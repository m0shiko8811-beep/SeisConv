// seisconv-core / gis - turn a parsed SPS survey into shapefile layers.
//
// Produces two point layers, `<base>_sources` (S records) and `<base>_receivers`
// (R records), each a full .shp/.shx/.dbf/.prj/.cpg set. X (relation) records
// carry no geometry and are not exported here.
//
// Coordinates go out in ONE of two ways:
//   native  - easting/northing copied through untouched, .prj describing the CRS
//             read from the file's own H-records. No arithmetic, so no way to
//             introduce error. This is the default.
//   target  - reprojected through the shared coords engine to a chosen CRS.
//             Only offered for CRSs that engine can actually compute.
//
// Pure - no DOM, no Node, no Date.

import { projToLatLon, type Projection } from '../coords';
import type { SPSData, SPSPoint, SPSProjection } from '../sps/parse';
import { extraProjFields, lonLatToProj, type CRS } from '../sps/reproject';
import { crsToWkt } from './wkt';
import { writeShapefile, type DbfField, type DbfValue, type ShapePoint, type ShapefileOut } from './shapefile';

/** Attribute columns, in output order. Names are dBASE-legal (<=10 chars). */
const FIELDS: DbfField[] = [
  { name: 'RECTYPE', type: 'C', length: 1 },
  { name: 'LINE', type: 'C', length: 16 },
  { name: 'STATION', type: 'N', length: 12, decimals: 2 },
  { name: 'POINT_IDX', type: 'C', length: 4 },
  { name: 'EASTING', type: 'N', length: 18, decimals: 3 },
  { name: 'NORTHING', type: 'N', length: 18, decimals: 3 },
  { name: 'ELEV', type: 'N', length: 12, decimals: 3 },
  { name: 'LAT', type: 'N', length: 14, decimals: 9 },
  { name: 'LON', type: 'N', length: 14, decimals: 9 },
  { name: 'SRC_TYPE', type: 'C', length: 8 },
  { name: 'UPHOLE_MS', type: 'N', length: 10, decimals: 2 },
  { name: 'STATIC_MS', type: 'N', length: 10, decimals: 2 },
  { name: 'FFID', type: 'N', length: 12, decimals: 0 },
  // In SPS 2.1 this field is the DAY OF YEAR (cols 72-74), not a calendar date;
  // legacy layouts put a date-like string there. Named for what it holds.
  { name: 'SPS_DOY', type: 'C', length: 10 },
  { name: 'SPS_TIME', type: 'C', length: 10 },
];

export interface SpsShapeOptions {
  /** File-name stem; `_sources` / `_receivers` are appended. */
  baseName?: string;
  /** Reproject to this CRS instead of writing the survey's native coordinates. */
  target?: CRS | null;
  /** Header date for the .dbf, as [year, month, day]. */
  dateYMD?: [number, number, number];
}

export interface SpsShapeResult {
  files: ShapefileOut[];
  /** Human-readable notes to surface in the UI (never silent). */
  notes: string[];
  sourceCount: number;
  receiverCount: number;
}

/**
 * Bridge the parser's {@link SPSProjection} to the {@link CRS} shape the WKT and
 * reprojection code use. Mirrors write.ts' private crsFromProjection; kept here
 * so the GIS layer does not reach into the SPS writer.
 */
export function crsFromSPSProjection(p: SPSProjection | undefined): CRS | null {
  if (!p || !p.type) return null;
  const epsg = (p.desc || '').match(/EPSG:\d+/i);
  return {
    code: epsg ? epsg[0].toUpperCase() : '',
    name: p.desc || p.type || p.datum || 'Custom',
    subtype: p.subtype || p.type || 'TM',
    zone: p.zone ?? undefined,
    hemi: p.hemi ?? undefined,
    a: p.a ?? undefined,
    f: p.invF ? 1 / p.invF : undefined,
    lon0: p.centralMeridian ?? undefined,
    lat0: p.latOrigin ?? undefined,
    k0: p.scaleFactor ?? undefined,
    FE: p.falseEasting ?? undefined,
    FN: p.falseNorthing ?? undefined,
    helmert: p.helmert ?? undefined,
  };
}

/** The SPSProjection, in the shape projToLatLon reads. */
function toProjection(p: SPSProjection): Projection {
  return {
    subtype: p.subtype ?? undefined,
    zone: p.zone ?? undefined,
    hemi: p.hemi ?? undefined,
    a: p.a ?? undefined,
    invF: p.invF ?? undefined,
    centralMeridian: p.centralMeridian ?? undefined,
    latOrigin: p.latOrigin ?? undefined,
    scaleFactor: p.scaleFactor ?? undefined,
    falseEasting: p.falseEasting ?? undefined,
    falseNorthing: p.falseNorthing ?? undefined,
    helmert: p.helmert ?? undefined,
  };
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Trim to printable ASCII-ish text for an attribute cell. */
function txt(v: unknown): string {
  return String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * Build one layer's geometry + attribute rows. `xform` maps a point's native
 * easting/northing to the OUTPUT coordinates, and also yields WGS84 lat/lon for
 * the LAT/LON columns when it can be determined; both may be non-finite, which
 * the writer degrades to a NULL shape / blank cell rather than dropping the row.
 */
function layerRows(pts: SPSPoint[], xform: (p: SPSPoint) => { E: number; N: number; lat: number; lon: number }): { points: ShapePoint[]; rows: DbfValue[][] } {
  const points: ShapePoint[] = [];
  const rows: DbfValue[][] = [];
  for (const p of pts) {
    const t = xform(p);
    points.push({ x: t.E, y: t.N, z: fin(p.elevation) ? p.elevation : 0 });
    rows.push([
      p.rtype,
      txt(p.lineName),
      fin(p.point) ? p.point : null,
      txt(p.idx),
      fin(t.E) ? t.E : null,
      fin(t.N) ? t.N : null,
      fin(p.elevation) ? p.elevation : null,
      fin(t.lat) ? t.lat : null,
      fin(t.lon) ? t.lon : null,
      txt(p.srcType),
      fin(p.upholeMs) ? p.upholeMs : null,
      fin(p.staticMs) ? p.staticMs : null,
      fin(p.ffid) ? p.ffid : null,
      txt(p.date),
      txt(p.time),
    ]);
  }
  return { points, rows };
}

/**
 * Build the shapefile set for a loaded survey.
 *
 * Never throws on survey content: a missing CRS, an unprojectable point, or an
 * empty record class each produce a NOTE plus degraded-but-valid output. It
 * throws only when the caller asks for something impossible (a layer over the
 * record cap), which the writer surfaces.
 */
export function buildSPSShapefiles(d: SPSData, opts: SpsShapeOptions = {}): SpsShapeResult {
  const notes: string[] = [];
  const base = (opts.baseName || 'survey').replace(/[^A-Za-z0-9_.-]/g, '_') || 'survey';
  const nativeProj = d.projection && d.projection.type ? d.projection : undefined;
  const nativeCrs = crsFromSPSProjection(d.projection);
  const target = opts.target || null;

  if (!nativeProj) {
    notes.push('The SPS header carries no projection, so the coordinates are written as raw easting/northing with NO .prj. Set the CRS in the Header Editor to get a georeferenced shapefile.');
  }

  // Reprojection needs a KNOWN source CRS. Without one there is nothing to
  // convert from, so we refuse and fall back to native rather than assuming a
  // default grid and silently moving the survey.
  let outCrs: CRS | null = nativeCrs;
  let reproject = false;
  if (target) {
    if (!nativeProj) {
      notes.push(`Cannot reproject to ${target.code || target.name}: the source CRS is unknown. Wrote native coordinates instead.`);
    } else {
      outCrs = target;
      reproject = true;
    }
  }

  const srcProjection = nativeProj ? toProjection(nativeProj) : undefined;
  const xform = (p: SPSPoint): { E: number; N: number; lat: number; lon: number } => {
    const e = fin(p.easting) ? p.easting : NaN;
    const n = fin(p.northing) ? p.northing : NaN;
    // Geographic coordinates carried directly by the record win over anything
    // we could re-derive from E/N.
    let lat = fin(p.lat) ? (p.lat as number) : NaN;
    let lon = fin(p.lon) ? (p.lon as number) : NaN;
    if ((!fin(lat) || !fin(lon)) && srcProjection && fin(e) && fin(n)) {
      const ll = projToLatLon(e, n, srcProjection, fin(p.elevation) ? p.elevation : 0);
      lat = ll.lat;
      lon = ll.lon;
    }
    if (!reproject || !target) return { E: e, N: n, lat, lon };
    if (!fin(lat) || !fin(lon)) return { E: NaN, N: NaN, lat, lon };
    const en = lonLatToProj(lat, lon, target, fin(p.elevation) ? p.elevation : 0);
    return { E: en.E, N: en.N, lat, lon };
  };

  const prj = outCrs ? crsToWkt(outCrs) : '';
  if (outCrs && !prj) {
    notes.push(`No WKT mapping exists for ${outCrs.code || outCrs.name}, so no .prj was written. The .shp coordinates are still correct; set the CRS manually in your GIS.`);
  }

  const files: ShapefileOut[] = [];
  const mk = (suffix: string, pts: SPSPoint[]) => {
    if (!pts.length) return;
    const { points, rows } = layerRows(pts, xform);
    files.push(...writeShapefile({ name: `${base}_${suffix}`, points, rows, fields: FIELDS, prj, hasZ: true, dateYMD: opts.dateYMD }));
  };
  mk('sources', d.sources);
  mk('receivers', d.receivers);

  if (!d.sources.length && !d.receivers.length) notes.push('No S or R records in the loaded survey - nothing to export.');
  if (d.xrefs.length) notes.push(`${d.xrefs.length} relation (X) record${d.xrefs.length === 1 ? '' : 's'} were not exported: X records carry no geometry.`);
  if (reproject && target) notes.push(`Reprojected to ${target.code || target.name}.`);

  return { files, notes, sourceCount: d.sources.length, receiverCount: d.receivers.length };
}
