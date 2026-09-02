// seisconv-core - map projection methods beyond Transverse Mercator.
//
// Forward (geodetic -> E/N) and inverse (E/N -> geodetic) for the projection
// methods that, together with the Transverse Mercator in ./coords, cover ~97 %
// of the projected CRSs in the EPSG registry:
//
//   LCC     Lambert Conformal Conic, 1SP and 2SP   (EPSG 9801 / 9802)
//   MERC    Mercator, variant A (k0) and B (lat_ts) (EPSG 9804 / 9805)
//   CASS    Cassini-Soldner                         (EPSG 9806)
//   AEA     Albers Equal Area Conic                 (EPSG 9822)
//   LAEA    Lambert Azimuthal Equal Area            (EPSG 9820)
//   STERE   Polar Stereographic, variants A and B   (EPSG 9810 / 9829)
//   STEREA  Oblique Stereographic (double proj.)    (EPSG 9809)
//
// All angles in DEGREES at the boundary, radians internally. Spherical forms are
// used when the ellipsoid is a sphere (e = 0), which is how EPSG:3857 (Pseudo-
// Mercator) is defined. Every inverse is iterative where the closed form does not
// exist, with a fixed iteration cap so malformed input can never spin.
//
// Verified against PROJ (pyproj) - see the projection tests in core/__tests__.
// Pure - no DOM, no Node.

import type { EN, LatLon } from './coords';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const HALF_PI = Math.PI / 2;
const EPS = 1e-12;
/** Iteration cap for the inverse series. PROJ converges in <8 for real data. */
const MAX_ITER = 30;

/** Parameters common to the methods here. Angles in degrees, lengths in metres. */
export interface ProjParams {
  a: number;
  /** First eccentricity SQUARED. 0 for a sphere. */
  e2: number;
  lat0: number;
  lon0: number;
  lat1?: number;
  lat2?: number;
  /** Latitude of true scale (Mercator / Polar Stereographic "variant B"). */
  latTs?: number;
  k0: number;
  FE: number;
  FN: number;
}

/** Build ProjParams from a semi-major axis + inverse flattening. rf 0 = sphere. */
export function paramsFrom(a: number, rf: number, rest: Partial<ProjParams> = {}): ProjParams {
  const f = rf && Number.isFinite(rf) && rf !== 0 ? 1 / rf : 0;
  return {
    a: a || 6378137,
    e2: 2 * f - f * f,
    lat0: rest.lat0 ?? 0,
    lon0: rest.lon0 ?? 0,
    lat1: rest.lat1,
    lat2: rest.lat2,
    latTs: rest.latTs,
    k0: rest.k0 ?? 1,
    FE: rest.FE ?? 0,
    FN: rest.FN ?? 0,
  };
}

/** Normalise a longitude difference to [-pi, pi] so a grid can straddle +/-180. */
function wrap(dLon: number): number {
  let d = dLon;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Normalise a longitude to (-180, 180]. Every inverse runs its result through
 *  this: the azimuthal and conic inverses can legitimately land on 288 deg for a
 *  grid whose origin is at 180 deg, and an unwrapped longitude silently breaks
 *  every downstream consumer (map plotting, bbox tests, further reprojection). */
function wrapDeg(lon: number): number {
  if (!Number.isFinite(lon)) return lon;
  let d = lon;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

/** m(lat) = cos(lat) / sqrt(1 - e^2 sin^2 lat) - the conformal scale term. */
function msfn(sinPhi: number, cosPhi: number, e2: number): number {
  return cosPhi / Math.sqrt(1 - e2 * sinPhi * sinPhi);
}

/** t(lat), the isometric-latitude exponential used by conformal projections. */
function tsfn(phi: number, sinPhi: number, e: number): number {
  const con = e * sinPhi;
  return Math.tan(0.5 * (HALF_PI - phi)) / Math.pow((1 - con) / (1 + con), 0.5 * e);
}

/** Inverse of tsfn: recover latitude from t. Iterative, capped. */
function phi2(ts: number, e: number): number {
  const eccnth = 0.5 * e;
  let phi = HALF_PI - 2 * Math.atan(ts);
  for (let i = 0; i < MAX_ITER; i++) {
    const con = e * Math.sin(phi);
    const dphi = HALF_PI - 2 * Math.atan(ts * Math.pow((1 - con) / (1 + con), eccnth)) - phi;
    phi += dphi;
    if (Math.abs(dphi) < 1e-12) break;
  }
  return phi;
}

/** Authalic (equal-area) helper q(lat), EPSG 9822 / Snyder 3-12. */
function qsfn(sinPhi: number, e: number, e2: number): number {
  if (e < EPS) return 2 * sinPhi;
  const con = e * sinPhi;
  return (1 - e2) * (sinPhi / (1 - con * con) - (0.5 / e) * Math.log((1 - con) / (1 + con)));
}

/** Meridional arc distance, shared with the TM code in ./coords. */
function mlfn(phi: number, a: number, e2: number): number {
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  return a * (
    (1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
    ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
    ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
    ((35 * e6) / 3072) * Math.sin(6 * phi)
  );
}

/** Footprint latitude: invert mlfn. */
function invMlfn(M: number, a: number, e2: number): number {
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  return (
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)
  );
}

// -- Lambert Conformal Conic ---------------------------------------------------
//
// One implementation serves both EPSG variants, exactly as PROJ does: given two
// distinct standard parallels it is the 2SP form; given one (or two equal ones)
// it collapses to the 1SP form with the scale factor at the natural origin.

interface LccConst { n: number; c: number; rho0: number; e: number; }

function lccConst(p: ProjParams): LccConst {
  const e = Math.sqrt(p.e2);
  const phi0 = p.lat0 * D2R;
  let phi1 = (p.lat1 ?? p.lat0) * D2R;
  let phi2 = (p.lat2 ?? p.lat1 ?? p.lat0) * D2R;
  // A single standard parallel (or two identical ones) is the 1SP case.
  const oneSP = Math.abs(phi1 - phi2) < 1e-10;
  if (oneSP) phi2 = phi1;

  const sin1 = Math.sin(phi1), cos1 = Math.cos(phi1);
  const m1 = msfn(sin1, cos1, p.e2);
  const t1 = tsfn(phi1, sin1, e);
  let n: number;
  if (oneSP) {
    n = sin1;
  } else {
    const sin2 = Math.sin(phi2), cos2 = Math.cos(phi2);
    const m2 = msfn(sin2, cos2, p.e2);
    const t2 = tsfn(phi2, sin2, e);
    n = Math.log(m1 / m2) / Math.log(t1 / t2);
  }
  // Guard a degenerate cone (standard parallel at the equator): n -> 0 makes the
  // projection undefined. Returning NaN here surfaces as a non-finite coordinate
  // that callers already reject, rather than an Infinity that plots somewhere.
  if (!Number.isFinite(n) || Math.abs(n) < 1e-10) return { n: NaN, c: NaN, rho0: NaN, e };
  const c = (m1 * Math.pow(t1, -n)) / n;
  // In the 1SP form the scale factor at the natural origin multiplies the radius.
  const k = oneSP ? p.k0 : 1;
  const t0 = tsfn(phi0, Math.sin(phi0), e);
  const rho0 = Math.abs(Math.abs(phi0) - HALF_PI) < EPS ? 0 : p.a * k * c * Math.pow(t0, n);
  return { n, c: p.a * k * c, rho0, e };
}

export function lccForward(lat: number, lon: number, p: ProjParams): EN {
  const K = lccConst(p);
  if (!Number.isFinite(K.n)) return { E: NaN, N: NaN };
  const phi = lat * D2R;
  const rho = Math.abs(Math.abs(phi) - HALF_PI) < EPS
    ? 0
    : K.c * Math.pow(tsfn(phi, Math.sin(phi), K.e), K.n);
  const theta = K.n * wrap(lon * D2R - p.lon0 * D2R);
  return { E: p.FE + rho * Math.sin(theta), N: p.FN + K.rho0 - rho * Math.cos(theta) };
}

export function lccInverse(E: number, N: number, p: ProjParams): LatLon {
  const K = lccConst(p);
  if (!Number.isFinite(K.n)) return { lat: NaN, lon: NaN };
  const x = E - p.FE;
  const y = K.rho0 - (N - p.FN);
  let rho = Math.hypot(x, y);
  if (rho === 0) return { lat: K.n > 0 ? 90 : -90, lon: wrapDeg(p.lon0) };
  // The cone opens the other way for a southern-hemisphere standard parallel.
  const sign = K.n < 0 ? -1 : 1;
  rho *= sign;
  const theta = Math.atan2(sign * x, sign * y);
  const ts = Math.pow(rho / K.c, 1 / K.n);
  return { lat: phi2(ts, K.e) * R2D, lon: wrapDeg((theta / K.n + p.lon0 * D2R) * R2D) };
}

// -- Mercator ------------------------------------------------------------------

/** Effective scale factor: variant B derives it from the latitude of true scale. */
function mercK0(p: ProjParams): number {
  if (p.latTs != null && Math.abs(p.latTs) > 1e-12) {
    const phiTs = p.latTs * D2R;
    return msfn(Math.sin(phiTs), Math.cos(phiTs), p.e2);
  }
  return p.k0 || 1;
}

export function mercForward(lat: number, lon: number, p: ProjParams): EN {
  const e = Math.sqrt(p.e2);
  const k0 = mercK0(p);
  const phi = lat * D2R;
  const E = p.FE + p.a * k0 * wrap(lon * D2R - p.lon0 * D2R);
  // A pole has no finite Mercator northing - report it rather than +/-Infinity.
  if (Math.abs(Math.abs(phi) - HALF_PI) < EPS) return { E, N: NaN };
  const N = p.FN - p.a * k0 * Math.log(tsfn(phi, Math.sin(phi), e));
  return { E, N };
}

export function mercInverse(E: number, N: number, p: ProjParams): LatLon {
  const e = Math.sqrt(p.e2);
  const k0 = mercK0(p);
  const ts = Math.exp((p.FN - N) / (p.a * k0));
  return { lat: phi2(ts, e) * R2D, lon: wrapDeg(((E - p.FE) / (p.a * k0) + p.lon0 * D2R) * R2D) };
}

// -- Cassini-Soldner -----------------------------------------------------------

export function cassForward(lat: number, lon: number, p: ProjParams): EN {
  const phi = lat * D2R;
  const dl = wrap(lon * D2R - p.lon0 * D2R);
  const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
  const nu = p.a / Math.sqrt(1 - p.e2 * sinPhi * sinPhi);
  const T = Math.tan(phi) ** 2;
  const A = dl * cosPhi;
  const C = (p.e2 * cosPhi * cosPhi) / (1 - p.e2);
  const A2 = A * A;
  const X = nu * (A - (T * A * A2) / 6 - ((8 - T + 8 * C) * T * A2 * A2 * A) / 120);
  const M = mlfn(phi, p.a, p.e2);
  const M0 = mlfn(p.lat0 * D2R, p.a, p.e2);
  const Y = M - M0 + nu * Math.tan(phi) * (A2 / 2 + ((5 - T + 6 * C) * A2 * A2) / 24);
  return { E: p.FE + X, N: p.FN + Y };
}

export function cassInverse(E: number, N: number, p: ProjParams): LatLon {
  const M0 = mlfn(p.lat0 * D2R, p.a, p.e2);
  const M1 = M0 + (N - p.FN);
  const phi1 = invMlfn(M1, p.a, p.e2);
  if (Math.abs(Math.cos(phi1)) < EPS) return { lat: phi1 * R2D, lon: wrapDeg(p.lon0) };
  const sin1 = Math.sin(phi1), cos1 = Math.cos(phi1), tan1 = Math.tan(phi1);
  const nu1 = p.a / Math.sqrt(1 - p.e2 * sin1 * sin1);
  const rho1 = (p.a * (1 - p.e2)) / Math.pow(1 - p.e2 * sin1 * sin1, 1.5);
  const T1 = tan1 * tan1;
  const D = (E - p.FE) / nu1;
  const D2 = D * D;
  const phi = phi1 - ((nu1 * tan1) / rho1) * (D2 / 2 - ((1 + 3 * T1) * D2 * D2) / 24);
  const lam = (D - (T1 * D * D2) / 3 + ((1 + 3 * T1) * T1 * D2 * D2 * D) / 15) / cos1;
  return { lat: phi * R2D, lon: wrapDeg((lam + p.lon0 * D2R) * R2D) };
}

// -- Albers Equal Area ---------------------------------------------------------

interface AeaConst { n: number; c: number; rho0: number; e: number; qp: number; }

function aeaConst(p: ProjParams): AeaConst {
  const e = Math.sqrt(p.e2);
  const phi1 = (p.lat1 ?? p.lat0) * D2R;
  const phi2 = (p.lat2 ?? p.lat1 ?? p.lat0) * D2R;
  const sin1 = Math.sin(phi1), cos1 = Math.cos(phi1);
  const sin2 = Math.sin(phi2), cos2 = Math.cos(phi2);
  const m1 = msfn(sin1, cos1, p.e2);
  const m2 = msfn(sin2, cos2, p.e2);
  const q1 = qsfn(sin1, e, p.e2);
  const q2 = qsfn(sin2, e, p.e2);
  const n = Math.abs(phi1 - phi2) < 1e-10 ? sin1 : (m1 * m1 - m2 * m2) / (q2 - q1);
  const c = m1 * m1 + n * q1;
  const q0 = qsfn(Math.sin(p.lat0 * D2R), e, p.e2);
  const rho0 = (p.a * Math.sqrt(c - n * q0)) / n;
  return { n, c, rho0, e, qp: qsfn(1, e, p.e2) };
}

export function aeaForward(lat: number, lon: number, p: ProjParams): EN {
  const K = aeaConst(p);
  if (!Number.isFinite(K.n) || Math.abs(K.n) < 1e-12) return { E: NaN, N: NaN };
  const q = qsfn(Math.sin(lat * D2R), K.e, p.e2);
  const inner = K.c - K.n * q;
  const rho = (p.a * Math.sqrt(Math.max(0, inner))) / K.n;
  const theta = K.n * wrap(lon * D2R - p.lon0 * D2R);
  return { E: p.FE + rho * Math.sin(theta), N: p.FN + K.rho0 - rho * Math.cos(theta) };
}

export function aeaInverse(E: number, N: number, p: ProjParams): LatLon {
  const K = aeaConst(p);
  if (!Number.isFinite(K.n) || Math.abs(K.n) < 1e-12) return { lat: NaN, lon: NaN };
  const x = E - p.FE;
  const y = K.rho0 - (N - p.FN);
  const sign = K.n < 0 ? -1 : 1;
  const rho = sign * Math.hypot(x, y);
  const theta = rho === 0 ? 0 : Math.atan2(sign * x, sign * y);
  const q = (K.c - (rho * rho * K.n * K.n) / (p.a * p.a)) / K.n;
  // Authalic latitude -> geodetic latitude, by Newton iteration on q(phi).
  const phi = Math.abs(Math.abs(q) - K.qp) < 1e-12
    ? (q < 0 ? -HALF_PI : HALF_PI)
    : phiFromQ(q, K.e, p.e2);
  return { lat: phi * R2D, lon: wrapDeg((theta / K.n + p.lon0 * D2R) * R2D) };
}

// -- Lambert Azimuthal Equal Area ---------------------------------------------

/** True when the origin sits on a pole - LAEA's oblique formulae divide by
 *  cos(beta0) there, so the polar aspect needs its own (simpler) closed form. */
function isPolarAspect(lat0: number): boolean {
  return Math.abs(Math.abs(lat0) - 90) < 1e-9;
}

export function laeaForward(lat: number, lon: number, p: ProjParams): EN {
  const e = Math.sqrt(p.e2);
  const phi = lat * D2R;
  const dl = wrap(lon * D2R - p.lon0 * D2R);
  const phi0 = p.lat0 * D2R;
  const qp = qsfn(1, e, p.e2);
  const q = qsfn(Math.sin(phi), e, p.e2);
  const Rq = p.a * Math.sqrt(qp / 2);

  // POLAR aspect (EPSG 9820 polar case): rho comes straight from q, no beta0.
  if (isPolarAspect(p.lat0)) {
    const north = p.lat0 > 0;
    const inner = north ? qp - q : qp + q;
    const rho = p.a * Math.sqrt(Math.max(0, inner));
    return {
      E: p.FE + rho * Math.sin(dl),
      N: p.FN + (north ? -rho * Math.cos(dl) : rho * Math.cos(dl)),
    };
  }

  const q0 = qsfn(Math.sin(phi0), e, p.e2);
  const beta = Math.asin(Math.max(-1, Math.min(1, q / qp)));
  const beta0 = Math.asin(Math.max(-1, Math.min(1, q0 / qp)));
  const m0 = msfn(Math.sin(phi0), Math.cos(phi0), p.e2);
  const D = (p.a * m0) / (Rq * Math.cos(beta0));
  const denom = 1 + Math.sin(beta0) * Math.sin(beta) + Math.cos(beta0) * Math.cos(beta) * Math.cos(dl);
  if (denom < EPS) return { E: NaN, N: NaN }; // antipodal point: undefined
  const B = Rq * Math.sqrt(2 / denom);
  return {
    E: p.FE + B * D * Math.cos(beta) * Math.sin(dl),
    N: p.FN + (B / D) * (Math.cos(beta0) * Math.sin(beta) - Math.sin(beta0) * Math.cos(beta) * Math.cos(dl)),
  };
}

/** Authalic latitude (via q) -> geodetic latitude, by Newton iteration. */
function phiFromQ(q: number, e: number, e2: number): number {
  if (e < EPS) return Math.asin(Math.max(-1, Math.min(1, q / 2)));
  let phi = Math.asin(Math.max(-1, Math.min(1, q / 2)));
  for (let i = 0; i < MAX_ITER; i++) {
    const s = Math.sin(phi), c = Math.cos(phi);
    if (Math.abs(c) < EPS) break; // at a pole the iteration is already exact
    const con = e2 * s * s;
    const dphi = ((1 - con) ** 2 / (2 * c)) * (q / (1 - e2) - s / (1 - con) + (0.5 / e) * Math.log((1 - e * s) / (1 + e * s)));
    phi += dphi;
    if (Math.abs(dphi) < 1e-13) break;
  }
  return phi;
}

export function laeaInverse(E: number, N: number, p: ProjParams): LatLon {
  const e = Math.sqrt(p.e2);
  const phi0 = p.lat0 * D2R;
  const qp = qsfn(1, e, p.e2);

  // POLAR aspect: invert the closed form used in the forward direction.
  if (isPolarAspect(p.lat0)) {
    const north = p.lat0 > 0;
    const x = E - p.FE;
    const y = N - p.FN;
    const rho = Math.hypot(x, y);
    if (rho < EPS) return { lat: p.lat0, lon: wrapDeg(p.lon0) };
    const q = north ? qp - (rho * rho) / (p.a * p.a) : (rho * rho) / (p.a * p.a) - qp;
    const lam = north ? Math.atan2(x, -y) : Math.atan2(x, y);
    return { lat: phiFromQ(q, e, p.e2) * R2D, lon: wrapDeg((lam + p.lon0 * D2R) * R2D) };
  }

  const q0 = qsfn(Math.sin(phi0), e, p.e2);
  const Rq = p.a * Math.sqrt(qp / 2);
  const beta0 = Math.asin(Math.max(-1, Math.min(1, q0 / qp)));
  const m0 = msfn(Math.sin(phi0), Math.cos(phi0), p.e2);
  const D = (p.a * m0) / (Rq * Math.cos(beta0));
  const x = (E - p.FE) / D;
  const y = (N - p.FN) * D;
  const rho = Math.hypot(x, y);
  if (rho < EPS) return { lat: p.lat0, lon: wrapDeg(p.lon0) };
  const C = 2 * Math.asin(Math.max(-1, Math.min(1, rho / (2 * Rq))));
  const beta = Math.asin(Math.cos(C) * Math.sin(beta0) + (y * Math.sin(C) * Math.cos(beta0)) / rho);
  const lam = Math.atan2(x * Math.sin(C), rho * Math.cos(beta0) * Math.cos(C) - y * Math.sin(beta0) * Math.sin(C));
  const phi = phiFromQ(qp * Math.sin(beta), e, p.e2);
  return { lat: phi * R2D, lon: wrapDeg((lam + p.lon0 * D2R) * R2D) };
}

// -- Polar Stereographic (EPSG 9810 variant A / 9829 variant B) -----------------

export function stereoPolarForward(lat: number, lon: number, p: ProjParams): EN {
  const e = Math.sqrt(p.e2);
  const south = p.lat0 < 0;
  const sgn = south ? -1 : 1;
  const phi = lat * D2R * sgn;
  const dl = wrap(lon * D2R - p.lon0 * D2R) * sgn;
  let k0 = p.k0 || 1;
  if (p.latTs != null && Math.abs(Math.abs(p.latTs) - 90) > 1e-9) {
    // Variant B: scale is 1 at the latitude of true scale, not at the pole.
    const phiTs = Math.abs(p.latTs) * D2R;
    const mTs = msfn(Math.sin(phiTs), Math.cos(phiTs), p.e2);
    const tTs = tsfn(phiTs, Math.sin(phiTs), e);
    k0 = (mTs * Math.sqrt(Math.pow(1 + e, 1 + e) * Math.pow(1 - e, 1 - e))) / (2 * tTs);
  }
  const t = tsfn(phi, Math.sin(phi), e);
  const rho = (2 * p.a * k0 * t) / Math.sqrt(Math.pow(1 + e, 1 + e) * Math.pow(1 - e, 1 - e));
  return { E: p.FE + sgn * rho * Math.sin(dl), N: p.FN - sgn * rho * Math.cos(dl) };
}

export function stereoPolarInverse(E: number, N: number, p: ProjParams): LatLon {
  const e = Math.sqrt(p.e2);
  const south = p.lat0 < 0;
  const sgn = south ? -1 : 1;
  let k0 = p.k0 || 1;
  if (p.latTs != null && Math.abs(Math.abs(p.latTs) - 90) > 1e-9) {
    const phiTs = Math.abs(p.latTs) * D2R;
    const mTs = msfn(Math.sin(phiTs), Math.cos(phiTs), p.e2);
    const tTs = tsfn(phiTs, Math.sin(phiTs), e);
    k0 = (mTs * Math.sqrt(Math.pow(1 + e, 1 + e) * Math.pow(1 - e, 1 - e))) / (2 * tTs);
  }
  const x = (E - p.FE) * sgn;
  const y = (N - p.FN) * sgn;
  const rho = Math.hypot(x, y);
  if (rho < EPS) return { lat: 90 * sgn, lon: wrapDeg(p.lon0) };
  const t = (rho * Math.sqrt(Math.pow(1 + e, 1 + e) * Math.pow(1 - e, 1 - e))) / (2 * p.a * k0);
  const phi = phi2(t, e);
  const lam = Math.atan2(x, -y);
  return { lat: phi * R2D * sgn, lon: wrapDeg((lam * sgn + p.lon0 * D2R) * R2D) };
}

// -- Oblique Stereographic, EPSG 9809 ------------------------------------------
//
// The "double projection": geodetic -> conformal sphere -> plane. This is the
// method used by the Dutch RD grid and several national systems, and is NOT the
// same as PROJ's `stere` at a non-polar origin.

interface StereaConst { R: number; C: number; K: number; phic0: number; lam0: number; sinc0: number; cosc0: number; e: number; }

function stereaConst(p: ProjParams): StereaConst {
  const e = Math.sqrt(p.e2);
  const phi0 = p.lat0 * D2R;
  const sin0 = Math.sin(phi0), cos0 = Math.cos(phi0);
  const rho0 = (p.a * (1 - p.e2)) / Math.pow(1 - p.e2 * sin0 * sin0, 1.5);
  const nu0 = p.a / Math.sqrt(1 - p.e2 * sin0 * sin0);
  const R = Math.sqrt(rho0 * nu0);
  const n = Math.sqrt(1 + (p.e2 * Math.pow(cos0, 4)) / (1 - p.e2));
  const S1 = (1 + sin0) / (1 - sin0);
  const S2 = (1 - e * sin0) / (1 + e * sin0);
  const w1 = Math.pow(S1 * Math.pow(S2, e), n);
  const sinChi0 = (w1 - 1) / (w1 + 1);
  const c = ((n + sin0) * (1 - sinChi0)) / ((n - sin0) * (1 + sinChi0));
  const w2 = c * w1;
  const chi0 = Math.asin((w2 - 1) / (w2 + 1));
  return { R, C: c, K: n, phic0: chi0, lam0: p.lon0 * D2R, sinc0: Math.sin(chi0), cosc0: Math.cos(chi0), e };
}

/** Geodetic latitude -> conformal latitude on the sphere of radius R. */
function toConformal(phi: number, K: StereaConst, e: number): number {
  const Sa = (1 + Math.sin(phi)) / (1 - Math.sin(phi));
  const Sb = (1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi));
  const w = K.C * Math.pow(Sa * Math.pow(Sb, e), K.K);
  return Math.asin((w - 1) / (w + 1));
}

export function stereaForward(lat: number, lon: number, p: ProjParams): EN {
  const K = stereaConst(p);
  const e = K.e;
  const phi = lat * D2R;
  const chi = toConformal(phi, K, e);
  const lamC = K.K * wrap(lon * D2R - K.lam0) + K.lam0;
  const dl = lamC - K.lam0;
  const sinChi = Math.sin(chi), cosChi = Math.cos(chi);
  const B = 1 + sinChi * K.sinc0 + cosChi * K.cosc0 * Math.cos(dl);
  if (Math.abs(B) < EPS) return { E: NaN, N: NaN };
  const k0 = p.k0 || 1;
  return {
    E: p.FE + 2 * K.R * k0 * (cosChi * Math.sin(dl)) / B,
    N: p.FN + 2 * K.R * k0 * (sinChi * K.cosc0 - cosChi * K.sinc0 * Math.cos(dl)) / B,
  };
}

export function stereaInverse(E: number, N: number, p: ProjParams): LatLon {
  const K = stereaConst(p);
  const e = K.e;
  const k0 = p.k0 || 1;
  const x = E - p.FE;
  const y = N - p.FN;
  const g = 2 * K.R * k0 * Math.tan(Math.PI / 4 - K.phic0 / 2);
  const h = 4 * K.R * k0 * Math.tan(K.phic0) + g;
  const i = Math.atan2(x, h + y);
  const j = Math.atan2(x, g - y) - i;
  const chi = K.phic0 + 2 * Math.atan((y - x * Math.tan(j / 2)) / (2 * K.R * k0));
  const lamC = j + 2 * i + K.lam0;
  const lam = (wrap(lamC - K.lam0)) / K.K + K.lam0;
  // Conformal latitude -> geodetic latitude, iteratively.
  const psi = 0.5 * Math.log((1 + Math.sin(chi)) / (K.C * (1 - Math.sin(chi)))) / K.K;
  let phi = 2 * Math.atan(Math.exp(psi)) - HALF_PI;
  for (let it = 0; it < MAX_ITER; it++) {
    const s = Math.sin(phi);
    const psiI = Math.log(Math.tan(phi / 2 + Math.PI / 4) * Math.pow((1 - e * s) / (1 + e * s), e / 2));
    const dphi = ((psi - psiI) * Math.cos(phi) * (1 - p.e2 * s * s)) / (1 - p.e2);
    phi += dphi;
    if (Math.abs(dphi) < 1e-13) break;
  }
  return { lat: phi * R2D, lon: wrapDeg(lam * R2D) };
}

/** Methods this module can compute, as used by the dispatcher in ./coords. */
export const EXTRA_METHODS = ['LCC', 'MERC', 'CASS', 'AEA', 'LAEA', 'STERE', 'STEREA'] as const;
export type ExtraMethod = (typeof EXTRA_METHODS)[number];

/** Forward-project with one of the methods above. Returns NaN E/N if unknown. */
export function projectForward(method: string, lat: number, lon: number, p: ProjParams): EN {
  switch (method) {
    case 'LCC': return lccForward(lat, lon, p);
    case 'MERC': return mercForward(lat, lon, p);
    case 'CASS': return cassForward(lat, lon, p);
    case 'AEA': return aeaForward(lat, lon, p);
    case 'LAEA': return laeaForward(lat, lon, p);
    case 'STERE': return stereoPolarForward(lat, lon, p);
    case 'STEREA': return stereaForward(lat, lon, p);
    default: return { E: NaN, N: NaN };
  }
}

/** Inverse of {@link projectForward}. Returns NaN lat/lon if unknown. */
export function projectInverse(method: string, E: number, N: number, p: ProjParams): LatLon {
  switch (method) {
    case 'LCC': return lccInverse(E, N, p);
    case 'MERC': return mercInverse(E, N, p);
    case 'CASS': return cassInverse(E, N, p);
    case 'AEA': return aeaInverse(E, N, p);
    case 'LAEA': return laeaInverse(E, N, p);
    case 'STERE': return stereoPolarInverse(E, N, p);
    case 'STEREA': return stereaInverse(E, N, p);
    default: return { lat: NaN, lon: NaN };
  }
}
