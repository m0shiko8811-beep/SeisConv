// seisconv-renderer - the cropped heatmap blit, in one place
//
// Three sites paint an offscreen heatmap into a plot rectangle, stretching a
// visible source window to fill the axes: drawSpecGram, drawSpecFk (both via
// what used to be `blitHeatCrop` in app.ts) and drawVelocity, which had the same
// arithmetic retyped inline against nV/nT. This module owns that sequence.
//
// DOM-touching (it calls drawImage on a 2d context), so it lives here and NOT in
// `core/`, which is pure TS per CLAUDE.md.

/** Blit a cropped sub-rectangle of an offscreen heatmap into `dest`, stretching
 *  the visible source window to fill it. `srcFrac` gives the crop in 0..1 source
 *  fractions (sx0<sx1 left→right, sy0<sy1 top→bottom of the OFFSCREEN image).
 *  All values are pre-clamped to [0,1] with a ≥1px source span so drawImage
 *  never gets a zero/negative rect (which throws). */
export function blitRaster(
  ctx: CanvasRenderingContext2D,
  off: HTMLCanvasElement,
  dest: { x: number; y: number; w: number; h: number },
  srcFrac: { sx0: number; sx1: number; sy0: number; sy1: number },
) {
  const cl = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  const sx0 = cl(srcFrac.sx0), sx1 = cl(srcFrac.sx1), sy0 = cl(srcFrac.sy0), sy1 = cl(srcFrac.sy1);
  let sx = sx0 * off.width, sw = (sx1 - sx0) * off.width;
  let sy = sy0 * off.height, sh = (sy1 - sy0) * off.height;
  if (!(sw >= 1)) { sw = 1; sx = Math.min(sx, off.width - 1); }
  if (!(sh >= 1)) { sh = 1; sy = Math.min(sy, off.height - 1); }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, sx, sy, sw, sh, dest.x, dest.y, dest.w, dest.h);
}
