// seisconv-core - SEG-D parser + writer (Rev 1 / 2.1 / 3.0, demultiplexed)
//
// READER: decodes the general-header region to the SEG-D spec - GH1 at the true
// offsets (year b[10], julian day b[11-12], base scan interval b[22] in binary
// 1/16-ms units, record length b[25-26], scan types b[27], channel sets b[28],
// extended/external header counts b[30-31] with the 0xFF → GH2 indirection),
// GH2 (revision at bytes 10-11, extended file number / record length, the rev-3
// additional-GH-block and external-header counts), 32-byte (rev ≤ 2) or 96-byte
// (rev 3) channel-set descriptors, then per-trace 20-byte demux trace headers +
// 32-byte trace-header extensions. THE1 is read positionally in every revision
// (ns, receiver line/point/index, sensor type, and on rev 3 the re-shoot/group/
// depth indexes, extended trace number, physical unit); the blocks AFTER it are
// read only on rev 3, where each 32-byte block names its own type in byte 32 -
// position blocks (receiver coordinates), sensor info, timestamp and time-drift
// headers. Rev 2.1 gives blocks 2..15 no layout at all, so there they stay
// bytes. Field map taken from SEG-D Rev 2.1 (SEG Field Tape Standards, January 2006)
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

import { asciiPrintable, bcd2, dv, getF64, r32s, r32u, rIEEE, w32 } from '../binary';
import type { Bytes, ParsedFile, SegdChanSet, Trace, TraceHeader } from '../types';
import { MAX_SAMPLE_TRACES, MAX_SAMPLES_PER_TRACE, MAX_TRACES, segdChanTypeIsSeismic } from '../types';

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

// A SEG-D timestamp is "an 8 byte, signed, big-endian integer counting the number
// of microseconds since 6 Jan 1980 00:00:00 (GPS epoch)" (SEG-D Rev 3.0, 3.1
// SEG-D timestamp, printed page 25). Read as two 32-bit halves so no BigInt is
// needed: a double represents every microsecond count inside ±2^53 µs (about ±285
// years around that epoch) exactly, and the standard's own range note ("292471
// years") is the only part that would overflow.
const r64s = (b: Bytes, o: number): number => r32s(b, o) * 4294967296 + r32u(b, o + 4);

/**
 * Set a numeric trace-header field once, and only when the decode is finite.
 * Two jobs: an IEEE infinity is the standard's "not available" for the position
 * error and coordinate fields (SEG-D Rev 3.0, 8.13, printed pages 107-109), so
 * it must not surface as a number; and where a trace carries several blocks of
 * the same type the FIRST one wins rather than the last, since "the ordering of
 * blocks is used to indicate what the information in the block refers to" (5.1,
 * printed page 40) and the nearest block is the one describing this trace.
 */
function putNum(h: TraceHeader, k: string, v: number): void {
  if (Number.isFinite(v) && !(k in h)) h[k] = v;
}

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
  const chanSets: SegdChanSet[] = [];
  let off = totalGHBytes;
  // The CHANNEL TYPE is not the same field in both revisions, and reading it the
  // rev-2 way on a rev-3 file collapses whole families of codes onto one number.
  // Rev 3 widened it to a full byte: "Channel type Identification (one byte,
  // unsigned binary). 0016 Unused 1016 Seis 1116 Electromagnetic (EM) 2016 Time
  // break 2116 Clock timebreak 2216 Field timebreak 3016 Up hole ... F016
  // Calibration trace (time series)" (SEG-D Rev 3.0, 8.16 Channel Set Descriptor,
  // byte 4 row (C7 - C0), printed page 111; qa/conform
  // SEGD3-CSD-04-CHANNEL-TYPE gives bytes 4, width 1, with that whole code set).
  // Rev 2.1 really is a nibble, and it really does sit in the HIGH bits: the
  // descriptor table draws byte 11 as "Channel Type C3 C2 C1 C0 X X X X" (SEG-D
  // Rev 2.1, 7.4 Scan Type Header (Channel Set Descriptor), byte 11 row, printed
  // page 37) and the field description names the codes bit by bit, 0000 Unused /
  // 0001 Seis / 0010 Time break / 0011 Up hole and so on (8.5 Channel Set
  // Descriptor, byte 11 row, printed page 43).
  // Read as a nibble, a rev-3 time-break set (0x20) became 2 - a code the
  // standard assigns to nothing - and an Electromagnetic set (0x11) became 1,
  // indistinguishable from Seis (0x10), so the seismic lookup below could pick the
  // EM set and hand its sample interval to every trace in the file.
  for (let i = 0; i < nCS && off + csdSize <= b.length; i++, off += csdSize) {
    if (revMajor >= 3) {
      const startUs = r32u(b, off + 4), endUs = r32u(b, off + 8);
      const siUs = r24(b, off + 23) || baseSiUs;
      let ns = r32u(b, off + 12);
      // NO "+ 1" here, unlike the rev <= 2 branch below. Rev 3 states the relation
      // outright: "the number of samples NS, sampling interval SR, channel set
      // start time TF, and channel set end time TE should be related by the
      // formula TE=TF+NS*SR" (SEG-D Rev 3.0, 8.16 Channel Set Descriptor, bytes
      // 13-16 row, printed page 113; qa/conform SEGD3-CSD-13-END-TIME-FORMULA,
      // whose note spells out that TE therefore lands one whole interval AFTER the
      // last sample). So (TE - TF) / SR is already the sample count, and adding one
      // over-counted every rev-3 set that had to fall back to this - which, when
      // the trace also carried no usable THE1 count, walked the reader one extra
      // sample's worth of bytes per trace into the next trace's header.
      if (!(ns >= 1) && siUs > 0) ns = Math.round((endUs - startUs) / siUs);
      chanSets.push({
        scanType: b[off], csNum: r16(b, off + 1), chanType: b[off + 3],
        chanCount: r24(b, off + 20), theCount: b[off + 27],
        ns: Math.min(Math.max(ns, 0), MAX_SAMPLES_PER_TRACE), siUs,
      });
    } else {
      const startMs = r16(b, off + 2) * 2, endMs = r16(b, off + 4) * 2; // 2-ms units
      const siUs = baseSiUs || 2000;
      // The "+ 1" stays for rev <= 2, and the reason is that the revision states
      // no NS relation to solve. Bytes 3-4 are "the timing word of the first scan
      // of data in this channel set"; bytes 5-6 "represent the record end time of
      // the channel set in milliseconds", and "in a single scan type record, Bytes
      // 5 and 6 would be the length of the record" (SEG-D Rev 2.1, 8.5 Channel Set
      // Descriptor, bytes 3-4 and 5-6 rows, printed page 42). There is no
      // TE = TF + NS * SR anywhere in Rev 2.1, so nothing there settles whether TE
      // is the last sample's time or one interval past it, and the inclusive
      // reading below is left exactly as it stands rather than changed on a guess.
      const ns = siUs > 0 ? Math.round(((endMs - startMs) * 1000) / siUs) + 1 : 0;
      chanSets.push({
        scanType: bcd2(b[off]), csNum: bcd2(b[off + 1]), chanType: (b[off + 10] >> 4) & 0xf,
        chanCount: bcd4(b, off + 8), theCount: b[off + 28],
        ns: Math.min(Math.max(ns, 0), MAX_SAMPLES_PER_TRACE), siUs,
      });
    }
  }
  off += (extHdr + extlHdr) * 32;

  const seisCS = chanSets.find((c) => segdChanTypeIsSeismic(c.chanType, revMajor)) || chanSets[0];
  const siUs = (seisCS?.siUs || baseSiUs) || 2000;
  const totalChans = chanSets.reduce((s, c) => s + (c.chanCount > 0 ? c.chanCount : 0), 0);

  r.gh1 = {
    fileNum: fileNum > 0 ? fileNum : 0, fmtCode, year, julDay, hour, minute, second,
    numChanSets: chanSets.length, extHdrLen: extHdr, extlHdrLen: extlHdr,
    recordLenMs, revMajor, revMinor,
  };
  r.bh = { sampleInt: siUs, samplesTrace: seisCS?.ns || 0 };
  // Keep the descriptors themselves, not only the totals folded into gh1 above:
  // a reader cannot tell an aux set from a seismic one, or see how the channels
  // divide between sets, from `numChanSets` and a channel total.
  r.chanSets = chanSets;
  if (bits === 20 && fmtCode !== 8015) r.errors.push(`SEG-D format code ${fmtCode} not fully supported - decoding as 20-bit packed`);

  // -- Demultiplexed trace records: 20-byte header + THE×32 + samples --
  // Trust the declared channel geometry for the trace COUNT when it's sane -
  // it stops the walk before any rev-3 general trailer / trailing junk.
  let tc = 0;
  let clipNoted = false;
  // Every trace in a channel set carries the same block layout ("Channels within
  // the same channel set must have the same number of Trace Header Extensions.
  // Value must be the same as byte 28 of the matching Channel Set Descriptor",
  // SEG-D Rev 3.0, 8.17 Demux Trace Header, byte 10 row, printed page 116), so
  // the block-type map is
  // the same string over and over. Keep the previous one and re-use the SAME
  // string object when it repeats: at MAX_TRACES x up to 255 blocks a fresh
  // string per trace would be tens of megabytes of identical text.
  let lastTypes = '';
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

    // Only offsets this walk has already proved: scan type b[off+2] and channel
    // set b[off+3] (read above), trace number b[off+4-5], and the trace-header
    // extension count b[off+9] - all inside the 20 bytes the loop guard checked,
    // so none of them can read past a short record.
    const hdr: TraceHeader = {
      trcNum, trcField: trcNum, fieldRec: tFile || (fileNum > 0 ? fileNum : 0),
      scanType, chanSet: csNum, theCount: the, nSamples: ns,
    };
    // Two facts about this trace that the format keeps in its channel-set
    // descriptor rather than in the trace header: whether the channel is seismic
    // or an aux/time-break one, and the interval it was really sampled at when
    // the sets disagree. `cs` is undefined when the file declared no usable
    // descriptor, hence the guard.
    if (cs) {
      if (isFinite(cs.chanType)) hdr.chanType = cs.chanType;
      if (isFinite(cs.siUs) && cs.siUs > 0) hdr.sampInt = cs.siUs;
    }
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

      // Byte 21 names the sensor on this trace in BOTH revisions: "SEN  Sensor
      // Type recorded on this trace (one byte unsigned binary) 00 Not defined /
      // 01 Hydrophone (pressure sensor) / 02 Geophone (velocity sensor) Vertical
      // / 03 Geophone, Horizontal, inline / ..." (SEG-D Rev 2.1, 8.7 Trace Header
      // Extension, byte 21 row, printed page 46; the same table and the same
      // codes at SEG-D Rev 3.0, 8.18 Trace Header Extension #1, byte 21 row,
      // printed page 117). 0016 is "Not defined", so an unset byte adds nothing.
      if (b[theBase + 20]) hdr.sensorType = b[theBase + 20];

      // Everything below exists only from Rev 3 on. Rev 2.1 puts the 24-bit
      // sample count in bytes 8-10 where Rev 3 puts the re-shoot / group / depth
      // indexes, and ends the block at byte 21: "22 - 32  X  These fields are
      // undefined by format and may have any value" (SEG-D Rev 2.1, 8.7, printed
      // page 46).
      if (revMajor >= 3) {
        // "Re-shoot Index (one byte, unsigned binary) ... Re-shoot index starts
        // at 0 (indicates recorded for first time)", "Group Index (one byte,
        // unsigned binary) ... 0 means receiver is not part of a group", "Depth
        // Index (one byte, unsigned binary) ... 0 is not allowed. Starts at 1
        // closest to the surface" (SEG-D Rev 3.0, 8.18, bytes 8, 9 and 10 rows,
        // printed page 117). Reported only when non-zero, because "016 is
        // commonly used for indexes (receiver line/point, re-shoot, depth and
        // group indexes) to indicate not set" (8.18 closing note, printed page
        // 118).
        if (b[theBase + 7]) hdr.reshootIdx = b[theBase + 7];
        if (b[theBase + 8]) hdr.groupIdx = b[theBase + 8];
        if (b[theBase + 9]) hdr.depthIdx = b[theBase + 9];

        // "Extended Trace Number (three bytes, unsigned binary). Extended trace
        // number to allow up to 16,777,215 traces in one channel set. Field is
        // only valid if bytes 5-6 in Demux Trace Header is set to FFFF16" (8.18,
        // bytes 22-24 row, printed page 117) - so the test is on the RAW demux
        // bytes, not on the BCD value decoded from them (which is meaningless
        // for FFFF). Substituted into the trace number exactly the way the walk
        // above already substitutes the extended FILE number.
        if (r16(b, off + 4) === 0xffff) {
          const etn = r24(b, theBase + 21);
          if (etn > 0) { hdr.trcNum = etn; hdr.trcField = etn; }
        }

        // "Sensor moving (one byte, unsigned binary). Sensor moving or
        // stationary. Set to 1 if sensor is moving during the record, 0 if it is
        // stationary." (8.18, byte 29 row, printed pages 117-118). 0 is the ordinary
        // planted-geophone case, so only a set byte is worth a field.
        if (b[theBase + 28]) hdr.sensorMoving = b[theBase + 28];

        // "Physical unit (1 byte, unsigned binary). This is the physical unit
        // measured by this sensor. Same as byte 62 of the channel set header"
        // (8.18, byte 31 row, printed page 118). The code table is the channel
        // set descriptor's: "0016 Unknown, 0116 Millibar, 0216 Bar, 0316
        // Millimeter/second, 0416 Meter/second, 0516 Millimeter/second/second,
        // ... 1216 Pascal, ... 1516 Meter" (8.16, byte 62 row, printed pages
        // 114-115). The raw code is carried; this reader does not name the unit.
        if (b[theBase + 30]) hdr.physUnit = b[theBase + 30];
      }
    }

    // -- Trace header extension blocks 2..N -----------------------------------
    // Rev 3 types every 32-byte block by its last byte - "a sequence of 32 byte
    // blocks of different types, identified by the ID in byte 32" (SEG-D Rev 3.0,
    // 5.1, printed page 40) - and Table 2 (printed page 40) lists which types may
    // appear in a Trace Header, so the blocks after THE1 are decoded BY TYPE and
    // never by position. THE1 itself stays positional: it is required and first
    // ("At least one Trace Header Extension block (the Trace Header Extension,
    // block type 4016) is required", 8.17, byte 10 row, printed page 116).
    // Rev 2.1 has no type byte at all: there "Additional trace header blocks may
    // be added as needed by the manufacturer or user" (SEG-D Rev 2.1, 5.3 Trace
    // Header, printed page 24) with no layout given for them, so on Rev <= 2
    // files blocks 2..N stay unread, exactly as before.
    if (revMajor >= 3 && the >= 2 && theBase + 32 <= b.length) {
      let types = b[theBase + 31].toString(16).padStart(2, '0');
      for (let k = 1; k < the; k++) {
        const o = theBase + k * 32;
        if (o + 32 > b.length) break;
        const bt = b[o + 31];
        types += ',' + bt.toString(16).padStart(2, '0');
        switch (bt) {
          // 8.19 SENSOR INFO HEADER EXTENSION (optional), printed page 118:
          // bytes 1-8 "Equipment Test Time (SEG-D 8 byte timestamp). Time of last
          // test. Set to 0 if not recorded."; 9-12 "Sensor Sensitivity (four
          // bytes, IEEE float). This is the signal sensitivity for the sensor.
          // Divide the sample value by this number to achieve a physical unit ...
          // Set to 0 if not specified"; 13 "Equipment Test Result (one byte,
          // unsigned binary) ... 0016 Unknown (untested) 0116 Passed 0216 Failed
          // 0316 Uncertain"; 14-31 "Serial Number (18 bytes, ASCII text) ...
          // Left-justified, padded with space (2016) characters."
          case 0x41: {
            const tt = r64s(b, o);
            if (tt) putNum(hdr, 'sensorTestTime', tt);
            const ss = rIEEE(b, o + 8);
            if (ss) putNum(hdr, 'sensorSens', ss);
            if (b[o + 12]) putNum(hdr, 'sensorTestResult', b[o + 12]);
            const sn = asciiPrintable(b.subarray(o + 13, o + 31)).trim();
            if (sn && !('sensorSerial' in hdr)) hdr.sensorSerial = sn;
            break;
          }
          // 8.20 TIMESTAMP HEADER (optional), printed page 119: bytes 1-8 "Time
          // Zero for this data block (eight bytes, SEG-D timestamp). The time of
          // first sample in the data described by this header. ... Typically
          // inserted into Trace Header in Extended Recording Mode, the timestamp
          // is then the time of first sample in the trace." Bytes 9-31 are
          // "undefined by the format and may have any value".
          case 0x42: {
            const tz = r64s(b, o);
            if (tz) putNum(hdr, 'traceTimeZero', tz);
            break;
          }
          // 8.22 TIME DRIFT HEADER (optional), printed pages 120-121: 1-8 "Time
          // of deployment (eight bytes, SEG-D timestamp)"; 9-16 "Time of
          // retrieval"; 17-20 "Time offset at deployment (four bytes, two's
          // complement, signed binary). Time offset value at deployment in number
          // of microseconds"; 21-24 "Time offset at retrieval"; 25 "Time drift
          // corrected (one byte, unsigned binary). Set to 1 if time drift
          // correction has been applied, 0 if not"; 26 "Time drift correction
          // method ... 0016 Uncorrected 0116 Linear correction ... FF16 Other".
          case 0x44: {
            const td = r64s(b, o);
            if (td) putNum(hdr, 'driftDeployTime', td);
            const tr = r64s(b, o + 8);
            if (tr) putNum(hdr, 'driftRetrieveTime', tr);
            const od = r32s(b, o + 16);
            if (od) putNum(hdr, 'driftOffsetDeploy', od);
            const orv = r32s(b, o + 20);
            if (orv) putNum(hdr, 'driftOffsetRetrieve', orv);
            if (b[o + 24]) putNum(hdr, 'driftCorrected', b[o + 24]);
            if (b[o + 25]) putNum(hdr, 'driftMethod', b[o + 25]);
            break;
          }
          // 8.13 POSITION BLOCKS (optional), Position Block 1 (bytes 1-32 of the
          // 96-byte position group), printed pages 107-108. What it positions is
          // fixed by where it sits: "Position blocks following a Demux Trace
          // Header will describe the position of the trace" (8.13 preamble,
          // printed page 107). Bytes 1-8 "Time of position (eight bytes, SEG-D
          // timestamp). Time to which this position applies, i.e., sample time";
          // 9-16 "Time of measurement/calculation"; 17-20 "Vertical error quality
          // estimate: 95% precision estimate in same units as vertical coordinate
          // (four bytes, IEEE float) ... Set to infinity ... if not available";
          // 21-24 and 25-28 the 95% error ellipse semi-major and semi-minor axes,
          // same rule; 29-30 "Bearing of error ellipse semi-major axis (two
          // bytes, unsigned binary). Orientation to map grid north in steps of
          // 1/100 of a degree ... Set FFFF16 if not available" (hence /100 to
          // give degrees); 31 "Position type (one byte, unsigned binary) ... 0116
          // Planned/preplot 0216 Measured 0316 Processed 0416 Final 0F16
          // Unknown". The "not available" infinities drop out in putNum.
          case 0x50: {
            const tp = r64s(b, o);
            if (tp) putNum(hdr, 'posTime', tp);
            const tcm = r64s(b, o + 8);
            if (tcm) putNum(hdr, 'posCalcTime', tcm);
            putNum(hdr, 'posVertErr', rIEEE(b, o + 16));
            putNum(hdr, 'posErrMaj', rIEEE(b, o + 20));
            putNum(hdr, 'posErrMin', rIEEE(b, o + 24));
            const hb = r16(b, o + 28);
            if (hb !== 0xffff) putNum(hdr, 'posErrBearing', hb / 100);
            if (b[o + 30]) putNum(hdr, 'posType', b[o + 30]);
            break;
          }
          // 8.13 Position Block 2 (bytes 33-64 of the position group), printed
          // pages 108-109: 33-40 / 41-48 / 49-56 "First / Second / Third
          // coordinate for coordinate tuple 1 (eight bytes, IEEE double float).
          // This coordinate and its unit is as given in the CRS definition in the
          // location data stanza identified through ID1. Set to infinity ... if
          // CRS type is one-dimensional i.e. vertical / ... if CRS type is
          // two-dimensional"; 57-58 "Location Data Stanza ID 1 (two bytes,
          // unsigned binary) ... A value of 0 means unknown Location Data Stanza
          // ID"; 59 "Position 1 Valid (one byte, unsigned binary) ... Set to 1 if
          // position coordinates are valid, 0 if not"; 60 "Position 1 Quality ...
          // 0016 Position 1 not present 0116 Position is good 0216 Quality
          // uncertain 0316 Position is bad, not to be used".
          // These are deliberately NOT mapped onto rcvX / rcvY: their unit and
          // axis order come from a CRS stanza this reader does not resolve, so
          // calling them metres would be an assumption the standard never makes.
          case 0x51: {
            putNum(hdr, 'rcvCrd1', getF64(b, o));
            putNum(hdr, 'rcvCrd2', getF64(b, o + 8));
            putNum(hdr, 'rcvCrd3', getF64(b, o + 16));
            const id1 = r16(b, o + 24);
            if (id1) putNum(hdr, 'posStanza', id1);
            if (b[o + 27]) { putNum(hdr, 'posValid', b[o + 26]); putNum(hdr, 'posQual', b[o + 27]); }
            break;
          }
          // 8.13 Position Block 3 (bytes 65-96 of the position group), printed
          // pages 109-110: the same six fields again for coordinate tuple 2, a
          // second CRS for the same point - 65-72 / 73-80 / 81-88 (T2C1-T2C3),
          // 89-90 "Location Data Stanza ID 2", 91 "Position 2 Valid", 92
          // "Position 2 Quality" with the same code list as Position 2's.
          case 0x52: {
            putNum(hdr, 'rcvAltCrd1', getF64(b, o));
            putNum(hdr, 'rcvAltCrd2', getF64(b, o + 8));
            putNum(hdr, 'rcvAltCrd3', getF64(b, o + 16));
            const id2 = r16(b, o + 24);
            if (id2) putNum(hdr, 'posAltStanza', id2);
            if (b[o + 27]) { putNum(hdr, 'posAltValid', b[o + 26]); putNum(hdr, 'posAltQual', b[o + 27]); }
            break;
          }
          // Every other type is left as bytes on purpose: B016-FF16 is "User
          // defined header block" (Table 2, printed page 40) with no layout to
          // read, and the standard blocks this reader does not decode (4316
          // sensor calibration, 4516 electromagnetic, 5516 CRS identification,
          // 5616 relative position, 6016 orientation, 6116 measurement) are
          // listed by type below rather than guessed at.
          default:
            break;
        }
      }
      // The full block-type map, THE1 first, as lower-case hex. It is the only
      // trace-level evidence that the manufacturer blocks exist at all.
      if (types !== lastTypes) lastTypes = types;
      hdr.theTypes = lastTypes;
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
    // 0xFF in the LAST byte of the second general-header block is the old writer's
    // OWN Rev-3 marker, not a SEG-D field: it stamped that one byte and left the
    // rest of the block zero when the export was asked for Rev 3, and wrote no
    // second block at all otherwise. So this reports the revision the operator
    // chose at export time. It does not claim a conformant Rev 3 LAYOUT - that
    // writer emitted the same 32-byte channel-set descriptor and bare 20-byte
    // trace header in both revisions.
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
 * `rev3` selects Rev 3.0 (three general header blocks, 96-byte channel-set
 * descriptor, µs record length, 32-bit ns in THE1) versus Rev 1.0 (two general
 * header blocks, 32-byte descriptor, ms record length, 24-bit ns in THE1).
 * Layout mirrors the real iX1 NT structure verified by the Field QC:
 * GH1 + GH2 (+ GH3, required by Rev 3.0 section 5.1, printed page 39) + one
 * seismic channel set + per-trace 20-byte demux header + ONE 32-byte THE1
 * (receiver line/point + samples-per-trace) + data. Every offset after the
 * general header is derived from the block count, never assumed, so the parser
 * above (which reads that count from byte 12) walks its own output.
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
  // Record length from time zero. Rev 3 states the relation outright: "the
  // number of samples NS, sampling interval SR, channel set start time TF, and
  // channel set end time TE should be related by the formula TE=TF+NS*SR"
  // (SEG-D Rev 3.0, 8.16 Channel Set Descriptor, bytes 13-16 row, printed page
  // 113), and the end time IS the record length here: "In a single scan type
  // record starting at time zero, Bytes 9-12 would be the length of the record"
  // (8.16, bytes 9-12 row, printed page 112). So with TF = 0 the rev-3 record
  // length and channel-set end time are both NS*SR, one sampling interval past
  // the LAST sample (qa/conform SEGD3-CSD-13-END-TIME-FORMULA). Rev 2.1 states
  // no NS formula for its 2-ms end time, only "In a single scan type record,
  // Bytes 5 and 6 would be the length of the record" (SEG-D Rev 2.1, 8.5
  // Channel Set Descriptor, bytes 5-6 row, printed page 43), so the rev-1
  // branch keeps the time of the last sample rather than invent a value.
  const recordLenUs = Math.max(0, Math.round((spt > 0 ? (rev3 ? spt : spt - 1) : 0) * siUs));
  const recordLenMs = Math.round(recordLenUs / 1000);
  const gFileNum = pd.gh1?.fileNum;
  const fileNum = typeof gFileNum === 'number' && gFileNum >= 1 && gFileNum <= 9999 ? gFileNum : 1;

  const csdSize = rev3 ? 96 : 32;
  // Rev 3 needs THREE general header blocks, not two: "SEG-D, Rev 3.0 requires
  // the use of General Header Block #1, General Header Block #2 (as was also
  // required in SEG-D, Rev 2.x), and General Header #3 (new with SEG-D, Rev
  // 3.0)" (SEG-D Rev 3.0, 5.1 General Headers, printed page 39) (qa/conform
  // SEGD3-GH3-BLOCK-PRESENT). Every offset after the general header follows
  // this, so it is a variable rather than the literal 64 it used to be.
  const ghBytes = rev3 ? 96 : 64;
  const off0 = ghBytes + csdSize; // general header blocks + one channel-set descriptor
  const tsz = 20 + 32 + spt * 4; // demux header + ONE THE1 + IEEE samples
  const out = new Uint8Array(off0 + trc.length * tsz);

  const bcdByte = (v: number): number => ((Math.floor(v / 10) % 10) << 4) | (v % 10);
  const bcdW4 = (o: number, v: number): void => { out[o] = bcdByte(Math.floor(v / 100)); out[o + 1] = bcdByte(v % 100); };
  const w24 = (o: number, v: number): void => { out[o] = (v >> 16) & 0xff; out[o + 1] = (v >> 8) & 0xff; out[o + 2] = v & 0xff; };
  // 8-byte big-endian unsigned, for the rev-3 General Header Block #3 sizes
  // (bit ops in JS are 32-bit, so this divides instead of shifting).
  const w64 = (o: number, v: number): void => {
    let x = Math.max(0, Math.round(v));
    for (let i = 7; i >= 0; i--) { out[o + i] = x % 256; x = Math.floor(x / 256); }
  };
  const hnum = (h: TraceHeader, k: string): number => { const v = h[k]; return typeof v === 'number' && isFinite(v) ? v : 0; };

  // -- General Header Block 1 --
  bcdW4(0, fileNum);
  out[2] = 0x80; out[3] = 0x58; // format code 8058 (BCD) = 32-bit IEEE float demux
  const now = new Date();
  out[10] = bcdByte(now.getFullYear() % 100); // year (BCD, spec offset)
  const jd = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
  // Byte 12 upper nibble: "Number of additional Blocks in General Header
  // (unsigned binary). This number will be 2 or greater for Rev 3 (e.g., if only
  // General Header Blocks #1, #2 and #3 are present then GH = 2)" (SEG-D Rev
  // 3.0, 8.1 General Header, Block #1, byte 12 row, printed page 87) (qa/conform
  // SEGD3-GH1-12-ADDITIONAL-GENERAL-HEADER-BLOCKS). Rev 1 declares the one
  // additional block it really writes. Lower nibble = julian-day hundreds.
  out[11] = ((rev3 ? 2 : 1) << 4) | (Math.floor(jd / 100) % 10);
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
    // Bytes 23-24, the EXTENDED additional-general-header-block count. The
    // escape into it is not in use - "When using this field, the upper nibble of
    // byte 12 of General Header Block #1 must be set to F16" (8.2, bytes 23-24
    // row, printed page 90) and byte 12 carries the real count instead - so the
    // rule for every extended field applies: "When the normal field is used, the
    // extended field is either set to 0 or the value of the normal field. No
    // other values are allowed." (8.0 Header Block Parameters, printed page 87).
    // It therefore repeats the same 2; the old 1 here contradicted byte 12.
    out[g + 22] = 0; out[g + 23] = 2;
    // Byte 32: "Header block type (one byte, unsigned binary). ... For General
    // Header Block #2 this byte is set to 0216" (8.2, byte 32 row, printed page
    // 91). Rev 3.0 gives byte 32 of EVERY header block an ID so a reader can
    // tell the blocks apart (5.1, printed page 39) (qa/conform
    // SEGD3-GH2-32-HEADER-BLOCK-TYPE).
    out[g + 31] = 0x02;
    // GH2[28-29]: external header blocks = 0.
  } else {
    w24(g + 14, recordLenMs); // extended record length in ms (GH2[14-16])
    out[g + 18] = 2; // general-header block number
  }

  // -- General Header Block #3 (Timestamp and size header), rev 3 only --
  // Required by 5.1 (printed page 39); it "contains an accurate timestamp for
  // the record in addition to size information for the record to allow quick
  // searching through the record".
  if (rev3) {
    // 64 is definitional, not an assumed layout: block #3 follows blocks #1 and
    // #2, and every general header block is 32 bytes.
    const t = 64;
    // Bytes 1-8 Time Zero + byte 30 Relative Time Mode. A converter rewriting an
    // existing file does not know the record's absolute time zero, and the
    // standard provides for exactly that case: "For recording systems without
    // absolute time, the timestamp in General Header Block #3 (bytes 1 to 8)
    // must be set to 0, and the Relative Time Mode in General Header Block #3
    // (byte 30) set to 1. All timestamps in the record must then be relative to
    // start of record (time zero)." (3.1 SEG-D timestamp, printed page 25; byte
    // 30 row, 8.3, printed page 92). The channel-set start time this writer
    // emits is 0 and its end time is the record length, so every time in the
    // record already is relative to the start of the record. Bytes 1-8 stay 0
    // from the allocation. No GPS timestamp is invented here: the 8-byte field
    // is "GPS time converted to microseconds" (3.1, printed page 25), and the
    // wall clock this process can read is UTC at CONVERSION time, neither the
    // record's time zero nor GPS.
    out[t + 29] = 1;
    // Byte 29 Extended Recording Mode = 0 (normal record), left at 0 by the
    // allocation. It has to be 0: the extended record length written above is
    // non-zero, and "If Extended Recording Mode is used (General Header #3 byte
    // 29 set to 1), Extended Record Length must be set to 0.0" (8.2, bytes 17-20
    // row, printed page 90).
    // Bytes 9-16 Record Size: "The total size of the SEG-D record in number of
    // bytes. ... If no General Trailer blocks exist, this field is equal to the
    // Data Size (bytes 17-24)." Bytes 17-24 Data Size: "The total size of the
    // headers and data in this record in number of bytes." (8.3, printed page
    // 91). This writer emits no general trailer, so both are the whole file.
    w64(t + 8, out.length);
    w64(t + 16, out.length);
    // Bytes 25-28 Header Size: "The total size of the headers (i.e. General
    // Headers, Channel Set Headers, Skew Headers, External Header, Extended
    // Header, etc.) in this record in number of bytes. This value enables
    // skipping of all headers to the beginning of the first trace." (8.3,
    // printed page 92) - here three general header blocks + one channel-set
    // descriptor, with no skew, extended or external blocks.
    w32(out, t + 24, off0);
    // Byte 32: "Header block type (one byte, unsigned binary). ... For General
    // Header Block #3 this byte is set to 0316" (8.3, byte 32 row, printed page
    // 92), the ID Table 2 row 0316 assigns to "General Header 3 (Timestamp and
    // size header)" (5.1, printed page 39) (qa/conform SEGD3-GH3-BLOCK-PRESENT).
    out[t + 31] = 0x03;
    // Byte 31 is "undefined by the format and may have any value" (8.3, printed
    // page 92) and is left at 0.
  }

  // -- Channel-set descriptor (one seismic set holding every trace) --
  const c = ghBytes;
  if (rev3) {
    out[c + 0] = 1; // scan type
    out[c + 2] = 1; // channel set number (16-bit at [1-2])
    // Byte 4 is a WHOLE byte in rev 3, not the nibble rev 2 used, and 1016 is its
    // code for "Seis": "Channel type Identification (one byte, unsigned binary).
    // 0016 Unused 1016 Seis 1116 Electromagnetic (EM) ..." (8.16, byte 4 row,
    // printed page 111) (qa/conform SEGD3-CSD-04-CHANNEL-TYPE). The byte written
    // here is unchanged and already right; only this comment was describing the
    // rev-2 layout.
    out[c + 3] = 0x10; // channel type 0x10 = Seis
    w32(out, c + 4, 0); // start time (µs)
    w32(out, c + 8, recordLenUs); // end time (µs)
    w32(out, c + 12, spt); // number of samples
    out[c + 16] = 0x3f; out[c + 17] = 0x80; // descale multiplier = 1.0 (IEEE f32)
    w24(c + 20, trc.length); // number of channels (24-bit)
    w24(c + 23, Math.round(siUs)); // sampling interval (µs, 24-bit)
    out[c + 27] = 1; // trace-header extensions per trace
    // Byte 30 Vertical Stack: "Effective stack order. Set to zero if the trace
    // data was intentionally set to real zero. Set to one if no stack. Set to
    // the effective stack order if the data is the result of stacked data (with
    // or without processing)." (8.16, byte 30 row, printed page 114). These
    // traces carry real samples and are not stacked, so a zero here would tell a
    // reader the data was deliberately zeroed (qa/conform
    // SEGD3-CSD-30-VERTICAL-STACK).
    out[c + 29] = 1;
    // Bytes 69-95 Description: "Channel set description 27 byte free-text as
    // defined by the recording system. Left justified, padded with spaces (2016)
    // for unused characters. zero (0016) is not allowed." (8.16, bytes 69-95
    // row, printed page 115; the rule row cites 114, which is where the byte 62
    // physical-unit list ends) (qa/conform SEGD3-CSD-69-DESCRIPTION-NO-NULLS).
    const desc = 'SeisConv seismic channel'; // 24 of the 27 bytes; ASCII only
    for (let i = 0; i < 27; i++) out[c + 68 + i] = i < desc.length ? desc.charCodeAt(i) : 0x20;
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
    // Byte 30 Vertical Stack, same field and same wording one revision earlier:
    // "Effective stack order. Set to zero if the trace data was intentionally
    // set to real zero. Set to one if no stack." (SEG-D Rev 2.1, 8.5 Channel Set
    // Descriptor, byte 30 row, printed page 44) (qa/conform
    // SEGD1-CSD-30-VERTICAL-STACK).
    out[c + 29] = 1;
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
    if (rev3) {
      w32(out, e + 24, spt); // ns (32-bit, rev-3 home)
      // Byte 32: "Header block type (1 byte, unsigned binary) Set to 4016 for
      // Trace header extension 1." (SEG-D Rev 3.0, 8.18 Trace Header Extension
      // #1, byte 32 row, printed page 118), Table 2 row 4016 "Trace header
      // extension 1" (5.1, printed page 40). Without it a rev-3 reader walking
      // the trace header cannot tell what the 32-byte block it just read was
      // (qa/conform SEGD3-THE1-32-BLOCK-TYPE).
      out[e + 31] = 0x40;
    } else w24(e + 7, spt); // ns (24-bit)
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
