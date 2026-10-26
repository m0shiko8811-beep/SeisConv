// seisconv-core - the ONE trace-header vocabulary shared by every format.
//
// SEG-Y's 240-byte trace header is the reference: every parser puts a value on
// `trace.hdr` under the key named here for the SEG-Y word with the same meaning,
// and every writer reads those keys. SU uses the same 240-byte header (CWP's
// segy.h keeps SEG-Y bytes 1-180 unchanged and defines its own fields from byte
// 181 on), so SEG-Y and SU read and write bytes 1-180 through this one table and
// carry every standard word both ways. SEG-2 and SEG-D map what they really carry
// onto these same keys in their own parsers.
//
// Byte positions and meanings: SEG-Y rev 1.0 (May 2002), 7.1 Trace Header, Table
// 3, printed pages 12-21. Offsets below are 0-based (byte N of the standard is
// offset N - 1). Every word is a two's complement integer in rev 1 (rev 1.0
// printed page 6), except the sample count and sample interval, which this
// reader has always taken as unsigned (rev 2.0 allows "two's complement or
// unsigned").
//
// Two kinds of key:
//   * the words the SEG-Y reader has always returned are put on EVERY header,
//     zero or not, in the same order as before, so nothing that reads them sees a
//     change;
//   * the rest are put on a header only when non-zero. Zero is "not recorded" for
//     all of them, and a 500,000-trace file would otherwise carry dozens of zero
//     properties per trace for nothing.

import { getF32, r16s, r16u, r32s } from '../binary';
import type { Bytes, TraceHeader } from '../types';

/** One trace-header word: canonical key, 0-based byte offset, width in bytes. */
export interface TraceWord {
  key: string;
  off: number;
  w: 2 | 4;
  /** Read as unsigned (sample count and interval only). */
  u?: boolean;
  /** Always present on a parsed header, zero or not. */
  always?: boolean;
}

/** Bytes 1-180: identical in SEG-Y and SU. The first block keeps the historical
 *  SEG-Y reader's key order; the second adds every other standard word. */
export const STD_TRACE_WORDS: readonly TraceWord[] = [
  { key: 'seqLine', off: 0, w: 4, always: true }, // 1-4 trace sequence number within line
  { key: 'seqFile', off: 4, w: 4, always: true }, // 5-8 trace sequence number within file
  { key: 'fieldRec', off: 8, w: 4, always: true }, // 9-12 original field record number (FFID)
  { key: 'trcField', off: 12, w: 4, always: true }, // 13-16 trace number within the field record (channel)
  { key: 'srcPt', off: 16, w: 4, always: true }, // 17-20 energy source point number
  { key: 'ensemble', off: 20, w: 4, always: true }, // 21-24 ensemble (CDP) number
  { key: 'trcEns', off: 24, w: 4, always: true }, // 25-28 trace number within the ensemble
  { key: 'traceId', off: 28, w: 2, always: true }, // 29-30 trace identification code
  { key: 'dataUse', off: 34, w: 2, always: true }, // 35-36 data use
  { key: 'offset', off: 36, w: 4, always: true }, // 37-40 source-receiver distance
  { key: 'rcvElev', off: 40, w: 4, always: true }, // 41-44 receiver group elevation
  { key: 'surfElev', off: 44, w: 4, always: true }, // 45-48 surface elevation at source
  { key: 'srcDepth', off: 48, w: 4, always: true }, // 49-52 source depth below surface
  { key: 'elevScalar', off: 68, w: 2, always: true }, // 69-70 scalar for bytes 41-68
  { key: 'coordScalar', off: 70, w: 2, always: true }, // 71-72 scalar for bytes 73-88
  { key: 'srcX', off: 72, w: 4, always: true }, // 73-76
  { key: 'srcY', off: 76, w: 4, always: true }, // 77-80
  { key: 'rcvX', off: 80, w: 4, always: true }, // 81-84 group X
  { key: 'rcvY', off: 84, w: 4, always: true }, // 85-88 group Y
  { key: 'coordUnit', off: 88, w: 2, always: true }, // 89-90 coordinate units
  { key: 'nSamples', off: 114, w: 2, u: true, always: true }, // 115-116
  { key: 'sampInt', off: 116, w: 2, u: true, always: true }, // 117-118 (microseconds)
  { key: 'gainType', off: 118, w: 2, always: true }, // 119-120
  { key: 'gainConst', off: 120, w: 2, always: true }, // 121-122 instrument gain constant (dB)
  { key: 'lowCut', off: 148, w: 2, always: true }, // 149-150 low-cut frequency (Hz)
  { key: 'highCut', off: 150, w: 2, always: true }, // 151-152 high-cut frequency (Hz)
  { key: 'year', off: 156, w: 2, always: true }, // 157-158
  { key: 'day', off: 158, w: 2, always: true }, // 159-160
  { key: 'hour', off: 160, w: 2, always: true }, // 161-162
  { key: 'minute', off: 162, w: 2, always: true }, // 163-164
  { key: 'second', off: 164, w: 2, always: true }, // 165-166
  { key: 'muteStart', off: 110, w: 2, always: true }, // 111-112
  { key: 'muteEnd', off: 112, w: 2, always: true }, // 113-114
  { key: 'traceWeight', off: 168, w: 2, always: true }, // 169-170 trace weighting factor
  // -- present only when non-zero --
  { key: 'vertSumCount', off: 30, w: 2 }, // 31-32 number of vertically summed traces
  { key: 'horzStackCount', off: 32, w: 2 }, // 33-34 number of horizontally stacked traces
  { key: 'rcvDatumElev', off: 52, w: 4 }, // 53-56 datum elevation at receiver group
  { key: 'srcDatumElev', off: 56, w: 4 }, // 57-60 datum elevation at source
  { key: 'srcWaterDepth', off: 60, w: 4 }, // 61-64 water depth at source
  { key: 'rcvWaterDepth', off: 64, w: 4 }, // 65-68 water depth at group
  { key: 'weatheringVel', off: 90, w: 2 }, // 91-92
  { key: 'subWeatheringVel', off: 92, w: 2 }, // 93-94
  { key: 'srcUpholeTime', off: 94, w: 2 }, // 95-96 (ms)
  { key: 'rcvUpholeTime', off: 96, w: 2 }, // 97-98 (ms)
  { key: 'srcStatic', off: 98, w: 2 }, // 99-100 source static correction (ms)
  { key: 'rcvStatic', off: 100, w: 2 }, // 101-102 group static correction (ms)
  { key: 'totalStatic', off: 102, w: 2 }, // 103-104 total static applied (ms)
  { key: 'lagTimeA', off: 104, w: 2 }, // 105-106 (ms)
  { key: 'lagTimeB', off: 106, w: 2 }, // 107-108 (ms)
  { key: 'delayTime', off: 108, w: 2 }, // 109-110 delay recording time (ms)
  { key: 'initialGain', off: 122, w: 2 }, // 123-124 instrument early or initial gain (dB)
  { key: 'correlated', off: 124, w: 2 }, // 125-126
  { key: 'sweepFreqStart', off: 126, w: 2 }, // 127-128 (Hz)
  { key: 'sweepFreqEnd', off: 128, w: 2 }, // 129-130 (Hz)
  { key: 'sweepLength', off: 130, w: 2 }, // 131-132 (ms)
  { key: 'sweepType', off: 132, w: 2 }, // 133-134
  { key: 'sweepTaperStart', off: 134, w: 2 }, // 135-136 (ms)
  { key: 'sweepTaperEnd', off: 136, w: 2 }, // 137-138 (ms)
  { key: 'taperType', off: 138, w: 2 }, // 139-140
  { key: 'aliasFreq', off: 140, w: 2 }, // 141-142 alias filter frequency (Hz)
  { key: 'aliasSlope', off: 142, w: 2 }, // 143-144 (dB/octave)
  { key: 'notchFreq', off: 144, w: 2 }, // 145-146 notch filter frequency (Hz)
  { key: 'notchSlope', off: 146, w: 2 }, // 147-148 (dB/octave)
  { key: 'lowCutSlope', off: 152, w: 2 }, // 153-154 (dB/octave)
  { key: 'highCutSlope', off: 154, w: 2 }, // 155-156 (dB/octave)
  { key: 'timeBasis', off: 166, w: 2 }, // 167-168 time basis code
  { key: 'geophoneRoll1', off: 170, w: 2 }, // 171-172 group number of roll switch position one
  { key: 'geophoneFirst', off: 172, w: 2 }, // 173-174 group number of trace one
  { key: 'geophoneLast', off: 174, w: 2 }, // 175-176 group number of last trace
  { key: 'gapSize', off: 176, w: 2 }, // 177-178 total number of groups dropped
  { key: 'overTravel', off: 178, w: 2 }, // 179-180 over travel associated with taper
];

/** Bytes 181-232: SEG-Y rev 1 words. SEG-Y only - SU defines these bytes
 *  differently (d1, f1, d2, f2, ...), and rev 0 leaves them unassigned, so they
 *  are read from and written to rev 1+ SEG-Y only. Bytes 219-224 are carried as
 *  three two-byte words so the six bytes pass through exactly. 233-240 are
 *  unassigned. */
export const REV1_TRACE_WORDS: readonly TraceWord[] = [
  { key: 'cdpX', off: 180, w: 4 }, // 181-184 X of ensemble (CDP) position
  { key: 'cdpY', off: 184, w: 4 }, // 185-188
  { key: 'inline3d', off: 188, w: 4 }, // 189-192
  { key: 'crossline3d', off: 192, w: 4 }, // 193-196
  { key: 'shotPoint', off: 196, w: 4 }, // 197-200 shotpoint number (post-stack)
  { key: 'shotPointScalar', off: 200, w: 2 }, // 201-202
  { key: 'traceValueUnit', off: 202, w: 2 }, // 203-204 trace value measurement unit
  { key: 'transConstMant', off: 204, w: 4 }, // 205-208 transduction constant mantissa
  { key: 'transConstExp', off: 208, w: 2 }, // 209-210 transduction constant power of ten
  { key: 'transUnit', off: 210, w: 2 }, // 211-212 transduction units
  { key: 'deviceId', off: 212, w: 2 }, // 213-214 device/trace identifier
  { key: 'timeScalar', off: 214, w: 2 }, // 215-216 scalar for times in bytes 95-114
  { key: 'srcType', off: 216, w: 2 }, // 217-218 source type/orientation
  { key: 'srcEnergyDir1', off: 218, w: 2 }, // 219-220 source energy direction
  { key: 'srcEnergyDir2', off: 220, w: 2 }, // 221-222
  { key: 'srcEnergyDir3', off: 222, w: 2 }, // 223-224
  { key: 'srcMeasMant', off: 224, w: 4 }, // 225-228 source measurement mantissa
  { key: 'srcMeasExp', off: 228, w: 2 }, // 229-230 source measurement power of ten
  { key: 'srcMeasUnit', off: 230, w: 2 }, // 231-232 source measurement unit
];

/** SU's own fields after byte 180 (CWP segy.h: float d1, f1, d2, f2, ungpow,
 *  unscale; int ntr; short mark). Not SEG-Y words: read from and written to SU
 *  only, so SU -> SU keeps them and nothing else ever sees them as SEG-Y. */
export const SU_EXTRA_WORDS: readonly { key: string; off: number; t: 'f32' | 'i32' | 'i16' }[] = [
  { key: 'suD1', off: 180, t: 'f32' },
  { key: 'suF1', off: 184, t: 'f32' },
  { key: 'suD2', off: 188, t: 'f32' },
  { key: 'suF2', off: 192, t: 'f32' },
  { key: 'suUngpow', off: 196, t: 'f32' },
  { key: 'suUnscale', off: 200, t: 'f32' },
  { key: 'suNtr', off: 204, t: 'i32' },
  { key: 'suMark', off: 208, t: 'i16' },
];

/** Read `words` from the 240-byte header at `off` into `hdr`. The caller has
 *  already proved the 240 bytes are in the buffer. */
export function readTraceWords(b: Bytes, off: number, le: boolean, words: readonly TraceWord[], hdr: TraceHeader): void {
  for (const wd of words) {
    const p = off + wd.off;
    const v = wd.w === 4 ? r32s(b, p, le) : wd.u ? r16u(b, p, le) : r16s(b, p, le);
    if (wd.always || v !== 0) hdr[wd.key] = v;
  }
}

/** Read SU's own post-180 fields (non-zero, finite values only). */
export function readSuExtraWords(b: Bytes, off: number, le: boolean, hdr: TraceHeader): void {
  for (const wd of SU_EXTRA_WORDS) {
    const p = off + wd.off;
    const v = wd.t === 'f32' ? getF32(b, p, le) : wd.t === 'i32' ? r32s(b, p, le) : r16s(b, p, le);
    if (Number.isFinite(v) && v !== 0) hdr[wd.key] = v;
  }
}

/** A header value as an integer that fits a `w`-byte two's complement field, or
 *  null when it is absent, not a finite number, or would not fit. Out-of-range is
 *  left unwritten (zero, "not recorded") rather than wrapped into a wrong number. */
export function hdrWord(h: TraceHeader, key: string, w: 2 | 4, unsigned = false): number | null {
  const raw = h[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const v = Math.round(raw);
  if (v === 0) return null;
  if (w === 4) return v >= -2147483648 && v <= 2147483647 ? v : null;
  if (unsigned) return v >= 0 && v <= 65535 ? v : null;
  return v >= -32768 && v <= 32767 ? v : null;
}

/** Write every word of `words` that `h` carries into the big-endian header at
 *  `off` of `out`. Words the header does not carry stay zero. */
export function writeTraceWords(out: Bytes, off: number, h: TraceHeader, words: readonly TraceWord[]): void {
  for (const wd of words) {
    const v = hdrWord(h, wd.key, wd.w, wd.u);
    if (v == null) continue;
    const p = off + wd.off;
    if (wd.w === 4) {
      out[p] = (v >> 24) & 0xff;
      out[p + 1] = (v >> 16) & 0xff;
      out[p + 2] = (v >> 8) & 0xff;
      out[p + 3] = v & 0xff;
    } else {
      out[p] = (v >> 8) & 0xff;
      out[p + 1] = v & 0xff;
    }
  }
}

/** Write SU's own post-180 fields (big-endian, as writeSU emits). */
export function writeSuExtraWords(out: Bytes, off: number, h: TraceHeader): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (const wd of SU_EXTRA_WORDS) {
    const raw = h[wd.key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw === 0) continue;
    const p = off + wd.off;
    if (wd.t === 'f32') view.setFloat32(p, raw, false);
    else if (wd.t === 'i32') { const v = Math.round(raw); if (v >= -2147483648 && v <= 2147483647) view.setInt32(p, v, false); }
    else { const v = Math.round(raw); if (v >= -32768 && v <= 32767) view.setInt16(p, v, false); }
  }
}

/**
 * Pick the SEG-Y coordinate scalar for real-world values that arrived with none
 * (SEG-2 locations are decimal numbers): the smallest of 1, -10, -100, -1000,
 * -10000 that stores every value exactly as an integer, and never one that would
 * overflow int32. When no scalar is exact, the finest that still fits. Returns 1
 * for an empty or all-integer set.
 */
export function chooseCoordScalar(values: readonly number[]): number {
  const vals = values.filter((v) => Number.isFinite(v));
  if (!vals.length) return 1;
  const maxAbs = vals.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  let best = 1;
  for (let k = 0; k <= 4; k++) {
    const f = 10 ** k;
    if (maxAbs * f > 2147483647) break;
    best = k === 0 ? 1 : -f;
    if (vals.every((v) => Math.abs(v * f - Math.round(v * f)) < 1e-6)) return best;
  }
  return best;
}

/** Real value -> raw integer for a SEG-Y scalar (negative divides on read, so it
 *  multiplies here; positive multiplies on read, so it divides here). */
export function encodeWithScalar(real: number, scalar: number): number {
  if (!Number.isFinite(real)) return 0;
  if (scalar < 0) return Math.round(real * -scalar);
  if (scalar > 1) return Math.round(real / scalar);
  return Math.round(real);
}
