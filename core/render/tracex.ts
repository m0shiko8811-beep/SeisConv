// seisconv-core / render - trace X positions from a header value, both directions.
//
// WHY this lives in core/render: it is layout, and it sits beside ./mapper.ts
// whose header already describes the exact failure mode this module exists to
// prevent (a draw site and a hit-test site retyping the same maths and drifting
// apart). Forward and inverse here read ONE precomputed array, so they cannot
// disagree by construction.
//
// WHY the feature exists: the section currently places trace i at uniform
// spacing by ARRAY INDEX. A spread gap, a dropped station or a channel that
// never made it into the file is then silently closed up and the record looks
// perfect. Positioned by offset (or station, or CDP) the gap is drawn as a real
// gap, which is exactly the geometry error a field engineer is looking for.
//
// Reference: Seismic Unix, src/su/graphics/xplot/suxwigb.c, self-doc:
//
//     key=(keyword)           if set, the values of x2 are set from header field
//                             specified by keyword
//
// i.e. unequally spaced traces are plotted from a header value rather than at
// uniform spacing.
//
// UNITS: the header values are in whatever unit the chosen header carries
// (metres for offset, station numbers for a station key). This module never
// interprets them; it only orders and scales them. Pixels are pixels.
//
// NaN policy (CLAUDE.md: no NaN may reach a canvas): every fraction this module
// produces is finite for every input, including empty, single, all-equal and
// non-finite header arrays. A header array that cannot be trusted degrades to
// the uniform index axis with a stated reason, rather than placing some traces
// and quietly mis-placing others.
//
// Pure TypeScript: no DOM, no Electron.

import { fracToPixel, pixelToFrac } from './mapper';

/** Why the axis fell back to uniform index spacing. `null` on a header axis. */
export type IndexAxisReason =
  | 'no-header'    // no values supplied, or fewer values than traces
  | 'non-finite'   // at least one value was NaN/Infinity/null
  | 'all-zero'     // every value is 0: the header was never populated
  | 'zero-range'   // every value is the same non-zero number
  | 'empty';       // no traces at all

export interface TraceAxis {
  /** 'header' = positioned by the header value; 'index' = uniform fallback. */
  readonly kind: 'header' | 'index';
  /** Set only when kind is 'index', so the UI can explain the fallback. */
  readonly reason: IndexAxisReason | null;
  readonly count: number;
  /** Window in HEADER UNITS that fraction 0 and 1 map to. On an index axis
   *  these are 0 and count-1 (trace numbers), kept finite always. */
  readonly lo: number;
  readonly hi: number;
  /** Fraction across the plot for each trace, in original trace order. THE
   *  single source of truth: forward and inverse both read this array. */
  readonly fracs: Float64Array;
  /** Trace indices sorted by fraction ascending, ties by original index.
   *  Used only by the inverse; never a second copy of the maths. */
  readonly order: Int32Array;
}

function finite(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function buildOrder(fracs: Float64Array): Int32Array {
  const n = fracs.length;
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // Stable on ties (duplicate header values) by falling back to the original
  // index, so hit-testing two traces at the same offset is deterministic.
  const tmp = Array.from(order).sort((a, b) => (fracs[a] - fracs[b]) || (a - b));
  for (let i = 0; i < n; i++) order[i] = tmp[i];
  return order;
}

/** Uniform-by-index axis: what the section does today. Single trace centred. */
function indexAxis(count: number, reason: IndexAxisReason): TraceAxis {
  const n = Math.max(0, count | 0);
  const fracs = new Float64Array(n);
  for (let i = 0; i < n; i++) fracs[i] = n > 1 ? i / (n - 1) : 0.5;
  return {
    kind: 'index', reason, count: n,
    lo: 0, hi: n > 1 ? n - 1 : 0,
    fracs, order: buildOrder(fracs),
  };
}

/**
 * Build the axis for one record.
 *
 * `values` are the per-trace header values (offset, station, CDP...). Pass
 * null/undefined, or a short array, to get the uniform index axis.
 *
 * `window` optionally pins the header-unit range that maps to fractions 0..1,
 * so an X zoom is a rebuild rather than a redesign. Ignored unless hi > lo.
 *
 * Cost: two typed arrays plus one sort per RECORD (O(n log n) over hundreds of
 * traces). Nothing is allocated per draw or per hit-test.
 */
export function buildTraceAxis(
  values: ArrayLike<number | null | undefined> | null | undefined,
  count: number,
  window?: { lo: number; hi: number },
): TraceAxis {
  const n = Math.max(0, count | 0);
  if (n === 0) return indexAxis(0, 'empty');
  if (!values || values.length < n) return indexAxis(n, 'no-header');

  let lo = Infinity, hi = -Infinity, allZero = true;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    // One bad value poisons the whole axis on purpose: placing the good traces
    // and parking the bad ones somewhere would make the picture lie about
    // geometry, which is the only reason the feature exists.
    if (!finite(v)) return indexAxis(n, 'non-finite');
    if (v !== 0) allZero = false;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (allZero) return indexAxis(n, 'all-zero');

  let wLo = lo, wHi = hi;
  if (window && finite(window.lo) && finite(window.hi) && window.hi > window.lo) {
    wLo = window.lo; wHi = window.hi;
  }
  const span = wHi - wLo;

  const fracs = new Float64Array(n);
  if (!(span > 0)) {
    // Zero range. Dividing would be 0/0 = NaN, and stacking every trace on one
    // pixel would hide the record entirely, so several traces at one value fall
    // back to uniform index spacing with the reason stated. A SINGLE trace has
    // no spacing question at all: centre it.
    if (n > 1) return indexAxis(n, 'zero-range');
    fracs[0] = 0.5;
  } else {
    for (let i = 0; i < n; i++) fracs[i] = ((values[i] as number) - wLo) / span;
  }
  return { kind: 'header', reason: null, count: n, lo: wLo, hi: wHi, fracs, order: buildOrder(fracs) };
}

/** Fraction across the plot for trace i. Out-of-range i gives 0.5, never NaN. */
export function traceFrac(axis: TraceAxis, i: number): number {
  return i >= 0 && i < axis.count ? axis.fracs[i] : 0.5;
}

/** FORWARD: trace index -> pixel. The only place drawing may compute an X. */
export function traceX(axis: TraceAxis, i: number, originPx: number, widthPx: number): number {
  return fracToPixel(traceFrac(axis, i), originPx, widthPx);
}

/** Pixel -> header-unit value (the axis label under the cursor). */
export function xToValue(axis: TraceAxis, px: number, originPx: number, widthPx: number): number {
  if (!(widthPx > 0)) return axis.lo;
  return axis.lo + pixelToFrac(px, originPx, widthPx) * (axis.hi - axis.lo);
}

/**
 * INVERSE: pixel -> nearest trace index, or -1 when there is nothing to hit.
 *
 * Binary search over `order`, comparing against the SAME `fracs` the forward
 * direction reads, so `traceX(nearestTraceAtX(traceX(i))) === traceX(i)` holds
 * for every i. Among duplicate values the lowest original index wins.
 */
export function nearestTraceAtX(axis: TraceAxis, px: number, originPx: number, widthPx: number): number {
  const n = axis.count;
  if (n === 0 || !(widthPx > 0) || !finite(px) || !finite(originPx)) return -1;
  const f = pixelToFrac(px, originPx, widthPx);
  if (!finite(f)) return -1;

  const ord = axis.order, fr = axis.fracs;
  let a = 0, b = n;                       // first order-slot with frac >= f
  while (a < b) {
    const m = (a + b) >> 1;
    if (fr[ord[m]] < f) a = m + 1; else b = m;
  }
  if (a === 0) return firstAtSameFrac(axis, 0);
  if (a === n) return firstAtSameFrac(axis, n - 1);
  const dPrev = f - fr[ord[a - 1]], dNext = fr[ord[a]] - f;
  return firstAtSameFrac(axis, dNext < dPrev ? a : a - 1);
}

/** Walk back over ties so duplicates resolve to the lowest original index. */
function firstAtSameFrac(axis: TraceAxis, slot: number): number {
  const ord = axis.order, fr = axis.fracs;
  let s = slot;
  while (s > 0 && fr[ord[s - 1]] === fr[ord[s]]) s--;
  return ord[s];
}

/**
 * LOCAL trace spacing: the fraction of the plot between each trace and its
 * NEAREST DISTINCT neighbour, one entry per trace in original trace order.
 *
 * WHY this exists: the wiggle excursion used to scale off the AVERAGE column
 * width (plot width / trace count). Under header positioning that average is a
 * lie wherever the geometry is irregular - where offsets bunch up the wiggles
 * overlapped into mud, and where the spread opens out they shrank to threads.
 * The display was worst exactly where the geometry was most interesting.
 *
 * WHY the NEAREST neighbour, and not half the gap on each side: the excursion
 * has to be SYMMETRIC. Giving a trace one deflection to the left and a different
 * one to the right would draw a peak and a trough of equal sample value at
 * different widths, so the waveform shape itself would depend on where the
 * neighbours happen to sit. Taking the smaller of the two gaps keeps one width
 * per trace and guarantees that an excursion of 1.0 reaches the nearer
 * neighbour and no further - which is what the control has always promised.
 *
 * WHY DISTINCT: two traces recorded at the same offset are a real case (see the
 * duplicate handling above). Their gap is zero, so a plain nearest-neighbour
 * distance would collapse both of them to a vertical line. Ties are skipped
 * instead, so both traces get the spacing to the next real position and draw on
 * top of each other - which is honest, because they ARE at the same place.
 *
 * Every entry is finite and > 0. With no distinct neighbour anywhere (a single
 * trace) the whole plot is that trace's own, so the gap is 1.
 */
export function traceGaps(axis: TraceAxis): Float64Array {
  const n = axis.count;
  const gaps = new Float64Array(n);
  if (n === 0) return gaps;
  if (n === 1) { gaps[0] = 1; return gaps; }

  const ord = axis.order, fr = axis.fracs;
  // Walk the sorted order in RUNS of equal fraction, so duplicates share one gap.
  let k = 0;
  let prevFrac = NaN;                      // fraction of the previous distinct run
  while (k < n) {
    let e = k + 1;
    while (e < n && fr[ord[e]] === fr[ord[k]]) e++;
    const f = fr[ord[k]];
    const dPrev = Number.isFinite(prevFrac) ? f - prevFrac : NaN;
    const dNext = e < n ? fr[ord[e]] - f : NaN;
    let g: number;
    if (Number.isFinite(dPrev) && Number.isFinite(dNext)) g = Math.min(dPrev, dNext);
    else if (Number.isFinite(dPrev)) g = dPrev;
    else if (Number.isFinite(dNext)) g = dNext;
    else g = 1;                            // only one distinct position in the record
    if (!(g > 0)) g = 1;
    for (let i = k; i < e; i++) gaps[ord[i]] = g;
    prevFrac = f;
    k = e;
  }
  return gaps;
}
