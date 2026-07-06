// seisconv-core / sps - Geometry Integrity Suite (Phase 1).
//
// Cross-check a SEG-Y's trace-header geometry against an SPS survey design and
// surface the high-value busts BEFORE the data reaches the processing shop:
//   - coverage   - do the headers carry source / receiver coordinates at all?
//   - scalar     - is the SEG-Y coordinate scalar (bytes 71-72) consistent?
//   - source     - does each shot's (srcX,srcY) land on its SPS source station?
//   - receiver   - does each trace's (rcvX,rcvY) land on an SPS receiver station?
//
// PURE: no DOM / Node / Electron, no I/O. Bounds every loop, never throws on bad
// input, never emits NaN. The renderer/worker (Phase 2) feed it a TraceGeom[]
// distilled from each parsed TraceHeader plus a merged SPSData.

import type { SPSData, SPSPoint } from './parse';

/** The minimal geometry distilled from one SEG-Y TraceHeader. Raw header values
 *  (srcX/srcY/rcvX/rcvY are pre-scalar); {@link applyScalar} turns them real. */
export interface TraceGeom {
  ffid: number;
  channel: number;
  srcPt: number;
  ensemble: number;
  srcX: number;
  srcY: number;
  rcvX: number;
  rcvY: number;
  coordScalar: number;
}

export interface GeomFinding {
  sev: 'error' | 'warn' | 'info';
  cat: string;
  msg: string;
  count: number;
  sample?: Array<{ ffid?: number; channel?: number; point?: number; dx?: number; dy?: number; dist?: number }>;
}

export interface GeomCheckResult {
  traceCount: number;
  srcCoveragePct: number;
  rcvCoveragePct: number;
  scalarValues: number[];
  matchedSrcPts: number;
  matchedRcv: number;
  /**
   * Stack state of the data, used as a SAFETY NET for the source/receiver match.
   *   'prestack'  - shot gathers / vertical composites: source ≠ receiver per
   *                 trace, so the SPS source/receiver checks are meaningful.
   *   'poststack' - CMP / horizontally-stacked: traces collapse to CDP midpoints
   *                 (source ≈ receiver), so the per-trace match no longer applies;
   *                 a StackState warning is prepended and the match may false-flag.
   *   'unknown'   - no trace-sorting code and no geometry to judge from.
   */
  dataType: 'prestack' | 'poststack' | 'unknown';
  findings: GeomFinding[];
}

/**
 * Apply the SEG-Y coordinate scalar (trace-header bytes 71-72) to a raw coordinate:
 *   scalar < 0 → raw / |scalar|   (the common "store integers, divide" convention)
 *   scalar > 0 → raw * scalar
 *   scalar == 0 → raw             (0 is treated as a scalar of 1, per the spec)
 * Finite-guarded: a non-finite raw stays NaN; a non-finite/zero scalar is a no-op.
 */
export function applyScalar(raw: number, scalar: number): number {
  if (!isFinite(raw)) return NaN;
  if (!isFinite(scalar) || scalar === 0) return raw;
  return scalar < 0 ? raw / Math.abs(scalar) : raw * scalar;
}

/** Euclidean distance, NaN when either coordinate is non-finite. */
function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Round to 2 dp for display; non-finite collapses to 0 so no NaN escapes. */
function r2(v: number): number {
  return isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

/** A (scalar-applied) coordinate counts as "carried" when finite and not the
 *  origin (0,0) - an all-zero coordinate means the field was never populated. */
function hasGeom(x: number, y: number): boolean {
  return isFinite(x) && isFinite(y) && (x !== 0 || y !== 0);
}

/** Bin SPS points into a square grid (cell size `cell`) keyed by `gx|gy`, storing
 *  point indices. A Map (not a plain object) sidesteps prototype-pollution on the
 *  numeric-derived keys. With cell == tol, any point within `tol` of a query lands
 *  in the query's own cell or an 8-neighbour, so a 3×3 scan finds every candidate. */
export function buildGrid(pts: SPSPoint[], cell: number): Map<string, number[]> {
  const grid = new Map<string, number[]>();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!isFinite(p.easting) || !isFinite(p.northing)) continue;
    const k = `${Math.floor(p.easting / cell)}|${Math.floor(p.northing / cell)}`;
    const arr = grid.get(k);
    if (arr) arr.push(i);
    else grid.set(k, [i]);
  }
  return grid;
}

/** Nearest grid point to (x,y): scans the query cell + its 8 neighbours. Returns
 *  the point index and distance (idx -1 / d Infinity when nothing is near). */
export function nearestInGrid(grid: Map<string, number[]>, pts: SPSPoint[], x: number, y: number, cell: number): { idx: number; d: number } {
  if (!isFinite(x) || !isFinite(y)) return { idx: -1, d: Infinity };
  const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
  let bestI = -1, bestD = Infinity;
  for (let cx = gx - 1; cx <= gx + 1; cx++) {
    for (let cy = gy - 1; cy <= gy + 1; cy++) {
      const arr = grid.get(`${cx}|${cy}`);
      if (!arr) continue;
      for (const ri of arr) {
        const d = dist(x, y, pts[ri].easting, pts[ri].northing);
        if (d < bestD) { bestD = d; bestI = ri; }
      }
    }
  }
  return { idx: bestI, d: bestD };
}

const MAX_SAMPLE_FINDINGS = 6; // cap per-finding sample arrays (keep results small)

// Post-stack safety-net thresholds (coordinate-collapse heuristic).
// A trace whose (scalar-applied) source lands within COLLAPSE_EPS_M metres of its
// receiver has collapsed to a CDP midpoint; when ≥ COLLAPSE_FRAC_MIN of the
// geometry-bearing traces do so, the data reads as CMP/horizontally-stacked.
const COLLAPSE_EPS_M = 1; // metres: source effectively coincident with receiver
const COLLAPSE_FRAC_MIN = 0.9; // ≥ 90% collapsed → post-stack/midpoint

/**
 * Check whether `traces` (SEG-Y header geometry) agree with the `sps` survey
 * design. v1 checks: coverage, scalar consistency, source-position match (incl.
 * X/Y-swap detection), receiver-position match (nearest SPS station within tol)
 * and missing-station detection. Default tolerance 2 m. Pure, bounded, never throws.
 *
 * `opts.maxSampleTraces` (default 20000) caps the per-trace receiver scan: when a
 * SEG-Y has more traces, they are sampled at an even stride so the cost stays
 * bounded on huge gathers. The source scan is naturally bounded (one entry per
 * distinct FFID), so it is never sub-sampled.
 *
 * Phase-2 enrichment (noted, not done here): expand the SPS X-file
 * channel→station relation (ffid + channel range → receiver line/point) to do an
 * EXACT per-channel receiver check instead of the robust nearest-within-tol match.
 *
 * SAFETY NET (`dataType`): the source/receiver match is only meaningful for
 * PRE-STACK data (shot gathers / vertical composites - source ≠ receiver per
 * trace). For CMP/horizontally-stacked (post-stack) data the traces collapse to
 * CDP midpoints (source ≈ receiver) and the match is meaningless. We detect that
 * from two OR'd signals - the SEG-Y binary-header trace-sorting code
 * (`opts.traceSorting` ∈ {4,8,9}) and a coordinate-collapse heuristic (≥ 90% of
 * geometry-bearing traces have source coincident with receiver) - and, when it
 * fires, PREPEND a clear `StackState` warning instead of silently false-flagging
 * good post-stack data. Pre-stack data is labelled 'prestack' with no new finding.
 */
export function checkGeometry(
  traces: TraceGeom[],
  sps: SPSData,
  opts?: { tolM?: number; maxSampleTraces?: number; traceSorting?: number },
): GeomCheckResult {
  const tol = isFinite(opts?.tolM as number) && (opts?.tolM as number) > 0 ? (opts!.tolM as number) : 2;
  const maxSample =
    isFinite(opts?.maxSampleTraces as number) && (opts?.maxSampleTraces as number) > 0
      ? Math.floor(opts!.maxSampleTraces as number)
      : 20000;
  // Trace-sorting code from the SEG-Y binary header (0 = missing/unknown).
  const traceSorting = isFinite(opts?.traceSorting as number) ? Math.trunc(opts!.traceSorting as number) : 0;

  const tr: TraceGeom[] = Array.isArray(traces) ? traces : [];
  const sources: SPSPoint[] = sps && Array.isArray(sps.sources) ? sps.sources : [];
  const receivers: SPSPoint[] = sps && Array.isArray(sps.receivers) ? sps.receivers : [];

  const findings: GeomFinding[] = [];
  const result: GeomCheckResult = {
    traceCount: tr.length,
    srcCoveragePct: 0,
    rcvCoveragePct: 0,
    scalarValues: [],
    matchedSrcPts: 0,
    matchedRcv: 0,
    dataType: 'unknown',
    findings,
  };

  // Empty SPS or no traces → a clean, honest result rather than a throw.
  if (!sources.length && !receivers.length) {
    findings.push({ sev: 'info', cat: 'SPS', msg: 'SPS survey carries no source or receiver stations to check against', count: 0 });
  }
  // Post-stack signal #1: the binary-header trace-sorting code (4/8/9). Computed
  // here so a no-traces file with a sorting code is still labelled honestly.
  const sortingPost = traceSorting === 4 || traceSorting === 8 || traceSorting === 9;
  const sortingPre = traceSorting !== 0 && !sortingPost; // any other known nonzero code

  if (!tr.length) {
    findings.push({ sev: 'info', cat: 'Coverage', msg: 'no traces supplied', count: 0 });
    result.dataType = sortingPost ? 'poststack' : sortingPre ? 'prestack' : 'unknown';
    return result;
  }

  // -- Pass 1: coverage + scalar inventory + coordinate-collapse stat (one walk) --
  // The collapse stat feeds the post-stack safety net: a (scalar-applied) trace
  // whose source coincides with its receiver (within COLLAPSE_EPS_M metres) has
  // collapsed to a CDP midpoint - the hallmark of CMP/horizontally-stacked data.
  let srcCov = 0, rcvCov = 0;
  let geomBoth = 0, collapsed = 0; // traces carrying BOTH src+rcv geom; of those, # collapsed
  const scalarSet = new Set<number>();
  for (let i = 0; i < tr.length; i++) {
    const t = tr[i];
    const sc = t.coordScalar;
    if (isFinite(sc)) scalarSet.add(sc);
    const sx = applyScalar(t.srcX, sc), sy = applyScalar(t.srcY, sc);
    const rx = applyScalar(t.rcvX, sc), ry = applyScalar(t.rcvY, sc);
    const sG = hasGeom(sx, sy), rG = hasGeom(rx, ry);
    if (sG) srcCov++;
    if (rG) rcvCov++;
    if (sG && rG) {
      geomBoth++;
      if (Math.abs(sx - rx) <= COLLAPSE_EPS_M && Math.abs(sy - ry) <= COLLAPSE_EPS_M) collapsed++;
    }
  }
  result.srcCoveragePct = r2((srcCov / tr.length) * 100);
  result.rcvCoveragePct = r2((rcvCov / tr.length) * 100);
  result.scalarValues = Array.from(scalarSet).sort((a, b) => a - b);

  // -- Post-stack safety net: combine the two OR'd signals into a dataType label --
  const collapseFrac = geomBoth > 0 ? collapsed / geomBoth : 0;
  const collapsePost = geomBoth > 0 && collapseFrac >= COLLAPSE_FRAC_MIN;
  const collapsePre = geomBoth > 0 && !collapsePost; // per-trace source ≠ receiver
  result.dataType = sortingPost || collapsePost ? 'poststack' : sortingPre || collapsePre ? 'prestack' : 'unknown';

  // -- Check 2: scalar consistency --
  const nonzeroScalars = result.scalarValues.filter((v) => v !== 0);
  if (nonzeroScalars.length > 1) {
    findings.push({
      sev: 'warn',
      cat: 'Scalar',
      msg: `mixed coordinate scalars across traces (${nonzeroScalars.join(', ')}) - one SEG-Y should use a single scalar`,
      count: nonzeroScalars.length,
    });
  }

  // -- Check 1: coverage findings (≈0 → records not yet merged with SPS) --
  const srcHasGeom = result.srcCoveragePct >= 1;
  const rcvHasGeom = result.rcvCoveragePct >= 1;
  if (!srcHasGeom) {
    findings.push({
      sev: 'info',
      cat: 'Coverage',
      msg: 'trace headers carry no source geometry (records not yet merged with SPS)',
      count: srcCov,
    });
  }
  if (!rcvHasGeom) {
    findings.push({
      sev: 'info',
      cat: 'Coverage',
      msg: 'trace headers carry no receiver geometry (records not yet merged with SPS)',
      count: rcvCov,
    });
  }

  // -- Check 3: source match (only when the headers carry source geometry) --
  // Primary: match each shot's (srcX,srcY) against the SPS source carrying the
  // header's source-POINT number - this catches numbering busts where a named
  // point sits at the wrong place. Fallback: when that point number isn't in the
  // SPS numbering at all (common - field SEG-Y often leaves byte-17 source-point
  // 0/sequential and encodes the true shot→station link only in the X-file, a
  // Phase-2 enrichment), match by POSITION (nearest SPS source within tol). A
  // position match with a non-SPS point number is reported as INFO, not an error:
  // the geometry is correct, only the header numbering needs the X-file relation.
  if (srcHasGeom && sources.length) {
    const cell = Math.max(tol, 1e-6);
    const srcGrid = buildGrid(sources, cell);
    // Index SPS sources by point number → candidate indices (a point number may
    // recur across lines in a multi-line survey; we test against the nearest).
    const srcByPoint = new Map<number, number[]>();
    for (let i = 0; i < sources.length; i++) {
      const p = sources[i].point;
      if (!isFinite(p)) continue;
      const arr = srcByPoint.get(p);
      if (arr) arr.push(i);
      else srcByPoint.set(p, [i]);
    }

    // One representative shot coordinate per FFID (all traces of a shot share the
    // same source point + position; first geometry-bearing trace wins).
    const shotByFfid = new Map<number, { srcPt: number; sx: number; sy: number }>();
    for (let i = 0; i < tr.length; i++) {
      const t = tr[i];
      if (shotByFfid.has(t.ffid)) continue;
      const sx = applyScalar(t.srcX, t.coordScalar);
      const sy = applyScalar(t.srcY, t.coordScalar);
      if (!hasGeom(sx, sy)) continue;
      shotByFfid.set(t.ffid, { srcPt: t.srcPt, sx, sy });
    }

    const matchedIdx = new Set<number>(); // distinct SPS source stations matched
    let offCount = 0, swapCount = 0, byPosition = 0;
    const offSample: GeomFinding['sample'] = [];
    const swapSample: GeomFinding['sample'] = [];
    const numberingSample: GeomFinding['sample'] = [];

    for (const [ffid, shot] of shotByFfid) {
      const cands = srcByPoint.get(shot.srcPt);
      if (cands && cands.length) {
        // Numbered: evaluate against the named station(s), normal + X/Y-swapped.
        let bestNorm = Infinity, bestSwap = Infinity, bestIdx = -1, bestDx = 0, bestDy = 0;
        for (const ci of cands) {
          const s = sources[ci];
          const dN = dist(shot.sx, shot.sy, s.easting, s.northing);
          if (dN < bestNorm) { bestNorm = dN; bestIdx = ci; bestDx = shot.sx - s.easting; bestDy = shot.sy - s.northing; }
          const dS = dist(shot.sx, shot.sy, s.northing, s.easting); // E/N swapped
          if (dS < bestSwap) bestSwap = dS;
        }
        if (isFinite(bestNorm) && bestNorm <= tol) {
          matchedIdx.add(bestIdx);
        } else if (isFinite(bestSwap) && bestSwap <= tol) {
          swapCount++;
          if (swapSample.length < MAX_SAMPLE_FINDINGS) swapSample.push({ ffid, point: shot.srcPt, dist: r2(bestNorm) });
        } else {
          offCount++;
          if (offSample.length < MAX_SAMPLE_FINDINGS) offSample.push({ ffid, point: shot.srcPt, dx: r2(bestDx), dy: r2(bestDy), dist: r2(bestNorm) });
        }
        continue;
      }
      // Not in the SPS numbering → position fallback (nearest SPS source).
      const near = nearestInGrid(srcGrid, sources, shot.sx, shot.sy, cell);
      if (near.idx >= 0 && near.d <= tol) {
        matchedIdx.add(near.idx);
        byPosition++;
        if (numberingSample.length < MAX_SAMPLE_FINDINGS) numberingSample.push({ ffid, point: shot.srcPt, dist: r2(near.d) });
      } else {
        const swap = nearestInGrid(srcGrid, sources, shot.sy, shot.sx, cell); // swapped query
        if (swap.idx >= 0 && swap.d <= tol) {
          swapCount++;
          if (swapSample.length < MAX_SAMPLE_FINDINGS) swapSample.push({ ffid, point: shot.srcPt, dist: isFinite(near.d) ? r2(near.d) : undefined });
        } else {
          offCount++;
          if (offSample.length < MAX_SAMPLE_FINDINGS) offSample.push({ ffid, point: shot.srcPt, dist: isFinite(near.d) ? r2(near.d) : undefined });
        }
      }
    }
    result.matchedSrcPts = matchedIdx.size;

    if (swapCount > 0) {
      findings.push({
        sev: 'error',
        cat: 'SourceSwap',
        msg: `source X/Y appear swapped: ${swapCount} shot(s) match SPS only when easting/northing are exchanged`,
        count: swapCount,
        sample: swapSample,
      });
    }
    if (offCount > 0) {
      const ex = offSample[0];
      findings.push({
        sev: 'error',
        cat: 'SourcePos',
        msg: `${offCount} shot source position(s) disagree with SPS by > ${tol} m` + (ex && ex.dist != null ? ` (e.g. FFID ${ex.ffid}: ${ex.dist} m)` : ''),
        count: offCount,
        sample: offSample,
      });
    }
    if (byPosition > 0) {
      findings.push({
        sev: 'info',
        cat: 'SourceNumbering',
        msg: `${byPosition} shot(s) match an SPS source by POSITION but the header source-point number isn't in the SPS numbering (the shot→station link lives in the X-file relation)`,
        count: byPosition,
        sample: numberingSample,
      });
    }
  }

  // -- Check 4: receiver-position match via a spatial grid (cell ≈ tol) --
  // Robust nearest-within-tol match (Phase-2 enrichment: expand the X-file
  // channel→station relation for an EXACT per-channel receiver check instead).
  if (rcvHasGeom && receivers.length) {
    const cell = Math.max(tol, 1e-6);
    const grid = buildGrid(receivers, cell);

    // Sample the traces at an even stride when there are more than maxSample.
    const stride = tr.length > maxSample ? Math.ceil(tr.length / maxSample) : 1;
    const matchedRcv = new Set<number>();
    let scanned = 0, noMatch = 0;
    const noMatchSample: GeomFinding['sample'] = [];

    for (let i = 0; i < tr.length; i += stride) {
      const t = tr[i];
      const rx = applyScalar(t.rcvX, t.coordScalar);
      const ry = applyScalar(t.rcvY, t.coordScalar);
      if (!hasGeom(rx, ry)) continue;
      scanned++;
      const near = nearestInGrid(grid, receivers, rx, ry, cell);
      if (near.idx >= 0 && near.d <= tol) {
        matchedRcv.add(near.idx);
      } else {
        noMatch++;
        if (noMatchSample.length < MAX_SAMPLE_FINDINGS) {
          noMatchSample.push({ ffid: t.ffid, channel: t.channel, dist: isFinite(near.d) ? r2(near.d) : undefined });
        }
      }
    }
    result.matchedRcv = matchedRcv.size;

    if (noMatch > 0) {
      findings.push({
        sev: 'error',
        cat: 'ReceiverPos',
        msg: `${noMatch} of ${scanned} scanned trace(s) have receiver coords with no SPS station within ${tol} m`,
        count: noMatch,
        sample: noMatchSample,
      });
    }
    // Missing-station: SPS receivers no scanned trace landed on. Exact when every
    // trace was scanned (stride 1); approximate (an upper bound) under sampling.
    const missing = receivers.length - matchedRcv.size;
    if (missing > 0) {
      const missSample: GeomFinding['sample'] = [];
      for (let i = 0; i < receivers.length && missSample.length < MAX_SAMPLE_FINDINGS; i++) {
        if (!matchedRcv.has(i)) {
          const r = receivers[i];
          missSample.push({ point: isFinite(r.point) ? r.point : undefined });
        }
      }
      findings.push({
        sev: 'warn',
        cat: 'MissingStation',
        msg:
          `${missing} SPS receiver station(s) matched by zero traces` +
          (stride > 1 ? ` (traces sampled 1-in-${stride}; upper bound)` : ''),
        count: missing,
        sample: missSample,
      });
    }
  }

  // -- Post-stack safety net: PREPEND a StackState warning when the data reads as
  // CMP/horizontally-stacked, so the user sees it BEFORE any (now-suspect)
  // source/receiver findings. Pre-stack / unknown data emits nothing here. --
  if (result.dataType === 'poststack') {
    const reasons: string[] = [];
    if (sortingPost) {
      const label = traceSorting === 4 ? 'horizontally/CMP-stacked' : traceSorting === 8 ? 'CMP' : 'common-conversion-point';
      reasons.push(`SEG-Y trace-sorting code ${traceSorting} = ${label}`);
    }
    if (collapsePost) {
      reasons.push(`${r2(collapseFrac * 100)}% of geometry-bearing traces have source coincident with receiver`);
    }
    findings.unshift({
      sev: 'warn',
      cat: 'StackState',
      msg:
        `Data appears post-stack / CMP-stacked (${reasons.join('; ')}) - per-trace source/receiver geometry has ` +
        'collapsed to CDP midpoints, so the source/receiver match may not apply; use a CDP / bin-grid check instead.',
      count: 1,
    });
  }

  return result;
}
