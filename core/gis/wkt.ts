// seisconv-core / gis - CRS to WKT1, for the .prj sidecar of a shapefile.
//
// Emits OGC WKT1 in the flavour GDAL writes (AUTHORITY tags, and TOWGS84 inside
// DATUM when a 7-parameter shift is known). That is what QGIS/GDAL produce for a
// .prj and what ArcGIS reads back, and unlike strict "ESRI WKT" it can carry the
// datum shift - which for a local grid such as ITM is the difference between the
// survey landing in the right place and being ~50 m out.
//
// Pure - no DOM, no Node. Every number is emitted with a decimal point so the
// text parses as a double in every reader.

import type { CRS } from '../sps/reproject';

/** A named reference ellipsoid, keyed for lookup by (a, 1/f). */
interface Ellipsoid {
  name: string;
  a: number;
  invF: number;
  /** EPSG ellipsoid code, when we know it. */
  code?: number;
  /** The geodetic datum most commonly paired with this ellipsoid, for naming. */
  datum?: string;
  datumCode?: number;
}

/** Ellipsoids reachable from the built-in EPSG DB plus the common survey ones. */
const ELLIPSOIDS: Ellipsoid[] = [
  { name: 'WGS 84', a: 6378137, invF: 298.257223563, code: 7030, datum: 'WGS_1984', datumCode: 6326 },
  { name: 'GRS 1980', a: 6378137, invF: 298.257222101, code: 7019, datum: 'GRS_1980', datumCode: 6019 },
  { name: 'International 1924', a: 6378388, invF: 297, code: 7022, datum: 'European_Datum_1950', datumCode: 6230 },
  { name: 'Airy 1830', a: 6377563.396, invF: 299.3249646, code: 7001, datum: 'OSGB_1936', datumCode: 6277 },
  { name: 'Bessel 1841', a: 6377397.155, invF: 299.1528128, code: 7004, datum: 'Amersfoort', datumCode: 6289 },
  { name: 'Clarke 1866', a: 6378206.4, invF: 294.9786982, code: 7008, datum: 'North_American_Datum_1927', datumCode: 6267 },
  { name: 'Clarke 1880 (RGS)', a: 6378249.145, invF: 293.465, code: 7012, datum: 'Clarke_1880_RGS' },
  { name: 'Krassowsky 1940', a: 6378245, invF: 298.3, code: 7024, datum: 'Pulkovo_1942', datumCode: 6284 },
  { name: 'WGS 72', a: 6378135, invF: 298.26, code: 7043, datum: 'WGS_1972', datumCode: 6322 },
];

const WGS84 = ELLIPSOIDS[0];

/** Format a number for WKT: always with a decimal point, no exponent. */
function num(v: number, dp = 9): string {
  if (!Number.isFinite(v)) return '0.0';
  let s = v.toFixed(dp);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '.0');
  return s.indexOf('.') >= 0 ? s : s + '.0';
}

/** Quote-safe WKT string literal (WKT1 has no escape, so quotes are stripped). */
function q(s: string): string {
  return '"' + (s || '').replace(/["\r\n]/g, '').trim() + '"';
}

/**
 * Identify the ellipsoid from its defining constants. Matching within a small
 * tolerance rather than exactly, because H12-parsed values carry only the
 * precision the SPS file printed. Unknown ellipsoids are named from their own
 * numbers rather than silently snapped to WGS 84.
 */
export function findEllipsoid(a?: number, invF?: number): Ellipsoid {
  // A SPHERE is a real, explicit definition (EPSG:3857 and the other pseudo-
  // Mercator grids are spherical on the WGS 84 radius). invF === 0 must produce a
  // sphere, never the WGS 84 ellipsoid - substituting the ellipsoid there put
  // EPSG:3857 out by ~1.1 km.
  if (invF === 0 && Number.isFinite(a) && (a as number) > 0) {
    return { name: 'Sphere', a: a as number, invF: 0 };
  }
  if (!Number.isFinite(a) || !(a as number) || !Number.isFinite(invF) || !(invF as number)) return WGS84;
  const A = a as number;
  const F = invF as number;
  // CLOSEST match, not first-within-tolerance: WGS 84 and GRS 1980 share an
  // identical semi-major axis and differ by only 1.5e-6 in 1/f, so any tolerance
  // loose enough to absorb an SPS file's printed precision also matches both. A
  // first-hit scan therefore labelled every GRS 1980 grid (ITM included) "WGS 84".
  let best: Ellipsoid | null = null;
  let bestErr = Infinity;
  for (const e of ELLIPSOIDS) {
    if (Math.abs(e.a - A) > 1 || Math.abs(e.invF - F) > 1e-3) continue; // not this ellipsoid at all
    const err = Math.abs(e.a - A) / A + Math.abs(e.invF - F) / F;
    if (err < bestErr) { bestErr = err; best = e; }
  }
  if (best) return best;
  return { name: `Unknown ellipsoid ${A.toFixed(3)} ${F.toFixed(6)}`, a: A, invF: F };
}

function spheroidWkt(e: Ellipsoid): string {
  const auth = e.code ? `,AUTHORITY["EPSG","${e.code}"]` : '';
  // WKT spells a sphere as an inverse flattening of exactly 0.
  return `SPHEROID[${q(e.name)},${num(e.a, 4)},${e.invF === 0 ? '0.0' : num(e.invF, 9)}${auth}]`;
}

/** A Helmert small enough to be noise is dropped rather than written as zeros. */
function significantHelmert(h?: CRS['helmert']): boolean {
  if (!h) return false;
  return Math.abs(h.dx) + Math.abs(h.dy) + Math.abs(h.dz) > 0.01 ||
    Math.abs(h.rx) + Math.abs(h.ry) + Math.abs(h.rz) > 1e-6 ||
    Math.abs(h.ds) > 1e-6;
}

/**
 * The datum name to put in the WKT. EPSG names a projected CRS
 * "<datum> / <projection>", so the part before the slash IS the datum - but ONLY
 * when a slash is actually present. Treating a slashless name as a datum turned
 * "ITM - Israel Transverse Mercator (New Israeli Grid)" into a datum of that same
 * unwieldy string; without the slash we fall back to the ellipsoid's usual datum.
 * Cosmetic either way: the geodetic content lives in SPHEROID + TOWGS84.
 */
function datumName(crs: CRS, e: Ellipsoid): string {
  const name = (crs.name || '').trim();
  if (name.includes('/')) {
    const before = name.split('/')[0].trim();
    if (before) return before;
  }
  return e.datum ? e.datum.replace(/_/g, ' ') : e.name;
}

function datumWkt(crs: CRS, e: Ellipsoid): string {
  const parts = [q(datumName(crs, e).replace(/\s+/g, '_')), spheroidWkt(e)];
  if (significantHelmert(crs.helmert)) {
    const h = crs.helmert!;
    parts.push(`TOWGS84[${num(h.dx, 4)},${num(h.dy, 4)},${num(h.dz, 4)},${num(h.rx, 6)},${num(h.ry, 6)},${num(h.rz, 6)},${num(h.ds, 6)}]`);
  }
  if (e.datumCode && !significantHelmert(crs.helmert)) parts.push(`AUTHORITY["EPSG","${e.datumCode}"]`);
  return `DATUM[${parts.join(',')}]`;
}

/** The geographic CRS a projected CRS is built on (or the whole thing, for GEO). */
function geogcsWkt(crs: CRS, e: Ellipsoid): string {
  const gName = crs.subtype === 'GEO' && /wgs\s*84/i.test(crs.name || '') ? 'WGS 84' : datumName(crs, e);
  const isWgs84 = e === WGS84 && !significantHelmert(crs.helmert);
  const auth = isWgs84 ? ',AUTHORITY["EPSG","4326"]' : '';
  return [
    `GEOGCS[${q(gName)}`,
    datumWkt(crs, e),
    'PRIMEM["Greenwich",0.0,AUTHORITY["EPSG","8901"]]',
    'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]]',
  ].join(',') + auth + ']';
}

/** Linear unit for the projected CRS. `factor` is metres per unit. */
function unitWkt(name?: string, factor?: number): string {
  const f = Number.isFinite(factor) && (factor as number) > 0 ? (factor as number) : 1;
  if (Math.abs(f - 1) < 1e-12) return 'UNIT["metre",1.0,AUTHORITY["EPSG","9001"]]';
  if (Math.abs(f - 0.3048) < 1e-9) return 'UNIT["foot",0.3048,AUTHORITY["EPSG","9002"]]';
  if (Math.abs(f - 0.30480060960121924) < 1e-12) return 'UNIT["US survey foot",0.304800609601219,AUTHORITY["EPSG","9003"]]';
  return `UNIT[${q(name || 'unknown')},${num(f, 12)}]`;
}

export interface WktOptions {
  /** Metres per linear unit of the projected coordinates. Defaults to 1. */
  unitFactor?: number;
  unitName?: string;
}

/**
 * Build the .prj text for a CRS.
 *
 * Returns an empty string for a CRS we cannot describe honestly (no subtype, or
 * a projection method with no WKT mapping). An absent .prj means "CRS unknown"
 * to every GIS reader, which is strictly better than writing a plausible-looking
 * projection that is not the one the coordinates are in.
 */
export function crsToWkt(crs: CRS, opts: WktOptions = {}): string {
  if (!crs) return '';
  // The CRS's own linear unit wins; the caller's opts are the fallback.
  if (crs.unitFactor != null && opts.unitFactor == null) opts = { ...opts, unitFactor: crs.unitFactor };
  const e = findEllipsoid(crs.a, crs.f ? 1 / crs.f : crs.f === 0 ? 0 : undefined);
  const sub = (crs.subtype || '').toUpperCase();
  const authority = /^EPSG:\d+$/i.test(crs.code || '') ? `,AUTHORITY["EPSG","${crs.code.split(':')[1]}"]` : '';

  if (sub === 'GEO') return geogcsWkt(crs, e) + '';

  const geogcs = geogcsWkt(crs, e);
  const unit = unitWkt(opts.unitName, opts.unitFactor);

  // Central meridian: explicit lon0 wins; a UTM zone derives its own. We always
  // emit PRIMEM Greenwich, so a grid whose lon0 is stated from Ferro / Jakarta /
  // Paris must have that offset folded in here - otherwise the WKT describes a
  // meridian up to 107 degrees away from the one the coordinates use.
  const lon0 = (crs.lon0 != null ? crs.lon0 : crs.zone != null ? crs.zone * 6 - 183 : 0) + (crs.pmOffset ?? 0);
  const lat0 = crs.lat0 != null ? crs.lat0 : 0;
  const k0 = crs.k0 != null ? crs.k0 : sub === 'UTM' ? 0.9996 : 1;
  // WKT states false easting/northing in the CRS's LINEAR UNIT, but every source
  // we read (proj4 +x_0/+y_0, SPS H232) states them in METRES. A foot-based grid
  // therefore needs the conversion, or the origin lands ~1.1 million feet out.
  const uf = Number.isFinite(opts.unitFactor) && (opts.unitFactor as number) > 0 ? (opts.unitFactor as number) : 1;
  const FE = (crs.FE != null ? crs.FE : sub === 'UTM' ? 500000 : 0) / uf;
  const FN = (crs.FN != null ? crs.FN : sub === 'UTM' && crs.hemi === 'S' ? 10000000 : 0) / uf;

  // Non-TM methods. Parameter names follow OGC WKT1 as GDAL writes them, so a
  // .prj round-trips through QGIS/ArcGIS/PROJ.
  const method = (crs.method || '').toUpperCase();
  if (method) {
    const P = (k: string, v: number, dp = 9) => `PARAMETER["${k}",${num(v, dp)}]`;
    const head = `PROJCS[${q(crs.name || crs.code || method)}`;
    const tail = (...params: string[]) =>
      [head, geogcs, ...params, unit, 'AXIS["Easting",EAST]', 'AXIS["Northing",NORTH]'].join(',') + authority + ']';

    switch (method) {
      case 'LCC': {
        // Two distinct standard parallels is the 2SP form; otherwise 1SP.
        const twoSP = crs.lat1 != null && crs.lat2 != null && Math.abs(crs.lat1 - crs.lat2) > 1e-10;
        if (twoSP) {
          return tail(
            'PROJECTION["Lambert_Conformal_Conic_2SP"]',
            P('standard_parallel_1', crs.lat1 as number), P('standard_parallel_2', crs.lat2 as number),
            P('latitude_of_origin', lat0), P('central_meridian', lon0),
            P('false_easting', FE, 4), P('false_northing', FN, 4),
          );
        }
        return tail(
          'PROJECTION["Lambert_Conformal_Conic_1SP"]',
          P('latitude_of_origin', crs.lat1 ?? lat0), P('central_meridian', lon0),
          P('scale_factor', k0, 12), P('false_easting', FE, 4), P('false_northing', FN, 4),
        );
      }
      case 'MERC': {
        if (crs.latTs != null && Math.abs(crs.latTs) > 1e-12) {
          return tail('PROJECTION["Mercator_2SP"]', P('standard_parallel_1', crs.latTs), P('central_meridian', lon0),
            P('false_easting', FE, 4), P('false_northing', FN, 4));
        }
        return tail('PROJECTION["Mercator_1SP"]', P('central_meridian', lon0), P('scale_factor', k0, 12),
          P('false_easting', FE, 4), P('false_northing', FN, 4));
      }
      case 'CASS':
        return tail('PROJECTION["Cassini_Soldner"]', P('latitude_of_origin', lat0), P('central_meridian', lon0),
          P('false_easting', FE, 4), P('false_northing', FN, 4));
      case 'AEA':
        return tail('PROJECTION["Albers_Conic_Equal_Area"]',
          P('standard_parallel_1', crs.lat1 ?? lat0), P('standard_parallel_2', crs.lat2 ?? crs.lat1 ?? lat0),
          P('latitude_of_center', lat0), P('longitude_of_center', lon0),
          P('false_easting', FE, 4), P('false_northing', FN, 4));
      case 'LAEA':
        return tail('PROJECTION["Lambert_Azimuthal_Equal_Area"]',
          P('latitude_of_center', lat0), P('longitude_of_center', lon0),
          P('false_easting', FE, 4), P('false_northing', FN, 4));
      case 'STERE':
        return tail('PROJECTION["Polar_Stereographic"]',
          P('latitude_of_origin', crs.latTs != null ? crs.latTs : lat0), P('central_meridian', lon0),
          crs.latTs != null ? P('scale_factor', 1, 12) : P('scale_factor', k0, 12),
          P('false_easting', FE, 4), P('false_northing', FN, 4));
      case 'STEREA':
        return tail('PROJECTION["Oblique_Stereographic"]', P('latitude_of_origin', lat0), P('central_meridian', lon0),
          P('scale_factor', k0, 12), P('false_easting', FE, 4), P('false_northing', FN, 4));
      default:
        return ''; // method with no WKT mapping: say nothing rather than guess
    }
  }

  if (sub === 'UTM' || sub === 'TM') {
    const name = crs.name || (sub === 'UTM' ? `UTM zone ${crs.zone ?? ''}${crs.hemi ?? ''}` : 'Transverse Mercator');
    return [
      `PROJCS[${q(name)}`,
      geogcs,
      'PROJECTION["Transverse_Mercator"]',
      `PARAMETER["latitude_of_origin",${num(lat0)}]`,
      `PARAMETER["central_meridian",${num(lon0)}]`,
      `PARAMETER["scale_factor",${num(k0, 12)}]`,
      `PARAMETER["false_easting",${num(FE, 4)}]`,
      `PARAMETER["false_northing",${num(FN, 4)}]`,
      unit,
      'AXIS["Easting",EAST]',
      'AXIS["Northing",NORTH]',
    ].join(',') + authority + ']';
  }

  // No WKT mapping for this projection method: say nothing rather than guess.
  return '';
}
