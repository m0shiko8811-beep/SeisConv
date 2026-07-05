// seisconv-core — binary + EBCDIC helpers
//
// Byte-level readers/writers shared by every parser/writer. Big-endian unless
// noted (SEG-Y/SEG-D are big-endian; SEG-2 is little-endian and handled inline
// in its parser). Ported verbatim from the SeisConv reference so numeric output
// is bit-identical.
//
// NOTE (Hermes): big-endian DataView reads must be validated on-device, not just
// in Node — see the plan's risk list.

import type { Bytes } from './types';

// ───────────────────────── EBCDIC ─────────────────────────

/** EBCDIC code page → ASCII lookup (IBM CP037-ish, as used by SEG-Y textual headers). */
// prettier-ignore
export const E2A: readonly number[] = [0,1,2,3,156,9,134,127,151,141,142,11,12,13,14,15,16,17,18,19,157,133,8,135,24,25,146,143,28,29,30,31,128,129,130,131,132,10,23,27,136,137,138,139,140,5,6,7,144,145,22,147,148,149,150,4,152,153,154,155,20,21,158,26,32,160,161,162,163,164,165,166,167,168,91,46,60,40,43,33,38,169,170,171,172,173,174,175,176,177,93,36,42,41,59,94,45,47,178,179,180,181,182,183,184,185,124,44,37,95,62,63,186,187,188,189,190,191,192,193,194,96,58,35,64,39,61,34,195,97,98,99,100,101,102,103,104,105,196,197,198,199,200,201,202,106,107,108,109,110,111,112,113,114,203,204,205,206,207,208,209,126,115,116,117,118,119,120,121,122,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,123,65,66,67,68,69,70,71,72,73,232,233,234,235,236,237,125,74,75,76,77,78,79,80,81,82,238,239,240,241,242,243,92,159,83,84,85,86,87,88,89,90,244,245,246,247,248,249,48,49,50,51,52,53,54,55,56,57,250,251,252,253,254,255];

/** Decode EBCDIC bytes to a printable ASCII string (non-printables → space). */
export function ebcdic(b: Bytes): string {
  return Array.from(b)
    .map((x) => {
      const c = E2A[x];
      return c >= 32 && c < 127 ? String.fromCharCode(c) : ' ';
    })
    .join('');
}

/** Decode ASCII/Latin bytes to a printable string (non-printables → space). */
export function asciiPrintable(b: Bytes): string {
  return Array.from(b)
    .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : ' '))
    .join('');
}

// ASCII → EBCDIC inverse of E2A (CP037 is a bijection, so the inverse is exact),
// built once on first use. Used by the SEG-Y writer: rev 0 requires an EBCDIC
// textual header and EBCDIC is the spec default for rev 1.
let A2E: Uint8Array | null = null;

/** Encode one ASCII char code as its EBCDIC (CP037) byte. */
export function asciiToEbcdic(c: number): number {
  if (!A2E) {
    A2E = new Uint8Array(256);
    for (let e = 0; e < 256; e++) A2E[E2A[e]] = e;
  }
  return A2E[c & 0xff];
}

// ─────────────────────── integer reads (big-endian default) ───────────────────────
//
// Big-endian by default (SEG-Y/SEG-D/SU read BE). Pass `le=true` to read the
// same bytes little-endian — used by the SEG-Y parser once it has auto-detected
// a little-endian file. The default keeps every existing caller bit-identical.

export const r16s = (b: Bytes, o: number, le = false): number => {
  const v = le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
  return v > 32767 ? v - 65536 : v;
};
export const r16u = (b: Bytes, o: number, le = false): number =>
  le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
export const r32s = (b: Bytes, o: number, le = false): number => {
  const v =
    (le
      ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
      : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  return v > 2147483647 ? v - 4294967296 : v;
};
export const r32u = (b: Bytes, o: number, le = false): number =>
  (le
    ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
    : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

// ─────────────────────── integer writes (big-endian) ───────────────────────

export function w16(b: Bytes, o: number, v: number): void {
  v &= 0xffff;
  b[o] = (v >> 8) & 0xff;
  b[o + 1] = v & 0xff;
}
export function w32(b: Bytes, o: number, v: number): void {
  b[o] = (v >> 24) & 0xff;
  b[o + 1] = (v >> 16) & 0xff;
  b[o + 2] = (v >> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

// ─────────────────────── float helpers ───────────────────────

// Scratch DataView for single IEEE-754 conversions.
const _d4 = new DataView(new ArrayBuffer(8));

// Cached DataView per source array — avoids thousands of allocations in tight
// parse/write loops. Keyed on the Uint8Array itself (not its buffer) so views
// that share a buffer at different byte offsets never collide.
const _dvc = new WeakMap<Bytes, DataView>();
/** Get a cached DataView covering the same bytes as `b`. */
export function dv(b: Bytes): DataView {
  let d = _dvc.get(b);
  if (!d) {
    d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    _dvc.set(b, d);
  }
  return d;
}

// ─────────────────── bounds-safe DataView reads ───────────────────
//
// DataView.getX throws 'Offset is outside the bounds of the DataView' when the
// read runs past the buffer end. On a truncated / variable-length / garbage
// trace that throw aborts the whole parse (and, batched, masquerades as a
// per-file failure). These wrappers return 0 instead of throwing, so parsers
// degrade gracefully on a short buffer while staying bit-identical on valid
// data (an in-range read goes straight through to the native DataView).

/** Big-endian float32; returns 0 if o+4 exceeds the buffer. `le` for little-endian. */
export function getF32(b: Bytes, o: number, le = false): number {
  if (o < 0 || o + 4 > b.byteLength) return 0;
  return dv(b).getFloat32(o, le);
}
/** Big-endian float64; returns 0 if o+8 exceeds the buffer. `le` for little-endian. */
export function getF64(b: Bytes, o: number, le = false): number {
  if (o < 0 || o + 8 > b.byteLength) return 0;
  return dv(b).getFloat64(o, le);
}
/** Big-endian int32; returns 0 if o+4 exceeds the buffer. `le` for little-endian. */
export function getI32(b: Bytes, o: number, le = false): number {
  if (o < 0 || o + 4 > b.byteLength) return 0;
  return dv(b).getInt32(o, le);
}
/** Big-endian int16; returns 0 if o+2 exceeds the buffer. `le` for little-endian. */
export function getI16(b: Bytes, o: number, le = false): number {
  if (o < 0 || o + 2 > b.byteLength) return 0;
  return dv(b).getInt16(o, le);
}

/** Read a big-endian IEEE-754 float32. */
export function rIEEE(b: Bytes, o: number): number {
  _d4.setUint8(0, b[o]);
  _d4.setUint8(1, b[o + 1]);
  _d4.setUint8(2, b[o + 2]);
  _d4.setUint8(3, b[o + 3]);
  return _d4.getFloat32(0, false);
}

/** Write a big-endian IEEE-754 float32. */
export function wIEEE(b: Bytes, o: number, v: number): void {
  _d4.setFloat32(0, v, false);
  b[o] = _d4.getUint8(0);
  b[o + 1] = _d4.getUint8(1);
  b[o + 2] = _d4.getUint8(2);
  b[o + 3] = _d4.getUint8(3);
}

/** Decode a 4-byte IBM System/360 hexadecimal float (SEG-Y data format 1). */
export function ibm2f(b: Bytes, o: number): number {
  const s = b[o] & 0x80 ? -1 : 1;
  const e = (b[o] & 0x7f) - 64;
  const m = ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) / 16777216;
  return m === 0 ? 0 : s * m * Math.pow(16, e);
}

/** Decode a single BCD byte (two packed decimal digits) to its integer value. */
export function bcd2(x: number): number {
  return ((x >> 4) & 0xf) * 10 + (x & 0xf);
}

/** Human-readable byte size. */
export function fmtBytes(n: number): string {
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}
