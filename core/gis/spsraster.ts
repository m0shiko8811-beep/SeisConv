// seisconv-core / gis - build GeoTIFF rasters from a loaded SPS survey.
//
// Produces any combination of:
//   fold      CMP fold from the X (relation) records   single-band Float32
//   density   station density, when there are no X-refs single-band Float32
//   elevation IDW surface from station elevations       single-band Float32
//   layout    the survey drawn as a picture             3-band RGB
//
// All layers share ONE extent and resolution, so they stack pixel for pixel in
// GIS. Coordinates go out in the survey's own CRS by default, or in a chosen
// target CRS - the same rule as the shapefile export.
//
// Pure - no DOM, no Node, no Date.

import { projToLatLon, type Projection } from '../coords';
import type { SPSData, SPSPoint } from '../sps/parse';
import { lonLatToProj, type CRS } from '../sps/reproject';
import { crsToWkt } from './wkt';
import { GEOTIFF_NODATA, writeGeoTIFF, type GeoTiffCRS } from './geotiff';
import { bandStats, rasterGrid, rasterizeCounts, rasterizeIDW, rasterizeLayout, type RasterGrid, type ValuePoint } from './rasterize';
import { crsFromSPSProjection } from './spsshape';

/** Bound the CMP pair walk exactly as the fold map does, so a crafted or huge
 *  X-file can never spin the worker. */
const MAX_PAIRS = 4_000_000;

export type RasterLayer = 'fold' | 'elevation' | 'layout';

export interface SpsRasterOptions {
  /** Extent in WGS84 degrees, as dragged on the map. Ignored when `whole` is set. */
  bounds?: { south: number; west: number; north: number; east: number } | null;
  /** Use the full extent of every station instead of a dragged box. Computed
   *  HERE, in the output CRS, because this side has both the stations and the
   *  projection - deriving it in the renderer meant guessing which frame the
   *  on-screen geometry happened to be in. */
  whole?: boolean;
  /** Margin added around the whole-survey extent, in output CRS units. */
  marginM?: number;
  /** Ground resolution in the OUTPUT CRS's units (metres for a projected CRS). */
  pixelSize: number;
  layers: RasterLayer[];
  /** Reproject to this CRS instead of the survey's own. */
  target?: CRS | null;
  /** IDW search radius for the elevation surface, in output CRS units. */
  demRadius?: number;
  baseName?: string;
  /**
   * Resolve an EPSG code for a CRS that carries only parameters (the SPS-header
   * case). INJECTED rather than imported so this module stays free of the ~1.1 MB
   * EPSG table - only the worker, which already runs in Node, supplies it.
   *
   * It matters: GeoTIFF states a CRS cleanly only by EPSG code, so without this
   * a projected raster is written "user-defined" and GDAL reads it back as
   * geographic - a UTM raster claiming to be in degrees.
   */
  identifyEpsg?: (crs: CRS) => number | undefined;
}

export interface SpsRasterResult {
  files: { name: string; bytes: Uint8Array }[];
  notes: string[];
  /** What the wizard should report back: the grid actually produced. */
  grid: RasterGrid & { crsCode: string; crsName: string };
  /** The resolved OUTPUT CRS, so the main process can build the basemap layer
   *  on the identical grid (it needs the inverse projection to resample tiles). */
  outCrs: CRS | null;
  /** EPSG code the GeoTIFFs declare, when one is known or was identified. */
  epsg?: number;
}


/**
 * Median distance from a station to its nearest neighbour, in output CRS units.
 *
 * This is the number the raster defaults should key off - NOT the pixel size.
 * Tying the elevation search radius to pixel size meant choosing a finer
 * resolution SHRANK coverage, which is backwards, and left the surface ~95 %
 * nodata: an empty-looking layer produced from a perfectly good survey.
 * Sampled and capped so a 500k-station survey does not go quadratic.
 */
function medianStationSpacing(pts: { e: number; n: number }[]): number {
  const MAX_SAMPLE = 400;
  const step = Math.max(1, Math.floor(pts.length / MAX_SAMPLE));
  const sample: { e: number; n: number }[] = [];
  for (let i = 0; i < pts.length; i += step) sample.push(pts[i]);
  if (sample.length < 2) return NaN;
  const d: number[] = [];
  for (let i = 0; i < sample.length; i++) {
    let best = Infinity;
    for (let j = 0; j < sample.length; j++) {
      if (i === j) continue;
      const dx = sample[i].e - sample[j].e, dy = sample[i].n - sample[j].n;
      const q = dx * dx + dy * dy;
      if (q < best) best = q;
    }
    if (isFinite(best) && best > 0) d.push(Math.sqrt(best));
  }
  if (!d.length) return NaN;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOf = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v ?? '')));

/** The parser's projection in the shape projToLatLon reads. */
function toProjection(d: SPSData): Projection | undefined {
  const p = d.projection;
  if (!p || !p.type) return undefined;
  return {
    subtype: p.subtype ?? undefined, zone: p.zone ?? undefined, hemi: p.hemi ?? undefined,
    a: p.a ?? undefined, invF: p.invF ?? undefined,
    centralMeridian: p.centralMeridian ?? undefined, latOrigin: p.latOrigin ?? undefined,
    scaleFactor: p.scaleFactor ?? undefined, falseEasting: p.falseEasting ?? undefined,
    falseNorthing: p.falseNorthing ?? undefined, helmert: p.helmert ?? undefined,
  };
}

/**
 * Project the dragged lat/lon box into the output CRS.
 *
 * A geographic rectangle is NOT a rectangle once projected, so we project the
 * four corners AND the edge midpoints and take the bounding box of all eight.
 * The result always covers at least what the user dragged - erring outward is
 * safe, erring inward would quietly clip stations off the edge of the raster.
 */
function projectBounds(b: NonNullable<SpsRasterOptions['bounds']>, out: CRS): { minE: number; minN: number; maxE: number; maxN: number } {
  const midLat = (b.south + b.north) / 2;
  const midLon = (b.west + b.east) / 2;
  const samples: [number, number][] = [
    [b.south, b.west], [b.south, b.east], [b.north, b.west], [b.north, b.east],
    [b.south, midLon], [b.north, midLon], [midLat, b.west], [midLat, b.east],
  ];
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [lat, lon] of samples) {
    const en = out.subtype === 'GEO' ? { E: lon, N: lat } : lonLatToProj(lat, lon, out, 0);
    if (!fin(en.E) || !fin(en.N)) continue;
    if (en.E < minE) minE = en.E;
    if (en.E > maxE) maxE = en.E;
    if (en.N < minN) minN = en.N;
    if (en.N > maxN) maxN = en.N;
  }
  return { minE, minN, maxE, maxN };
}

/** Every station's position in the OUTPUT CRS, plus its elevation. */
function stationsInOutputCRS(
  pts: SPSPoint[],
  src: Projection | undefined,
  target: CRS | null,
): { e: number; n: number; v: number }[] {
  const out: { e: number; n: number; v: number }[] = [];
  for (const p of pts) {
    if (!fin(p.easting) || !fin(p.northing)) continue;
    if (!target) { out.push({ e: p.easting, n: p.northing, v: fin(p.elevation) ? p.elevation : NaN }); continue; }
    if (!src) continue;
    const ll = projToLatLon(p.easting, p.northing, src, fin(p.elevation) ? p.elevation : 0);
    const en = target.subtype === 'GEO' ? { E: ll.lon, N: ll.lat } : lonLatToProj(ll.lat, ll.lon, target, 0);
    if (!fin(en.E) || !fin(en.N)) continue;
    out.push({ e: en.E, n: en.N, v: fin(p.elevation) ? p.elevation : NaN });
  }
  return out;
}

/**
 * CMP midpoints from the X (relation) records, in the OUTPUT CRS. Mirrors the
 * fold map's pairing rules exactly (same key format, same per-xref iteration cap)
 * so the GeoTIFF and the on-screen fold map cannot disagree.
 */
function cmpMidpoints(
  d: SPSData,
  src: Projection | undefined,
  target: CRS | null,
): { es: number[]; ns: number[]; capped: boolean } {
  const key = (line: unknown, pt: unknown) => `${String(line).trim()}|${numOf(pt)}`;
  const srcMap = new Map<string, SPSPoint>();
  for (const s of d.sources) srcMap.set(key(s.lineName, s.point), s);
  const rcvMap = new Map<string, SPSPoint>();
  for (const r of d.receivers) rcvMap.set(key(r.lineName, r.point), r);

  const es: number[] = [];
  const ns: number[] = [];
  let capped = false;
  outer:
  for (const x of d.xrefs) {
    const shot = srcMap.get(key(x.srcLine, x.srcPt));
    if (!shot || !fin(shot.easting) || !fin(shot.northing)) continue;
    const rcvLine = String((x as Record<string, unknown>).rcvLineFrom ?? (x as Record<string, unknown>).rcvLine ?? '').trim();
    const from = numOf((x as Record<string, unknown>).rcvPtFrom);
    const to = numOf((x as Record<string, unknown>).rcvPtTo);
    if (!fin(from) || !fin(to) || to < from) continue;
    const incr = Math.max(1, numOf((x as Record<string, unknown>).rcvPtIncr) || 1);
    let steps = 0;
    for (let rp = from; rp <= to; rp += incr) {
      if (++steps > MAX_PAIRS) break;
      const rcv = rcvMap.get(`${rcvLine}|${rp}`);
      if (!rcv || !fin(rcv.easting) || !fin(rcv.northing)) continue;
      if (es.length >= MAX_PAIRS) { capped = true; break outer; }
      es.push((shot.easting + rcv.easting) / 2);
      ns.push((shot.northing + rcv.northing) / 2);
    }
  }

  if (!target) return { es, ns, capped };
  if (!src) return { es: [], ns: [], capped };
  // Midpoints are computed in the NATIVE grid (that is where the geometry lives)
  // and only then carried into the output CRS.
  const oe: number[] = [], on: number[] = [];
  for (let i = 0; i < es.length; i++) {
    const ll = projToLatLon(es[i], ns[i], src, 0);
    const en = target.subtype === 'GEO' ? { E: ll.lon, N: ll.lat } : lonLatToProj(ll.lat, ll.lon, target, 0);
    if (!fin(en.E) || !fin(en.N)) continue;
    oe.push(en.E); on.push(en.N);
  }
  return { es: oe, ns: on, capped };
}

/** The GeoTIFF CRS descriptor for an output CRS (EPSG code when we have one). */
function tiffCRS(crs: CRS | null, identify?: (c: CRS) => number | undefined): { desc: GeoTiffCRS | undefined; identified?: number; unnamed?: boolean } {
  if (!crs) return { desc: undefined };
  const m = /^EPSG:(\d+)$/i.exec(crs.code || '');
  let epsg = m ? parseInt(m[1], 10) : undefined;
  let identified: number | undefined;
  if (!epsg && identify) {
    const found = identify(crs);
    if (found) { epsg = found; identified = found; }
  }
  return {
    desc: {
      epsg,
      geographic: crs.subtype === 'GEO',
      wkt: epsg ? undefined : crsToWkt(crs) || undefined,
      name: crs.name || crs.code,
    },
    identified,
    unnamed: !epsg,
  };
}

/**
 * Build the requested rasters for a loaded survey.
 *
 * Never throws on survey content: a layer that cannot be produced (no X-refs for
 * fold, no elevations for the DEM) is SKIPPED with a note saying why, and the
 * other layers still come out. It throws only when the request itself is
 * impossible - an empty area, or a resolution that would blow the pixel cap.
 */
export function buildSPSRasters(d: SPSData, opts: SpsRasterOptions): SpsRasterResult {
  const notes: string[] = [];
  const base = (opts.baseName || 'survey').replace(/[^A-Za-z0-9_.-]/g, '_') || 'survey';
  const srcProj = toProjection(d);
  const nativeCrs = crsFromSPSProjection(d.projection);

  let target = opts.target || null;
  if (target && !srcProj) {
    notes.push(`Cannot reproject to ${target.code || target.name}: the SPS header carries no projection. Wrote the survey's native coordinates instead.`);
    target = null;
  }
  const outCrs = target || nativeCrs;
  if (!outCrs) {
    notes.push('The SPS header carries no projection, so the raster is written in raw easting/northing with no CRS. Set the CRS in the Header Editor for a georeferenced GeoTIFF.');
  }

  // The extent arrives as WGS84 degrees from the map. Without a source
  // projection we cannot place that box on the survey's own grid at all.
  let extent: { minE: number; minN: number; maxE: number; maxN: number };
  const stationExtent = () => {
    const pts = stationsInOutputCRS([...d.sources, ...d.receivers], srcProj, target);
    let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
    for (const p of pts) {
      if (p.e < minE) minE = p.e;
      if (p.e > maxE) maxE = p.e;
      if (p.n < minN) minN = p.n;
      if (p.n > maxN) maxN = p.n;
    }
    if (!fin(minE)) throw new Error('The survey has no usable coordinates to rasterise.');
    const m = fin(opts.marginM) && (opts.marginM as number) > 0 ? (opts.marginM as number) : 0;
    return { minE: minE - m, minN: minN - m, maxE: maxE + m, maxN: maxN + m };
  };

  if (opts.whole) {
    extent = stationExtent();
  } else if (outCrs && srcProj && opts.bounds) {
    extent = projectBounds(opts.bounds, outCrs);
  } else if (opts.bounds && !srcProj) {
    // No CRS anywhere: fall back to the raw extent of the stations themselves,
    // so the user still gets a raster rather than a hard failure.
    let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
    for (const p of [...d.sources, ...d.receivers]) {
      if (!fin(p.easting) || !fin(p.northing)) continue;
      minE = Math.min(minE, p.easting); maxE = Math.max(maxE, p.easting);
      minN = Math.min(minN, p.northing); maxN = Math.max(maxN, p.northing);
    }
    if (!fin(minE)) throw new Error('The survey has no usable coordinates to rasterise.');
    extent = { minE, minN, maxE, maxN };
    notes.push('Without a CRS the dragged map area could not be used; the raster covers the full extent of the stations instead.');
  } else {
    extent = stationExtent();
  }

  const g = rasterGrid({ ...extent, pixelSize: opts.pixelSize });
  const tc = tiffCRS(outCrs, opts.identifyEpsg);
  const crsDesc = tc.desc;
  if (tc.identified) {
    notes.push(`The SPS header names no EPSG code; its parameters match EPSG:${tc.identified}, which is what the GeoTIFF declares.`);
  } else if (tc.unnamed && outCrs) {
    notes.push(`Could not match ${outCrs.name || 'the survey CRS'} to an EPSG code, so the GeoTIFF marks its CRS user-defined. Some GIS software will show it as having no projection - reproject to a named CRS above if that matters.`);
  }
  const files: { name: string; bytes: Uint8Array }[] = [];
  const geo = (band: Float32Array | undefined, rgb: Uint8Array | undefined, name: string, description: string) => {
    files.push({
      name: `${base}_${name}.tif`,
      bytes: writeGeoTIFF({
        width: g.width, height: g.height, originX: g.originX, originY: g.originY,
        pixelSizeX: g.pixelSize, pixelSizeY: g.pixelSize,
        crs: crsDesc, band, rgb, nodata: GEOTIFF_NODATA, description,
      }),
    });
  };

  const want = new Set(opts.layers);

  if (want.has('fold')) {
    const { es, ns, capped } = cmpMidpoints(d, srcProj, target);
    if (!es.length) {
      notes.push('Fold map skipped: it needs X (relation) records tying sources to receivers, and none could be matched.');
    } else {
      if (capped) notes.push(`Fold map: the CMP pair walk hit its ${MAX_PAIRS.toLocaleString()} pair cap, so the fold is a lower bound in the densest bins.`);
      const band = rasterizeCounts(es, ns, g);
      const s = bandStats(band);
      geo(band, undefined, 'fold', 'CMP fold (midpoints per pixel)');
      notes.push(`Fold map: ${es.length.toLocaleString()} midpoints, maximum fold ${s.max}.`);
    }
  }

  if (want.has('elevation')) {
    const stations = stationsInOutputCRS([...d.sources, ...d.receivers], srcProj, target).filter((p) => fin(p.v)) as ValuePoint[];
    if (!stations.length) {
      notes.push('Elevation surface skipped: no station in the survey carries an elevation.');
    } else {
      // Default the search radius to a few pixels, which keeps interpolation
      // local - see the note in rasterize.ts about not inventing terrain.
      // Default from the SURVEY's own geometry: reach far enough to bridge the
      // gap between neighbouring stations along a line, and no further. Falls
      // back to a pixel-based guess only when spacing cannot be measured.
      // Measure spacing WITHIN a record class. Sources and receivers usually sit
      // at the same stations, so mixing them measures the S-to-R offset (0.5 m on
      // a production line) instead of the station interval, and the radius comes out
      // an order of magnitude too small.
      const srcPts = stationsInOutputCRS(d.sources, srcProj, target).filter((p) => fin(p.v));
      const rcvPts = stationsInOutputCRS(d.receivers, srcProj, target).filter((p) => fin(p.v));
      const perClass = [medianStationSpacing(rcvPts), medianStationSpacing(srcPts)].filter((v) => Number.isFinite(v) && v > 0);
      const spacing = perClass.length ? Math.max(...perClass) : medianStationSpacing(stations);
      const auto = isFinite(spacing) && spacing > 0 ? Math.max(spacing * 4, opts.pixelSize * 4) : opts.pixelSize * 8;
      const radius = fin(opts.demRadius) && (opts.demRadius as number) > 0 ? (opts.demRadius as number) : auto;
      const band = rasterizeIDW(stations, g, { searchRadius: radius, power: 2 });
      const s = bandStats(band);
      geo(band, undefined, 'elevation', `Station elevation, IDW within ${radius} units`);
      const pct = ((s.filled / s.total) * 100).toFixed(1);
      notes.push(`Elevation surface: ${stations.length.toLocaleString()} stations, median spacing ${Number.isFinite(spacing) ? spacing.toFixed(1) : '?'} units, search radius ${radius.toFixed(1)} - ${pct}% of pixels filled (the rest are nodata, never interpolated).`);
      // An almost-empty layer is a real outcome, not a silent one: say so and
      // name the control that changes it.
      if (s.filled / s.total < 0.05) {
        notes.push(`The elevation surface is only ${pct}% filled - raise "Elevation search radius" in the wizard if you need a fuller surface.`);
      }
    }
  }

  if (want.has('layout')) {
    const s = stationsInOutputCRS(d.sources, srcProj, target);
    const r = stationsInOutputCRS(d.receivers, srcProj, target);
    if (!s.length && !r.length) {
      notes.push('Layout image skipped: the survey has no plottable stations.');
    } else {
      // A fixed 1 px marker was invisible at fine resolutions - 377 stations
      // covered ~2 % of the image and it read as blank. Size the marker from
      // station spacing so the survey is legible at any resolution.
      const sp = Math.max(medianStationSpacing(r), medianStationSpacing(s)) || medianStationSpacing([...s, ...r]);
      const mr = isFinite(sp) && sp > 0
        ? Math.max(1, Math.min(8, Math.round(sp / g.pixelSize / 2)))
        : 1;
      const rgb = rasterizeLayout(s, r, g, { markerRadius: mr });
      geo(undefined, rgb, 'layout', 'Survey layout (sources red, receivers blue)');
      notes.push(`Layout image: ${s.length.toLocaleString()} sources, ${r.length.toLocaleString()} receivers, ${mr * 2 + 1} px markers.`);
    }
  }

  // Only complain about empty output when layers were actually asked for - a
  // basemap-only export legitimately produces nothing HERE and is completed by
  // the caller.
  if (!files.length && opts.layers.length) notes.push('No raster could be produced from this survey with the layers you chose.');

  return {
    files,
    notes,
    grid: { ...g, crsCode: outCrs?.code || '', crsName: outCrs?.name || 'unknown CRS' },
    outCrs,
    epsg: crsDesc?.epsg,
  };
}
