// seisconv-core / gis - slippy-map tile mathematics and mosaic resampling.
//
// Web-map tiles are always in Web Mercator (EPSG:3857) on a SPHERE, addressed by
// z/x/y with y counting from the north. A survey raster is in the survey's own
// CRS, so a basemap layer is not a copy of the tiles - every output pixel is
// resampled: output pixel -> output CRS -> WGS84 lat/lon -> Web Mercator pixel ->
// sample the mosaic. Pasting tiles in unresampled would misregister the imagery
// against the survey by tens of metres at survey latitudes.
//
// Pure - no DOM, no Node, no network. Fetching and PNG/JPEG decoding happen in
// the main process (see electron/main.ts); this module only does the geometry.

/** Standard slippy-map tile edge, in pixels. */
export const TILE_SIZE = 256;
/** Web Mercator is defined on a sphere of the WGS 84 semi-major axis. */
const R_MAJOR = 6378137;
const MAX_LAT = 85.05112877980659; // where the Mercator projection is truncated

export interface TileRange {
  zoom: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Total tiles the range covers. */
  count: number;
}

export interface Mosaic {
  /** RGB, row-major, width*height*3. */
  rgb: Uint8Array;
  width: number;
  height: number;
  zoom: number;
  /** Global Web-Mercator pixel coordinate of the mosaic's top-left corner. */
  originPx: number;
  originPy: number;
}

const clampLat = (lat: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

/** WGS84 lat/lon -> GLOBAL Web-Mercator pixel coordinates at `zoom`. */
export function lonLatToPixel(lat: number, lon: number, zoom: number): { px: number; py: number } {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const x = (lon + 180) / 360;
  const s = Math.sin((clampLat(lat) * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return { px: x * scale, py: y * scale };
}

/** Inverse of {@link lonLatToPixel}. */
export function pixelToLonLat(px: number, py: number, zoom: number): { lat: number; lon: number } {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const lon = (px / scale) * 360 - 180;
  const n = Math.PI * (1 - 2 * (py / scale));
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lon };
}

/** Ground resolution (metres per pixel) of a tile zoom level at a latitude. */
export function tileResolution(zoom: number, lat: number): number {
  return (Math.cos((clampLat(lat) * Math.PI) / 180) * 2 * Math.PI * R_MAJOR) / (TILE_SIZE * Math.pow(2, zoom));
}

/**
 * The lowest zoom whose tile resolution is at least as fine as `targetRes`
 * metres per pixel, so the basemap is never upsampled beyond the detail it
 * actually has - and never fetches far more tiles than the output can show.
 */
export function zoomForResolution(targetRes: number, lat: number, maxZoom = 19): number {
  if (!Number.isFinite(targetRes) || targetRes <= 0) return Math.min(16, maxZoom);
  for (let z = 0; z <= maxZoom; z++) {
    if (tileResolution(z, lat) <= targetRes) return z;
  }
  return maxZoom;
}

/** The tiles covering a WGS84 bounding box at `zoom`. */
export function tileRangeForBounds(
  bounds: { south: number; west: number; north: number; east: number },
  zoom: number,
): TileRange {
  const tl = lonLatToPixel(bounds.north, bounds.west, zoom);
  const br = lonLatToPixel(bounds.south, bounds.east, zoom);
  const n = Math.pow(2, zoom);
  const clampT = (v: number) => Math.max(0, Math.min(n - 1, v));
  const minX = clampT(Math.floor(tl.px / TILE_SIZE));
  const maxX = clampT(Math.floor((br.px - 1e-9) / TILE_SIZE));
  const minY = clampT(Math.floor(tl.py / TILE_SIZE));
  const maxY = clampT(Math.floor((br.py - 1e-9) / TILE_SIZE));
  return { zoom, minX, maxX, minY, maxY, count: (maxX - minX + 1) * (maxY - minY + 1) };
}

/**
 * Choose the highest zoom whose tile count stays within `maxTiles`, starting
 * from the zoom the output resolution deserves and backing off. Fetching
 * thousands of tiles for one export would hammer a public tile server, so the
 * cap is a hard constraint and the chosen zoom is reported back to the user.
 */
export function fitZoom(
  bounds: { south: number; west: number; north: number; east: number },
  targetRes: number,
  maxTiles: number,
  maxZoom = 19,
): { zoom: number; range: TileRange; downgraded: boolean } {
  const midLat = (bounds.south + bounds.north) / 2;
  const want = zoomForResolution(targetRes, midLat, maxZoom);
  let z = want;
  let range = tileRangeForBounds(bounds, z);
  while (z > 0 && range.count > maxTiles) {
    z--;
    range = tileRangeForBounds(bounds, z);
  }
  return { zoom: z, range, downgraded: z < want };
}

/**
 * Resample a Web-Mercator mosaic onto an arbitrary output grid.
 *
 * `toLatLon` maps an output pixel CENTRE (in output CRS units) to WGS84, which
 * is what makes this work for any CRS the engine supports rather than only for
 * Web Mercator output. Sampling is nearest-neighbour: a basemap is a backdrop,
 * and interpolating imagery would invent detail while costing four times the
 * work. Pixels with no tile coverage are left at `fill`.
 */
export function resampleMosaic(
  m: Mosaic,
  grid: { width: number; height: number; originX: number; originY: number; pixelSize: number },
  toLatLon: (e: number, n: number) => { lat: number; lon: number },
  fill: [number, number, number] = [255, 255, 255],
): Uint8Array {
  const out = new Uint8Array(grid.width * grid.height * 3);
  for (let i = 0; i < out.length; i += 3) { out[i] = fill[0]; out[i + 1] = fill[1]; out[i + 2] = fill[2]; }

  for (let iy = 0; iy < grid.height; iy++) {
    const n = grid.originY - (iy + 0.5) * grid.pixelSize;
    for (let ix = 0; ix < grid.width; ix++) {
      const e = grid.originX + (ix + 0.5) * grid.pixelSize;
      const ll = toLatLon(e, n);
      if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lon)) continue;
      const p = lonLatToPixel(ll.lat, ll.lon, m.zoom);
      const sx = Math.floor(p.px - m.originPx);
      const sy = Math.floor(p.py - m.originPy);
      if (sx < 0 || sy < 0 || sx >= m.width || sy >= m.height) continue;
      const so = (sy * m.width + sx) * 3;
      const oo = (iy * grid.width + ix) * 3;
      out[oo] = m.rgb[so];
      out[oo + 1] = m.rgb[so + 1];
      out[oo + 2] = m.rgb[so + 2];
    }
  }
  return out;
}
