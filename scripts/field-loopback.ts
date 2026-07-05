// WiFiSync engine — standalone two-way loopback proof.
//
//   npx tsx scripts/field-loopback.ts
//
// Starts two real FileServers + two SyncEngines on 127.0.0.1 (ephemeral ports,
// so nothing collides with a live WiFiSync on 47823/47824) with two isolated
// temp folders, then drives the actual socket engine through:
//   1. a NEW file on side A appears byte-identical (and mtime-preserved) on B
//   2. a CHANGE on A propagates to B
//   3. a DELETION on A propagates to B via tombstone (peer keeps a live file)
//   4. TWO-WAY: a file added on each side ends up on both
//   5. anti-wipe guard: an all-tombstone (no live) peer manifest never wipes B
//
// LOOPBACK ONLY — 127.0.0.1, no real network, no hotspot, no firewall.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SyncEngine, FileServer, buildManifest } from '../electron/field';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Write `content` to `<folder>/<rel>` and back-date its mtime by `ageSec`
 *  seconds so it clears the 2 s write-stability window immediately. */
async function writeAged(folder: string, rel: string, content: Buffer | string, ageSec: number): Promise<number> {
  const abs = path.join(folder, ...rel.split('/'));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
  const mtime = nowSec() - ageSec;
  await fsp.utimes(abs, mtime, mtime);
  return mtime;
}

function exists(folder: string, rel: string): boolean {
  return fs.existsSync(path.join(folder, ...rel.split('/')));
}
function read(folder: string, rel: string): Buffer {
  return fs.readFileSync(path.join(folder, ...rel.split('/')));
}
async function mtimeOf(folder: string, rel: string): Promise<number> {
  return (await fsp.stat(path.join(folder, ...rel.split('/')))).mtimeMs / 1000;
}

async function main(): Promise<void> {
  // Distinct PARENT dirs so each side's ".wfsync_tombstones.json" (kept in the
  // folder's parent) is separate.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wfsync-loop-'));
  const folderA = path.join(base, 'A', 'data');
  const folderB = path.join(base, 'B', 'data');
  fs.mkdirSync(folderA, { recursive: true });
  fs.mkdirSync(folderB, { recursive: true });

  const logsA: string[] = [];
  const logsB: string[] = [];

  const engineA = new SyncEngine({ folder: folderA, mode: 'both', onLog: (m) => logsA.push(m) });
  const engineB = new SyncEngine({ folder: folderB, mode: 'both', onLog: (m) => logsB.push(m) });

  const serverA = new FileServer({ folder: folderA, getManifest: () => engineA.getMergedManifest(), port: 0, host: '127.0.0.1' });
  const serverB = new FileServer({ folder: folderB, getManifest: () => engineB.getMergedManifest(), port: 0, host: '127.0.0.1' });
  await serverA.start();
  await serverB.start();
  const portA = serverA.address()!.port;
  const portB = serverB.address()!.port;

  engineA.addPeer('127.0.0.1', portB); // A pulls from B
  engineB.addPeer('127.0.0.1', portA); // B pulls from A

  console.log(`\nWiFiSync loopback  (A:127.0.0.1:${portA}  B:127.0.0.1:${portB})\n`);

  // ── Case 1: new file A → B (nested path exercises safeJoin + mkdir) ──────────
  console.log('[case 1] new file A → B');
  const payload1 = Buffer.from('first-breaks shot 042 — hello wifisync\n'.repeat(64));
  const aMtime1 = await writeAged(folderA, 'sub/hello.txt', payload1, 20);
  await engineB.syncNow();
  check('B received sub/hello.txt', exists(folderB, 'sub/hello.txt'));
  check('bytes are identical', exists(folderB, 'sub/hello.txt') && read(folderB, 'sub/hello.txt').equals(payload1));
  if (exists(folderB, 'sub/hello.txt')) {
    const bMtime = await mtimeOf(folderB, 'sub/hello.txt');
    check('mtime preserved', Math.abs(bMtime - aMtime1) < 0.01, `A=${aMtime1} B=${bMtime}`);
  }

  // ── Case 2: change on A propagates ───────────────────────────────────────────
  console.log('[case 2] change on A propagates to B');
  const payload2 = Buffer.from('EDITED — sweep 8-96 Hz 12 s linear\n'.repeat(80));
  await writeAged(folderA, 'sub/hello.txt', payload2, 5); // newer than case-1 mtime by ~15 s
  await engineB.syncNow();
  check('B picked up the change', exists(folderB, 'sub/hello.txt') && read(folderB, 'sub/hello.txt').equals(payload2));

  // ── Case 3: deletion on A propagates via tombstone (A keeps a live file) ─────
  console.log('[case 3] deletion on A → B via tombstone');
  await writeAged(folderA, 'keep.txt', 'stays alive\n', 20);
  await writeAged(folderA, 'gone.txt', 'about to be deleted\n', 20);
  await engineB.syncNow(); // B now has keep.txt + gone.txt
  const bHadGone = exists(folderB, 'gone.txt') && exists(folderB, 'keep.txt');
  await fsp.unlink(path.join(folderA, 'gone.txt'));
  engineA.recordLocalDelete('gone.txt');
  await engineA.originateTombstones(); // A's served manifest now tombstones gone.txt
  await engineB.syncNow(); // B sees the tombstone (keep.txt still live → guard passes)
  check('precondition: B had gone.txt + keep.txt', bHadGone);
  check('B deleted gone.txt', !exists(folderB, 'gone.txt'));
  check('B kept keep.txt (live)', exists(folderB, 'keep.txt'));
  const bTomb = path.join(base, 'B', '.wfsync_tombstones.json');
  check('B originated its own tombstone for gone.txt', fs.existsSync(bTomb) && JSON.parse(fs.readFileSync(bTomb, 'utf-8'))['gone.txt'] !== undefined);

  // ── Case 4: two-way — a file added on each side ends up on both ──────────────
  console.log('[case 4] two-way merge');
  const onlyA = Buffer.from('originated on A\n'.repeat(40));
  const onlyB = Buffer.from('originated on B\n'.repeat(40));
  await writeAged(folderA, 'onlyA.txt', onlyA, 20);
  await writeAged(folderB, 'onlyB.txt', onlyB, 20);
  await engineA.syncNow(); // A pulls onlyB.txt from B
  await engineB.syncNow(); // B pulls onlyA.txt from A
  check('A has onlyA.txt', exists(folderA, 'onlyA.txt') && read(folderA, 'onlyA.txt').equals(onlyA));
  check('A received onlyB.txt', exists(folderA, 'onlyB.txt') && read(folderA, 'onlyB.txt').equals(onlyB));
  check('B has onlyB.txt', exists(folderB, 'onlyB.txt') && read(folderB, 'onlyB.txt').equals(onlyB));
  check('B received onlyA.txt', exists(folderB, 'onlyA.txt') && read(folderB, 'onlyA.txt').equals(onlyA));

  // ── Case 5: anti-wipe guard — an all-tombstone peer must not wipe B ──────────
  console.log('[case 5] empty/all-tombstone peer never wipes local files');
  const bBefore = (await buildManifest(folderB, 0)).size;
  // Delete + tombstone EVERY live file on A so A advertises zero live records.
  const aLive = [...(await buildManifest(folderA, 0)).keys()];
  for (const rel of aLive) {
    await fsp.unlink(path.join(folderA, ...rel.split('/')));
    engineA.recordLocalDelete(rel);
  }
  await engineA.originateTombstones();
  const aMerged = await engineA.getMergedManifest();
  const aLiveNow = [...aMerged.values()].filter((r) => !r.deleted).length;
  await engineB.syncNow(); // B must NOT delete anything
  const bAfter = (await buildManifest(folderB, 0)).size;
  check('A advertises no live records', aLiveNow === 0, `live=${aLiveNow}`);
  check('B kept all its files (guard held)', bAfter === bBefore && bBefore > 0, `before=${bBefore} after=${bAfter}`);
  check('B logged the [SAFETY] skip', logsB.some((l) => l.includes('[SAFETY]')));

  // ── teardown ─────────────────────────────────────────────────────────────────
  await serverA.stop();
  await serverB.stop();
  await sleep(50);
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  console.log(`\n----------------------\nloopback: passed ${passed}   failed ${failed}\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error('loopback crashed:', e);
  process.exitCode = 1;
});
