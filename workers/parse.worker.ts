// SeisConv - stateful parse/convert/render worker.
//
// Long-lived: it parses a file ONCE, holds the ParsedFile in worker memory, and
// answers many requests (summary, a single trace, a decimated section, convert)
// without re-reading or re-parsing. Heavy work stays off the UI thread; sample
// buffers are returned as transferables (zero structured-clone copy).
//
// Protocol: every request has a numeric `id`; the reply echoes that `id`.

import { parentPort } from 'node:worker_threads';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { findEpsgByParams } from '../core/sps/epsgdb';
import { applyAGC, assistFirstBreaks, averageSpectrum, buildPositioningExport, buildPositioningPrj, buildSPSRasters, buildSPSShapefiles, buildRenumberMaps, buildSPS, checkGeometry, compareSPS, computeSemblance, CREATE_DEFAULTS, crsFromSpec, decodeSegyTrace, detect, detectPositioningFormat, detectSPSType, EPSG_DB, fkSpectrum, generateProjHeaders, generatePreplotSPS, generateSPS, getWriter, groupByLine, hRecCode, isIX1SegdTape, loadGeometry, lonLatToProj, MAX_SAMPLE_TRACES, MAX_SAMPLES_PER_TRACE, MAX_TRACES, mergeSPSData, nextPow2, normFactorPercentile, parseAny, parsePositioning, parseSEGY, parseSegyMeta, parseSPSText, projToLatLon, PROJ_HEADER_CODES, r16u, renumberSPSText, reprojectSPS, resampleLinear, runSPSQC, scanTraceHealth, EVIDENCE_STRIDE, writeEvidence, spectrogram, spsHeaderDesc, writeTapeRecord, type AGCType, type BinGrid, type CRS, type CreateParams, type CRSSpec, type DetectorId, type FBPolarity, type FBSeed, type GeomLoadResult, type HealthThresholds, type ParsedFile, type PreplotLine, type PreplotStation, type QCParams, type RenumberSpec, type SegyMeta, type Sensitivity, type SPSData, type SPSDeltaResult, type SPSHeader, type SPSPoint, type SPSProjection, type SurveyLine, type Trace, type TraceGeom } from '../core';

if (!parentPort) throw new Error('parse.worker must run as a worker thread');
const port = parentPort;

// -- Long-op progress channel (worker → main → renderer) ----------------------
// A side-band message (NO `id`, so main forwards it to the renderer instead of
// resolving a pending request) the renderer routes to the global progress bar.
// The worker has no clock, so callers THROTTLE by a cheap counter/byte-percent
// (never by time). Emitted DURING a synchronous handler: the message is queued on
// the port and delivered to main by libuv while this thread is still busy, so the
// renderer's bar advances live even though the worker is blocked in the loop.
function emitProgress(op: string, done: number, total: number, label: string): void {
  port.postMessage({ type: 'progress', op, done, total, label });
}

let current: ParsedFile | null = null;
// A very large SEG-Y opened by INDEXING trace offsets and reading traces on
// demand (bounded memory, no freeze) instead of loading the whole file. A loaded
// file is EITHER `current` (in-memory) XOR `currentStream` (streamed): opening or
// clearing one nulls the other and closes the fd. See the streaming block below.
let currentStream: StreamedFile | null = null;
// Trace Workbench extract cache: the offset index of the LAST large (streamed-size)
// non-open file an extractTrace touched, keyed by path + mtime. Repeatedly picking
// different trace indices from the same file otherwise rebuilds the whole O(file)
// offset index every call (a full sequential scan of a multi-GB file). Only the
// index is cached - the fd is reopened per pick (O(1)) so there's no fd to leak.
interface ExtractIndex {
  path: string;
  mtimeMs: number;
  meta: SegyMeta;
  offsets: Float64Array;
  nsArr: Int32Array | null;
  recMetas: SegyMeta[] | null;
  recOf: Int32Array | null;
  traceCount: number;
}
let extractIndexCache: ExtractIndex | null = null;
let currentSPS: SPSData | null = null;
let currentSPSFiles: { name: string; text: string; type: 'S' | 'R' | 'X' | 'mixed' }[] = [];
// A P6/11 bin grid loaded alongside (or instead of) the point survey. Held
// separately from currentSPS since it is a grid, not a list of S/R points.
let currentBinGrid: BinGrid | null = null;
// Identity (name + raw text) of the bin grid currently held in currentBinGrid, so a
// reload of the SAME .p611 skips re-reading + re-parsing the multi-MB grid. Bin grids
// are never added to currentSPSFiles, so they bypass that file dedup otherwise.
let currentBinGridSig: string | null = null;

// -- Streaming / indexed SEG-Y reader (very large files) --
//
// A file at or below STREAM_THRESHOLD takes the simple in-memory path: it is read
// WHOLE into worker memory (readFileSync + a transient `new Uint8Array(...)` copy)
// and parsed by parseAny. A multi-GB file can't go that way - it would block this
// single-threaded worker for many seconds (or OOM-kill the thread), and because
// the worker handles one message at a time, every later Clear/Open then queues
// behind it: the whole app appears frozen. So above the threshold a SEG-Y file is
// opened by INDEXING its per-trace byte offsets (a cheap, header-only pass - NO
// sample data read) and serving traces ON DEMAND via positioned reads. statSync is
// O(1) and never touches the bytes, so the size decision is instant, BEFORE any read.
//
// STREAM_THRESHOLD keeps the in-memory double-allocation comfortable while still
// covering every everyday file in memory; above it (and ≤ MAX_STREAM_BYTES) a file
// that sanity-checks as SEG-Y is streamed, otherwise rejected (non-SEG-Y giants
// aren't streamable here). MAX_STREAM_TRACES bounds the offset index itself.
const STREAM_THRESHOLD = 256 * 1024 * 1024; // 256 MiB - in-memory at/below this
const MAX_STREAM_BYTES = 30 * 1024 * 1024 * 1024; // 30 GiB - refuse to index above this
const MAX_STREAM_TRACES = 8_000_000; // 8M × 8B offsets = 64 MB (+ optional 32 MB nsArr)
// Largest file still loaded WHOLE into memory when it can't be streamed (i.e. it
// isn't SEG-Y - a big SEG-D/SEG-2/SU/tape-image). Preserves the prior behaviour
// (the old MAX_OPEN_FILE_BYTES freeze-fix cap) so a mid-size non-SEG-Y that opened
// before still opens; only an un-streamable file ABOVE this is refused. SEG-Y above
// STREAM_THRESHOLD takes the streamed path regardless of this cap.
const IN_MEMORY_MAX = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB
// Total decoded-sample budget for an in-memory SEG-Y. The parser caps SAMPLE
// decoding at MAX_SAMPLE_TRACES (2000) to bound arbitrary files, but a file on the
// in-memory path is already size-bounded, so we decode EVERY trace's samples (else
// panning/zooming past trace ~2000 renders blank and convert drops the deep
// traces). This budget still bounds the rare case of a few very long traces / a big
// SEG-Y that failed stream-sanity and fell back here. ~1.6 GB of Float32 samples.
const IN_MEMORY_SAMPLE_BUDGET = 400_000_000;
// SEG-Y data sample format codes (binhdr offset 24) this build recognises - the
// stride/decode width key set. Used as a sanity gate before streaming: a non-SEG-Y
// giant (huge SEG-D / blob) won't carry a plausible code here. Mirrors SEGY_BPS keys.
const SEGY_FORMAT_CODES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16]);

/**
 * A very large SEG-Y opened by index. Holds the file descriptor, the resolved
 * header `meta`, and a per-trace byte-offset table (`offsets[i]` = abs offset of
 * trace i's 240-byte header). `nsArr` carries per-trace sample counts ONLY when
 * they vary; when every trace shares `meta.defaultNs` it is null (serving uses
 * defaultNs). `repNs` is a representative samples/trace for the summary. Sample
 * data is never held - a trace is decoded on demand by reading exactly its record.
 */
interface StreamedFile {
  fd: number;
  path: string;
  name: string;
  meta: SegyMeta;
  offsets: Float64Array;
  nsArr: Int32Array | null;
  traceCount: number;
  repNs: number;
  // Per-record decode meta for a HETEROGENEOUS tape image whose embedded SEG-Y
  // records differ in byte order / sample format / stride. `recOf[i]` is trace i's
  // record index into `recMetas`. Both null for a plain SEG-Y or a HOMOGENEOUS tape
  // (every record decode-identical), where the single `meta` serves every trace -
  // keeping that common path, and SeisConv's own combines, byte-identical.
  recMetas: SegyMeta[] | null;
  recOf: Int32Array | null;
}

/** Read up to `length` bytes at absolute file `position` into a fresh zero-filled
 *  buffer, looping over partial reads. Returns the buffer trimmed to bytes read
 *  (so a short tail read shrinks rather than leaving stale zeros at the end). */
function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    let n: number;
    try { n = readSync(fd, buf, total, length - total, position + total); }
    catch { break; }
    if (n <= 0) break;
    total += n;
  }
  return total === length ? buf : buf.subarray(0, total);
}

/** Decode meta for streamed trace `i` - the per-record meta for a heterogeneous
 *  tape, else the single shared `meta`. */
function traceMeta(s: StreamedFile, i: number): SegyMeta {
  return s.recMetas && s.recOf ? s.recMetas[s.recOf[i]] : s.meta;
}

/** Per-trace sample count for the streamed file (nsArr when ns varies, else the
 *  trace's record default). Drives both the on-demand record size and the summary. */
function streamNs(s: StreamedFile, i: number): number {
  return s.nsArr ? s.nsArr[i] : traceMeta(s, i).defaultNs;
}

/**
 * Decode ONE streamed trace: read exactly its record (240 + extra headers +
 * ns*bps bytes) at `off` and run decodeSegyTrace. The window is sized to the FULL
 * record (Phase-1 caveat: decodeSegyTrace short-returns null on a shorter window),
 * so a valid trace always decodes. Returns null on a short/truncated tail.
 */
function readStreamedTrace(fd: number, meta: SegyMeta, off: number, ns: number, withSamples: boolean): Trace | null {
  const stride = 240 + meta.addHdrBytes + ns * meta.bps;
  const buf = readAt(fd, off, stride);
  if (buf.length < stride) return null;
  const res = decodeSegyTrace(buf, 0, meta, withSamples);
  return res ? res.trace : null;
}

/** Does the 240-byte trace header at local offset `p` in `buf` look like a real
 *  SEG-Y trace (not a record boundary / junk)? Requires ns in range and the full
 *  record to fit in the file, plus - the key discriminator at a concatenated-record
 *  boundary - ONE of: the per-trace ns equals the binary-header samples/trace (a
 *  fixed-length file's authoritative count), or the per-trace sample-interval field
 *  is the file's interval (or 0/unset). A textual-header boundary's bytes at
 *  +114/+116 essentially never satisfy either, so the walk stops there and the
 *  embedded record header is detected + skipped instead. */
function looksLikeTrace(buf: Uint8Array, p: number, absOff: number, fileSize: number, meta: SegyMeta): { ok: boolean; ns: number } {
  const ns = r16u(buf, p + 114, meta.le) || meta.defaultNs;
  if (ns <= 0 || ns > MAX_SAMPLES_PER_TRACE) return { ok: false, ns };
  if (absOff + 240 + meta.addHdrBytes + ns * meta.bps > fileSize) return { ok: false, ns };
  const si = r16u(buf, p + 116, meta.le);
  const anchored = (meta.defaultNs > 0 && ns === meta.defaultNs) || meta.sampleInt <= 0 || si === meta.sampleInt || si === 0;
  if (!anchored) return { ok: false, ns };
  return { ok: true, ns };
}

/**
 * Build the per-trace offset index for a streamed SEG-Y over an open fd, by a
 * single BOUNDED, sequential pass (an 8 MiB scan window reused in place - peak
 * memory stays ~tens of MB regardless of file size; the file's bytes are never
 * held). Robust to BOTH a plain SEG-Y and a CONCATENATED / tape-image SEG-Y (many
 * complete SEG-Y records joined end to end, each `[header][traces]` - exactly the
 * shape of the 1.78 GB whole-line .TpImage): at a record boundary the trace check
 * fails, the embedded SEG-Y header is detected via parseSegyMeta and skipped, and
 * the walk resumes. `nsArr` is kept only when ns actually varies. The trace count
 * is bounded by MAX_STREAM_TRACES. A sequential scan is also HDD-friendly (no
 * seek-per-trace), unlike a header-only random-read walk.
 */
function buildStreamIndex(fd: number, fileSize: number, meta: SegyMeta): {
  offsets: Float64Array; nsArr: Int32Array | null; traceCount: number; repNs: number; hitCap: boolean; records: number;
} {
  const bps = meta.bps;
  const base = 240 + meta.addHdrBytes; // bytes before the samples of each trace
  const CHUNK = 8 * 1024 * 1024;
  const win = Buffer.allocUnsafe(CHUNK); // reused scan window (only [0,winLen) is valid)
  let winStart = -1;
  let winLen = 0;
  // Ensure [pos, pos+need) is resident in `win`; refill (sequentially) if not.
  const ensure = (pos: number, need: number): boolean => {
    if (winStart >= 0 && pos >= winStart && pos + need <= winStart + winLen) return true;
    if (pos + need > fileSize) return false;
    const want = Math.min(CHUNK, fileSize - pos);
    if (want < need) return false;
    let t = 0;
    while (t < want) {
      let n: number;
      try { n = readSync(fd, win, t, want - t, pos + t); }
      catch { break; }
      if (n <= 0) break;
      t += n;
    }
    winStart = pos; winLen = t;
    return pos + need <= winStart + winLen;
  };

  const offList: number[] = [];
  const nsList: number[] = [];
  let varies = false;
  let records = 1; // the file itself is the first record
  let g = meta.dataStart;
  // Throttle progress to ≤100 emits/file: fire only when the integer byte-percent
  // through the file advances (no clock in the worker, so percent - not time).
  let lastPct = -1;
  while (g + 240 <= fileSize && offList.length < MAX_STREAM_TRACES) {
    const pct = fileSize > 0 ? Math.floor((g / fileSize) * 100) : 0;
    if (pct !== lastPct) { lastPct = pct; emitProgress('open', g, fileSize, `Indexing traces - ${offList.length.toLocaleString()} found`); }
    if (!ensure(g, 240)) break;
    const probe = looksLikeTrace(win, g - winStart, g, fileSize, meta);
    if (probe.ok) {
      if (nsList.length && probe.ns !== nsList[0]) varies = true;
      offList.push(g);
      nsList.push(probe.ns);
      g += base + probe.ns * bps;
      continue;
    }
    // Not a trace → maybe a fresh embedded SEG-Y record header (concatenation).
    // Resolve it and skip to its first trace, verifying that lands on a real trace.
    const head = readAt(fd, g, Math.min(64 * 1024, fileSize - g));
    const m2 = parseSegyMeta(head);
    const plausible = SEGY_FORMAT_CODES.has(m2.format) && m2.defaultNs > 0 && m2.defaultNs <= MAX_SAMPLES_PER_TRACE && m2.dataStart >= 3600 && g + m2.dataStart + 240 <= fileSize;
    if (plausible) {
      const g2 = g + m2.dataStart;
      const vb = readAt(fd, g2, 240);
      // Verify against the EMBEDDED record's own meta (its ns/interval may differ).
      if (vb.length >= 240 && looksLikeTrace(vb, 0, g2, fileSize, m2).ok) {
        g = g2; winStart = -1; records++; continue;
      }
    }
    break; // trailing data / unrecognized → stop cleanly
  }

  const offsets = Float64Array.from(offList);
  const repNs = nsList.length ? nsList[0] : meta.defaultNs;
  let nsArr: Int32Array | null = null;
  if (varies) nsArr = Int32Array.from(nsList);
  else if (nsList.length && nsList[0] !== meta.defaultNs) { nsArr = new Int32Array(nsList.length); nsArr.fill(nsList[0]); }
  return { offsets, nsArr, traceCount: offsets.length, repNs, hitCap: offsets.length >= MAX_STREAM_TRACES, records };
}

/** Does the first 64 KiB at offset 0 look like an ANSI/IBM TAPE IMAGE rather than a
 *  bare SEG-Y? A tape image frames each block with a 4-byte big-endian length prefix
 *  and interleaves 80-byte VOL1/HDR/EOF label blocks + tape marks around the embedded
 *  SEG-Y data blocks (what writeTapeImageMulti emits, and an Inova/ION .TpImage
 *  carries). Detect EITHER a leading 80-byte label block (ASCII or EBCDIC VOL1/HDR1…)
 *  OR a no-label tape: a length-prefixed data block whose payload parses as a SEG-Y
 *  header. A real bare SEG-Y's first 4 bytes are textual-header glyphs whose BE value
 *  far exceeds the file size, so this never misfires on one. */
function looksLikeTape(head: Buffer, fileSize: number): boolean {
  if (head.length < 8) return false;
  const blen = head.readUInt32BE(0);
  if (blen === 80) {
    const tag = String.fromCharCode(head[4], head[5], head[6], head[7]);
    if (['VOL1', 'HDR1', 'HDR2', 'EOF1', 'EOF2', 'EOV1'].includes(tag)) return true;
    if (head[4] === 0xe5 && head[5] === 0xd6 && head[6] === 0xd3) return true; // EBCDIC VOL1
  }
  // No-label tape ('none' mode): the first block IS a SEG-Y data block.
  if (blen > 3600 && blen <= fileSize - 4) {
    const m = parseSegyMeta(head.subarray(4));
    if (SEGY_FORMAT_CODES.has(m.format) && m.bps > 0 && m.defaultNs > 0 && m.defaultNs <= MAX_SAMPLES_PER_TRACE && m.dataStart >= 3600) return true;
  }
  return false;
}

/**
 * Build the per-trace offset index for a streamed TAPE IMAGE by walking its block
 * framing (mirrors parseTpimage in core/formats/tapeimage.ts, but over an open fd
 * with bounded memory - an 8 MiB scan window reused in place, the tape's bytes are
 * never held). For each block: read the 4-byte BE length, skip tape marks (length 0)
 * and 80-byte VOL1/HDR/EOF label blocks, and for an embedded SEG-Y data block resolve
 * its header (parseSegyMeta) then index every trace inside [blockStart+dataStart,
 * blockStart+blockLen) via the SAME looksLikeTrace probe + per-trace stride as
 * buildStreamIndex. The first embedded SEG-Y's `meta` becomes the representative for
 * decoding (combine output + typical tapes are homogeneous - same format/byte order/
 * stride - so a single meta serves every record; per-trace sample counts that vary
 * are still captured in nsArr). Returns null when no embedded SEG-Y trace is found.
 */
function buildTapeStreamIndex(fd: number, fileSize: number): {
  meta: SegyMeta; offsets: Float64Array; nsArr: Int32Array | null; traceCount: number; repNs: number; hitCap: boolean; records: number;
  recMetas: SegyMeta[] | null; recOf: Int32Array | null;
} | null {
  const CHUNK = 8 * 1024 * 1024;
  const win = Buffer.allocUnsafe(CHUNK); // reused scan window (only [0,winLen) is valid)
  let winStart = -1;
  let winLen = 0;
  // Ensure [pos, pos+need) is resident in `win`; refill (sequentially) if not. Access
  // is monotonically forward across the whole walk, so the window only ever advances.
  const ensure = (pos: number, need: number): boolean => {
    if (winStart >= 0 && pos >= winStart && pos + need <= winStart + winLen) return true;
    if (pos + need > fileSize) return false;
    const want = Math.min(CHUNK, fileSize - pos);
    if (want < need) return false;
    let t = 0;
    while (t < want) {
      let n: number;
      try { n = readSync(fd, win, t, want - t, pos + t); }
      catch { break; }
      if (n <= 0) break;
      t += n;
    }
    winStart = pos; winLen = t;
    return pos + need <= winStart + winLen;
  };

  const offList: number[] = [];
  const nsList: number[] = [];
  // Per-record decode meta + per-trace record index, so a heterogeneous tape (records
  // differing in byte order / sample format) decodes each trace with ITS record's meta
  // rather than the first record's. Collapsed to null below when every record matches.
  const recMetas: SegyMeta[] = [];
  const recOfList: number[] = [];
  let varies = false;
  let meta0: SegyMeta | null = null;
  let records = 0;
  let pos = 0;
  // Throttle to ≤100 emits/file: fire only when the integer byte-percent advances.
  let lastPct = -1;
  while (pos + 4 <= fileSize && offList.length < MAX_STREAM_TRACES) {
    const pct = fileSize > 0 ? Math.floor((pos / fileSize) * 100) : 0;
    if (pct !== lastPct) { lastPct = pct; emitProgress('open', pos, fileSize, `Indexing tape - ${offList.length.toLocaleString()} traces, ${records} record${records === 1 ? '' : 's'}`); }
    if (!ensure(pos, 4)) break;
    const blen = win.readUInt32BE(pos - winStart);
    if (blen === 0) { pos += 4; continue; }              // tape mark
    if (blen > fileSize || pos + 4 + blen > fileSize) break; // truncated / junk → stop
    const dataStart = pos + 4;
    // ANSI/IBM label block (80 bytes, known tag) → skip the whole framing block.
    if (blen === 80 && ensure(dataStart, 80)) {
      const o = dataStart - winStart;
      const tag = String.fromCharCode(win[o], win[o + 1], win[o + 2], win[o + 3]);
      const isLabel = ['VOL1', 'HDR1', 'HDR2', 'EOF1', 'EOF2', 'EOV1'].includes(tag)
        || (win[o] === 0xe5 && win[o + 1] === 0xd6 && win[o + 2] === 0xd3); // EBCDIC VOL1
      if (isLabel) { pos = dataStart + 80; continue; }
    }
    // Data block → an embedded seismic file. Resolve its SEG-Y header once (a one-off
    // positioned read, not via the window) and, when plausible, index its traces.
    const head = readAt(fd, dataStart, Math.min(64 * 1024, blen));
    const m = parseSegyMeta(head);
    const plausible = SEGY_FORMAT_CODES.has(m.format) && m.bps > 0
      && m.defaultNs > 0 && m.defaultNs <= MAX_SAMPLES_PER_TRACE
      && m.dataStart >= 3600 && m.dataStart < blen;
    if (plausible) {
      records++;
      if (!meta0) meta0 = m;
      recMetas.push(m);
      const recIdx = recMetas.length - 1;
      const base = 240 + m.addHdrBytes;
      const end = dataStart + blen;
      let g = dataStart + m.dataStart;
      while (g + 240 <= end && offList.length < MAX_STREAM_TRACES) {
        if (!ensure(g, 240)) break;
        const probe = looksLikeTrace(win, g - winStart, g, fileSize, m);
        if (!probe.ok) break;
        if (nsList.length && probe.ns !== nsList[0]) varies = true;
        offList.push(g);
        nsList.push(probe.ns);
        recOfList.push(recIdx);
        g += base + probe.ns * m.bps;
      }
    }
    pos = dataStart + blen;
  }

  if (!meta0 || offList.length === 0) return null;
  const offsets = Float64Array.from(offList);
  const repNs = nsList.length ? nsList[0] : meta0.defaultNs;
  let nsArr: Int32Array | null = null;
  if (varies) nsArr = Int32Array.from(nsList);
  else if (nsList.length && nsList[0] !== meta0.defaultNs) { nsArr = new Int32Array(nsList.length); nsArr.fill(nsList[0]); }
  // Collapse the per-record meta to null when every record decodes identically (the
  // common case - SeisConv combines + typical tapes are homogeneous), so the single
  // shared-meta path stays byte-identical; keep them only for a heterogeneous tape.
  const m0 = recMetas[0];
  const heterogeneous = recMetas.some((mm) => mm.le !== m0.le || mm.format !== m0.format || mm.bps !== m0.bps || mm.addHdrBytes !== m0.addHdrBytes || mm.defaultNs !== m0.defaultNs);
  const recMetasOut = heterogeneous ? recMetas : null;
  const recOf = heterogeneous ? Int32Array.from(recOfList) : null;
  return { meta: meta0, offsets, nsArr, traceCount: offsets.length, repNs, hitCap: offList.length >= MAX_STREAM_TRACES, records, recMetas: recMetasOut, recOf };
}

type StreamOpen =
  | { ok: true; fd: number; meta: SegyMeta; offsets: Float64Array; nsArr: Int32Array | null; traceCount: number; repNs: number; hitCap: boolean; recMetas: SegyMeta[] | null; recOf: Int32Array | null }
  | { ok: false; notSegy?: boolean; error: string };

/**
 * Open a large file as a streamed SEG-Y: read the first 64 KiB, resolve the header
 * via parseSegyMeta, SANITY-CHECK it really is a SEG-Y we can stream, then build
 * the offset index. On success returns the live fd + index (caller owns the fd and
 * MUST close it). `notSegy:true` distinguishes "looks like something else" (caller
 * surfaces the too-large rejection) from a genuine read error.
 */
function openStreamIndex(path: string, fileSize: number): StreamOpen {
  let fd: number;
  try { fd = openSync(path, 'r'); }
  catch (e) { return { ok: false, error: 'Could not open file: ' + (e as Error).message }; }
  try {
    const head = readAt(fd, 0, Math.min(64 * 1024, fileSize));
    // iX1 "Stand Alone Mode" SEG-D tape: refuse honestly BEFORE any tape/SEG-Y
    // walk (streaming its raw SEG-D records is deferred - plan item 1.6 stretch).
    if (isIX1SegdTape(head)) {
      closeSync(fd);
      return { ok: false, error: 'iX1 "Stand Alone Mode" SEG-D tape image - not yet supported; open the per-shot .segd files instead.' };
    }
    const meta = parseSegyMeta(head);
    const looksSegy =
      SEGY_FORMAT_CODES.has(meta.format) &&
      meta.bps > 0 &&
      meta.defaultNs > 0 && meta.defaultNs <= MAX_SAMPLES_PER_TRACE &&
      meta.dataStart >= 3600;
    if (!looksSegy) {
      // Not a bare SEG-Y at offset 0 → maybe an ANSI/IBM TAPE IMAGE (a combined
      // .tpimage, or an Inova/ION .TpImage): walk the block framing, index each
      // embedded SEG-Y data block's traces, and stream the tape at ANY size (the
      // same on-demand path as a giant SEG-Y, so a 2/4/10 GB combine opens with
      // bounded memory instead of failing the in-memory cap).
      if (looksLikeTape(head, fileSize)) {
        const tidx = buildTapeStreamIndex(fd, fileSize);
        if (tidx && tidx.traceCount > 0) {
          return { ok: true, fd, meta: tidx.meta, offsets: tidx.offsets, nsArr: tidx.nsArr, traceCount: tidx.traceCount, repNs: tidx.repNs, hitCap: tidx.hitCap, recMetas: tidx.recMetas, recOf: tidx.recOf };
        }
      }
      closeSync(fd);
      return { ok: false, notSegy: true, error: 'not a streamable SEG-Y' };
    }
    const idx = buildStreamIndex(fd, fileSize, meta);
    if (idx.traceCount <= 0) { closeSync(fd); return { ok: false, error: 'No readable SEG-Y traces found in the file.' }; }
    // A bare SEG-Y is one homogeneous record → the single `meta` serves every trace.
    return { ok: true, fd, meta, offsets: idx.offsets, nsArr: idx.nsArr, traceCount: idx.traceCount, repNs: idx.repNs, hitCap: idx.hitCap, recMetas: null, recOf: null };
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    return { ok: false, error: (e as Error).message };
  }
}

/** Close + drop any streamed file (never leak the fd). Safe to call when none. */
function closeStream(): void {
  if (currentStream) {
    try { closeSync(currentStream.fd); } catch { /* already closed */ }
    currentStream = null;
  }
}

/** File-summary panel shape for a STREAMED file - mirrors summarize(), plus a
 *  `streamed:true` flag the UI can note. format/byteOrder/etc come from `meta`. */
function summarizeStream(s: StreamedFile) {
  return {
    format: 'SEG-Y',
    revision: s.meta.revision,
    traceCount: s.traceCount,
    samplesTrace: s.repNs || s.meta.defaultNs || null,
    sampleInt: s.meta.sampleInt || null,
    byteOrder: s.meta.le ? 'little-endian' : 'big-endian',
    errors: [] as string[],
    streamed: true,
    textHeader: s.meta.textHeader,
  };
}

interface Req {
  id: number;
  type: 'open' | 'quickMeta' | 'trace' | 'extractTrace' | 'section' | 'convert' | 'convertPath' | 'convertTapeRecord' | 'convertTraces' | 'reset' | 'openSPS' | 'spsClear' | 'binGrid' | 'spsGeometry' | 'spsXrefLines' | 'spsFold' | 'spsQC' | 'spsGeomCheck' | 'spsGeomLoad' | 'spsDelta' | 'spsPointDetail' | 'spsSourceList' | 'spsReproject' | 'spsCreate' | 'spsRenumber' | 'spsExport' | 'spsShapefile' | 'spsRaster' | 'spsHeaderList' | 'spsApplyHeaders' | 'spsSaveCorrected' | 'semblance' | 'avgSpectrum' | 'spectrogram' | 'fk' | 'traceHealth' | 'firstBreaks';
  path?: string;
  // spsApplyHeaders: scope ('shared' = all loaded files, else a file name) + the
  // edit/add/remove batch and an optional CRS rewrite. Mirrors the IPC contract.
  scope?: 'shared' | string;
  // `oldVal` (when present) targets a specific record by code+value so two
  // records sharing a code aren't edited/removed together. A `string` remove is
  // still accepted for code-only drops (back-compat).
  edits?: { code: string; val: string; oldVal?: string }[];
  adds?: { code: string; desc?: string; val: string }[];
  removes?: (string | { code: string; oldVal?: string })[];
  crs?: CRSSpec;
  // spsCreate (survey generator): a file stem + the acquisition geometry as map
  // picks (WGS84 lat/lon per line, projected to the CRS's E/N before generateSPS)
  // plus the CreateParams scalars (mode/intervals/numbering/relation/types).
  baseName?: string;
  picks?: { vertices: { lat: number; lon: number }[] }[];
  // spsCreate: PREPLOT lines whose stations are placed VERBATIM (an imported
  // pre-plot), as opposed to `picks`, which are walked at an interval. `e`/`n` are
  // the file's original projected coordinates and win over lat/long when present.
  preplots?: {
    lineName: string;
    role: 'R' | 'S' | 'SR';
    stations: { lat: number; lon: number; point: number; elev?: number; e?: number; n?: number }[];
  }[];
  mode?: '2D' | '3D';
  rcvInterval?: number;
  srcInterval?: number;
  rcvLineStart?: number;
  rcvLineInc?: number;
  rcvPointStart?: number;
  rcvPointInc?: number;
  srcLineStart?: number;
  srcLineInc?: number;
  srcPointStart?: number;
  srcPointInc?: number;
  // 3D only: source-line spacing (SLI, along the in-line bearing) + an optional
  // receiver-line bearing override; relation gains a moving-patch line count.
  srcLineSpacing?: number;
  azimuthDeg?: number;
  relation?: { type: 'full' | 'split'; channels?: number; patchLines?: number };
  srcType?: string;
  rcvType?: string;
  // spsCreate: 'Date file written' (H26) stamp; main.ts supplies it because the
  // worker can't read the wall clock (no `new Date()`).
  dateWritten?: string;
  // spsRenumber: per-category (source/receiver) line + point renumbering spec.
  spec?: RenumberSpec;
  paths?: string[];
  qc?: QCParams;
  code?: string;
  /** A fully resolved target CRS, supplied by main.ts from the EPSG registry.
   *  Distinct from `crs`, which is the Header Editor's loose CRSSpec. */
  targetCrs?: CRS | null;
  // spsRaster: the GeoTIFF wizard's dragged extent (WGS84 degrees), ground
  // resolution in output-CRS units, and which layers to produce.
  bounds?: { south: number; west: number; north: number; east: number } | null;
  whole?: boolean;
  marginM?: number;
  pixelSize?: number;
  layers?: ('fold' | 'elevation' | 'layout')[];
  demRadius?: number;
  // spsExport: which artifact to produce + optional QC params for the QC report.
  // 'p111' / 'coordcsv' re-serialize the point survey via buildPositioningExport.
  kind?: 'kml' | 'geojson' | 'csv' | 'qcreport' | 'p111' | 'coordcsv' | 'segp1' | 'sps';
  qcParams?: QCParams;
  // spsShapefile: the .dbf header date, supplied by main.ts because the worker
  // has no wall clock. (The output file-name stem reuses `baseName` above.)
  dateYMD?: [number, number, number];
  // spsPointDetail lookup key: pick the matching S/R point by line + point (+ idx).
  rtype?: 'S' | 'R';
  lineName?: string;
  point?: number;
  idx?: string;
  geo?: boolean;
  velMin?: number;
  velMax?: number;
  velStep?: number;
  index?: number;
  format?: string;
  // convertTapeRecord: the tape-label date stamp (` YYJJJ`), resolved by main (the
  // worker has no wall clock) so every streamed record shares one stable date.
  dateStr?: string;
  // convertTraces (Trace Workbench EXPORT): the collected traces + the sample
  // interval (µs) to stamp on the synthetic file (the collection's first trace).
  traces?: { samples: Float32Array; nSamples: number; hdr?: Record<string, number | string> }[];
  sampleInt?: number;
  maxTraces?: number;
  maxSamples?: number;
  // Optional visible sub-window for the section view (full-data indices). When
  // present, only this trace/sample range is decimated/returned, so zooming
  // re-fetches the visible region at full detail instead of magnifying pixels.
  traceStart?: number;
  traceEnd?: number;
  sampStart?: number;
  sampEnd?: number;
  agc?: boolean;
  agcType?: AGCType;
  agcWindowMs?: number;
  // traceHealth (File-Viewer QC): per-detector sensitivity + Advanced numeric
  // threshold overrides + the structural (scan-time) knobs. Thresholds are
  // applied to the SAME cached evidence the renderer re-classifies, so the
  // worker just forwards them through to scanTraceHealth.
  sensitivity?: Partial<Record<DetectorId, Sensitivity>>;
  thresholds?: Partial<HealthThresholds>;
  localWindow?: number;
  neighbors?: number;
  polarity?: boolean;
  polarityMax?: number;
  specMax?: number;
  // firstBreaks (assisted picker): the user's seed picks (≥2) keyed by ABSOLUTE
  // trace index + the picker tuning. Operates on REAL adjacent traces in
  // [traceStart, traceEnd) at step 1 (own real-trace cap), NOT the display columns.
  seeds?: { absIdx: number; tMs: number }[];
  fbWindowMs?: number;
  fbPolarity?: FBPolarity;
  fbStaMs?: number;
  fbLtaMs?: number;
  fbThreshold?: number;
  // spsFold: CMP bin dimensions (projected units, e.g. metres).
  binX?: number;
  binY?: number;
  // Spectrum Analysis tab: spectrogram STFT params (winLen/hop in samples) + the
  // f-k trace spacing (dx, projected distance units). traceStart/traceEnd above
  // double as the avgSpectrum averaging window.
  winLen?: number;
  hop?: number;
  dx?: number;
  // spsGeomCheck / spsDelta / spsGeomLoad: station-match (geomcheck/geomload) /
  // over-tolerance flag (delta) distance in metres. geomcheck/load default 2;
  // delta default 1.
  tolM?: number;
  // spsGeomLoad: the output coordinate/elevation scalar + which field groups to
  // stamp into the trace headers (all default on). main injects `path` (the open
  // file's path) so the worker re-reads the ORIGINAL bytes and patches in place.
  coordScalar?: number;
  writeCoords?: boolean;
  writeElev?: boolean;
  writeOffset?: boolean;
  writeCdp?: boolean;
  // spsDelta: the REFERENCE (pre-plot) SPS files, already read by main as text
  // (mirrors how main hands openSPS its picked paths). Parsed into their OWN
  // SPSData - never merged into / mutating currentSPS.
  referenceFiles?: { name: string; text: string }[];
}

function summarize(pf: ParsedFile) {
  // Byte order for the File-summary panel: SEG-Y / SU carry a DETECTED `littleEndian`
  // flag (auto-detection); SEG-2 is little-endian by spec, SEG-D big-endian by spec.
  const f = (pf.format || '').toUpperCase();
  const le = pf.bh.littleEndian;
  const byteOrder =
    f.includes('SEG-Y') || f === 'SU' ? (le ? 'little-endian' : 'big-endian')
      : f.includes('SEG-2') ? 'little-endian'
        : f.includes('SEG-D') ? 'big-endian'
          : '-';
  return {
    format: pf.format,
    revision: pf.revision,
    traceCount: pf.traceCount,
    samplesTrace: pf.bh.samplesTrace ?? pf.traces[0]?.nSamples ?? null,
    sampleInt: pf.bh.sampleInt ?? null,
    byteOrder,
    errors: pf.errors,
  };
}

/** Map a detectPositioningFormat id to a short human label for the stats badge. */
function fmtLabel(id: string): string {
  switch (id) {
    case 'sps': return 'SPS';
    case 'segp1': return 'SEG-P1';
    case 'p111': return 'P1/11';
    case 'p611': return 'P6/11';
    case 'coordcsv': return 'Coord CSV';
    default: return id.toUpperCase();
  }
}

// -- SPS exports (CSV / GeoJSON / KML / QC-report) --
//
// All of these read from the in-worker `currentSPS`. Geographic outputs reproject
// projected E/N to WGS84 lon/lat with the SAME projToLatLon spsGeometry uses; when
// the SPS header carries no projection they fall back to raw E/N (GeoJSON keeps the
// numbers + flags it; KML refuses, since it is geographic-only by spec).

type SPSExportProj = Parameters<typeof projToLatLon>[2];

/** Number → fixed string, blank for non-finite (keeps CSV cells / coords clean). */
function nz(v: unknown, dp = 6): string {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return isFinite(n) ? n.toFixed(dp) : '';
}

/** Quote a CSV cell only when it contains a comma, quote, or newline (RFC-4180). */
function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** Escape the five XML metacharacters for KML text/attribute content. */
function xmlEsc(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Project a point's E/N to lon/lat when `proj` is set; else echo raw E/N as lon/lat. */
function toLonLat(p: SPSPoint, proj: SPSExportProj | undefined): { lon: number; lat: number } {
  if (proj && isFinite(p.easting) && isFinite(p.northing)) {
    const ll = projToLatLon(p.easting, p.northing, proj, isFinite(p.elevation) ? p.elevation : 0);
    return { lon: ll.lon, lat: ll.lat };
  }
  return { lon: p.easting, lat: p.northing };
}

function buildSPSCsv(d: SPSData): { name: string; text: string }[] {
  const srcHdr = ['rtype', 'lineName', 'point', 'idx', 'easting', 'northing', 'elevation', 'srcType', 'upholeMs', 'date', 'time', 'ffid'];
  const rcvHdr = ['rtype', 'lineName', 'point', 'idx', 'easting', 'northing', 'elevation', 'staticMs'];
  const srcLines = [csvRow(srcHdr)];
  for (const s of d.sources) {
    srcLines.push(csvRow([s.rtype, s.lineName, s.point, s.idx, nz(s.easting, 3), nz(s.northing, 3), nz(s.elevation, 3), s.srcType ?? '', s.upholeMs ?? '', s.date ?? '', s.time ?? '', s.ffid ?? '']));
  }
  const rcvLines = [csvRow(rcvHdr)];
  for (const r of d.receivers) {
    rcvLines.push(csvRow([r.rtype, r.lineName, r.point, r.idx, nz(r.easting, 3), nz(r.northing, 3), nz(r.elevation, 3), r.staticMs ?? '']));
  }

  // X-refs: include the channel range only when present (SPS2.1 records carry it).
  const hasCh = d.xrefs.some((x) => x.fromCh != null || x.toCh != null);
  const xHdr = ['srcLine', 'srcPt', 'ffid', 'rcvLineFrom', 'rcvPtFrom', 'rcvPtTo', ...(hasCh ? ['fromCh', 'toCh'] : []), 'layout'];
  const xLines = [csvRow(xHdr)];
  for (const x of d.xrefs) {
    const row: unknown[] = [x.srcLine ?? '', x.srcPt ?? '', x.ffid ?? '', x.rcvLineFrom ?? '', x.rcvPtFrom ?? '', x.rcvPtTo ?? ''];
    if (hasCh) row.push(x.fromCh ?? '', x.toCh ?? '');
    row.push(x.layout ?? '');
    xLines.push(csvRow(row));
  }

  return [
    { name: 'sources.csv', text: srcLines.join('\n') + '\n' },
    { name: 'receivers.csv', text: rcvLines.join('\n') + '\n' },
    { name: 'xrefs.csv', text: xLines.join('\n') + '\n' },
  ];
}

function buildSPSGeoJSON(d: SPSData): { name: string; text: string }[] {
  const proj = (d.projection && d.projection.type ? d.projection : undefined) as unknown as SPSExportProj | undefined;
  const geographic = !!proj;
  const features: unknown[] = [];

  const pointFeature = (p: SPSPoint) => {
    const { lon, lat } = toLonLat(p, proj);
    if (!isFinite(lon) || !isFinite(lat)) return;
    const props: Record<string, unknown> = { rtype: p.rtype, lineName: p.lineName, point: p.point, idx: p.idx, easting: p.easting, northing: p.northing, elevation: p.elevation };
    if (p.rtype === 'S') { props.srcType = p.srcType; props.upholeMs = p.upholeMs; props.ffid = p.ffid; }
    else props.staticMs = p.staticMs;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: props });
  };
  for (const s of d.sources) pointFeature(s);
  for (const r of d.receivers) pointFeature(r);

  // One LineString per survey line (sources then receivers), points ordered.
  const lineFeatures = (pts: SPSPoint[], rtype: 'S' | 'R') => {
    const groups = groupByLine(pts);
    for (const name of Object.keys(groups)) {
      const coords: number[][] = [];
      for (const p of groups[name]) {
        const { lon, lat } = toLonLat(p, proj);
        if (isFinite(lon) && isFinite(lat)) coords.push([lon, lat]);
      }
      if (coords.length >= 2) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { rtype, lineName: name, kind: 'surveyLine' } });
    }
  };
  lineFeatures(d.sources, 'S');
  lineFeatures(d.receivers, 'R');

  const fc: Record<string, unknown> = { type: 'FeatureCollection', features };
  if (geographic) fc.crs = { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } };
  else fc.crsNote = 'projected, not WGS84 - coordinates are raw easting/northing (no projection in SPS header)';
  return [{ name: 'survey.geojson', text: JSON.stringify(fc, null, 2) + '\n' }];
}

function buildSPSKml(d: SPSData): { ok: boolean; files: { name: string; text: string }[]; error?: string } {
  const proj = (d.projection && d.projection.type ? d.projection : undefined) as unknown as SPSExportProj | undefined;
  if (!proj) return { ok: false, files: [], error: 'KML export needs a projected CRS in the SPS header' };

  const placemark = (p: SPSPoint, styleId: string): string => {
    const { lon, lat } = toLonLat(p, proj);
    if (!isFinite(lon) || !isFinite(lat)) return '';
    const elev = isFinite(p.elevation) ? p.elevation : 0;
    const name = `${p.lineName}/${p.point}${p.idx ? '.' + p.idx : ''}`;
    return [
      '      <Placemark>',
      `        <name>${xmlEsc(name)}</name>`,
      `        <styleUrl>#${styleId}</styleUrl>`,
      `        <Point><coordinates>${lon},${lat},${elev}</coordinates></Point>`,
      '      </Placemark>',
    ].join('\n');
  };

  const srcMarks = d.sources.map((p) => placemark(p, 'srcStyle')).filter(Boolean).join('\n');
  const rcvMarks = d.receivers.map((p) => placemark(p, 'rcvStyle')).filter(Boolean).join('\n');

  const kml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    '    <name>SeisConv survey</name>',
    '    <Style id="srcStyle"><IconStyle><color>ff0000ff</color><scale>0.8</scale>',
    '      <Icon><href>http://maps.google.com/mapfiles/kml/shapes/star.png</href></Icon></IconStyle></Style>',
    '    <Style id="rcvStyle"><IconStyle><color>ffff9900</color><scale>0.7</scale>',
    '      <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>',
    '    <Folder>',
    '      <name>Sources</name>',
    srcMarks,
    '    </Folder>',
    '    <Folder>',
    '      <name>Receivers</name>',
    rcvMarks,
    '    </Folder>',
    '  </Document>',
    '</kml>',
    '',
  ].join('\n');
  return { ok: true, files: [{ name: 'survey.kml', text: kml }] };
}

function buildSPSQCReport(d: SPSData, params: QCParams): { name: string; text: string }[] {
  const results = runSPSQC(d, params);
  let errors = 0, warns = 0, oks = 0;
  for (const r of results) { if (r.sev === 'error') errors++; else if (r.sev === 'warn') warns++; else oks++; }

  // A small comment-style header block (the data rows follow, machine-readable).
  const lines: string[] = [];
  lines.push('# SeisConv SPS QC report');
  lines.push(`# sources,${d.sources.length}`);
  lines.push(`# receivers,${d.receivers.length}`);
  lines.push(`# xrefs,${d.xrefs.length}`);
  lines.push(`# errors,${errors}`);
  lines.push(`# warnings,${warns}`);
  lines.push(`# ok,${oks}`);
  lines.push(csvRow(['severity', 'category', 'message', 'easting', 'northing']));
  for (const r of results) {
    const pt = r.pts && r.pts.length ? r.pts[0] : undefined;
    lines.push(csvRow([r.sev, r.cat, r.msg, pt ? nz(pt.easting, 3) : '', pt ? nz(pt.northing, 3) : '']));
  }
  return [{ name: 'sps_qc_report.csv', text: lines.join('\n') + '\n' }];
}

// -- SPS H-record (header) editing --
//
// All edits preserve the fixed-column SPS H-record format: cols 1-4 hold the
// 4-char code, cols 5-32 the description, cols 33-80 (0-based 32..79) the DATA
// field, terminated with `;`. The parser (parseSPSText) reads code = cols 1-4
// and val = everything from col 33 with a trailing `;…` stripped, so we write
// the value into cols 33-80, left/space-pad the whole line to 80, and re-add `;`.

/** Read the DATA field (cols 33-80) of an H-record line the way parseSPSText does:
 *  everything from col 33 on, with a trailing `;…` stripped, then trimmed. Used to
 *  disambiguate two records that share a code but differ in value. */
function hRecData(raw: string): string {
  const ln = raw || '';
  let data = ln.length > 32 ? ln.substring(32) : '';
  const semi = data.indexOf(';');
  if (semi >= 0) data = data.substring(0, semi);
  return data.trim();
}

/** Rewrite the DATA field (cols 33-80) of an H-record line, keeping cols 1-32
 *  (code + description) intact and re-terminating with `;`. Pads to 80. */
function rewriteHData(raw: string, val: string): string {
  const ln = (raw || '').padEnd(32, ' ');
  const prefix = ln.substring(0, 32); // code + description columns, untouched
  const data = (val ?? '').trim();
  return (prefix + data + ';').padEnd(80, ' ').substring(0, 80);
}

/** Build a fresh H-record line for an ADD: code in cols 1-4, description in
 *  cols 5-32, value in cols 33-80, `;`-terminated, padded to 80. */
function buildHRecord(code: string, desc: string | undefined, val: string): string {
  const c = (code || '').substring(0, 4);
  const label = (desc && desc.trim()) || spsHeaderDesc(code);
  // cols 1-32 = code (1-4) + description (5-32). Code may be 3 or 4 chars; pad
  // the code field so the description starts no earlier than col 5.
  const head = (c.padEnd(c.length >= 4 ? 4 : 4, ' ') + ' ' + label).substring(0, 32).padEnd(32, ' ');
  return (head + (val ?? '').trim() + ';').padEnd(80, ' ').substring(0, 80);
}

/**
 * Apply one file's H-record edit batch to its raw text, preserving fixed columns.
 *  - `edits`: rewrite the DATA field of every H-record whose code matches.
 *  - `crs`:   replace the projection H-records (PROJ_HEADER_CODES) in place from
 *             generateProjHeaders; any missing ones are appended (header-only -
 *             S/R coordinate lines are never touched).
 *  - `removes`: drop H-records whose code matches.
 *  - `adds`:  insert new H-records after the last existing H-record.
 * Returns the new file text.
 */
function applyHeaderEditsToText(
  text: string,
  edits: { code: string; val: string; oldVal?: string }[],
  adds: { code: string; desc?: string; val: string }[],
  removes: (string | { code: string; oldVal?: string })[],
  crsLines: Record<string, string> | null,
): string {
  const hadCRLF = /\r\n/.test(text);
  const eol = hadCRLF ? '\r\n' : '\n';
  // Split on either newline style; keep blank lines so structure is preserved.
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  // Strip a leading BOM from line 0 (parseSPSText does the same).
  if (lines.length && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);

  // Edits/removes can carry an optional `oldVal` so a record is matched by
  // code+value, not code alone - without it, two records sharing a code (e.g. two
  // H22x lines with different content) would all be rewritten/dropped together.
  // Keys: `code` for the code-only entries (back-compat: Admin/CRS upserts, adds
  // reconcile) and `code oldVal` for the value-discriminated ones.
  const SEP = ' ';
  const editByCode = new Map<string, string>();
  const editByCodeVal = new Map<string, string>();
  for (const e of edits || []) {
    if (e.oldVal != null) editByCodeVal.set(e.code + SEP + e.oldVal, e.val);
    else editByCode.set(e.code, e.val);
  }
  const removeCodes = new Set<string>();
  const removeCodeVals = new Set<string>();
  for (const r of removes || []) {
    if (typeof r === 'string') removeCodes.add(r);
    else if (r.oldVal != null) removeCodeVals.add(r.code + SEP + r.oldVal);
    else removeCodes.add(r.code);
  }
  // CRS rewrite codes still pending insertion (those not matched in place).
  const crsPending = new Set(crsLines ? Object.keys(crsLines) : []);

  const out: string[] = [];
  let lastHIdx = -1;
  for (const raw of lines) {
    const code = hRecCode(raw);
    if (code) {
      const cv = code + SEP + hRecData(raw);
      const removed = removeCodes.has(code) || removeCodeVals.has(cv);
      // CRS projection-record rewrite takes precedence over a plain edit.
      if (crsLines && crsLines[code] != null) {
        if (removed) { continue; } // user removed it → skip even under CRS
        out.push(crsLines[code]);
        crsPending.delete(code);
        lastHIdx = out.length - 1;
        continue;
      }
      if (removed) continue; // drop this H-record
      if (editByCodeVal.has(cv)) {
        out.push(rewriteHData(raw, editByCodeVal.get(cv)!));
        lastHIdx = out.length - 1;
        continue;
      }
      if (editByCode.has(code)) {
        out.push(rewriteHData(raw, editByCode.get(code)!));
        lastHIdx = out.length - 1;
        continue;
      }
      out.push(raw);
      lastHIdx = out.length - 1;
      continue;
    }
    out.push(raw);
  }

  // Records to insert after the last existing H-record: any CRS codes not found
  // in the file (header-only addition) followed by the explicit `adds`.
  const inserts: string[] = [];
  if (crsLines) {
    for (const code of PROJ_HEADER_CODES) {
      if (crsPending.has(code) && !removeCodes.has(code)) inserts.push(crsLines[code]);
    }
  }
  for (const a of adds || []) inserts.push(buildHRecord(a.code, a.desc, a.val));

  if (inserts.length) {
    if (lastHIdx >= 0) out.splice(lastHIdx + 1, 0, ...inserts);
    else out.unshift(...inserts); // no H block at all → prepend
  }

  return out.join(eol);
}

/** Re-parse + re-merge all currentSPSFiles into a fresh merged SPSData. */
function reparseMergeAll(files: { name: string; text: string }[]): SPSData | null {
  let merged: SPSData | null = null;
  for (const f of files) {
    const sps = parseSPSText(f.text);
    merged = merged ? mergeSPSData(merged, sps) : sps;
  }
  return merged;
}

/** Build the {code,val,raw,desc} header list from a parsed SPSData's H block. */
function headerListFromSPS(sps: SPSData | null): { code: string; val: string; raw: string; desc: string }[] {
  if (!sps) return [];
  return sps.headers.map((h: SPSHeader) => ({ code: h.code, val: h.val, raw: h.raw, desc: spsHeaderDesc(h.code, h.raw) }));
}

// Cache each loaded SPS file's H-block signature, keyed by the file ENTRY object and
// validated against its current text. spsFilesDiffer runs on every header-panel open
// and otherwise re-parses every file's full S/R/X body (via parseSPSText) just to
// compare H blocks; the cache reparses a file only when its text actually changes
// (load / header-edit / renumber). A WeakMap auto-drops entries GC'd on spsClear.
const hsigCache = new WeakMap<object, { text: string; sig: string }>();
function headerSig(f: { text: string }): string {
  const cached = hsigCache.get(f);
  if (cached && cached.text === f.text) return cached.sig;
  const hs = parseSPSText(f.text).headers;
  const sig = hs.map((h) => `${h.code}=${h.val}`).join('\n');
  hsigCache.set(f, { text: f.text, sig });
  return sig;
}

/** Whether the loaded SPS files' H blocks actually differ (by code+val). A
 *  single file (or none) never "differs". */
function spsFilesDiffer(files: { name: string; text: string }[]): boolean {
  if (files.length < 2) return false;
  const first = headerSig(files[0]);
  for (let i = 1; i < files.length; i++) if (headerSig(files[i]) !== first) return true;
  return false;
}

function buildSPSExport(d: SPSData, kind: 'kml' | 'geojson' | 'csv' | 'qcreport' | 'p111' | 'coordcsv' | 'segp1' | 'sps', qcParams: QCParams): { ok: boolean; files: { name: string; text: string }[]; error?: string } {
  if (kind === 'csv') return { ok: true, files: buildSPSCsv(d) };
  if (kind === 'geojson') return { ok: true, files: buildSPSGeoJSON(d) };
  if (kind === 'kml') return buildSPSKml(d);
  if (kind === 'qcreport') return { ok: true, files: buildSPSQCReport(d, qcParams) };
  // Positioning-format re-serialization (P1/11, coordinate CSV) lives in
  // core/sps/formats - dispatch through the single buildPositioningExport door.
  if (kind === 'p111' || kind === 'coordcsv' || kind === 'segp1' || kind === 'sps') return { ok: true, files: buildPositioningExport(kind, d) };
  return { ok: false, files: [], error: `unknown export kind: ${kind}` };
}

/**
 * Build the SPS load summary the renderer binds the stats bar + map to. SINGLE
 * source of truth shared by openSPS, spsCreate and spsRenumber so every survey
 * load - opened, generated or renumbered - returns the SAME shape. `fmtIds` are
 * raw detect-format ids (mapped to display labels here); `grid` is the optional
 * P6/11 bin grid loaded alongside.
 */
function spsSummary(merged: SPSData | null, fmtIds: string[], grid: BinGrid | null) {
  return {
    sources: merged?.sources.length ?? 0,
    receivers: merged?.receivers.length ?? 0,
    xrefs: merged?.xrefs.length ?? 0,
    layout: merged?.layout ?? null,
    projection: merged?.projection ?? null,
    errors: merged?.errors ?? [],
    formats: fmtIds.map(fmtLabel),
    binGrid: grid
      ? { nInline: grid.nInline, nCrossline: grid.nCrossline, originE: grid.originE, originN: grid.originN, binI: grid.binI, binJ: grid.binJ, inlineAzimuth: grid.inlineAzimuth }
      : null,
  };
}

/**
 * Bridge a resolved {@link CRS} (from crsFromSpec) to the parser's
 * {@link SPSProjection} model, so a GENERATED survey carries a projection that
 * spsGeometry/spsExport/spsReproject read exactly like a parsed one. The inverse
 * of write.ts' crsFromProjection; only the fields those consumers use are mapped
 * (note `invF`, not `f`, is what projToLatLon reads).
 */
function crsToSPSProjection(crs: CRS): SPSProjection {
  return {
    type: crs.subtype || null,
    subtype: crs.subtype || null,
    zone: crs.zone ?? null,
    hemi: crs.hemi ?? null,
    datum: null,
    ellipsoid: null,
    a: crs.a ?? null,
    invF: crs.f ? 1 / crs.f : null,
    units: 'meters',
    unitFactor: 1,
    centralMeridian: crs.lon0 ?? null,
    latOrigin: crs.lat0 ?? null,
    falseEasting: crs.FE ?? null,
    falseNorthing: crs.FN ?? null,
    scaleFactor: crs.k0 ?? null,
    helmert: crs.helmert ?? null,
    source: 'create',
    desc: crs.name || crs.code || 'Custom',
  };
}

/** The ArrayBuffer to TRANSFER for a writer/encoder output `out`: the whole
 *  underlying buffer when `out` spans it exactly (every writer allocates a fresh
 *  Uint8Array with byteOffset 0, so this is the common, zero-copy case), else an
 *  exact slice. Replaces an unconditional slice-copy of every conversion's output
 *  before IPC transfer; the guard keeps it correct for any pooled/offset buffer. */
function transferBuffer(out: Uint8Array): ArrayBuffer {
  return (out.byteOffset === 0 && out.byteLength === out.buffer.byteLength)
    ? (out.buffer as ArrayBuffer)
    : (out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
}

/**
 * Parse a file the worker has read WHOLE into memory (open / convertPath /
 * convertTapeRecord / extractTrace-fallback). A SEG-Y gets EVERY trace's samples
 * decoded - the parser caps in-memory sample decoding at MAX_SAMPLE_TRACES (2000)
 * to bound arbitrary files, but a file on this path is already size-bounded, and
 * leaving the deep traces sample-less renders BLANK when the viewer pans/zooms past
 * the cap, ZEROES them on convert (writeSEGY emits 0 for a null-sample trace) and
 * yields empty samples when extracting a high trace index. The decode is bounded by
 * a total-sample budget (so a few very long traces can't blow memory) and never
 * below the parser's own cap. Non-SEG-Y containers (SEG-D / SU / tape image) go
 * through parseAny unchanged. `bytes` is read-only here (a Node Buffer is fine).
 */
function parseInMemory(bytes: Uint8Array, name: string): ParsedFile {
  if (detect(bytes, name) === 'SEG-Y') {
    const perTrace = Math.max(1, parseSegyMeta(bytes).defaultNs || 1);
    const cap = Math.max(MAX_SAMPLE_TRACES, Math.min(MAX_TRACES, Math.floor(IN_MEMORY_SAMPLE_BUDGET / perTrace)));
    return parseSEGY(bytes, cap);
  }
  return parseAny(bytes, name);
}

// Largest file the Trigger Watch quickMeta parse will read WHOLE. Shot files
// from the recorder are a few MB; this cap just bounds a mis-pointed watch.
const QUICKMETA_MAX_BYTES = 256 * 1024 * 1024;

port.on('message', (req: Req) => {
  const { id, type } = req;
  try {
    if (type === 'quickMeta') {
      // Observer Log "Trigger Watch" enrichment: quick FFID / traces / ns for a
      // just-landed shot file. Parses into a LOCAL - never touches `current` /
      // `currentStream`, so the viewer's open file is NOT clobbered by
      // enrichment parses running mid-session. (main.ts confines the path to
      // the actively watched folder before the request reaches us.)
      if (typeof req.path !== 'string' || !req.path) {
        port.postMessage({ id, ok: false, error: 'quickMeta: missing or invalid path' });
        return;
      }
      let size: number;
      try { size = statSync(req.path).size; }
      catch (e) { port.postMessage({ id, ok: false, error: 'Could not read file: ' + (e as Error).message }); return; }
      if (size <= 0 || size > QUICKMETA_MAX_BYTES) {
        port.postMessage({ id, ok: false, error: `quickMeta: file empty or too large (${size} bytes)` });
        return;
      }
      const pf = parseAny(readFileSync(req.path), basename(req.path));
      if (!pf || pf.traceCount <= 0) {
        port.postMessage({ id, ok: false, error: pf?.errors?.[0] || 'Unrecognized or unsupported shot file.' });
        return;
      }
      const t0 = pf.traces[0];
      const ns = t0?.nSamples ?? (typeof pf.bh.samplesTrace === 'number' ? pf.bh.samplesTrace : null);
      const siUs = typeof pf.bh.sampleInt === 'number' && pf.bh.sampleInt > 0 ? pf.bh.sampleInt : null;
      // FFID: SEG-Y/SU trace header 'fieldRec'; SEG-D general header 'fileNum'.
      // SEG-2 has no FFID - the renderer falls back to the file-name digits.
      const fr = t0?.hdr?.['fieldRec'];
      const fn = pf.gh1?.['fileNum'];
      const ffid = typeof fr === 'number' && fr > 0 ? fr
        : typeof fn === 'number' && fn > 0 ? fn : null;
      port.postMessage({ id, ok: true, meta: { format: pf.format, traces: pf.traceCount, ns, siUs, ffid } });
      return;
    }
    if (type === 'open') {
      if (typeof req.path !== 'string' || !req.path) { port.postMessage({ id, ok: false, error: 'open: missing or invalid path' }); return; }
      // A new file replaces whatever was loaded: drop the in-memory file and close
      // any streamed fd up front so neither lingers (current XOR currentStream).
      closeStream();
      current = null;
      // Bound memory BEFORE the read: stat the file (O(1), no bytes touched) so a
      // multi-GB file can never block this single-threaded worker (which would
      // queue - and so freeze - every later Clear/Open). See STREAM_THRESHOLD.
      let fileSize: number;
      try { fileSize = statSync(req.path).size; }
      catch (e) { port.postMessage({ id, ok: false, error: 'Could not read file: ' + (e as Error).message }); return; }

      // -- Large file → try the streaming/indexed SEG-Y path (bounded memory) --
      if (fileSize > STREAM_THRESHOLD) {
        const gb = (fileSize / 1e9).toFixed(2);
        if (fileSize > MAX_STREAM_BYTES) {
          port.postMessage({ id, ok: false, error: `File too large to open in the viewer (${gb} GB). Convert or split it first.` });
          return;
        }
        const opened = openStreamIndex(req.path, fileSize);
        if (opened.ok) {
          currentStream = {
            fd: opened.fd, path: req.path, name: basename(req.path), meta: opened.meta,
            offsets: opened.offsets, nsArr: opened.nsArr, traceCount: opened.traceCount, repNs: opened.repNs,
            recMetas: opened.recMetas, recOf: opened.recOf,
          };
          port.postMessage({ id, ok: true, summary: summarizeStream(currentStream) });
          return;
        }
        if (!opened.notSegy) {
          // A genuine open/read error (not "looks like another format").
          port.postMessage({ id, ok: false, error: opened.error });
          return;
        }
        // Not a streamable SEG-Y (big SEG-D / other). Fall back to loading it WHOLE
        // only within the prior in-memory cap; above that it's refused (loading the
        // whole file would block the worker - the original freeze risk).
        if (fileSize > IN_MEMORY_MAX) {
          port.postMessage({ id, ok: false, error: `File too large to open in the viewer (${gb} GB). The viewer loads non-SEG-Y files into memory - convert or split it first.` });
          return;
        }
        // else fall through to the in-memory path below.
      }

      // -- Small/medium file (or a non-streamable file ≤ the in-memory cap) --
      // readFileSync returns a Buffer (a Uint8Array); the parsers only READ it, so
      // pass it straight through instead of copying into a fresh Uint8Array. A SEG-Y
      // gets every trace's samples decoded (parseInMemory) so the viewer doesn't go
      // blank past the preview cap.
      current = parseInMemory(readFileSync(req.path), basename(req.path));
      // parseAny never throws on garbage; an unrecognized / undecodable container
      // (an UNKNOWN blob, or a tape-image archive with no embedded seismic file)
      // comes back with zero traces and an `errors` note. Surface that as a clean
      // failure - never "open" an empty viewer the user can do nothing with, and
      // drop `current` so a later Clear/Open isn't confused by a half-state.
      if (!current || current.traceCount <= 0) {
        const why = current?.errors?.[0];
        current = null;
        port.postMessage({ id, ok: false, error: why || 'Unrecognized or unsupported file format (e.g. a tape-image archive) - cannot open in the viewer.' });
        return;
      }
      port.postMessage({ id, ok: true, summary: summarize(current) });
      return;
    }

    if (type === 'reset') {
      current = null;
      closeStream(); // never leak the streamed fd
      extractIndexCache = null; // drop the Trace Workbench offset-index cache
      currentSPS = null;
      currentSPSFiles = [];
      currentBinGrid = null;
      currentBinGridSig = null;
      port.postMessage({ id, ok: true });
      return;
    }

    // Clear ONLY the SPS survey state, leaving any open seismic file untouched
    // (distinct from 'reset', which also drops `current`). Backs the SPS tab's
    // dedicated "Clear SPS" control so the user can start a fresh survey without
    // closing the file they're converting/inspecting.
    if (type === 'spsClear') {
      currentSPS = null;
      currentSPSFiles = [];
      currentBinGrid = null;
      currentBinGridSig = null;
      port.postMessage({ id, ok: true });
      return;
    }

    // Return the loaded P6/11 bin grid (or null when none is loaded). The grid is
    // populated by openSPS when a positioning file resolves to kind:'bingrid'.
    if (type === 'binGrid') {
      port.postMessage({ id, ok: true, grid: currentBinGrid });
      return;
    }

    if (type === 'convertPath') {
      if (typeof req.path !== 'string' || !req.path) { port.postMessage({ id, ok: false, error: 'convertPath: missing or invalid path' }); return; }
      const writer = getWriter(req.format!);
      if (!writer) {
        port.postMessage({ id, ok: false, error: `unknown output format: ${req.format}` });
        return;
      }
      // Parse into a LOCAL variable - never overwrite the persistent `current`.
      // readFileSync returns a Buffer (read-only here) → no fresh-Uint8Array copy;
      // parseInMemory decodes every SEG-Y trace so a large file isn't zeroed on convert.
      const local = parseInMemory(readFileSync(req.path), basename(req.path));
      const out = writer.write(local);
      const ab = transferBuffer(out);
      port.postMessage({ id, ok: true, bytes: ab, ext: writer.ext }, [ab]);
      return;
    }

    // Frame ONE input file into a single tape RECORD (HDR/data/EOF group). The
    // MEMORY-BOUNDED combine path: main drives the loop, calling this once per file
    // and APPENDING each returned record to a write stream (with VOL1 header first +
    // closing tape marks last), so a 4/10 GB combine never holds all inputs - or the
    // whole output - in RAM, and emits genuine per-file progress. `index` (0-based)
    // sets the record's file-sequence number; `dateStr` stamps the label date. A bad
    // / oversized / traceless input resolves ok:false so main can skip it cleanly.
    if (type === 'convertTapeRecord') {
      if (typeof req.path !== 'string' || !req.path) { port.postMessage({ id, ok: false, error: 'convertTapeRecord: missing or invalid path' }); return; }
      let size: number;
      try { size = statSync(req.path).size; } catch { port.postMessage({ id, ok: false, error: 'unreadable' }); return; }
      // One input file is read whole to parse it; bound it by the in-memory cap so a
      // single pathological giant can't OOM the worker (the OUTPUT still streams).
      if (size > IN_MEMORY_MAX) { port.postMessage({ id, ok: false, error: `too large to combine (${(size / 1e9).toFixed(2)} GB)` }); return; }
      let pf: ParsedFile;
      // Decode every SEG-Y trace's samples (parseInMemory) - writeTapeRecord
      // re-encodes from pf.traces, so the preview cap would zero a large file's
      // deep traces in the combined tape.
      try { pf = parseInMemory(readFileSync(req.path), basename(req.path)); }
      catch (e) { port.postMessage({ id, ok: false, error: (e as Error).message }); return; }
      if (!pf || pf.traceCount <= 0) { port.postMessage({ id, ok: false, error: 'no traces / unsupported' }); return; }
      // Tag with the source base name so the record's HDR1 file id carries it.
      (pf as ParsedFile & { _name?: string })._name = basename(req.path);
      const idx = Number.isFinite(req.index) ? (req.index as number) | 0 : 0;
      const out = writeTapeRecord(pf, idx, { dateStr: typeof req.dateStr === 'string' ? req.dateStr : undefined });
      const ab = transferBuffer(out);
      port.postMessage({ id, ok: true, bytes: ab }, [ab]);
      return;
    }

    if (type === 'openSPS') {
      // ACCUMULATE: each Load APPENDS to the in-worker survey instead of
      // replacing it. Seed `merged` from whatever's already loaded so a 2nd/3rd
      // Load adds its stations to the existing survey, and APPEND to
      // currentSPSFiles (never reset) so reproject/export see every loaded file.
      //
      // Every file is now routed through the positioning-format dispatch: the
      // format is detected per file (extension-first, then content) and parsed.
      // A point format (sps / segp1 / p111 / coordcsv) merges into currentSPS
      // exactly as before - the 'sps' path stays byte-identical, since detect
      // defaults to 'sps' and parsePositioning('sps') calls parseSPSText. A
      // bin-grid format (p611) populates currentBinGrid instead of the point list.
      let merged: SPSData | null = currentSPS;
      let lastGrid: BinGrid | null = null;
      // Collect the distinct positioning formats touched THIS call so the renderer
      // can badge what was loaded (e.g. "SPS · P1/11", "P6/11"). Order-preserving.
      const fmtsSeen: string[] = [];
      // Bound memory BEFORE readFileSync: skip any positioning file larger than a
      // generous cap so a hostile multi-GB file can't exhaust memory pre-parse.
      const MAX_SPS_FILE_BYTES = 64 * 1024 * 1024; // 64 MB
      const spsPaths = req.paths ?? [];
      let spsDone = 0;
      for (const p of spsPaths) {
        if (typeof p === 'string' && p) emitProgress('sps', spsDone, spsPaths.length, `Loading ${basename(p)}`);
        spsDone++;
        if (typeof p !== 'string' || !p) continue;
        try { if (statSync(p).size > MAX_SPS_FILE_BYTES) continue; } catch { continue; }
        const text = readFileSync(p, 'utf8');
        const name = basename(p);
        const fmt = detectPositioningFormat(name, text);
        if (!fmtsSeen.includes(fmt)) fmtsSeen.push(fmt);
        // Bin-grid dedup BEFORE the (multi-MB) parse: a P6/11 grid is never tracked
        // in currentSPSFiles, so without this an identical .p611 would be re-read AND
        // re-parsed on every Load. 'p611' always resolves to a bin grid. Skip the
        // parse when name+text is unchanged.
        if (fmt === 'p611') {
          const sig = name + '␟' + text;
          if (sig === currentBinGridSig && currentBinGrid) { lastGrid = currentBinGrid; continue; }
          const parsedGrid = parsePositioning(fmt, text);
          if (parsedGrid.kind === 'bingrid') {
            // Bin grids are not point files: store the latest one and skip the
            // currentSPSFiles point-list (reproject/header-edit don't apply to it).
            currentBinGrid = parsedGrid.grid;
            currentBinGridSig = sig;
            lastGrid = parsedGrid.grid;
          }
          continue;
        }
        const parsed = parsePositioning(fmt, text);
        if (parsed.kind === 'bingrid') {
          // Defensive: detect said non-grid but parse resolved to a grid anyway.
          currentBinGrid = parsed.grid;
          currentBinGridSig = name + '␟' + text;
          lastGrid = parsed.grid;
          continue;
        }
        // Skip a file that's already loaded with identical content: re-loading the
        // same set would otherwise add duplicate scope-selector entries and make
        // spsSaveCorrected zip two files with the same name. Point dedup in
        // mergeSPSData already collapses the stations, but the file list does not.
        if (currentSPSFiles.some((f) => f.name === name && f.text === text)) continue;
        currentSPSFiles.push({ name, text, type: detectSPSType(name, text) });
        merged = merged ? mergeSPSData(merged, parsed.data) : parsed.data;
      }
      currentSPS = merged;
      // Single source of truth for the summary shape (shared with spsCreate /
      // spsRenumber). `fmtsSeen` are the distinct positioning format(s) detected
      // this Load (badged by the stats bar); `lastGrid` surfaces a P6/11 grid.
      port.postMessage({ id, ok: true, summary: spsSummary(merged, fmtsSeen, lastGrid) });
      return;
    }

    if (type === 'spsGeometry') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const proj = currentSPS.projection as unknown as Parameters<typeof projToLatLon>[2];
      const geo = !!req.geo && !!currentSPS.projection;
      const build = (pts: SPSPoint[]) => {
        const groups = groupByLine(pts);
        const names = Object.keys(groups);
        let total = 0;
        for (const n of names) total += groups[n].length;
        const x = new Float32Array(total);
        const y = new Float32Array(total);
        const line = new Int32Array(total);
        const pt = new Float32Array(total);
        let k = 0;
        names.forEach((n, li) => {
          for (const p of groups[n]) {
            let cx = p.easting;
            let cy = p.northing;
            if (geo && isFinite(cx) && isFinite(cy)) {
              const ll = projToLatLon(cx, cy, proj, 0);
              cx = ll.lon;
              cy = ll.lat;
            }
            x[k] = cx;
            y[k] = cy;
            line[k] = li;
            pt[k] = p.point;
            k++;
          }
        });
        return { x, y, line, pt, names };
      };
      const src = build(currentSPS.sources);
      const rcv = build(currentSPS.receivers);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const g of [src, rcv]) {
        for (let i = 0; i < g.x.length; i++) {
          const a = g.x[i];
          const b = g.y[i];
          if (!isFinite(a) || !isFinite(b)) continue;
          if (a < minX) minX = a;
          if (a > maxX) maxX = a;
          if (b < minY) minY = b;
          if (b > maxY) maxY = b;
        }
      }
      const transfer = [src.x.buffer, src.y.buffer, src.line.buffer, src.pt.buffer, rcv.x.buffer, rcv.y.buffer, rcv.line.buffer, rcv.pt.buffer] as ArrayBuffer[];
      port.postMessage({ id, ok: true, geo, src, rcv, bbox: { minX, maxX, minY, maxY } }, transfer);
      return;
    }

    // X-ref "spider": one segment per (shot → live receiver) connection. Returns
    // parallel typed arrays of endpoint coords + a per-shot group id so the
    // renderer can emphasize a single clicked shot. Mirrors spsGeometry's geo
    // reprojection + transferable buffers.
    if (type === 'spsXrefLines') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const proj = currentSPS.projection as unknown as Parameters<typeof projToLatLon>[2];
      const geo = !!req.geo && !!currentSPS.projection;
      const num = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v)));

      // Lookup maps: trimmed(line)|point → point. Sources keyed for shot resolve,
      // receivers keyed for range expansion.
      const srcMap = new Map<string, SPSPoint>();
      for (const s of currentSPS.sources) srcMap.set(`${(s.lineName || '').trim()}|${s.point}`, s);
      const rcvMap = new Map<string, SPSPoint>();
      for (const r of currentSPS.receivers) rcvMap.set(`${(r.lineName || '').trim()}|${r.point}`, r);

      // Cap total segments; if the survey would blow past it, decimate the xref
      // LIST (keep every Nth xref) so a representative spider still renders.
      const MAX_SEG = 50000;
      const xrefs = currentSPS.xrefs;
      // First count how many segments a full pass would emit, to pick a stride.
      let wouldEmit = 0;
      for (const x of xrefs) {
        const from = num(x.rcvPtFrom), to = num(x.rcvPtTo);
        if (!isFinite(from) || !isFinite(to)) continue;
        const incr = x.layout === 'SPS2.1' ? 1 : Math.max(1, num(x.rcvPtIncr) || 1);
        if (to >= from) wouldEmit += Math.floor((to - from) / incr) + 1;
      }
      const xrefStride = wouldEmit > MAX_SEG ? Math.ceil(wouldEmit / MAX_SEG) : 1;
      const decimated = xrefStride > 1;

      // Per-shot grouping: every distinct (srcLine|srcPt) becomes one group id so
      // the renderer can light up a clicked source's whole fan.
      const shotIndex = new Map<string, number>();
      const shotKeys: string[] = [];
      const sxA: number[] = [], syA: number[] = [], rxA: number[] = [], ryA: number[] = [], shotA: number[] = [];

      for (let xi = 0; xi < xrefs.length; xi++) {
        if (decimated && xi % xrefStride !== 0) continue;
        if (sxA.length >= MAX_SEG) break;
        const x = xrefs[xi];
        const srcKey = `${String(x.srcLine).trim()}|${num(x.srcPt)}`;
        const shot = srcMap.get(srcKey);
        if (!shot) continue;
        let sx = shot.easting, sy = shot.northing;
        if (!isFinite(sx) || !isFinite(sy)) continue;
        if (geo) { const ll = projToLatLon(sx, sy, proj, 0); sx = ll.lon; sy = ll.lat; }

        // Stable per-shot group id (first time we see this shot → new id).
        let gid = shotIndex.get(srcKey);
        if (gid === undefined) { gid = shotKeys.length; shotIndex.set(srcKey, gid); shotKeys.push(srcKey); }

        const rcvLine = String(x.rcvLineFrom).trim();
        const from = num(x.rcvPtFrom), to = num(x.rcvPtTo);
        if (!isFinite(from) || !isFinite(to) || to < from) continue;
        const incr = x.layout === 'SPS2.1' ? 1 : Math.max(1, num(x.rcvPtIncr) || 1);
        // Bound the inner range walk independently of pushes: a crafted X-file
        // range (from=0,to=1e9,incr=1) whose points never match would otherwise
        // run ~1e9 Map lookups and hang the single-threaded worker, since the
        // sxA-length break only fires when a segment is actually pushed.
        let rcvSteps = 0;
        for (let rp = from; rp <= to; rp += incr) {
          if (sxA.length >= MAX_SEG || ++rcvSteps > MAX_SEG) break;
          const rcv = rcvMap.get(`${rcvLine}|${rp}`);
          if (!rcv) continue;
          let rx = rcv.easting, ry = rcv.northing;
          if (!isFinite(rx) || !isFinite(ry)) continue;
          if (geo) { const ll = projToLatLon(rx, ry, proj, 0); rx = ll.lon; ry = ll.lat; }
          sxA.push(sx); syA.push(sy); rxA.push(rx); ryA.push(ry); shotA.push(gid);
        }
      }

      const sx = Float32Array.from(sxA);
      const sy = Float32Array.from(syA);
      const rx = Float32Array.from(rxA);
      const ry = Float32Array.from(ryA);
      const shot = Int32Array.from(shotA);
      const log = decimated
        ? `X-ref spider decimated: ~${wouldEmit} segments > ${MAX_SEG} cap; kept every ${xrefStride}${xrefStride === 2 ? 'nd' : xrefStride === 3 ? 'rd' : 'th'} xref → ${sx.length} segments.`
        : '';
      port.postMessage(
        { id, ok: true, geo, sx, sy, rx, ry, shot, shotKeys, decimated, log },
        [sx.buffer, sy.buffer, rx.buffer, ry.buffer, shot.buffer] as ArrayBuffer[],
      );
      return;
    }

    // FOLD / coverage bin map: count CMP midpoints ((shot+receiver)/2) per bin.
    // Reuses the EXACT xref-expansion logic from spsXrefLines (srcMap/rcvMap +
    // SPS2.1 incr-1 / legacy rcvPtIncr range walk), but instead of emitting a
    // segment per (shot, receiver) pair it accumulates the midpoint into a 2-D
    // bin grid. Always works in PROJECTED E/N (fold maps are a planning view).
    if (type === 'spsFold') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const num = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v)));
      const binX = num(req.binX) > 0 ? num(req.binX) : 25;
      const binY = num(req.binY) > 0 ? num(req.binY) : 25;

      // Same lookup maps as spsXrefLines: trimmed(line)|point → SPSPoint.
      const srcMap = new Map<string, SPSPoint>();
      for (const s of currentSPS.sources) srcMap.set(`${(s.lineName || '').trim()}|${s.point}`, s);
      const rcvMap = new Map<string, SPSPoint>();
      for (const r of currentSPS.receivers) rcvMap.set(`${(r.lineName || '').trim()}|${r.point}`, r);

      const xrefs = currentSPS.xrefs;

      // Cap total CMP pairs. First count how many a full pass would emit, then
      // decimate the xref LIST by a stride (keep every Nth xref) if over.
      const MAX_PAIRS = 2_000_000;
      let wouldEmit = 0;
      for (const x of xrefs) {
        const from = num(x.rcvPtFrom), to = num(x.rcvPtTo);
        if (!isFinite(from) || !isFinite(to)) continue;
        const incr = x.layout === 'SPS2.1' ? 1 : Math.max(1, num(x.rcvPtIncr) || 1);
        if (to >= from) wouldEmit += Math.floor((to - from) / incr) + 1;
      }
      const xrefStride = wouldEmit > MAX_PAIRS ? Math.ceil(wouldEmit / MAX_PAIRS) : 1;
      const decimated = xrefStride > 1;

      // FIRST PASS: walk every (shot, receiver) pair, accumulate midpoints into a
      // flat buffer AND track the midpoint extent. We materialize midpoints once
      // (Float64) so the second binning pass is a cheap index loop.
      // Pre-allocate fixed Float64 buffers (the xref-list decimation above already
      // targets ~MAX_PAIRS total midpoints) instead of growing dynamic number[]s via
      // push(); a hard total cap also bounds the emitted count against pathological
      // per-xref ranges. Peak memory is O(MAX_PAIRS), not O(file size).
      const mx = new Float64Array(MAX_PAIRS);
      const my = new Float64Array(MAX_PAIRS);
      let nMid = 0;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      pairLoop:
      for (let xi = 0; xi < xrefs.length; xi++) {
        if (decimated && xi % xrefStride !== 0) continue;
        const x = xrefs[xi];
        const shot = srcMap.get(`${String(x.srcLine).trim()}|${num(x.srcPt)}`);
        if (!shot) continue;
        const sx = shot.easting, sy = shot.northing;
        if (!isFinite(sx) || !isFinite(sy)) continue;
        const rcvLine = String(x.rcvLineFrom).trim();
        const from = num(x.rcvPtFrom), to = num(x.rcvPtTo);
        if (!isFinite(from) || !isFinite(to) || to < from) continue;
        const incr = x.layout === 'SPS2.1' ? 1 : Math.max(1, num(x.rcvPtIncr) || 1);
        // Bound the inner range walk: MAX_PAIRS decimation is an xref-LIST stride
        // and never caps a single xref, so a crafted range (from=0,to=1e9,incr=1)
        // would run ~1e9 Map lookups and hang the worker. Cap iterations per xref.
        let rcvSteps = 0;
        for (let rp = from; rp <= to; rp += incr) {
          if (++rcvSteps > MAX_PAIRS) break;
          const rcv = rcvMap.get(`${rcvLine}|${rp}`);
          if (!rcv) continue;
          const rx = rcv.easting, ry = rcv.northing;
          if (!isFinite(rx) || !isFinite(ry)) continue;
          const cx = (sx + rx) / 2, cy = (sy + ry) / 2;
          if (nMid >= MAX_PAIRS) break pairLoop;
          mx[nMid] = cx; my[nMid] = cy; nMid++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
        }
      }

      const totalMid = nMid;
      if (totalMid === 0 || !isFinite(minX)) {
        port.postMessage({ id, ok: false, error: 'no CMP midpoints (need matching S/R points referenced by X-refs)' });
        return;
      }

      // Grid dimensions, row-major (iy * nx + ix).
      const nx = Math.ceil((maxX - minX) / binX) + 1;
      const ny = Math.ceil((maxY - minY) / binY) + 1;

      // Guard: clamp total cells to a sane cap; ask for a bigger bin if exceeded.
      const MAX_CELLS = 4_000_000;
      if (nx * ny > MAX_CELLS) {
        const ext = `${Math.round(maxX - minX)} × ${Math.round(maxY - minY)} units`;
        port.postMessage({
          id, ok: false,
          error: `bin too small: ${nx} × ${ny} = ${nx * ny} cells exceeds the ${MAX_CELLS} cell cap for a ${ext} midpoint extent. Increase the bin size.`,
        });
        return;
      }

      // SECOND PASS: bin the midpoints.
      const fold = new Int32Array(nx * ny);
      let maxFold = 0;
      for (let i = 0; i < totalMid; i++) {
        let ix = Math.floor((mx[i] - minX) / binX);
        let iy = Math.floor((my[i] - minY) / binY);
        if (ix < 0) ix = 0; else if (ix >= nx) ix = nx - 1;
        if (iy < 0) iy = 0; else if (iy >= ny) iy = ny - 1;
        const v = ++fold[iy * nx + ix];
        if (v > maxFold) maxFold = v;
      }

      const log = decimated
        ? `Fold map decimated: ~${wouldEmit} CMP pairs > ${MAX_PAIRS} cap; kept every ${xrefStride}${xrefStride === 2 ? 'nd' : xrefStride === 3 ? 'rd' : 'th'} xref → ${totalMid} midpoints. Bin ${binX}×${binY}, grid ${nx}×${ny}, max fold ${maxFold}.`
        : `Fold map: ${totalMid} CMP midpoints, bin ${binX}×${binY}, grid ${nx}×${ny}, max fold ${maxFold}.`;

      port.postMessage(
        { id, ok: true, nx, ny, binX, binY, originX: minX, originY: minY, fold, maxFold, totalMid, decimated, log },
        [fold.buffer] as ArrayBuffer[],
      );
      return;
    }

    if (type === 'spsQC') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const results = runSPSQC(currentSPS, req.qc ?? {});
      // Forward each finding's offending points as lightweight coords so the
      // renderer can locate + highlight them (the full SPSPoint stays here).
      port.postMessage({
        id,
        ok: true,
        results: results.map((r) => ({
          sev: r.sev,
          cat: r.cat,
          msg: r.msg,
          pts: (r.pts || []).map((p) => ({ rtype: p.rtype, lineName: p.lineName, point: p.point, easting: p.easting, northing: p.northing })),
        })),
      });
      return;
    }

    // -- Geometry Integrity Suite (Phase 2) --
    //
    // Cross-check the OPEN seismic file's per-trace header geometry against the
    // loaded SPS survey design (the pure, bounded core check from Phase 1). Needs
    // BOTH a seismic file (`current`) AND a survey (`currentSPS`) loaded at once -
    // the worker holds both. Per-trace TraceHeaders are retained for every parsed
    // trace (only the SAMPLE arrays are dropped past the preview cap), so the
    // headers come straight from `current.traces[i].hdr` - no re-parse. Raw header
    // coords + coordScalar are passed through; checkGeometry applies the scalar.
    if (type === 'spsGeomCheck') {
      if (!current) {
        port.postMessage({ id, ok: false, error: 'load a SEG-Y / seismic file first' });
        return;
      }
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'load an SPS first' });
        return;
      }
      // Coerce a header field to a finite number (missing / string / non-finite →
      // 0; checkGeometry guards anyway and treats a 0 scalar as a no-op).
      const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);
      // Bound the build by the parser's own trace cap (headers are retained for
      // every parsed trace, already ≤ MAX_TRACES) so a huge file stays bounded.
      const cap = Math.min(current.traces.length, MAX_TRACES);
      const traces: TraceGeom[] = new Array(cap);
      for (let i = 0; i < cap; i++) {
        const h = current.traces[i]?.hdr ?? {};
        traces[i] = {
          ffid: num(h.fieldRec),
          channel: num(h.trcField),
          srcPt: num(h.srcPt),
          ensemble: num(h.ensemble),
          srcX: num(h.srcX),
          srcY: num(h.srcY),
          rcvX: num(h.rcvX),
          rcvY: num(h.rcvY),
          coordScalar: num(h.coordScalar),
        };
      }
      // Pass the SEG-Y binary-header trace-sorting code so the geometry check can
      // recognise post-stack / CMP-stacked data (source/receiver collapsed to CDP
      // midpoints) and warn instead of false-flagging it.
      const result = checkGeometry(traces, currentSPS, { tolM: req.tolM ?? 2, traceSorting: current.bh?.traceSorting });
      port.postMessage({ id, ok: true, result });
      return;
    }

    // -- Load geometry into SEG-Y (the WRITE counterpart of spsGeomCheck) --
    //
    // Stamp the loaded SPS survey's source/receiver coordinates (+ elevation,
    // offset, CDP, scalars) into the open SEG-Y's trace headers and return a new,
    // geometry-loaded SEG-Y. Needs BOTH a SEG-Y (`current`, format 'SEG-Y' - not a
    // SEG-D/SEG-2/SU re-encode and not a streamed giant) AND a survey (`currentSPS`).
    // The patch is byte-faithful, so loadGeometry needs the ORIGINAL bytes: main
    // injects `req.path` (the open file's path), the worker re-reads it here (the
    // convertPath pattern) into a LOCAL buffer - `current` is never replaced.
    if (type === 'spsGeomLoad') {
      if (!current) {
        port.postMessage({ id, ok: false, error: 'load a SEG-Y file first' });
        return;
      }
      if ((current.format || '') !== 'SEG-Y') {
        port.postMessage({ id, ok: false, error: `geometry load writes SEG-Y trace headers - the open file is ${current.format || 'not a SEG-Y'}` });
        return;
      }
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'load an SPS first' });
        return;
      }
      if (typeof req.path !== 'string' || !req.path) {
        port.postMessage({ id, ok: false, error: 'the open file path is unavailable - reopen the SEG-Y, then load geometry' });
        return;
      }
      // Bound memory before the re-read: a SEG-Y opened in-memory is ≤ the in-memory
      // cap, but stat + refuse anything larger so a path swap can't OOM the worker.
      let size: number;
      try { size = statSync(req.path).size; }
      catch (e) { port.postMessage({ id, ok: false, error: 'Could not read the open file: ' + (e as Error).message }); return; }
      if (size > IN_MEMORY_MAX) {
        port.postMessage({ id, ok: false, error: 'File too large to load geometry into in memory - convert or split it first.' });
        return;
      }
      // readFileSync returns a Buffer; loadGeometry makes its own working copy
      // internally, so passing it straight (no fresh-Uint8Array copy) is read-safe.
      let bytes: Uint8Array;
      try { bytes = readFileSync(req.path); }
      catch (e) { port.postMessage({ id, ok: false, error: 'Could not read the open file: ' + (e as Error).message }); return; }
      const loaded: GeomLoadResult = loadGeometry(bytes, currentSPS, {
        tolM: req.tolM ?? 2,
        coordScalar: req.coordScalar,
        writeCoords: req.writeCoords,
        writeElev: req.writeElev,
        writeOffset: req.writeOffset,
        writeCdp: req.writeCdp,
      });
      const ab = transferBuffer(loaded.bytes);
      const summary = {
        traceCount: loaded.traceCount,
        matched: loaded.matched,
        srcMatched: loaded.srcMatched,
        rcvMatched: loaded.rcvMatched,
        unmatched: loaded.unmatched,
        srcStations: loaded.srcStations,
        rcvStations: loaded.rcvStations,
        coordScalar: loaded.coordScalar,
        fieldsWritten: loaded.fieldsWritten,
        errors: loaded.errors,
      };
      port.postMessage({ id, ok: true, bytes: ab, summary }, [ab]);
      return;
    }

    // -- As-laid vs Pre-plot delta ("skid report") --
    //
    // Diff the LOADED survey (`currentSPS`, the AS-LAID positions) against a
    // SEPARATELY-chosen REFERENCE (pre-plot / planned) SPS, station by station,
    // via the pure, bounded compareSPS. The reference files arrive as already-read
    // text (main read the user-picked files, mirroring how it hands openSPS its
    // paths). They are parsed into their OWN `referenceSPS` and are NEVER merged
    // into currentSPS: mergeSPSData's rounded-E/N dedup would collapse the very
    // plan↔actual pairs we want to diff, and we must not mutate the loaded survey.
    // Each reference file is routed through the same positioning dispatch openSPS
    // uses (detect → parsePositioning); point formats are merged into ONE
    // referenceSPS (internal dedup of the reference alone is fine), while a P6/11
    // bin grid carries no S/R stations to diff and is skipped.
    if (type === 'spsDelta') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'load the survey (SPS) first' });
        return;
      }
      const refFiles = Array.isArray(req.referenceFiles) ? req.referenceFiles : [];
      let referenceSPS: SPSData | null = null;
      for (const f of refFiles) {
        if (!f || typeof f.text !== 'string') continue;
        const name = typeof f.name === 'string' ? f.name : '';
        const fmt = detectPositioningFormat(name, f.text);
        if (fmt === 'p611') continue; // a bin grid carries no S/R stations to diff
        const parsed = parsePositioning(fmt, f.text);
        if (parsed.kind === 'bingrid') continue; // defensive: detect missed it
        referenceSPS = referenceSPS ? mergeSPSData(referenceSPS, parsed.data) : parsed.data;
      }
      if (!referenceSPS) {
        port.postMessage({ id, ok: false, error: 'No source/receiver stations found in the reference SPS.' });
        return;
      }
      const result: SPSDeltaResult = compareSPS(currentSPS, referenceSPS, { tolM: req.tolM ?? 1 });
      const names = refFiles.map((f) => (f && typeof f.name === 'string' ? f.name : '')).filter(Boolean);
      const refName = names.length === 0 ? '' : names.length === 1 ? names[0] : `${names[0]} (+${names.length - 1} more)`;
      port.postMessage({ id, ok: true, result, refName });
      return;
    }

    if (type === 'spsPointDetail') {
      if (!currentSPS) {
        port.postMessage({ id, ok: true, detail: null });
        return;
      }
      const rtype = req.rtype;
      const lineName = (req.lineName ?? '').trim();
      const point = req.point;
      const arr = rtype === 'S' ? currentSPS.sources : rtype === 'R' ? currentSPS.receivers : [];
      const match = arr.find(
        (p) => (p.lineName || '').trim() === lineName && p.point === point && (req.idx == null || (p.idx || '') === req.idx),
      );
      if (!match) {
        port.postMessage({ id, ok: true, detail: null });
        return;
      }
      // Return only the defined fields (source vs receiver carry different extras).
      const d: Record<string, unknown> = {
        rtype: match.rtype,
        lineName: match.lineName,
        point: match.point,
        idx: match.idx,
        easting: match.easting,
        northing: match.northing,
        elevation: match.elevation,
        raw: match.raw,
      };
      if (match.upholeMs !== undefined) d.upholeMs = match.upholeMs;
      if (match.srcType !== undefined) d.srcType = match.srcType;
      if (match.date !== undefined) d.date = match.date;
      if (match.time !== undefined) d.time = match.time;
      if (match.ffid !== undefined) d.ffid = match.ffid;
      if (match.staticMs !== undefined) d.staticMs = match.staticMs;
      port.postMessage({ id, ok: true, detail: d });
      return;
    }

    // Observer Log v2 SPS-linking: flatten currentSPS.sources to the lean record
    // the renderer binds log columns to (sps-role columns pull one srcField each).
    // Returns [] when no survey is loaded so the renderer can clear/disable the
    // link without special-casing the no-SPS state. upholeMs/staticMs/srcType are
    // optional on SPSPoint → coerced to null when absent (the contract type).
    if (type === 'spsSourceList') {
      const sources = (currentSPS?.sources ?? []).map((s) => ({
        lineName: s.lineName,
        point: s.point,
        idx: s.idx,
        easting: s.easting,
        northing: s.northing,
        elevation: s.elevation,
        upholeMs: s.upholeMs ?? null,
        staticMs: s.staticMs ?? null,
        srcType: s.srcType ?? null,
      }));
      port.postMessage({ id, ok: true, sources });
      return;
    }

    if (type === 'spsReproject') {
      if (!currentSPS || !currentSPS.projection) {
        port.postMessage({ id, ok: false, error: 'no SPS / source projection' });
        return;
      }
      // Resolved by main.ts against the full EPSG registry (and already refused
      // there if unsupported); the built-in table is only a fallback for callers
      // that still pass a bare code.
      const tgt = req.targetCrs ?? EPSG_DB.find((c) => c.code === req.code);
      if (!tgt) {
        port.postMessage({ id, ok: false, error: `unknown CRS: ${req.code}` });
        return;
      }
      const tag = tgt.code.replace(':', '');
      const files = currentSPSFiles.map((f) => ({
        name: f.name.replace(/(\.[^.]+)?$/, `_${tag}$1`),
        text: reprojectSPS(f.text.split('\n'), tgt, f.type === 'X' ? 'X' : f.type === 'R' ? 'R' : 'S', currentSPS!.projection!),
      }));
      port.postMessage({ id, ok: true, files });
      return;
    }

    // SPS SURVEY GENERATOR: build a fresh survey from map picks. The renderer
    // sends a CRS spec + one polyline per acquisition line as WGS84 lat/lon picks
    // (plus the CreateParams scalars). We resolve the CRS, FORWARD-project every
    // pick to the target E/N (the inverse of projToLatLon), run the pure
    // generateSPS, install the result as the loaded survey + synthesize the S/R/X
    // files via buildSPS, and return the same summary shape openSPS does.
    if (type === 'spsCreate') {
      const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);
      const numOr = (v: unknown, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d);
      if (!req.crs || typeof req.crs !== 'object') {
        port.postMessage({ id, ok: false, error: 'spsCreate: missing CRS' });
        return;
      }
      // Bound the geometry BEFORE projecting/allocating (generateSPS bounds the
      // GENERATED point count separately). Reject a malformed/oversized pick set.
      const picks = Array.isArray(req.picks) ? req.picks : [];
      const preplots = Array.isArray(req.preplots) ? req.preplots : [];
      const MAX_LINES = 100_000;
      const MAX_VERTS = 5_000_000; // total pick vertices across all lines
      // A plan may be all re-sampled lines (the historical case), all preplot lines
      // (an import used as-is), or a mix. Only an empty plan is an error.
      if (picks.length === 0 && preplots.length === 0) {
        port.postMessage({ id, ok: false, error: 'spsCreate: at least one survey line (with ≥2 picks) is required' });
        return;
      }
      if (picks.length + preplots.length > MAX_LINES) {
        port.postMessage({ id, ok: false, error: `spsCreate: ${picks.length + preplots.length} lines exceeds the cap of ${MAX_LINES}` });
        return;
      }
      let crs: CRS;
      try { crs = crsFromSpec(req.crs); }
      catch (e) { port.postMessage({ id, ok: false, error: `spsCreate: bad CRS - ${(e as Error).message}` }); return; }

      // Forward-project every pick (WGS84 lat/lon → target E/N). Validate each
      // vertex is finite + in geographic range; a bad pick set → clean error.
      const lines: SurveyLine[] = [];
      let totalVerts = 0;
      for (let li = 0; li < picks.length; li++) {
        const ln = picks[li];
        const verts = ln && Array.isArray(ln.vertices) ? ln.vertices : null;
        if (!verts || verts.length < 2) {
          port.postMessage({ id, ok: false, error: `spsCreate: line ${li} needs ≥2 picks` });
          return;
        }
        totalVerts += verts.length;
        if (totalVerts > MAX_VERTS) {
          port.postMessage({ id, ok: false, error: `spsCreate: too many picks (> ${MAX_VERTS})` });
          return;
        }
        const projected: { e: number; n: number }[] = [];
        for (const v of verts) {
          const lat = num(v?.lat), lon = num(v?.lon);
          if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            port.postMessage({ id, ok: false, error: `spsCreate: line ${li} has an out-of-range pick (lat/lon)` });
            return;
          }
          const en = lonLatToProj(lat, lon, crs);
          if (!isFinite(en.E) || !isFinite(en.N)) {
            port.postMessage({ id, ok: false, error: `spsCreate: line ${li} pick failed to project (check the CRS)` });
            return;
          }
          projected.push({ e: en.E, n: en.N });
        }
        lines.push({ vertices: projected });
      }

      const params: CreateParams = {
        mode: req.mode === '3D' ? '3D' : '2D',
        lines,
        rcvInterval: numOr(req.rcvInterval, CREATE_DEFAULTS.rcvInterval),
        srcInterval: numOr(req.srcInterval, CREATE_DEFAULTS.srcInterval),
        rcvLineStart: numOr(req.rcvLineStart, CREATE_DEFAULTS.rcvLineStart),
        rcvLineInc: numOr(req.rcvLineInc, CREATE_DEFAULTS.rcvLineInc),
        rcvPointStart: numOr(req.rcvPointStart, CREATE_DEFAULTS.rcvPointStart),
        rcvPointInc: numOr(req.rcvPointInc, CREATE_DEFAULTS.rcvPointInc),
        srcLineStart: numOr(req.srcLineStart, CREATE_DEFAULTS.srcLineStart),
        srcLineInc: numOr(req.srcLineInc, CREATE_DEFAULTS.srcLineInc),
        srcPointStart: numOr(req.srcPointStart, CREATE_DEFAULTS.srcPointStart),
        srcPointInc: numOr(req.srcPointInc, CREATE_DEFAULTS.srcPointInc),
        srcLineSpacing: numOr(req.srcLineSpacing, CREATE_DEFAULTS.srcLineSpacing),
        azimuthDeg: typeof req.azimuthDeg === 'number' && isFinite(req.azimuthDeg) ? req.azimuthDeg : undefined,
        relation: req.relation && (req.relation.type === 'full' || req.relation.type === 'split') ? req.relation : CREATE_DEFAULTS.relation,
        srcType: typeof req.srcType === 'string' ? req.srcType : undefined,
        rcvType: typeof req.rcvType === 'string' ? req.rcvType : undefined,
      };

      // generateSPS validates the scalars (intervals > 0, finite numbering, point
      // count cap) and throws on mode:'3D' - both caught by the outer try/catch.
      const proj = crsToSPSProjection(crs);
      const data: SPSData = lines.length
        ? generateSPS(params, proj)
        : { sources: [], receivers: [], xrefs: [], headers: [], errors: [], skipped: 0, layout: 'SPS2.1', projection: proj };

      // PREPLOT lines: stations placed verbatim. A station keeps its ORIGINAL E/N
      // when the importer said those coordinates are already in this CRS; otherwise
      // its lat/long is forward-projected like any pick. ffids continue after the
      // generated ones so a mixed survey never repeats a shot id.
      if (preplots.length) {
        const preLines: PreplotLine[] = [];
        let totalStations = 0;
        for (let li = 0; li < preplots.length; li++) {
          const ln = preplots[li];
          const sts = ln && Array.isArray(ln.stations) ? ln.stations : null;
          const name = ln && typeof ln.lineName === 'string' ? ln.lineName.trim() : '';
          if (!name) {
            port.postMessage({ id, ok: false, error: `spsCreate: preplot line ${li} has no name` });
            return;
          }
          if (!sts || sts.length === 0) {
            port.postMessage({ id, ok: false, error: `spsCreate: preplot line ${name} has no stations` });
            return;
          }
          totalStations += sts.length;
          if (totalStations > MAX_VERTS) {
            port.postMessage({ id, ok: false, error: `spsCreate: too many preplot stations (> ${MAX_VERTS})` });
            return;
          }
          const stations: PreplotStation[] = [];
          for (const s of sts) {
            const e = num(s?.e), n = num(s?.n);
            let pos: { e: number; n: number };
            if (isFinite(e) && isFinite(n)) {
              pos = { e, n }; // already in the target CRS - use the exact numbers
            } else {
              const lat = num(s?.lat), lon = num(s?.lon);
              if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
                port.postMessage({ id, ok: false, error: `spsCreate: preplot line ${name} has an out-of-range station (lat/lon)` });
                return;
              }
              const en = lonLatToProj(lat, lon, crs);
              if (!isFinite(en.E) || !isFinite(en.N)) {
                port.postMessage({ id, ok: false, error: `spsCreate: preplot line ${name} failed to project (check the CRS)` });
                return;
              }
              pos = { e: en.E, n: en.N };
            }
            const pt = num(s?.point);
            if (!isFinite(pt)) {
              port.postMessage({ id, ok: false, error: `spsCreate: preplot line ${name} has a station with no number` });
              return;
            }
            stations.push({ e: pos.e, n: pos.n, point: Math.round(pt), elev: isFinite(num(s?.elev)) ? num(s?.elev) : 0 });
          }
          const role = ln.role === 'S' || ln.role === 'SR' ? ln.role : 'R';
          preLines.push({ lineName: name, role, stations });
        }
        // generatePreplotSPS validates + bounds; a throw becomes {ok:false,error}.
        const pre = generatePreplotSPS({
          lines: preLines,
          relation: params.relation.type === 'split'
            ? { type: 'split', channels: params.relation.channels }
            : { type: 'full' },
          srcType: params.srcType,
          rcvType: params.rcvType,
          ffidStart: data.xrefs.length + 1,
        }, proj);
        data.sources.push(...pre.sources);
        data.receivers.push(...pre.receivers);
        data.xrefs.push(...pre.xrefs);
      }

      const base = (typeof req.baseName === 'string' && req.baseName.trim()) ? req.baseName.trim() : 'survey';
      const built = buildSPS(data, { baseName: base, emitHeaders: true, dateWritten: typeof req.dateWritten === 'string' ? req.dateWritten : undefined });
      currentSPS = data;
      currentSPSFiles = built.map((f) => ({ name: f.name, text: f.text, type: detectSPSType(f.name, f.text) }));
      // A generated survey carries no P6/11 grid of its own - drop any stale one.
      currentBinGrid = null;
      currentBinGridSig = null;
      // Ship a matching .prj so the generated survey opens in a GIS already
      // georeferenced. It rides in the SAVED set only - currentSPSFiles stays the
      // S/R/X triplet, because that is what re-parses back into the survey.
      const outFiles = built.slice();
      const prj = buildPositioningPrj(data, built[0]?.name ?? base);
      if (prj) outFiles.push(prj);
      port.postMessage({ id, ok: true, summary: spsSummary(data, ['sps'], null), files: outFiles });
      return;
    }

    // SPS RENUMBER: re-map source/receiver line + point identifiers across the
    // loaded survey, keeping every X-ref range internally consistent. Resolve the
    // spec to maps, column-splice each loaded file's raw text (preserves vendor
    // columns beyond the modeled fields), then re-parse + merge to refresh
    // currentSPS. Returns the refreshed summary + the renumbered files (suffixed
    // names) for main.ts to ZIP + save.
    if (type === 'spsRenumber') {
      if (!currentSPS || !currentSPSFiles.length) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const spec = req.spec;
      if (!spec || typeof spec !== 'object' || (!spec.source && !spec.receiver)) {
        port.postMessage({ id, ok: false, error: 'spsRenumber: a source and/or receiver renumber spec is required' });
        return;
      }
      // buildRenumberMaps throws on a non-monotonic / non-finite transform (so X
      // from..to ranges can't invert) - caught by the outer handler as {ok:false}.
      const maps = buildRenumberMaps(currentSPS, spec);
      const base = (typeof req.baseName === 'string' && req.baseName.trim()) ? req.baseName.trim() : '';
      const extOf = (name: string): string => { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i) : ''; };
      const renName = (name: string): string => base ? `${base}_renum${extOf(name)}` : name.replace(/(\.[^.]+)?$/, '_renum$1');
      // Rewrite each loaded file's text in place (the loaded survey BECOMES the
      // renumbered one); the returned download copies carry the suffixed names.
      const out: { name: string; text: string }[] = [];
      for (const f of currentSPSFiles) {
        const spsType: 'S' | 'R' | 'X' = f.type === 'X' ? 'X' : f.type === 'R' ? 'R' : 'S';
        f.text = renumberSPSText(f.text.split('\n'), spsType, maps);
        out.push({ name: renName(f.name), text: f.text });
      }
      currentSPS = reparseMergeAll(currentSPSFiles);
      port.postMessage({ id, ok: true, summary: spsSummary(currentSPS, ['sps'], null), files: out });
      return;
    }

    // SPS HEADER VIEWER: return the shared H block as {code,val,raw,desc}, the
    // parsed projection, the loaded file list, and whether the files' H blocks
    // actually differ. Built from currentSPS (the merged survey) + currentSPSFiles.
    if (type === 'spsHeaderList') {
      const headers = headerListFromSPS(currentSPS);
      const proj = currentSPS?.projection ?? null;
      const projection = proj
        ? {
            type: proj.type, subtype: proj.subtype, zone: proj.zone, hemi: proj.hemi,
            datum: proj.datum, ellipsoid: proj.ellipsoid, units: proj.units,
            centralMeridian: proj.centralMeridian, latOrigin: proj.latOrigin,
            falseEasting: proj.falseEasting, falseNorthing: proj.falseNorthing,
            scaleFactor: proj.scaleFactor, desc: proj.desc,
          }
        : null;
      const files = currentSPSFiles.map((f) => ({ name: f.name, type: f.type }));
      const filesDiffer = spsFilesDiffer(currentSPSFiles);
      port.postMessage({ id, ok: true, headers, projection, files, filesDiffer });
      return;
    }

    // SPS HEADER EDITOR: apply an edit/add/remove batch (+ optional CRS rewrite)
    // to the H block of every targeted file (scope 'shared' = all loaded SPS
    // files, else the named file), rewrite currentSPSFiles raw text in place,
    // re-parse + re-merge, and return the refreshed header list. NEVER touches
    // S/R coordinate lines - the CRS rewrite is HEADER-ONLY.
    if (type === 'spsApplyHeaders') {
      if (!currentSPSFiles.length) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const scope = req.scope ?? 'shared';
      // Bound the batch so a malformed/oversized IPC payload can't fan out into a
      // huge text rewrite (one 80-char line per add, × every targeted file). A
      // real header block has a few dozen records; cap generously.
      const MAX_HDR_OPS = 1000;
      const MAX_HDR_VAL = 4096; // per-value char cap (the line itself is clamped to 80)
      const clampVal = (v: string) => (typeof v === 'string' ? v.slice(0, MAX_HDR_VAL) : '');
      const edits = (req.edits ?? []).slice(0, MAX_HDR_OPS).map((e) => ({ code: e.code, val: clampVal(e.val), oldVal: e.oldVal }));
      const adds = (req.adds ?? []).slice(0, MAX_HDR_OPS).map((a) => ({ code: a.code, desc: a.desc, val: clampVal(a.val) }));
      const removes = (req.removes ?? []).slice(0, MAX_HDR_OPS);
      let crsLines: Record<string, string> | null = null;
      if (req.crs) {
        try { crsLines = generateProjHeaders(crsFromSpec(req.crs)); }
        catch (e) { port.postMessage({ id, ok: false, error: `CRS rewrite failed: ${(e as Error).message}` }); return; }
      }

      const targets = scope === 'shared' ? currentSPSFiles : currentSPSFiles.filter((f) => f.name === scope);
      if (scope !== 'shared' && !targets.length) {
        port.postMessage({ id, ok: false, error: `no loaded SPS file named '${scope}'` });
        return;
      }
      for (const f of targets) {
        f.text = applyHeaderEditsToText(f.text, edits, adds, removes, crsLines);
      }

      currentSPS = reparseMergeAll(currentSPSFiles);
      port.postMessage({ id, ok: true, headers: headerListFromSPS(currentSPS) });
      return;
    }

    // SPS HEADER EDITOR - save: hand the edited currentSPSFiles raw text back so
    // main.ts can ZIP + Save them (same flow as spsReproject). One {name,text}
    // per loaded file, names kept as-is.
    if (type === 'spsSaveCorrected') {
      if (!currentSPSFiles.length) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const files = currentSPSFiles.map((f) => ({ name: f.name, text: f.text }));
      port.postMessage({ id, ok: true, files });
      return;
    }

    // SPS geographic / tabular EXPORTS: turn the loaded survey into CSV / GeoJSON /
    // KML / a QC-report CSV. Single source of truth for coordinates is the SAME
    // projToLatLon used by spsGeometry - KML/GeoJSON go to WGS84 lon/lat when a
    // projected CRS is present in the SPS header, otherwise raw projected E/N.
    if (type === 'spsExport') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      const out = buildSPSExport(currentSPS, req.kind ?? 'csv', req.qcParams ?? {});
      port.postMessage({ id, ok: out.ok, files: out.files, error: out.error });
      return;
    }

    // SPS -> ESRI Shapefile. Unlike every other SPS export this one is BINARY, so
    // it returns {name, bytes} and transfers the buffers rather than {name, text}.
    // `code` selects a reprojection target from the EPSG DB; omitted (or blank)
    // means write the survey's own native coordinates, which involves no
    // coordinate arithmetic at all.
    if (type === 'spsShapefile') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      // main.ts resolves the code against the full EPSG registry and refuses
      // unsupported CRSs, so by here we either have a usable CRS or none (which
      // means "write the survey's native coordinates").
      const target: CRS | null = req.targetCrs ?? null;
      try {
        const res = buildSPSShapefiles(currentSPS, { baseName: req.baseName, target, dateYMD: req.dateYMD });
        const files = res.files.map((f) => ({ name: f.name, bytes: f.bytes }));
        port.postMessage({ id, ok: true, files, notes: res.notes }, files.map((f) => f.bytes.buffer as ArrayBuffer));
      } catch (e) {
        port.postMessage({ id, ok: false, error: (e as Error).message || 'shapefile export failed' });
      }
      return;
    }

    // SPS -> GeoTIFF rasters (fold / elevation / layout). Binary, like the
    // shapefile export: returns {name, bytes} and transfers the buffers.
    if (type === 'spsRaster') {
      if (!currentSPS) {
        port.postMessage({ id, ok: false, error: 'no SPS loaded' });
        return;
      }
      // An EMPTY layer list is legitimate: a basemap-only export still needs the
      // grid and the resolved CRS computed here, and main.ts builds the imagery
      // on top of them.
      if ((!req.bounds && !req.whole) || !req.pixelSize) {
        port.postMessage({ id, ok: false, error: 'raster export needs an area, a resolution and at least one layer' });
        return;
      }
      try {
        const res = buildSPSRasters(currentSPS, {
          bounds: req.bounds ?? null,
          whole: !!req.whole,
          marginM: req.marginM,
          pixelSize: req.pixelSize,
          layers: req.layers ?? [],
          target: req.targetCrs ?? null,
          demRadius: req.demRadius,
          baseName: req.baseName,
          // Let the raster builder name the survey's CRS by EPSG code when the
          // SPS header only gave parameters (see the note on identifyEpsg).
          identifyEpsg: (c) => {
            const hit = findEpsgByParams(c);
            const m = hit ? /^EPSG:(\d+)$/i.exec(hit.crs.code) : null;
            return m ? parseInt(m[1], 10) : undefined;
          },
        });
        const files = res.files.map((f) => ({ name: f.name, bytes: f.bytes }));
        port.postMessage({ id, ok: true, files, notes: res.notes, grid: res.grid, outCrs: res.outCrs, epsg: res.epsg }, files.map((f) => f.bytes.buffer as ArrayBuffer));
      } catch (e) {
        port.postMessage({ id, ok: false, error: (e as Error).message || 'raster export failed' });
      }
      return;
    }

    // Trace Workbench: parse a file LOCALLY (never touching `current`) and pull
    // ONE trace out of it. Mirrors convertPath's local-parse pattern so the
    // workbench can collect traces from arbitrary files without disturbing - or
    // requiring - the persistently-open file. Placed above the `!current` guard
    // because it needs no open file of its own.
    if (type === 'extractTrace') {
      if (typeof req.path !== 'string' || !req.path) { port.postMessage({ id, ok: false, error: 'extractTrace: missing or invalid path' }); return; }
      const want = (req.index ?? 0) | 0;
      // If the workbench points at the file already open as a STREAM, serve the
      // trace straight from the live index instead of re-reading the multi-GB file.
      if (currentStream && req.path === currentStream.path) {
        const s = currentStream;
        const i = Math.max(0, Math.min(s.traceCount - 1, want));
        const tr = readStreamedTrace(s.fd, traceMeta(s, i), s.offsets[i], streamNs(s, i), true);
        const samples = tr?.samples ?? new Float32Array(0);
        port.postMessage(
          { id, ok: true, name: s.name, index: i, traceCount: s.traceCount, nSamples: tr?.nSamples ?? streamNs(s, i), sampleInt: s.meta.sampleInt ?? 0, hdr: tr?.hdr ?? {}, samples },
          [samples.buffer as ArrayBuffer],
        );
        return;
      }
      // A large local SEG-Y that isn't the open file: index it (header-only, but an
      // O(file) sequential scan), read the one trace, close the fd - never readFileSync
      // a giant. The index is CACHED by path+mtime, so picking many traces from the
      // same file rebuilds it only once.
      let fsz = -1;
      let fmtime = 0;
      try { const st = statSync(req.path); fsz = st.size; fmtime = st.mtimeMs; } catch { /* fall through to the in-memory parse, which surfaces the read error */ }
      if (fsz > STREAM_THRESHOLD) {
        if (fsz > MAX_STREAM_BYTES) { port.postMessage({ id, ok: false, error: `File too large to extract from (${(fsz / 1e9).toFixed(2)} GB).` }); return; }
        // Reuse the cached offset index when it's the same file (path + mtime); else
        // build it once via openStreamIndex and cache it. The fd is reopened per pick.
        let cache = extractIndexCache;
        if (!cache || cache.path !== req.path || cache.mtimeMs !== fmtime) {
          const opened = openStreamIndex(req.path, fsz);
          if (opened.ok) {
            cache = { path: req.path, mtimeMs: fmtime, meta: opened.meta, offsets: opened.offsets, nsArr: opened.nsArr, recMetas: opened.recMetas, recOf: opened.recOf, traceCount: opened.traceCount };
            extractIndexCache = cache;
            closeSync(opened.fd); // keep only the index; reopen the fd per pick below
          } else {
            if (!opened.notSegy) { port.postMessage({ id, ok: false, error: opened.error }); return; }
            // Not a streamable SEG-Y: load whole only within the in-memory cap; above
            // it, refuse rather than readFileSync a giant. (Mirrors the open handler.)
            if (fsz > IN_MEMORY_MAX) { port.postMessage({ id, ok: false, error: 'File too large to extract from (not a streamable SEG-Y).' }); return; }
            cache = null; // else fall through to the in-memory parse below.
          }
        }
        if (cache) {
          let efd: number;
          try { efd = openSync(req.path, 'r'); }
          catch (e) { port.postMessage({ id, ok: false, error: 'Could not open file: ' + (e as Error).message }); return; }
          try {
            const i = Math.max(0, Math.min(cache.traceCount - 1, want));
            // Per-record meta for a heterogeneous tape, else the single shared meta.
            const meta_i = cache.recMetas && cache.recOf ? cache.recMetas[cache.recOf[i]] : cache.meta;
            const ns = cache.nsArr ? cache.nsArr[i] : meta_i.defaultNs;
            const tr = readStreamedTrace(efd, meta_i, cache.offsets[i], ns, true);
            const samples = tr?.samples ?? new Float32Array(0);
            port.postMessage(
              { id, ok: true, name: basename(req.path), index: i, traceCount: cache.traceCount, nSamples: tr?.nSamples ?? ns, sampleInt: meta_i.sampleInt ?? 0, hdr: tr?.hdr ?? {}, samples },
              [samples.buffer as ArrayBuffer],
            );
          } finally { closeSync(efd); }
          return;
        }
      }
      const local = parseInMemory(readFileSync(req.path), basename(req.path));
      const i = Math.max(0, Math.min(local.traceCount - 1, (req.index ?? 0) | 0));
      const tr = local.traces[i];
      const samples = tr?.samples ? tr.samples.slice() : new Float32Array(0);
      port.postMessage(
        {
          id,
          ok: true,
          name: basename(req.path!),
          index: i,
          traceCount: local.traceCount,
          nSamples: tr?.nSamples ?? 0,
          sampleInt: local.bh.sampleInt ?? 0,
          hdr: tr?.hdr ?? {},
          samples,
        },
        [samples.buffer],
      );
      return;
    }

    // Trace Workbench EXPORT: assemble a synthetic ParsedFile from the collected
    // traces and run it through the chosen writer - same SAVE flow as `convert`,
    // but the data comes from the request, not the persistently-open file. No
    // open file is required, so it sits above the `!current` guard. The writers
    // size the record from the LONGEST trace and clamp, so mixed-length traces
    // are safe; the sample interval defaults inside the writers (→ 2000 µs) when
    // the collection carried none.
    if (type === 'convertTraces') {
      const writer = getWriter(req.format!);
      if (!writer) {
        port.postMessage({ id, ok: false, error: `unknown output format: ${req.format}` });
        return;
      }
      const inTraces = req.traces ?? [];
      // Bound the synthetic file before the writer allocates its output buffer.
      // trc.length is renderer-supplied and otherwise uncapped, so a driven
      // renderer could force a multi-GB allocation in writeSU/writeSEGY. Reject
      // collections past a sane trace count or total-sample budget instead.
      const MAX_EXPORT_TRACES = 200_000;
      const MAX_EXPORT_SAMPLES = 200_000_000; // ~800 MB of f32 samples
      let totalSamples = 0;
      for (const t of inTraces) totalSamples += Math.max(0, (t.nSamples | 0));
      if (inTraces.length > MAX_EXPORT_TRACES || totalSamples > MAX_EXPORT_SAMPLES) {
        port.postMessage({ id, ok: false, error: `export collection too large (${inTraces.length} traces, ${totalSamples} samples)` });
        return;
      }
      const pf: ParsedFile = {
        format: 'SEG-Y',
        revision: 1,
        textHeader: '',
        bh: { sampleInt: req.sampleInt },
        traces: inTraces.map((t) => ({ hdr: t.hdr ?? {}, samples: t.samples, nSamples: t.nSamples })),
        traceCount: inTraces.length,
        errors: [],
      };
      const out = writer.write(pf);
      const ab = transferBuffer(out);
      port.postMessage({ id, ok: true, bytes: ab, ext: writer.ext }, [ab]);
      return;
    }

    // -- Streamed (very large SEG-Y) VIEW path --
    //
    // When a file is loaded as a stream, `current` is null, so the in-memory
    // handlers below are unreachable; serve the view requests on demand from the
    // offset index instead, returning the SAME payload shapes. Handlers that need
    // EVERY trace in memory (convert / spectra / f-k / semblance) are GATED with a
    // clean message - never silently load the whole file. (extractTrace is handled
    // above, against an arbitrary path.)
    if (currentStream) {
      const s = currentStream;

      if (type === 'trace') {
        const i = Math.max(0, Math.min(s.traceCount - 1, (req.index ?? 0) | 0));
        const tr = readStreamedTrace(s.fd, traceMeta(s, i), s.offsets[i], streamNs(s, i), true);
        const samples = tr?.samples ?? new Float32Array(0);
        port.postMessage(
          { id, ok: true, index: i, nSamples: tr?.nSamples ?? streamNs(s, i), sampleInt: s.meta.sampleInt ?? 0, hdr: tr?.hdr ?? {}, samples },
          [samples.buffer as ArrayBuffer],
        );
        return;
      }

      if (type === 'section') {
        const maxTraces = req.maxTraces ?? 1500;
        const maxSamples = req.maxSamples ?? 1500;
        const si = s.meta.sampleInt || 2000;
        const tc = s.traceCount;
        const fullSamps = s.repNs || s.meta.defaultNs || 0;

        // Visible sub-window (full-data indices, end exclusive); clamp + order -
        // identical to the in-memory section so the renderer behaves the same.
        let t0 = Math.max(0, Math.min(tc, (req.traceStart ?? 0) | 0));
        let t1 = Math.max(0, Math.min(tc, (req.traceEnd ?? tc) | 0));
        if (t1 <= t0) { t0 = 0; t1 = tc; }
        let s0 = Math.max(0, Math.min(fullSamps, (req.sampStart ?? 0) | 0));
        let s1 = Math.max(0, Math.min(fullSamps, (req.sampEnd ?? fullSamps) | 0));
        if (s1 <= s0) { s0 = 0; s1 = fullSamps || 0; }
        const sampZoom = s0 > 0 || s1 < fullSamps;
        const winTraces = t1 - t0;
        const traceStep = Math.max(1, Math.ceil(winTraces / maxTraces));

        // Decimated columns: read ONLY the traces we actually plot (≤ maxTraces),
        // on demand - never the whole file. Mirrors the in-memory normalize/AGC.
        const columns: Float32Array[] = [];
        let norm = 0;
        for (let t = t0; t < t1; t += traceStep) {
          const tr = readStreamedTrace(s.fd, traceMeta(s, t), s.offsets[t], streamNs(s, t), true);
          let samp = tr?.samples;
          if (!samp) continue;
          if (req.agc) samp = applyAGC(samp, req.agcWindowMs ?? 200, si, req.agcType ?? 'rms');
          if (sampZoom) samp = samp.subarray(Math.min(s0, samp.length), Math.min(s1, samp.length));
          const nf = normFactorPercentile(samp, 0.95);
          if (nf > norm) norm = nf;
          columns.push(samp.length > maxSamples ? resampleLinear(samp, maxSamples) : samp);
        }
        if (norm <= 0) norm = 1;

        const numTraces = columns.length;
        let colLen = 0;
        for (let c = 0; c < numTraces; c++) if (columns[c].length > colLen) colLen = columns[c].length;
        const data = new Float32Array(numTraces * colLen);
        for (let c = 0; c < numTraces; c++) {
          const col = columns[c];
          const cbase = c * colLen;
          const n = Math.min(colLen, col.length);
          for (let k = 0; k < n; k++) data[cbase + k] = col[k];
        }
        port.postMessage(
          { id, ok: true, numTraces, colLen, norm, sampleInt: si, traceStep, data, traceStart: t0, traceEnd: t1, sampStart: s0, sampEnd: s1, fullTraces: tc, fullSamples: fullSamps, winSamps: s1 - s0 },
          [data.buffer],
        );
        return;
      }

      // Everything that consumes ALL traces at once isn't available for a streamed
      // file yet (would defeat the bounded-memory goal). Clean, explicit refusal.
      if (type === 'convert' || type === 'avgSpectrum' || type === 'fk' || type === 'spectrogram' || type === 'semblance' || type === 'traceHealth' || type === 'firstBreaks') {
        port.postMessage({ id, ok: false, error: 'Not available for very large streamed files yet - view/convert a smaller range.' });
        return;
      }
    }

    if (!current) {
      port.postMessage({ id, ok: false, error: 'no file open' });
      return;
    }

    if (type === 'trace') {
      const i = Math.max(0, Math.min(current.traceCount - 1, (req.index ?? 0) | 0));
      const tr = current.traces[i];
      const samples = tr?.samples ? tr.samples.slice() : new Float32Array(0);
      port.postMessage(
        {
          id,
          ok: true,
          index: i,
          nSamples: tr?.nSamples ?? 0,
          sampleInt: current.bh.sampleInt ?? 0,
          hdr: tr?.hdr ?? {},
          samples,
        },
        [samples.buffer],
      );
      return;
    }

    if (type === 'section') {
      const maxTraces = req.maxTraces ?? 1500;
      const maxSamples = req.maxSamples ?? 1500;
      const si = current.bh.sampleInt ?? 2000;
      const tc = current.traceCount;
      // Full sample count (most files share a trace length; fall back to trace 0).
      const fullSamps = current.bh.samplesTrace ?? current.traces[0]?.nSamples ?? 0;

      // Visible sub-window in full-data indices. Defaults to the whole record so
      // the very first (un-zoomed) request behaves exactly as before. End indices
      // are exclusive; clamp + order them so a bad request can never throw.
      let t0 = Math.max(0, Math.min(tc, (req.traceStart ?? 0) | 0));
      let t1 = Math.max(0, Math.min(tc, (req.traceEnd ?? tc) | 0));
      if (t1 <= t0) { t0 = 0; t1 = tc; }
      let s0 = Math.max(0, Math.min(fullSamps, (req.sampStart ?? 0) | 0));
      let s1 = Math.max(0, Math.min(fullSamps, (req.sampEnd ?? fullSamps) | 0));
      if (s1 <= s0) { s0 = 0; s1 = fullSamps || 0; }
      // True only when the request actually narrows the sample axis. Without this
      // flag, an un-zoomed request (s1 = fullSamps = bh.samplesTrace) would slice
      // - and so truncate - any variable-length trace whose nSamples exceeds
      // bh.samplesTrace, silently dropping its deep tail (a data-loss regression).
      const sampZoom = s0 > 0 || s1 < fullSamps;
      const winTraces = t1 - t0;
      const winSamps = s1 - s0;
      const traceStep = Math.max(1, Math.ceil(winTraces / maxTraces));

      // First pass: collect decimated columns + a global normalization factor.
      // AGC is computed on the FULL trace (its window is time-based), then the
      // visible sample range is sliced out, then time-preserving downsampled.
      const columns: Float32Array[] = [];
      let norm = 0;
      for (let t = t0; t < t1; t += traceStep) {
        const tr = current.traces[t];
        if (!tr?.samples) continue;
        let s = tr.samples;
        if (req.agc) s = applyAGC(s, req.agcWindowMs ?? 200, si, req.agcType ?? 'rms');
        // Slice to the visible sample window only when the user actually zoomed
        // the sample axis; otherwise keep the full trace (its tail beyond
        // bh.samplesTrace must survive an un-zoomed render).
        if (sampZoom) s = s.subarray(Math.min(s0, s.length), Math.min(s1, s.length));
        const nf = normFactorPercentile(s, 0.95);
        if (nf > norm) norm = nf;
        // Time-preserving downsample (clean vertical axis for VD; good enough for wiggle).
        columns.push(s.length > maxSamples ? resampleLinear(s, maxSamples) : s);
      }
      if (norm <= 0) norm = 1;

      const numTraces = columns.length;
      // Use the LONGEST column, not columns[0]: with variable-length traces the
      // first windowed trace may be short/dead (e.g. 400 samples) while later
      // ones are full - sizing to columns[0] would truncate every longer trace.
      let colLen = 0;
      for (let c = 0; c < numTraces; c++) if (columns[c].length > colLen) colLen = columns[c].length;
      // Flatten into one transferable matrix (numTraces × colLen), row = trace.
      const data = new Float32Array(numTraces * colLen);
      for (let c = 0; c < numTraces; c++) {
        const col = columns[c];
        const base = c * colLen;
        const n = Math.min(colLen, col.length);
        for (let k = 0; k < n; k++) data[base + k] = col[k];
      }
      // Echo the window + full extents so the renderer can label axes and clamp.
      port.postMessage(
        { id, ok: true, numTraces, colLen, norm, sampleInt: si, traceStep, data, traceStart: t0, traceEnd: t1, sampStart: s0, sampEnd: s1, fullTraces: tc, fullSamples: fullSamps, winSamps },
        [data.buffer],
      );
      return;
    }

    if (type === 'convert') {
      const writer = getWriter(req.format!);
      if (!writer) {
        port.postMessage({ id, ok: false, error: `unknown output format: ${req.format}` });
        return;
      }
      const out = writer.write(current);
      const ab = transferBuffer(out);
      port.postMessage({ id, ok: true, bytes: ab, ext: writer.ext }, [ab]);
      return;
    }

    if (type === 'semblance') {
      const gather = current.traces.filter((tr) => tr.samples).slice(0, 96);
      if (!gather.length) {
        port.postMessage({ id, ok: false, error: 'no traces with samples' });
        return;
      }
      const sr = computeSemblance(gather, current.bh.sampleInt ?? 2000, req.velMin ?? 1000, req.velMax ?? 5000, req.velStep ?? 50);
      port.postMessage({ id, ok: true, semb: sr.semb, vels: sr.vels, nT: sr.nT, dt: sr.dt, siUs: sr.siUs, offNote: sr.offNote }, [sr.semb.buffer as ArrayBuffer]);
      return;
    }

    // -- Spectrum Analysis tab --
    //
    // avgSpectrum + fk both consume the file's trace matrix; spectrogram pulls a
    // single trace. avgSpectrum + fk reuse the SAME stride-decimation the section
    // handler uses (cap the trace count, keep every Nth) but assemble UN-normalized
    // raw samples (true amplitudes matter for a spectrum). The trace caps below
    // mirror the section view's defaults so a huge survey can't blow the worker.

    if (type === 'avgSpectrum') {
      const si = current.bh.sampleInt ?? 2000;
      const tc = current.traceCount;
      // Averaging window (full-data indices, end exclusive); clamp + order.
      let t0 = Math.max(0, Math.min(tc, (req.traceStart ?? 0) | 0));
      let t1 = Math.max(0, Math.min(tc, (req.traceEnd ?? tc) | 0));
      if (t1 <= t0) { t0 = 0; t1 = tc; }
      // Decimate the trace COUNT if the window is huge (same idea as the section
      // handler's traceStep): keep at most MAX_TRACES, every Nth across the window.
      const MAX_TRACES = 4000;
      // Also cap each trace's sample length (like the fk handler) so averageSpectrum's
      // N = nextPow2(maxTraceLen) can't force a huge per-trace FFT from one over-long
      // trace; resample longer traces down to MAX_SAMPLES before averaging.
      const MAX_SAMPLES = 8192;
      const winTraces = t1 - t0;
      const stride = Math.max(1, Math.ceil(winTraces / MAX_TRACES));
      const traces: Float32Array[] = [];
      for (let t = t0; t < t1; t += stride) {
        const s = current.traces[t]?.samples;
        if (s) traces.push(s.length > MAX_SAMPLES ? resampleLinear(s, MAX_SAMPLES) : s);
      }
      if (!traces.length) {
        port.postMessage({ id, ok: false, error: 'no traces with samples' });
        return;
      }
      const r = averageSpectrum(traces, si, {});
      const decimated = stride > 1;
      const log = decimated
        ? `Average spectrum decimated: ${winTraces} traces > ${MAX_TRACES} cap; kept every ${stride}${stride === 2 ? 'nd' : stride === 3 ? 'rd' : 'th'} → ${r.nTraces} traces.`
        : `Average spectrum over ${r.nTraces} traces.`;
      port.postMessage(
        { id, ok: true, freqs: r.freqs, amp: r.amp, nyquist: r.nyquist, nTraces: r.nTraces, decimated, log },
        [r.freqs.buffer, r.amp.buffer] as ArrayBuffer[],
      );
      return;
    }

    if (type === 'spectrogram') {
      const si = current.bh.sampleInt ?? 2000;
      const i = Math.max(0, Math.min(current.traceCount - 1, (req.index ?? 0) | 0));
      const s = current.traces[i]?.samples;
      if (!s || s.length === 0) {
        port.postMessage({ id, ok: false, error: 'trace has no samples' });
        return;
      }
      // Cap the output grid (nFrames*nBins) so a long trace with a tiny hop can't
      // allocate a huge image; grow the hop just enough to fit the budget.
      const MAX_CELLS = 4_000_000;
      // Cap the window so nextPow2(winLen) can't force a multi-GB FFT buffer
      // (spectrogram allocates Float64Array(nextPow2(winLen)) for re AND im). A
      // window longer than the trace yields a single zero-padded frame anyway, so
      // clamp to the trace length and an absolute ceiling.
      const MAX_WIN = 65_536;
      let winLen = Math.max(2, Math.min(MAX_WIN, s.length, (req.winLen ?? 128) | 0));
      let hop = Math.max(1, (req.hop ?? (winLen >> 1)) | 0);
      const nBins = nextPow2(winLen) >> 1;
      const framesFor = (h: number) => (s.length >= winLen ? Math.floor((s.length - winLen) / h) + 1 : 1);
      if (framesFor(hop) * nBins > MAX_CELLS) {
        const maxFrames = Math.max(1, Math.floor(MAX_CELLS / nBins));
        hop = Math.max(hop, Math.ceil((s.length - winLen) / Math.max(1, maxFrames - 1)));
      }
      const r = spectrogram(s, si, { winLen, hop });
      port.postMessage(
        { id, ok: true, mag: r.mag, nFrames: r.nFrames, nBins: r.nBins, freqs: r.freqs, times: r.times, maxMag: r.maxMag, siUs: r.siUs },
        [r.mag.buffer, r.freqs.buffer, r.times.buffer] as ArrayBuffer[],
      );
      return;
    }

    if (type === 'fk') {
      const si = current.bh.sampleInt ?? 2000;
      const tc = current.traceCount;
      const fullSamps = current.bh.samplesTrace ?? current.traces[0]?.nSamples ?? 0;
      // Decimate trace count + sample count to keep the 2-D FFT (padded to pow2)
      // bounded. Reuse the section view's defaults as the working caps.
      const MAX_TRACES = 1024;
      const MAX_SAMPLES = 4096;
      const traceStep = Math.max(1, Math.ceil(tc / MAX_TRACES));
      // Build an un-normalized trace matrix (raw samples). Size to the LONGEST
      // selected trace (capped), zero-pad shorter ones - variable-length traces
      // must not be truncated to trace 0's length.
      const cols: Float32Array[] = [];
      for (let t = 0; t < tc; t += traceStep) {
        const s = current.traces[t]?.samples;
        if (!s) continue;
        cols.push(s.length > MAX_SAMPLES ? resampleLinear(s, MAX_SAMPLES) : s);
      }
      const nTraces = cols.length;
      if (!nTraces) {
        port.postMessage({ id, ok: false, error: 'no traces with samples' });
        return;
      }
      let nSamples = 0;
      for (let c = 0; c < nTraces; c++) if (cols[c].length > nSamples) nSamples = cols[c].length;
      const matrix = new Float32Array(nTraces * nSamples);
      for (let c = 0; c < nTraces; c++) {
        const col = cols[c];
        matrix.set(col.subarray(0, Math.min(nSamples, col.length)), c * nSamples);
      }
      // dx scales by the trace decimation: skipping traceStep traces multiplies
      // the effective spacing so the wavenumber axis stays physically correct.
      const dx = (req.dx && req.dx > 0 ? req.dx : 1) * traceStep;
      const r = fkSpectrum(matrix, nTraces, nSamples, si, dx);
      const decimated = traceStep > 1 || fullSamps > MAX_SAMPLES;
      const log = decimated
        ? `f-k decimated: ${nTraces} traces (every ${traceStep}${traceStep === 2 ? 'nd' : traceStep === 3 ? 'rd' : 'th'}), ${nSamples} samples/trace; grid ${r.nF}×${r.nKx}.`
        : `f-k spectrum: ${nTraces} traces × ${nSamples} samples; grid ${r.nF}×${r.nKx}.`;
      port.postMessage(
        { id, ok: true, mag: r.mag, nKx: r.nKx, nF: r.nF, kAxis: r.kAxis, fAxis: r.fAxis, maxMag: r.maxMag, decimated, log },
        [r.mag.buffer, r.kAxis.buffer, r.fAxis.buffer] as ArrayBuffer[],
      );
      return;
    }

    // -- Trace-health QC (File Viewer) --
    //
    // Scan the open file's traces for quality problems and return per-SCANNED-trace
    // EVIDENCE (a flat Float32 struct-of-arrays) keyed by ABSOLUTE trace index, so the
    // renderer can re-classify live as the sensitivity changes WITHOUT a re-parse. A
    // huge survey is sampled as a handful of CONTIGUOUS blocks (adjacency preserved →
    // the polarity test still runs) and an honest coverage report is returned - never
    // a silent skip. Streamed files are refused above.
    if (type === 'traceHealth') {
      const si = current.bh.sampleInt ?? 2000;
      const tc = current.traceCount;
      const HEALTH_MAX = 20000;
      const cap = req.maxTraces && req.maxTraces > 0 ? Math.min(Math.floor(req.maxTraces), HEALTH_MAX) : HEALTH_MAX;

      // Build the scanned set. Small files: every trace, one block. Big files: a few
      // contiguous blocks spread across the record (each block keeps real adjacency
      // so the neighbour baselines + polarity pilot stay physical).
      const absList: number[] = [];
      const samples: (Float32Array | null)[] = [];
      const blockSizes: number[] = [];
      if (tc <= cap) {
        for (let t = 0; t < tc; t++) { absList.push(t); samples.push(current.traces[t]?.samples ?? null); }
        if (tc > 0) blockSizes.push(tc);
      } else {
        const nBlocks = Math.min(8, Math.max(2, Math.round(tc / 4000)));
        const blockLen = Math.max(1, Math.floor(cap / nBlocks));
        let prevEnd = -1;
        for (let b = 0; b < nBlocks; b++) {
          let startAbs = nBlocks === 1 ? 0 : Math.round((b * (tc - blockLen)) / (nBlocks - 1));
          startAbs = Math.max(prevEnd + 1, Math.min(Math.max(0, tc - blockLen), startAbs));
          if (startAbs >= tc) break;
          const sz = Math.min(blockLen, tc - startAbs);
          for (let k = 0; k < sz; k++) { absList.push(startAbs + k); samples.push(current.traces[startAbs + k]?.samples ?? null); }
          blockSizes.push(sz);
          prevEnd = startAbs + sz - 1;
        }
      }

      const res = scanTraceHealth(samples, si, {
        sensitivity: req.sensitivity,
        thresholds: req.thresholds,
        localWindow: req.localWindow,
        neighbors: req.neighbors,
        polarity: req.polarity ?? true,
        polarityMax: req.polarityMax,
        specMax: req.specMax,
        blockSizes,
      });

      const hInt = (v: number | string | undefined): number => {
        const x = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
        return Number.isFinite(x) ? Math.trunc(x) : 0;
      };
      const hNum = (v: number | string | undefined): number => {
        const x = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
        return Number.isFinite(x) ? x : 0;
      };
      const n = absList.length;
      const evidence = new Float32Array(n * EVIDENCE_STRIDE);
      const traceIndex = new Int32Array(n);
      const ffid = new Int32Array(n);
      const channel = new Int32Array(n);
      const offset = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        writeEvidence(evidence, i, res.evidence[i]);
        const abs = absList[i];
        traceIndex[i] = abs;
        const tr = current.traces[abs];
        ffid[i] = hInt(tr?.hdr?.fieldRec as number | string | undefined);
        channel[i] = hInt(tr?.hdr?.trcField as number | string | undefined);
        offset[i] = hNum(tr?.hdr?.offset as number | string | undefined);
      }
      const stride = n > 0 ? Math.max(1, Math.round(tc / n)) : 1;
      port.postMessage(
        {
          id, ok: true, evidence, traceIndex, ffid, channel, offset, evStride: EVIDENCE_STRIDE,
          sampleInt: si,
          coverage: {
            scanned: n, total: tc, stride, blocks: res.coverage.blocks,
            polarityRan: res.coverage.polarityRan, polarityScanned: res.coverage.polarityScanned,
          },
        },
        [evidence.buffer, traceIndex.buffer, ffid.buffer, channel.buffer, offset.buffer] as ArrayBuffer[],
      );
      return;
    }

    if (type === 'firstBreaks') {
      const si = current.bh.sampleInt ?? 2000;
      const tc = current.traceCount;
      // Operate on REAL adjacent traces (step 1), keyed by ABSOLUTE index - NOT the
      // display-strided section columns (the old bug that scattered far picks). The
      // window defaults to the whole record; cap the real-trace COUNT so a huge open
      // gather can't blow the worker, centring the block on the seed span when over.
      const FB_REAL_MAX = 10000;
      let t0 = Math.max(0, Math.min(tc, (req.traceStart ?? 0) | 0));
      let t1 = Math.max(0, Math.min(tc, (req.traceEnd ?? tc) | 0));
      if (t1 <= t0) { t0 = 0; t1 = tc; }
      if (t1 - t0 > FB_REAL_MAX) {
        // Centre the capped block on the seed span so the user's picks stay covered.
        let lo = t0, hi = t1;
        const seedAbs = (req.seeds ?? []).map((s) => s.absIdx).filter((a) => Number.isFinite(a));
        if (seedAbs.length) {
          const mid = Math.round((Math.min(...seedAbs) + Math.max(...seedAbs)) / 2);
          lo = Math.max(t0, Math.min(t1 - FB_REAL_MAX, mid - (FB_REAL_MAX >> 1)));
          hi = lo + FB_REAL_MAX;
        } else { hi = t0 + FB_REAL_MAX; }
        t0 = lo; t1 = hi;
      }

      const fbInt = (v: number | string | undefined): number => {
        const x = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
        return Number.isFinite(x) ? Math.trunc(x) : 0;
      };
      const fbNum = (v: number | string | undefined): number => {
        const x = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
        return Number.isFinite(x) ? x : NaN;
      };
      const samplesArr: (Float32Array | null)[] = [];
      const absArr: number[] = [];
      const offsets: (number | null)[] = [];
      const ffidArr: number[] = [];
      const chanArr: number[] = [];
      for (let t = t0; t < t1; t++) {
        const tr = current.traces[t];
        samplesArr.push(tr?.samples ?? null);
        absArr.push(t);
        const off = fbNum(tr?.hdr?.offset as number | string | undefined);
        offsets.push(Number.isFinite(off) ? off : null);
        ffidArr.push(fbInt(tr?.hdr?.fieldRec as number | string | undefined));
        chanArr.push(fbInt(tr?.hdr?.trcField as number | string | undefined));
      }

      const seeds: FBSeed[] = (req.seeds ?? [])
        .filter((s) => Number.isFinite(s.absIdx) && Number.isFinite(s.tMs) && s.absIdx >= t0 && s.absIdx < t1)
        .map((s) => ({ absIdx: s.absIdx | 0, tMs: s.tMs }));

      const total = absArr.length;
      const res = assistFirstBreaks({
        traces: samplesArr, absIdx: absArr, siUs: si, seeds, offsets,
        opts: {
          windowMs: req.fbWindowMs, polarity: req.fbPolarity,
          staMs: req.fbStaMs, ltaMs: req.fbLtaMs, threshold: req.fbThreshold,
        },
        onProgress: (done) => emitProgress('firstBreaks', done, total || 1, 'Picking first breaks…'),
      });

      // Flatten the picks into transferable struct-of-arrays keyed by absolute index.
      const m = res.picks.length;
      const pAbs = new Int32Array(m);
      const pTime = new Float32Array(m);
      const pSource = new Int8Array(m);   // 0 seed · 1 auto · 2 edited
      const pConf = new Float32Array(m);
      const pDev = new Float32Array(m);
      const pFfid = new Int32Array(m);
      const pChan = new Int32Array(m);
      const pOff = new Float32Array(m);
      const posByAbs = new Map<number, number>();
      for (let i = 0; i < absArr.length; i++) posByAbs.set(absArr[i], i);
      for (let i = 0; i < m; i++) {
        const pk = res.picks[i];
        pAbs[i] = pk.absIdx;
        pTime[i] = Number.isFinite(pk.tMs) ? pk.tMs : NaN;
        pSource[i] = pk.source === 'seed' ? 0 : pk.source === 'edited' ? 2 : 1;
        pConf[i] = Number.isFinite(pk.confidence) ? pk.confidence : 0;
        pDev[i] = Number.isFinite(pk.deviation) ? pk.deviation : 0;
        const row = posByAbs.get(pk.absIdx);
        pFfid[i] = row !== undefined ? ffidArr[row] : 0;
        pChan[i] = row !== undefined ? chanArr[row] : 0;
        const ov = row !== undefined ? offsets[row] : null;
        pOff[i] = ov != null && Number.isFinite(ov) ? ov : NaN;
      }
      // The guide curve over the scanned real-trace range (parallel to absArr), for the
      // overlay's dashed guide + shaded ±window band.
      const gAbs = new Int32Array(absArr.length);
      for (let i = 0; i < absArr.length; i++) gAbs[i] = absArr[i];
      const guide = res.guideMs;

      port.postMessage(
        {
          id, ok: true, sampleInt: si, windowMs: res.windowMs, hasOffsets: res.hasOffsets,
          traceStart: t0, traceEnd: t1,
          pAbs, pTime, pSource, pConf, pDev, pFfid, pChan, pOff,
          gAbs, guide,
        },
        [pAbs.buffer, pTime.buffer, pSource.buffer, pConf.buffer, pDev.buffer, pFfid.buffer, pChan.buffer, pOff.buffer, gAbs.buffer, guide.buffer] as ArrayBuffer[],
      );
      return;
    }

    port.postMessage({ id, ok: false, error: `unknown request type: ${type}` });
  } catch (e) {
    port.postMessage({ id, ok: false, error: (e as Error).message });
  }
});
