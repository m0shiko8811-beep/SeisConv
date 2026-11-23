// seisconv-core / sheet - the frame of the survey-area map image.
//
// Fits the survey extent into a fixed-size picture with a margin, in the metric
// grid of the survey (square pixels, north up), and picks "nice" round steps for
// the coordinate grid and the scale bar. The renderer draws with these numbers
// and the main process fetches basemap tiles for the same grid, so both agree.
//
// Every output is finite with min < max; degenerate input (one point, NaN)
// falls back to a minimum span instead of producing a zero or NaN scale.
//
// Pure: no DOM / Electron.

export interface MapGrid {
  /** Picture size, pixels. */
  width: number;
  height: number;
  /** Grid coordinate of the top-left pixel corner. */
  originX: number;
  originY: number;
  /** Grid units (metres) per pixel, square. */
  pixelSize: number;
}

export interface Extent { minE: number; minN: number; maxE: number; maxN: number }

/** Smallest span the map shows, metres (a single point still gets a frame). */
export const MAP_MIN_SPAN_M = 200;

/**
 * The grid that shows `ext` inside a `plot` rectangle of the picture (plot
 * insets in pixels), with `marginFrac` of breathing room around the extent.
 * Returns null only when the extent itself is not finite.
 */
export function fitMapGrid(
  ext: Extent,
  width: number,
  height: number,
  plot: { left: number; top: number; right: number; bottom: number },
  marginFrac = 0.12,
): MapGrid | null {
  if (![ext.minE, ext.minN, ext.maxE, ext.maxN].every(Number.isFinite)) return null;
  const W = Math.max(16, Math.floor(width)), H = Math.max(16, Math.floor(height));
  const pw = Math.max(8, W - plot.left - plot.right), ph = Math.max(8, H - plot.top - plot.bottom);
  const cx = (ext.minE + ext.maxE) / 2, cy = (ext.minN + ext.maxN) / 2;
  const m = Number.isFinite(marginFrac) && marginFrac >= 0 && marginFrac < 2 ? marginFrac : 0.12;
  const spanE = Math.max(MAP_MIN_SPAN_M, (ext.maxE - ext.minE) * (1 + 2 * m));
  const spanN = Math.max(MAP_MIN_SPAN_M, (ext.maxN - ext.minN) * (1 + 2 * m));
  const pixelSize = Math.max(spanE / pw, spanN / ph);
  if (!Number.isFinite(pixelSize) || pixelSize <= 0) return null;
  // Centre the extent in the plot rectangle, then extend to the whole picture.
  const plotCx = plot.left + pw / 2, plotCy = plot.top + ph / 2;
  return { width: W, height: H, originX: cx - plotCx * pixelSize, originY: cy + plotCy * pixelSize, pixelSize };
}

/** Grid -> pixel. */
export function toPx(g: MapGrid, e: number, n: number): { x: number; y: number } {
  return { x: (e - g.originX) / g.pixelSize, y: (g.originY - n) / g.pixelSize };
}

/** A round step (1, 2 or 5 x 10^k) giving about `target` intervals over `span`. */
export function niceStep(span: number, target = 6): number {
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(target) || target <= 0) return 1;
  const raw = span / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const k = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return k * p;
}

/** Scale bar length in metres (a round number) no longer than `maxPx` pixels. */
export function scaleBarMetres(pixelSize: number, maxPx: number): number {
  if (!Number.isFinite(pixelSize) || pixelSize <= 0 || !Number.isFinite(maxPx) || maxPx <= 0) return 0;
  const maxM = pixelSize * maxPx;
  const p = Math.pow(10, Math.floor(Math.log10(maxM)));
  for (const k of [5, 2, 1]) if (k * p <= maxM) return k * p;
  return p;
}

/** "250 m" / "1.5 km". */
export function fmtDistance(m: number): string {
  if (!Number.isFinite(m)) return '';
  return m >= 1000 ? `${Number((m / 1000).toFixed(2))} km` : `${Number(m.toFixed(1))} m`;
}

/** The grid tick values inside [lo, hi] for a step. Capped at 200 ticks. */
export function ticks(lo: number, hi: number, step: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo) || !Number.isFinite(step) || step <= 0) return [];
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi && out.length < 200; v += step) out.push(Number(v.toFixed(6)));
  return out;
}
