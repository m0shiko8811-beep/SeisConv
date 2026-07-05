// seisconv-core / sps — survey renumbering engine (feature A).
//
// Re-number an SPS survey's line and point identifiers while keeping every
// cross-reference (X) relation internally consistent. Two equivalent paths:
//   • applyRenumberToData  — transforms a parsed SPSData (in-memory model);
//   • renumberSPSText      — column-splices ONLY the line/point/idx columns of
//     the raw 80-col lines (mirrors reprojectSPS), so non-modeled vendor columns
//     survive byte-for-byte.
// Point remaps are restricted to monotonic transforms (affine scale>0, or a
// per-line sequential start/inc) so X `from..to` ranges stay contiguous + valid.
// Pure — no DOM/Node/Electron.

import type { SPSData, SPSPoint, SPSXref } from './parse';
import { fmtSPSNum, padSPSField } from './write';

/** Per-category (source or receiver) renumbering instructions. */
export interface LineRenumber {
  /** Sequential line renumber: distinct lines (numeric-sorted) → start, +inc each. */
  lineStart?: number;
  lineInc?: number;
  /** Explicit old-line → new-line map (takes precedence over lineStart/lineInc). */
  lineMap?: Record<string, string>;
  /** Sequential point renumber per line: points (ascending) → start, +inc each. */
  pointStart?: number;
  pointInc?: number;
  /** Affine point renumber: new = old·pointScale + pointOffset. */
  pointOffset?: number;
  pointScale?: number;
}

export interface RenumberSpec {
  source?: LineRenumber;
  receiver?: LineRenumber;
}

/** A resolved point transform — either affine or a per-line sequential lookup. */
export interface PointTransform {
  mode: 'identity' | 'affine' | 'sequential';
  scale: number;
  offset: number;
  /** sequential mode: `${oldLine}|${oldPoint}` → new point. */
  map: Map<string, number>;
}

/** Resolved maps for one category (source or receiver). */
export interface LineMaps {
  /** old line → new line (empty map = identity). */
  line: Map<string, string>;
  point: PointTransform;
}

export interface RenumberMaps {
  source: LineMaps;
  receiver: LineMaps;
}

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const IDENTITY: PointTransform = { mode: 'identity', scale: 1, offset: 0, map: new Map() };

function num(v: string | number | undefined): number {
  return typeof v === 'number' ? v : v != null ? parseFloat(String(v)) : NaN;
}

/** Distinct line names in first-seen, then numeric-then-lexical, order. */
function distinctLines(pts: SPSPoint[]): string[] {
  const seen = new Set<string>();
  for (const p of pts) seen.add((p.lineName || '').trim());
  return [...seen].sort((a, b) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (isFinite(na) && isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function buildLineMap(pts: SPSPoint[], lr?: LineRenumber): Map<string, string> {
  const m = new Map<string, string>();
  if (!lr) return m;
  if (lr.lineMap) {
    for (const k of Object.keys(lr.lineMap)) {
      if (PROTO_KEYS.has(k)) continue; // reject prototype-pollution keys
      m.set(k.trim(), String(lr.lineMap[k]).trim());
    }
    return m;
  }
  if (lr.lineStart != null) {
    const inc = lr.lineInc ?? 1;
    if (!isFinite(lr.lineStart) || !isFinite(inc))
      throw new Error('renumber: lineStart/lineInc must be finite numbers');
    distinctLines(pts).forEach((ln, i) => m.set(ln, String(lr.lineStart! + i * inc)));
  }
  return m;
}

function buildPointTransform(pts: SPSPoint[], lr?: LineRenumber): PointTransform {
  if (!lr) return IDENTITY;
  if (lr.pointStart != null) {
    const inc = lr.pointInc ?? 1;
    if (!isFinite(lr.pointStart) || !(inc > 0))
      throw new Error('renumber: pointInc must be a finite value > 0 (monotonic)');
    // Sequential per line: ascending old points → start, +inc each.
    const byLine = new Map<string, SPSPoint[]>();
    for (const p of pts) {
      const k = (p.lineName || '').trim();
      (byLine.get(k) || byLine.set(k, []).get(k)!).push(p);
    }
    const map = new Map<string, number>();
    for (const [line, arr] of byLine) {
      arr.slice().sort((a, b) => a.point - b.point).forEach((p, i) => map.set(`${line}|${p.point}`, lr.pointStart! + i * inc));
    }
    return { mode: 'sequential', scale: 1, offset: 0, map };
  }
  if (lr.pointScale != null || lr.pointOffset != null) {
    const scale = lr.pointScale ?? 1;
    const offset = lr.pointOffset ?? 0;
    if (!(scale > 0)) throw new Error('renumber: pointScale must be > 0 to keep point ranges monotonic');
    if (!isFinite(offset)) throw new Error('renumber: pointOffset must be finite');
    return { mode: 'affine', scale, offset, map: new Map() };
  }
  return IDENTITY;
}

/**
 * Resolve a {@link RenumberSpec} against the survey into concrete maps. Throws a
 * clear error on a non-monotonic / non-finite point transform (so X `from..to`
 * ranges can never be inverted).
 */
export function buildRenumberMaps(data: SPSData, spec: RenumberSpec): RenumberMaps {
  return {
    source: { line: buildLineMap(data.sources, spec.source), point: buildPointTransform(data.sources, spec.source) },
    receiver: { line: buildLineMap(data.receivers, spec.receiver), point: buildPointTransform(data.receivers, spec.receiver) },
  };
}

function remapLine(m: LineMaps, line: string | undefined): string {
  const k = (line || '').toString().trim();
  return m.line.get(k) ?? k;
}

function remapPoint(m: LineMaps, line: string | undefined, point: number): number {
  if (!isFinite(point)) return point;
  const t = m.point;
  if (t.mode === 'affine') return point * t.scale + t.offset;
  if (t.mode === 'sequential') {
    const v = t.map.get(`${(line || '').toString().trim()}|${point}`);
    return v != null ? v : point;
  }
  return point;
}

/**
 * Apply the resolved maps to a parsed {@link SPSData}, returning a NEW SPSData
 * with renumbered sources, receivers AND cross-references (srcLine/srcPt,
 * rcvLine/rcvLineFrom/rcvLineTo, rcvPtFrom/rcvPtTo). Headers / projection / error
 * provenance are carried through unchanged.
 */
export function applyRenumberToData(data: SPSData, maps: RenumberMaps): SPSData {
  const mapPts = (arr: SPSPoint[], m: LineMaps): SPSPoint[] =>
    arr.map((p) => ({ ...p, point: remapPoint(m, p.lineName, p.point), lineName: remapLine(m, p.lineName) }));

  const xrefs: SPSXref[] = data.xrefs.map((x) => {
    const srcLineOld = String(x.srcLine ?? '').trim();
    const rcvLineOld = String(x.rcvLine ?? x.rcvLineFrom ?? '').trim();
    const rcvFromLineOld = String(x.rcvLineFrom ?? x.rcvLine ?? '').trim();
    const rcvToLineOld = String(x.rcvLineTo ?? x.rcvLineFrom ?? x.rcvLine ?? '').trim();
    const out: SPSXref = { ...x };
    if (x.srcLine != null) out.srcLine = remapLine(maps.source, srcLineOld);
    if (x.srcPt != null) out.srcPt = remapPoint(maps.source, srcLineOld, num(x.srcPt));
    if (x.rcvLine != null) out.rcvLine = remapLine(maps.receiver, rcvLineOld);
    if (x.rcvLineFrom != null) out.rcvLineFrom = remapLine(maps.receiver, rcvFromLineOld);
    if (x.rcvLineTo != null) out.rcvLineTo = remapLine(maps.receiver, rcvToLineOld);
    if (x.rcvPtFrom != null) out.rcvPtFrom = remapPoint(maps.receiver, rcvFromLineOld, num(x.rcvPtFrom));
    if (x.rcvPtTo != null) out.rcvPtTo = remapPoint(maps.receiver, rcvToLineOld, num(x.rcvPtTo));
    return out;
  });

  return {
    ...data,
    sources: mapPts(data.sources, maps.source),
    receivers: mapPts(data.receivers, maps.receiver),
    xrefs,
  };
}

/**
 * Column-splice the raw 80-col lines of one SPS file, rewriting ONLY the
 * line/point/idx columns (S/R) or the src/rcv line+point columns (X). Every other
 * column — coordinates, channel ranges, point-index flags, vendor tails beyond
 * col 80 — is preserved byte-for-byte (mirrors {@link reprojectSPS}). H/comment
 * and unrecognised lines pass through unchanged.
 */
export function renumberSPSText(srcLines: string[], spsType: 'S' | 'R' | 'X', maps: RenumberMaps): string {
  const out: string[] = [];
  for (const raw of srcLines) {
    if (!raw.trim()) { out.push(raw); continue; }
    const t = raw[0]?.toUpperCase();
    // Keep the original tail (incl. any column past 80) — pad only up to col 80.
    const base = raw.length >= 80 ? raw : raw.padEnd(80, ' ');

    if (spsType !== 'X' && (t === 'S' || t === 'R')) {
      const m = spsType === 'S' ? maps.source : maps.receiver;
      const oldLine = base.substring(1, 11).trim();
      const oldPoint = parseFloat(base.substring(11, 21));
      const spliced =
        base.substring(0, 1) +
        padSPSField(remapLine(m, oldLine), 10) +
        fmtSPSNum(remapPoint(m, oldLine, oldPoint), 10) +
        base.substring(21);
      out.push(spliced);
      continue;
    }

    if (spsType === 'X' && t === 'X') {
      const srcPt = parseFloat(base.substring(27, 37));
      if (isFinite(srcPt) && Math.abs(srcPt) > 0) {
        const oldSrcLine = base.substring(17, 27).trim();
        const oldRcvLine = base.substring(49, 59).trim();
        const oldRcvFrom = parseFloat(base.substring(59, 69));
        const oldRcvTo = parseFloat(base.substring(69, 79));
        const spliced =
          base.substring(0, 17) +
          padSPSField(remapLine(maps.source, oldSrcLine), 10) +
          fmtSPSNum(remapPoint(maps.source, oldSrcLine, srcPt), 10) +
          base.substring(37, 49) +
          padSPSField(remapLine(maps.receiver, oldRcvLine), 10) +
          fmtSPSNum(remapPoint(maps.receiver, oldRcvLine, oldRcvFrom), 10) +
          fmtSPSNum(remapPoint(maps.receiver, oldRcvLine, oldRcvTo), 10) +
          base.substring(79);
        out.push(spliced);
        continue;
      }
    }

    out.push(raw);
  }
  return out.join('\n');
}
