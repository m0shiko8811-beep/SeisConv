// seisconv-core - zoom window arithmetic
//
// The anchor-zoom family in `renderer/src/app.ts` - secZoomAt `:4496`,
// traceZoomAt `:5353`, wbZoomAt `:5519`, velZoomAt `:12011`, specAvgZoomAt
// `:12286`, heatZoomAt `:12343` - all narrow a window about a fractional cursor
// anchor. The clamps (secClamp `:3200`, traceClamp `:5329`, wbClamp `:5497`)
// then keep the window inside the data.
//
// Maths only. No handler is added, removed or rebound by this module, and no
// DOM or Electron type appears in it.
//
// TWO REAL DIFFERENCES between sites that look identical, preserved rather than
// unified (see the report accompanying this step):
//   1. Y anchoring. specAvgZoomAt (`:12296-12297`) writes
//      `ay = y1 - fy*(y1-y0); y1 = ay + fy*wy; y0 = ay - (1-fy)*wy`, while
//      heatZoomAt with yUp (`:12349-12351`) writes
//      `ay = y0 + (1-fy)*(y1-y0); y0 = ay - fyTop*wy; y1 = ay + (1-fyTop)*wy`.
//      Algebraically the same, NOT bit-identical in floating point.
//   2. Minimum-span floors. specAvgZoomAt uses 1e-6 on X and 1e-9 on Y
//      (`:12299-12300`); heatZoomAt uses 1e-9 on both (`:12352-12353`).

/** A 1-D window. */
export type Window1D = { lo: number; hi: number };

/** Narrow (or widen) [lo,hi] by `factor` about fraction `f`, where f = 0 is the
 *  LOW edge. The value under `f` stays put.
 *
 *  This is the shape at `app.ts:4498-4503` (secZoomAt, both axes), `:5354-5357`
 *  (traceZoomAt), `:5520-5523` (wbZoomAt) and `:12347-12348` (heatZoomAt X):
 *
 *    const a = lo + f * (hi - lo);
 *    const w = (hi - lo) * factor;
 *    lo = a - f * w;  hi = a + (1 - f) * w;
 */
export function anchorZoom(lo: number, hi: number, f: number, factor: number): Window1D {
  const a = lo + f * (hi - lo);
  const w = (hi - lo) * factor;
  return { lo: a - f * w, hi: a + (1 - f) * w };
}

/** heatZoomAt's Y axis, `app.ts:12349-12351`. `yUp` flips the anchor so
 *  fraction 0 (screen top) means the HIGH edge, the F-K frequency-up
 *  convention. Written with the same `fyTop` intermediate as the tree so the
 *  arithmetic is bit-identical, not merely equivalent. */
export function anchorZoomY(lo: number, hi: number, fy: number, factor: number, yUp: boolean): Window1D {
  const fyTop = yUp ? (1 - fy) : fy;
  const a = lo + fyTop * (hi - lo);
  const w = (hi - lo) * factor;
  return { lo: a - fyTop * w, hi: a + (1 - fyTop) * w };
}

/** specAvgZoomAt's Y axis, `app.ts:12296-12297`, kept as its own function
 *  because it anchors off the HIGH edge:
 *
 *    const ay = y1 - fy * (y1 - y0), wy = (y1 - y0) * factor;
 *    y1 = ay + fy * wy;  y0 = ay - (1 - fy) * wy;
 *
 *  Equal to anchorZoomY(..., yUp = true) in exact arithmetic, not in floats. */
export function anchorZoomYFromHigh(lo: number, hi: number, fy: number, factor: number): Window1D {
  const a = hi - fy * (hi - lo);
  const w = (hi - lo) * factor;
  return { lo: a - (1 - fy) * w, hi: a + fy * w };
}

/** Clamp a continuous window into [eLo,eHi] keeping at least `minSpan`.
 *  `app.ts:12352-12354` (heatZoomAt) and `:12299-12302` (specAvgZoomAt) run the
 *  identical four statements, so the order is preserved exactly: raise lo,
 *  lower hi, then if the span collapsed push hi up from lo and pull lo back. */
export function clampToExtent(lo: number, hi: number, eLo: number, eHi: number, minSpan: number): Window1D {
  let a = Math.max(eLo, lo);
  let b = Math.min(eHi, hi);
  if (b - a < minSpan) { b = Math.min(eHi, a + minSpan); a = b - minSpan; }
  return { lo: a, hi: b };
}

/** The minimum-span floor: `Math.max(floor, extentSpan * 1e-3)`.
 *  `floor` is 1e-6 for specAvgZoomAt's X axis and 1e-9 everywhere else. */
export function minSpanFor(eLo: number, eHi: number, floor: number): number {
  return Math.max(floor, (eHi - eLo) * 1e-3);
}

/** Clamp an INDEX window into [0,full], keeping at least `minSpan` indices, and
 *  round to integers.
 *
 *  Verbatim structure of traceClamp (`app.ts:5329-5339`) and wbClamp
 *  (`:5497-5507`), which are byte-for-byte the same function under two names;
 *  secClamp (`:3200-3217`) is this applied to each of its two axes with
 *  minSpan 2 (traces) and 4 (samples). The `minSpan` passed by all three is
 *  `Math.min(full, k)`, so callers should pass `Math.min(full, 4)`, not 4 -
 *  a file shorter than the floor must not be inflated.
 *
 *  Note the ordering: shift-into-range first, THEN Math.round, THEN a final
 *  Math.max(0,...) / Math.min(full,...). Reordering changes the result on
 *  half-integer inputs. */
export function clampWindow(lo: number, hi: number, full: number, minSpan: number): Window1D {
  let a = lo, b = hi;
  if (b - a < minSpan) b = a + minSpan;
  if (b - a > full) { a = 0; b = full; }
  if (a < 0) { b -= a; a = 0; }
  if (b > full) { a -= b - full; b = full; }
  return { lo: Math.max(0, Math.round(a)), hi: Math.min(full, Math.round(b)) };
}

/** Manual axis boxes -> a visible window, `heatAxisWindow` at `app.ts:12537`.
 *  A null/non-finite edge means auto (take the data edge); an inverted pair
 *  falls back to the full extent; the result is clamped inside the data with a
 *  0.1%-of-extent minimum span. A degenerate extent yields a unit window. */
export function boxToWindow(
  manualLo: number | null,
  manualHi: number | null,
  dLo: number,
  dHi: number,
): Window1D {
  const span = dHi - dLo;
  if (!(span > 0)) return { lo: dLo, hi: dLo + 1 };
  let lo = (typeof manualLo === 'number' && Number.isFinite(manualLo)) ? manualLo : dLo;
  let hi = (typeof manualHi === 'number' && Number.isFinite(manualHi)) ? manualHi : dHi;
  if (!(hi > lo)) { lo = dLo; hi = dHi; }
  const minW = span * 1e-3;
  lo = Math.max(dLo, Math.min(lo, dHi - minW));
  hi = Math.min(dHi, Math.max(hi, lo + minW));
  return { lo, hi };
}

/** A drag rectangle's fractional extent -> a rounded INDEX window, the shared
 *  half of finishSecBoxDrag (`app.ts:4959-4960`) and finishTraceBoxDrag
 *  (`:4999`): `Math.round(v0 + f * (v1 - v0))` on each edge of the CURRENT
 *  window. The per-viewer clamping that follows is left at the call site
 *  because the two differ (`Math.min(fT, ...)` versus
 *  `Math.min(t.nSamples - 1, ...)`). */
export function boxDragToIndices(f0: number, f1: number, v0: number, v1: number): Window1D {
  return { lo: Math.round(v0 + f0 * (v1 - v0)), hi: Math.round(v0 + f1 * (v1 - v0)) };
}
