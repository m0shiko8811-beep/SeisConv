// seisconv-core / sps - Load geometry into SEG-Y (Geometry Integrity Suite, write side).
//
// The WRITE counterpart to geomcheck.ts: instead of REPORTING whether a SEG-Y's
// trace-header geometry agrees with an SPS survey, it STAMPS the SPS survey's
// authoritative coordinates into the SEG-Y trace headers and returns a new,
// geometry-loaded SEG-Y.
//
// Faithful by design - it PATCHES the original bytes in place: every trace keeps
// its samples, its textual / binary headers and every non-geometry trace-header
// field byte-for-byte; only the geometry fields are overwritten. (Re-emitting via
// writeSEGY would re-encode samples to IEEE-f32 and drop most header fields.)
//
// Matching REUSES geomcheck's primitives (the SPS spatial grid + nearestInGrid +
// the by-point-number index + applyScalar) so a trace is paired to its source /
// receiver exactly the way the check pairs it - no second matching algorithm.
//
// PURE: no DOM / Node / Electron, no I/O. Bounds every loop (MAX_TRACES /
// MAX_SAMPLES_PER_TRACE via the shared decoder), never throws on a bad/garbage
// match (it is collected as "unmatched", the trace is left untouched), and never
// writes a non-finite value into a header.

import type { Bytes } from '../types';
import { MAX_TRACES } from '../types';
import { dv } from '../binary';
import { decodeSegyTrace, parseSegyMeta } from '../formats/segy';
import type { SPSData, SPSPoint } from './parse';
import { applyScalar, buildGrid, nearestInGrid } from './geomcheck';

// SEG-Y rev1 trace-header byte offsets (0-based within the 240-byte header) of the
// geometry fields this loader writes. These mirror exactly what segy.ts' parser
// reads back (decodeSegyTrace), so a re-parse round-trips every field except the
// CDP pair (which the parser doesn't surface; read it straight from the bytes).
const OFF_OFFSET = 36; // bytes 37-40   source→receiver distance (int32, unscaled)
const OFF_RCV_ELEV = 40; // bytes 41-44   receiver group elevation (int32, *elevScalar)
const OFF_SRC_ELEV = 44; // bytes 45-48   surface elevation at source (int32, *elevScalar)
const OFF_ELEV_SCALAR = 68; // bytes 69-70   elevation scalar (int16)
const OFF_COORD_SCALAR = 70; // bytes 71-72   coordinate scalar (int16)
const OFF_SRC_X = 72; // bytes 73-76   source X (int32, *coordScalar)
const OFF_SRC_Y = 76; // bytes 77-80   source Y
const OFF_GRP_X = 80; // bytes 81-84   group (receiver) X
const OFF_GRP_Y = 84; // bytes 85-88   group (receiver) Y
const OFF_CDP_X = 180; // bytes 181-184 CDP / ensemble X
const OFF_CDP_Y = 184; // bytes 185-188 CDP / ensemble Y

/** SEG-Y coordinate/elevation scalars allowed by the spec (1, ±10…±10000). The
 *  selector offers these; anything else falls back to the default. */
export const GEOMLOAD_SCALARS: readonly number[] = [1, -10, -100, -1000, -10000];
const DEFAULT_SCALAR = -100; // → 2 decimal places preserved (store value × 100)

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

/** Clamp a (rounded) integer into the signed-32-bit range so an over-range value
 *  can never wrap to a wrong number when written with DataView.setInt32. */
function clampI32(v: number): number {
  if (!isFinite(v)) return 0;
  const r = Math.round(v);
  return r < I32_MIN ? I32_MIN : r > I32_MAX ? I32_MAX : r;
}

/**
 * Encode a real-world coordinate/elevation into the raw integer SEG-Y stores for
 * a given scalar - the EXACT inverse of geomcheck's {@link applyScalar} reader, so
 * `applyScalar(encodeScalar(v, s), s) === v` (to rounding). Per the SEG-Y spec the
 * stored value is multiplied by a positive scalar / divided by |negative scalar|
 * to recover the real value; this inverts that:
 *   scalar < 0 → raw = real * |scalar|   (e.g. -100 stores hundredths → 2 dp)
 *   scalar > 0 → raw = real / scalar
 *   scalar 0/1 → raw = round(real)
 * Finite-guarded and int32-clamped (a non-finite real encodes to 0).
 */
export function encodeScalar(real: number, scalar: number): number {
  if (!isFinite(real)) return 0;
  if (!isFinite(scalar) || scalar === 0) return clampI32(real);
  const raw = scalar < 0 ? real * Math.abs(scalar) : real / scalar;
  return clampI32(raw);
}

/** Sanitize a requested coordinate scalar to an allowed spec value (default -100). */
function sanitizeScalar(s: number | undefined): number {
  return typeof s === 'number' && GEOMLOAD_SCALARS.includes(s) ? s : DEFAULT_SCALAR;
}

export interface GeomLoadOptions {
  /** Station-match tolerance in metres (default 2 - mirrors geomcheck). */
  tolM?: number;
  /** Output coordinate + elevation scalar (one of {@link GEOMLOAD_SCALARS}; default -100). */
  coordScalar?: number;
  /** Write source + group (receiver) X/Y (default true). */
  writeCoords?: boolean;
  /** Write source + receiver-group elevation (default true). */
  writeElev?: boolean;
  /** Write the source→receiver offset (default true). */
  writeOffset?: boolean;
  /** Write the CDP / ensemble midpoint X/Y (default true). */
  writeCdp?: boolean;
}

export interface GeomLoadResult {
  /** The geometry-loaded SEG-Y bytes (a copy of the input with headers stamped). */
  bytes: Bytes;
  traceCount: number;
  /** Traces whose source AND receiver both resolved to an SPS station. */
  matched: number;
  /** Traces whose source resolved (by point number or position). */
  srcMatched: number;
  /** Traces whose receiver resolved (nearest SPS receiver within tol). */
  rcvMatched: number;
  /** Traces with neither source nor receiver resolved (left untouched). */
  unmatched: number;
  /** Distinct SPS source / receiver stations stamped into ≥1 trace. */
  srcStations: number;
  rcvStations: number;
  /** Coordinate + elevation scalar actually written. */
  coordScalar: number;
  /** Human-readable list of the field groups written at least once. */
  fieldsWritten: string[];
  errors: string[];
}

/** A real-world coordinate triple the matcher resolves a trace's source/receiver to. */
interface Station {
  e: number;
  n: number;
  z: number;
  idx: number;
}

/**
 * Stamp the `sps` survey's source / receiver coordinates into the trace headers of
 * the SEG-Y in `b` and return the patched bytes plus a load summary.
 *
 * Each trace is paired to its source + receiver REUSING geomcheck's matching: the
 * source by header source-POINT number (the SPS by-point index) and, when that
 * isn't in the SPS numbering or the header carries coordinates that disagree, by
 * POSITION (nearest SPS source within tol); the receiver by POSITION (nearest SPS
 * receiver within tol). For a matched trace it writes - subject to the field-group
 * opts - source X/Y, group X/Y, source + receiver elevation, the source→receiver
 * offset, the CDP midpoint X/Y, and the coordinate + elevation scalars. Coordinates
 * are encoded with the caller's scalar ({@link encodeScalar}); the offset is an
 * unscaled integer distance. Unmatched / partially-matched traces keep whatever
 * geometry they already carried - nothing is zeroed.
 *
 * Bounded + total: walks at most MAX_TRACES traces, never throws, and never writes
 * a non-finite value (every numeric is finite-guarded + int32-clamped).
 */
export function loadGeometry(b: Bytes, sps: SPSData, opts?: GeomLoadOptions): GeomLoadResult {
  const errors: string[] = [];
  const tol = isFinite(opts?.tolM as number) && (opts?.tolM as number) > 0 ? (opts!.tolM as number) : 2;
  const coordScalar = sanitizeScalar(opts?.coordScalar);
  const elevScalar = coordScalar; // one selector drives both scalar fields
  const writeCoords = opts?.writeCoords !== false;
  const writeElev = opts?.writeElev !== false;
  const writeOffset = opts?.writeOffset !== false;
  const writeCdp = opts?.writeCdp !== false;

  // Copy the input so the caller's bytes are never mutated; the patch lands here.
  const out = b instanceof Uint8Array ? b.slice() : new Uint8Array(b);
  const result: GeomLoadResult = {
    bytes: out,
    traceCount: 0,
    matched: 0,
    srcMatched: 0,
    rcvMatched: 0,
    unmatched: 0,
    srcStations: 0,
    rcvStations: 0,
    coordScalar,
    fieldsWritten: [],
    errors,
  };

  if (out.length < 3600) {
    errors.push('File < 3600 bytes - not a SEG-Y');
    return result;
  }
  const sources: SPSPoint[] = sps && Array.isArray(sps.sources) ? sps.sources : [];
  const receivers: SPSPoint[] = sps && Array.isArray(sps.receivers) ? sps.receivers : [];
  if (!sources.length && !receivers.length) {
    errors.push('SPS survey carries no source or receiver stations to load');
    return result;
  }

  const meta = parseSegyMeta(out);
  const view = dv(out);
  const le = meta.le;
  const cell = Math.max(tol, 1e-6);

  // -- SPS lookup structures (geomcheck's primitives) --
  const srcGrid = buildGrid(sources, cell);
  const rcvGrid = buildGrid(receivers, cell);
  // SPS sources indexed by point number → candidate indices (a point may recur
  // across lines; the nearest to the header position wins). A Map sidesteps any
  // prototype-pollution on the numeric-derived key.
  const srcByPoint = new Map<number, number[]>();
  for (let i = 0; i < sources.length; i++) {
    const p = sources[i].point;
    if (!isFinite(p)) continue;
    const arr = srcByPoint.get(p);
    if (arr) arr.push(i);
    else srcByPoint.set(p, [i]);
  }

  /** Resolve a shot to an SPS source station (idx + real E/N/Z) or null. By point
   *  number first (trusting the number when the header has no coords; gating on tol
   *  when it does), else nearest position within tol. Mirrors geomcheck's source
   *  branch. */
  const matchSource = (srcPt: number, sx: number, sy: number): Station | null => {
    const hasPos = isFinite(sx) && isFinite(sy) && (sx !== 0 || sy !== 0);
    const cands = srcByPoint.get(srcPt);
    if (cands && cands.length) {
      let bestI = -1, bestD = Infinity;
      for (const ci of cands) {
        const s = sources[ci];
        const d = hasPos ? Math.hypot(sx - s.easting, sy - s.northing) : 0;
        if (d < bestD) { bestD = d; bestI = ci; }
      }
      if (bestI >= 0 && (!hasPos || bestD <= tol)) {
        const s = sources[bestI];
        return { e: s.easting, n: s.northing, z: s.elevation, idx: bestI };
      }
    }
    if (hasPos) {
      const near = nearestInGrid(srcGrid, sources, sx, sy, cell);
      if (near.idx >= 0 && near.d <= tol) {
        const s = sources[near.idx];
        return { e: s.easting, n: s.northing, z: s.elevation, idx: near.idx };
      }
    }
    return null;
  };

  /** Resolve a trace's receiver to an SPS receiver station by nearest position
   *  within tol (geomcheck's receiver branch). Needs header receiver coordinates. */
  const matchReceiver = (rx: number, ry: number): Station | null => {
    if (!(isFinite(rx) && isFinite(ry) && (rx !== 0 || ry !== 0))) return null;
    const near = nearestInGrid(rcvGrid, receivers, rx, ry, cell);
    if (near.idx >= 0 && near.d <= tol) {
      const r = receivers[near.idx];
      return { e: r.easting, n: r.northing, z: r.elevation, idx: near.idx };
    }
    return null;
  };

  // Per-FFID source cache: all traces of one shot share a source, so resolve it
  // once (from the first geometry-bearing trace of the shot) and reuse - exactly
  // geomcheck's shotByFfid model. `undefined` = not yet tried; `null` = tried, no match.
  const shotSrc = new Map<number, Station | null>();
  const srcStationSet = new Set<number>();
  const rcvStationSet = new Set<number>();
  // Track which field groups actually got written (for the summary).
  let wroteSrcXY = false, wroteGrpXY = false, wroteElev = false, wroteOff = false, wroteCdp = false;

  // -- Trace walk + in-place patch (mirrors parseSEGY's bounded walk so we land on
  //    real trace-header boundaries; on a bad ns we use the same recovery stride). --
  let off = meta.dataStart;
  let tc = 0;
  while (off + 240 <= out.length && tc < MAX_TRACES) {
    const res = decodeSegyTrace(out, off, meta, false);
    if (!res) {
      // Mirror parseSEGY: an out-of-range ns skips with the recovery stride; an
      // in-range ns means the samples ran past the buffer end → stop.
      const ns = view.getUint16(off + 114, le) || meta.defaultNs;
      if (ns <= 0 || ns > 1000000) {
        off += 240 + meta.addHdrBytes + Math.max(meta.defaultNs > 0 ? meta.defaultNs * meta.bps : 0, 4);
        continue;
      }
      break;
    }
    const h = res.trace.hdr;
    const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);
    const hdrScalar = num(h.coordScalar);
    const ffid = num(h.fieldRec);
    const srcPt = num(h.srcPt);
    const sxReal = applyScalar(num(h.srcX), hdrScalar);
    const syReal = applyScalar(num(h.srcY), hdrScalar);
    const rxReal = applyScalar(num(h.rcvX), hdrScalar);
    const ryReal = applyScalar(num(h.rcvY), hdrScalar);

    // Source (cached per FFID).
    let src = shotSrc.get(ffid);
    if (src === undefined) {
      src = matchSource(srcPt, sxReal, syReal);
      shotSrc.set(ffid, src);
    }
    const rcv = matchReceiver(rxReal, ryReal);

    if (src) { result.srcMatched++; srcStationSet.add(src.idx); }
    if (rcv) { result.rcvMatched++; rcvStationSet.add(rcv.idx); }
    if (src && rcv) result.matched++;
    if (!src && !rcv) result.unmatched++;

    // -- Patch this trace's geometry fields (each group guarded + opt-gated) --
    let coordTouched = false, elevTouched = false;
    if (writeCoords && src) {
      view.setInt32(off + OFF_SRC_X, encodeScalar(src.e, coordScalar), le);
      view.setInt32(off + OFF_SRC_Y, encodeScalar(src.n, coordScalar), le);
      wroteSrcXY = true; coordTouched = true;
    }
    if (writeCoords && rcv) {
      view.setInt32(off + OFF_GRP_X, encodeScalar(rcv.e, coordScalar), le);
      view.setInt32(off + OFF_GRP_Y, encodeScalar(rcv.n, coordScalar), le);
      wroteGrpXY = true; coordTouched = true;
    }
    if (writeElev && src && isFinite(src.z)) {
      view.setInt32(off + OFF_SRC_ELEV, encodeScalar(src.z, elevScalar), le);
      wroteElev = true; elevTouched = true;
    }
    if (writeElev && rcv && isFinite(rcv.z)) {
      view.setInt32(off + OFF_RCV_ELEV, encodeScalar(rcv.z, elevScalar), le);
      wroteElev = true; elevTouched = true;
    }
    if (writeOffset && src && rcv) {
      const dist = Math.hypot(src.e - rcv.e, src.n - rcv.n);
      if (isFinite(dist)) { view.setInt32(off + OFF_OFFSET, clampI32(dist), le); wroteOff = true; }
    }
    if (writeCdp && src && rcv) {
      const midE = (src.e + rcv.e) / 2, midN = (src.n + rcv.n) / 2;
      if (isFinite(midE) && isFinite(midN)) {
        view.setInt32(off + OFF_CDP_X, encodeScalar(midE, coordScalar), le);
        view.setInt32(off + OFF_CDP_Y, encodeScalar(midN, coordScalar), le);
        wroteCdp = true; coordTouched = true;
      }
    }
    // Stamp the scalars only on traces we actually touched, so an untouched trace
    // keeps its original scalar (we never zero a field we didn't rewrite).
    if (coordTouched) view.setInt16(off + OFF_COORD_SCALAR, coordScalar, le);
    if (elevTouched) view.setInt16(off + OFF_ELEV_SCALAR, elevScalar, le);

    off += res.stride;
    tc++;
  }

  result.traceCount = tc;
  result.srcStations = srcStationSet.size;
  result.rcvStations = rcvStationSet.size;

  const fields: string[] = [];
  if (wroteSrcXY) fields.push('source X/Y');
  if (wroteGrpXY) fields.push('group (receiver) X/Y');
  if (wroteElev) fields.push('source/receiver elevation');
  if (wroteOff) fields.push('source→receiver offset');
  if (wroteCdp) fields.push('CDP X/Y');
  if (wroteSrcXY || wroteGrpXY || wroteCdp) fields.push('coordinate scalar');
  if (wroteElev) fields.push('elevation scalar');
  result.fieldsWritten = fields;

  if (tc === 0) errors.push('No readable SEG-Y traces found to load geometry into');
  return result;
}
