// seisconv-core / sps — coordinate reprojection + EPSG target database.
//
// Reproject an SPS survey from its source CRS to a target CRS: each S/R point's
// E/N is taken source-proj → WGS84 (via the Helmert-aware coords engine) →
// target-proj, and the projection H-records are rewritten. Ported from the
// SeisConv reference. Pure — no DOM.

import { latLonToProj, projToLatLon, type EN, type Projection } from '../coords';
import { hRecCode, spsParseCoords, SPS_COORD_SPANS, type SPSProjection } from './parse';

export interface CRS {
  code: string;
  name: string;
  subtype: string; // 'UTM' | 'TM' | 'GEO' | 'LCC'
  zone?: number;
  hemi?: 'N' | 'S';
  a?: number;
  f?: number;
  lon0?: number;
  lat0?: number;
  k0?: number;
  FE?: number;
  FN?: number;
  helmert?: { dx: number; dy: number; dz: number; rx: number; ry: number; rz: number; ds: number };
  region?: string;
}

export function buildEPSGDB(): CRS[] {
  const W84 = { a: 6378137, f: 1 / 298.257223563 };
  const db: CRS[] = [];
  for (let z = 1; z <= 60; z++)
    db.push({ code: 'EPSG:' + (32600 + z), name: `WGS 84 / UTM zone ${z}N`, subtype: 'UTM', zone: z, hemi: 'N', ...W84, lon0: z * 6 - 183, lat0: 0, k0: 0.9996, FE: 500000, FN: 0, region: z <= 20 ? 'Americas' : z <= 40 ? 'Europe/Africa/Middle East' : 'Asia/Pacific' });
  for (let z = 1; z <= 60; z++)
    db.push({ code: 'EPSG:' + (32700 + z), name: `WGS 84 / UTM zone ${z}S`, subtype: 'UTM', zone: z, hemi: 'S', ...W84, lon0: z * 6 - 183, lat0: 0, k0: 0.9996, FE: 500000, FN: 10000000, region: z <= 20 ? 'Americas S' : z <= 40 ? 'Africa S' : 'Pacific S' });
  const GRS80 = { a: 6378137, f: 1 / 298.257222101 };
  db.push({ code: 'EPSG:2039', name: 'ITM — Israel Transverse Mercator (New Israeli Grid)', subtype: 'TM', ...GRS80, lon0: 35.20451694444, lat0: 31.73439361111, k0: 1.0000067, FE: 219529.584, FN: 626907.39, helmert: { dx: 23.772, dy: 17.49, dz: 17.859, rx: -0.313, ry: -1.853, rz: 1.673, ds: 0 }, region: 'Israel' });
  db.push({ code: 'EPSG:4326', name: 'WGS 84 — Geographic (lat/lon degrees)', subtype: 'GEO', region: 'Global' });
  db.push({ code: 'EPSG:27700', name: 'OSGB 1936 / British National Grid', subtype: 'TM', a: 6377563.396, f: 1 / 299.3249646, lon0: -2, lat0: 49, k0: 0.9996012717, FE: 400000, FN: -100000, helmert: { dx: 375, dy: -111, dz: 431, rx: 0, ry: 0, rz: 0, ds: 0 }, region: 'UK' });
  db.push({ code: 'EPSG:28992', name: 'Amersfoort / RD New (Netherlands)', subtype: 'TM', a: 6377397.155, f: 1 / 299.1528128, lon0: 5.38720621, lat0: 52.15616056, k0: 0.9999079, FE: 155000, FN: 463000, helmert: { dx: 565.2369, dy: 50.0087, dz: 465.658, rx: -0.40685, ry: -0.35107, rz: -1.87035, ds: 4.0812 }, region: 'Netherlands' });
  db.push({ code: 'EPSG:23036', name: 'ED50 / UTM zone 36N', subtype: 'UTM', a: 6378388, f: 1 / 297, zone: 36, hemi: 'N', lon0: 33, lat0: 0, k0: 0.9996, FE: 500000, FN: 0, helmert: { dx: -84, dy: -97, dz: -117, rx: 0, ry: 0, rz: 0, ds: 0 }, region: 'Middle East' });
  db.push({ code: 'EPSG:23037', name: 'ED50 / UTM zone 37N', subtype: 'UTM', a: 6378388, f: 1 / 297, zone: 37, hemi: 'N', lon0: 39, lat0: 0, k0: 0.9996, FE: 500000, FN: 0, helmert: { dx: -84, dy: -97, dz: -117, rx: 0, ry: 0, rz: 0, ds: 0 }, region: 'Middle East' });
  // ETRS89 / UTM zones used across Europe & the Mediterranean (GRS80 ellipsoid).
  // ETRS89 is WGS84-equivalent to sub-decimetre, so no datum shift is applied
  // (Helmert all-zero). Standard EPSG codes 258zz where zz = 28..38 → zone
  // 28N..38N. Generated from the zone number — not hand-written literals.
  for (let z = 28; z <= 38; z++)
    db.push({ code: 'EPSG:' + (25800 + z), name: `ETRS89 / UTM zone ${z}N`, subtype: 'UTM', zone: z, hemi: 'N', ...GRS80, lon0: z * 6 - 183, lat0: 0, k0: 0.9996, FE: 500000, FN: 0, region: 'Europe (ETRS89)' });
  return db;
}

export const EPSG_DB = buildEPSGDB();

/**
 * Free-text search of the built-in (offline) EPSG database, used by the renderer's
 * CRS picker. Matches case-insensitively against BOTH the EPSG code (numeric or
 * full, e.g. "2039", "32636", "EPSG:32636") AND the human name/region (e.g. "ITM",
 * "UTM 36N", "zone 36", "Israel"), returning ranked results:
 *   exact code  ≫  whole-query substring in name  ≫  every query token present
 * Token matching is what lets "UTM 36N" find "WGS 84 / UTM zone 36N" — the word
 * "zone" breaks a naive substring match, but the tokens "utm" + "36n" are both
 * present. Linear over the in-memory list (a few hundred rows) — fast and fully
 * built-in (no network).
 */
export function searchEPSG(q: string): CRS[] {
  const query = (q || '').trim();
  if (!query) return EPSG_DB.slice(0, 30);
  const ql = query.toLowerCase();
  // Tokenise on any non-alphanumeric run so "utm-36n", "UTM 36N" and "zone 36"
  // all split into clean tokens we can require against the haystack.
  const tokens = ql.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  // A pure code query, optionally with an "epsg:" prefix → exact/prefix code match.
  const stripped = ql.replace(/^epsg:?\s*/, '').trim();
  const isCodeQuery = /^[0-9]+$/.test(stripped);

  const scored: { crs: CRS; score: number }[] = [];
  for (const p of EPSG_DB) {
    const codeNum = p.code.replace(/^EPSG:/i, '');
    const hay = (p.code + ' ' + p.name + ' ' + (p.region || '')).toLowerCase();
    let score = 0;
    if (isCodeQuery) {
      if (codeNum === stripped) score += 1000; // exact EPSG code
      else if (codeNum.startsWith(stripped)) score += 200; // code prefix (zone family, e.g. "326")
    }
    if (hay.includes(ql)) score += 100; // whole query appears verbatim in code/name/region
    if (tokens.length && tokens.every((t) => hay.includes(t))) score += 40 + tokens.length * 5; // all tokens present
    if (score > 0) scored.push({ crs: p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.crs.code.localeCompare(b.crs.code, undefined, { numeric: true }));
  return scored.slice(0, 60).map((s) => s.crs);
}

/**
 * Format `v` to fit EXACTLY `width` columns, right-justified, preferring 2
 * decimals but dropping decimals (then, if still too wide, clipping the integer
 * part) so the result never exceeds the field — preventing a long coordinate
 * (e.g. a 10,000,000 m northing in a 10-col field) from shifting later columns.
 */
export function fitNum(v: number, width: number): string {
  for (let dp = 2; dp >= 0; dp--) {
    const s = v.toFixed(dp);
    if (s.length <= width) return s.padStart(width);
  }
  // Even with no decimals it doesn't fit (extreme/garbage value): clip to width.
  const s = v.toFixed(0);
  return s.length > width ? s.slice(0, width) : s.padStart(width);
}

function decToDMS(deg: number, pos: string, neg: string): string {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = ((abs - d) * 60 - m) * 60;
  return String(d).padStart(3, '0') + String(m).padStart(2, '0') + s.toFixed(3).padStart(6, '0') + (deg >= 0 ? pos : neg);
}
function fmtFalseEN(tgt: CRS): string {
  // 3 decimal places (mm) so canonical false-eastings/northings with sub-cm
  // precision (e.g. ITM FE 219529.584) are preserved — toFixed(2) silently
  // dropped the last millimetre on every survey re-headered to such a grid.
  const fe = (tgt.FE || 0).toFixed(3).padStart(12, '0');
  const fn = (tgt.FN || 0).toFixed(3).padStart(12, '0');
  return fe + 'E ' + fn + 'N';
}
function fmtHelmert(hP?: CRS['helmert']): string {
  if (!hP) return ' '.repeat(48);
  const f8 = (v: number) => v.toFixed(3).padStart(8);
  const f6 = (v: number) => v.toFixed(3).padStart(6);
  return f8(hP.dx) + f8(hP.dy) + f8(hP.dz) + f6(hP.rx) + f6(hP.ry) + f6(hP.rz) + f6(hP.ds);
}

/**
 * Build the projection / datum H-record LINES for a target CRS — the single
 * source of truth for the H12/H14/H18/H19/H20/H201/H220/H231/H232/H241 block.
 *
 * Each entry is a fixed-column SPS H-record: cols 1-32 carry the record code +
 * description label, cols 33-80 carry the DATA field, terminated with `;`. The
 * returned map is keyed by record code so callers can either splice the whole
 * block in (header-only CRS edit) or replace matching records in place
 * (reprojectSPS). Header-only: NO S/R coordinate lines are touched here.
 */
export function generateProjHeaders(tgt: CRS): Record<string, string> {
  const datumDesc = tgt.subtype === 'TM' || tgt.subtype === 'UTM' ? 'WGS 84 GRS 1980' : 'WGS 84';
  const a = tgt.a || 6378137;
  const invF = tgt.f ? 1 / tgt.f : 298.257223563;
  const hp = tgt.helmert;

  let projName: string;
  if (tgt.code === 'EPSG:2039') projName = 'ISRAEL GRID (NEW)';
  else if (tgt.subtype === 'UTM') projName = 'UTM';
  else if (tgt.subtype === 'TM') projName = 'TRANSVERSE MERCATOR';
  else projName = tgt.name || tgt.code;

  const zoneInfo = tgt.subtype === 'UTM' ? `Zone ${tgt.zone}, ${tgt.hemi === 'N' ? 'North' : 'South'}` : 'N/A';
  const cm = tgt.lon0 != null ? tgt.lon0 : tgt.zone ? tgt.zone * 6 - 183 : 0;
  const lat0 = tgt.lat0 != null ? tgt.lat0 : 0;

  return {
    H12: 'H12 Geodetic datum,-spheroid    '.padEnd(32) + (datumDesc + ' ' + a.toFixed(3) + ' ' + invF.toFixed(7)).padEnd(48) + ';',
    H14: 'H14 Geodetic datum parameters   '.padEnd(32) + (hp && Math.abs(hp.dx) + Math.abs(hp.dy) + Math.abs(hp.dz) > 0.01 ? fmtHelmert(hp) : 'N/A') + ';',
    H18: 'H18 Projection type             '.padEnd(32) + projName + ';',
    H19: 'H19 Projection zone             '.padEnd(32) + zoneInfo + ';',
    H20: 'H20 Description of grid units   '.padEnd(32) + 'meters;',
    H201: 'H201Factor to meters            '.padEnd(32) + '1.0000000000;',
    H220: 'H220Long. of central meridian   '.padEnd(32) + decToDMS(cm, 'E', 'W') + ';',
    H231: 'H231Grid origin                 '.padEnd(32) + (lat0 !== 0 ? decToDMS(lat0, 'N', 'S') : 'N/A') + ';',
    H232: 'H232Grid coord. at origin       '.padEnd(32) + fmtFalseEN(tgt) + ';',
    H241: 'H241Scale factor                '.padEnd(32) + (tgt.k0 || 1.0).toFixed(10) + ';',
  };
}

/** The projection H-record codes generateProjHeaders emits, in canonical order. */
export const PROJ_HEADER_CODES = ['H12', 'H14', 'H18', 'H19', 'H20', 'H201', 'H220', 'H231', 'H232', 'H241'];

/** Loose CRS edit spec the Header Editor sends (a subset of CRS, with friendly
 *  names) — converted to a full {@link CRS} via {@link crsFromSpec}. */
export interface CRSSpec {
  datum?: string;
  projType?: string;
  zone?: number;
  hemi?: 'N' | 'S';
  units?: string;
  centralMeridian?: number;
  latOrigin?: number;
  falseEasting?: number;
  falseNorthing?: number;
  scaleFactor?: number;
}

/**
 * Build a {@link CRS} for {@link generateProjHeaders} from the Header Editor's
 * loose spec. If `datum` names a known EPSG entry (code or name match) we start
 * from that DB row so its ellipsoid + Helmert + standard parameters are carried,
 * then overlay any explicitly-set fields. UTM specs derive lon0 from the zone
 * when no central meridian is given.
 */
export function crsFromSpec(spec: CRSSpec): CRS {
  const subtype = (() => {
    const t = (spec.projType || '').toUpperCase();
    if (/UTM/.test(t)) return 'UTM';
    if (/TRANSVERSE MERCATOR|^TM$|\bTM\b|ISRAEL/.test(t)) return 'TM';
    if (/GEO|LAT\s*\/?\s*LON|WGS\s*84\b/.test(t) && !/UTM|TM/.test(t)) return 'GEO';
    return t ? 'TM' : 'TM';
  })();

  // Seed from a matching EPSG entry when the datum/projType names one (so the
  // ellipsoid + Helmert + canonical false-E/N come along for known grids).
  let base: CRS | undefined;
  const want = `${spec.datum || ''} ${spec.projType || ''}`.trim().toUpperCase();
  if (want) {
    base = EPSG_DB.find((c) => {
      const hay = (c.code + ' ' + c.name).toUpperCase();
      return c.code.toUpperCase() === want || (spec.datum && hay.includes(spec.datum.toUpperCase()));
    });
    // For UTM, prefer the entry matching the requested zone+hemi.
    if (subtype === 'UTM' && spec.zone != null) {
      const z = EPSG_DB.find((c) => c.subtype === 'UTM' && c.zone === spec.zone && (spec.hemi == null || c.hemi === spec.hemi));
      if (z) base = z;
    }
  }

  // When the matched entry's subtype differs from the requested one (e.g. a
  // generic 'WGS 84' datum substring-matched the first UTM-zone-1N row but the
  // user asked for a TM grid), only the datum-level fields (ellipsoid a/f +
  // Helmert) are meaningful — its projection parameters (lon0/lat0/k0/FE/FN/zone)
  // belong to a different grid and would seed a silently-wrong central meridian /
  // false-easting. Carry over only the safe fields in that case.
  let crs: CRS;
  if (base && base.subtype !== subtype) {
    crs = { code: '', name: spec.datum || spec.projType || 'Custom', subtype, a: base.a, f: base.f, helmert: base.helmert };
  } else if (base) {
    crs = { ...base };
  } else {
    crs = { code: '', name: spec.datum || spec.projType || 'Custom', subtype };
  }
  crs.subtype = subtype;
  if (spec.zone != null) crs.zone = spec.zone;
  if (spec.hemi != null) crs.hemi = spec.hemi;
  if (spec.centralMeridian != null) crs.lon0 = spec.centralMeridian;
  if (spec.latOrigin != null) crs.lat0 = spec.latOrigin;
  if (spec.falseEasting != null) crs.FE = spec.falseEasting;
  if (spec.falseNorthing != null) crs.FN = spec.falseNorthing;
  if (spec.scaleFactor != null) crs.k0 = spec.scaleFactor;
  if (!crs.name) crs.name = spec.datum || spec.projType || crs.code || 'Custom';
  // UTM with no explicit central meridian → derive from the zone.
  if (crs.subtype === 'UTM' && crs.lon0 == null && crs.zone != null) crs.lon0 = crs.zone * 6 - 183;
  return crs;
}

function toProj(p: SPSProjection): Projection {
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

/**
 * Forward-project a WGS84 lat/lon to a target CRS's projected E/N — the inverse of
 * {@link projToLatLon}, and the projection direction the survey GENERATOR needs to
 * turn map picks (lat/lon) into station coordinates. Mirrors the forward step
 * inside {@link reprojectSPS}: a GEO target echoes lon/lat straight into E/N; every
 * other subtype goes through {@link latLonToProj}, applying the target's Helmert
 * datum shift + projection. Pure.
 */
export function lonLatToProj(lat: number, lon: number, tgt: CRS, elev = 0): EN {
  if (tgt.subtype === 'GEO') return { E: lon, N: lat };
  const tgtProj: Projection = {
    subtype: tgt.subtype, zone: tgt.zone, hemi: tgt.hemi, a: tgt.a, f: tgt.f,
    lon0: tgt.lon0, lat0: tgt.lat0, k0: tgt.k0, FE: tgt.FE, FN: tgt.FN, helmert: tgt.helmert,
  };
  return latLonToProj(lat, lon, tgtProj, elev);
}

/** Reproject one SPS file's lines from `sourceProj` to target `tgt`; returns new file text. */
export function reprojectSPS(srcLines: string[], tgt: CRS, spsType: 'S' | 'R' | 'X', sourceProj: SPSProjection): string {
  const out: string[] = [];
  const srcP = toProj(sourceProj);
  const tgtProj: Projection = { subtype: tgt.subtype, zone: tgt.zone, hemi: tgt.hemi, a: tgt.a, f: tgt.f, lon0: tgt.lon0, lat0: tgt.lat0, k0: tgt.k0, FE: tgt.FE, FN: tgt.FN, helmert: tgt.helmert };
  // Single source of truth for the projection H-records (shared with the
  // header-only CRS edit in spsApplyHeaders): replace any matching existing
  // H-record in place, leaving all other records (and S/R lines) untouched.
  const projHeaders = generateProjHeaders(tgt);

  for (const raw of srcLines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const t = line[0];

    if (t === 'H') {
      // Use the canonical H-code parser so the record this rewrites is exactly the
      // one parseSPSText recognises (the old substring(0,3)+digit-check diverged).
      const code = hRecCode(line);
      const gen = code ? projHeaders[code] : undefined;
      if (gen != null) { out.push(gen); continue; }
      out.push(raw.trimEnd());
      continue;
    }

    if ((t === 'S' || t === 'R') && spsType !== 'X') {
      // Detect the SAME layout the parser uses and write the new coordinates back
      // into THAT layout's columns. Hardcoding the SPS2.1 columns produced NaN for
      // a legacy-layout file (→ the S/R line was emitted unchanged in the SOURCE
      // CRS while the H-records were rewritten to the target CRS — a silent datum
      // mismatch). Layout 'D' (whitespace-delimited) has no fixed span, so such a
      // line is left unchanged rather than mis-columned.
      const padded = line.padEnd(80, ' ');
      const coords = spsParseCoords(padded);
      const span = coords ? SPS_COORD_SPANS[coords.layout] : undefined;
      if (coords && span && isFinite(coords.e) && isFinite(coords.n)) {
        const ll = projToLatLon(coords.e, coords.n, srcP, 0);
        const newEN = tgt.subtype === 'GEO' ? { E: ll.lon, N: ll.lat } : latLonToProj(ll.lat, ll.lon, tgtProj, 0);
        const eW = span.eEnd - span.eStart;
        const nW = span.nEnd - span.nStart;
        // Right-justify within the field; truncate (never pad past) the width so a
        // value too large for the field (e.g. a southern-hemisphere northing of
        // 10,000,000 in a 10-col field) can't push every later column one place to
        // the right. fitNum keeps as many decimals as fit, else clips the string.
        const newE = fitNum(newEN.E, eW);
        const newN = fitNum(newEN.N, nW);
        out.push(padded.substring(0, span.eStart) + newE + newN + padded.substring(span.tail).trimEnd());
        continue;
      }
    }
    out.push(raw.trimEnd());
  }
  return out.join('\n');
}
