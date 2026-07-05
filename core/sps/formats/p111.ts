// seisconv-core / sps / formats — IOGP P1/11 (P1-11) positioning parser + writer.
//
// P1/11 is the IOGP/UKOOA modern, COMMA-DELIMITED, RELATIONAL post-plot
// positioning exchange format (v1.1 added LAND + OBC). Unlike the fixed-column
// SPS family, records are RECORD-TYPE CODED: the first comma-field is a record
// tag, and the remaining fields are positional. A header block carries the
// project + CRS/datum/projection/units; point records carry point type
// (source/receiver), line name, point number, projected E/N, height (and, where
// present, geodetic lat/long); relation/event records tie a source shot to the
// receiver span it recorded.
//
// The IOGP spec PDF is paywalled, so this implements the well-known P1/11
// structure with a SELF-DESCRIBING, record-coded grammar that round-trips
// (parseP111 → buildP111 → parseP111 is stable on the points). It maps onto the
// SAME SPSData model so every downstream view (geometry, fold, QC, export) is
// format-agnostic. The projection is recovered into SPSProjection reusing the
// shared coords/EPSG handling (ITM / UTM / TM).
//
// SECURITY (a full audit JUST shipped — do not regress it):
//  - DoS bounds: MAX_POINTS caps total emitted records; MAX_LINE_LEN caps any
//    single attacker-controlled line; we never allocate from an unbounded count.
//  - Malformed input NEVER throws: problems land in errors / skipped, parse goes on.
//  - No dynamic object keys are built from attacker data, so there is no
//    prototype-pollution surface here (cf. the coordcsv / obslog guard).
//
// PURE: no DOM, no Node — runs in the worker AND in unit tests.

import { projToLatLon, type Projection } from '../../coords';
import type { SPSData, SPSPoint, SPSXref, SPSProjection } from '../parse';
import { spsExtractProjection } from '../parse';

// ── DoS bounds (mirror the SPS / SEG-D MAX_TRACES discipline) ──
const MAX_POINTS = 2_000_000; // hard cap on sources + receivers + xrefs combined
const MAX_LINE_LEN = 4096; // a conformant P1/11 record is short; clamp hostile lines
const MAX_FIELDS = 64; // record fields are positional + few; bound the split

/** A fresh, empty SPSData. */
function emptySPSData(): SPSData {
  return { sources: [], receivers: [], xrefs: [], headers: [], errors: [], skipped: 0, layout: null };
}

/** Map the parsed SPSProjection onto the coords {@link Projection} used by
 *  projToLatLon (same shape the reprojector's private `toProj` produces). */
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

/** Parse a finite number from a CSV field, else NaN (never throws). */
function num(s: string | undefined): number {
  if (s == null) return NaN;
  const v = parseFloat(s.trim());
  return isFinite(v) ? v : NaN;
}

/** Split a P1/11 record into trimmed, length-bounded fields. */
function fields(line: string): string[] {
  const clamped = line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) : line;
  const parts = clamped.split(',');
  // Bound the number of fields we retain so a hostile line of thousands of
  // commas can't blow up later per-field work.
  if (parts.length > MAX_FIELDS) parts.length = MAX_FIELDS;
  return parts.map((p) => p.trim());
}

// ── Header → SPSHeader (H-record) bridge ──
//
// We translate the P1/11 CRS header fields into the SAME H-record codes the SPS
// header machinery already understands, then run the shared spsExtractProjection
// over them. That reuses the KNOWN-CRS handling (ITM / UTM / TM / Helmert) with
// zero duplication and keeps the projection model byte-identical with the SPS path.
function projectionFromHeaders(
  crsName: string | null,
  subtype: string | null,
  zone: number | null,
  hemi: string | null,
  ellipsoidName: string | null,
  a: number | null,
  invF: number | null,
  lon0: number | null,
  lat0: number | null,
  k0: number | null,
  fe: number | null,
  fn: number | null,
  helmert: number[] | null,
  unitFactor: number | null,
): SPSProjection {
  const hdrs: { code: string; val: string; raw: string }[] = [];
  const push = (code: string, val: string) => hdrs.push({ code, val, raw: `${code} ${val}` });

  if (a != null && invF != null) push('H12', `${ellipsoidName || crsName || ''} ${a} ${invF};`.trim());
  else if (ellipsoidName) push('H12', `${ellipsoidName};`);

  if (helmert && helmert.length >= 3) push('H14', `${helmert.slice(0, 7).join(' ')};`);

  // H18 = projection type/name. Feed both an explicit subtype and the CRS name so
  // spsExtractProjection's KNOWN map (and its UTM / TM heuristics) can resolve it.
  const typeText = subtype || crsName || '';
  if (typeText) push('H18', `${typeText};`);
  if (zone != null) push('H19', `${zone}${hemi === 'S' ? ' South' : hemi === 'N' ? ' North' : ''};`);
  if (unitFactor != null && isFinite(unitFactor) && unitFactor > 0) push('H201', `${unitFactor};`);
  if (lon0 != null) push('H220', encodeLon(lon0));
  if (lat0 != null) push('H231', encodeLat(lat0));
  if (fe != null || fn != null) push('H232', `${fe ?? 0}E ${fn ?? 0}N;`);
  if (k0 != null) push('H241', `${k0};`);

  const proj = spsExtractProjection(hdrs);
  // Carry forward the explicit CRS name as a human description when present.
  if (crsName && !proj.desc) proj.desc = crsName;
  if (subtype && !proj.subtype) proj.subtype = subtype;
  if (zone != null && proj.zone == null) proj.zone = zone;
  if ((hemi === 'N' || hemi === 'S') && proj.hemi == null) proj.hemi = hemi;
  proj.source = 'p111';
  return proj;
}

/** Encode a signed decimal-degrees longitude into the DDDMMSS.s;E/W token
 *  spsParseDMSlon understands. */
function encodeLon(deg: number): string {
  const w = deg < 0;
  const a = Math.abs(deg);
  let d = Math.floor(a);
  let m = Math.floor((a - d) * 60);
  let s = ((a - d) * 60 - m) * 60;
  ({ d, m, s } = carryDMS(d, m, s)); // round seconds to 3dp and carry any 60s overflow
  const dd = String(d).padStart(3, '0');
  const mm = String(m).padStart(2, '0');
  const ss = padSec(s);
  return `${dd}${mm}${ss}${w ? 'W' : 'E'};`;
}

/** Round seconds to 3 decimals and carry a resulting 60.000 up into minutes/degrees,
 *  so the encoded SS field is always < 60 (s=59.9997 ⇒ 00 sec + 1 minute, not "60.000"
 *  which spsParseDMS reads as +1 arc-minute, breaking the round-trip). */
function carryDMS(d: number, m: number, s: number): { d: number; m: number; s: number } {
  s = Math.round(s * 1000) / 1000;
  if (s >= 60) { s -= 60; m += 1; }
  if (m >= 60) { m -= 60; d += 1; }
  return { d, m, s };
}

/** Two-digit-integer, 3-decimal seconds field ("SS.sss") for the DMS tokens the
 *  shared SPS H-record parsers expect (`\d{2}\.\d+`). */
function padSec(s: number): string {
  const fixed = s.toFixed(3); // e.g. "3.817" or "12.034"
  const dot = fixed.indexOf('.');
  const intPart = dot >= 0 ? fixed.slice(0, dot) : fixed;
  const frac = dot >= 0 ? fixed.slice(dot) : '.000';
  return intPart.padStart(2, '0') + frac;
}

/** Encode a signed decimal-degrees latitude into the DDDMMSS.s;N/S token
 *  spsParseDMSlat understands (it requires a 3-digit degree field). */
function encodeLat(deg: number): string {
  const sgn = deg < 0;
  const a = Math.abs(deg);
  let d = Math.floor(a);
  let m = Math.floor((a - d) * 60);
  let s = ((a - d) * 60 - m) * 60;
  ({ d, m, s } = carryDMS(d, m, s)); // round seconds to 3dp and carry any 60s overflow
  const dd = String(d).padStart(3, '0');
  const mm = String(m).padStart(2, '0');
  const ss = padSec(s);
  return `${dd}${mm}${ss}${sgn ? 'S' : 'N'};`;
}

/**
 * Parse IOGP P1/11 positioning text into the shared {@link SPSData} model.
 *
 * Record grammar (first comma-field is the record tag; case-insensitive):
 *   H,1,1[,…]                              format/provenance banner (ignored)
 *   H,PROJECT,<name>                       project name
 *   H,CRS,<code>,<name>,<subtype>,<zone>,<hemi>
 *   H,ELLIPSOID,<a>,<invF>[,<name>]
 *   H,PROJPARAMS,<lon0>,<lat0>,<k0>,<FE>,<FN>
 *   H,HELMERT,<dx>,<dy>,<dz>,<rx>,<ry>,<rz>,<ds>
 *   H,UNITS,<name>,<factorToMetres>
 *   P,<S|R>,<line>,<point>,<idx>,<E>,<N>,<height>[,<lat>,<lon>]
 *   E,<srcLine>,<srcPt>,<ffid>,<rcvLineFrom>,<rcvPtFrom>,<rcvPtTo>[,<chFrom>,<chTo>]
 *
 * CONTRACT (do not change this signature): `(text: string) => SPSData`. Never
 * throws — malformed records land in errors / skipped and parsing continues.
 */
export function parseP111(text: string): SPSData {
  const out = emptySPSData();
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.length && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);

  // CRS header accumulation.
  let projectName: string | null = null;
  let crsCode: string | null = null;
  let crsName: string | null = null;
  let subtype: string | null = null;
  let zone: number | null = null;
  let hemi: string | null = null;
  let ellipsoidName: string | null = null;
  let a: number | null = null;
  let invF: number | null = null;
  let lon0: number | null = null;
  let lat0: number | null = null;
  let k0: number | null = null;
  let fe: number | null = null;
  let fn: number | null = null;
  let helmert: number[] | null = null;
  let unitFactor: number | null = null;
  let sawCrs = false;

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    if (!raw.trim()) continue;
    if (out.sources.length + out.receivers.length + out.xrefs.length >= MAX_POINTS) {
      out.errors.push(`P1/11: record cap (${MAX_POINTS}) reached at L${li + 1}; remaining records ignored`);
      break;
    }
    const f = fields(raw);
    const tag = (f[0] || '').toUpperCase();

    if (tag === 'H') {
      // Keep the raw header for the Header Viewer (length already clamped by fields()).
      out.headers.push({ code: 'H', val: raw.slice(0, MAX_LINE_LEN), raw: raw.slice(0, MAX_LINE_LEN) });
      const sub = (f[1] || '').toUpperCase();
      if (sub === 'PROJECT') projectName = f.slice(2).join(',').trim() || null;
      else if (sub === 'CRS') {
        sawCrs = true;
        crsCode = f[2] || null;
        crsName = f[3] || null;
        subtype = (f[4] || '').toUpperCase() || null;
        const z = num(f[5]);
        zone = isFinite(z) ? z : null;
        const h = (f[6] || '').toUpperCase();
        hemi = h === 'N' || h === 'S' ? h : null;
      } else if (sub === 'ELLIPSOID') {
        const av = num(f[2]);
        const iv = num(f[3]);
        a = isFinite(av) ? av : null;
        invF = isFinite(iv) ? iv : null;
        ellipsoidName = f[4] || null;
      } else if (sub === 'PROJPARAMS') {
        const v0 = num(f[2]); lon0 = isFinite(v0) ? v0 : null;
        const v1 = num(f[3]); lat0 = isFinite(v1) ? v1 : null;
        const v2 = num(f[4]); k0 = isFinite(v2) ? v2 : null;
        const v3 = num(f[5]); fe = isFinite(v3) ? v3 : null;
        const v4 = num(f[6]); fn = isFinite(v4) ? v4 : null;
      } else if (sub === 'HELMERT') {
        const h = f.slice(2, 9).map(num);
        if (h.length >= 3 && h.slice(0, 3).every((x) => isFinite(x))) helmert = h.map((x) => (isFinite(x) ? x : 0));
      } else if (sub === 'UNITS') {
        const fac = num(f[3]);
        unitFactor = isFinite(fac) && fac > 0 ? fac : null;
      }
      continue;
    }

    if (tag === 'P') {
      // P,<S|R>,line,point,idx,E,N,height[,lat,lon]
      const ptype = (f[1] || '').toUpperCase();
      const rtype: 'S' | 'R' | null = ptype === 'S' ? 'S' : ptype === 'R' ? 'R' : null;
      if (!rtype) {
        out.skipped++;
        out.errors.push(`L${li + 1}: P record — unknown point type [${f[1] || ''}]`);
        continue;
      }
      const e = num(f[5]);
      const n = num(f[6]);
      if (!isFinite(e) || !isFinite(n)) {
        out.skipped++;
        out.errors.push(`L${li + 1}: P record — cannot parse E/N [${f[5] || ''},${f[6] || ''}]`);
        continue;
      }
      const pt = num(f[3]);
      const z = num(f[7]);
      const p: SPSPoint = {
        rtype,
        lineName: f[2] || '',
        point: isFinite(pt) ? pt : 0,
        idx: f[4] || '',
        easting: e,
        northing: n,
        elevation: isFinite(z) ? z : 0,
        raw: raw.slice(0, MAX_LINE_LEN),
        lineNum: li + 1,
      };
      if (rtype === 'S') out.sources.push(p);
      else out.receivers.push(p);
      continue;
    }

    if (tag === 'E') {
      // E,srcLine,srcPt,ffid,rcvLineFrom,rcvPtFrom,rcvPtTo[,chFrom,chTo]
      const xr: SPSXref = {
        srcLine: f[1] || '',
        srcPt: num(f[2]),
        ffid: num(f[3]),
        rcvLineFrom: f[4] || '',
        rcvLine: f[4] || '',
        rcvPtFrom: num(f[5]),
        rcvPtTo: num(f[6]),
        fromCh: num(f[7]),
        toCh: num(f[8]),
        layout: 'p111',
        raw: raw.slice(0, MAX_LINE_LEN),
        lineNum: li + 1,
      };
      out.xrefs.push(xr);
      continue;
    }

    // Unknown record tag — count it, keep going.
    out.skipped++;
    out.errors.push(`L${li + 1}: unrecognised P1/11 record tag [${tag}]`);
  }

  out.layout = 'p111';
  if (out.skipped > 0) out.errors.unshift(`${out.skipped} record(s) skipped (P1/11)`);
  if (sawCrs || a != null || subtype != null || lon0 != null || helmert != null) {
    // H,CRS,<code/desc>,<name/datum>,…  — field f[2] (crsCode) carries the human
    // CRS DESCRIPTION (buildP111 writes proj.desc there); f[3] (crsName) is the
    // datum. Prefer crsCode as the description source so the human CRS label
    // survives a parse→build→parse round-trip (it would otherwise drift to the
    // datum string). Fall back to crsName when no code/desc is present.
    out.projection = projectionFromHeaders(
      crsCode || crsName,
      subtype,
      zone,
      hemi,
      ellipsoidName,
      a,
      invF,
      lon0,
      lat0,
      k0,
      fe,
      fn,
      helmert,
      unitFactor,
    );
  }
  // Stash the project name in a header so the Header Viewer can show it even when
  // no CRS block was present. (Already pushed as a raw H above; nothing else to do.)
  void projectName;
  return out;
}

/** Normalize a unit name to an IOGP-conventional token. The internal model uses
 *  the lowercase 'meters' produced by spsExtractProjection; map the metre family to
 *  the spec-conventional 'METRE', and uppercase anything else, defaulting to METRE. */
function normUnitName(u: string | null | undefined): string {
  const s = (u || '').trim().toLowerCase();
  if (!s || s === 'meter' || s === 'meters' || s === 'metre' || s === 'metres' || s === 'm') return 'METRE';
  return (u as string).trim().toUpperCase();
}

/** Round a finite number to a stable, comma-safe string (drop trailing zeros). */
function fmt(v: number | undefined, dp = 3): string {
  if (v == null || !isFinite(v)) return '';
  // toFixed then strip trailing zeros so a round-trip stays numerically stable.
  return String(parseFloat(v.toFixed(dp)));
}

/**
 * Serialize an {@link SPSData} survey back to IOGP P1/11 text.
 *
 * Emits the comma-delimited header block (project + CRS/ellipsoid/proj-params/
 * Helmert/units derived from data.projection) followed by one P record per
 * source/receiver and one E record per relation. Geodetic lat/long columns are
 * filled via projToLatLon when the projection is resolvable, so the export is a
 * complete, self-describing positioning file.
 *
 * CONTRACT (do not change this signature): `(data: SPSData) => {name,text}[]`.
 */
export function buildP111(data: SPSData): { name: string; text: string }[] {
  const lines: string[] = [];
  const proj = data.projection;

  lines.push('H,1,1,IOGP P1/11 v1.1,SeisConv');
  lines.push('H,PROJECT,SeisConv export');

  if (proj) {
    const subtype = (proj.subtype || proj.type || '').toString();
    lines.push(
      `H,CRS,${proj.desc || ''},${(proj.datum || proj.desc || '').toString()},${subtype},${proj.zone ?? ''},${proj.hemi ?? ''}`,
    );
    if (proj.a != null && proj.invF != null) {
      lines.push(`H,ELLIPSOID,${fmt(proj.a, 4)},${fmt(proj.invF, 9)},${(proj.ellipsoid || '').toString()}`);
    }
    if (
      proj.centralMeridian != null ||
      proj.latOrigin != null ||
      proj.scaleFactor != null ||
      proj.falseEasting != null ||
      proj.falseNorthing != null
    ) {
      lines.push(
        `H,PROJPARAMS,${fmt(proj.centralMeridian ?? undefined, 9)},${fmt(proj.latOrigin ?? undefined, 9)},${fmt(
          proj.scaleFactor ?? undefined,
          9,
        )},${fmt(proj.falseEasting ?? undefined, 4)},${fmt(proj.falseNorthing ?? undefined, 4)}`,
      );
    }
    if (proj.helmert) {
      const h = proj.helmert;
      lines.push(
        `H,HELMERT,${fmt(h.dx, 4)},${fmt(h.dy, 4)},${fmt(h.dz, 4)},${fmt(h.rx, 6)},${fmt(h.ry, 6)},${fmt(h.rz, 6)},${fmt(
          h.ds,
          6,
        )}`,
      );
    }
    lines.push(`H,UNITS,${normUnitName(proj.units)},${fmt(proj.unitFactor ?? 1, 9) || '1'}`);
  }

  const cProj = proj ? toProj(proj) : undefined;
  const canGeo = !!(cProj && cProj.subtype && cProj.subtype !== 'GEO');

  let emitted = 0;
  const emit = (p: SPSPoint, rtype: 'S' | 'R'): void => {
    if (emitted >= MAX_POINTS) return;
    let latCol = '';
    let lonCol = '';
    if (canGeo && isFinite(p.easting) && isFinite(p.northing)) {
      try {
        const ll = projToLatLon(p.easting, p.northing, cProj, p.elevation || 0);
        if (isFinite(ll.lat) && isFinite(ll.lon)) {
          latCol = fmt(ll.lat, 8);
          lonCol = fmt(ll.lon, 8);
        }
      } catch {
        /* lat/long is optional — leave blank on any conversion error */
      }
    }
    lines.push(
      `P,${rtype},${p.lineName ?? ''},${fmt(p.point, 4)},${p.idx ?? ''},${fmt(p.easting, 3)},${fmt(
        p.northing,
        3,
      )},${fmt(p.elevation, 3)}${latCol || lonCol ? `,${latCol},${lonCol}` : ''}`,
    );
    emitted++;
  };

  for (const s of data.sources) emit(s, 'S');
  for (const r of data.receivers) emit(r, 'R');

  for (const x of data.xrefs) {
    if (emitted >= MAX_POINTS) break;
    const g = (k: string): string => {
      const v = (x as Record<string, unknown>)[k];
      if (v == null) return '';
      if (typeof v === 'number') return isFinite(v) ? String(v) : '';
      return String(v);
    };
    lines.push(
      `E,${g('srcLine')},${g('srcPt')},${g('ffid')},${g('rcvLineFrom')},${g('rcvPtFrom')},${g('rcvPtTo')},${g(
        'fromCh',
      )},${g('toCh')}`,
    );
    emitted++;
  }

  return [{ name: 'export.p111', text: lines.join('\n') + '\n' }];
}
