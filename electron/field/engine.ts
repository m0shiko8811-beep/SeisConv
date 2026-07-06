// electron/field - SyncEngine: the WiFiSync orchestration core (sync_engine.py).
//
// Ties together the fs manifest, TCP transport, watcher, tombstones and rate
// limiter. Supports both directions (two-way "both") and master/slave. The
// public `syncNow()` runs exactly one pass over the known peers (the body of
// the Python `_sync_loop` iteration) - the interval/watch loop calls it, and
// the loopback integration test calls it directly for determinism.
//
// Node-only (net/dgram/fs) - no electron import, so it's drivable from a plain
// tsx script and unit-testable end-to-end over 127.0.0.1.

import * as fsp from 'node:fs/promises';
import {
  type Manifest,
  type SyncMode,
  type SyncPlan,
  RateLimiter,
  computeDiff,
  applyEmptyManifestGuard,
  mergeManifest,
  safeJoin,
  PathEscapeError,
  MTIME_TOLERANCE,
  SYNC_INTERVAL_SEC,
  TCP_FILE_PORT,
} from '../../core/field';
import { fetchManifest, fetchFile } from './transport';
import { buildManifest, loadTombstonesSync, saveTombstone, removeTombstone, isFile, pathExists } from './fsutil';
import { FolderWatcher } from './watcher';

export type OnLog = (msg: string) => void;
export type OnSyncResult = (success: boolean, detail?: string) => void;
export type FileEventKind = 'pulled' | 'deleted';
export type OnFileEvent = (kind: FileEventKind, relPath: string, peerIp: string, size: number) => void;

export interface SyncEngineOptions {
  folder: string;
  mode?: SyncMode; // "both" (default) | "master" | "slave"
  bindIp?: string;
  watchMode?: 'on_change' | 'interval';
  syncInterval?: number; // seconds (min 1)
  maxKbps?: number; // 0 = unlimited
  onLog?: OnLog;
  onSyncResult?: OnSyncResult;
  onFileEvent?: OnFileEvent;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SyncEngine {
  readonly folder: string;
  private mode: SyncMode;
  private readonly bindIp: string;
  private readonly watchMode: 'on_change' | 'interval';
  private readonly syncInterval: number;
  private readonly limiter: RateLimiter;
  private readonly onLog: OnLog;
  private readonly onSyncResult: OnSyncResult;
  private readonly onFileEvent?: OnFileEvent;

  private readonly peers = new Map<string, number>(); // ip → tcp port
  private tombstones: Manifest;
  private pendingDeletes = new Set<string>();

  private stopFlag = false;
  private changeSignalled = false;
  private watcher: FolderWatcher | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(opts: SyncEngineOptions) {
    this.folder = opts.folder;
    this.mode = opts.mode ?? 'both';
    this.bindIp = opts.bindIp ?? '';
    this.watchMode = opts.watchMode ?? 'on_change';
    this.syncInterval = Math.max(1, opts.syncInterval ?? SYNC_INTERVAL_SEC);
    this.limiter = new RateLimiter(opts.maxKbps ?? 0);
    this.onLog = opts.onLog ?? (() => {});
    this.onSyncResult = opts.onSyncResult ?? (() => {});
    this.onFileEvent = opts.onFileEvent;
    this.tombstones = loadTombstonesSync(this.folder);
  }

  // -- peer management --------------------------------------------------------

  addPeer(ip: string, port: number = TCP_FILE_PORT): void {
    this.peers.set(ip, port);
  }
  removePeer(ip: string): void {
    this.peers.delete(ip);
  }
  clearPeers(): void {
    this.peers.clear();
  }
  setMode(mode: SyncMode): void {
    this.mode = mode;
  }
  getMode(): SyncMode {
    return this.mode;
  }
  peerCount(): number {
    return this.peers.size;
  }

  // -- manifest ---------------------------------------------------------------

  /** build_manifest(folder) overlaid with in-memory tombstones - the manifest
   *  BOTH the file server and the local diff use. */
  async getMergedManifest(): Promise<Manifest> {
    const base = await buildManifest(this.folder);
    return mergeManifest(base, this.tombstones);
  }

  // -- deletion propagation -----------------------------------------------------

  /** Record an authoritative local deletion (watchdog on_deleted / on_moved). */
  recordLocalDelete(relPath: string): void {
    this.pendingDeletes.add(relPath);
  }

  /** Drain pending deletions into tombstones (skipping any file recreated since).
   *  Delete-event-driven (not manifest-diff) so a briefly-unreadable folder can't
   *  mass-propagate deletions. */
  async originateTombstones(): Promise<void> {
    const pending = [...this.pendingDeletes];
    this.pendingDeletes.clear();
    for (const rel of pending) {
      let abs: string;
      try {
        abs = safeJoin(this.folder, rel);
      } catch {
        continue;
      }
      if (await pathExists(abs)) continue; // recreated → not actually deleted
      const now = Date.now() / 1000;
      await saveTombstone(this.folder, rel, now);
      this.tombstones.set(rel, { relPath: rel, mtime: now, size: 0, deleted: true });
      this.onLog(`Local deletion recorded - will propagate to peers: ${rel}`);
    }
  }

  // -- one sync pass (loop body) ------------------------------------------------

  /**
   * Run one sync pass over all known peers (the body of the Python _sync_loop
   * iteration, minus the wait). Deterministic and awaitable - used by both the
   * background loop and the loopback test.
   */
  async syncNow(): Promise<{ ok: boolean; detail: string }> {
    let peers = [...this.peers.entries()];
    if (peers.length === 0) return { ok: true, detail: 'no peers' };

    if (this.mode === 'slave' && peers.length > 1) {
      this.onLog(`Slave mode: using first peer ${peers[0][0]}, ignoring ${peers.length - 1} others`);
      peers = peers.slice(0, 1);
    }

    let anyOk = false;
    let lastDetail = '';
    for (const [ip, port] of peers) {
      try {
        if (this.mode === 'master') {
          this.onLog(`Master mode: serving ${ip}, not pulling`);
          this.onSyncResult(true, 'master - serving only');
          anyOk = true;
          continue;
        }
        const transferred = await this.runSyncRound(ip, port);
        anyOk = true;
        this.onLog(transferred ? `Sync with ${ip} - ${transferred} file(s) transferred` : `Sync with ${ip} - up to date`);
      } catch (e) {
        lastDetail = `${ip}: ${(e as Error).message}`;
        this.onLog(`[ERROR] Sync with ${ip} failed: ${(e as Error).message}`);
        this.onSyncResult(false, lastDetail);
      }
    }

    if (anyOk) {
      const detail = peers.length > 1 ? `${peers.length} peer(s)` : 'up to date';
      this.onSyncResult(true, detail);
      return { ok: true, detail };
    }
    return { ok: false, detail: lastDetail };
  }

  /** Single peer sync round (_run_sync_round) → number of files pulled. */
  private async runSyncRound(peerIp: string, peerPort: number): Promise<number> {
    await this.originateTombstones();
    const local = await this.getMergedManifest();
    const remote = await fetchManifest(peerIp, peerPort);

    const rawPlan: SyncPlan = computeDiff(local, remote, this.mode);
    const plan: SyncPlan = applyEmptyManifestGuard(rawPlan, remote);
    if (rawPlan.toDeleteLocally.length > 0 && plan.toDeleteLocally.length === 0) {
      this.onLog(
        `[SAFETY] Remote has no live files - skipping ${rawPlan.toDeleteLocally.length} local deletion(s); peer folder may be offline.`,
      );
    }

    let transferred = 0;

    for (const rel of plan.toPull) {
      try {
        await fetchFile(peerIp, peerPort, rel, this.folder, this.limiter);
        transferred++;
        this.tombstones.delete(rel);
        await removeTombstone(this.folder, rel);
        if (this.onFileEvent) {
          let size = 0;
          try {
            const abs = safeJoin(this.folder, rel);
            size = (await fsp.stat(abs)).size;
          } catch {
            /* size stays 0 */
          }
          this.onFileEvent('pulled', rel, peerIp, size);
        }
      } catch (e) {
        this.onLog(`[ERROR] Failed to pull '${rel}': ${(e as Error).message}`);
      }
    }

    for (const rel of plan.toDeleteLocally) {
      let abs: string;
      try {
        abs = safeJoin(this.folder, rel);
      } catch (e) {
        if (e instanceof PathEscapeError) this.onLog(`[SECURITY] Skipped out-of-root delete: ${JSON.stringify(rel)}`);
        continue;
      }
      try {
        if (await isFile(abs)) {
          await fsp.unlink(abs);
          this.onLog(`Deleted: ${rel}`);
          if (this.onFileEvent) this.onFileEvent('deleted', rel, peerIp, 0);
        }
        if (this.mode !== 'slave') {
          const rec = remote.get(rel);
          if (rec) {
            await saveTombstone(this.folder, rel, rec.mtime);
            this.tombstones.set(rel, rec);
          }
        }
      } catch (e) {
        this.onLog(`[ERROR] Failed to delete '${rel}': ${(e as Error).message}`);
      }
    }

    return transferred;
  }

  // -- background loop (watch-driven + interval) --------------------------------

  start(): void {
    this.stopFlag = false;
    this.changeSignalled = false;
    if (this.watchMode === 'on_change') {
      this.watcher = new FolderWatcher(
        this.folder,
        () => {
          this.changeSignalled = true;
        },
        (rel) => this.recordLocalDelete(rel),
        this.onLog,
      );
      const ok = this.watcher.start();
      this.onLog(ok ? 'File watcher active - syncs trigger instantly on changes' : `watchdog unavailable - polling every ${this.syncInterval}s`);
    } else {
      this.onLog(`Interval sync mode - checking every ${this.syncInterval}s`);
    }
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopFlag) {
      try {
        await this.syncNow();
      } catch (e) {
        this.onLog(`[ERROR] sync pass failed: ${(e as Error).message}`);
      }
      await this.waitForChangeOrInterval();
    }
  }

  private async waitForChangeOrInterval(): Promise<void> {
    const start = Date.now();
    while (!this.stopFlag && !this.changeSignalled && Date.now() - start < this.syncInterval * 1000) {
      await sleep(100);
    }
    const changed = this.changeSignalled;
    this.changeSignalled = false;
    if (changed && !this.stopFlag) {
      this.onLog('Change detected in folder - syncing immediately…');
      await sleep(500); // debounce
    }
  }

  async stop(): Promise<void> {
    this.stopFlag = true;
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
    if (this.loopPromise) {
      await Promise.race([this.loopPromise, sleep(3000)]);
      this.loopPromise = null;
    }
  }
}

export { MTIME_TOLERANCE };
