// electron/field - filesystem side of WiFiSync (fs walk, tombstone/history/settings I/O).
//
// Node-only (uses node:fs). Pairs with the pure transforms in core/field. All
// writes are atomic (tmp + rename on the same volume). mtime is Unix-epoch
// seconds (stat.mtimeMs/1000) to match the Python st_mtime wire value.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  type Manifest,
  type ManifestEntryInput,
  buildManifestFromEntries,
  tombstonesToRecords,
  addTombstoneEntry,
  removeTombstoneEntry,
  WFSYNC_TMP_SUFFIX,
  WFSYNC_TOMBSTONE_FILE,
  WRITE_STABILITY_SEC,
  HISTORY_MAX,
} from '../../core/field';

/** Async atomic JSON write: `<path>.tmp` → rename over `<path>`. */
async function atomicWriteJson(p: string, data: unknown): Promise<void> {
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf-8');
  await fsp.rename(tmp, p);
}

/** True if `p` exists (any type). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** True if `p` is a regular file. */
export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

export { pathExists };

/**
 * Recursively walk `folder`, stat each file, and build the manifest (build_manifest).
 * Skips `.wfsync_tmp` files; applies the write-stability window via the pure
 * builder. stat errors on individual files are ignored (file skipped).
 */
export async function buildManifest(
  folder: string,
  stabilitySec: number = WRITE_STABILITY_SEC,
): Promise<Manifest> {
  const entries: ManifestEntryInput[] = [];
  const nowSec = Date.now() / 1000;

  async function walk(dir: string): Promise<void> {
    let items: fs.Dirent[];
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir → skip (never mass-propagate)
    }
    for (const it of items) {
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) {
        await walk(abs);
      } else if (it.isFile()) {
        if (it.name.endsWith(WFSYNC_TMP_SUFFIX)) continue;
        let st: fs.Stats;
        try {
          st = await fsp.stat(abs);
        } catch {
          continue;
        }
        const rel = path.relative(folder, abs).split(path.sep).join('/');
        entries.push({ relPath: rel, mtime: st.mtimeMs / 1000, size: st.size });
      }
    }
  }

  await walk(folder);
  return buildManifestFromEntries(entries, nowSec, stabilitySec);
}

// -- Tombstones (live in the PARENT directory of the sync folder) --------------

function tombstonePath(folder: string): string {
  return path.join(path.dirname(path.resolve(folder)), WFSYNC_TOMBSTONE_FILE);
}

function readTombstoneObjectSync(folder: string): Record<string, { mtime: number }> {
  try {
    return JSON.parse(fs.readFileSync(tombstonePath(folder), 'utf-8'));
  } catch {
    return {};
  }
}

async function readTombstoneObject(folder: string): Promise<Record<string, { mtime: number }>> {
  try {
    return JSON.parse(await fsp.readFile(tombstonePath(folder), 'utf-8'));
  } catch {
    return {};
  }
}

/** Load tombstones as deleted FileRecords (load_tombstones). {} on any error. */
export function loadTombstonesSync(folder: string): Manifest {
  const p = tombstonePath(folder);
  if (!fs.existsSync(p)) return new Map();
  return tombstonesToRecords(readTombstoneObjectSync(folder));
}

/** Persist a deletion tombstone, pinning `mtime` (default now) and pruning
 *  entries older than 30 days, then atomic-write (save_tombstone). */
export async function saveTombstone(folder: string, relPath: string, mtime?: number): Promise<void> {
  const existing = await readTombstoneObject(folder);
  const nowSec = Date.now() / 1000;
  const pruned = addTombstoneEntry(existing, relPath, mtime ?? nowSec, nowSec);
  await atomicWriteJson(tombstonePath(folder), pruned);
}

/** Drop a tombstone from disk (remove_tombstone) - called when a deleted file
 *  comes back. No-op if the key/file is absent. */
export async function removeTombstone(folder: string, relPath: string): Promise<void> {
  const existing = await readTombstoneObject(folder);
  const { changed, data } = removeTombstoneEntry(existing, relPath);
  if (changed) await atomicWriteJson(tombstonePath(folder), data);
}

// -- History log (wifisync_history.json - JSON array, newest-first on read) -----

export interface HistoryEntry {
  timestamp: number; // Unix epoch seconds
  filename: string;
  action: 'pulled' | 'deleted';
  peer_ip: string;
  size_bytes: number;
}

export class HistoryLog {
  private entries: HistoryEntry[] = [];
  constructor(private readonly filePath: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Array.isArray(raw)) this.entries = raw as HistoryEntry[];
    } catch {
      this.entries = [];
    }
  }

  append(entry: HistoryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > HISTORY_MAX) {
      this.entries = this.entries.slice(-HISTORY_MAX);
    }
    this.save();
  }

  /** Newest-first snapshot. */
  list(): HistoryEntry[] {
    return [...this.entries].reverse();
  }

  clear(): void {
    this.entries = [];
    this.save();
  }

  private save(): void {
    try {
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.entries), 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch {
      /* best effort */
    }
  }
}

// -- Settings (wifisync_settings.json, indent=2) -------------------------------

export interface WifiSyncSettings {
  folder: string;
  adapter: string;
  manual_ip: string;
  hs_ssid: string;
  hs_pass: string;
  role: 'both' | 'master' | 'slave';
  sync_mode: 'on_change' | 'interval';
  sync_interval: string;
  throttle_enabled: boolean;
  throttle_kbps: string;
}

export const DEFAULT_SETTINGS: WifiSyncSettings = {
  folder: '',
  adapter: '',
  manual_ip: '',
  hs_ssid: 'WifiSync_Host',
  hs_pass: 'wifisync1',
  role: 'both',
  sync_mode: 'on_change',
  sync_interval: '5',
  throttle_enabled: false,
  throttle_kbps: '500',
};

/** Load settings, validating enums and applying only known keys. Missing file → defaults. */
export function loadSettings(filePath: string): WifiSyncSettings {
  let raw: Partial<WifiSyncSettings> = {};
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  const out: WifiSyncSettings = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof WifiSyncSettings)[]) {
    if (raw[k] === undefined) continue;
    if (k === 'role' && !['both', 'master', 'slave'].includes(String(raw[k]))) continue;
    if (k === 'sync_mode' && !['on_change', 'interval'].includes(String(raw[k]))) continue;
    // @ts-expect-error indexed assignment across a validated union
    out[k] = raw[k];
  }
  return out;
}

/** Persist settings as JSON with indent=2 (matching the Python writer). */
export function saveSettings(filePath: string, settings: WifiSyncSettings): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}
