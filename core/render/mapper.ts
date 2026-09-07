// seisconv-core - value <-> pixel mapping, both directions
//
// Drawing maps a data value to a pixel; hit-testing maps a pixel back to a data
// value. In `renderer/src/app.ts` those two halves are written at different
// sites (drawSpectrum `:2717` versus specPlotFrac `:12733`, paintSection versus
// secPlotFrac `:4490`), so nothing forces the inverse to actually invert. That
// is the reason both directions live in one file here.
//
// Pure TS. No DOM, no Electron.
//
// Clamping is NOT baked in. The call sites genuinely disagree: secPlotFrac
// (`:4492`) clamps the fraction to [0,1], specPlotFrac (`:12735`) returns null
// when it falls outside, and drawSpectrum's Yf (`:2718`) clamps the PIXEL to
// the plot rect. So the raw maths is exported and each variant is a separate,
// named function.

/** Data value -> fraction across a [lo,hi] window. Not clamped. */
export function valueToFrac(v: number, lo: number, hi: number): number {
  return (v - lo) / (hi - lo);
}

/** Fraction -> data value across a [lo,hi] window. The exact inverse of
 *  valueToFrac. This is `t0 + fx * (t1 - t0)` at `app.ts:4498` (secZoomAt
 *  anchor), `:4956` (box zoom) and `:5354` (traceZoomAt). */
export function fracToValue(f: number, lo: number, hi: number): number {
  return lo + f * (hi - lo);
}

/** Fraction -> pixel along an axis starting at `origin` and `size` long.
 *  `origin + f * size`, the form used for X everywhere. */
export function fracToPixel(f: number, origin: number, size: number): number {
  return origin + f * size;
}

/** Pixel -> fraction. The inverse: `(px - origin) / size`. Matches
 *  `app.ts:4491-4492` and `:12733-12734` before their differing clamps. */
export function pixelToFrac(px: number, origin: number, size: number): number {
  return (px - origin) / size;
}

/** Fraction -> pixel on a DOWNWARD axis whose fraction 0 sits at the BOTTOM.
 *  `origin + size - f * size`, i.e. drawSpectrum's amplitude axis at
 *  `app.ts:2718` where vmin is at the bottom of the plot. */
export function fracToPixelUp(f: number, origin: number, size: number): number {
  return origin + size - f * size;
}

/** Pixel -> fraction for the upward axis. Inverse of fracToPixelUp. */
export function pixelToFracUp(px: number, origin: number, size: number): number {
  return (origin + size - px) / size;
}

/** X mapping of drawSpectrum (`app.ts:2717`): `ML + ((f - fLo) / fSpan) * pw`.
 *
 *  `fSpan` is passed in rather than derived, because the call site computes it
 *  as `fHi - fLo || 1` (`:2707`) - a JavaScript falsy test, NOT a `> 0` guard.
 *  A negative span therefore survives there, and reproducing that exactly
 *  matters for byte-identical output. See spanOrOne. */
export function spectrumX(f: number, fLo: number, fSpan: number, ML: number, pw: number): number {
  return ML + ((f - fLo) / fSpan) * pw;
}

/** `hi - lo || 1` from `app.ts:2707`. Zero (and NaN, and -0) become 1; a
 *  negative span is left alone. Deliberately not "fixed". */
export function spanOrOne(lo: number, hi: number): number {
  return (hi - lo) || 1;
}

/** Y mapping of drawSpectrum (`app.ts:2718`), including its clamp to the plot
 *  rect. Kept whole because the clamp is inside the same arrow function there:
 *
 *    const y = MT + ph - ((v - vmin) / (vmax - vmin)) * ph;
 *    return y < MT ? MT : y > MT + ph ? MT + ph : y;
 *
 *  Note the ternary chain, not Math.max/Math.min: NaN fails both comparisons
 *  and is returned unchanged, which is what the inline code does. */
export function spectrumY(v: number, vmin: number, vmax: number, MT: number, ph: number): number {
  const y = MT + ph - ((v - vmin) / (vmax - vmin)) * ph;
  return y < MT ? MT : y > MT + ph ? MT + ph : y;
}

/** Sample index -> y on a time-down axis, with the 0/0 guard from
 *  `app.ts:3494`: with a single sample `s / (colLen - 1)` would be 0/0 = NaN
 *  and reach lineTo. `sDen = Math.max(1, colLen - 1)`. */
export function sampleDenominator(count: number): number {
  return Math.max(1, count - 1);
}

/** Pixel -> fraction, clamped to [0,1]. secPlotFrac at `app.ts:4492`. */
export function pixelToFracClamped(px: number, origin: number, size: number): number {
  const f = (px - origin) / size;
  return Math.max(0, Math.min(1, f));
}

/** Pixel -> fraction, or null when the pixel is outside the plot rect.
 *  specPlotFrac at `app.ts:12733-12736`. Note the test is on the FRACTION
 *  after division, `fx < 0 || fx > 1`, so a NaN fraction passes the test and is
 *  returned - reproduced here rather than corrected. */
export function pixelToFracOrNull(px: number, origin: number, size: number): number | null {
  const f = (px - origin) / size;
  return (f < 0 || f > 1) ? null : f;
}
