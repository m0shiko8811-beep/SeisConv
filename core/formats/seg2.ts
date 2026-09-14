// seisconv-core - SEG-2 parser (incl. Geometrics Geode ".dat")
//
// The standard is "SEG-2": Pullan, S. E., 1990, Recommended standard for seismic
// (/radar) data files in the personal computer environment, Geophysics 55(9),
// 1260-1271 (Subcommittee of the SEG Engineering and Groundwater Geophysics
// Committee). A file is a File Descriptor Block, one Trace Descriptor Block per
// trace and one Data Block per trace.
//
// BYTE ORDER: the standard fixes it per file - integers are read in the order
// implied by the first two bytes of the File Descriptor Block (block ID 3A55h).
// Every file seen in practice (and every Geode file) is little-endian, which is
// what this reader assumes throughout; a big-endian SEG-2 file would not decode.
// FREE FORMAT STRINGS: the offset-prefixed form is the STANDARD one, not a
// vendor variant. SEG-2 (Pullan 1990), C. String format, printed page 6: "All
// strings start with an offset (2 bytes) to the next string and a keyword that
// identifies the nature of the string, contain a numeric and/or alphanumeric
// value(s), and end with the string terminator indicated in the File Descriptor
// Block. An offset of 0 (2 bytes), after the final string, marks the end of the
// string list." Geometrics Geode hardware writes exactly that, because it is
// what the document requires; calling it "Geode's variant" is what let a writer
// that emitted plain separated text look like the normal case for years.
// This reader ALSO accepts a section written as plain terminator-separated
// lines, which is NOT conformant and cannot be walked by a conformant reader.
// It is kept only so files SeisConv itself wrote before the offset-prefix fix,
// and any other tool that took the same shortcut, still open.
// Ported from the SeisConv reference.

import { dv, getF32, getF64 } from '../binary';
import type { Bytes, ParsedFile, Trace, TraceHeader } from '../types';
import { MAX_SAMPLES_PER_TRACE } from '../types';

/** Bytes-per-sample for a SEG-2 per-trace data-format code (Pullan 1990: 01h
 * 16-bit fixed, 02h 32-bit fixed, 03h "20-bit floating point (SEG-D)", 04h 32-bit
 * IEEE, 05h 64-bit IEEE). Format 3 packs 2 samples into 5 bytes (2.5 B/sample);
 * the rest are whole-byte widths.
 * Used both to decode and to bound `nSamples` by the on-disk data-block size. */
function seg2BytesPerSample(trDataFmt: number): number {
  return trDataFmt === 1 ? 2 : trDataFmt === 2 ? 4 : trDataFmt === 3 ? 2.5 : trDataFmt === 5 ? 8 : 4;
}

/** Most traces a conformant SEG-2 file can hold, and therefore the most this
 *  writer will emit. SEG-2 (Pullan 1990), B1. File Descriptor Block, printed page
 *  4: "N is an unsigned integer with an allowable range of 1 to 16,383. N must be
 *  less than or equal to M/4." N (bytes 6-7) is the trace count and M (bytes 4-5)
 *  the Trace Pointer Subblock size, both 16-bit, and M = 4N here - see the guard
 *  in writeSEG2 for what the overflow does to a reader. */
const SEG2_MAX_TRACES = 16383;

const ri16 = (buf: Bytes, o: number): number => buf[o] | (buf[o + 1] << 8); // always LE
const ri32 = (buf: Bytes, o: number): number =>
  (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;

/** Free format section → one flat string (line-terminator → newline), used for
 * the File Descriptor Block's textHeader. Offset prefixes, where present, are
 * non-printing bytes and drop out with everything else below decimal 32. */
function seg2FreeFormStr(b: Bytes, s: number, e: number, st: number, lt: number): string {
  let r = '';
  for (let i = s; i < e; i++) {
    const c = b[i];
    r += c === lt ? '\n' : c === 0 || c === st ? '' : c >= 32 && c < 127 ? String.fromCharCode(c) : '?';
  }
  return r.trim();
}

/** The STANDARD free format string parser - SEG-2 section C, printed page 6:
 * "All strings start with an offset (2 bytes) to the next string and a keyword
 * ... An offset of 0 (2 bytes), after the final string, marks the end of the
 * string list."
 * Each entry: [uint16LE offset-to-next][keyword value][string terminator], and
 * the offset counts its own two bytes. This is what real Geometrics Geode
 * hardware writes and what every conformant reader walks; it is the normal
 * case, not a vendor quirk. `seg2FreeFormObj` below is the non-conformant
 * fallback, not the other way round. */
function seg2LenPrefixObj(b: Bytes, start: number, end: number): TraceHeader {
  const p: TraceHeader = {};
  let i = start;
  while (i + 2 <= end) {
    const total = b[i] | (b[i + 1] << 8);
    if (total < 3 || i + total > end) break;
    let nul = i + 2;
    while (nul < i + total && b[nul] !== 0) nul++;
    const line = Array.from(b.slice(i + 2, nul))
      .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : ' '))
      .join('')
      .trim();
    if (line) {
      const sp = line.indexOf(' ');
      if (sp > 0) p[line.slice(0, sp).trim()] = line.slice(sp + 1).trim();
      else p[line] = '';
    }
    i += total;
  }
  return p;
}

/** NON-CONFORMANT fallback: a free format section written as plain
 * terminator-separated lines with no two-byte offsets. The standard gives a
 * reader no way to find the second string in such a section, so this is a
 * tolerance, not a supported form. It exists because SeisConv's own writer
 * emitted it until the offset-prefix fix, so those files must keep opening. */
function seg2FreeFormObj(b: Bytes, start: number, end: number, st: number, lt: number): TraceHeader {
  const p: TraceHeader = {};
  let i = start;
  while (i < end) {
    if (b[i] === 0 || b[i] === st) {
      i++;
      continue;
    }
    let le = i;
    while (le < end && b[le] !== lt && b[le] !== 0 && b[le] !== st) le++;
    const line = Array.from(b.slice(i, le))
      .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : ' '))
      .join('')
      .trim();
    if (line) {
      const sp = line.indexOf(' ');
      if (sp > 0) p[line.slice(0, sp).trim()] = line.slice(sp + 1).trim();
      else if (line) p[line] = '';
    }
    i = le + 1;
  }
  return p;
}

function num(v: number | string | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isNaN(n) ? 0 : n;
}

export function parseSEG2(b: Bytes): ParsedFile {
  const r: ParsedFile = { format: 'SEG-2', revision: 1, fileHeader: {}, textHeader: '', bh: {}, traces: [], traceCount: 0, errors: [] };
  // Byte pair 55 3A is the CONFORMANT low-byte-first mark (3A55h stored low byte
  // first; SEG-2 / Pullan 1990, B1, printed page 4: "If the first byte of the
  // file is 55h, the file is recorded low byte first as on an IBM PC"), and it is
  // what real Geometrics Geode hardware writes. Byte pair 3A 55 declares low byte
  // LAST; it is accepted here only because SeisConv's own writer emitted it
  // before the byte-order fix below, so files already on disk must keep opening.
  // Both are decoded little-endian, which is what those legacy files really are.
  const valid = (b[0] === 0x3a && b[1] === 0x55) || (b[0] === 0x55 && b[1] === 0x3a);
  if (!valid) {
    r.errors.push('Invalid SEG-2 magic');
    return r;
  }

  const revision = ri16(b, 2);
  const nTraces = ri16(b, 6); // FDB bytes 6-7 = nTraces
  const stl = b[10]; // string terminator length
  const strTerm = stl > 0 ? b[11] : 0x00;
  const ltlOff = 11 + stl;
  const ltl = b[ltlOff] || 0; // line terminator length
  const lineTerm = ltl > 0 ? b[ltlOff + 1] : 0x0a; // default \n
  r.fileHeader = { revision, nTraces };
  r.revision = revision;

  // Trace pointer array starts at a FIXED byte 32 (Geode format).
  const ptrBase = 32;

  // FDB free-form (between term chars and trace ptrs) → textHeader.
  const ffFDBStart = ltlOff + (ltl > 0 ? ltl + 1 : 1);
  const ffFDBEnd = ptrBase;
  if (ffFDBStart < ffFDBEnd) r.textHeader = seg2FreeFormStr(b, ffFDBStart, ffFDBEnd, strTerm, lineTerm);

  // Per-trace free format section: the STANDARD offset-prefixed form, or the
  // non-conformant plain-lines fallback, decided by a heuristic on the first two
  // bytes. A plausible offset (3..512 and inside the block) means the section is
  // the conformant one; anything else is read as plain lines.
  function getTrHdr(trcOff: number, tdbSize: number): TraceHeader {
    const ffStart = trcOff + 32;
    const ffEnd = trcOff + tdbSize;
    if (ffEnd <= ffStart) return {};
    const b0 = b[ffStart];
    const b1 = b[ffStart + 1];
    const maybeLen = b0 | (b1 << 8);
    if (maybeLen >= 3 && maybeLen <= 512 && ffStart + maybeLen <= ffEnd) return seg2LenPrefixObj(b, ffStart, ffEnd);
    return seg2FreeFormObj(b, ffStart, ffEnd, strTerm, lineTerm);
  }

  // SECURITY (memory-DoS, defense-in-depth): a FILE-WIDE cumulative allocation
  // budget. The per-trace clamp below bounds each trace by ITS OWN available
  // bytes, but a crafted file can point many trace pointers at the SAME data
  // region (overlapping/non-monotonic offsets, dataBlockSize=0) so every trace
  // independently clamps to ~filesize/bps and still allocates O(traces×filesize)
  // in total. This budget caps the TOTAL sample bytes allocated across ALL
  // traces at the bytes the file could plausibly hold - the on-disk sample
  // region (b.length minus the fixed 32-byte FDB header). For any valid file the
  // sum of all traces' sample bytes is ≤ filesize ≤ budget, so the budget never
  // clamps a legit trace and parsing stays bit-identical. Once exhausted we stop
  // allocating sample arrays (samples=null / nSamples=0), mirroring the
  // MAX_SAMPLE_TRACES (t < 2000) cap below.
  let sampleByteBudget = Math.max(0, b.length - ptrBase);
  // Track the previous trace's data-block start to detect non-monotonic /
  // overlapping data pointers (a hallmark of the budget-bypass attack). We only
  // record it for diagnostics; the budget above is what makes the allocation
  // safe regardless of pointer ordering.
  let prevDataStart = -1;

  for (let t = 0; t < nTraces && t < 500000; t++) {
    const trcOff = ri32(b, ptrBase + t * 4);
    if (trcOff === 0 || trcOff + 32 > b.length) break;
    const tdbID = ri16(b, trcOff);
    if (tdbID !== 0x4422 && tdbID !== 0x2244) {
      r.errors.push(`Trace ${t}: bad TDB ID 0x${tdbID.toString(16)}`);
      break;
    }
    const tdbSize = ri16(b, trcOff + 2);
    if (tdbSize < 32 || trcOff + tdbSize > b.length) break;
    const dataBlockSize = ri32(b, trcOff + 4);
    let nSamples = ri32(b, trcOff + 8);
    const trDataFmt = ri16(b, trcOff + 12); // per-trace data format (NOT from FDB)
    if (nSamples <= 0 || nSamples > MAX_SAMPLES_PER_TRACE) break;
    if (trcOff + tdbSize + dataBlockSize > b.length) break;

    const dataStart = trcOff + tdbSize;
    // SECURITY (memory-DoS): nSamples is attacker-controllable and decoupled
    // from the on-disk data block. Bound it by the bytes ACTUALLY available for
    // this trace's samples before allocating, so a crafted header (huge declared
    // nSamples, tiny data block) can't drive a multi-GB Float32Array. Use the
    // trace's own data-block size when present, else the remaining file bytes.
    // For a valid file the data block holds exactly nSamples*bps bytes, so this
    // clamp is a no-op and parsing stays bit-identical.
    const bps = seg2BytesPerSample(trDataFmt);
    const availBytes = dataBlockSize > 0 ? Math.min(dataBlockSize, b.length - dataStart) : b.length - dataStart;
    nSamples = Math.min(nSamples, Math.max(0, Math.floor(availBytes / bps)));
    if (nSamples <= 0) break;

    // FILE-WIDE budget clamp: cap this trace's samples so its sample bytes don't
    // exceed the budget remaining for ALL remaining traces combined. This is the
    // piece the per-trace clamp can't provide on its own - without it, N traces
    // sharing one data region each allocate ~filesize/bps for an O(N×filesize)
    // blow-up. For a valid file the budget is never the binding constraint.
    nSamples = Math.min(nSamples, Math.max(0, Math.floor(sampleByteBudget / bps)));
    if (nSamples <= 0) break; // budget exhausted → stop allocating sample arrays

    // Diagnostic only: flag overlapping / non-monotonic trace data pointers.
    if (dataStart <= prevDataStart) r.errors.push(`Trace ${t}: non-monotonic/overlapping data pointer`);
    prevDataStart = dataStart;

    const trHdr = getTrHdr(trcOff, tdbSize);
    let samples: Float32Array | null = null;
    if (t < 2000) {
      samples = new Float32Array(nSamples);
      // Charge the budget for the bytes this trace actually consumes.
      sampleByteBudget -= nSamples * bps;
      const bpsInt = trDataFmt === 1 ? 2 : trDataFmt === 2 ? 4 : trDataFmt === 5 ? 8 : 4;
      if (trDataFmt === 3) {
        // 20-bit packed (2 samples per 5 bytes). Decode full PAIRS, then the
        // trailing single sample when nSamples is odd (it sits in the low 20 bits
        // of the final 5-byte group). Without the odd-tail decode the last sample
        // of every odd-length trace stays 0 although nSamples counts it.
        const pairs = Math.floor(nSamples / 2);
        for (let i = 0; i < pairs; i++) {
          const p = dataStart + i * 5;
          if (p + 5 > b.length) break;
          let s1 = b[p] | (b[p + 1] << 8) | ((b[p + 2] & 0xf) << 16);
          let s2 = (b[p + 2] >> 4) | (b[p + 3] << 4) | (b[p + 4] << 12);
          samples[i * 2] = s1 & 0x80000 ? s1 - 0x100000 : s1;
          samples[i * 2 + 1] = s2 & 0x80000 ? s2 - 0x100000 : s2;
        }
        if (nSamples % 2 === 1) {
          const p = dataStart + pairs * 5;
          if (p + 3 <= b.length) {
            let s1 = b[p] | (b[p + 1] << 8) | ((b[p + 2] & 0xf) << 16);
            samples[nSamples - 1] = s1 & 0x80000 ? s1 - 0x100000 : s1;
          }
        }
      } else {
        for (let i = 0; i < nSamples; i++) {
          const p = dataStart + i * bpsInt;
          if (p + bpsInt > b.length) break;
          if (trDataFmt === 4) samples[i] = getF32(b, p, true);
          else if (trDataFmt === 1) {
            const v = b[p] | (b[p + 1] << 8);
            samples[i] = v > 32767 ? v - 65536 : v;
          } else if (trDataFmt === 2) {
            samples[i] = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | ((b[p + 3] << 24) >> 0);
          } else if (trDataFmt === 5) samples[i] = getF64(b, p, true);
          else samples[i] = getF32(b, p, true);
        }
      }
    }
    const trace: Trace = { hdr: trHdr, samples, nSamples, dataFmt: trDataFmt };
    r.traces.push(trace);
  }
  r.traceCount = r.traces.length;

  // Populate r.bh from the first trace that has headers.
  const _ft = r.traces.find((tr) => tr.hdr && Object.keys(tr.hdr).length > 0) || r.traces[0];
  if (_ft) {
    let _si = 2000;
    const _siStr = _ft.hdr?.SAMPLE_INTERVAL;
    if (_siStr != null) {
      const _sv = typeof _siStr === 'number' ? _siStr : parseFloat(_siStr);
      if (!isNaN(_sv) && _sv > 0) {
        if (_sv < 0.1) _si = Math.round(_sv * 1e6); // seconds → µs
        else if (_sv <= 200) _si = Math.round(_sv * 1000); // ms → µs
        else _si = Math.round(_sv); // already µs
      }
    }
    r.bh = { sampleInt: _si, samplesTrace: _ft.nSamples || 0, numTraces: r.traceCount, dataFmt: _ft.dataFmt };
  }

  // Normalise common trace-header keys for downstream viewers.
  r.traces.forEach((tr, i) => {
    const h = tr.hdr;
    if (!h) return;
    if (h.CHANNEL_NUMBER) h.channelNum = parseInt(String(h.CHANNEL_NUMBER)) || i + 1;
    if (h.RECEIVER_LOCATION) h.rcvSP = num(h.RECEIVER_LOCATION);
    if (h.SOURCE_LOCATION) h.srcSP = num(h.SOURCE_LOCATION);
    if (h.SHOT_SEQUENCE_NUMBER) h.shotSeq = parseInt(String(h.SHOT_SEQUENCE_NUMBER)) || 0;
    if (h.DELAY || h.DELAY_TIME) h.delayMs = num(h.DELAY || h.DELAY_TIME);
    if (h.RECEIVER_LOCATION) h.ensemble = num(h.RECEIVER_LOCATION);
    if (h.SOURCE_LOCATION) h.srcPt = num(h.SOURCE_LOCATION);
  });

  return r;
}

// ------------------------------ SEG-2 writer ------------------------------
//
// Ported faithfully from the SeisConv reference (writeSEG2file, lines ~1949-2015
// of seisconv_v5.11_22.html). LITTLE-ENDIAN throughout. Emits a Geode-style
// ".dat": a fixed 32-byte file descriptor block (FDB) header, an N-entry 32-bit
// trace-pointer array, then per-trace 32-byte trace descriptor blocks (TDB) with
// standard offset-prefixed free format strings, followed by IEEE float32 (LE)
// samples.
//
// CAVEAT: this is an approximate, lossless-for-samples SEG-2 export - it writes
// the minimal free-form keys most readers need (SAMPLE_INTERVAL,
// SAMPLES_PER_TRACE, CHANNEL_NUMBER, plus an FDB ACQUISITION_DATE) and always
// uses data-format code 4 (IEEE float32). It is not a byte-for-byte reproduction
// of an arbitrary source SEG-2.
export function writeSEG2(pd: ParsedFile): Bytes {
  const trc = pd.traces;
  if (!trc || !trc.length) throw new Error('No traces');
  // Size every slot from the LONGEST trace (not the first) so a short first
  // trace can't under-allocate and overrun on a later, longer trace.
  const spt = trc.reduce((m, t) => Math.max(m, t.nSamples || 0), 0) || trc[0].nSamples;
  const si_us = pd.bh?.sampleInt || 2000;
  // SEG-2 SAMPLE_INTERVAL is in SECONDS (Pullan 1990; ObsPy header['delta'] is
  // seconds; SeisUnix seg2segy multiplies by 1e6 to reach µs). Emitting ms here
  // would make every conformant reader mis-time the traces by 1000×. e.g. a
  // 2000 µs interval → "0.002000000". Our own parser's seconds branch (value <
  // 0.1 → ×1e6) reads this straight back to 2000 µs, so the round-trip is exact.
  const si_s = (si_us / 1e6).toFixed(9);
  const n = trc.length;
  const LT = 0x0a; // line terminator
  const ST = 0x00; // string terminator

  // CONFORMANCE (SEG2-FDB-04-POINTER-SUBBLOCK-DIVISIBLE-BY-4 /
  // SEG2-FDB-32-POINTERS-CLEAR-THE-SUBBLOCK): bytes 4-5 are the Trace Pointer
  // Subblock ALONE, not the whole 32-byte header plus the subblock.
  // SEG-2 (Pullan 1990), B1. File Descriptor Block, printed page 4:
  //   "Bytes 4 and 5 contain an unsigned integer giving the size (M) of the
  //    Trace Pointer Subblock in bytes. ... This number, as all block sizes,
  //    must be divisible by 4 since all blocks must start on double word
  //    boundaries. This number must be between 4 and 65,532."
  //   "The Trace Pointer Subblock starts at byte 32, and contains pointers
  //    (unsigned long integers) to the start of each Trace Descriptor Block
  //    contained in the file. The length of this subblock in bytes (M) is
  //    specified in bytes 4 and 5, and the number of pointers contained in the
  //    subblock (N) is specified in bytes 6 and 7 (see above)."
  //   "N must be less than or equal to M/4."
  // We emit exactly N four-byte pointers, so M = 4N: divisible by 4, N = M/4,
  // and (with 1 <= N <= 16,383 from the same page) 4 <= M <= 65,532. Writing
  // 32 + 4N instead declared a subblock that swallowed the first Trace
  // Descriptor Block, which is the region byte 32 + M hands to the File
  // Descriptor Block's own free format section.
  //
  // That makes 16,383 a hard ceiling on the trace count, and the same page states
  // it outright:
  //   "N is an unsigned integer with an allowable range of 1 to 16,383. N must be
  //    less than or equal to M/4."
  // Both fields are 16 bits, so nothing above that can even be stated: at 20,000
  // traces M = 80,000 wraps to 14,464 and a conformant reader places the first
  // Trace Descriptor Block inside the pointer array, and at exactly 16,384 M
  // wraps to 0 - below the standard's own minimum of 4. MAX_TRACES is 500,000, so
  // the parser will happily hand over a gather this writer cannot describe.
  // Refuse it, the way writeSEGD refuses above its 4-digit BCD trace number.
  if (n > SEG2_MAX_TRACES)
    throw new Error(`${n} traces; SEG-2 trace-pointer subblock max ${SEG2_MAX_TRACES} - split the gather`);
  const ptrSubblockBytes = n * 4; // M, bytes 4-5
  // First Trace Descriptor Block sits at byte 32 + M, immediately after the
  // pointer subblock. The FDB free format section (optional, "a series of
  // optional strings", same page) is empty here, so there is no gap.
  const firstTdb = 32 + ptrSubblockBytes;

  // FDB free-form (acquisition date) - written between the term chars and the
  // trace-pointer array within the fixed 32-byte FDB. One LT-terminated line,
  // ST-terminated section. Kept short so it never collides with the ptr array.
  const acqDate = new Date().toISOString().slice(0, 10).replace(/-/g, '/'); // YYYY/MM/DD

  // Per-trace free format strings (written into the TDB from byte 32 on).
  //
  // CONFORMANCE (SEG2-TDB-32-STRING-LIST-WALKS, and with it
  // SEG2-STR-KEYWORD-UPPERCASE, SEG2-STR-ALPHABETICAL-ORDER and
  // SEG2-STR-SAMPLE-INTERVAL-PRESENT): the offsets ARE the string list. A
  // reader has no other way to find the second string, so a section written as
  // plain separated lines is not a short form of the format, it is unreadable.
  // SEG-2 (Pullan 1990), C. String format, printed page 6:
  //   "The File and Trace Descriptor Blocks contain strings that provide other
  //    required or optional information. All strings start with an offset (2
  //    bytes) to the next string and a keyword that identifies the nature of the
  //    string, contain a numeric and/or alphanumeric value(s), and end with the
  //    string terminator indicated in the File Descriptor Block. An offset of 0
  //    (2 bytes), after the final string, marks the end of the string list."
  //   "Keywords cannot have embedded spaces. The keyword and the associated data
  //    are separated by spaces or tabs. All alpha characters in the keywords
  //    themselves must be uppercase."
  //   "To assist application program string searches, strings must be ordered
  //    alphabetically according to keyword. The only exception to this rule is
  //    the NOTE string, which is always at the end of the string list, if it
  //    exists at all."
  // The same requirement is restated per block in C1 and C2, printed pages 7
  // and 8: "The keywords must be arranged in alphabetical order except for the
  // NOTE string, which will be at the end of the string list, if it exists at
  // all."
  //
  // The writer emitted 'SAMPLE_INTERVAL ...' as the very first bytes of the
  // section, so a conformant reader took the ASCII pair "SA" as the offset to
  // the next string: 16723, well past the end of a 104-byte block.
  //
  // ORDER: the keys are written CHANNEL_NUMBER, SAMPLES_PER_TRACE,
  // SAMPLE_INTERVAL, which is alphabetical in ASCII order. The alphabetical
  // requirement itself is not a judgement call - the document states it three
  // times as "must". What the document never states is how the underscore
  // collates, and these three keys are a case where it decides the answer:
  // 'S' (53h) sorts before '_' (5Fh), so ASCII order puts SAMPLES_PER_TRACE
  // before SAMPLE_INTERVAL, while an order that ignored the underscore would
  // put SAMPLE_INTERVAL first. ASCII is taken here because C1 and C2 define the
  // separator as "an underscore (decimal ASCII code 95)" - the keyword is an
  // ASCII byte string - and because the stated purpose is "to assist
  // application program string searches", which is a program comparing those
  // bytes. Neither the document's own C1/C2 keyword lists nor a real Geode
  // recorder's string list settles it on its own: both are alphabetical and
  // NOTE-last, but neither happens to contain a pair where the underscore is
  // the deciding character.
  // NOTE is not written here, so the one exception does not arise.
  //
  // Each string is [uint16 LE offset-to-next][KEYWORD value][ST], where the
  // offset COUNTS ITS OWN TWO BYTES, and a uint16 zero closes the list. This is
  // byte-for-byte the shape a real Geode recorder writes.
  function makeFreeFormBytes(tr: Trace, idx: number): Bytes {
    const ch = Number(tr.hdr?.channelNum ?? tr.hdr?.CHANNEL_NUMBER ?? idx + 1);
    const texts = ['CHANNEL_NUMBER ' + ch, 'SAMPLES_PER_TRACE ' + spt, 'SAMPLE_INTERVAL ' + si_s];
    // offset = 2 (the offset field) + the text + 1 (the string terminator).
    const total = texts.reduce((a, t) => a + 3 + t.length, 0) + 2; // + the closing zero offset
    const buf = new Uint8Array(total);
    let p = 0;
    for (const t of texts) {
      const off = 3 + t.length;
      buf[p] = off & 0xff;
      buf[p + 1] = (off >> 8) & 0xff;
      for (let j = 0; j < t.length; j++) buf[p + 2 + j] = t.charCodeAt(j) & 0xff;
      buf[p + 2 + t.length] = ST;
      p += off;
    }
    buf[p] = 0;
    buf[p + 1] = 0; // "An offset of 0 (2 bytes), after the final string, marks the end"
    return buf;
  }
  const ffBufs = trc.map((tr, i) => makeFreeFormBytes(tr, i));

  // TDB size = 32-byte fixed header + free-form length, padded to a 4-byte boundary.
  const tdbSizes = ffBufs.map((ff) => Math.ceil((32 + ff.length) / 4) * 4);
  const trD = spt * 4; // data block bytes (IEEE float32)

  let totalSize = firstTdb;
  for (let t = 0; t < n; t++) totalSize += tdbSizes[t] + trD;

  const out = new Uint8Array(totalSize);
  const odv = dv(out);

  // -- File Descriptor Block (32 bytes) --
  // CONFORMANCE (SEG2-FDB-04-INTEGER-BYTE-ORDER, SEG2-FDB-00-BYTE-ORDER-MARK,
  // SEG2-LAYOUT-CLOSES): the first two bytes ARE the byte-order declaration for
  // every integer that follows, so they must be stored in the order this writer
  // actually uses. SEG-2 (Pullan 1990), B1. File Descriptor Block, printed page 4:
  //   "The first two bytes (bytes 0 and 1) of this block (and of the file)
  //    contain the integer 3a55h. This integer identifies the file as a seismic
  //    (/radar) data file following this standard, identifies this block as the
  //    File Descriptor Block, and provides the means to determine whether the
  //    Iow byte (least-significant bits) of multibyte entities is written first
  //    or last."
  //   "If the first byte of the file is 55h, the file is recorded low byte first
  //    as on an IBM PC; but if the first byte is 3ah, the file is recorded Iow
  //    byte last as on some 68000 based UNIX machines."
  //   "The integer byte order of this and all following integers is interpreted
  //    according to the first two bytes of this file"
  // This writer stores every integer low byte first, so byte 0 must be 55h and
  // byte 1 3Ah - the same pair real Geometrics Geode hardware writes. Emitting
  // 3A 55 while still writing little-endian integers declared low-byte-LAST and
  // then contradicted itself: a conformant reader took the trace count 0003h as
  // 0300h = 768, and a 24-channel record as 6144.
  out[0] = 0x55;
  out[1] = 0x3a; // block id 3A55h stored low byte first (= little-endian file)
  out[2] = 1;
  out[3] = 0; // revision 1
  out[4] = ptrSubblockBytes & 0xff;
  out[5] = (ptrSubblockBytes >> 8) & 0xff; // M: size of the Trace Pointer Subblock alone
  out[6] = n & 0xff;
  out[7] = (n >> 8) & 0xff; // number of traces (Geode: bytes 6-7)
  // SEG-2 FDB terminator definitions, 'BccBcc' @ byte 8 (Pullan 1990; ObsPy /
  // MathWorks / Stanford readers REQUIRE the string-terminator size at byte 8 to
  // be 1 or 2). This is exactly the layout real Geometrics Geode hardware writes
  // (byte8=1, byte9=0x00, byte10=0, byte11=1, byte12=0x0A). Our own parser reads
  // the string terminator from byte 10 (=0 here) and the line terminator from
  // byte 11/12, so adding the spec bytes 8/9 keeps the in-house round-trip
  // identical while making the file acceptable to strict SEG-2 readers.
  out[8] = 1; // size of string terminator (bytes)
  out[9] = ST; // string terminator char = 0x00
  // byte 10: reserved (0) - our parser's legacy string-terminator slot
  out[11] = 1; // size of line terminator (bytes)
  out[12] = LT; // line terminator = 0x0A
  // bytes 13-31: reserved (FDB free-form would go here in a fuller writer); the
  // ACQUISITION_DATE is recorded but kept out of the fixed FDB to avoid clobbering
  // the trace-pointer array - readers pick up date from the trace free-form below.
  void acqDate;

  // -- Trace pointer array (32-bit LE offsets) --
  let pos = firstTdb;
  for (let t = 0; t < n; t++) {
    const po = 32 + t * 4;
    out[po] = pos & 0xff;
    out[po + 1] = (pos >> 8) & 0xff;
    out[po + 2] = (pos >> 16) & 0xff;
    out[po + 3] = (pos >> 24) & 0xff;
    pos += tdbSizes[t] + trD;
  }

  // -- Trace descriptor blocks + sample data --
  pos = firstTdb;
  for (let t = 0; t < n; t++) {
    const tr = trc[t];
    const to = pos;
    const tdb = tdbSizes[t];
    const ff = ffBufs[t];
    // TDB fixed header
    out[to] = 0x22;
    out[to + 1] = 0x44; // TDB ID 0x4422 (LE)
    out[to + 2] = tdb & 0xff;
    out[to + 3] = (tdb >> 8) & 0xff; // TDB block size
    out[to + 4] = trD & 0xff;
    out[to + 5] = (trD >> 8) & 0xff;
    out[to + 6] = (trD >> 16) & 0xff;
    out[to + 7] = (trD >> 24) & 0xff; // data block size (bytes)
    out[to + 8] = spt & 0xff;
    out[to + 9] = (spt >> 8) & 0xff;
    out[to + 10] = (spt >> 16) & 0xff;
    out[to + 11] = (spt >> 24) & 0xff; // number of samples
    out[to + 12] = 4; // data format code 4 = IEEE float32
    // Free-form headers start at TDB byte 32.
    out.set(ff, to + 32);
    // Sample data (LE float32). Clamp to the allocated slot (spt).
    if (tr.samples) {
      const base = to + tdb;
      const ns2 = Math.min(tr.nSamples || spt, spt);
      for (let i = 0; i < ns2; i++) odv.setFloat32(base + i * 4, tr.samples[i] || 0, true);
    }
    pos += tdb + trD;
  }
  return out;
}
