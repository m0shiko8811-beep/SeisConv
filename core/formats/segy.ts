// seisconv-core - SEG-Y parser + writer (Rev 0/1/2)
//
// Ported from the SeisConv reference. The READER auto-detects byte order per
// file (big- or little-endian) and threads a single `le` flag through every
// header/sample read; the WRITER always emits standard big-endian SEG-Y.
// Data formats: 1=IBM float, 2=int32, 3=int16, 5=IEEE float32, 8=int8.

import { asciiPrintable, asciiToEbcdic, dv, ebcdic, getF32, getI16, getI32, ibm2f, r16s, r16u, r32s, r32u, w16, w32 } from '../binary';
import type { Bytes, ParsedFile, Trace, TraceHeader } from '../types';
import { MAX_SAMPLE_TRACES, MAX_SAMPLES_PER_TRACE, MAX_TRACES } from '../types';

/** Product tag stamped into written SEG-Y textual headers. Neutral; change here if rebranding. */
export const WRITER_TAG = 'SeisConv';

/**
 * Detect SEG-Y byte order from the binary header (file bytes 3201-3600, abs
 * offset 3200). Returns true for little-endian, false for big-endian. Three
 * layers, most authoritative first, so rev0/rev1 files without the byte-order
 * constant still resolve via the format-code / sample-interval heuristics.
 */
function detectLittleEndian(b: Bytes): boolean {
  // PRIMARY - byte-order constant, file bytes 3297-3300 (binhdr offset 96, uint32).
  const o = 3296; // 3200 + 96
  const beVal = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (beVal === 0x01020304) return false; // big-endian marker
  if (beVal === 0x04030201) return true; // little-endian marker (bytes swapped)
  // rev0/rev1 leave this zero → fall through to the heuristics.

  // FALLBACK - data sample format code, file bytes 3225-3226 (binhdr offset 24, uint16).
  const fo = 3224; // 3200 + 24
  const fmtBE = (b[fo] << 8) | b[fo + 1];
  const fmtLE = b[fo] | (b[fo + 1] << 8);
  const okFmt = (v: number): boolean => v >= 1 && (v <= 12 || v === 15 || v === 16); // SEGY_BPS keys
  if (okFmt(fmtLE) && !okFmt(fmtBE)) return true;
  if (okFmt(fmtBE) && !okFmt(fmtLE)) return false;
  // both valid or both invalid → tiebreak.

  // TIEBREAK - sample interval (µs), file bytes 3217-3218 (binhdr offset 16, uint16).
  const so = 3216; // 3200 + 16
  const siBE = (b[so] << 8) | b[so + 1];
  const siLE = b[so] | (b[so + 1] << 8);
  const plaus = (v: number): boolean => v >= 1 && v <= 100000;
  if (plaus(siLE) && !plaus(siBE)) return true;
  if (plaus(siBE) && !plaus(siLE)) return false;

  return false; // default big-endian
}

/** Read a header value as an integer (headers are numeric for SEG-Y). */
function hi(h: TraceHeader, k: string): number {
  const v = h[k];
  return typeof v === 'number' ? v : 0;
}

// Bytes-per-sample keyed by the SEG-Y data sample format code (byte 3225-3226).
// This drives BOTH the decode switch AND the trace-walk stride, so a conformant
// rev2 file using an 8-/3-/1-byte format is stepped at the true on-disk record
// size instead of being mis-walked as 4-byte IEEE.
//   1=IBM f32(4) 2=int32(4) 3=int16(2) 4=fixed-gain(4) 5=IEEE f32(4)
//   6=IEEE f64(8) 7=int24(3) 8=int8(1) 9=int64(8) 10=uint32(4) 11=uint16(2)
//   12=uint64(8) 15=uint24(3) 16=uint8(1)
const SEGY_BPS: Record<number, number> = { 1: 4, 2: 4, 3: 2, 4: 4, 5: 4, 6: 8, 7: 3, 8: 1, 9: 8, 10: 4, 11: 2, 12: 8, 15: 3, 16: 1 };

/** Codes this parser can actually decode to samples. Others (rev2 additions we
 *  don't yet decode) are stepped at the correct width but flagged, not silently
 *  reinterpreted as IEEE f32. */
function segyDecodable(fmt: number): boolean {
  return fmt === 1 || fmt === 2 || fmt === 3 || fmt === 5 || fmt === 8;
}

/**
 * Everything the per-trace walk needs that is derived ONCE from the SEG-Y file
 * headers (textual + binary + extended textual). Extracted as a reusable building
 * block so a streaming/indexed reader can resolve the header off the first N KB of
 * a multi-GB file, then walk traces by positioned reads (see `decodeSegyTrace`).
 */
export interface SegyMeta {
  /** Detected byte order: true = little-endian, false = big-endian. */
  le: boolean;
  /** True when the textual header was decoded as EBCDIC (else ASCII/Latin). */
  isEbcdic: boolean;
  /** The 3200-byte textual header, decoded to a printable string. */
  textHeader: string;
  /** Binary-header summary (same shape/keys as `ParsedFile.bh` for SEG-Y). */
  bh: Record<string, number>;
  /** Major revision: 0 → rev 0, 1 → rev 1, 2 → rev 2 (regardless of minor). */
  revision: number;
  /** Data sample format code (binhdr offset 24), defaulted to 1 when absent. */
  format: number;
  /** Bytes per sample for `format` (SEGY_BPS), defaulted to 4 for unknown codes. */
  bps: number;
  /** Rev2 additional-trace-header bytes that widen each trace's stride (0 pre-rev2). */
  addHdrBytes: number;
  /** Fallback sample count (binary-header samples/trace) when a trace header is 0. */
  defaultNs: number;
  /** Sample interval in microseconds (binary-header value). */
  sampleInt: number;
  /** Absolute byte offset of the FIRST trace header (3600 + extended-header bytes). */
  dataStart: number;
}

/**
 * Parse the SEG-Y HEADER half (textual + binary + extended textual headers) into
 * a reusable `SegyMeta`. Never throws: on a short/garbage buffer the numeric reads
 * degrade to 0 and `dataStart` is resolved as far as the buffer allows.
 *
 * `dataStart` is the absolute offset of the first trace = 3600 + the extended
 * textual headers. For a fixed extended-header count it is exact even from a small
 * buffer; for the rev2 variable count (-1) the End-Text stanza is scanned, so the
 * caller must pass enough bytes to contain it (the worker passes the first 64 KB+).
 * If the buffer is too short to reach the stanza, `dataStart` is the best offset
 * resolved so far (off advances only while a full 3200-byte block fits).
 */
export function parseSegyMeta(b: Bytes): SegyMeta {
  // Auto-detect byte order ONCE from the binary header, then thread `le` through
  // every header/sample read. Reads the raw absolute buffer `b` (the binary header
  // lives at abs offset 3200) before the byte-order-dependent header parse so the
  // very first header value is interpreted correctly.
  const le = detectLittleEndian(b);
  const isEbcdic = b[0] === 0xc3 || b[0] === 0xc1 || b[0] === 0x40;
  const textHeader = isEbcdic ? ebcdic(b.slice(0, 3200)) : asciiPrintable(b.slice(0, 3200));
  const bhBytes = b.slice(3200, 3600);
  const bh: Record<string, number> = {
    sampleInt: r16u(bhBytes, 16, le),
    samplesTrace: r16u(bhBytes, 20, le),
    dataFmt: r16u(bhBytes, 24, le),
    // Trace-sorting code, file bytes 3229-3230 (binhdr offset 28, SIGNED int16).
    // 4/8/9 = horizontally-stacked / CMP / common-conversion-point (post-stack);
    // 1/5/etc = pre-stack; 0/absent = unknown. Read straight through; the geometry
    // check uses it to avoid false-flagging post-stack data.
    traceSorting: r16s(bhBytes, 28, le),
    revision: r16u(bhBytes, 300, le),
    // Byte 3505-3506 is SIGNED in rev2: -1 (0xFFFF) means "a variable number of
    // extended textual headers, read until the End Text stanza", NOT 65535.
    extHdrCnt: r16s(bhBytes, 304, le),
    // SEG-Y rev2 'Max number of additional 240-byte trace headers' (file bytes
    // 3507-3510, binhdr offset 306, uint32). Drives the per-trace stride below.
    maxAddTraceHdr: r32u(bhBytes, 306, le),
    lineNum: r32s(bhBytes, 4, le),
    jobId: r32s(bhBytes, 0, le),
    // Diagnostic: detected byte order, for worker-summary / test asserts.
    littleEndian: le ? 1 : 0,
  };
  // Byte 3501 = major revision, byte 3502 = minor (radix point between the two
  // bytes). Decode the major byte on its own so a nonzero minor - e.g. rev 2.1 =
  // 0x0201 - is NOT demoted to rev 0, and any future minor revision is honoured.
  const revWord = bh.revision || 0;
  // r16u already applied the file's byte order, so the major byte (3501) lands in
  // the HIGH byte for big-endian but the LOW byte for little-endian. Decode major/
  // minor accordingly - else a little-endian rev-2 file mis-reads as rev 0 and the
  // rev-2 additional-trace-header stride below is skipped (traces mis-walk).
  const revMajor = le ? (revWord & 0xff) : ((revWord >> 8) & 0xff);
  bh.revMinor = le ? ((revWord >> 8) & 0xff) : (revWord & 0xff);

  let off = 3600;
  const extCnt = bh.extHdrCnt || 0;
  if (extCnt < 0) {
    // Variable count (rev2, -1): skip 3200-byte extended-header blocks until one
    // contains the End Text stanza '((SEG: EndText))' (case-insensitive), or we
    // run out of room. The stanza marks the last extended textual header.
    while (off + 3200 <= b.length) {
      const block = asciiPrintable(b.slice(off, off + 3200));
      off += 3200;
      if (/\(\(\s*SEG\s*:\s*EndText\s*\)\)/i.test(block)) break;
    }
  } else {
    for (let i = 0; i < extCnt && off + 3200 <= b.length; i++) off += 3200;
  }

  const fmt = bh.dataFmt || 1;
  // SEG-Y rev2 may carry extra 240-byte trace headers that FOLLOW the primary
  // trace header and PRECEDE the samples. They widen the per-trace stride. Only
  // rev2; clamp to [0,100] so a garbage high word can't blow up the stride.
  const addHdrCount = revMajor >= 2 ? Math.max(0, Math.min(bh.maxAddTraceHdr ?? 0, 100)) : 0;
  return {
    le,
    isEbcdic,
    textHeader,
    bh,
    revision: revMajor, // 0 → rev 0, 1 → rev 1, 2 → rev 2 (regardless of minor)
    format: fmt,
    bps: SEGY_BPS[fmt] ?? 4,
    addHdrBytes: addHdrCount * 240,
    defaultNs: bh.samplesTrace || 0,
    sampleInt: bh.sampleInt || 0,
    dataStart: off,
  };
}

/**
 * Decode ONE trace whose 240-byte trace header starts at absolute offset `off`,
 * using the already-resolved `meta`. The second reusable building block: a
 * streaming reader indexes trace offsets by reading only the 240-byte headers,
 * then calls this with `withSamples:true` for the trace(s) it actually needs.
 *
 * Returns the parsed header plus `stride` (the bytes from `off` to the next trace
 * header). `trace.samples` is a decoded Float32Array only when `withSamples` is
 * true AND the format is decodable; otherwise null (header always kept). Returns
 * null when the trace can't be read - `ns <= 0 || ns > MAX_SAMPLES_PER_TRACE`, or
 * the samples run past the buffer end - mirroring the in-file parser's guards.
 */
export function decodeSegyTrace(
  b: Bytes,
  off: number,
  meta: SegyMeta,
  withSamples: boolean,
): { trace: Trace; stride: number } | null {
  const le = meta.le;
  const fmt = meta.format;
  const addHdrBytes = meta.addHdrBytes;
  const bps = meta.bps;
  // Read header fields directly from the main buffer - no slice/copy.
  const hdr: TraceHeader = {
    seqLine: r32s(b, off + 0, le), seqFile: r32s(b, off + 4, le), fieldRec: r32s(b, off + 8, le),
    trcField: r32s(b, off + 12, le), srcPt: r32s(b, off + 16, le), ensemble: r32s(b, off + 20, le),
    trcEns: r32s(b, off + 24, le), traceId: r16s(b, off + 28, le), dataUse: r16s(b, off + 34, le),
    offset: r32s(b, off + 36, le), rcvElev: r32s(b, off + 40, le), surfElev: r32s(b, off + 44, le),
    srcDepth: r32s(b, off + 48, le), elevScalar: r16s(b, off + 68, le), coordScalar: r16s(b, off + 70, le),
    srcX: r32s(b, off + 72, le), srcY: r32s(b, off + 76, le), rcvX: r32s(b, off + 80, le), rcvY: r32s(b, off + 84, le),
    coordUnit: r16s(b, off + 88, le), nSamples: r16u(b, off + 114, le), sampInt: r16u(b, off + 116, le),
    gainType: r16s(b, off + 118, le), gainConst: r16s(b, off + 120, le), lowCut: r16s(b, off + 146, le),
    highCut: r16s(b, off + 148, le), year: r16s(b, off + 156, le), day: r16s(b, off + 158, le),
    hour: r16s(b, off + 160, le), minute: r16s(b, off + 162, le), second: r16s(b, off + 164, le),
    muteStart: r16s(b, off + 110, le), muteEnd: r16s(b, off + 112, le), traceWeight: r16s(b, off + 168, le),
  };
  const ns = (hdr.nSamples as number) || meta.defaultNs;
  if (ns <= 0 || ns > MAX_SAMPLES_PER_TRACE) return null;
  const dEnd = off + 240 + addHdrBytes + ns * bps;
  if (dEnd > b.length) return null;
  // Cap in-memory sample arrays for huge files (mirrors su.ts/segd.ts via the
  // MAX_SAMPLE_TRACES discipline): the caller passes withSamples=false past the
  // preview cap, so a header is kept for EVERY trace, but `samples` stays null past
  // the cap - or for non-decodable sample codes. The `stride` is returned either
  // way so the walk stays aligned without allocating one Float32Array per trace.
  let samples: Float32Array | null = null;
  if (withSamples && segyDecodable(fmt)) {
    samples = new Float32Array(ns);
    for (let i = 0; i < ns; i++) {
      const p = off + 240 + addHdrBytes + i * bps;
      if (fmt === 1) samples[i] = ibm2f(b, p); // IBM hex float is byte-order-agnostic
      else if (fmt === 5) samples[i] = getF32(b, p, le);
      else if (fmt === 2) samples[i] = getI32(b, p, le);
      else if (fmt === 3) samples[i] = getI16(b, p, le);
      else samples[i] = b[p] > 127 ? b[p] - 256 : b[p]; // fmt === 8 (int8): single byte
    }
  }
  const trace: Trace = { hdr, samples, nSamples: ns, dataFmt: fmt };
  return { trace, stride: 240 + addHdrBytes + ns * bps };
}

/**
 * Parse a SEG-Y file. `sampleTraceCap` bounds how many traces get their SAMPLES
 * decoded into memory (a header is still kept for EVERY trace up to MAX_TRACES);
 * it defaults to MAX_SAMPLE_TRACES so existing callers (registry/parseAny) are
 * byte-identical. A caller that has already size-bounded the file (the worker's
 * in-memory open path) raises this so the deep traces aren't left sample-less -
 * which otherwise renders blank when the viewer pans/zooms past the cap.
 */
export function parseSEGY(b: Bytes, sampleTraceCap: number = MAX_SAMPLE_TRACES): ParsedFile {
  const r: ParsedFile = { format: 'SEG-Y', revision: 0, textHeader: '', bh: {}, traces: [], traceCount: 0, errors: [] };
  if (b.length < 3600) {
    r.errors.push('File <3600 bytes');
    return r;
  }
  // -- HEADER half: one source of truth (also used by the streaming reader). --
  const meta = parseSegyMeta(b);
  r.textHeader = meta.textHeader;
  r.bh = meta.bh;
  r.revision = meta.revision;
  const fmt = meta.format;
  if (!SEGY_BPS[fmt]) r.errors.push(`Unknown SEG-Y data sample format code ${fmt}`);
  else if (!segyDecodable(fmt)) r.errors.push(`Unsupported SEG-Y data sample format code ${fmt} (samples not decoded)`);

  // -- TRACE-WALK half: decode each trace via the shared building block. --
  let off = meta.dataStart;
  let tc = 0;
  // Unified entry guard: enter the body only when a full 240-byte trace header
  // fits. (Replaces a weaker outer `off < b.length - 240` plus a redundant inner
  // `if (off + 240 > b.length) break` - the inner test could never fire.)
  while (off + 240 <= b.length && tc < MAX_TRACES) {
    const res = decodeSegyTrace(b, off, meta, tc < sampleTraceCap);
    if (res) {
      r.traces.push(res.trace);
      off += res.stride;
      tc++;
      continue;
    }
    // `null` ⇒ one of the two original guards fired. Disambiguate with the same
    // `ns` the decoder used, preserving the original walk byte-for-byte: an
    // out-of-range `ns` skips this trace with the recovery stride and continues;
    // an in-range `ns` means the samples ran past the buffer end → stop.
    const ns = r16u(b, off + 114, meta.le) || meta.defaultNs;
    if (ns <= 0 || ns > MAX_SAMPLES_PER_TRACE) {
      off += 240 + meta.addHdrBytes + Math.max(meta.defaultNs > 0 ? meta.defaultNs * meta.bps : 0, 4);
      continue;
    }
    break;
  }
  r.traceCount = tc;
  return r;
}

/**
 * Write traces as SEG-Y (always IEEE float32, data format 5). `rev` selects the
 * declared revision (0/1/2). Mirrors the reference writer.
 *
 * Known deviation (accepted): the sample format is IEEE float32 (code 5) even
 * when labeled rev 0 - the strict rev 0 spec knows only IBM float (code 1).
 * Readers that honour the format code (including ours) read it fine; a minimal
 * IBM-float encoder is deliberately not added (lossy + little demand).
 */
export function writeSEGY(pd: ParsedFile, rev: number): Bytes {
  const trc = pd.traces;
  if (!trc || !trc.length) throw new Error('No traces');
  // SEG-Y is a fixed-record format: every trace slot is the same size. Size it
  // from the LONGEST trace, not just the first - otherwise a short first trace
  // (e.g. an aux/timebreak) under-allocates `out` and the per-trace write below
  // runs past the buffer end ('Offset is outside the bounds of the DataView').
  const spt = trc.reduce((m, t) => Math.max(m, t.nSamples || 0), 0);
  // The samples-per-trace fields are 16-bit: ns > 65535 CANNOT be represented in
  // SEG-Y. Refuse loudly - the old clamp silently truncated every longer trace.
  if (spt > 65535)
    throw new Error(`trace has ${spt} samples; SEG-Y max 65535 - resample or split before export`);
  const si = pd.bh?.sampleInt || 2000;
  const tsz = 240 + spt * 4;
  const out = new Uint8Array(3600 + trc.length * tsz);

  const lines = [
    `C 1 ${WRITER_TAG} SEG-Y Rev ${rev}`,
    `C 2 Traces: ${trc.length}  Samples: ${spt}`,
    `C 3 SI: ${si} us IEEE Float32`,
    `C 4 Input: ${pd.format} Rev ${pd.revision || 0}`,
    `C40 END TEXTUAL HEADER`,
  ];
  let txt = '';
  for (let i = 0; i < 40; i++) {
    const l = lines[i] || `C${String(i + 1).padStart(2, ' ')}`;
    txt += l.slice(0, 80).padEnd(80, ' ');
  }
  // Textual header encoding: EBCDIC for rev 0/1 (rev 0 REQUIRES it; it is the
  // spec default for rev 1), ASCII for rev 2 (explicitly permitted there).
  // parseSegyMeta auto-detects either via the first byte, so round-trips hold.
  for (let i = 0; i < 3200; i++) {
    const c = txt.charCodeAt(i) || 0x20;
    out[i] = rev <= 1 ? asciiToEbcdic(c) : c;
  }

  const bh = 3200;
  w16(out, bh + 16, si);
  w16(out, bh + 18, si);
  w16(out, bh + 20, spt);
  w16(out, bh + 22, spt);
  w16(out, bh + 24, 5);
  w16(out, bh + 300, rev === 1 ? 0x0100 : rev === 2 ? 0x0200 : 0);
  w16(out, bh + 302, 1);

  // -- Rev 2 extended / required binary-header fields --
  // The legacy 16-bit sample-interval (3217) and samples-per-trace (3221) fields
  // overflow above 65535; rev2 carries authoritative copies in extended fields,
  // and a fixed-length flag (3503) that references them. Write them so a rev2
  // file is internally self-consistent for strict rev2 readers. The parser does
  // not read these, so round-tripping through parseSEGY is unaffected.
  if (rev === 2) {
    const bdv = dv(out);
    bdv.setFloat64(bh + 80, si, false); // 3281-3288: extended sample interval (IEEE double, µs)
    bdv.setUint32(bh + 88, spt, false); // 3289-3292: extended number of samples/trace (uint32)
    bdv.setUint32(bh + 96, 0x01020304, false); // 3297-3300: byte-order constant (big-endian)
    // 3507-3510 (binhdr offset 306, uint32): max number of additional 240-byte
    // trace headers = 0. MUST match the field the reader parses (maxAddTraceHdr,
    // r32u at offset 306) so the per-trace stride round-trips; the previous
    // w16(bh+316) wrote a different field (wrong location AND width).
    w32(out, bh + 306, 0);
  }

  // Hoist the output DataView (a WeakMap lookup) out of the per-trace loop - it is
  // the same view for every trace, so resolving it once avoids a lookup per trace.
  const odv = dv(out);
  let off = 3600;
  for (let t = 0; t < trc.length; t++) {
    const tr = trc[t];
    const h = tr.hdr || {};
    w32(out, off, t + 1);
    w32(out, off + 4, t + 1);
    w32(out, off + 8, hi(h, 'fieldRec') || t + 1);
    w32(out, off + 12, hi(h, 'trcField') || t + 1);
    // Preserve source-point, ensemble and offset when the input carried them -
    // dropping them (while keeping raw coordinates) breaks geometry in standard
    // readers. Ensemble keeps the source value; t+1 is only synthesized if absent.
    if (hi(h, 'srcPt')) w32(out, off + 16, hi(h, 'srcPt'));
    w32(out, off + 20, hi(h, 'ensemble') || t + 1);
    w16(out, off + 28, hi(h, 'traceId') || 1);
    if (hi(h, 'offset')) w32(out, off + 36, hi(h, 'offset'));
    // coordScalar (bytes 71-72) MUST accompany the raw coordinates below: with
    // e.g. coordScalar=-100 data, omitting it makes readers see coords 100× too
    // large. elevScalar is written alongside for the same reason.
    if (hi(h, 'elevScalar')) w16(out, off + 68, hi(h, 'elevScalar'));
    if (hi(h, 'coordScalar')) w16(out, off + 70, hi(h, 'coordScalar'));
    // Write the PADDED sample count, not the trace's own: every record slot is
    // sized from the longest trace, so a reader walking by the trace header (ours
    // included) would land inside the padding of a short trace and desynchronise
    // permanently. The binary header already declares spt for the whole file.
    w16(out, off + 114, spt);
    w16(out, off + 116, si);
    if (hi(h, 'srcX')) w32(out, off + 72, hi(h, 'srcX'));
    if (hi(h, 'srcY')) w32(out, off + 76, hi(h, 'srcY'));
    if (hi(h, 'rcvX')) w32(out, off + 80, hi(h, 'rcvX'));
    if (hi(h, 'rcvY')) w32(out, off + 84, hi(h, 'rcvY'));
    // Elevations: the parser reads these and elevScalar is already written above,
    // so dropping them handed a processor a flat datum next to a scalar claiming
    // to scale it. Mirrors the coordinate writes.
    if (hi(h, 'rcvElev')) w32(out, off + 40, hi(h, 'rcvElev'));
    if (hi(h, 'surfElev')) w32(out, off + 44, hi(h, 'surfElev'));
    if (hi(h, 'srcDepth')) w32(out, off + 48, hi(h, 'srcDepth'));
    if (tr.samples) {
      const base = off + 240;
      // Clamp to the allocated slot (spt), never the raw per-trace nSamples - the
      // slot is sized for the longest trace, so this stays in-bounds for all.
      const ns2 = Math.min(tr.nSamples, spt);
      for (let i = 0; i < ns2; i++) odv.setFloat32(base + i * 4, tr.samples[i] || 0, false);
    }
    off += tsz;
  }
  return out;
}
