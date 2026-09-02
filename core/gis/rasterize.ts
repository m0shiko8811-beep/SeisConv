// seisconv-core / gis - turn survey geometry into a regular grid.
//
// Three rasters, all sharing one {@link RasterSpec} so they line up pixel for
// pixel and can be exported as a stack of GeoTIFFs over the same extent:
//   counts       CMP fold / point density  (single band, Float32)
//   idw          an interpolated surface, e.g. station elevation (Float32)
//   layout       a rendered picture of the survey (RGB)
//
// Everything works in the survey's PROJECTED coordinates, and every raster is
// written NORTH-UP (row 0 is the north edge) because that is what GeoTIFF's
// ModelTiepoint convention expects.
//
// Interpolation never extrapolates: a cell with no station inside the search
// radius is nodata, not a guess. A survey is a set of measurements along lines
// with large gaps between them, and filling those gaps with invented values
// would produce a terrain surface a client could mistake for surveyed data.
//
// Pure - no DOM, no Node, no Date.

import { GEOTIFF_NODATA, MAX_GEOTIFF_PIXELS } from './geotiff';

export interface RasterSpec {
  /** Extent in projected CRS units. */
  minE: number;
  minN: number;
  maxE: number;
  maxN: number;
  /** Ground resolution, CRS units per pixel. */
  pixelSize: number;
}

export interface RasterGrid {
  width: number;
  height: number;
  /** West edge and NORTH edge (GeoTIFF origin, pixel-is-area outer corner). */
  originX: number;
  originY: number;
  pixelSize: number;
}

/** Point with a value, for the interpolated surface. */
export interface ValuePoint {
  e: number;
  n: number;
  v: number;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Resolve an extent + resolution to whole pixels. The extent is EXPANDED (never
 * shrunk) to a whole number of pixels, so the requested area is always fully
 * covered rather than clipped along the north/east edges.
 */
export function rasterGrid(spec: RasterSpec): RasterGrid {
  const px = spec.pixelSize;
  if (!fin(px) || px <= 0) throw new Error(`Resolution must be a positive number, got ${spec.pixelSize}`);
  const w = spec.maxE - spec.minE;
  const h = spec.maxN - spec.minN;
  if (!fin(w) || !fin(h) || w <= 0 || h <= 0) throw new Error('The selected area is empty - drag a box that covers some of the survey.');
  const width = Math.max(1, Math.ceil(w / px));
  const height = Math.max(1, Math.ceil(h / px));
  if (width * height > MAX_GEOTIFF_PIXELS) {
    throw new Error(`That area at ${px} units/pixel is ${width}x${height} pixels (${(width * height / 1e6).toFixed(1)} Mpx), over the ${(MAX_GEOTIFF_PIXELS / 1e6).toFixed(0)} Mpx cap. Use a coarser resolution or a smaller area.`);
  }
  return { width, height, originX: spec.minE, originY: spec.minN + height * px, pixelSize: px };
}

/** Column/row of a coordinate, north-up. Returns null when outside the grid. */
function cellOf(g: RasterGrid, e: number, n: number): { ix: number; iy: number } | null {
  const ix = Math.floor((e - g.originX) / g.pixelSize);
  const iy = Math.floor((g.originY - n) / g.pixelSize); // row 0 = north
  if (ix < 0 || iy < 0 || ix >= g.width || iy >= g.height) return null;
  return { ix, iy };
}

/**
 * Count points per cell - the fold map when fed CMP midpoints, a station-density
 * map when fed the stations themselves. Empty cells are 0, not nodata: zero fold
 * is a real, meaningful measurement.
 */
export function rasterizeCounts(es: ArrayLike<number>, ns: ArrayLike<number>, g: RasterGrid): Float32Array {
  const out = new Float32Array(g.width * g.height);
  const n = Math.min(es.length, ns.length);
  for (let i = 0; i < n; i++) {
    const e = es[i], nn = ns[i];
    if (!fin(e) || !fin(nn)) continue;
    const c = cellOf(g, e, nn);
    if (c) out[c.iy * g.width + c.ix]++;
  }
  return out;
}

export interface IdwOptions {
  /** Only stations within this distance (CRS units) contribute. */
  searchRadius: number;
  /** Inverse-distance exponent. 2 is the usual choice. */
  power?: number;
  /** Cap on how many nearest stations feed one cell. */
  maxPoints?: number;
  nodata?: number;
}

/**
 * Inverse-distance-weighted surface from scattered stations.
 *
 * A uniform bucket index keeps this near-linear: without it, a 1 000 x 1 000
 * raster against 100 000 stations is 10^11 distance tests. Cells with nothing
 * inside `searchRadius` stay nodata - see the note at the top of this file about
 * refusing to invent terrain between lines.
 */
export function rasterizeIDW(pts: ValuePoint[], g: RasterGrid, opts: IdwOptions): Float32Array {
  const nodata = opts.nodata ?? GEOTIFF_NODATA;
  const out = new Float32Array(g.width * g.height).fill(nodata);
  const radius = opts.searchRadius;
  if (!fin(radius) || radius <= 0) throw new Error(`Search radius must be positive, got ${opts.searchRadius}`);
  const power = fin(opts.power) && (opts.power as number) > 0 ? (opts.power as number) : 2;
  const maxPoints = Math.max(1, Math.min(64, Math.floor(opts.maxPoints ?? 12)));

  const usable = pts.filter((p) => fin(p.e) && fin(p.n) && fin(p.v));
  if (!usable.length) return out;

  // Bucket the stations on a grid of one search radius, so a cell only has to
  // look at the 3x3 buckets around it.
  const bs = radius;
  let bMinE = Infinity, bMinN = Infinity;
  for (const p of usable) { if (p.e < bMinE) bMinE = p.e; if (p.n < bMinN) bMinN = p.n; }
  const buckets = new Map<number, ValuePoint[]>();
  const key = (bx: number, by: number) => bx * 73856093 ^ by * 19349663;
  for (const p of usable) {
    const bx = Math.floor((p.e - bMinE) / bs);
    const by = Math.floor((p.n - bMinN) / bs);
    const k = key(bx, by);
    const arr = buckets.get(k);
    if (arr) arr.push(p); else buckets.set(k, [p]);
  }

  const r2 = radius * radius;
  const near: { d2: number; v: number }[] = [];
  for (let iy = 0; iy < g.height; iy++) {
    const cn = g.originY - (iy + 0.5) * g.pixelSize; // cell CENTRE
    for (let ix = 0; ix < g.width; ix++) {
      const ce = g.originX + (ix + 0.5) * g.pixelSize;
      const bx = Math.floor((ce - bMinE) / bs);
      const by = Math.floor((cn - bMinN) / bs);
      near.length = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const arr = buckets.get(key(bx + dx, by + dy));
          if (!arr) continue;
          for (const p of arr) {
            const d2 = (p.e - ce) ** 2 + (p.n - cn) ** 2;
            if (d2 <= r2) near.push({ d2, v: p.v });
          }
        }
      }
      if (!near.length) continue;
      // An exact hit wins outright - averaging around a zero distance blows up.
      let exact = -1;
      for (let i = 0; i < near.length; i++) if (near[i].d2 < 1e-12) { exact = i; break; }
      if (exact >= 0) { out[iy * g.width + ix] = near[exact].v; continue; }
      if (near.length > maxPoints) near.sort((a, b) => a.d2 - b.d2);
      const take = Math.min(near.length, maxPoints);
      let num = 0, den = 0;
      for (let i = 0; i < take; i++) {
        const w = 1 / Math.pow(near[i].d2, power / 2);
        num += w * near[i].v;
        den += w;
      }
      if (den > 0) out[iy * g.width + ix] = num / den;
    }
  }
  return out;
}

export interface LayoutStyle {
  /** Background RGB. */
  bg?: [number, number, number];
  src?: [number, number, number];
  rcv?: [number, number, number];
  /** Marker half-size in pixels (0 = a single pixel). */
  markerRadius?: number;
}

/**
 * Render the survey as an RGB picture, georeferenced by the same grid. This is a
 * PICTURE, not data: it is for dropping a ready-made plot into a client's GIS or
 * a report. The fold and elevation rasters are the ones to analyse.
 */
export function rasterizeLayout(
  sources: { e: number; n: number }[],
  receivers: { e: number; n: number }[],
  g: RasterGrid,
  style: LayoutStyle = {},
): Uint8Array {
  const bg = style.bg ?? [255, 255, 255];
  const srcCol = style.src ?? [220, 60, 40];
  const rcvCol = style.rcv ?? [40, 110, 200];
  const r = Math.max(0, Math.min(32, Math.floor(style.markerRadius ?? 1)));

  const out = new Uint8Array(g.width * g.height * 3);
  for (let i = 0; i < out.length; i += 3) { out[i] = bg[0]; out[i + 1] = bg[1]; out[i + 2] = bg[2]; }

  const plot = (pts: { e: number; n: number }[], col: [number, number, number]) => {
    for (const p of pts) {
      if (!fin(p.e) || !fin(p.n)) continue;
      const c = cellOf(g, p.e, p.n);
      if (!c) continue;
      for (let dy = -r; dy <= r; dy++) {
        const y = c.iy + dy;
        if (y < 0 || y >= g.height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const x = c.ix + dx;
          if (x < 0 || x >= g.width) continue;
          const o = (y * g.width + x) * 3;
          out[o] = col[0]; out[o + 1] = col[1]; out[o + 2] = col[2];
        }
      }
    }
  };
  // Receivers first so the (usually sparser) sources draw on top.
  plot(receivers, rcvCol);
  plot(sources, srcCol);
  return out;
}

/** Simple statistics for the UI to report what was actually produced. */
export function bandStats(band: Float32Array, nodata = GEOTIFF_NODATA): { min: number; max: number; filled: number; total: number } {
  let min = Infinity, max = -Infinity, filled = 0;
  for (let i = 0; i < band.length; i++) {
    const v = band[i];
    if (v === nodata || !Number.isFinite(v)) continue;
    filled++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min: filled ? min : 0, max: filled ? max : 0, filled, total: band.length };
}
