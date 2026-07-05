// SeisConv — Electron main process.
//
// Owns the window + native dialogs and drives ONE long-lived worker thread that
// holds the parsed file and answers view/convert requests. The renderer is
// sandboxed (contextIsolation, no nodeIntegration); it reaches privileged work
// only through the typed `seisconvAPI` in preload.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { writeFile, readFile, readdir, stat, unlink, open } from 'node:fs/promises';
import { createWriteStream, watch, type FSWatcher } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import * as dgram from 'node:dgram';
import * as dns from 'node:dns';
import * as path from 'node:path';
import JSZip from 'jszip';
import { writeTapeVolHeader, writeTapeEnd, parseUdpTrigger, parseTriggerLine, parseScsLogLine, scsLogKey, isScsTrigTouch, SCS_TRIG_WINDOW_MS, TRIGGER_TEXT_MAX } from '../core';
import { RateLimiter, TCP_FILE_PORT, complementRole, type Role as FieldRole } from '../core/field';
import {
  SyncEngine, FileServer, DiscoveryService, HistoryLog,
  loadSettings, saveSettings, DEFAULT_SETTINGS,
  type WifiSyncSettings,
  windows as fieldWin,
} from './field';

const WORKER_PATH = path.join(__dirname, 'parse.worker.js');

// Feedback inbox — centralized here so it is easy to point at your own address.
const FEEDBACK_EMAIL = 'feedback@example.com';

const SEISMIC_FILTERS = [
  { name: 'Seismic files', extensions: ['segy', 'sgy', 'segd', 'seg', 'su', 'seg2', 'dat', 'bat'] },
  { name: 'All files', extensions: ['*'] },
];

// OPEN dialogs default to "All files" first: seismic data ships under countless
// extensions (.TpImage tape archives, vendor SEG-D variants, raw .dat, no ext at
// all) and the user knows which file they want — so we never block a pick by type.
// "Seismic files" stays as an optional convenience filter. Save dialogs keep
// SEISMIC_FILTERS (a save should default to the writer's own extension).
const OPEN_FILTERS = [
  { name: 'All files', extensions: ['*'] },
  { name: 'Seismic files', extensions: ['segy', 'sgy', 'segd', 'seg', 'su', 'seg2', 'dat', 'bat'] },
];

// Input-folder enumeration: extensions (lower-case, no dot) we treat as seismic.
const INPUT_EXTS = new Set(['.segy', '.sgy', '.segd', '.seg', '.seg2', '.dat', '.bat', '.su']);

// Largest file a non-tape batch convert will dispatch: the worker reads each input
// WHOLE into memory (readFileSync) to convert it, so refuse anything above the
// worker's own in-memory cap before dispatch rather than OOMing it. Mirrors the
// worker's IN_MEMORY_MAX.
const IN_MEMORY_MAX = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB

let win: BrowserWindow | null = null;
let lastOpenedPath = '';

// Last conversion OUTPUT locations, for the "Open output folder" buttons on the
// finished convert wizards. `lastSavedFilePath` is the exact file a single-file /
// geometry-load save wrote (revealed + selected in its folder); `lastBatchOutDir`
// is the batch/combine destination directory (opened). Both are set only from a
// user-chosen save path / authorized output dir, never a renderer-supplied string.
let lastSavedFilePath = '';
let lastBatchOutDir = '';

// Sibling-file navigation state: the sorted list of seismic files in the
// CURRENTLY-open file's containing directory, plus the open file's index into
// it. Rebuilt every time a file is opened (open dialog OR sibling step), so
// Prev/Next can flip through neighbours without re-opening the picker.
let siblingPaths: string[] = [];
let siblingIndex = -1;

// Allowlist of file paths the USER has chosen via a native dialog (or that we
// enumerated from a user-chosen folder). extractTrace/getSection-style handlers
// read arbitrary renderer-supplied paths; confining them to this set stops a
// compromised renderer from reading files the user never selected. Normalized
// with path.resolve so '.'/'..'/separator variants can't slip past the check.
const authorizedPaths = new Set<string>();
function authorizePath(p: string): string {
  const abs = path.resolve(p);
  authorizedPaths.add(abs);
  return abs;
}
function isAuthorizedPath(p: string): boolean {
  return typeof p === 'string' && authorizedPaths.has(path.resolve(p));
}

// Allowlist of OUTPUT directories the user has chosen via the folder picker.
// batchConvert writes attacker-influenceable bytes (templated names) into its
// outDir, so confining writes to a user-picked directory stops a compromised
// renderer from dropping files into e.g. the Startup folder.
const authorizedDirs = new Set<string>();
function authorizeDir(p: string): string {
  const abs = path.resolve(p);
  authorizedDirs.add(abs);
  return abs;
}
function isAuthorizedDir(p: string): boolean {
  return typeof p === 'string' && authorizedDirs.has(path.resolve(p));
}

// Enumerate the seismic siblings of `filePath` (same directory), sorted by name,
// and remember the open file's position. Best-effort: on any fs error we fall
// back to a one-element list containing just the open file so navigation is a
// no-op rather than a crash.
async function indexSiblings(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const names = entries
      .filter((e) => e.isFile() && INPUT_EXTS.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    siblingPaths = names.map((n) => path.join(dir, n));
  } catch {
    siblingPaths = [];
  }
  // Every enumerated sibling is reachable via Prev/Next, so authorize them all.
  for (const p of siblingPaths) authorizePath(p);
  // Locate the open file in the list; if it (somehow) isn't present, seed the
  // list with just it so index/count stay coherent.
  let idx = siblingPaths.indexOf(filePath);
  if (idx < 0) {
    siblingPaths = [filePath];
    idx = 0;
  }
  siblingIndex = idx;
}

// Build the standard open-summary envelope (path/name + nav fields + worker
// summary), shared by openAndParse and openSiblingFile so the UI can label the
// first-opened file exactly like a stepped-to one.
function openEnvelope(filePath: string, summary: any) {
  const count = siblingPaths.length;
  const index = siblingIndex;
  return {
    path: filePath,
    name: path.basename(filePath),
    index,
    count,
    hasPrev: index > 0,
    hasNext: index >= 0 && index < count - 1,
    ...summary,
  };
}

// Set true by a cancel signal; the running batch checks it between files.
let cancelRequested = false;
ipcMain.on('seisconv:cancelConvert', () => {
  cancelRequested = true;
});

// ── Persistent worker with id-correlated request/response ──
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(WORKER_PATH);
  w.on('message', (msg: { id: number; type?: string }) => {
    // Side-band long-op progress (no pending id to resolve) → push to the renderer's
    // global progress bar. Everything else correlates to a pending request by id.
    if (msg.type === 'progress') { win?.webContents.send('seisconv:workerProgress', msg); return; }
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p.resolve(msg);
    }
  });
  const fail = (err: unknown) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = null;
  };
  w.on('error', fail);
  w.on('exit', () => {
    if (worker === w) worker = null;
  });
  worker = w;
  return w;
}

function callWorker<T = any>(req: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const w = getWorker();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...req, id }, transfer as any);
  });
}

// Strip control keys a malicious/compromised renderer could use to RE-ROUTE a
// worker call — e.g. overriding `type` to 'open'/'convertPath' with an arbitrary
// `path` to read a file outside the dialog allowlist. Every worker request is
// built here with an explicit `type`; renderer-supplied opts may only carry view
// PARAMETERS (trace/sample ranges, gain, agc, fk knobs…), never routing keys.
function paramOpts(opts: unknown): Record<string, unknown> {
  if (!opts || typeof opts !== 'object') return {};
  const { type: _type, path: _path, paths: _paths, format: _format, id: _id, ...rest } =
    opts as Record<string, unknown>;
  void _type; void _path; void _paths; void _format; void _id;
  return rest;
}

// ── SNTP (NTP-over-UDP) client for the Observer Log "Sync clock" control ──
//
// Minimal RFC-4330 SNTP query: send a 48-byte request (LI=0, VN=4, Mode=3 client)
// to <server>:123 over UDP, read the server's TRANSMIT timestamp from the reply,
// and return offsetMs = serverTimeMs - Date.now(). No round-trip delay correction
// — the log only needs the wall-clock offset, not sub-ms precision. Resolves a
// clean error (never throws/rejects) on timeout, DNS failure, or offline so the
// renderer can surface "sync failed" without crashing. 2-second hard timeout.
const NTP_UNIX_EPOCH_DIFF = 2208988800; // seconds between 1900-01-01 and 1970-01-01

// Reject SNTP targets that point at the local machine / private networks so a
// compromised renderer can't drive the main process to probe internal hosts
// over UDP/123 (an SSRF the sandboxed renderer itself could never perform). We
// only block obviously-internal LITERALS (loopback, RFC-1918, link-local,
// unique-local IPv6); public hostnames like pool.ntp.org are resolved normally.
/** Is an IP LITERAL (v4 or v6) an internal/loopback/link-local/private address?
 *  Used both for the user-supplied host string AND for the DNS-resolved address,
 *  so a public hostname that resolves to an internal IP (DNS-rebinding) is caught. */
function isInternalIp(ip: string): boolean {
  const h = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4 literal?
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255)) return true; // malformed → reject
    const [a, b] = o;
    if (a === 0 || a === 127) return true;                 // this-host / loopback
    if (a === 10) return true;                              // 10/8
    if (a === 100 && b >= 64 && b <= 127) return true;      // 100.64/10 CGNAT (RFC 6598)
    if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16/12
    if (a === 192 && b === 168) return true;                // 192.168/16
    if (a === 169 && b === 254) return true;                // link-local
    if (a >= 224) return true;                              // multicast/reserved
    return false;
  }
  // IPv6 literal: block loopback (::1), unspecified (::), unique-local (fc00::/7),
  // link-local (fe80::/10), and IPv4-mapped (::ffff:a.b.c.d → re-check the v4 tail).
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd]/.test(h)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
    if (mapped) return isInternalIp(mapped[1]);
    return false;
  }
  return false;
}

function isInternalNtpHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '' || h.endsWith('.localhost')) return true;
  return isInternalIp(h);
}

function sntpQuery(server: string): Promise<{ ok: boolean; offsetMs?: number; serverTimeMs?: number; error?: string }> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (result: { ok: boolean; offsetMs?: number; serverTimeMs?: number; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'NTP request timed out' }), 2000);

    socket.on('error', (err) => finish({ ok: false, error: (err as Error).message }));
    socket.on('message', (msg) => {
      // Server transmit timestamp: 4-byte integer seconds + 4-byte fraction at
      // byte offset 40 (seconds since 1900). Need at least 48 bytes for a valid reply.
      if (msg.length < 48) { finish({ ok: false, error: 'short NTP reply' }); return; }
      const seconds = msg.readUInt32BE(40);
      const fraction = msg.readUInt32BE(44);
      const serverTimeMs = (seconds - NTP_UNIX_EPOCH_DIFF) * 1000 + Math.round((fraction / 0x100000000) * 1000);
      const offsetMs = serverTimeMs - Date.now();
      finish({ ok: true, offsetMs, serverTimeMs });
    });

    // Client request packet: first byte 0x1B = LI 0, VN 4, Mode 3 (client); rest zero.
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b;

    // Resolve the hostname OURSELVES and re-check every resolved address against the
    // private/loopback/link-local table BEFORE sending. The literal-only
    // isInternalNtpHost check can't catch a public hostname that resolves to an
    // internal IP (DNS-rebinding), which would otherwise let the main process
    // probe internal hosts over UDP/123. We then send to the vetted literal IP (not
    // the hostname) so the OS can't re-resolve to a different address (no TOCTOU).
    dns.lookup(server, { all: true }, (err, addresses) => {
      if (done) return;
      if (err || !addresses.length) { finish({ ok: false, error: 'NTP DNS lookup failed' }); return; }
      if (addresses.some((a) => isInternalIp(a.address))) {
        finish({ ok: false, error: 'NTP server resolved to an internal address (blocked)' });
        return;
      }
      // Prefer an IPv4 result (the socket is udp4); fall back to the first address.
      const target = (addresses.find((a) => a.family === 4) ?? addresses[0]).address;
      socket.send(packet, 0, packet.length, 123, target, (sendErr) => {
        if (sendErr) finish({ ok: false, error: (sendErr as Error).message });
      });
    });
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0d1f33',
    show: false,
    // Frameless: drop the native OS title bar AND the OS window-controls overlay
    // so the app's own header is the entire top of the window. The renderer draws
    // its own min/max/close buttons (.win-controls) that match the theme, and the
    // header acts as the drag region (-webkit-app-region:drag). titleBarStyle
    // 'hidden' with NO titleBarOverlay yields a frameless window with zero native
    // controls on Windows while keeping the rounded-corners / shadow chrome.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // Kill every live trigger source with the window — nothing may keep watching
  // folders / listening on sockets once the UI that owns the watch is gone.
  win.on('closed', () => { stopTriggerWatch(true); void fieldHub.stop(); win = null; });
  // Hardening: a local-only app never opens new windows or navigates elsewhere.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // Keep the renderer's custom maximize/restore button in sync with the real
  // window state (covers OS-level maximize via Win+Up, double-click, snap, etc.).
  win.on('maximize', () => win?.webContents.send('seisconv:win-maximized', true));
  win.on('unmaximize', () => win?.webContents.send('seisconv:win-maximized', false));
  // Push the initial state once the renderer is ready to receive it.
  win.webContents.once('did-finish-load', () =>
    win?.webContents.send('seisconv:win-maximized', win.isMaximized()),
  );
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// ── Custom window controls (renderer draws its own min/max/close buttons) ──
ipcMain.on('seisconv:win-minimize', () => win?.minimize());
ipcMain.on('seisconv:win-maximize-toggle', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('seisconv:win-close', () => win?.close());

// ── Send Feedback ──
// The renderer composes the subject + body; MAIN owns the inbox address (so it
// stays out of the renderer bundle) and opens the OS default mail client via a
// mailto: URL. shell.openExternal lets the user pick their mail app. Inputs are
// length-capped before URL-encoding; nothing is sent automatically.
ipcMain.handle('seisconv:sendFeedback', async (_e, args: { subject?: string; body?: string }) => {
  try {
    const subject = String(args?.subject ?? '').slice(0, 998);
    const body = String(args?.body ?? '').slice(0, 8000);
    const url = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

// ── IPC ──
ipcMain.handle('seisconv:openAndParse', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: OPEN_FILTERS });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const r = await callWorker<{ ok: boolean; summary?: any; error?: string }>({ type: 'open', path: filePath });
  if (!r.ok) throw new Error(r.error || 'parse failed');
  lastOpenedPath = filePath;
  // Index the open file's seismic siblings so Prev/Next can step the folder.
  await indexSiblings(filePath);
  return openEnvelope(filePath, r.summary);
});

// Step to the previous/next seismic file in the open file's folder. `delta` is
// usually ±1; the target index is clamped to the list bounds. Returns null when
// the move would leave the index unchanged (already at an edge, or no file open),
// otherwise parses the target the same way as open and returns the same summary
// envelope (with updated index/count/hasPrev/hasNext).
ipcMain.handle('seisconv:openSiblingFile', async (_e, delta: number) => {
  const count = siblingPaths.length;
  if (count === 0 || siblingIndex < 0) return null;
  const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const prev = siblingIndex;
  const next = Math.max(0, Math.min(count - 1, siblingIndex + d));
  if (next === siblingIndex) return null; // no move (clamped at an edge)
  const filePath = siblingPaths[next];
  // Commit the index BEFORE the await so a second fast ]/[ press reads the new
  // index and steps further, instead of both reads seeing the same stale index
  // and resolving to the same file (one keypress silently dropped). Roll back if
  // the parse fails so a failed step doesn't leave the index advanced.
  siblingIndex = next;
  let r: { ok: boolean; summary?: any; error?: string };
  try {
    r = await callWorker<{ ok: boolean; summary?: any; error?: string }>({ type: 'open', path: filePath });
  } catch (e) {
    siblingIndex = prev;
    throw e;
  }
  if (!r.ok) { siblingIndex = prev; throw new Error(r.error || 'parse failed'); }
  lastOpenedPath = filePath;
  return openEnvelope(filePath, r.summary);
});

ipcMain.handle('seisconv:getTrace', async (_e, index: number) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'trace', index });
  if (!r.ok) throw new Error(r.error || 'trace failed');
  return { index: r.index, nSamples: r.nSamples, sampleInt: r.sampleInt, hdr: r.hdr, samples: r.samples };
});

// Trace Workbench: open a single-file picker and return the chosen path WITHOUT
// parsing (the workbench parses lazily via extractTrace). Null when cancelled.
ipcMain.handle('seisconv:pickTraceFile', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: OPEN_FILTERS });
  if (res.canceled || !res.filePaths.length) return null;
  return authorizePath(res.filePaths[0]);
});

// Trace Workbench: parse `path` locally (off the persistently-open file) and
// return ONE trace's samples + header. Mirrors getTrace's return shape, plus the
// source name + total trace count so the workbench can label + clamp the entry.
ipcMain.handle('seisconv:extractTrace', async (_e, filePath: string, index: number) => {
  // Only read paths the user actually chose via a dialog (or that we enumerated
  // from a user-picked folder). Blocks a compromised renderer from passing an
  // arbitrary path to readFileSync in the worker.
  if (!isAuthorizedPath(filePath)) throw new Error('extractTrace: unauthorized file path');
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'extractTrace', path: filePath, index });
  if (!r.ok) throw new Error(r.error || 'extract trace failed');
  return { name: r.name, index: r.index, traceCount: r.traceCount, nSamples: r.nSamples, sampleInt: r.sampleInt, hdr: r.hdr, samples: r.samples };
});

ipcMain.handle('seisconv:getSection', async (_e, opts: Record<string, unknown>) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'section', ...paramOpts(opts) });
  if (!r.ok) throw new Error(r.error || 'section failed');
  return {
    numTraces: r.numTraces, colLen: r.colLen, norm: r.norm, sampleInt: r.sampleInt, traceStep: r.traceStep, data: r.data,
    traceStart: r.traceStart, traceEnd: r.traceEnd, sampStart: r.sampStart, sampEnd: r.sampEnd, fullTraces: r.fullTraces, fullSamples: r.fullSamples,
  };
});

// Pick a folder and enumerate its seismic files (by extension), sorted by name.
ipcMain.handle('seisconv:pickInputFolder', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  const dir = res.filePaths[0];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && INPUT_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length) return null;
  // Authorize each enumerated file so batchConvert/extractTrace can read them.
  for (const f of files) authorizePath(f.path);
  return { dir, files };
});

// Pick an output folder; returns the chosen path or null.
ipcMain.handle('seisconv:pickOutputFolder', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  // Authorize the chosen directory so batchConvert may write into it.
  return authorizeDir(res.filePaths[0]);
});

// Strip characters illegal in file names so a templated base is always safe.
function sanitizeBaseName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'output';
}

// Apply the output-name template for one file → a safe base name (no extension).
// Tokens: {name} input base, {custom} custom text, {fmt} writer id, {date} stamp,
// {time} HHMM, {seq3} 3-digit index + {seq}/{n} 1-based index (batch only). MUST
// stay token-identical to the renderer's applyNameTemplate (renderer/src/app.ts):
// an EMPTY component is dropped together with one neighbouring separator so a
// blank/absent part never leaves a doubled or dangling _ / - in the name.
function applyNameTemplate(
  tpl: string,
  vars: { name: string; fmt: string; date: string; custom?: string; time?: string; n?: number },
): string {
  const val: Record<'name' | 'custom' | 'fmt' | 'date' | 'time' | 'seq3' | 'seq' | 'n', string> = {
    name: vars.name ?? '',
    custom: vars.custom ?? '',
    fmt: vars.fmt ?? '',
    date: vars.date ?? '',
    time: vars.time ?? '',
    seq3: vars.n != null ? String(vars.n).padStart(3, '0') : '',
    seq: vars.n != null ? String(vars.n) : '',
    n: vars.n != null ? String(vars.n) : '',
  };
  let out = tpl || '{name}';
  // The token list is a fixed literal set, so the dynamic RegExp is safe.
  for (const key of ['name', 'custom', 'fmt', 'date', 'time', 'seq3', 'seq', 'n'] as const) {
    if (val[key]) continue;
    out = out.replace(new RegExp('[_-]?\\{' + key + '\\}', 'g'), '');
  }
  out = out
    .replace(/\{name\}/g, val.name)
    .replace(/\{custom\}/g, val.custom)
    .replace(/\{fmt\}/g, val.fmt)
    .replace(/\{date\}/g, val.date)
    .replace(/\{time\}/g, val.time)
    .replace(/\{seq3\}/g, val.seq3)
    .replace(/\{seq\}/g, val.seq)
    .replace(/\{n\}/g, val.n);
  out = out.replace(/^[_-]+/, '').replace(/[_-]+$/, '');
  return sanitizeBaseName(out);
}

// Convert the CURRENTLY-OPEN file to `format` and save via a native dialog. The
// renderer passes the templated `outBaseName` (no extension) as the default name.
ipcMain.handle('seisconv:convertSingle', async (_e, format: string, outBaseName?: string) => {
  const r = await callWorker<{ ok: boolean; bytes?: ArrayBuffer; ext?: string; error?: string }>({ type: 'convert', format });
  if (!r.ok || !r.bytes) return { ok: false, error: r.error ?? 'conversion failed' };
  if (!win) return { ok: false, error: 'no window' };
  const fallback = lastOpenedPath ? path.basename(lastOpenedPath).replace(/\.[^.]+$/, '') : 'output';
  const base = outBaseName && outBaseName.trim() ? sanitizeBaseName(outBaseName) : fallback;
  const save = await dialog.showSaveDialog(win, { defaultPath: `${base}.${r.ext}`, filters: SEISMIC_FILTERS });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, Buffer.from(r.bytes));
  lastSavedFilePath = save.filePath; // remember for "Open output folder"
  return { ok: true, path: save.filePath };
});

// Trace Workbench EXPORT: write the collected traces out as a seismic file in
// `format`. The worker assembles a synthetic ParsedFile from the passed traces +
// sample interval and runs the writer; we save the returned bytes via the SAME
// native dialog flow as convertSingle. `baseName` (no extension) seeds the
// dialog's default file name.
ipcMain.handle(
  'seisconv:convertTraces',
  async (
    _e,
    args: { traces: { samples: Float32Array; nSamples: number; sampleInt?: number }[]; sampleInt?: number; format: string; baseName?: string },
  ) => {
    const r = await callWorker<{ ok: boolean; bytes?: ArrayBuffer; ext?: string; error?: string }>({
      type: 'convertTraces',
      format: args.format,
      sampleInt: args.sampleInt,
      traces: args.traces,
    });
    if (!r.ok || !r.bytes) return { ok: false, error: r.error ?? 'conversion failed' };
    if (!win) return { ok: false, error: 'no window' };
    const base = args.baseName && args.baseName.trim() ? sanitizeBaseName(args.baseName) : 'workbench';
    const save = await dialog.showSaveDialog(win, { defaultPath: `${base}.${r.ext}`, filters: SEISMIC_FILTERS });
    if (save.canceled || !save.filePath) return { ok: false, canceled: true };
    await writeFile(save.filePath, Buffer.from(r.bytes));
    return { ok: true, path: save.filePath };
  },
);

// Convert a list of files to `format`, writing each into outDir under a name
// derived from the output-name template ({name}/{custom}/{fmt}/{date}/{time}/
// {seq3}/{n}) + writer ext. Emits a per-file progress event; honors cancel.
ipcMain.handle(
  'seisconv:batchConvert',
  async (
    _e,
    opts: { files: { name: string; path: string }[]; format: string; outDir: string; nameTemplate?: string; dateStr?: string; custom?: string; time?: string },
  ) => {
    const files = opts?.files ?? [];
    const tpl = opts?.nameTemplate || '{name}';
    const dateStr = opts?.dateStr || '';
    // {custom} + {time} are supplied once for the whole run (the renderer resolves
    // them at launch time); the per-file index drives {seq3}/{seq}/{n}.
    const custom = opts?.custom || '';
    const time = opts?.time || '';
    // The renderer supplies the input paths AND the output directory; neither is
    // trustworthy if the renderer is compromised. Only read inputs the user has
    // actually authorized (dialog/enumerated, same gate as extractTrace), and
    // only write into an output directory the user picked via pickOutputFolder.
    // Without these gates a compromised renderer could read any file on disk and
    // overwrite attacker-controlled bytes into any writable directory.
    if (!isAuthorizedDir(opts.outDir)) {
      return { ok: false, error: 'batchConvert: unauthorized output directory' };
    }
    const outDir = path.resolve(opts.outDir);
    lastBatchOutDir = outDir; // remember for "Open output folder"
    const total = files.length;
    const results: { name: string; ok: boolean; error?: string }[] = [];
    let done = 0;
    let failed = 0;
    let canceled = false;
    cancelRequested = false;

    const emit = (payload: { index: number; total: number; file: string; state: 'start' | 'done' | 'error' | 'cancelled' | 'finished'; error?: string }) => {
      win?.webContents.send('seisconv:convertProgress', payload);
    };

    // ── Tape image is a COMBINE target (memory-bounded, streamed to disk) ───────
    // A tape image is an archive of many records; converting a folder to TPIMAGE
    // must produce ONE combined .tpimage, not one tape per file. We STREAM the tape
    // to disk: write the VOL1 header, then for EACH input file ask the worker to
    // frame ONE record (parse + HDR/data/EOF) and append it to the write stream,
    // then write the closing tape marks. This never holds all inputs — or the whole
    // output — in RAM, so a 2/4/10 GB combine scales (bounded by disk, not memory),
    // emits genuine per-file progress, and the result opens via the streamed reader.
    if (opts.format === 'tpimage') {
      if (total === 0) { emit({ index: 0, total: 0, file: '', state: 'finished' }); return { ok: false, total: 0, done: 0, failed: 0, canceled: false, results: [] }; }
      // Authorize-gate every input (same trust boundary as the per-file path).
      const bad = files.find((f) => !isAuthorizedPath(f.path));
      if (bad) {
        emit({ index: 1, total, file: bad.name, state: 'error', error: 'unauthorized input file path' });
        emit({ index: total, total, file: '', state: 'finished' });
        return { ok: false, total, done: 0, failed: total, canceled: false, results: files.map((f) => ({ name: f.name, ok: false, error: 'unauthorized input file path' })) };
      }
      // ONE output file, named from the template with {name} = the source folder.
      const srcFolder = path.basename(path.dirname(files[0].path)) || 'tape_image';
      const base = applyNameTemplate(tpl, { name: srcFolder, fmt: 'tpimage', date: dateStr, custom, time, n: 1 });
      const outName = `${base}.tpimage`;
      const outPath = path.join(outDir, outName);
      // Tape-label date stamp (` YYJJJ`) resolved ONCE here (the worker has no clock)
      // so every streamed record shares it — keeping the assembled tape consistent.
      const now = new Date();
      // UTC Julian day: local-time arithmetic across a DST boundary can stamp '000'.
      const yy = String(now.getUTCFullYear()).slice(-2);
      const jd = String(Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000)).padStart(3, '0');
      const tapeDateStr = ` ${yy}${jd}`;

      const ws = createWriteStream(outPath);
      // Append a chunk and await its flush — backpressure keeps memory bounded even
      // when the worker out-runs the disk. Rejects on a write error so we abort.
      const append = (buf: Buffer): Promise<void> =>
        new Promise<void>((resolve, reject) => { ws.write(buf, (err) => (err ? reject(err) : resolve())); });

      let combined = 0;
      let seq = 0; // 0-based record sequence (only successfully-framed files advance it)
      // Named distinctly from the outer (non-tape) `results` so it doesn't shadow it.
      const tapeResults: { name: string; ok: boolean; error?: string }[] = [];
      try {
        await append(Buffer.from(writeTapeVolHeader())); // VOL1 label group
        for (let i = 0; i < total; i++) {
          const f = files[i];
          const index = i + 1;
          if (cancelRequested) { canceled = true; emit({ index, total, file: f.name, state: 'cancelled' }); break; }
          emit({ index, total, file: f.name, state: 'start' });
          const r = await callWorker<{ ok: boolean; bytes?: ArrayBuffer; error?: string }>(
            { type: 'convertTapeRecord', path: f.path, index: seq, dateStr: tapeDateStr },
          );
          if (!r.ok || !r.bytes) {
            failed++;
            const error = r.error ?? 'could not frame file';
            tapeResults.push({ name: f.name, ok: false, error });
            emit({ index, total, file: f.name, state: 'error', error });
            continue;
          }
          await append(Buffer.from(r.bytes));
          combined++; seq++;
          tapeResults.push({ name: f.name, ok: true });
          emit({ index, total, file: f.name, state: 'done' });
        }
        await append(Buffer.from(writeTapeEnd())); // closing double tape mark
        await new Promise<void>((resolve) => ws.end(resolve));
      } catch (e) {
        try { ws.destroy(); } catch { /* already closed */ }
        try { await unlink(outPath); } catch { /* nothing to remove */ } // drop the partial tape
        const error = (e as Error).message;
        emit({ index: total, total, file: '', state: 'error', error });
        emit({ index: total, total, file: '', state: 'finished' });
        return { ok: false, total, done: combined, failed: total - combined, canceled, results: tapeResults.length ? tapeResults : [{ name: outName, ok: false, error }] };
      }
      // Every input failed → the file on disk is just the VOL1 header + closing tape
      // marks (a spurious ~96-byte empty tape). Remove it and don't claim success.
      if (combined === 0) {
        try { await unlink(outPath); } catch { /* nothing to remove */ }
        emit({ index: total, total, file: '', state: 'finished' });
        return { ok: false, total, done: 0, failed, canceled, results: tapeResults };
      }
      emit({ index: total, total, file: '', state: 'finished' });
      return { ok: failed === 0 && combined > 0 && !canceled, total, done: combined, failed, canceled, results: tapeResults };
    }

    for (let i = 0; i < total; i++) {
      const f = files[i];
      const index = i + 1;
      if (cancelRequested) {
        canceled = true;
        emit({ index, total, file: f.name, state: 'cancelled' });
        break;
      }
      emit({ index, total, file: f.name, state: 'start' });
      try {
        // Only convert inputs the user actually authorized (dialog/enumerated),
        // mirroring extractTrace — the worker reads f.path with no gate of its own.
        if (!isAuthorizedPath(f.path)) throw new Error('unauthorized input file path');
        // Bound memory BEFORE dispatch: the worker reads the file whole to convert it,
        // so refuse anything larger than the in-memory cap (record an error result for
        // this file) rather than OOMing the worker on readFileSync.
        let inSize = 0;
        try { inSize = (await stat(f.path)).size; } catch { throw new Error('could not read input file'); }
        if (inSize > IN_MEMORY_MAX) throw new Error(`file too large to convert in memory (${(inSize / 1e9).toFixed(2)} GB) — convert or split it first`);
        const r = await callWorker<{ ok: boolean; bytes?: ArrayBuffer; ext?: string; error?: string }>({ type: 'convertPath', path: f.path, format: opts.format });
        if (!r.ok || !r.bytes) throw new Error(r.error ?? 'conversion failed');
        const inputBase = f.name.replace(/\.[^.]+$/, '');
        const base = applyNameTemplate(tpl, { name: inputBase, fmt: opts.format, date: dateStr, custom, time, n: index });
        await writeFile(path.join(outDir, `${base}.${r.ext}`), Buffer.from(r.bytes));
        done++;
        results.push({ name: f.name, ok: true });
        emit({ index, total, file: f.name, state: 'done' });
      } catch (e) {
        failed++;
        const error = (e as Error).message;
        results.push({ name: f.name, ok: false, error });
        emit({ index, total, file: f.name, state: 'error', error });
      }
    }

    emit({ index: total, total, file: '', state: 'finished' });
    return { ok: failed === 0 && !canceled, total, done, failed, canceled, results };
  },
);

// Reveal the last conversion OUTPUT in the OS file explorer (the "Open output
// folder" button on the finished convert wizards). `which:'single'` reveals +
// selects the exact saved file; `which:'batch'` opens the batch/combine output
// directory. Only the remembered user-chosen save path / authorized output dir is
// opened — never a renderer-supplied path — so this can't reveal arbitrary files.
ipcMain.handle('seisconv:openOutputFolder', async (_e, which: 'single' | 'batch') => {
  try {
    if (which === 'batch') {
      if (!lastBatchOutDir || !isAuthorizedDir(lastBatchOutDir)) return { ok: false };
      const err = await shell.openPath(lastBatchOutDir);
      return err ? { ok: false, error: err } : { ok: true };
    }
    if (!lastSavedFilePath) return { ok: false };
    shell.showItemInFolder(lastSavedFilePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

// Clear the open file + cached state in the worker.
ipcMain.handle('seisconv:resetState', async () => {
  await callWorker({ type: 'reset' });
  lastOpenedPath = '';
  siblingPaths = [];
  siblingIndex = -1;
  // Also forget the last conversion-output locations: resetState scopes the working
  // set to nothing, so "Open output folder" must not reveal a prior save dir.
  lastSavedFilePath = '';
  lastBatchOutDir = '';
  // Scope the read/write allowlists to the current working set: resetState drops
  // the open file + siblings, so the paths the user touched before should no
  // longer be reachable by a (possibly compromised) renderer. Without this the
  // sets grow unbounded for the whole process lifetime and keep granting access
  // to every path the user ever opened.
  authorizedPaths.clear();
  authorizedDirs.clear();
  // Reset also kills the live trigger sources (folder watch / UDP / serial);
  // the 'stopped' status pushes let the Trigger Watch UI un-arm itself.
  stopTriggerWatch();
});

ipcMain.handle('seisconv:openSPS', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Positioning files', extensions: ['s', 'r', 'x', 's01', 'r01', 'x01', 'sps', 'p1', 'segp1', 'p111', 'p611', 'csv', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const r = await callWorker<{ ok: boolean; summary?: any; error?: string }>({ type: 'openSPS', paths: res.filePaths });
  if (!r.ok) throw new Error(r.error || 'SPS parse failed');
  return r.summary;
});

// Clear ONLY the loaded SPS survey in the worker (currentSPS + currentSPSFiles),
// leaving any open seismic file intact. Distinct from resetState, which also
// drops the open file; this backs the SPS tab's dedicated "Clear SPS" button.
ipcMain.handle('seisconv:spsClear', async () => {
  await callWorker({ type: 'spsClear' });
});

// Return the loaded P6/11 bin grid (or null when none is loaded). Populated when
// openSPS ingests a positioning file that resolves to a bin grid rather than points.
ipcMain.handle('seisconv:binGrid', async () => {
  const r = await callWorker<{ ok: boolean; grid?: unknown; error?: string }>({ type: 'binGrid' });
  if (!r.ok) throw new Error(r.error || 'bin grid failed');
  return r.grid ?? null;
});

ipcMain.handle('seisconv:spsGeometry', async (_e, geo: boolean) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'spsGeometry', geo });
  if (!r.ok) throw new Error(r.error || 'sps geometry failed');
  return { geo: r.geo, src: r.src, rcv: r.rcv, bbox: r.bbox };
});

// X-ref "spider": shot → live-receiver connection segments as parallel typed
// arrays (sx/sy/rx/ry) + a per-shot group id (shot) and shotKeys mapping.
ipcMain.handle('seisconv:spsXrefLines', async (_e, geo: boolean) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'spsXrefLines', geo });
  if (!r.ok) throw new Error(r.error || 'sps xref lines failed');
  return { geo: r.geo, sx: r.sx, sy: r.sy, rx: r.rx, ry: r.ry, shot: r.shot, shotKeys: r.shotKeys, decimated: r.decimated, log: r.log };
});

// FOLD / coverage bin map: CMP-midpoint counts per bin, as a row-major Int32
// grid (nx × ny) anchored at (originX, originY) in projected E/N.
ipcMain.handle('seisconv:spsFold', async (_e, opts: { binX: number; binY: number }) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'spsFold', binX: opts?.binX, binY: opts?.binY });
  if (!r.ok) throw new Error(r.error || 'sps fold failed');
  return { nx: r.nx, ny: r.ny, binX: r.binX, binY: r.binY, originX: r.originX, originY: r.originY, fold: r.fold, maxFold: r.maxFold, totalMid: r.totalMid, decimated: r.decimated, log: r.log };
});

ipcMain.handle('seisconv:spsQC', async (_e, qc: Record<string, number>) => {
  const r = await callWorker<{ ok: boolean; results?: unknown[]; error?: string }>({ type: 'spsQC', qc });
  if (!r.ok) throw new Error(r.error || 'QC failed');
  return r.results;
});

// Fetch the FULL field set of one source/receiver point (the worker owns the
// parsed SPSData; the renderer only holds bare position arrays). Returns null
// when no SPS is loaded or the point can't be matched.
ipcMain.handle('seisconv:spsPointDetail', async (_e, args: { rtype: 'S' | 'R'; lineName: string; point: number; idx?: string }) => {
  const r = await callWorker<{ ok: boolean; detail?: Record<string, unknown> | null; error?: string }>({ type: 'spsPointDetail', ...(args || {}) });
  if (!r.ok) throw new Error(r.error || 'point detail failed');
  return r.detail ?? null;
});

// Geometry Integrity Suite: cross-check the OPEN seismic file's trace-header
// geometry against the loaded SPS survey (the worker holds both). `tolM` (the
// station-match tolerance in metres) is sanitized to a finite number here, then
// passed through; the worker returns { ok, result } or { ok:false, error }.
ipcMain.handle('seisconv:spsGeomCheck', async (_e, opts: { tolM?: number }) => {
  const tolM = typeof opts?.tolM === 'number' && Number.isFinite(opts.tolM) ? opts.tolM : undefined;
  const r = await callWorker<{ ok: boolean; result?: unknown; error?: string }>({ type: 'spsGeomCheck', tolM });
  return { ok: r.ok, result: r.result, error: r.error };
});

// Load geometry into SEG-Y (the WRITE counterpart of spsGeomCheck): stamp the
// loaded SPS survey's coordinates into the open SEG-Y's trace headers and save the
// geometry-loaded SEG-Y via a native dialog. The worker re-reads the ORIGINAL file
// to patch its bytes in place, so we inject `lastOpenedPath` (the open file's path,
// tracked here — never a renderer-supplied path) and pass the sanitized options.
// The match summary is returned regardless of the save outcome (so the user sees
// matched/unmatched even on cancel); `savedPath` is set only when Save completes.
ipcMain.handle(
  'seisconv:spsGeomLoad',
  async (_e, opts: { tolM?: number; coordScalar?: number; writeCoords?: boolean; writeElev?: boolean; writeOffset?: boolean; writeCdp?: boolean }) => {
    const tolM = typeof opts?.tolM === 'number' && Number.isFinite(opts.tolM) ? opts.tolM : undefined;
    const coordScalar = typeof opts?.coordScalar === 'number' && Number.isFinite(opts.coordScalar) ? opts.coordScalar : undefined;
    const r = await callWorker<{ ok: boolean; bytes?: ArrayBuffer; summary?: Record<string, unknown>; error?: string }>({
      type: 'spsGeomLoad',
      path: lastOpenedPath,
      tolM,
      coordScalar,
      writeCoords: opts?.writeCoords,
      writeElev: opts?.writeElev,
      writeOffset: opts?.writeOffset,
      writeCdp: opts?.writeCdp,
    });
    if (!r.ok || !r.bytes) return { ok: false, error: r.error ?? 'geometry load failed' };
    if (!win) return { ok: false, error: 'no window' };
    const base = lastOpenedPath ? path.basename(lastOpenedPath).replace(/\.[^.]+$/, '') : 'output';
    const save = await dialog.showSaveDialog(win, { defaultPath: `${base}_geom.sgy`, filters: SEISMIC_FILTERS });
    if (save.canceled || !save.filePath) return { ok: true, canceled: true, summary: r.summary };
    await writeFile(save.filePath, Buffer.from(r.bytes));
    return { ok: true, savedPath: save.filePath, summary: r.summary };
  },
);

// As-laid vs Pre-plot delta ("skid report"): diff the LOADED survey (as-laid)
// against a SEPARATELY-chosen REFERENCE (pre-plot / planned) SPS. Opens its OWN
// multi-select picker (same filters/flow as openSPS), reads the user-picked
// reference files the same way the worker reads openSPS inputs (UTF-8, 64 MB
// cap, basename only), and hands their TEXT to the worker — which parses them
// into their OWN SPSData WITHOUT merging into / mutating the loaded survey, then
// runs the pure compareSPS. `tolM` (the over-tolerance flag distance, metres) is
// sanitized to a finite number here. Only the user-picked dialog paths are read
// (path-allowlist discipline). Dialog cancel → { ok:false, canceled:true }.
ipcMain.handle('seisconv:spsDelta', async (_e, opts: { tolM?: number }) => {
  if (!win) return { ok: false, error: 'no window' };
  const tolM = typeof opts?.tolM === 'number' && Number.isFinite(opts.tolM) ? opts.tolM : undefined;
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Positioning files', extensions: ['s', 'r', 'x', 's01', 'r01', 'x01', 'sps', 'p1', 'segp1', 'p111', 'p611', 'csv', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  // Bound memory before reading: skip any reference file larger than the worker's
  // own openSPS cap so a hostile multi-GB file can't exhaust memory pre-parse.
  const MAX_SPS_FILE_BYTES = 64 * 1024 * 1024; // 64 MB (mirrors the worker)
  const referenceFiles: { name: string; text: string }[] = [];
  for (const p of res.filePaths) {
    try { if ((await stat(p)).size > MAX_SPS_FILE_BYTES) continue; } catch { continue; }
    try { referenceFiles.push({ name: path.basename(p), text: await readFile(p, 'utf8') }); } catch { continue; }
  }
  if (!referenceFiles.length) return { ok: false, error: 'Could not read the chosen reference SPS file(s).' };
  const r = await callWorker<{ ok: boolean; result?: unknown; error?: string; refName?: string }>({ type: 'spsDelta', referenceFiles, tolM });
  return { ok: r.ok, result: r.result, error: r.error, refName: r.refName };
});

ipcMain.handle('seisconv:spsReproject', async (_e, code: string) => {
  const r = await callWorker<{ ok: boolean; files?: { name: string; text: string }[]; error?: string }>({ type: 'spsReproject', code });
  if (!r.ok || !r.files) return { ok: false, error: r.error ?? 'reprojection failed' };
  if (!win) return { ok: false, error: 'no window' };
  const zip = new JSZip();
  for (const f of r.files) zip.file(f.name, f.text);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const tag = code.replace(':', '');
  const save = await dialog.showSaveDialog(win, { defaultPath: `reprojected_${tag}.zip`, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, buf);
  return { ok: true, path: save.filePath };
});

// SPS SURVEY GENERATOR: the worker generates a fresh survey from the map picks
// (and installs it as the loaded survey), returning the synthesized S/R/X files;
// we ZIP + save them via a native dialog (same flow as spsReproject). Fields are
// forwarded EXPLICITLY (no spread) so a compromised renderer can't inject worker
// routing keys (path/type/format). The survey is loaded even when the save is
// cancelled, so the summary is returned regardless of the save outcome.
ipcMain.handle(
  'seisconv:spsCreate',
  async (
    _e,
    req: {
      crs: Record<string, unknown>;
      baseName?: string;
      picks: { vertices: { lat: number; lon: number }[] }[];
      mode?: '2D' | '3D';
      rcvInterval?: number; srcInterval?: number;
      rcvLineStart?: number; rcvLineInc?: number; rcvPointStart?: number; rcvPointInc?: number;
      srcLineStart?: number; srcLineInc?: number; srcPointStart?: number; srcPointInc?: number;
      relation?: { type: 'full' | 'split'; channels?: number };
      srcType?: string; rcvType?: string;
    },
  ) => {
    // Stamp the 'H26 Date file written' header value here (the worker can't read
    // the clock). Local time, 'YYYY-MM-DD HH:MM:SS' to match real SPS software.
    const now = new Date();
    const p2 = (n: number): string => String(n).padStart(2, '0');
    const dateWritten = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
    const r = await callWorker<{ ok: boolean; summary?: any; files?: { name: string; text: string }[]; error?: string }>({
      type: 'spsCreate',
      crs: req?.crs,
      baseName: req?.baseName,
      dateWritten,
      picks: req?.picks,
      mode: req?.mode,
      rcvInterval: req?.rcvInterval, srcInterval: req?.srcInterval,
      rcvLineStart: req?.rcvLineStart, rcvLineInc: req?.rcvLineInc,
      rcvPointStart: req?.rcvPointStart, rcvPointInc: req?.rcvPointInc,
      srcLineStart: req?.srcLineStart, srcLineInc: req?.srcLineInc,
      srcPointStart: req?.srcPointStart, srcPointInc: req?.srcPointInc,
      relation: req?.relation,
      srcType: req?.srcType, rcvType: req?.rcvType,
    });
    if (!r.ok) return { ok: false, error: r.error ?? 'create failed' };
    if (!win) return { ok: false, error: 'no window' };
    const zip = new JSZip();
    for (const f of r.files ?? []) zip.file(f.name, f.text);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const base = sanitizeBaseName(req?.baseName ?? 'survey');
    const save = await dialog.showSaveDialog(win, { defaultPath: `${base}_sps.zip`, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
    if (save.canceled || !save.filePath) return { ok: true, summary: r.summary, canceled: true };
    await writeFile(save.filePath, buf);
    return { ok: true, summary: r.summary, savedPath: save.filePath };
  },
);

// SPS RENUMBER: the worker re-maps the loaded survey's line/point ids (refreshing
// the loaded survey + keeping X-refs consistent) and returns the renumbered S/R/X
// files; we ZIP + save them (same flow as spsReproject). The renumber is applied
// to the loaded survey even when the save is cancelled, so the summary is returned
// regardless of the save outcome.
ipcMain.handle(
  'seisconv:spsRenumber',
  async (
    _e,
    req: { spec?: { source?: Record<string, unknown>; receiver?: Record<string, unknown> }; baseName?: string },
  ) => {
    const r = await callWorker<{ ok: boolean; summary?: any; files?: { name: string; text: string }[]; error?: string }>({
      type: 'spsRenumber',
      spec: req?.spec,
      baseName: req?.baseName,
    });
    if (!r.ok) return { ok: false, error: r.error ?? 'renumber failed' };
    if (!win) return { ok: false, error: 'no window' };
    const zip = new JSZip();
    for (const f of r.files ?? []) zip.file(f.name, f.text);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const base = sanitizeBaseName(req?.baseName ?? 'survey');
    const save = await dialog.showSaveDialog(win, { defaultPath: `${base}_renum.zip`, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
    if (save.canceled || !save.filePath) return { ok: true, summary: r.summary, canceled: true };
    await writeFile(save.filePath, buf);
    return { ok: true, summary: r.summary, savedPath: save.filePath };
  },
);

// SPS HEADER VIEWER: return the shared H block (code/val/raw/desc), the parsed
// projection, the loaded-file list, and whether the files' H blocks differ.
ipcMain.handle('seisconv:spsHeaderList', async () => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'spsHeaderList' });
  if (!r.ok) throw new Error(r.error || 'sps header list failed');
  return { ok: true, headers: r.headers ?? [], projection: r.projection ?? null, files: r.files ?? [], filesDiffer: !!r.filesDiffer };
});

// SPS HEADER EDITOR: apply an edit/add/remove batch (+ optional CRS rewrite) to
// the loaded survey's H block(s), re-parse in the worker, and return the
// refreshed header list. Does NOT save to disk — that's spsSaveCorrected.
ipcMain.handle(
  'seisconv:spsApplyHeaders',
  async (
    _e,
    req: {
      scope: 'shared' | string;
      edits: { code: string; val: string; oldVal?: string }[];
      adds: { code: string; desc?: string; val: string }[];
      removes: (string | { code: string; oldVal?: string })[];
      crs?: Record<string, unknown>;
    },
  ) => {
    const r = await callWorker<{ ok: boolean; headers?: unknown[]; error?: string }>({
      type: 'spsApplyHeaders',
      scope: req?.scope ?? 'shared',
      edits: req?.edits ?? [],
      adds: req?.adds ?? [],
      removes: req?.removes ?? [],
      crs: req?.crs,
    });
    if (!r.ok) return { ok: false, headers: [], error: r.error ?? 'apply headers failed' };
    return { ok: true, headers: r.headers ?? [] };
  },
);

// SPS HEADER EDITOR — save: ZIP the edited currentSPSFiles and write via a native
// dialog. Reuses the spsReproject ZIP save flow (JSZip + showSaveDialog + writeFile).
ipcMain.handle('seisconv:spsSaveCorrected', async () => {
  const r = await callWorker<{ ok: boolean; files?: { name: string; text: string }[]; error?: string }>({ type: 'spsSaveCorrected' });
  if (!r.ok || !r.files) return { ok: false, error: r.error ?? 'save failed' };
  if (!win) return { ok: false, error: 'no window' };
  const zip = new JSZip();
  for (const f of r.files) zip.file(f.name, f.text);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const save = await dialog.showSaveDialog(win, { defaultPath: 'sps_corrected.zip', filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, buf);
  return { ok: true, path: save.filePath };
});

// SPS geographic / tabular exports (KML, GeoJSON, CSV trio, QC-report CSV). The
// worker returns one-or-more {name,text} files; we save them with the SAME flow
// as spsReproject: multi-file output is zipped (JSZip), single-file output uses a
// plain native save dialog. The CSV kind yields three files → ZIP; kml / geojson /
// qcreport each yield one file → single-file Save dialog.
ipcMain.handle('seisconv:spsExport', async (_e, args: { kind: 'kml' | 'geojson' | 'csv' | 'qcreport' | 'p111' | 'coordcsv'; qcParams?: Record<string, number> }) => {
  const r = await callWorker<{ ok: boolean; files?: { name: string; text: string }[]; error?: string }>({ type: 'spsExport', kind: args?.kind, qcParams: args?.qcParams });
  if (!r.ok || !r.files) return { ok: false, error: r.error ?? 'export failed' };
  if (!win) return { ok: false, error: 'no window' };

  if (r.files.length > 1) {
    // Same packaging path as the reproject ZIP export.
    const zip = new JSZip();
    for (const f of r.files) zip.file(f.name, f.text);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const save = await dialog.showSaveDialog(win, { defaultPath: `sps_${args.kind}.zip`, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
    if (save.canceled || !save.filePath) return { ok: false, canceled: true };
    await writeFile(save.filePath, buf);
    return { ok: true, path: save.filePath };
  }

  // Single-file: same single-file Save flow as exportText.
  const f = r.files[0];
  const save = await dialog.showSaveDialog(win, { defaultPath: f.name });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, f.text, 'utf8');
  return { ok: true, path: save.filePath };
});

ipcMain.handle('seisconv:semblance', async (_e, opts: { velMin: number; velMax: number; velStep: number }) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'semblance', ...paramOpts(opts) });
  if (!r.ok) throw new Error(r.error || 'semblance failed');
  return { semb: r.semb, vels: r.vels, nT: r.nT, dt: r.dt, siUs: r.siUs, offNote: r.offNote };
});

// Spectrum Analysis tab: average amplitude spectrum, single-trace spectrogram
// (STFT), and the section's f-k spectrum. Each forwards the open file's typed
// arrays straight through from the worker (transferred, zero-copy).
ipcMain.handle('seisconv:avgSpectrum', async (_e, opts: { traceStart?: number; traceEnd?: number }) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'avgSpectrum', ...paramOpts(opts) });
  if (!r.ok) throw new Error(r.error || 'avgSpectrum failed');
  return { freqs: r.freqs, amp: r.amp, nyquist: r.nyquist, nTraces: r.nTraces, decimated: r.decimated, log: r.log };
});

ipcMain.handle('seisconv:spectrogram', async (_e, opts: { index: number; winLen?: number; hop?: number }) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'spectrogram', ...paramOpts(opts) });
  if (!r.ok) throw new Error(r.error || 'spectrogram failed');
  return { mag: r.mag, nFrames: r.nFrames, nBins: r.nBins, freqs: r.freqs, times: r.times, maxMag: r.maxMag, siUs: r.siUs };
});

ipcMain.handle('seisconv:fk', async (_e, opts: { dx?: number }) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'fk', ...paramOpts(opts) });
  if (!r.ok) throw new Error(r.error || 'fk failed');
  return { mag: r.mag, nKx: r.nKx, nF: r.nF, kAxis: r.kAxis, fAxis: r.fAxis, maxMag: r.maxMag, decimated: r.decimated, log: r.log };
});

// File Viewer: trace-health QC scan over the open file's traces. Forwards the
// sensitivity/threshold + structural opts and returns the cached evidence buffer +
// header arrays + an honest coverage report for the renderer to classify.
ipcMain.handle('seisconv:traceHealth', async (_e, opts: Record<string, unknown>) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'traceHealth', ...paramOpts(opts) });
  if (!r.ok) throw new Error(r.error || 'traceHealth failed');
  return {
    evidence: r.evidence, evStride: r.evStride, traceIndex: r.traceIndex,
    ffid: r.ffid, channel: r.channel, offset: r.offset,
    sampleInt: r.sampleInt, coverage: r.coverage,
  };
});

// File Viewer: assisted (seeded) first-break picking. Forwards the seed picks +
// picker tuning to the worker, which operates on REAL adjacent traces (step 1) and
// returns one pick per trace keyed by absolute index + the moveout guide curve.
ipcMain.handle('seisconv:firstBreaks', async (_e, opts: Record<string, unknown>) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'firstBreaks', ...paramOpts(opts) });
  if (!r.ok) throw new Error(r.error || 'firstBreaks failed');
  return {
    sampleInt: r.sampleInt, windowMs: r.windowMs, hasOffsets: r.hasOffsets,
    traceStart: r.traceStart, traceEnd: r.traceEnd,
    pAbs: r.pAbs, pTime: r.pTime, pSource: r.pSource, pConf: r.pConf, pDev: r.pDev,
    pFfid: r.pFfid, pChan: r.pChan, pOff: r.pOff, gAbs: r.gAbs, guide: r.guide,
  };
});

ipcMain.handle('seisconv:exportText', async (_e, args: { name: string; text: string }) => {
  if (!win) return { ok: false };
  const save = await dialog.showSaveDialog(win, { defaultPath: args.name });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, args.text, 'utf8');
  return { ok: true, path: save.filePath };
});

// Append `.ext` to a path unless it already ends with it (case-insensitive), so a
// native save dialog that dropped the suffix can't yield an extension-less file
// (e.g. an .xlsx saved without its suffix that Excel then opens as empty).
function ensureExt(p: string, ext: string): string {
  return p.toLowerCase().endsWith('.' + ext.toLowerCase()) ? p : `${p}.${ext}`;
}

// Save arbitrary BINARY bytes (e.g. an .xlsx / .ods the renderer built in-core)
// via a native dialog. Mirrors exportText but writes a Buffer instead of a UTF-8
// string. `bytes` arrives as a Uint8Array over IPC (structured-clone safe).
// We derive a filter + enforce the suffix from args.name's extension so the saved
// file always carries the right extension (fixes obslog XLSX opening empty).
ipcMain.handle('seisconv:exportBinary', async (_e, args: { name: string; bytes: Uint8Array }) => {
  if (!win) return { ok: false };
  const ext = path.extname(args.name || '').replace(/^\./, '').toLowerCase();
  const filters =
    ext === 'xlsx' ? [{ name: 'Excel workbook', extensions: ['xlsx'] }] :
    ext === 'ods' ? [{ name: 'OpenDocument Spreadsheet', extensions: ['ods'] }] :
    undefined;
  const save = await dialog.showSaveDialog(
    win,
    filters ? { defaultPath: args.name, filters } : { defaultPath: args.name },
  );
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  const outPath = ext ? ensureExt(save.filePath, ext) : save.filePath;
  await writeFile(outPath, Buffer.from(args.bytes));
  return { ok: true, path: outPath };
});

// Read a user-picked JSON file with a size bound, so a pathologically large file
// can't be slurped + JSON.parse'd + materialized into renderer state unbounded.
// Observer-log / template JSON is at most a few MB in practice; 64 MB is generous.
const MAX_JSON_BYTES = 64 * 1024 * 1024;
async function readJsonFileBounded(path: string): Promise<unknown> {
  const st = await stat(path);
  if (st.size > MAX_JSON_BYTES) {
    throw new Error(`file too large (${st.size} bytes > ${MAX_JSON_BYTES} cap)`);
  }
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

// Observer Log RELOAD: open a .json picker, read + parse it, and return the
// {meta, columns, rows} payload (or null if cancelled / unreadable). The shape
// matches what the renderer saves via exportText('observer-log.json', …).
ipcMain.handle('seisconv:openLogJson', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Observer Log (JSON)', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const o = (await readJsonFileBounded(res.filePaths[0])) as { meta?: unknown; columns?: unknown; rows?: unknown };
  return {
    meta: o && typeof o.meta === 'object' && o.meta ? o.meta : {},
    columns: Array.isArray(o?.columns) ? o.columns : [],
    rows: Array.isArray(o?.rows) ? o.rows : [],
  };
});

// Observer Log TEMPLATE import: open a .json picker, read + parse it, and return
// the RAW parsed object (or null if cancelled / unreadable). Unlike openLogJson
// (which narrows to {meta,columns,rows}), templates carry {meta,columns,srcType,
// timeSource}, so we hand the renderer the whole object to validate itself.
ipcMain.handle('seisconv:openTemplateJson', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Observer Log template (JSON)', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return readJsonFileBounded(res.filePaths[0]);
});

// Observer Log "Sync clock": query an SNTP server over UDP and return the offset
// (serverTimeMs - local Date.now()). Never throws — a failed/offline query
// resolves { ok: false, error }. Default server 'pool.ntp.org'.
ipcMain.handle('seisconv:ntpSync', async (_e, server?: string) => {
  const host = (typeof server === 'string' && server.trim()) ? server.trim() : 'pool.ntp.org';
  if (isInternalNtpHost(host)) return { ok: false, error: 'NTP server must be a public host (internal/loopback addresses are blocked)' };
  return sntpQuery(host);
});

// Observer Log SPS-linking: flat list of the loaded survey's source records, for
// columns the user links to an SPS source field. Forwards to the worker (which
// owns the parsed SPSData); returns { sources: [] } when no survey is loaded.
ipcMain.handle('seisconv:spsSourceList', async () => {
  const r = await callWorker<{ ok: boolean; sources?: unknown[]; error?: string }>({ type: 'spsSourceList' });
  if (!r.ok) throw new Error(r.error || 'sps source list failed');
  return { sources: r.sources ?? [] };
});

// ════════════════ Observer Log "Trigger Watch" hub ════════════════
// Live trigger sources that push events to the renderer so the Observer Log can
// add a row THE MOMENT a shot happens:
//   folder — fs.watch on the acquisition (SCS) survey folder. A new/updated
//            shot file (INPUT_EXTS) is a trigger event AND the enrichment
//            source for the other two. Strictly READ-ONLY: this hub only ever
//            watch/readdir/stat/reads the folder — it never writes into it.
//   udp    — dgram text/JSON datagrams, bound to 127.0.0.1 by DEFAULT; binding
//            all interfaces (LAN) is an explicit renderer opt-in. Packets are
//            length-capped, defensively parsed (core/trigger/parse) and
//            debounced, so a hostile datagram can at worst be dropped.
//   serial — the trigger box's `[SHOT] #id Lline:SPsp ts=…` USB-serial feed
//            (arrives with the next update; validation is already strict).
// Events push via webContents.send('seisconv:triggerEvent', …) — the same push
// pattern as 'seisconv:workerProgress'. All sources are killed on window close
// and on resetState, and restarted from scratch on every reconfigure.

const TRIG_SETTLE_MS = 500;          // folder-event debounce + size-settle period
const TRIG_UDP_DEBOUNCE_MS = 200;    // minimum gap between accepted datagrams
const TRIG_EMITTED_MAX = 1000;       // dedupe-memory cap (file name → mtime)
const TRIG_SCAN_MAX = 2000;          // catch-up scan file cap
const TRIG_QUICKMETA_MAX = 256 * 1024 * 1024; // mirrors the worker's own cap

let trigWatchDir = '';                        // resolved ACTIVE watch dir ('' = folder source off)
let trigWatcher: FSWatcher | null = null;
let trigUdp: dgram.Socket | null = null;
const trigTimers = new Map<string, NodeJS.Timeout>(); // per-file settle timers
const trigSizes = new Map<string, number>();          // last stat'ed size while settling
const trigEmitted = new Map<string, number>();        // file name → mtimeMs already emitted
let trigUdpLastMs = 0;

function trigSend(payload: Record<string, unknown>): void {
  win?.webContents.send('seisconv:triggerEvent', payload);
}
function trigStatus(source: 'folder' | 'udp' | 'serial' | 'scslog' | 'scstrig', state: 'started' | 'stopped' | 'error', detail?: string): void {
  trigSend({ type: 'status', source, state, ...(detail ? { detail } : {}) });
}

function stopTriggerFolder(silent = false): void {
  if (trigWatcher) { try { trigWatcher.close(); } catch { /* already dead */ } trigWatcher = null; }
  for (const t of trigTimers.values()) clearTimeout(t);
  trigTimers.clear();
  trigSizes.clear();
  trigEmitted.clear();
  if (trigWatchDir && !silent) trigStatus('folder', 'stopped');
  trigWatchDir = '';
}
function stopTriggerUdp(silent = false): void {
  if (!trigUdp) return;
  try { trigUdp.close(); } catch { /* already closed */ }
  trigUdp = null;
  if (!silent) trigStatus('udp', 'stopped');
}
/** Kill EVERY trigger source (window close / resetState / reconfigure). */
function stopTriggerWatch(silent = false): void {
  stopTriggerFolder(silent);
  stopTriggerUdp(silent);
  stopTriggerSerial(silent);
  stopTriggerScsLog(silent);
  stopTriggerScsTrig(silent);
  stopTriggerScFiles(); // enrichment watch (emits no status)
}

// A raw folder event: debounce per file name, then settle (below).
function trigConsider(name: string): void {
  if (!trigWatchDir) return;
  if (!INPUT_EXTS.has(path.extname(name).toLowerCase())) return;
  const t = trigTimers.get(name);
  if (t) clearTimeout(t);
  trigTimers.set(name, setTimeout(() => { void trigSettle(name); }, TRIG_SETTLE_MS));
}

// Settle a debounced file: stat-confirm it exists, wait until two consecutive
// stats agree on the size (the recorder may still be writing), then emit ONE
// trigger event per landing (deduped by mtime).
async function trigSettle(name: string): Promise<void> {
  trigTimers.delete(name);
  if (!trigWatchDir) return;
  const full = path.join(trigWatchDir, name);
  let st;
  try { st = await stat(full); } catch { trigSizes.delete(name); return; } // vanished mid-write
  if (!st.isFile() || st.size <= 0) { trigSizes.delete(name); return; }
  const prev = trigSizes.get(name);
  if (prev !== st.size) {
    // First sighting or still growing — remember the size and re-check after
    // one more settle period; emit only once the size is stable.
    trigSizes.set(name, st.size);
    trigTimers.set(name, setTimeout(() => { void trigSettle(name); }, TRIG_SETTLE_MS));
    return;
  }
  trigSizes.delete(name);
  const mtimeMs = Math.floor(st.mtimeMs);
  if (trigEmitted.get(name) === mtimeMs) return; // duplicate event burst for the same landing
  trigEmitted.set(name, mtimeMs);
  if (trigEmitted.size > TRIG_EMITTED_MAX) {
    const oldest = trigEmitted.keys().next().value;
    if (oldest != null) trigEmitted.delete(oldest);
  }
  trigSend({
    type: 'trigger', source: 'folder', name, path: full,
    mtimeMs, size: st.size, ts: new Date(mtimeMs).toISOString(),
  });
}

function startTriggerFolder(dir: string): { on: boolean; error?: string } {
  try {
    const w = watch(dir, { persistent: true }, (_evt, filename) => {
      if (typeof filename === 'string' && filename) trigConsider(filename);
    });
    w.on('error', (e) => {
      trigStatus('folder', 'error', (e as Error).message);
      stopTriggerFolder(true);
    });
    trigWatcher = w;
    trigWatchDir = dir;
    trigStatus('folder', 'started', dir);
    return { on: true };
  } catch (e) {
    return { on: false, error: (e as Error).message };
  }
}

function startTriggerUdp(port: number, bindAll: boolean): Promise<{ on: boolean; error?: string }> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let bound = false;
    sock.on('error', (e) => {
      if (!bound) { try { sock.close(); } catch { /* never bound */ } resolve({ on: false, error: (e as Error).message }); return; }
      trigStatus('udp', 'error', (e as Error).message);
      stopTriggerUdp(true);
    });
    sock.on('message', (buf) => {
      if (buf.length > TRIGGER_TEXT_MAX) return;                    // length cap
      const now = Date.now();
      if (now - trigUdpLastMs < TRIG_UDP_DEBOUNCE_MS) return;       // debounce bursts
      const msg = parseUdpTrigger(buf.toString('utf8'));            // defensive parse
      if (!msg) return;                                             // not a trigger → drop
      trigUdpLastMs = now;
      trigSend({
        type: 'trigger', source: 'udp', kind: msg.kind, id: msg.id,
        line: msg.line, sp: msg.sp, ts: msg.ts ?? new Date().toISOString(), raw: msg.raw,
      });
    });
    // localhost-only by default; 0.0.0.0 requires the explicit LAN opt-in.
    sock.bind({ port, address: bindAll ? '0.0.0.0' : '127.0.0.1' }, () => {
      bound = true;
      trigUdp = sock;
      trigStatus('udp', 'started', `${bindAll ? '0.0.0.0' : '127.0.0.1'}:${port}`);
      resolve({ on: true });
    });
  });
}

// ── Serial source: hidden PowerShell COM reader child ──
// The trigger box emits `[SHOT] #id Lline:SPsp ts=<gps-iso>` on USB-serial
// at every contact closure — the TRUE trigger-time feed. Read WITHOUT native
// deps: spawn a hidden PowerShell child that opens System.IO.Ports.SerialPort
// and pipes lines to stdout; main parses each line (core/trigger/parse) and
// pushes trigger events. Security: the COM name is allowlisted (^COM\d{1,3}$)
// and the baud comes from a fixed set BEFORE either is embedded in the fixed
// script template — no shell interpolation of user config ever happens, and
// the child is spawned with an argument ARRAY (no shell). Lines are length-
// capped and debounced like the UDP source.
//
// SEISCONV_TRIG_SERIAL_SIM=<n> (env, main-process only) swaps the SerialPort
// script for one that EMITS n simulated [SHOT] lines through the *same* child/
// stdout/parse/IPC path — how the feature is verified without the hardware
// (the box itself is exercised in the field).
const TRIG_SERIAL_BAUDS = new Set([9600, 19200, 38400, 57600, 115200, 230400]);
const TRIG_SERIAL_PORT_RE = /^COM\d{1,3}$/i;
const TRIG_SERIAL_OPEN_MARK = 'SEISCONV_SERIAL_OPEN';
const TRIG_SERIAL_OPEN_TIMEOUT_MS = 7000;
let trigSerial: ChildProcess | null = null;
let trigSerialLastMs = 0;

function stopTriggerSerial(silent = false): void {
  if (!trigSerial) return;
  const child = trigSerial;
  trigSerial = null;
  try { child.kill(); } catch { /* already gone */ }
  if (!silent) trigStatus('serial', 'stopped');
}

/** The fixed reader script. `port`/`baud` are pre-validated literals (COM name
 *  regex + baud allowlist), so the template carries no user-controlled text. */
function trigSerialReaderScript(port: string, baud: number): string {
  return [
    `$ErrorActionPreference='Stop'`,
    `try {`,
    `  $p = New-Object System.IO.Ports.SerialPort '${port}',${baud},([System.IO.Ports.Parity]::None),8,([System.IO.Ports.StopBits]::One)`,
    '  $p.NewLine = "`n"',
    `  $p.ReadTimeout = 1000`,
    `  $p.Open()`,
    `} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
    `[Console]::Out.WriteLine('${TRIG_SERIAL_OPEN_MARK}')`,
    `while ($true) {`,
    `  try { $l = $p.ReadLine(); if ($l) { [Console]::Out.WriteLine($l) } }`,
    `  catch [System.TimeoutException] { }`,
    `  catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }`,
    `}`,
  ].join('\n');
}

/** Simulation script (env-gated): n [SHOT] lines, 700 ms apart, GPS-style ts. */
function trigSerialSimScript(n: number): string {
  return [
    `[Console]::Out.WriteLine('${TRIG_SERIAL_OPEN_MARK}')`,
    `1..${n} | ForEach-Object {`,
    `  Start-Sleep -Milliseconds 700`,
    `  [Console]::Out.WriteLine('[SHOT] #' + $_ + ' L0395:SP' + (2000 + 2 * $_) + ' ts=' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'))`,
    `}`,
    `Start-Sleep -Milliseconds 800`,
  ].join('\n');
}

function startTriggerSerial(portName: string, baud: number): Promise<{ on: boolean; error?: string }> {
  return new Promise((resolve) => {
    const simRaw = process.env.SEISCONV_TRIG_SERIAL_SIM;
    const simN = simRaw ? Math.max(1, Math.min(10, Number(simRaw) || 3)) : 0;
    const script = simN > 0 ? trigSerialSimScript(simN) : trigSerialReaderScript(portName, baud);
    let child: ChildProcess;
    try {
      child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ on: false, error: (e as Error).message });
      return;
    }
    let opened = false;
    let settled = false;
    let buf = '';
    let errBuf = '';
    const settle = (r: { on: boolean; error?: string }) => { if (!settled) { settled = true; resolve(r); } };
    const onLine = (line: string) => {
      if (!opened) {
        if (line.trim() === TRIG_SERIAL_OPEN_MARK) {
          opened = true;
          trigSerial = child;
          trigStatus('serial', 'started', `${portName} @ ${baud}${simN ? ' (simulated)' : ''}`);
          settle({ on: true });
        }
        return; // pre-open chatter (PS banner noise) is ignored
      }
      const msg = parseTriggerLine(line);
      if (!msg) return;                                        // boot chatter / NMEA → skip
      const now = Date.now();
      if (now - trigSerialLastMs < TRIG_UDP_DEBOUNCE_MS) return; // debounce glitch bursts
      trigSerialLastMs = now;
      trigSend({
        type: 'trigger', source: 'serial', kind: msg.kind, id: msg.id,
        line: msg.line, sp: msg.sp, ts: msg.ts ?? new Date().toISOString(), raw: msg.raw,
      });
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 64 * 1024) buf = buf.slice(-8192); // runaway-feed guard
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.length <= TRIGGER_TEXT_MAX * 2) onLine(line); // oversize lines dropped
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => { errBuf = (errBuf + c).slice(-500); });
    child.on('error', (e) => {
      if (!opened) settle({ on: false, error: (e as Error).message });
      else { trigStatus('serial', 'error', (e as Error).message); stopTriggerSerial(true); }
    });
    child.on('exit', (code) => {
      if (trigSerial === child) {
        // Reader died while armed: a real COM read error is an ERROR; the
        // finite simulation script simply finishing is a clean stop.
        trigSerial = null;
        if (simN > 0) trigStatus('serial', 'stopped');
        else trigStatus('serial', 'error', errBuf.trim() || `serial reader exited (code ${code ?? '?'})`);
      } else if (!opened) {
        settle({ on: false, error: errBuf.trim() || `Could not open ${portName} (reader exited, code ${code ?? '?'})` });
      }
    });
    // Give PowerShell + the port a bounded window to open.
    setTimeout(() => {
      if (!opened) {
        try { child.kill(); } catch { /* already gone */ }
        settle({ on: false, error: errBuf.trim() || `Opening ${portName} timed out` });
      }
    }, TRIG_SERIAL_OPEN_TIMEOUT_MS);
  });
}

// ── SCS survey-log source: tail the Geometrics shot log ──
// SCS writes one line per shot to SC_Survey.####.log at TRIGGER time — even for
// shots that are never saved — so tailing it is the TRUE, file-independent
// trigger feed. Open + seek to EOF (only NEW shots; history is NOT replayed),
// then on every fs.watch tick read the appended bytes from lastOffset and split
// into complete lines. Each line is defensively parsed (core/trigger/parse);
// non-shot and READ (file re-read) lines are skipped, and shots are deduped on
// `<shot>@<time>`. On a size shrink / rotation the offset re-seeks to 0. The log
// is STRICTLY READ-ONLY: this source only stat/opens/reads it.
const TRIG_SCS_DEBOUNCE_MS = 120;               // append-burst debounce
const TRIG_SCS_SEEN_MAX = 5000;                 // dedupe-memory cap (shot@time keys)
const TRIG_SCS_READ_MAX = 1 * 1024 * 1024;      // max bytes pulled per read pass
const TRIG_SCS_BUF_MAX = 256 * 1024;            // partial-line buffer runaway guard
let trigScsWatcher: FSWatcher | null = null;
let trigScsPath = '';
let trigScsOffset = 0;
let trigScsBuf = '';
let trigScsTimer: NodeJS.Timeout | null = null;
let trigScsReading = false;
const trigScsSeen = new Set<string>();

function stopTriggerScsLog(silent = false): void {
  if (trigScsTimer) { clearTimeout(trigScsTimer); trigScsTimer = null; }
  if (trigScsWatcher) { try { trigScsWatcher.close(); } catch { /* already dead */ } trigScsWatcher = null; }
  trigScsBuf = '';
  trigScsOffset = 0;
  trigScsSeen.clear();
  if (trigScsPath && !silent) trigStatus('scslog', 'stopped');
  trigScsPath = '';
}

function trigScsSchedule(): void {
  if (trigScsTimer) clearTimeout(trigScsTimer);
  trigScsTimer = setTimeout(() => { trigScsTimer = null; void trigScsRead(); }, TRIG_SCS_DEBOUNCE_MS);
}

// One shot record: skip non-matches and READ re-reads, dedupe, then emit.
function trigScsHandleLine(line: string): void {
  if (line.length > TRIGGER_TEXT_MAX * 2) return;        // oversize → drop
  const p = parseScsLogLine(line);
  if (!p) return;                                        // not a shot record
  if (p.status === 'READ') return;                       // file re-read, NOT a new shot
  const key = scsLogKey(p);
  if (trigScsSeen.has(key)) return;                      // identical replayed line → dedupe
  trigScsSeen.add(key);
  if (trigScsSeen.size > TRIG_SCS_SEEN_MAX) {
    const oldest = trigScsSeen.values().next().value;
    if (oldest != null) trigScsSeen.delete(oldest);
  }
  trigSend({ type: 'trigger', source: 'scslog', shot: p.shot, time: p.time, date: p.date });
}

// Read appended bytes from lastOffset and process complete lines. Re-entrancy
// guarded (a watch burst can fire while a read is in flight).
async function trigScsRead(): Promise<void> {
  if (trigScsReading || !trigScsPath) return;
  trigScsReading = true;
  try {
    let st;
    try { st = await stat(trigScsPath); } catch { return; }   // vanished mid-tail
    if (!st.isFile()) return;
    if (st.size < trigScsOffset) { trigScsOffset = 0; trigScsBuf = ''; } // shrink/rotation → re-seek to 0
    if (st.size <= trigScsOffset) return;                     // nothing new
    const fh = await open(trigScsPath, 'r');
    try {
      let pos = trigScsOffset;
      while (pos < st.size) {
        const want = Math.min(TRIG_SCS_READ_MAX, st.size - pos);
        const b = Buffer.allocUnsafe(want);
        const { bytesRead } = await fh.read(b, 0, want, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        trigScsBuf += b.toString('utf8', 0, bytesRead);
        if (trigScsBuf.length > TRIG_SCS_BUF_MAX) trigScsBuf = trigScsBuf.slice(-(TRIG_SCS_BUF_MAX / 4)); // runaway guard
      }
      trigScsOffset = pos;
    } finally { await fh.close(); }
    let i: number;
    while ((i = trigScsBuf.indexOf('\n')) >= 0) {
      const line = trigScsBuf.slice(0, i).replace(/\r$/, '');
      trigScsBuf = trigScsBuf.slice(i + 1);
      trigScsHandleLine(line);
    }
  } catch { /* transient read error — the next watch tick retries */ }
  finally { trigScsReading = false; }
}

async function startTriggerScsLog(logPath: string): Promise<{ on: boolean; error?: string }> {
  try {
    const st = await stat(logPath);
    if (!st.isFile()) return { on: false, error: 'SCS log path is not a file.' };
    trigScsPath = logPath;
    trigScsOffset = st.size;   // seek to EOF — only NEW shots; do NOT replay history
    trigScsBuf = '';
    trigScsSeen.clear();
    const w = watch(logPath, { persistent: true }, () => { trigScsSchedule(); });
    w.on('error', (e) => { trigStatus('scslog', 'error', (e as Error).message); stopTriggerScsLog(true); });
    trigScsWatcher = w;
    trigStatus('scslog', 'started', logPath);
    return { on: true };
  } catch (e) {
    return { on: false, error: (e as Error).message };
  }
}

// ── SCS TempCom passive-trigger source: fs.watch the trigger scratch folder ──
// At the instant of EACH trigger, SCS touches ~6 scratch files in
// C:\GeometricsSurveysAndSettings\SC\TempCom (TmpH0.00N, TmpN0.00N, …) — even for
// shots that are never saved — so a fs.watch on that folder is a PASSIVE,
// file-independent trigger feed. This source is STRICTLY OBSERVE-ONLY: it never
// writes into the folder, never opens/reads the scratch files, and never sends
// SCS any input — it only reacts to the fact that a `Tmp*` file was touched.
// A single physical trigger fans out into a short burst of touches, so the
// leading-edge debounce collapses every `Tmp*` touch within SCS_TRIG_WINDOW_MS
// of the last accepted one into ONE trigger event (one shot = one row). `STAT.*`
// heartbeat touches (which fire between shots) are filtered out (isScsTrigTouch).
let trigScsTrigWatcher: FSWatcher | null = null;
let trigScsTrigDir = '';
let trigScsTrigLastMs = 0;

function stopTriggerScsTrig(silent = false): void {
  if (trigScsTrigWatcher) { try { trigScsTrigWatcher.close(); } catch { /* already dead */ } trigScsTrigWatcher = null; }
  trigScsTrigLastMs = 0;
  if (trigScsTrigDir && !silent) trigStatus('scstrig', 'stopped');
  trigScsTrigDir = '';
}

// One raw folder touch: keep only `Tmp*` files, then leading-edge debounce so a
// multi-file burst collapses to a single trigger event (now = wall clock).
function trigScsTrigConsider(filename: string): void {
  if (!trigScsTrigDir) return;
  if (!isScsTrigTouch(filename)) return;                       // STAT.* / non-Tmp → ignore
  const now = Date.now();
  if (trigScsTrigLastMs > 0 && now - trigScsTrigLastMs < SCS_TRIG_WINDOW_MS) return; // collapse burst
  trigScsTrigLastMs = now;
  trigSend({ type: 'trigger', source: 'scstrig', ts: new Date(now).toISOString() });
}

function startTriggerScsTrig(dir: string): { on: boolean; error?: string } {
  try {
    const w = watch(dir, { persistent: true, recursive: false }, (_evt, filename) => {
      if (typeof filename === 'string' && filename) trigScsTrigConsider(filename);
    });
    w.on('error', (e) => {
      trigStatus('scstrig', 'error', (e as Error).message);
      stopTriggerScsTrig(true);
    });
    trigScsTrigWatcher = w;
    trigScsTrigDir = dir;
    trigScsTrigLastMs = 0;
    trigStatus('scstrig', 'started', dir);
    return { on: true };
  } catch (e) {
    return { on: false, error: (e as Error).message };
  }
}

// ── SC_Files enrichment watch: the recorder's REAL File# from the landed .dat ──
// The Observer Log Auto-number "reconcile" / "real" File# modes correct-or-fill a
// row's File#/FFID from the file SCS actually SAVES (e.g. C:\SC_Files). This watch
// is STRICTLY READ-ONLY and ENRICHMENT-ONLY: it NEVER triggers a row (triggering
// fires on the trigger source — TempCom/UDP/serial/folder), never writes into the
// folder, and quick-parses ONLY the File#/FFID header into a worker-LOCAL so the
// viewer's open file is never clobbered. Same settle discipline as the folder
// source (wait for two equal stats — the recorder may still be writing), deduped by
// mtime. The parsed path is always <watched dir>/<filename> (never renderer-
// supplied), so it needs no allowlist round-trip. It emits no source-status events
// (it is not an arming source); a runtime watcher error just stops it quietly.
let trigScFilesWatcher: FSWatcher | null = null;
let trigScFilesDir = '';
const trigScFilesTimers = new Map<string, NodeJS.Timeout>();
const trigScFilesSizes = new Map<string, number>();
const trigScFilesEmitted = new Map<string, number>();

function stopTriggerScFiles(): void {
  if (trigScFilesWatcher) { try { trigScFilesWatcher.close(); } catch { /* already dead */ } trigScFilesWatcher = null; }
  for (const t of trigScFilesTimers.values()) clearTimeout(t);
  trigScFilesTimers.clear();
  trigScFilesSizes.clear();
  trigScFilesEmitted.clear();
  trigScFilesDir = '';
}

function trigScFilesConsider(name: string): void {
  if (!trigScFilesDir) return;
  if (!INPUT_EXTS.has(path.extname(name).toLowerCase())) return;
  const t = trigScFilesTimers.get(name);
  if (t) clearTimeout(t);
  trigScFilesTimers.set(name, setTimeout(() => { void trigScFilesSettle(name); }, TRIG_SETTLE_MS));
}

async function trigScFilesSettle(name: string): Promise<void> {
  trigScFilesTimers.delete(name);
  if (!trigScFilesDir) return;
  const full = path.join(trigScFilesDir, name);
  let st;
  try { st = await stat(full); } catch { trigScFilesSizes.delete(name); return; } // vanished mid-write
  if (!st.isFile() || st.size <= 0 || st.size > TRIG_QUICKMETA_MAX) { trigScFilesSizes.delete(name); return; }
  const prev = trigScFilesSizes.get(name);
  if (prev !== st.size) {
    trigScFilesSizes.set(name, st.size); // first sighting / still growing — re-check
    trigScFilesTimers.set(name, setTimeout(() => { void trigScFilesSettle(name); }, TRIG_SETTLE_MS));
    return;
  }
  trigScFilesSizes.delete(name);
  const mtimeMs = Math.floor(st.mtimeMs);
  if (trigScFilesEmitted.get(name) === mtimeMs) return; // duplicate event burst for the same landing
  trigScFilesEmitted.set(name, mtimeMs);
  if (trigScFilesEmitted.size > TRIG_EMITTED_MAX) {
    const oldest = trigScFilesEmitted.keys().next().value;
    if (oldest != null) trigScFilesEmitted.delete(oldest);
  }
  // Quick-parse ONLY the File#/FFID header into a worker-local (never `current`).
  let ffid: number | null = null;
  try {
    const r = await callWorker<{ ok: boolean; meta?: { ffid?: number | null }; error?: string }>({ type: 'quickMeta', path: full });
    if (r.ok && r.meta && typeof r.meta.ffid === 'number' && r.meta.ffid > 0) ffid = r.meta.ffid;
  } catch { /* worker/parse hiccup — the renderer falls back to the file-name digits */ }
  trigSend({ type: 'scfile', name, path: full, ffid, ts: new Date(mtimeMs).toISOString() });
}

function startTriggerScFiles(dir: string): { on: boolean; error?: string } {
  try {
    const w = watch(dir, { persistent: true }, (_evt, filename) => {
      if (typeof filename === 'string' && filename) trigScFilesConsider(filename);
    });
    w.on('error', () => { stopTriggerScFiles(); }); // enrichment degrades quietly
    trigScFilesWatcher = w;
    trigScFilesDir = dir;
    return { on: true };
  } catch (e) {
    return { on: false, error: (e as Error).message };
  }
}

// Configure + (re)start the trigger sources. `null` (or nothing enabled) stops
// everything. Every value is validated HERE — the renderer is untrusted:
// folder must be an existing directory; the UDP port a 1–65535 integer; LAN
// bind only on an explicit boolean true; the SCS log must be an existing file;
// the SCS-trigger TempCom folder must be an existing directory.
ipcMain.handle('seisconv:triggerWatch', async (_e, cfgRaw: unknown) => {
  stopTriggerWatch(true); // restart-from-scratch semantics, no stop-noise
  const off = { on: false as const };
  const result = { ok: true, folder: { ...off } as { on: boolean; error?: string }, udp: { ...off } as { on: boolean; error?: string }, serial: { ...off } as { on: boolean; error?: string }, scslog: { ...off } as { on: boolean; error?: string }, scstrig: { ...off } as { on: boolean; error?: string }, scfiles: { ...off } as { on: boolean; error?: string } };
  if (cfgRaw == null || typeof cfgRaw !== 'object') return result;
  const cfg = cfgRaw as Record<string, unknown>;

  const folder = cfg.folder as Record<string, unknown> | undefined;
  if (folder && typeof folder === 'object' && folder.enabled === true) {
    const dirRaw = folder.dir;
    if (typeof dirRaw !== 'string' || dirRaw.trim() === '' || dirRaw.length > 512) {
      result.folder = { on: false, error: 'Watched folder is not set.' };
    } else {
      const dir = path.resolve(dirRaw.trim());
      let isDir = false;
      try { isDir = (await stat(dir)).isDirectory(); } catch { /* missing */ }
      result.folder = isDir ? startTriggerFolder(dir) : { on: false, error: 'Watched folder does not exist.' };
    }
    if (!result.folder.on) result.ok = false;
  }

  const udp = cfg.udp as Record<string, unknown> | undefined;
  if (udp && typeof udp === 'object' && udp.enabled === true) {
    const port = udp.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      result.udp = { on: false, error: 'UDP port must be 1–65535.' };
    } else {
      result.udp = await startTriggerUdp(port, udp.bindAll === true);
    }
    if (!result.udp.on) result.ok = false;
  }

  const serial = cfg.serial as Record<string, unknown> | undefined;
  if (serial && typeof serial === 'object' && serial.enabled === true) {
    const portName = serial.port;
    const baud = serial.baud;
    if (typeof portName !== 'string' || !TRIG_SERIAL_PORT_RE.test(portName)) {
      result.serial = { on: false, error: 'COM port must look like COM3 (COM + digits).' };
    } else if (typeof baud !== 'number' || !TRIG_SERIAL_BAUDS.has(baud)) {
      result.serial = { on: false, error: 'Baud rate must be one of 9600–230400.' };
    } else {
      result.serial = await startTriggerSerial(portName.toUpperCase(), baud);
    }
    if (!result.serial.on) result.ok = false;
  }

  const scslog = cfg.scslog as Record<string, unknown> | undefined;
  if (scslog && typeof scslog === 'object' && scslog.enabled === true) {
    const pathRaw = scslog.path;
    if (typeof pathRaw !== 'string' || pathRaw.trim() === '' || pathRaw.length > 512) {
      result.scslog = { on: false, error: 'SCS log path is not set.' };
    } else {
      const p = path.resolve(pathRaw.trim());
      let isFile = false;
      try { isFile = (await stat(p)).isFile(); } catch { /* missing */ }
      result.scslog = isFile ? await startTriggerScsLog(p) : { on: false, error: 'SCS log file does not exist.' };
    }
    if (!result.scslog.on) result.ok = false;
  }

  const scstrig = cfg.scstrig as Record<string, unknown> | undefined;
  if (scstrig && typeof scstrig === 'object' && scstrig.enabled === true) {
    const dirRaw = scstrig.dir;
    if (typeof dirRaw !== 'string' || dirRaw.trim() === '' || dirRaw.length > 512) {
      result.scstrig = { on: false, error: 'SCS trigger (TempCom) folder is not set.' };
    } else {
      const dir = path.resolve(dirRaw.trim());
      let isDir = false;
      try { isDir = (await stat(dir)).isDirectory(); } catch { /* missing */ }
      result.scstrig = isDir ? startTriggerScsTrig(dir) : { on: false, error: 'SCS trigger (TempCom) folder does not exist.' };
    }
    if (!result.scstrig.on) result.ok = false;
  }

  // Enrichment watch (File# reconcile/real): read-only watch of the recorder's
  // save folder. NOT a trigger source — it only enriches a row's File#/FFID.
  const scfiles = cfg.scfiles as Record<string, unknown> | undefined;
  if (scfiles && typeof scfiles === 'object' && scfiles.enabled === true) {
    const dirRaw = scfiles.dir;
    if (typeof dirRaw !== 'string' || dirRaw.trim() === '' || dirRaw.length > 512) {
      result.scfiles = { on: false, error: 'SC_Files folder is not set.' };
    } else {
      const dir = path.resolve(dirRaw.trim());
      let isDir = false;
      try { isDir = (await stat(dir)).isDirectory(); } catch { /* missing */ }
      result.scfiles = isDir ? startTriggerScFiles(dir) : { on: false, error: 'SC_Files folder does not exist.' };
    }
    if (!result.scfiles.on) result.ok = false;
  }
  return result;
});

// File picker for the Geometrics SCS survey log (separate from the folder/trace
// pickers). Returns the chosen path or null.
ipcMain.handle('seisconv:triggerPickLogFile', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'SCS survey log', extensions: ['log'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// Folder picker for the watched acquisition folder (separate from the
// converter's output-folder picker so it can't clobber that state).
ipcMain.handle('seisconv:triggerPickFolder', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// Catch-up scan: list the shot files currently in the ACTIVE watched folder
// (name/path/mtime/size, oldest first) so the renderer can offer the
// Add all / Select / Skip modal. Read-only; capped.
ipcMain.handle('seisconv:triggerScanFolder', async () => {
  if (!trigWatchDir) return { ok: false, error: 'Trigger watch is not active.', files: [] };
  try {
    const entries = await readdir(trigWatchDir, { withFileTypes: true });
    const files: { name: string; path: string; mtimeMs: number; size: number }[] = [];
    for (const e of entries) {
      if (!e.isFile() || !INPUT_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      const full = path.join(trigWatchDir, e.name);
      try {
        const st = await stat(full);
        if (st.size > 0) files.push({ name: e.name, path: full, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
      } catch { /* raced away — skip */ }
      if (files.length >= TRIG_SCAN_MAX) break;
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    return { ok: true, files };
  } catch (e) {
    return { ok: false, error: (e as Error).message, files: [] };
  }
});

// Quick FFID / traces / ns metadata for ONE shot file — the enrichment parse.
// Confined to the ACTIVE watched folder (the renderer may only quick-parse
// files the watcher itself announced), seismic extensions only, size-capped.
// The worker parses into a local, so the viewer's open file is never clobbered.
ipcMain.handle('seisconv:triggerQuickMeta', async (_e, p: unknown) => {
  if (typeof p !== 'string' || !p || p.length > 1024) return { ok: false, error: 'bad path' };
  if (!trigWatchDir) return { ok: false, error: 'Trigger watch is not active.' };
  const abs = path.resolve(p);
  const dirOf = path.dirname(abs);
  const sameDir = process.platform === 'win32'
    ? dirOf.toLowerCase() === trigWatchDir.toLowerCase()
    : dirOf === trigWatchDir;
  if (!sameDir) return { ok: false, error: 'Path is outside the watched folder.' };
  if (!INPUT_EXTS.has(path.extname(abs).toLowerCase())) return { ok: false, error: 'Not a seismic shot file.' };
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size <= 0 || st.size > TRIG_QUICKMETA_MAX) return { ok: false, error: 'File missing, empty or too large.' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const r = await callWorker<{ ok: boolean; meta?: Record<string, unknown>; error?: string }>({ type: 'quickMeta', path: abs });
  return r.ok ? { ok: true, meta: r.meta } : { ok: false, error: r.error || 'quick parse failed' };
});

// ════════════════ WiFiSync "FieldHub" ════════════════
// One long-lived owner of the WiFiSync socket engine: the SyncEngine (manifest
// diff + watcher + tombstones), the TCP FileServer (serves manifest/files on
// 47824), and the UDP DiscoveryService (beacons on 47823). It is a SINGLE
// instance for the process, torn down on window close so no socket/watcher can
// outlive the UI. All privileged work (fs, sockets, PowerShell WinRT for the
// Windows Mobile Hotspot) lives here; the renderer reaches it only through the
// `seisconv:field:*` IPC below and receives peer/sync/file/log pushes on
// 'seisconv:fieldEvent' (mirroring the trigger hub's 'seisconv:triggerEvent').
//
// SAFETY: the hotspot / adapter / firewall MUTATIONS are only ever reached from
// an explicit renderer action (start/stop hotspot). Nothing here runs a network
// mutation on its own, and the loopback/QA paths never call field:start.

interface FieldStartCfg {
  folder: string;
  role: FieldRole;
  watchMode: 'on_change' | 'interval';
  syncInterval: number;
  maxKbps: number;
  bindIp: string;         // adapter IP ('' = none → <broadcast>)
  broadcastAddr: string;  // directed broadcast or '<broadcast>'
  manualIp: string;       // peer IP; '' = auto-discover
}

interface FieldPeer { port: number; role: FieldRole }

class FieldHub {
  private engine: SyncEngine | null = null;
  private server: FileServer | null = null;
  private discovery: DiscoveryService | null = null;
  private history: HistoryLog | null = null;
  private instanceId: Buffer = randomBytes(16);
  private readonly peers = new Map<string, FieldPeer>();
  private role: FieldRole = 'both';
  private roleNegotiated = false;
  private folder = '';
  private bindIp = '';
  private broadcastAddr = '<broadcast>';
  private manualMode = false;
  private running = false;

  // Settings / history / log live under the Electron userData dir (the app's own
  // per-user store) — the SeisConv analogue of WiFiSync's exe-adjacent files.
  private settingsPath(): string { return path.join(app.getPath('userData'), 'wifisync_settings.json'); }
  private historyPath(): string { return path.join(app.getPath('userData'), 'wifisync_history.json'); }

  private send(payload: Record<string, unknown>): void {
    win?.webContents.send('seisconv:fieldEvent', payload);
  }
  private log(msg: string): void { this.send({ type: 'log', msg, ts: new Date().toISOString() }); }

  // ── settings ──
  getSettings(): WifiSyncSettings {
    try { return loadSettings(this.settingsPath()); } catch { return { ...DEFAULT_SETTINGS }; }
  }
  setSettings(s: Partial<WifiSyncSettings>): { ok: boolean; error?: string } {
    try {
      const merged: WifiSyncSettings = { ...this.getSettings(), ...s };
      saveSettings(this.settingsPath(), merged);
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  // ── history ──
  private ensureHistory(): HistoryLog {
    if (!this.history) this.history = new HistoryLog(this.historyPath());
    return this.history;
  }
  getHistory(): unknown[] { return this.ensureHistory().list(); }
  clearHistory(): void { this.ensureHistory().clear(); }

  status(): Record<string, unknown> {
    return {
      running: this.running,
      mode: this.role,
      serverOn: !!this.server,
      discoveryOn: !!this.discovery,
      manual: this.manualMode,
      folder: this.folder,
      peers: [...this.peers.entries()].map(([ip, p]) => ({ ip, port: p.port, role: p.role })),
    };
  }

  private makeDiscovery(): DiscoveryService {
    return new DiscoveryService({
      instanceId: this.instanceId,
      tcpPort: TCP_FILE_PORT,
      bindIp: this.bindIp,
      broadcastAddr: this.broadcastAddr,
      role: this.role,
      onLog: (m) => this.log(m),
      onPeerFound: (ip, port, role) => {
        this.peers.set(ip, { port, role });
        this.engine?.addPeer(ip, port);
        this.send({ type: 'peer', action: 'found', ip, port, role });
        // Auto-negotiation: adopt the complement of a definite-role peer once per
        // session (peer master → we slave, peer slave → we master). A 'both' peer
        // triggers none. The renderer mirrors the radio lock.
        if (!this.roleNegotiated && this.role === 'both') {
          const comp = complementRole(role);
          if (comp) {
            this.roleNegotiated = true;
            this.setRole(comp);
            this.send({ type: 'negotiated', role: comp, peerRole: role });
          }
        }
      },
      onPeerLost: (ip) => {
        this.peers.delete(ip);
        this.engine?.removePeer(ip);
        this.send({ type: 'peer', action: 'lost', ip });
        if (this.peers.size === 0) { this.roleNegotiated = false; this.send({ type: 'renegotiable' }); }
      },
    });
  }

  async start(cfg: FieldStartCfg): Promise<{ ok: boolean; error?: string; serverOn: boolean; discoveryOn: boolean }> {
    await this.stop();
    // Validate folder.
    let dir = '';
    try {
      dir = path.resolve(cfg.folder);
      if (!(await stat(dir)).isDirectory()) return { ok: false, error: 'Shared folder does not exist.', serverOn: false, discoveryOn: false };
    } catch {
      return { ok: false, error: 'Shared folder does not exist.', serverOn: false, discoveryOn: false };
    }
    if (!cfg.bindIp && !cfg.manualIp) {
      return { ok: false, error: 'Select a network adapter or enter a peer IP.', serverOn: false, discoveryOn: false };
    }

    this.folder = dir;
    this.role = cfg.role;
    this.roleNegotiated = false;
    this.bindIp = cfg.bindIp || '';
    this.broadcastAddr = cfg.broadcastAddr || '<broadcast>';
    this.manualMode = !!cfg.manualIp;
    this.instanceId = randomBytes(16);
    this.peers.clear();
    const maxKbps = Math.max(0, cfg.maxKbps || 0);

    // Engine (receive/diff path) + its own rate limiter.
    this.engine = new SyncEngine({
      folder: dir,
      mode: cfg.role,
      bindIp: this.bindIp,
      watchMode: cfg.watchMode,
      syncInterval: cfg.syncInterval,
      maxKbps,
      onLog: (m) => this.log(m),
      onSyncResult: (ok, detail) => this.send({ type: 'sync', ok, detail: detail ?? '' }),
      onFileEvent: (kind, relPath, peerIp, size) => {
        try {
          this.ensureHistory().append({ timestamp: Date.now() / 1000, filename: relPath, action: kind, peer_ip: peerIp, size_bytes: size });
        } catch { /* history is best-effort */ }
        this.send({ type: 'file', kind, relPath, peerIp, size });
      },
    });

    // File server (send path) with an independent limiter (spec §6).
    this.server = new FileServer({
      folder: dir,
      getManifest: () => this.engine!.getMergedManifest(),
      port: TCP_FILE_PORT,
      limiter: new RateLimiter(maxKbps),
      onLog: (m) => this.log(m),
    });
    try {
      await this.server.start();
    } catch (e) {
      await this.stop();
      return { ok: false, error: `File server could not bind ${TCP_FILE_PORT}: ${(e as Error).message}`, serverOn: false, discoveryOn: false };
    }

    this.engine.start();
    this.running = true;

    let discoveryOn = false;
    if (cfg.manualIp) {
      // Manual peer: test TCP reachability, then add it (no discovery).
      const reachable = await this.testPeer(cfg.manualIp, TCP_FILE_PORT);
      if (reachable) {
        this.peers.set(cfg.manualIp, { port: TCP_FILE_PORT, role: 'both' });
        this.engine.addPeer(cfg.manualIp, TCP_FILE_PORT);
        this.send({ type: 'peer', action: 'found', ip: cfg.manualIp, port: TCP_FILE_PORT, role: 'both' });
        this.log(`Manual peer ${cfg.manualIp}:${TCP_FILE_PORT} reachable — added.`);
      } else {
        this.log(`Manual peer ${cfg.manualIp}:${TCP_FILE_PORT} not reachable yet — will retry when you Sync.`);
      }
    } else {
      this.discovery = this.makeDiscovery();
      this.discovery.start();
      discoveryOn = true;
      this.log(`Discovery broadcasting on UDP ${47823} as "${this.role}".`);
    }

    this.send({ type: 'status', ...this.status() });
    return { ok: true, serverOn: true, discoveryOn };
  }

  async stop(): Promise<void> {
    if (this.discovery) { try { this.discovery.stop(); } catch { /* ignore */ } this.discovery = null; }
    if (this.engine) { try { await this.engine.stop(); } catch { /* ignore */ } this.engine = null; }
    if (this.server) { try { await this.server.stop(); } catch { /* ignore */ } this.server = null; }
    this.peers.clear();
    this.roleNegotiated = false;
    const was = this.running;
    this.running = false;
    if (was) { this.log('WiFiSync stopped.'); this.send({ type: 'status', ...this.status() }); }
  }

  /** Live role change (auto-negotiation or user radio). Restarts discovery so the
   *  beacon carries the new role; engine mode flips immediately. */
  setRole(role: FieldRole): void {
    this.role = role;
    this.engine?.setMode(role);
    if (this.discovery) {
      try { this.discovery.stop(); } catch { /* ignore */ }
      this.discovery = this.makeDiscovery();
      this.discovery.start();
    }
    this.log(`Role set to "${role}".`);
    this.send({ type: 'status', ...this.status() });
  }

  async syncNow(): Promise<{ ok: boolean; detail: string }> {
    if (!this.engine) return { ok: false, detail: 'WiFiSync is not running.' };
    // A manual peer that was offline at start can be retried here.
    if (this.manualMode && this.engine.peerCount() === 0) {
      for (const [ip, p] of this.peers) {
        if (await this.testPeer(ip, p.port)) this.engine.addPeer(ip, p.port);
      }
    }
    return this.engine.syncNow();
  }

  async connectPeer(ip: string, port = TCP_FILE_PORT): Promise<{ ok: boolean; error?: string }> {
    if (!this.engine) return { ok: false, error: 'WiFiSync is not running.' };
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { ok: false, error: 'Enter a valid IPv4 address.' };
    const ok = await this.testPeer(ip, port);
    if (!ok) return { ok: false, error: `No WiFiSync peer answering at ${ip}:${port}.` };
    this.peers.set(ip, { port, role: 'both' });
    this.engine.addPeer(ip, port);
    this.send({ type: 'peer', action: 'found', ip, port, role: 'both' });
    return { ok: true };
  }

  private testPeer(ip: string, port: number, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.createConnection({ host: ip, port });
      const done = (hit: boolean): void => { try { sock.destroy(); } catch { /* ignore */ } resolve(hit); };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.on('connect', () => done(true));
      sock.on('error', () => done(false));
    });
  }
}

const fieldHub = new FieldHub();

// ── WiFiSync IPC surface ──
ipcMain.handle('seisconv:field:status', () => fieldHub.status());
ipcMain.handle('seisconv:field:settingsGet', () => fieldHub.getSettings());
ipcMain.handle('seisconv:field:settingsSet', (_e, s: Partial<WifiSyncSettings>) => fieldHub.setSettings(s ?? {}));
ipcMain.handle('seisconv:field:historyGet', () => fieldHub.getHistory());
ipcMain.handle('seisconv:field:historyClear', () => { fieldHub.clearHistory(); return { ok: true }; });

ipcMain.handle('seisconv:field:pickFolder', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// Adapter list for the sync bind dropdown (ipconfig-based; §8j). Read-only.
ipcMain.handle('seisconv:field:listAdapters', async () => {
  try { return { ok: true, adapters: await fieldWin.listNetworkAdapters() }; }
  catch (e) { return { ok: false, error: (e as Error).message, adapters: [] }; }
});

ipcMain.handle('seisconv:field:start', async (_e, cfgRaw: unknown) => {
  const c = (cfgRaw ?? {}) as Record<string, unknown>;
  const role = (['both', 'master', 'slave'].includes(String(c.role)) ? c.role : 'both') as FieldRole;
  const watchMode = (String(c.watchMode) === 'interval' ? 'interval' : 'on_change') as 'on_change' | 'interval';
  const cfg: FieldStartCfg = {
    folder: String(c.folder ?? ''),
    role,
    watchMode,
    syncInterval: Math.max(1, Number(c.syncInterval) || 5),
    maxKbps: Math.max(0, Number(c.maxKbps) || 0),
    bindIp: String(c.bindIp ?? ''),
    broadcastAddr: String(c.broadcastAddr ?? '<broadcast>'),
    manualIp: String(c.manualIp ?? '').trim(),
  };
  return fieldHub.start(cfg);
});
ipcMain.handle('seisconv:field:stop', async () => { await fieldHub.stop(); return { ok: true }; });
ipcMain.handle('seisconv:field:setRole', (_e, role: unknown) => {
  const r = (['both', 'master', 'slave'].includes(String(role)) ? role : 'both') as FieldRole;
  fieldHub.setRole(r);
  return { ok: true, role: r };
});
ipcMain.handle('seisconv:field:syncNow', () => fieldHub.syncNow());
ipcMain.handle('seisconv:field:connectPeer', (_e, args: { ip?: string; port?: number }) =>
  fieldHub.connectPeer(String(args?.ip ?? ''), Number(args?.port) || TCP_FILE_PORT));

// Subnet scan (§8l) — read-only TCP probe of selfIp's /24 on 47824. Requires a
// valid IPv4 self address (the selected adapter's IP or the hotspot host IP).
ipcMain.handle('seisconv:field:scanPeers', async (_e, selfIp: unknown) => {
  const ip = String(selfIp ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { ok: false, error: 'A valid adapter IP is required to scan its subnet.', peers: [] as string[] };
  try { return { ok: true, peers: await fieldWin.scanForWifiSync(ip) }; }
  catch (e) { return { ok: false, error: (e as Error).message, peers: [] as string[] }; }
});
// ── Hotspot / host-IP (Windows Mobile Hotspot via WinRT/netsh, §8) ──
// hotspotStatus + hostIp are READ-ONLY; start/stop are MUTATIONS gated behind an
// explicit user click in the WiFiSync tab.
ipcMain.handle('seisconv:field:hostIp', () => fieldWin.getHostIp());
ipcMain.handle('seisconv:field:hotspotStatus', () => fieldWin.hotspotStatus());
ipcMain.handle('seisconv:field:hotspotStart', (_e, args: { ssid?: string; pass?: string; adapter?: string }) =>
  fieldWin.hotspotStart(String(args?.ssid ?? ''), String(args?.pass ?? ''), args?.adapter ? String(args.adapter) : undefined));
ipcMain.handle('seisconv:field:hotspotStop', () => fieldWin.hotspotStop());
ipcMain.handle('seisconv:field:openHotspotSettings', async () => {
  try { await shell.openExternal('ms-settings:network-mobilehotspot'); return { ok: true }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
});

// ── Field-workflow helpers (gui.py parity) ──
// listWifiAdapters is READ-ONLY (populates the hotspot adapter dropdown). scan is
// READ-ONLY (subnet TCP probe on 47824). openFirewall / resetAdapter / fixHyperV
// are MUTATIONS (self-elevating, UAC-prompting) — each is reached only from an
// explicit user click in the WiFiSync tab, never from tests or the loopback.
ipcMain.handle('seisconv:field:hotspotAdapters', async () => {
  try { return { ok: true, adapters: await fieldWin.listWifiAdapters() }; }
  catch (e) { return { ok: false, error: (e as Error).message, adapters: [] }; }
});
ipcMain.handle('seisconv:field:scan', async (_e, args: { selfIp?: string }) => {
  const selfIp = String(args?.selfIp ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(selfIp)) return { ok: false, error: 'Select a network adapter first.', hosts: [] };
  try { return { ok: true, hosts: await fieldWin.scanForWifiSync(selfIp, TCP_FILE_PORT) }; }
  catch (e) { return { ok: false, error: (e as Error).message, hosts: [] }; }
});
ipcMain.handle('seisconv:field:openFirewall', async () => {
  try { await fieldWin.openFirewallPorts(); return { ok: true }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
});
ipcMain.handle('seisconv:field:resetAdapter', async (_e, args: { adapter?: string }) => {
  const name = String(args?.adapter ?? '').trim();
  if (!name) return { ok: false, error: 'Select a WiFi adapter first.' };
  try { const r = await fieldWin.resetAdapter(name); return { ok: r.ok, error: r.ok ? undefined : (r.output || 'Adapter reset failed.') }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
});
ipcMain.handle('seisconv:field:fixHyperV', async () => {
  try {
    const sw = await fieldWin.checkHyperVConflict();
    if (!sw) return { ok: false, error: 'No Hyper-V WiFi switch conflict detected.' };
    const r = await fieldWin.removeHyperVWifiSwitch(sw);
    return { ok: r.ok, error: r.ok ? undefined : (r.output || `Could not remove switch "${sw}".`) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
});

// ── Single-instance lock ──
// SeisConv holds the parsed file + worker in ONE process; launching it again must
// surface the running window, not spin up a second copy. The first instance wins
// the lock; a later launch fails requestSingleInstanceLock(), so it fires
// 'second-instance' in the FIRST (already-running) process and then quits itself
// immediately — releasing nothing the first instance owns. Must be evaluated
// BEFORE we create the window so the loser never reaches app.whenReady().
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // We're the second instance: the running one was just signalled to focus. Exit
  // now (no window, no worker) so only a single SeisConv process ever exists.
  app.quit();
} else {
  // The 'second-instance' event arrives whenever ANOTHER launch is attempted while
  // we hold the lock. Bring our existing window to the foreground: un-minimize if
  // needed, then show + focus. Guard for the window being gone/destroyed (e.g. mid
  // teardown) so a stray second launch can never throw here. We intentionally don't
  // act on the second instance's argv/cwd — SeisConv opens files via its in-app
  // dialog, not a CLI path, so there's no file-open path to route here.
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
