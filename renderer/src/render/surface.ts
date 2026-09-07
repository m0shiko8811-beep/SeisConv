// seisconv-renderer - the canvas setup preamble, in one place
//
// Thirteen draw sites in `renderer/src/app.ts` open with the same five steps:
// read devicePixelRatio, take the CSS size (with a per-site fallback literal),
// set cv.width/cv.height in device pixels, get the 2d context, apply the dpr
// transform, and paint the background. This module owns that sequence.
//
// DOM-touching, so it lives here and NOT in `core/`, which is pure TS per
// CLAUDE.md. The pure arithmetic it uses (margins, plotRect) comes from
// `core/render/frame`.
//
// DELIBERATELY NOT NORMALISED: the fallback sizes differ per site (|| 900,
// || 460, || 240, || 160, || 200) and so do the background fills. A hidden tab
// has clientWidth === 0, so the fallback literal decides the real canvas size
// and the pixel oracle reads it back. Every caller keeps passing its own
// values; unifying them is a separate, deliberate step.

import { plotRect, type Margins, type PlotRect } from '../../../core/render/frame';

/** How the canvas gets its CSS size: either measured with a per-site fallback,
 *  or handed over already computed (drawVelocity takes W/H from velGeom, which
 *  is also the hit-test side, so that computation must not move). */
export type SurfaceSize =
  | { fallbackW: number; fallbackH: number }
  | { W: number; H: number };

/** The background paint: a plain style string, or a factory that builds one
 *  from the context AFTER the dpr transform is applied (drawSpectrum's
 *  createLinearGradient(0, 0, 0, H) is in user space, so the order matters).
 *  `null` means paint nothing. */
export type SurfaceFill =
  | string
  | null
  | ((ctx: CanvasRenderingContext2D, W: number, H: number) => string | CanvasGradient | CanvasPattern);

/** RENDER SCALE OVERRIDE (image export).
 *
 *  Normally every canvas is backed at `devicePixelRatio` device pixels per CSS
 *  pixel. The image export raises that number for ONE redraw, grabs the canvas,
 *  and puts it back. Because the CSS width/height handed to every draw function
 *  is untouched, the exported picture is the on-screen picture in every respect
 *  that matters - same margins, same tick count, same strip truncation, same
 *  hit-test geometry - only with more pixels behind it.
 *
 *  Kept HERE rather than in app.ts so the two section overlays (attachOverlay)
 *  land on the same transform as the base pass; an overlay left at dpr while the
 *  base is at 3x would draw the health flags a third of the way across. */
let renderScaleOverride: number | null = null;

/** Device pixels per CSS pixel for the next draw: the export override when one is
 *  active, otherwise the display's own ratio. Never returns a non-finite or
 *  non-positive number, so no canvas can be sized to NaN. */
export function renderScale(): number {
  const s = renderScaleOverride ?? (window.devicePixelRatio || 1);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** Set (or clear, with null) the export render scale. Callers MUST clear it in a
 *  `finally`: a scale left standing would silently change every later repaint. */
export function setRenderScale(s: number | null): void {
  renderScaleOverride = s !== null && Number.isFinite(s) && s > 0 ? s : null;
}

/** A sized, transformed, background-painted canvas. */
export type Surface = { ctx: CanvasRenderingContext2D; W: number; H: number };

/** Same, plus the inner plot rectangle. */
export type PlotSurface = Surface & { plot: PlotRect };

function cssSize(cv: HTMLCanvasElement, size: SurfaceSize): { W: number; H: number } {
  if ('W' in size) return { W: size.W, H: size.H };
  return { W: cv.clientWidth || size.fallbackW, H: cv.clientHeight || size.fallbackH };
}

/** DPR-size the canvas, apply the dpr transform and paint the background.
 *
 *  Returns null only when the 2d context is unavailable - the canvas is still
 *  resized first, exactly as the inline preamble did.
 *
 *  Step order is pixel-critical: assigning cv.width resets all context state,
 *  so the resize must precede getContext / setTransform / fill. */
export function beginCanvas(cv: HTMLCanvasElement, size: SurfaceSize, fill: SurfaceFill): Surface | null {
  const dpr = renderScale();
  const { W, H } = cssSize(cv, size);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (fill !== null) {
    ctx.fillStyle = typeof fill === 'function' ? fill(ctx, W, H) : fill;
    ctx.fillRect(0, 0, W, H);
  }
  return { ctx, W, H };
}

/** beginCanvas plus the plot rectangle for the given margins. */
export function beginPlot(cv: HTMLCanvasElement, size: SurfaceSize, fill: SurfaceFill, m: Margins): PlotSurface | null {
  const s = beginCanvas(cv, size, fill);
  if (!s) return null;
  return { ...s, plot: plotRect(s.W, s.H, m) };
}

/** Attach to an ALREADY sized and painted canvas: apply the dpr transform and
 *  hand back the context. Resizes nothing and fills nothing, so it never
 *  clears what the base pass drew. Used by the two section overlays. */
export function attachOverlay(cv: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const dpr = renderScale();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
