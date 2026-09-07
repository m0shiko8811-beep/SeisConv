// seisconv-core - axis tick arithmetic
//
// `niceStep` is moved here from `renderer/src/app.ts:6919` UNCHANGED. It is
// used at five sites, not one: drawSpectrum `:2720`, drawSurveyGrid `:6965` and
// `:6972`, drawScaleBar `:7134`, drawHeatAxesXY `:12608`.
//
// The tick GENERATOR below returns numbers and draws nothing, so it is safe in
// core. The two loop shapes in the tree are NOT the same and are not unified
// here: `:2722` and `:12610` test `v <= hi + 1e-6`, while `:6966` and `:6973`
// test `v <= hi` with no epsilon. The epsilon is therefore a parameter, so a
// call site can switch without moving a single label.
//
// Pure TS. No DOM, no Electron.

/** A "nice" axis step (1, 2, 5 or 10 times a power of ten) for `range` split
 *  into roughly `target` intervals.
 *
 *  Verbatim from `app.ts:6919-6925`, including the global `isFinite` (which
 *  coerces, unlike Number.isFinite) and the `Math.max(1, target)` floor. Do not
 *  tidy either: the five call sites depend on this exact output. */
export function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  if (!isFinite(raw) || raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

/** First tick at or above `lo` for a given step: `Math.ceil(lo / step) * step`.
 *  `app.ts:2721`, `:6966`, `:6973`, `:12609`. */
export function firstTick(lo: number, step: number): number {
  return Math.ceil(lo / step) * step;
}

/** The tick VALUES an axis loop would visit over [lo,hi].
 *
 *  Accumulates (`v += step`) rather than computing `start + i * step`, because
 *  the tree accumulates and floating-point drift between the two forms can flip
 *  a `toFixed(0)` label. `eps` is the slack added to the upper bound: 1e-6 for
 *  drawSpectrum / drawHeatAxesXY, 0 for the survey grid.
 *
 *  Bounded by `maxTicks` so a pathological step cannot spin forever; the draw
 *  loops are implicitly bounded by the canvas, this generator is not. */
export function tickValues(lo: number, hi: number, step: number, eps = 0, maxTicks = 4096): number[] {
  const out: number[] = [];
  if (!isFinite(lo) || !isFinite(hi) || !isFinite(step) || step <= 0) return out;
  for (let v = firstTick(lo, step); v <= hi + eps; v += step) {
    out.push(v);
    if (out.length >= maxTicks) break;
  }
  return out;
}

/** Convenience: niceStep + tickValues in one call, for an axis wanting roughly
 *  `target` intervals over [lo,hi]. */
export function axisTicks(lo: number, hi: number, target: number, eps = 0): number[] {
  return tickValues(lo, hi, niceStep(hi - lo, target), eps);
}

/** The `span || 1` fallback used before a tick loop at `app.ts:2707`, `:12607`
 *  and `:12620`. A zero span becomes 1; a negative span is preserved. */
export function spanOrOne(lo: number, hi: number): number {
  return (hi - lo) || 1;
}

/** Evenly spaced division fractions, the `for (g = 0; g <= n; g++) g / n` form
 *  used for the amplitude gridlines at `app.ts:2729` (four divisions) and the
 *  time labels at `:3564` (five) and `:11960` (quarters). Returns n+1 values. */
export function divisionFractions(n: number): number[] {
  const out: number[] = [];
  if (!Number.isInteger(n) || n < 1) return out;
  for (let g = 0; g <= n; g++) out.push(g / n);
  return out;
}
