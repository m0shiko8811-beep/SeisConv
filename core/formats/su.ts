// seisconv-core - SU (Seismic Unix) parser + writer
//
// Headerless SEG-Y: 240-byte trace headers, IEEE float32 samples, traces start
// at byte 0. Ported from the SeisConv reference.
//
// BYTE ORDER: SU files carry NO byte-order marker - samples + headers are in the
// writing machine's native order. Big-endian SU (classic Unix/SPARC) and
// little-endian SU (PC-written, very common) are both in the wild, so the READER
// auto-detects per file and threads a single `le` flag through every header /
// sample read. The WRITER always emits big-endian (the SU/CWP canonical order),
// keeping output bit-identical to the reference.

import { dv, getF32, r16u, r32s, w16, w32 } from '../binary';
import type { Bytes, ParsedFile, Trace, TraceHeader } from '../types';
import { MAX_SAMPLE_TRACES, MAX_SAMPLES_PER_TRACE, MAX_TRACES } from '../types';

/**
 * Detect SU byte order. SU is headerless and carries no magic, so we combine
 * structural signals. For each candidate order we read nSamp (trace-header byte
 * 114, uint16) + sampInt (byte 116, uint16), derive the fixed record stride
 * (240 + nSamp*4), and score the order on three things:
 *   1. filesize / stride is a clean positive integer (the file is a whole number
 *      of equal-size traces - the defining property of a headerless SU file);
 *   2. sampInt is a plausible microsecond interval (1..100000 µs);
 *   3. TIEBREAK - decode the first trace's first ~64 float32 samples that order
 *      and require them all finite + bounded (no NaN/Inf, no denormal blow-up);
 *      a mis-ordered IEEE float field is overwhelmingly likely to produce
 *      NaN/Inf or astronomically large magnitudes.
 * Returns true for little-endian, false (default) for big-endian.
 */
export function detectSU(b: Bytes): boolean {
  if (b.length < 240) return false; // too small to judge → default big-endian

  // Score one candidate byte order. Higher is more likely the true order.
  const score = (le: boolean): number => {
    const nSamp = r16u(b, 114, le);
    const sampInt = r16u(b, 116, le);
    if (nSamp <= 0) return -1; // a zero/unreadable sample count is disqualifying
    const stride = 240 + nSamp * 4;
    let s = 0;

    // (1) Clean tiling: filesize is an exact, positive multiple of the stride.
    const traces = b.length / stride;
    if (Number.isInteger(traces) && traces >= 1) s += 4;
    else if (b.length >= stride) s += 1; // at least one whole trace fits

    // (2) Plausible sample interval (µs).
    if (sampInt >= 1 && sampInt <= 100000) s += 2;

    // (3) First-trace sample sanity over the first ~64 float32s.
    const n = Math.min(64, nSamp);
    let allFinite = n > 0;
    for (let j = 0; j < n; j++) {
      const v = getF32(b, 240 + j * 4, le);
      // Reject NaN/Inf and absurd magnitudes (mis-ordered floats blow up); 0 is
      // fine. 1e30 is far beyond any real seismic amplitude yet leaves head-room
      // for legitimately large values.
      if (!Number.isFinite(v) || Math.abs(v) > 1e30) { allFinite = false; break; }
    }
    if (allFinite) s += 3;
    return s;
  };

  const beScore = score(false);
  const leScore = score(true);
  // Strictly-greater LE wins; ties and BE-favoured both default to big-endian,
  // preserving the historical default for ambiguous files.
  return leScore > beScore;
}

export function parseSU(b: Bytes): ParsedFile {
  const r: ParsedFile = { format: 'SU', revision: 0, textHeader: '', bh: {}, traces: [], traceCount: 0, errors: [] };
  if (b.length < 240) {
    r.errors.push('File too small for SU');
    return r;
  }
  // Auto-detect byte order ONCE, then thread `le` through every header/sample
  // read below so an LE (PC-written) SU file decodes correctly.
  const le = detectSU(b);
  // nSamples + sampleInterval come from the first trace header.
  const nSamp = r16u(b, 114, le);
  const si = r16u(b, 116, le);
  const fmt = 1; // SU uses 4-byte IEEE float
  const bps = 4;
  const tSize = 240 + nSamp * bps;
  if (tSize <= 240) {
    r.errors.push('Invalid SU trace size');
    return r;
  }
  // Surface the detected order for the worker summary / tests (mirrors segy.ts).
  r.bh = { sampleInt: si, samplesTrace: nSamp, dataFmt: fmt, littleEndian: le ? 1 : 0 };
  // Cap the trace COUNT at MAX_TRACES like segy/segd: nTraces is derived from the
  // file size and a tiny per-trace stride (e.g. nSamp=1 → 244 bytes), so a 500 MB
  // file would otherwise materialize ~2M TraceHeader objects and exhaust memory.
  const nTraces = Math.min(Math.floor(b.length / tSize), MAX_TRACES);
  // Bound the per-trace sample read by MAX_SAMPLES_PER_TRACE (defense-in-depth,
  // matching segy/seg2/segd) - nSamp is a 16-bit field so already ≤ 65535, but
  // keeping the shared cap here means no decode path is the lone unbounded one.
  const nSampClamped = Math.min(nSamp, MAX_SAMPLES_PER_TRACE);
  for (let i = 0; i < nTraces; i++) {
    const off = i * tSize;
    const hdr: TraceHeader = {
      traceSeq: r32s(b, off, le), lineSeq: r32s(b, off + 4, le), ffid: r32s(b, off + 8, le),
      traceNum: r32s(b, off + 12, le), sp: r32s(b, off + 16, le), cdp: r32s(b, off + 20, le),
      cdpTrace: r32s(b, off + 24, le), traceId: r16u(b, off + 28, le), offset: r32s(b, off + 36, le),
      nSamples: r16u(b, off + 114, le), sampInt: r16u(b, off + 116, le),
    };
    let samples: Float32Array | null = null;
    if (i < MAX_SAMPLE_TRACES) {
      samples = new Float32Array(nSampClamped);
      for (let j = 0; j < nSampClamped; j++) samples[j] = getF32(b, off + 240 + j * 4, le);
    }
    const trace: Trace = { hdr, samples, nSamples: nSampClamped };
    r.traces.push(trace);
  }
  r.traceCount = nTraces;
  return r;
}

export function writeSU(pd: ParsedFile): Bytes {
  const trc = pd.traces;
  if (!trc || !trc.length) throw new Error('No traces');
  // Fixed-record output: size every slot from the LONGEST trace, not the first,
  // so a short first trace can't under-allocate `out` and overrun on a later,
  // longer trace ('Offset is outside the bounds of the DataView').
  const spt = trc.reduce((m, t) => Math.max(m, t.nSamples || 0), 0);
  // ns (trace-header byte 114) is a 16-bit field: ns > 65535 CANNOT be represented
  // in SU. Refuse loudly - the old clamp wrote ns=65535 while emitting the full
  // sample payload, so a re-import mis-walked the traces (e.g. 1 trace → 7).
  if (spt > 65535)
    throw new Error(`trace has ${spt} samples; SU max 65535 - resample or split before export`);
  const si = pd.bh?.sampleInt || 2000;
  const tsz = 240 + spt * 4;
  const out = new Uint8Array(trc.length * tsz);
  // Pull a populated header word, accepting either the SU field name or the
  // equivalent SEG-Y trace-header name (so SU→SU and SEG-Y→SU both preserve the
  // geometry SU processing tools depend on). Returns 0 when neither is present.
  const hw = (h: TraceHeader, ...keys: string[]): number => {
    for (const k of keys) {
      const v = h[k];
      if (typeof v === 'number' && v !== 0) return v;
    }
    return 0;
  };
  let off = 0;
  for (let t = 0; t < trc.length; t++) {
    const tr = trc[t];
    const h = tr.hdr || {};
    w32(out, off, t + 1); // tracl (sequential)
    // Preserve trace geometry/identity at the CWP segy.h byte offsets instead of
    // zeroing it: fldr@8, ep@16 (shot/source point), cdp@20, cdpt@24, offset@36.
    if (hw(h, 'ffid', 'fieldRec')) w32(out, off + 8, hw(h, 'ffid', 'fieldRec'));
    if (hw(h, 'sp', 'srcPt')) w32(out, off + 16, hw(h, 'sp', 'srcPt'));
    if (hw(h, 'cdp', 'ensemble')) w32(out, off + 20, hw(h, 'cdp', 'ensemble'));
    if (hw(h, 'cdpTrace', 'trcEns')) w32(out, off + 24, hw(h, 'cdpTrace', 'trcEns'));
    // trid (byte 28): carry through if present, else 1 = seismic data (segy.h).
    w16(out, off + 28, hw(h, 'traceId') || 1);
    if (hw(h, 'offset')) w32(out, off + 36, hw(h, 'offset'));
    // ns (byte 114): the spt > 65535 guard above already refused anything that
    // can't fit this 16-bit field, so the raw value is always representable here.
    w16(out, off + 114, tr.nSamples);
    w16(out, off + 116, si);
    if (tr.samples) {
      const sdv = dv(out);
      const base = off + 240;
      // Clamp to the allocated slot (spt) so the write stays in-bounds for all traces.
      const ns2 = Math.min(tr.nSamples, spt);
      for (let i = 0; i < ns2; i++) sdv.setFloat32(base + i * 4, tr.samples[i] || 0, false);
    }
    off += tsz;
  }
  return out;
}
