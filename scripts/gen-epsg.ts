// Build script: distil the EPSG registry into the compact table SeisConv ships.
//
//   npx tsx scripts/gen-epsg.ts
//
// Reads the `epsg-index` dev dependency (a snapshot of the IOGP EPSG Geodetic
// Parameter Dataset) and writes `core/sps/epsg-registry.json`, keeping ONLY what
// the app needs: code, name, projection method, its parameters, the datum shift,
// and the linear unit. The official WKT strings are dropped - they are ~85 % of
// the source file's 8 MB and we regenerate equivalent WKT from these parameters.
//
// The output is COMMITTED, so the app needs no network and no runtime dependency
// on epsg-index. Re-run this when you want to refresh against a newer EPSG
// release. EPSG data is (c) IOGP, redistributable with attribution - see the
// attribution note in README / Help > About.

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const all = require('epsg-index/all.json') as Record<string, { code: string; kind: string; name: string; proj4?: string; wkt?: string; bbox?: number[]; unit?: string; area?: string; accuracy?: number }>;

/** proj4 `+proj=` name -> the method id our coords engine dispatches on. */
const METHOD_BY_PROJ: Record<string, string> = {
  tmerc: 'TM',
  utm: 'UTM',
  longlat: 'GEO',
  lcc: 'LCC',
  merc: 'MERC',
  cass: 'CASS',
  aea: 'AEA',
  stere: 'STERE',
  sterea: 'STEREA',
  laea: 'LAEA',
  geocent: 'GEOCENT',
};

/** Parse a proj4 string into a flat key/value map (`+k=v` and bare `+flag`). */
function parseProj4(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of (s || '').trim().split(/\s+/)) {
    if (!tok.startsWith('+')) continue;
    const eq = tok.indexOf('=');
    if (eq < 0) out[tok.slice(1)] = '';
    else out[tok.slice(1, eq)] = tok.slice(eq + 1);
  }
  return out;
}

const num = (v: string | undefined): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

export interface RegistryRow {
  c: string;   // EPSG code, numeric string
  n: string;   // name
  m: string;   // method id (TM/UTM/GEO/LCC/...) or the raw +proj= when unmapped
  a?: number;  // semi-major axis
  rf?: number; // inverse flattening (0 => sphere)
  lat0?: number;
  lon0?: number;
  lat1?: number;
  lat2?: number;
  /** Latitude of true scale (+lat_ts): Mercator/Stereographic "variant B". */
  lts?: number;
  k0?: number;
  x0?: number;
  y0?: number;
  /** Prime-meridian offset from Greenwich, degrees. Grids defined from Ferro /
   *  Jakarta / Paris state lon0 relative to THAT meridian, so without this the
   *  central meridian is out by up to 107 degrees. */
  pm?: number;
  /** Non-standard axis directions (proj4 `+axis=`, e.g. 'wsu' = west/south/up).
   *  Such a CRS has no easting and no northing - its numbers run the other way -
   *  so SPS output is refused for it rather than silently sign-flipped. */
  ax?: string;
  z?: number;  // UTM zone
  s?: 1;       // southern-hemisphere UTM
  t?: number[];// towgs84, 3 or 7 params
  u?: number;  // metres per linear unit (omitted when 1)
  d?: 1;       // deprecated
  /** No resolvable ellipsoid: the CRS cannot be computed and must be refused. */
  noEll?: 1;
  /** Its datum tie to WGS 84 is an NTv2 / NADCON GRID file, not a 7-parameter
   *  Helmert. We do not read grid files, so reprojecting to or from this CRS
   *  would be tens to hundreds of metres out; it is flagged and refused. */
  gs?: 1;
}

// Ellipsoid names proj4 uses, resolved to their defining constants. proj4 strings
// in this dataset mostly carry explicit +a/+rf, but +ellps= appears too.
// Every +ellps= name that appears in this dataset, as [semi-major, 1/f]. An
// inverse flattening of 0 marks a sphere. An UNRESOLVED name must never fall
// back to WGS 84: doing so silently reprojects onto the wrong figure of the
// Earth (Kertau 1968 / Johor Grid, +ellps=evrst48, came out ~485 m off that
// way). Unresolved rows are emitted WITHOUT a/rf and flagged unsupported.
const ELLPS: Record<string, [number, number]> = {
  WGS84: [6378137, 298.257223563],
  GRS80: [6378137, 298.257222101],
  intl: [6378388, 297],
  airy: [6377563.396, 299.3249646],
  bessel: [6377397.155, 299.1528128],
  clrk66: [6378206.4, 294.9786982],
  clrk80: [6378249.145, 293.465],
  'clrk80ign': [6378249.2, 293.4660212936269],
  krass: [6378245, 298.3],
  WGS72: [6378135, 298.26],
  GRS67: [6378160, 298.247167427],
  helmert: [6378200, 298.3],
  mod_airy: [6377340.189, 299.3249646],
  GSK2011: [6378136.5, 298.2564151],
  aust_SA: [6378160, 298.25],
  IAU76: [6378140, 298.257],
  evrst30: [6377276.345, 300.8017],
  evrst48: [6377304.063, 300.8017],
  evrst56: [6377301.243, 300.8017],
  evrst69: [6377295.664, 300.8017],
  evrstSS: [6377298.556, 300.8017],
  bess_nam: [6377483.865, 299.1528128],
  NWL9D: [6378145, 298.25],
  hough: [6378270, 297],
  fschr60: [6378166, 298.3],
  fschr60m: [6378155, 298.3],
  fschr68: [6378150, 298.3],
  walbeck: [6376896, 302.78],
  sphere: [6370997, 0],
  SEasia: [6378155, 298.3],
  andrae: [6377104.43, 300],
  engelis: [6378136.05, 298.2566],
  new_intl: [6378157.5, 298.2496154],
  plessis: [6376523, 308.641],
  CPM: [6375738.7, 334.29],
  delmbr: [6376428, 311.5],
  kaula: [6378163, 298.24],
  lerch: [6378139, 298.257],
  mprts: [6397300, 191],
  WGS60: [6378165, 298.3],
  WGS66: [6378145, 298.25],
};

/** +datum= implies an ellipsoid when +ellps= is absent. */
const DATUM_ELLPS: Record<string, [number, number]> = {
  WGS84: [6378137, 298.257223563],
  NAD83: [6378137, 298.257222101],
  NAD27: [6378206.4, 294.9786982],
  GGRS87: [6378137, 298.257222101],
  potsdam: [6377397.155, 299.1528128],
  carthage: [6378249.2, 293.4660212936269],
  hermannskogel: [6377397.155, 299.1528128],
  ire65: [6377340.189, 299.3249646],
  nzgd49: [6378388, 297],
  OSGB36: [6377563.396, 299.3249646],
};

const rows: RegistryRow[] = [];
const skipped: Record<string, number> = {};
const unresolved: string[] = [];

for (const key of Object.keys(all)) {
  const e = all[key];
  // Only CRSs a survey's coordinates can actually be in: projected + geographic
  // 2-D. Vertical / compound / engineering / geocentric CRSs have no place in a
  // "reproject this survey to" list.
  if (e.kind !== 'CRS-PROJCRS' && e.kind !== 'CRS-GEOGCRS') continue;
  if (!e.proj4) { skipped.noproj4 = (skipped.noproj4 || 0) + 1; continue; }

  const p = parseProj4(e.proj4);
  const projName = p.proj || '';
  const method = METHOD_BY_PROJ[projName] || projName.toUpperCase();
  if (!METHOD_BY_PROJ[projName]) skipped[projName] = (skipped[projName] || 0) + 1;

  const row: RegistryRow = { c: String(e.code), n: e.name, m: method };

  let a = num(p.a);
  let rf = num(p.rf);
  if ((a == null || rf == null) && p.ellps && ELLPS[p.ellps]) {
    a = a ?? ELLPS[p.ellps][0];
    rf = rf ?? ELLPS[p.ellps][1];
  }
  if ((a == null || rf == null) && p.datum && DATUM_ELLPS[p.datum]) {
    a = a ?? DATUM_ELLPS[p.datum][0];
    rf = rf ?? DATUM_ELLPS[p.datum][1];
  }
  const b = num(p.b);
  if (a != null && rf == null && b != null) rf = a === b ? 0 : a / (a - b); // +b given instead of +rf
  if (a != null && rf == null && p.R) { a = num(p.R) ?? a; rf = 0; }        // sphere of radius R
  if (a == null && p.R) { a = num(p.R); rf = 0; }
  if (a != null) row.a = a;
  if (rf != null) row.rf = rf;
  // No resolvable figure of the Earth => the CRS is unusable. Flag it rather than
  // let paramsFrom() quietly substitute WGS 84.
  if (a == null || rf == null) { row.noEll = 1; unresolved.push(`${e.code} ${e.name} [${p.ellps || p.datum || 'no ellipsoid'}]`); }

  if (projName === 'utm') {
    const z = num(p.zone);
    if (z != null) row.z = z;
    if ('south' in p) row.s = 1;
  } else {
    const lat0 = num(p.lat_0), lon0 = num(p.lon_0), lat1 = num(p.lat_1), lat2 = num(p.lat_2);
    const lts = num(p.lat_ts);
    const k0 = num(p.k_0) ?? num(p.k), x0 = num(p.x_0), y0 = num(p.y_0);
    if (lat0 != null) row.lat0 = lat0;
    if (lon0 != null) row.lon0 = lon0;
    if (lat1 != null) row.lat1 = lat1;
    if (lat2 != null) row.lat2 = lat2;
    if (lts != null) row.lts = lts;
    if (k0 != null) row.k0 = k0;
    if (x0 != null) row.x0 = x0;
    if (y0 != null) row.y0 = y0;
  }

  // Axis directions. proj4 records the reversed ones as `+axis=wsu` / `swu`.
  // Two historic Austrian Cassini grids carry the reversal in their EPSG
  // definition but NOT in their proj4 string, so they are named explicitly
  // (verified against PROJ: both report Southing/Westing axes).
  const AXIS_REVERSED_NO_PROJ4 = new Set(['8044', '8045']);
  const axm = /\+axis=(\w+)/.exec(e.proj4);
  if (axm && axm[1] !== 'enu') row.ax = axm[1];
  else if (AXIS_REVERSED_NO_PROJ4.has(String(e.code))) row.ax = 'wsu';

  // Named prime meridians PROJ recognises, in degrees east of Greenwich.
  const PM: Record<string, number> = {
    greenwich: 0, lisbon: -9.131906111111, paris: 2.337229166667, bogota: -74.08091666667,
    madrid: -3.687938888889, rome: 12.45233333333, bern: 7.439583333333, jakarta: 106.8077194444,
    ferro: -17.66666666667, brussels: 4.367975, stockholm: 18.05827777778, athens: 23.7163375,
    oslo: 10.72291666667,
  };
  if (p.pm) {
    const off = p.pm in PM ? PM[p.pm] : num(p.pm);
    if (off != null && Math.abs(off) > 1e-12) row.pm = off;
  }

  const ng = p.nadgrids;
  if (ng && ng !== '@null') row.gs = 1;

  if (p.towgs84) {
    const t = p.towgs84.split(',').map((v) => parseFloat(v));
    if (t.every((v) => Number.isFinite(v)) && (t.length === 3 || t.length === 7)) row.t = t;
  }

  // Linear unit: metres per unit. Recorded only when it is NOT metres, because
  // a foot-based grid's numbers are meaningless without it.
  const UNITS: Record<string, number> = {
    m: 1, ft: 0.3048, 'us-ft': 0.30480060960121924, 'ind-ft': 0.30479841, link: 0.201168,
    'us-ch': 20.11684023368047, 'ind-yd': 0.9143985307444408, fath: 1.8288, kmi: 1852, 'us-mi': 1609.3472186944375,
  };
  const uni = p.units ? UNITS[p.units] : p.to_meter ? num(p.to_meter) : undefined;
  if (uni != null && Math.abs(uni - 1) > 1e-12) row.u = uni;

  if (/deprecated/i.test(e.name)) row.d = 1;

  rows.push(row);
}

rows.sort((x, y) => Number(x.c) - Number(y.c));

const outPath = new URL('../core/sps/epsg-registry.json', import.meta.url);
writeFileSync(outPath, JSON.stringify({ generated: 'epsg-index', count: rows.length, rows }));

const byMethod: Record<string, number> = {};
for (const r of rows) byMethod[r.m] = (byMethod[r.m] || 0) + 1;
console.log(`wrote ${rows.length} CRSs`);
console.log('by method:', Object.entries(byMethod).sort((a, b) => b[1] - a[1]).slice(0, 15));
console.log('unmapped proj4 methods (kept, flagged unsupported):', Object.entries(skipped).sort((a, b) => b[1] - a[1]).slice(0, 12));
console.log(`CRSs with NO resolvable ellipsoid (flagged unusable): ${unresolved.length}`);
if (unresolved.length) console.log('  e.g.', unresolved.slice(0, 6));
