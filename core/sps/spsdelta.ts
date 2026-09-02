// seisconv-core / sps - As-laid vs Pre-plot delta ("skid report").
//
// Compare an AS-LAID SPS survey (where the crew's RTK actually planted each
// source / receiver station) against its REFERENCE pre-plot (the planned, on-grid
// design) and report, station by station, the positional skid: the easting /
// northing offset and the plan-to-actual distance, with a tolerance flag. This is
// the RTK "as-laid-vs-theoretical" QC a survey crew delivers - small sub-metre to
// few-metre skids are normal; large systematic offsets betray a numbering or datum
// mismatch worth flagging.
//
// PURE: no DOM / Node / Electron, no I/O. Bounds every loop (the category arrays
// are already capped by the parser), never throws on bad input, never emits NaN.
// Map keys (not plain-object keys) so the dynamic station keys can't pollute
// Object.prototype. The renderer/worker (Phase 2) feed it two parsed SPSData - the
// current survey as "as-laid" and a separately-loaded "reference" pre-plot - WITHOUT
// merging them (a merge would collapse the very pairs we want to diff).

import type { SPSData, SPSPoint } from './parse';

/** One matched station's plan-to-actual offset. dE/dN = asLaid - reference. */
export interface StationDelta {
  rtype: 'S' | 'R';
  lineName: string;
  point: number;
  /** asLaid.easting - reference.easting (metres). */
  dE: number;
  /** asLaid.northing - reference.northing (metres). */
  dN: number;
  /** hypot(dE, dN) - the plan-to-actual skid distance (metres). */
  dist: number;
  /** dist > tolM. */
  overTol: boolean;
}

/** Per-category (sources OR receivers) summary of the as-laid-vs-reference diff. */
export interface DeltaCategory {
  /** stations present in BOTH sets (matched by the active matchKey). */
  matched: number;
  /** of the matched stations, how many skidded more than tolM. */
  overTol: number;
  /** max / mean / 95th-percentile skid distance over the matched stations
   *  (finite-guarded; 0 when nothing matched). */
  maxDist: number;
  meanDist: number;
  p95Dist: number;
  /** stations in the as-laid set with no partner in the reference set. */
  addedInAsLaid: number;
  /** stations in the reference set with no partner in the as-laid set. */
  missingFromAsLaid: number;
  /** the over-tolerance stations, worst first, capped at {@link MAX_OFFENDERS}. */
  offenders: StationDelta[];
}

export interface SPSDeltaResult {
  /** tolerance (metres) used for the overTol flag. */
  tolM: number;
  sources: DeltaCategory;
  receivers: DeltaCategory;
  /** which identity the stations were matched on (see the robustness fallback). */
  matchKey: 'line+point' | 'point';
  /** set when the comparison is degenerate (empty input, or a numbering mismatch
   *  that even the point-only fallback couldn't resolve). */
  note?: string;
}

/** Cap the offenders list so a survey with many busts can't return an unbounded
 *  payload - the worst (largest-skid) stations are the ones a crew chief reads. */
export const MAX_OFFENDERS = 200;

/** Below this matched fraction (of the smaller survey), `line+point` matching is
 *  deemed to have "almost no matches" → trigger the point-only fallback. */
const LOW_MATCH_RATE = 0.05;

/** Round to 3 dp for display (sub-metre skids matter); non-finite collapses to 0
 *  so no NaN escapes into a result that later reaches a canvas / table. */
function r3(v: number): number {
  return isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

/**
 * Diff one category (sources↔sources OR receivers↔receivers): match each as-laid
 * station to its reference partner via `keyFn`, then compute the per-station skid.
 *
 * `keyFn` derives the match identity (line+point, or point alone in the fallback).
 * A Map keyed on that string sidesteps prototype pollution on the dynamic key - a
 * forged `__proto__`/`constructor` station key is just another Map entry, it can't
 * reach Object.prototype (mirrors the grid in geomcheck.ts). Reference duplicates
 * (same key) keep the first occurrence; matched pairs whose coordinates are
 * non-finite are counted as identity-matched but excluded from the distance stats
 * so no NaN propagates.
 */
function matchCategory(
  asLaidPts: SPSPoint[],
  refPts: SPSPoint[],
  keyFn: (p: SPSPoint) => string,
  tolM: number,
  rtype: 'S' | 'R',
): DeltaCategory {
  const refMap = new Map<string, SPSPoint>();
  for (const p of refPts) {
    const k = keyFn(p);
    if (!refMap.has(k)) refMap.set(k, p);
  }

  // Collapse re-occupied / duplicate as-laid stations sharing a match key to ONE
  // entry per key, keeping the WORST offset - so a re-shot station (or, under the
  // point-only fallback, two stations colliding on a point number) isn't counted
  // or listed twice. Each unique station then contributes once to matched /
  // over-tol / offenders.
  const bestByKey = new Map<string, { p: SPSPoint; dE: number; dN: number; dist: number }>();
  const addedKeys = new Set<string>();
  for (const p of asLaidPts) {
    const k = keyFn(p);
    const ref = refMap.get(k);
    if (!ref) { addedKeys.add(k); continue; }
    const dE = p.easting - ref.easting;
    const dN = p.northing - ref.northing;
    const dist = Math.hypot(dE, dN);
    const prev = bestByKey.get(k);
    // Keep the largest finite offset; prefer a measurable entry over a NaN one.
    if (!prev || (isFinite(dist) && !(isFinite(prev.dist) && prev.dist >= dist))) {
      bestByKey.set(k, { p, dE, dN, dist });
    }
  }

  const seenRefKeys = new Set<string>(bestByKey.keys());
  const dists: number[] = [];
  const offenders: StationDelta[] = [];
  let overTol = 0;
  for (const b of bestByKey.values()) {
    if (!isFinite(b.dist)) continue; // identity-matched but un-measurable → no stat
    dists.push(b.dist);
    if (b.dist > tolM) {
      overTol++;
      offenders.push({ rtype, lineName: (b.p.lineName || '').trim(), point: b.p.point, dE: r3(b.dE), dN: r3(b.dN), dist: r3(b.dist), overTol: true });
    }
  }
  const matched = bestByKey.size;
  const addedInAsLaid = addedKeys.size;

  // Distance stats over the matched-and-finite pairs (loop-based max/mean so a
  // huge category can't overflow the call stack via a spread).
  let maxDist = 0, sum = 0;
  for (const d of dists) { if (d > maxDist) maxDist = d; sum += d; }
  const meanDist = dists.length ? sum / dists.length : 0;
  let p95Dist = 0;
  if (dists.length) {
    const sorted = dists.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
    p95Dist = sorted[idx];
  }

  offenders.sort((a, b) => b.dist - a.dist);

  return {
    matched,
    overTol,
    maxDist: r3(maxDist),
    meanDist: r3(meanDist),
    p95Dist: r3(p95Dist),
    addedInAsLaid,
    missingFromAsLaid: refMap.size - seenRefKeys.size,
    offenders: offenders.slice(0, MAX_OFFENDERS),
  };
}

/** A clean, zeroed category - the honest result when there's nothing to diff. */
function emptyCategory(): DeltaCategory {
  return { matched: 0, overTol: 0, maxDist: 0, meanDist: 0, p95Dist: 0, addedInAsLaid: 0, missingFromAsLaid: 0, offenders: [] };
}

/**
 * Compare an AS-LAID SPS against a REFERENCE (pre-plot / planned) SPS, station by
 * station, within each category (sources, receivers). For every matched station:
 * `dE = asLaid.E - ref.E`, `dN = asLaid.N - ref.N`, `dist = hypot(dE, dN)`, flagged
 * `overTol` when `dist > tolM`. Reports per-category matched / over-tol counts, the
 * max / mean / p95 skid distance, the added (as-laid-only) and missing (reference-
 * only) station counts, and the worst offenders.
 *
 * Matching identity: primarily `(lineName, point)`. ROBUSTNESS - if that yields
 * almost no matches while both surveys are non-empty, the two SPS likely use
 * different LINE numbering, so the match is retried by `point` number alone within
 * each category; if THAT still barely matches, the line+point result is returned
 * with a `note` (rather than forcing bad matches). Default `tolM = 1` m - RTK
 * as-laid skids are usually sub-metre to a few metres; tolM only sets the overTol
 * flag, the full distance distribution is reported regardless.
 *
 * Pure, bounded, never throws; empty/garbage input → a clean zeroed result + note.
 */
export function compareSPS(asLaid: SPSData, reference: SPSData, opts?: { tolM?: number }): SPSDeltaResult {
  const tolM = isFinite(opts?.tolM as number) && (opts?.tolM as number) > 0 ? (opts!.tolM as number) : 1;

  const aS = asLaid && Array.isArray(asLaid.sources) ? asLaid.sources : [];
  const aR = asLaid && Array.isArray(asLaid.receivers) ? asLaid.receivers : [];
  const rS = reference && Array.isArray(reference.sources) ? reference.sources : [];
  const rR = reference && Array.isArray(reference.receivers) ? reference.receivers : [];

  const totalA = aS.length + aR.length;
  const totalR = rS.length + rR.length;

  // Both sides must carry stations or there's nothing to diff.
  if (totalA === 0 || totalR === 0) {
    const which = totalA === 0 && totalR === 0 ? 'Both the as-laid and reference SPS carry'
      : totalA === 0 ? 'The as-laid SPS carries' : 'The reference SPS carries';
    return { tolM, sources: emptyCategory(), receivers: emptyCategory(), matchKey: 'line+point', note: `Nothing to compare: ${which} no stations.` };
  }

  const lpKey = (p: SPSPoint): string => `${(p.lineName || '').trim()} ${p.point}`;
  const ptKey = (p: SPSPoint): string => `${p.point}`;

  let matchKey: 'line+point' | 'point' = 'line+point';
  let sources = matchCategory(aS, rS, lpKey, tolM, 'S');
  let receivers = matchCategory(aR, rR, lpKey, tolM, 'R');
  let note: string | undefined;

  // Robustness: when (line, point) matched almost nothing, the two SPS probably
  // number their lines differently - retry by point number alone.
  const minTotal = Math.min(totalA, totalR);
  const lpMatched = sources.matched + receivers.matched;
  const lpRate = minTotal > 0 ? lpMatched / minTotal : 0;
  if (lpRate < LOW_MATCH_RATE) {
    const sP = matchCategory(aS, rS, ptKey, tolM, 'S');
    const rP = matchCategory(aR, rR, ptKey, tolM, 'R');
    const pMatched = sP.matched + rP.matched;
    const pRate = minTotal > 0 ? pMatched / minTotal : 0;
    if (pMatched > lpMatched && pRate >= LOW_MATCH_RATE) {
      sources = sP; receivers = rP; matchKey = 'point';
      note = 'Stations did not match on (line, point) - the two SPS use different line numbering; matched by point number alone within each category.';
    } else {
      // Point-only didn't help either → don't force bad matches; keep the
      // canonical line+point result and explain the numbering mismatch.
      note = 'Few stations matched on (line, point), and matching by point number alone did not help - the as-laid and reference SPS do not appear to share station numbering (possibly different surveys/lines, or a datum / coordinate-system mismatch).';
    }
  }

  return { tolM, sources, receivers, matchKey, note };
}
