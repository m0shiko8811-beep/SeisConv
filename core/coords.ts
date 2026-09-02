// seisconv-core - coordinate conversion engine
//
// Forward + inverse Transverse Mercator, UTM, and 7-parameter Helmert datum
// transforms. Ported verbatim from the SeisConv reference. Pure math, no DOM
// (the reference's one DOM tie - guessUTMZone reading an <input> - is dropped).
//
// This is a SUPERSET of app/src/services/calculations.ts (which has only forward
// UTM + forward ITM). Consolidation onto this module is a later step; for now the
// ITM helpers below are kept numerically identical to calculations.ts so the two
// can be cross-checked (see the coord regression test).

import { EXTRA_METHODS, paramsFrom, projectForward, projectInverse, type ProjParams } from './projections';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const ARC2R = Math.PI / (180 * 3600);

export interface LatLon {
  lat: number;
  lon: number;
}
export interface EN {
  E: number;
  N: number;
}
/** 7-parameter Helmert (SPS H14 / EPSG-1192 convention). Translations in metres,
 * rotations in arc-seconds, scale `ds` in ppm. */
export interface HelmertParams {
  dx: number;
  dy: number;
  dz: number;
  rx: number;
  ry: number;
  rz: number;
  ds: number;
}
/** Transverse Mercator parameters. Angles in degrees. */
export interface TMParams {
  a: number;
  f: number;
  lon0: number;
  lat0: number;
  k0: number;
  FE: number;
  FN: number;
}
/** A projection descriptor as produced by SPS detection / the EPSG database. */
export interface Projection {
  subtype?: string;
  /**
   * Projection METHOD when it is not a Transverse Mercator: 'LCC', 'MERC',
   * 'CASS', 'AEA', 'LAEA', 'STERE', 'STEREA' (see ./projections). When set and
   * recognised it takes precedence over `subtype`; TM/UTM/GEO stay on the
   * original code path so nothing about existing surveys changes.
   */
  method?: string;
  /** Second standard parallel / latitude of true scale, for the conic and
   *  Mercator/Stereographic "variant B" methods. */
  lat1?: number;
  lat2?: number;
  latTs?: number;
  /** Prime-meridian offset from Greenwich in degrees (Ferro, Jakarta, Paris...).
   *  Added to the central meridian, which is stated relative to that meridian. */
  pmOffset?: number;
  /** Metres per linear unit of the PROJECTED coordinates (feet grids etc.).
   *  Defaults to 1. Applied outside the projection maths, which is metric. */
  unitFactor?: number;
  zone?: number;
  hemi?: 'N' | 'S';
  a?: number;
  f?: number;
  invF?: number;
  centralMeridian?: number;
  latOrigin?: number;
  scaleFactor?: number;
  falseEasting?: number;
  falseNorthing?: number;
  helmert?: HelmertParams;
  // forward-direction param names (latLonToProj / EPSG DB entries)
  lon0?: number;
  lat0?: number;
  k0?: number;
  FE?: number;
  FN?: number;
}

/** Meridional arc length for latitude `phi` (radians). */
export function meridionalArc(phi: number, a: number, e2: number): number {
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  return (
    a *
    ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi))
  );
}

/** Forward Transverse Mercator: geodetic (degrees) → projected (E, N). */
export function geodeticToTM(lat_deg: number, lon_deg: number, p: TMParams): EN {
  const lat = lat_deg * D2R;
  const lon = lon_deg * D2R;
  const lon0r = p.lon0 * D2R;
  const lat0r = p.lat0 * D2R;
  const e2 = 2 * p.f - p.f * p.f;
  const ep2 = e2 / (1 - e2);
  const Nv = p.a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const T = Math.tan(lat) ** 2;
  const Cv = ep2 * Math.cos(lat) ** 2;
  const A = (lon - lon0r) * Math.cos(lat);
  const M = meridionalArc(lat, p.a, e2);
  const M0 = meridionalArc(lat0r, p.a, e2);
  return {
    E: p.FE + p.k0 * Nv * (A + ((1 - T + Cv) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * Cv - 58 * ep2) * A ** 5) / 120),
    N:
      p.FN +
      p.k0 *
        (M - M0 + Nv * Math.tan(lat) * ((A * A) / 2 + ((5 - T + 9 * Cv + 4 * Cv * Cv) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * Cv - 330 * ep2) * A ** 6) / 720)),
  };
}

/** Inverse Transverse Mercator: projected (E, N) → geodetic (degrees). */
export function tmToGeodetic(E: number, N: number, params: TMParams): LatLon {
  const { a, f, lon0, lat0, k0, FE, FN } = params;
  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const lon0r = lon0 * D2R;
  const lat0r = lat0 * D2R;
  const M0 = meridionalArc(lat0r, a, e2);
  const M = M0 + (N - FN) / k0;
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const s1 = Math.sin(phi1);
  const c1 = Math.cos(phi1);
  const t1 = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * s1 * s1);
  const T1 = t1 * t1;
  const C1 = ep2 * c1 * c1;
  const R1 = (a * (1 - e2)) / (1 - e2 * s1 * s1) ** 1.5;
  const D = (E - FE) / (N1 * k0);
  const D2 = D * D;
  const lat =
    phi1 -
    (N1 * t1 / R1) *
      (D2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D2 * D2) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D2 * D2 * D2) / 720);
  const lon = lon0r + (D - ((1 + 2 * T1 + C1) * D2 * D) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D2 * D2 * D) / 120) / c1;
  return { lat: lat * R2D, lon: lon * R2D };
}

/** Forward UTM (WGS84). */
export function latLonToUTM(lat_deg: number, lon_deg: number, zone: number, hemi: 'N' | 'S'): EN {
  return geodeticToTM(lat_deg, lon_deg, {
    a: 6378137,
    f: 1 / 298.257223563,
    lon0: zone * 6 - 183,
    lat0: 0,
    k0: 0.9996,
    FE: 500000,
    FN: hemi === 'S' ? 10000000 : 0,
  });
}

/** Inverse UTM (WGS84). */
export function utmToLatLon(E: number, N: number, zone: number, hemi: 'N' | 'S'): LatLon {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const b = a * (1 - f);
  const e2 = 1 - (b / a) ** 2;
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;
  const E0 = 500000;
  const lon0 = (zone * 6 - 183) * D2R;
  const M = N / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sinP = Math.sin(phi1);
  const cosP = Math.cos(phi1);
  const tanP = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * sinP ** 2);
  const T1 = tanP ** 2;
  const C1 = ep2 * cosP ** 2;
  const R1 = (a * (1 - e2)) / (1 - e2 * sinP ** 2) ** 1.5;
  const D = (E - E0) / (N1 * k0);
  const lat = phi1 - (N1 * tanP / R1) * (D ** 2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720);
  const lon = lon0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120) / cosP;
  return { lat: lat * R2D, lon: lon * R2D };
}

/** 7-parameter Helmert: geodetic on a source datum → WGS84 lat/lon (degrees).
 * Position-vector convention (PROJ4 towgs84 / EPSG-1192 / SPS H14). */
export function helmert7ToWGS84(lat_deg: number, lon_deg: number, h: number, a_src: number, f_src: number, hP: HelmertParams): LatLon {
  const e2 = 2 * f_src - f_src * f_src;
  const lat = lat_deg * D2R;
  const lon = lon_deg * D2R;
  const Nc = a_src / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const X1 = (Nc + h) * Math.cos(lat) * Math.cos(lon);
  const Y1 = (Nc + h) * Math.cos(lat) * Math.sin(lon);
  const Z1 = (Nc * (1 - e2) + h) * Math.sin(lat);
  const rx = hP.rx * ARC2R;
  const ry = hP.ry * ARC2R;
  const rz = hP.rz * ARC2R;
  const m = 1 + hP.ds * 1e-6;
  const X2 = hP.dx + m * (X1 - rz * Y1 + ry * Z1);
  const Y2 = hP.dy + m * (rz * X1 + Y1 - rx * Z1);
  const Z2 = hP.dz + m * (-ry * X1 + rx * Y1 + Z1);
  // WGS84 geocentric → geodetic (iterative)
  const aW = 6378137;
  const fW = 1 / 298.257223563;
  const e2W = 2 * fW - fW * fW;
  const lonW = Math.atan2(Y2, X2);
  const p = Math.sqrt(X2 * X2 + Y2 * Y2);
  let latW = Math.atan2(Z2, p * (1 - e2W));
  for (let i = 0; i < 10; i++) {
    const NW = aW / Math.sqrt(1 - e2W * Math.sin(latW) ** 2);
    latW = Math.atan2(Z2 + e2W * NW * Math.sin(latW), p);
  }
  return { lat: latW * R2D, lon: lonW * R2D };
}

/** WGS84 → local datum (inverse Helmert). `hP` is the LOCAL→WGS84 params (SPS H14 direction). */
export function wgs84ToLocal(lat_deg: number, lon_deg: number, h_m: number, a_dst: number, f_dst: number, hP: HelmertParams): LatLon {
  const aW = 6378137;
  const fW = 1 / 298.257223563;
  const e2W = 2 * fW - fW * fW;
  const lat = lat_deg * D2R;
  const lon = lon_deg * D2R;
  const NW = aW / Math.sqrt(1 - e2W * Math.sin(lat) ** 2);
  const X2 = (NW + h_m) * Math.cos(lat) * Math.cos(lon);
  const Y2 = (NW + h_m) * Math.cos(lat) * Math.sin(lon);
  const Z2 = (NW * (1 - e2W) + h_m) * Math.sin(lat);
  const rx = hP.rx * ARC2R;
  const ry = hP.ry * ARC2R;
  const rz = hP.rz * ARC2R;
  const m = 1 + hP.ds * 1e-6;
  const X1 = ((X2 - hP.dx) + rz * (Y2 - hP.dy) - ry * (Z2 - hP.dz)) / m;
  const Y1 = (-rz * (X2 - hP.dx) + (Y2 - hP.dy) + rx * (Z2 - hP.dz)) / m;
  const Z1 = (ry * (X2 - hP.dx) - rx * (Y2 - hP.dy) + (Z2 - hP.dz)) / m;
  const e2d = 2 * f_dst - f_dst * f_dst;
  const lonD = Math.atan2(Y1, X1);
  const p = Math.sqrt(X1 * X1 + Y1 * Y1);
  let latD = Math.atan2(Z1, p * (1 - e2d));
  for (let i = 0; i < 10; i++) {
    const Nd = a_dst / Math.sqrt(1 - e2d * Math.sin(latD) ** 2);
    latD = Math.atan2(Z1 + e2d * Nd * Math.sin(latD), p);
  }
  return { lat: latD * R2D, lon: lonD * R2D };
}

/**
 * Build the {@link ProjParams} the extra-method engine takes from a Projection.
 * Returns null when `proj` does not name a method that engine implements, which
 * is the signal to stay on the Transverse Mercator path below.
 */
function extraParams(proj?: Projection): ProjParams | null {
  const m = proj?.method;
  if (!m || !(EXTRA_METHODS as readonly string[]).includes(m)) return null;
  const a = proj.a || 6378137;
  // A flattening of exactly 0 means a SPHERE (EPSG:3857 and the other pseudo-
  // Mercator grids), which is NOT the same as "unspecified": a truthiness test
  // here treated the sphere as absent and silently used the WGS 84 ellipsoid,
  // putting EPSG:3857 ~1.1 km out. Only an absent value falls back.
  const rf = proj.invF != null ? proj.invF : proj.f != null ? (proj.f === 0 ? 0 : 1 / proj.f) : 298.257223563;
  return paramsFrom(a, rf, {
    lat0: proj.lat0 ?? proj.latOrigin ?? 0,
    lon0: (proj.lon0 ?? proj.centralMeridian ?? 0) + (proj.pmOffset ?? 0),
    lat1: proj.lat1,
    lat2: proj.lat2,
    latTs: proj.latTs,
    k0: proj.k0 ?? proj.scaleFactor ?? 1,
    FE: proj.FE ?? proj.falseEasting ?? 0,
    FN: proj.FN ?? proj.falseNorthing ?? 0,
  });
}

/** Metres per linear unit of the projected coordinates (1 unless a feet grid). */
function unitOf(proj?: Projection): number {
  const u = proj?.unitFactor;
  return Number.isFinite(u) && (u as number) > 0 ? (u as number) : 1;
}

/**
 * First finite value among a projection's two spellings of the same parameter,
 * else the default.
 *
 * NOT `a || b || d`: a legitimate 0 (a Greenwich central meridian, a zero false
 * easting) must survive, and `||` would discard it.
 */
function tmParam(primary: number | undefined, alt: number | undefined, dflt: number): number {
  if (typeof primary === 'number' && Number.isFinite(primary)) return primary;
  if (typeof alt === 'number' && Number.isFinite(alt)) return alt;
  return dflt;
}

/** Projected (E, N) → WGS84 lat/lon, using a detected projection descriptor. */
export function projToLatLon(E: number, N: number, proj?: Projection, elevM?: number): LatLon {
  const h = elevM || 0;

  // Non-TM projection methods (Lambert, Mercator, Albers, Stereographic...).
  const xp = extraParams(proj);
  if (xp) {
    const u = unitOf(proj);
    const geodetic = projectInverse(proj!.method as string, E * u, N * u, xp);
    if (proj!.helmert) return helmert7ToWGS84(geodetic.lat, geodetic.lon, h, xp.a, xp.e2 ? 1 - Math.sqrt(1 - xp.e2) : 0, proj!.helmert);
    return geodetic;
  }

  const sub = (proj && proj.subtype) || 'UTM';
  if (sub === 'UTM') {
    return utmToLatLon(E, N, proj ? proj.zone || 36 : 36, proj ? proj.hemi || 'N' : 'N');
  }
  const a = (proj && proj.a) || 6378137;
  // A Projection reaches here under EITHER naming convention: the SPS parser fills
  // centralMeridian/latOrigin/scaleFactor/falseEasting/falseNorthing/invF, while an
  // EPSG registry entry fills lon0/lat0/k0/FE/FN/f. Reading only the first set made
  // this inverse silently degrade to a NULL projection (lon0=0, lat0=0, FE=0, FN=0)
  // for every EPSG-derived Transverse Mercator grid - ITM, British National Grid,
  // RD New - putting an Israeli survey in the Gulf of Guinea. UTM escaped it only
  // because that branch keys off `zone`. Accept both, in both directions.
  const f = tmParam(proj?.invF ? 1 / proj.invF : undefined, proj?.f, 1 / 298.257222101);
  const lon0 = tmParam(proj?.centralMeridian, proj?.lon0, 0);
  const lat0 = tmParam(proj?.latOrigin, proj?.lat0, 0);
  const k0 = tmParam(proj?.scaleFactor, proj?.k0, 1);
  const FE = tmParam(proj?.falseEasting, proj?.FE, 0);
  const FN = tmParam(proj?.falseNorthing, proj?.FN, 0);
  const geodetic = tmToGeodetic(E, N, { a, f, lon0, lat0, k0, FE, FN });
  if (proj && proj.helmert) {
    return helmert7ToWGS84(geodetic.lat, geodetic.lon, h, a, f, proj.helmert);
  }
  return geodetic;
}

/** WGS84 lat/lon → target projected CRS. */
export function latLonToProj(lat_deg: number, lon_deg: number, tgt: Projection, elev_m?: number): EN {
  const h = elev_m || 0;
  let ll: LatLon = { lat: lat_deg, lon: lon_deg };

  const xp = extraParams(tgt);
  if (xp) {
    if (tgt.helmert && Math.abs(tgt.helmert.dx) + Math.abs(tgt.helmert.dy) + Math.abs(tgt.helmert.dz) > 0.01) {
      const f = xp.e2 ? 1 - Math.sqrt(1 - xp.e2) : 0;
      ll = wgs84ToLocal(lat_deg, lon_deg, h, xp.a, f, tgt.helmert);
    }
    const en = projectForward(tgt.method as string, ll.lat, ll.lon, xp);
    const u = unitOf(tgt);
    return { E: en.E / u, N: en.N / u };
  }

  if (tgt.helmert && Math.abs(tgt.helmert.dx) + Math.abs(tgt.helmert.dy) + Math.abs(tgt.helmert.dz) > 0.01) {
    ll = wgs84ToLocal(lat_deg, lon_deg, h, tgt.a || 6378137, tgt.f || 1 / 298.257222101, tgt.helmert);
  }
  if (tgt.subtype === 'UTM') {
    return latLonToUTM(ll.lat, ll.lon, tgt.zone || 36, tgt.hemi || 'N');
  }
  // Symmetric with projToLatLon: accept an SPS-parser projection
  // (centralMeridian/latOrigin/...) as readily as an EPSG entry (lon0/lat0/...).
  return geodeticToTM(ll.lat, ll.lon, {
    a: tgt.a || 6378137,
    f: tmParam(tgt.f, tgt.invF ? 1 / tgt.invF : undefined, 1 / 298.257222101),
    lon0: tmParam(tgt.lon0, tgt.centralMeridian, 0),
    lat0: tmParam(tgt.lat0, tgt.latOrigin, 0),
    k0: tmParam(tgt.k0, tgt.scaleFactor, 1),
    FE: tmParam(tgt.FE, tgt.falseEasting, 0),
    FN: tmParam(tgt.FN, tgt.falseNorthing, 0),
  });
}

// ------------------- ITM (Israeli TM, EPSG:2039) convenience -------------------
// Numerically identical to app/src/services/calculations.ts#latLonToITM so the
// two implementations can be regression-checked against each other.

/** ITM (EPSG:2039) Transverse Mercator parameters, GRS80 ellipsoid. */
export const ITM_PARAMS: TMParams = {
  a: 6378137.0,
  f: 1 / 298.257222101,
  lon0: 35.2045169444444,
  lat0: 31.7343936111111,
  k0: 1.0000067,
  FE: 219529.584,
  FN: 626907.39,
};

/** Forward ITM: geodetic (on ITM datum) → ITM E/N. */
export function latLonToITM(lat_deg: number, lon_deg: number): EN {
  return geodeticToTM(lat_deg, lon_deg, ITM_PARAMS);
}

/** Inverse ITM: ITM E/N → geodetic (on ITM datum). */
export function itmToLatLon(E: number, N: number): LatLon {
  return tmToGeodetic(E, N, ITM_PARAMS);
}
