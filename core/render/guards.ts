// seisconv-core - numeric guards for anything that reaches a canvas
//
// CLAUDE.md rule: no NaN may reach a canvas. Today those checks are retyped at
// every draw site (`renderer/src/app.ts:2704`, `:2711`, `:5651`, `:11934`,
// `:12540`, `:12961`), so a site that forgets one is invisible until a plot goes
// blank. These are the exact shapes used there, extracted verbatim so a call
// site can switch without changing a single pixel.
//
// Pure TS. No DOM, no Electron - this module runs in Node, the worker and the
// browser alike.

/** True for a real, finite number. Matches the `typeof x === 'number' &&
 *  Number.isFinite(x)` pair used at `app.ts:2704` (drawSpectrum fMin/fMax),
 *  `:2713` (aMin/aMax) and `:12540` (heatAxisWindow manual edges). */
export function isFiniteNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** `x` when it is a finite number, otherwise `dflt`. The default is returned
 *  untouched, so `finiteOr(NaN, NaN)` is still NaN - this guards, it does not
 *  invent a value. */
export function finiteOr(x: unknown, dflt: number): number {
  return isFiniteNum(x) ? x : dflt;
}

/** A window is usable only when hi is STRICTLY greater than lo. Written as
 *  `hi > lo` rather than `!(lo >= hi)` so a NaN on either edge is rejected,
 *  which is the sense of the `if (!(fHi > fLo))` fallbacks at `app.ts:2706`,
 *  `:12541` and `:12547`. */
export function validRange(lo: number, hi: number): boolean {
  return hi > lo;
}

/** The plot-rect precondition. `app.ts:12730` (specPlotFrac) bails on
 *  `pw <= 0 || ph <= 0`; `:5648` and `:5000` use their own thresholds, so the
 *  threshold is a parameter rather than baked in. */
export function plotUsable(w: number, h: number, min = 0): boolean {
  return Number.isFinite(w) && Number.isFinite(h) && w > min && h > min;
}

/** Clamp to [lo,hi], mapping a non-finite input to `lo`. This is the
 *  `const cl = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))`
 *  helper at `app.ts:11934`, generalised over the bounds. */
export function clampFinite(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
}

/** `Math.max(-1, Math.min(1, v))` - the amplitude clamp at `app.ts:3471`.
 *  A NaN input passes through as NaN, exactly as the inline form does, because
 *  the colour maps carry their own finite check and changing that here would
 *  change pixels. */
export function clampUnit(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

/** `Math.max(0, Math.min(1, v))` - the magnitude clamp at `app.ts:11914`,
 *  `:12422` and `:12483`. NaN passes through, same reason as clampUnit. */
export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
