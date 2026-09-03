// seisconv-core - SEG-D parser + writer (Rev 1 / 2.1 / 3.0, demultiplexed)
//
// READER: decodes the general-header region to the SEG-D spec - GH1 at the true
// offsets (year b[10], julian day b[11-12], base scan interval b[22] in binary
// 1/16-ms units, record length b[25-26], scan types b[27], channel sets b[28],
// extended/external header counts b[30-31] with the 0xFF → GH2 indirection),
// GH2 (revision at bytes 10-11, extended file number / record length, the rev-3
// additional-GH-block and external-header counts), 32-byte (rev ≤ 2) or 96-byte
// (rev 3) channel-set descriptors, then per-trace 20-byte demux trace headers +
// 32-byte trace-header extensions (per-trace ns and receiver line/point from
// THE1). Field map taken from SEG-D Rev 2.1 (SEG Field Tape Standards, January 2006)
// and Rev 3.1 (October 2015), and verified against real iX1 NT SEG-D 2.1 and 3.0 shots whose
// samples are bit-identical to the vendor's paired SEG-Y (2026 field QC).
//
// Files written by SeisConv's own pre-spec writer (non-standard offsets) are
// detected by their layout signature and routed through a frozen legacy decoder
// so previously exported .segd files keep opening.
//
// Sample formats: 32-bit IEEE float (standard code 8058, plus the legacy
// SeisConv-internal codes 0032/8032), 24-bit two's-complement int (standard code
// 8036, plus the non-standard 8068/0068 seen from vendor files), 20-bit binary
// (standard code 8015 - 2.5 bytes/sample; also the fallback for unknown codes).
// The standard format-code table is SEG-D Rev 3.1 (Oct 2015) General Header #1
// bytes 3-4; it lists 8015/8022/8024/8036/8038/8042/8044/8048/8058/8080 and the
// little-endian 90xx variants. 8068 is NOT in it.

import { bcd2, dv, r32u, rIEEE, w32 } from '../binary';
import type { Bytes, ParsedFile, Trace, TraceHeader } from '../types';
import { MAX_SAMPLE_TRACES, MAX_SAMPLES_PER_TRACE, MAX_TRACES } from '../types';

// Legacy SeisConv-internal base-scan-interval CODES → microseconds. These are
// NOT a SEG-D revision's encoding: in every published revision GH1 byte 23 is a
// binary number with LSB = 1/16 ms (SEG-D Rev 3.1, Oct 2015, GH1 byte 23), which
// is handled inline below. Kept only so previously written SeisConv files open.
const BSI_TABLE: Record<number, number> = { 1: 4000, 2: 2000, 3: 1000, 4: 500, 5: 250, 6: 125, 7: 62.5, 8: 31.25, 9: 16, 10: 8 };

// -- tiny big-endian helpers (SEG-D is big-endian throughout) --
const r16 = (b: Bytes, o: number): number => (b[o] << 8) | b[o + 1];
const r24 = (b: Bytes, o: number): number => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const r24s = (b: Bytes, o: number): number => { const v = r24(b, o); return v & 0x800000 ? v - 0x1000000 : v; };
const bcd4 = (b: Bytes, o: number): number => bcd2(b[o]) * 100 + bcd2(b[o + 1]);

/** Bits per sample for a SEG-D format code (BCD bytes 2-3). */
function fmtBits(fmtCode: number): number {
  // 8058 = 32-bit IEEE float demux (the standard code); 0032/8032 are legacy
  // SeisConv-internal IEEE codes kept for previously written files.
  if (fmtCode === 8058 || fmtCode === 32 || fmtCode === 8032) return 32;
  // 8036 = 24-bit two's-complement integer demux (the standard code, SEG-D Rev
  // 2.1 §"Additional Valid Format Codes" / Rev 3.1 GH1 bytes 3-4); 8068/0068 are
  // non-standard codes seen in the wild and decoded the same way.
  if (fmtCode === 8036 || fmtCode === 36 || fmtCode === 8068 || fmtCode === 68) return 24;
  return 20; // 20-bit binary (standard code 8015) and unknown codes
}

/** One channel-set descriptor, reduced to what the trace walk needs. */
interface ChanSet {
  scanType: number;
  csNum: number;
  /** 1 = seismic, other codes are aux/time-break/etc - all are stored on disk. */
  chanType: number;
  chanCount: number;
  /** 32-byte trace-header extensions per trace in this set. */
  theCount: number;
  /** Samples per trace derived from the descriptor (fallback when THE1 absent). */
  ns: number;
  siUs: number;
}

/**
 * Old SeisConv writer layout (pre-spec): it stamped numChanSets|addl into b[22]
 * (always 0x11) and never wrote scan types (b[27]) / channel sets (b[28]) - a
 * combination no conformant file can have (b[22] is the base scan interval and
 * b[27-28] are ≥ 1 BCD on every real record).
 */
function isLegacySeisConvSEGD(b: Bytes): boolean {
  return b[22] === 0x11 && b[27] === 0 && b[28] === 0;
}

export function parseSEGD(b: Bytes): ParsedFile {
  const r: ParsedFile = { format: 'SEG-D', revision: 1, gh1: {}, bh: {}, traces: [], traceCount: 0, errors: [] };
  if (b.length < 64) {
    r.errors.push('File too small');
    return r;
  }
  if (isLegacySeisConvSEGD(b)) return parseLegacySeisConvSEGD(b);

  const fmtCode = bcd4(b, 2);
  const bits = fmtBits(fmtCode);

  // -- General Header Block 1 --
  const fileNumRaw = r16(b, 0);
  let fileNum = fileNumRaw === 0xffff ? -1 : bcd4(b, 0); // 0xFFFF → extended (GH2)
  const year = 2000 + bcd2(b[10]);
  const addlNib = (b[11] >> 4) & 0xf; // additional 32-byte general-header blocks (0xF → GH2, rev 3)
  const julDay = (b[11] & 0xf) * 100 + bcd2(b[12]);
  const hour = bcd2(b[13]), minute = bcd2(b[14]), second = bcd2(b[15]);
  // Base scan interval: binary, in units of 1/16 ms (0x08 → 0.5 ms = 500 µs).
  const baseSiUs = b[22] > 0 ? b[22] * 62.5 : 0;
  const recLenRaw = ((b[25] & 0xf) << 8) | b[26]; // 0xFFF → extended record length (GH2)
  const scanTypes = bcd2(b[27]) || 1;
  const csRaw = b[28]; // channel sets per scan type (BCD; 0xFF → GH2)
  const extRaw = b[30]; // extended header blocks (BCD; 0xFF → GH2)
  const extlRaw = b[31]; // external header blocks (BCD; 0xFF → GH2)

  let addlGH = addlNib === 0xf ? 0 : addlNib;
  let csPerScan = csRaw === 0xff ? 0 : bcd2(csRaw);
  let extHdr = extRaw === 0xff ? 0 : bcd2(extRaw);
  let extlHdr = extlRaw === 0xff ? 0 : bcd2(extlRaw);
  let recordLenMs = recLenRaw === 0xfff ? 0 : recLenRaw * 512; // 0.512-s increments (rev ≤ 2)

  // -- General Header Block 2 (revision + the extended/0xFF-indirected fields) --
  let revMajor = 1, revMinor = 0;
  if (addlNib >= 1) {
    const g = 32;
    const maj = b[g + 10], min = b[g + 11];
    if (maj >= 1 && maj <= 3) { revMajor = maj; revMinor = min; }
    if (fileNum < 0) fileNum = r24(b, g + 0);
    if (csRaw === 0xff) csPerScan = r16(b, g + 3);
    if (extRaw === 0xff) extHdr = r16(b, g + 5);
    // Rev 3 moved the external-header count (observed at GH2[28-29] on real iX1
    // 3.0, matching its header-block accounting); rev ≤ 2 keeps it at GH2[7-8].
    if (extlRaw === 0xff) extlHdr = revMajor >= 3 ? r16(b, g + 28) : r16(b, g + 7);
    // Rev 3: the true additional-GH-block count lives at GH2[23] when GH1's
    // nibble saturates at 0xF (real iX1 3.0 writes 15 extra blocks).
    if (addlNib === 0xf) addlGH = revMajor >= 3 ? b[g + 23] : addlNib;
    if (recLenRaw === 0xfff) {
      if (revMajor >= 3) {
        // Extended record length in MICROSECONDS (48-bit BE at GH2[14-19]).
        const us = r24(b, g + 14) * 0x1000000 + r24(b, g + 17);
        recordLenMs = Math.round(us / 1000);
      } else {
        recordLenMs = r24(b, g + 14); // extended record length in ms (GH2[14-16])
      }
    }
  }
  r.revision = revMajor;

  // -- Channel-set descriptors: 32 bytes (rev ≤ 2) / 96 bytes (rev 3) --
  const totalGHBytes = (1 + addlGH) * 32;
  const csdSize = revMajor >= 3 ? 96 : 32;
  const nCS = Math.min(scanTypes * Math.max(csPerScan, 1), 1024); // DoS bound
  const chanSets: ChanSet[] = [];
  let off = totalGHBytes;
  for (let i = 0; i < nCS && off + csdSize <= b.length; i++, off += csdSize) {
    if (revMajor >= 3) {
      const startUs = r32u(b, off + 4), endUs = r32u(b, off + 8);
      const siUs = r24(b, off + 23) || baseSiUs;
      let ns = r32u(b, off + 12);
      if (!(ns >= 1) && siUs > 0) ns = Math.round((endUs - startUs) / siUs) + 1;
      chanSets.push({
        scanType: b[off], csNum: r16(b, off + 1), chanType: (b[off + 3] >> 4) & 0xf,
        chanCount: r24(b, off + 20), theCount: b[off + 27],
        ns: Math.min(Math.max(ns, 0), MAX_SAMPLES_PER_TRACE), siUs,
      });
    } else {
      const startMs = r16(b, off + 2) * 2, endMs = r16(b, off + 4) * 2; // 2-ms units
      const siUs = baseSiUs || 2000;
      const ns = siUs > 0 ? Math.round(((endMs - startMs) * 1000) / siUs) + 1 : 0;
      chanSets.push({
        scanType: bcd2(b[off]), csNum: bcd2(b[off + 1]), chanType: (b[off + 10] >> 4) & 0xf,
        chanCount: bcd4(b, off + 8), theCount: b[off + 28],
        ns: Math.min(Math.max(ns, 0), MAX_SAMPLES_PER_TRACE), siUs,
      });
    }
  }
  off += (extHdr + extlHdr) * 32;

  const seisCS = chanSets.find((c) => c.chanType === 1) || chanSets[0];
  const siUs = (seisCS?.siUs || baseSiUs) || 2000;
  const totalChans = chanSets.reduce((s, c) => s + (c.chanCount > 0 ? c.chanCount : 0), 0);

  r.gh1 = {
    fileNum: fileNum > 0 ? fileNum : 0, fmtCode, year, julDay, hour, minute, second,
    numChanSets: chanSets.length, extHdrLen: extHdr, extlHdrLen: extlHdr,
    recordLenMs, revMajor, revMinor,
  };
  r.bh = { sampleInt: siUs, samplesTrace: seisCS?.ns || 0 };
  if (bits === 20 && fmtCode !== 8015) r.errors.push(`SEG-D format code ${fmtCode} not fully supported - decoding as 20-bit packed`);

  // -- Demultiplexed trace records: 20-byte header + THE×32 + samples --
  // Trust the declared channel geometry for the trace COUNT when it's sane -
  // it stops the walk before any rev-3 general trailer / trailing junk.
  let tc = 0;
  let clipNoted = false;
  while (off + 20 <= b.length && tc < MAX_TRACES && (totalChans === 0 || tc < totalChans)) {
    const scanType = bcd2(b[off + 2]);
    const csNum = bcd2(b[off + 3]);
    const trcNum = bcd4(b, off + 4);
    const tFileRaw = r16(b, off);
    const tFile = tFileRaw === 0xffff ? r24(b, off + 17) : bcd4(b, off);
    const the = b[off + 9];
    const cs = chanSets.find((c) => c.csNum === csNum && c.scanType === scanType) || seisCS;

    const theBase = off + 20;
    const dataOff = theBase + the * 32;
    if (dataOff >= b.length) break;
    const remBytes = b.length - dataOff;
    const maxNsRoom = Math.floor(bits === 20 ? (remBytes * 2) / 5 : remBytes / (bits === 32 ? 4 : 3));

    // ns: per-trace THE1 first (authoritative - 24-bit at [7-9] in rev ≤ 2,
    // 32-bit at [24-27] in rev 3), then the channel-set value, then the room left.
    let ns = 0;
    if (the >= 1 && theBase + 32 <= b.length) ns = revMajor >= 3 ? r32u(b, theBase + 24) : r24(b, theBase + 7);
    if (!(ns >= 1 && ns <= MAX_SAMPLES_PER_TRACE)) ns = cs?.ns || 0;
    if (!(ns >= 1)) ns = Math.min(maxNsRoom, MAX_SAMPLES_PER_TRACE);
    if (ns > maxNsRoom) {
      ns = maxNsRoom;
      if (!clipNoted) { clipNoted = true; r.errors.push(`SEG-D: trace ${tc + 1} data runs past the file end - clipped (truncated file?)`); }
    }
    if (ns <= 0) break;

    const hdr: TraceHeader = { trcNum, trcField: trcNum, fieldRec: tFile || (fileNum > 0 ? fileNum : 0), chanSet: csNum, nSamples: ns };
    if (the >= 1 && theBase + 32 <= b.length) {
      // THE1: receiver line/point/index. Rev 3 leaves the legacy 24-bit fields
      // at 0xFFFFFF and carries the values in the 5-byte extended fields - read
      // the integer part of those when the legacy fields are unset.
      let line = r24s(b, theBase);
      let point = r24s(b, theBase + 3);
      if (line === -1 || line === 0) line = r24s(b, theBase + 10);
      if (point === -1 || point === 0) point = r24s(b, theBase + 15);
      if (line !== 0 && line !== -1) hdr.rcvLine = line;
      if (point !== 0 && point !== -1) hdr.rcvPoint = point;
      if (b[theBase + 6]) hdr.rcvIdx = b[theBase + 6];
    }

    let samples: Float32Array | null = null;
    if (tc < MAX_SAMPLE_TRACES) {
      samples = new Float32Array(ns);
      if (bits === 32) {
        for (let i = 0; i < ns; i++) samples[i] = rIEEE(b, dataOff + i * 4);
      } else if (bits === 24) {
        for (let i = 0; i < ns; i++) {
          let v = r24(b, dataOff + i * 3);
          if (v & 0x800000) v -= 0x1000000;
          samples[i] = v;
        }
      } else {
        // 20-bit packed: 2 samples per 5 bytes; odd tail occupies the first
        // 2.5 bytes of the final group.
        const pairs = Math.floor(ns / 2);
        for (let i = 0; i < pairs; i++) {
          const p = dataOff + i * 5;
          if (p + 5 > b.length) break;
          const s1 = (b[p] << 12) | (b[p + 1] << 4) | ((b[p + 2] >> 4) & 0xf);
          const s2 = ((b[p + 2] & 0xf) << 16) | (b[p + 3] << 8) | b[p + 4];
          samples[i * 2] = s1 & 0x80000 ? s1 - 0x100000 : s1;
          samples[i * 2 + 1] = s2 & 0x80000 ? s2 - 0x100000 : s2;
        }
        if (ns % 2 === 1) {
          const p = dataOff + pairs * 5;
          if (p + 3 <= b.length) {
            const s1 = (b[p] << 12) | (b[p + 1] << 4) | ((b[p + 2] >> 4) & 0xf);
            samples[ns - 1] = s1 & 0x80000 ? s1 - 0x100000 : s1;
          }
        }
      }
    }
    r.traces.push({ hdr, samples, nSamples: ns, dataFmt: bits });
    tc++;
    off = dataOff + (bits === 20 ? Math.ceil((ns * 5) / 2) : ns * (bits === 32 ? 4 : 3));
  }
  r.traceCount = tc;
  if (totalChans > 0 && tc < totalChans)
    r.errors.push(`SEG-D: channel sets declare ${totalChans} traces but only ${tc} could be read (truncated file?)`);
  return r;
}

/**
 * Frozen decoder for .segd files written by SeisConv's pre-spec writer (wrong
 * GH1 offsets; see isLegacySeisConvSEGD). Kept verbatim so old exports open.
 */
function parseLegacySeisConvSEGD(b: Bytes): ParsedFile {
  const r: ParsedFile = { format: 'SEG-D', revision: 1, gh1: {}, bh: {}, traces: [], traceCount: 0, errors: [] };
  const fmtCode = bcd2(b[2]) * 100 + bcd2(b[3]);
  const addlBlocks = (b[10] >> 4) & 0xf;
  const numChanSets = (b[22] >> 4) & 0xf;
  const extHdrLen = (b[23] >> 4) & 0xf;
  const extlHdrLen = b[23] & 0xf;
  r.gh1 = {
    fileNum: bcd2(b[0]) * 100 + bcd2(b[1]),
    fmtCode,
    year: 2000 + bcd2(b[9]),
    julDay: ((b[10] & 0xf) << 8) | b[11],
    numChanSets,
    extHdrLen,
    extlHdrLen,
  };
  const bsiCode = (b[21] >> 4) & 0xf;
  const si_us = BSI_TABLE[bsiCode] || 2000;
  r.bh = { sampleInt: si_us };

  const bpsStored = bcd2(b[18]) * 10000 + bcd2(b[19]) * 100 + bcd2(b[20]);
  const bpsBits = fmtBits(fmtCode);
  const bytesPerSamp = bpsBits === 32 ? 4 : bpsBits === 24 ? 3 : 2.5;
  const sptStored = bpsStored > 0 && bytesPerSamp > 0 ? Math.round(bpsStored / bytesPerSamp) : 0;

  let off = 32;
  if (addlBlocks >= 1 && off + 32 <= b.length) {
    if (b[off + 31] === 0xff) r.revision = 3;
    off += 32 + Math.max(0, addlBlocks - 1) * 32;
  }
  for (let cs = 0; cs < (numChanSets || 1) && off + 32 <= b.length; cs++) off += 32;
  off += extHdrLen * 32 + extlHdrLen * 32;

  let tc = 0;
  while (off + 20 < b.length && tc < MAX_TRACES) {
    const trcNum = r32u(b, off + 4);
    off += 20;
    const rem = b.length - off;
    if (rem <= 0) break;
    let samples: Float32Array | null = null;
    let ns = 0;
    if (bpsBits === 32) {
      ns = sptStored > 0 ? sptStored : Math.floor(rem / 4);
      ns = Math.min(ns, Math.floor(rem / 4), MAX_SAMPLES_PER_TRACE);
      if (ns <= 0) break;
      if (tc < MAX_SAMPLE_TRACES) {
        samples = new Float32Array(ns);
        for (let i = 0; i < ns; i++) samples[i] = rIEEE(b, off + i * 4);
      }
      off += ns * 4;
    } else if (bpsBits === 24) {
      ns = sptStored > 0 ? sptStored : Math.floor(rem / 3);
      ns = Math.min(ns, Math.floor(rem / 3), MAX_SAMPLES_PER_TRACE);
      if (ns <= 0) break;
      if (tc < MAX_SAMPLE_TRACES) {
        samples = new Float32Array(ns);
        for (let i = 0; i < ns; i++) {
          let v = r24(b, off + i * 3);
          if (v & 0x800000) v -= 0x1000000;
          samples[i] = v;
        }
      }
      off += ns * 3;
    } else {
      ns = sptStored > 0 ? sptStored : Math.floor((rem * 2) / 5);
      ns = Math.min(ns, Math.floor((rem * 2) / 5), MAX_SAMPLES_PER_TRACE);
      const nb = Math.ceil((ns * 5) / 2);
      if (ns <= 0) break;
      if (tc < MAX_SAMPLE_TRACES) {
        samples = new Float32Array(ns);
        const pairs = Math.floor(ns / 2);
        for (let i = 0; i < pairs; i++) {
          const p = off + i * 5;
          if (p + 5 > b.length) break;
          const s1 = (b[p] << 12) | (b[p + 1] << 4) | ((b[p + 2] >> 4) & 0xf);
          const s2 = ((b[p + 2] & 0xf) << 16) | (b[p + 3] << 8) | b[p + 4];
          samples[i * 2] = s1 & 0x80000 ? s1 - 0x100000 : s1;
          samples[i * 2 + 1] = s2 & 0x80000 ? s2 - 0x100000 : s2;
        }
        if (ns % 2 === 1) {
          const p = off + pairs * 5;
          if (p + 3 <= b.length) {
            const s1 = (b[p] << 12) | (b[p + 1] << 4) | ((b[p + 2] >> 4) & 0xf);
            samples[ns - 1] = s1 & 0x80000 ? s1 - 0x100000 : s1;
          }
        }
      }
      off += nb;
    }
    r.traces.push({ hdr: { trcNum }, samples, nSamples: ns, dataFmt: bpsBits });
    tc++;
  }
  r.traceCount = tc;
  return r;
}

/**
 * Write traces as SEG-D (32-bit IEEE float, format code 8058, demultiplexed).
 * `rev3` selects Rev 3.0 (96-byte channel-set descriptor, µs record length,
 * 32-bit ns in THE1) versus Rev 1.0 (32-byte descriptor, ms record length,
 * 24-bit ns in THE1). Layout mirrors the real iX1 NT structure verified by the
 * Field QC: GH1 + GH2 + one seismic channel set + per-trace 20-byte demux
 * header + ONE 32-byte THE1 (receiver line/point + samples-per-trace) + data.
 * Round-trips exactly through parseSEGD above.
 *
 * SEG-D is a fixed-slot format here: every trace slot is sized from the LONGEST
 * trace; shorter traces are zero-padded to it (their THE1/CSD ns is the slot
 * size - same semantics as the SEG-Y/SU writers' fixed records).
 */
export function writeSEGD(pd: ParsedFile, rev3: boolean): Bytes {
  const trc = pd.traces;
  if (!trc || !trc.length) throw new Error('No traces');
  // Trace numbers and the rev-1 channel count are 4-digit BCD fields.
  if (trc.length > 9999)
    throw new Error(`${trc.length} traces; SEG-D BCD trace-number field max 9999 - split the gather`);
  const spt = trc.reduce((m, t) => Math.max(m, t.nSamples || 0), 0);
  const siUs = pd.bh?.sampleInt || 2000;
  // Base scan interval is binary in 1/16-ms units (1..255); the nearest code is
  // written (rev 3 also carries the exact µs interval in its descriptor).
  const bsi = Math.max(1, Math.min(255, Math.round(siUs / 62.5)));
  const recordLenUs = Math.max(0, Math.round((spt > 0 ? spt - 1 : 0) * siUs));
  const recordLenMs = Math.round(recordLenUs / 1000);
  const gFileNum = pd.gh1?.fileNum;
  const fileNum = typeof gFileNum === 'number' && gFileNum >= 1 && gFileNum <= 9999 ? gFileNum : 1;

  const csdSize = rev3 ? 96 : 32;
  const off0 = 64 + csdSize; // GH1 + GH2 + one channel-set descriptor
  const tsz = 20 + 32 + spt * 4; // demux header + ONE THE1 + IEEE samples
  const out = new Uint8Array(off0 + trc.length * tsz);

  const bcdByte = (v: number): number => ((Math.floor(v / 10) % 10) << 4) | (v % 10);
  const bcdW4 = (o: number, v: number): void => { out[o] = bcdByte(Math.floor(v / 100)); out[o + 1] = bcdByte(v % 100); };
  const w24 = (o: number, v: number): void => { out[o] = (v >> 16) & 0xff; out[o + 1] = (v >> 8) & 0xff; out[o + 2] = v & 0xff; };
  const hnum = (h: TraceHeader, k: string): number => { const v = h[k]; return typeof v === 'number' && isFinite(v) ? v : 0; };

  // -- General Header Block 1 --
  bcdW4(0, fileNum);
  out[2] = 0x80; out[3] = 0x58; // format code 8058 (BCD) = 32-bit IEEE float demux
  const now = new Date();
  out[10] = bcdByte(now.getFullYear() % 100); // year (BCD, spec offset)
  const jd = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
  out[11] = (1 << 4) | (Math.floor(jd / 100) % 10); // 1 additional GH block | julian-day hundreds
  out[12] = bcdByte(jd % 100);
  out[13] = bcdByte(now.getHours());
  out[14] = bcdByte(now.getMinutes());
  out[15] = bcdByte(now.getSeconds());
  out[22] = bsi; // base scan interval (binary 1/16 ms)
  out[25] = 0x8f; out[26] = 0xff; // record type 8 (normal) | record length 0xFFF → extended (GH2)
  out[27] = 0x01; // one scan type (BCD)
  out[28] = 0x01; // one channel set per scan type (BCD)
  // b[30]/b[31]: no extended / external header blocks.

  // -- General Header Block 2 --
  const g = 32;
  w24(g + 0, fileNum); // extended file number (binary)
  out[g + 10] = rev3 ? 3 : 1; // SEG-D revision major
  out[g + 11] = 0; //               … minor
  if (rev3) {
    // Extended record length in µs (48-bit BE at GH2[14-19]).
    let v = recordLenUs;
    for (let i = 5; i >= 0; i--) { out[g + 14 + i] = v % 256; v = Math.floor(v / 256); }
    out[g + 23] = 1; // additional general-header blocks (rev-3 true count)
    // GH2[28-29]: external header blocks = 0.
  } else {
    w24(g + 14, recordLenMs); // extended record length in ms (GH2[14-16])
    out[g + 18] = 2; // general-header block number
  }

  // -- Channel-set descriptor (one seismic set holding every trace) --
  const c = 64;
  if (rev3) {
    out[c + 0] = 1; // scan type
    out[c + 2] = 1; // channel set number (16-bit at [1-2])
    out[c + 3] = 0x10; // channel type 1 = seismic (hi nibble)
    w32(out, c + 4, 0); // start time (µs)
    w32(out, c + 8, recordLenUs); // end time (µs)
    w32(out, c + 12, spt); // number of samples
    out[c + 16] = 0x3f; out[c + 17] = 0x80; // descale multiplier = 1.0 (IEEE f32)
    w24(c + 20, trc.length); // number of channels (24-bit)
    w24(c + 23, Math.round(siUs)); // sampling interval (µs, 24-bit)
    out[c + 27] = 1; // trace-header extensions per trace
    out[c + 31] = 0x30; out[c + 63] = 0x31; out[c + 95] = 0x32; // sub-block ids
  } else {
    out[c + 0] = 0x01; // scan type (BCD)
    out[c + 1] = 0x01; // channel set number (BCD)
    // start [2-3] = 0; end time in 2-ms units.
    const end2ms = Math.min(0xffff, Math.round(recordLenMs / 2));
    out[c + 4] = (end2ms >> 8) & 0xff; out[c + 5] = end2ms & 0xff;
    bcdW4(c + 8, trc.length); // number of channels (4-digit BCD)
    out[c + 10] = 0x10; // channel type 1 = seismic (hi nibble)
    out[c + 28] = 1; // trace-header extensions per trace
  }

  // -- Demultiplexed trace records: 20-byte header + THE1 + samples --
  const sdv = dv(out);
  let to = off0;
  for (let t = 0; t < trc.length; t++) {
    const h = trc[t].hdr || {};
    bcdW4(to, fileNum);
    out[to + 2] = 0x01; // scan type (BCD)
    out[to + 3] = 0x01; // channel set number (BCD)
    bcdW4(to + 4, t + 1); // trace number (BCD)
    out[to + 9] = 1; // one trace-header extension
    // THE1 - receiver line/point/index + samples per trace (the slot size, so
    // the reader's per-trace walk stays aligned with the fixed slots).
    const e = to + 20;
    const line = hnum(h, 'rcvLine'), point = hnum(h, 'rcvPoint');
    w24(e + 0, line & 0xffffff);
    w24(e + 3, point & 0xffffff);
    out[e + 6] = hnum(h, 'rcvIdx') & 0xff;
    if (rev3) w32(out, e + 24, spt); // ns (32-bit, rev-3 home)
    else w24(e + 7, spt); // ns (24-bit)
    w24(e + 10, line & 0xffffff); // extended receiver line (int part)
    w24(e + 15, point & 0xffffff); // extended receiver point (int part)
    to += 20 + 32;
    if (trc[t].samples) {
      const ns2 = Math.min(trc[t].nSamples, spt);
      for (let i = 0; i < ns2; i++) sdv.setFloat32(to + i * 4, trc[t].samples![i] || 0, false);
    }
    to += spt * 4;
  }
  return out;
}
