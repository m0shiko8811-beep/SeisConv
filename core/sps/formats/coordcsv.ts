// seisconv-core / sps / formats - generic coordinate CSV parser + writer.
//
// A column-mapped CSV of survey points: the user (or a sniffer) maps CSV columns
// onto SPSPoint fields (rtype/line/point/idx/easting/northing/elevation/…). It
// maps onto the SAME SPSData model so every downstream view is format-agnostic,
// and round-trips (parse → buildCoordCsv).
//
// COORDINATES: projected easting/northing is the primary form. A file carrying only
// lat/long is forward-projected into the `# CRS:` tag's grid, or - when it has no
// tag - into the WGS84 UTM zone of its first valid point, and the original degrees
// are preserved on SPSPoint.lat/.lon. Every downstream metric (station interval,
// offset, QC) therefore works in metres regardless of how the file was written.
//
// SECURITY: dynamic column→field keys are ATTACKER-CONTROLLED. Phase-2 MUST
// validate every mapped key and REJECT `__proto__` / `constructor` / `prototype`
// (a prototype-pollution finding was just fixed in the obslog importer - apply the
// same guard here). PURE: no DOM, no Node - runs in the worker AND in unit tests.

import type { SPSData, SPSPoint, SPSProjection } from '../parse';
import { EPSG_DB, lonLatToProj, searchEPSG, type CRS } from '../reproject';

/** A fresh, empty SPSData - the value the stub returns until phase-2 fills it. */
function emptySPSData(): SPSData {
  return { sources: [], receivers: [], xrefs: [], headers: [], errors: [], skipped: 0, layout: null };
}

// -- DoS bounds (mirror the binary parsers' MAX_TRACES / MAX_SAMPLES discipline) --
/** Hard cap on parsed points - never allocate from an unbounded record count. */
const MAX_POINTS = 2_000_000;
/** Hard cap on the length of any single CSV line we will tokenize. */
const MAX_LINE_LEN = 64 * 1024;
/** Hard cap on the number of columns we will track for a row (defends a line of all-commas). */
const MAX_COLS = 4096;
/** Hard cap on the total number of physical lines we will scan. */
const MAX_LINES = 8_000_000;

// -- prototype-pollution guard --
//
// The column→field map keys are derived from an ATTACKER-CONTROLLED header row.
// We only ever write to a small fixed set of SPSPoint fields, but defence in depth
// (matching the obslog importer fix) demands we reject any header that resolves to
// a dangerous object key before it is ever used as one, AND validate the charset.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True when `key` is safe to use as a dynamic object key. Exported for `planio.ts`,
 *  which applies the same guard to the line names it groups by. */
export function isSafeKey(key: string): boolean {
  if (!key) return false;
  if (DANGEROUS_KEYS.has(key)) return false;
  // Mapped field names are a closed vocabulary of ASCII identifiers; reject anything
  // outside [A-Za-z0-9_] so a crafted header can never smuggle a prototype path.
  return /^[A-Za-z0-9_]+$/.test(key);
}

// -- the canonical SPSPoint fields a CSV column may map to --
export type FieldName = 'lineName' | 'point' | 'rtype' | 'easting' | 'northing' | 'elevation' | 'lat' | 'lon' | 'idx';

/**
 * Column-name synonyms → canonical field. Case-insensitive: the header token is
 * lowercased + stripped of non-alphanumerics before lookup, so "Line Name",
 * "line_name" and "LINENAME" all collapse to the same key.
 *
 * Exported so `planio.ts`'s column-mapping wizard guesses from the SAME vocabulary
 * the automatic reader uses - one table, not two that drift apart.
 */
export const SYNONYMS: Record<string, FieldName> = {
  // line
  line: 'lineName', linename: 'lineName', lineno: 'lineName', linenumber: 'lineName', srcline: 'lineName', rcvline: 'lineName',
  // point / station
  point: 'point', station: 'point', sp: 'point', stn: 'point', pointnumber: 'point', pointno: 'point', shot: 'point', peg: 'point',
  // record type
  type: 'rtype', code: 'rtype', rtype: 'rtype', kind: 'rtype', srtype: 'rtype',
  // easting / x
  easting: 'easting', east: 'easting', x: 'easting', e: 'easting', xcoord: 'easting',
  // northing / y
  northing: 'northing', north: 'northing', y: 'northing', n: 'northing', ycoord: 'northing',
  // elevation / z
  elevation: 'elevation', elev: 'elevation', z: 'elevation', height: 'elevation', alt: 'elevation', altitude: 'elevation',
  // geographic (optional)
  lat: 'lat', latitude: 'lat',
  lon: 'lon', long: 'lon', lng: 'lon', longitude: 'lon',
  // index char
  idx: 'idx', index: 'idx', flag: 'idx',
};

/** Normalize a header token for synonym lookup: lowercase + drop non-alphanumerics. */
export function normToken(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Tokenize a single CSV line, honouring double-quoted fields ("a,b" → one cell,
 * "" → an escaped quote). Bounded: stops once MAX_COLS cells are produced so a
 * line of nothing-but-commas cannot grow an unbounded array.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
      if (out.length >= MAX_COLS) return out; // bound the column count
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Strip a single layer of surrounding quotes/whitespace from a raw cell. */
function cleanCell(s: string): string {
  return (s || '').trim();
}

/** Parse a number from a cell, tolerating thousands separators absent / present. */
function num(s: string): number {
  const v = parseFloat(cleanCell(s));
  return isFinite(v) ? v : NaN;
}

/**
 * Resolve a `# CRS:` / `# EPSG:` comment tag to a {@link CRS} registry entry.
 * Accepts forms like `# CRS: ITM`, `# EPSG:2039`, `#crs=utm 36n`. Returns
 * undefined when the tag names nothing we recognise.
 *
 * Exported because the survey-plan importer (`planio.ts`) needs the CRS itself -
 * to pre-select it in the column-mapping wizard and to project geographic rows -
 * not just the SPS projection record.
 */
export function resolveCrsTagCRS(tag: string): CRS | undefined {
  // Strip the leading comment marker + a CRS/EPSG label, keep the value.
  const m = /^[#;]*\s*(?:crs|epsg|coordinate\s*system|projection)\s*[:=]?\s*(.+)$/i.exec(tag.trim());
  let q = m ? m[1].trim() : '';
  // A bare `# EPSG:2039` puts the code in the label; recover the numeric code.
  if (!q) {
    const e = /epsg\s*[:=]?\s*(\d+)/i.exec(tag);
    if (e) q = e[1];
  }
  if (!q) return undefined;
  // Normalize "EPSG:2039" → "2039" so searchEPSG's numeric-code path matches.
  const codeOnly = /^(?:epsg\s*[:=]?\s*)?(\d{3,6})$/i.exec(q);
  let hit: CRS | undefined;
  if (codeOnly) {
    const code = 'EPSG:' + codeOnly[1];
    hit = EPSG_DB.find((c) => c.code === code);
  }
  if (!hit) {
    const hits = searchEPSG(q);
    hit = hits[0];
  }
  // Common bare names that searchEPSG may miss → map onto a known EPSG entry.
  if (!hit) {
    const ql = q.toLowerCase();
    if (/\bitm\b|israel/.test(ql)) hit = EPSG_DB.find((c) => c.code === 'EPSG:2039');
  }
  // Bare "UTM <zone><N|S>" / "UTM zone 36 North": searchEPSG misses it because the
  // DB names read "WGS 84 / UTM zone 36N" (the word "zone" breaks the substring
  // match). Parse zone+hemisphere directly and select the WGS84 UTM EPSG entry.
  if (!hit) {
    const um = /\butm\b[^0-9]*?(\d{1,2})\s*([ns]|north|south)?/i.exec(q);
    if (um) {
      const zone = parseInt(um[1], 10);
      const h = (um[2] || 'n').toLowerCase();
      const south = h === 's' || h === 'south';
      if (zone >= 1 && zone <= 60) {
        const code = 'EPSG:' + ((south ? 32700 : 32600) + zone);
        hit = EPSG_DB.find((c) => c.code === code);
      }
    }
  }
  return hit;
}

/** As {@link resolveCrsTagCRS}, but projected onto the SPS {@link SPSProjection} model. */
export function resolveCrsTag(tag: string): SPSProjection | undefined {
  const hit = resolveCrsTagCRS(tag);
  return hit ? crsToProjection(hit) : undefined;
}

/**
 * The WGS84 UTM {@link CRS} covering a geographic position - the fallback frame for
 * a lat/long CSV that carries no `# CRS:` tag, so downstream metric code (station
 * intervals, offsets, QC) has a real metre grid instead of degrees.
 *
 * Deliberately UTM-only: core stays free of regional preferences. A caller that
 * knows better (the renderer suggests ITM inside Israel) passes its own CRS.
 */
export function utmCrsForLatLon(lat: number, lon: number): CRS | undefined {
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  const code = 'EPSG:' + ((lat < 0 ? 32700 : 32600) + zone);
  return EPSG_DB.find((c) => c.code === code);
}

/** Project a reproject-module {@link CRS} onto the SPS {@link SPSProjection} model. */
function crsToProjection(crs: CRS): SPSProjection {
  return {
    type: crs.subtype === 'UTM' ? 'UTM' : crs.subtype === 'TM' ? 'Transverse Mercator' : crs.subtype === 'GEO' ? 'Geographic' : crs.name || null,
    subtype: crs.subtype || null,
    zone: crs.zone ?? null,
    hemi: crs.hemi ?? null,
    datum: crs.name || null,
    ellipsoid: null,
    a: crs.a ?? null,
    invF: crs.f ? 1 / crs.f : null,
    units: 'meters',
    unitFactor: 1.0,
    centralMeridian: crs.lon0 ?? null,
    latOrigin: crs.lat0 ?? null,
    falseEasting: crs.FE ?? null,
    falseNorthing: crs.FN ?? null,
    scaleFactor: crs.k0 ?? null,
    helmert: crs.helmert ?? null,
    source: 'coordcsv-tag',
    desc: crs.code || undefined,
  };
}

/** True when a line is a blank or a comment we should not treat as data/header. */
export function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return !t || t.startsWith('#') || t.startsWith(';');
}

/**
 * Decide whether the first data row is a HEADER (column names) or already data.
 * A header row is one where at least one cell maps to a known field synonym AND
 * the row is not parseable as a pure coordinate record (no two numeric coords).
 */
export function looksLikeHeader(cells: string[]): boolean {
  let mapped = 0;
  let numeric = 0;
  for (const c of cells) {
    if (SYNONYMS[normToken(c)]) mapped++;
    if (isFinite(parseFloat(cleanCell(c)))) numeric++;
  }
  // Header iff some columns name fields and the row isn't mostly numbers.
  return mapped >= 2 && numeric <= 1;
}

/**
 * Parse a generic coordinate CSV into the shared {@link SPSData} model.
 *
 * CONTRACT (do not change this signature): `(text: string) => SPSData`. Malformed
 * input must NEVER throw - collect problems into `errors` / `skipped` and keep
 * going.
 */
export function parseCoordCsv(text: string): SPSData {
  const out = emptySPSData();
  try {
    let body = text || '';
    // Strip a UTF-8 BOM.
    if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
    const lines = body.replace(/\r/g, '').split('\n');

    // -- pass 1: pull any CRS tag from the leading comment block --
    // `tagCrs` is kept alongside the projection record because the geographic
    // fallback below has to FORWARD-project lat/long, which needs the CRS itself.
    let tagCrs: CRS | undefined;
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) continue;
      if (t.startsWith('#') || t.startsWith(';')) {
        if (/crs|epsg|coordinate|projection/i.test(t)) {
          const c = resolveCrsTagCRS(t);
          if (c && !tagCrs) tagCrs = c;
        }
        continue;
      }
      break; // first non-comment line ends the leading comment block
    }
    if (tagCrs) out.projection = crsToProjection(tagCrs);
    // Set on the first geographic row when no tag was present (see below).
    let autoCrs: CRS | undefined;

    // -- locate the header row (first non-comment, non-blank line) --
    let colMap: (FieldName | null)[] | null = null;
    let defaultType: 'S' | 'R' = 'R';

    let scanned = 0;
    for (let li = 0; li < lines.length; li++) {
      if (++scanned > MAX_LINES) {
        out.errors.push('coordcsv: line cap reached - file truncated');
        break;
      }
      const raw = lines[li];
      if (isCommentOrBlank(raw)) continue;
      // Bound per-line work: clip a pathologically long line.
      const line = raw.length > MAX_LINE_LEN ? raw.slice(0, MAX_LINE_LEN) : raw;
      const cells = splitCsvLine(line);

      // First data-ish line: detect + build the column map (or fall back to a
      // positional default when no header is present).
      if (!colMap) {
        if (looksLikeHeader(cells)) {
          colMap = cells.map((c) => {
            const f = SYNONYMS[normToken(c)] || null;
            // SECURITY: never let a header token become a dangerous object key.
            // (Our field set is fixed, but validate defensively all the same.)
            if (f && !isSafeKey(f)) return null;
            return f;
          });
          continue; // header consumed; data starts next line
        }
        // No header → positional layout, chosen by COLUMN COUNT of this first data
        // row. A 2-column E,N file must map to easting,northing - the old fixed
        // line,point,easting,northing,elevation map put E,N into lineName/point,
        // leaving easting/northing undefined → NaN → every row silently skipped.
        const n = cells.length;
        colMap =
          n <= 2 ? ['easting', 'northing']
          : n === 3 ? ['easting', 'northing', 'elevation']
          : ['lineName', 'point', 'easting', 'northing', 'elevation'];
        // fall through and parse THIS line as data
      }

      // -- parse a data row against the column map --
      if (out.sources.length + out.receivers.length >= MAX_POINTS) {
        out.errors.push(`coordcsv: point cap (${MAX_POINTS}) reached - file truncated`);
        break;
      }

      const fields: Record<string, string> = Object.create(null);
      for (let c = 0; c < cells.length && c < colMap.length; c++) {
        const f = colMap[c];
        if (!f) continue;
        if (!isSafeKey(f)) continue; // belt-and-suspenders
        fields[f] = cleanCell(cells[c]);
      }

      let easting = num(fields.easting);
      let northing = num(fields.northing);
      // Projected E/N takes precedence. A file that has only lat/long columns (what
      // the map-based survey-plan editor exports) is projected into the tagged CRS,
      // or into the WGS84 UTM zone of its first valid point when it carries no tag.
      // Without this branch every geographic row was silently skipped.
      let lat = NaN;
      let lon = NaN;
      if (!isFinite(easting) || !isFinite(northing)) {
        lat = num(fields.lat);
        lon = num(fields.lon);
        if (!isFinite(lat) || !isFinite(lon)) {
          out.skipped++;
          if (out.errors.length < 50) out.errors.push(`L${li + 1}: cannot parse coords [${line.slice(0, 40).trimEnd()}]`);
          continue;
        }
        // Range-guard BEFORE trusting the pair - an out-of-range degree is a
        // mis-mapped column, not a coordinate, and must never reach the projector.
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          out.skipped++;
          if (out.errors.length < 50) out.errors.push(`L${li + 1}: lat/long out of range (${lat}, ${lon})`);
          continue;
        }
        if (!tagCrs && !autoCrs) {
          autoCrs = utmCrsForLatLon(lat, lon);
          if (autoCrs) {
            out.projection = { ...crsToProjection(autoCrs), source: 'coordcsv-latlon-auto' };
            out.errors.unshift(`coordcsv: no "# CRS:" tag - lat/long auto-projected to ${autoCrs.code}; add "# CRS: EPSG:nnnn" to override`);
          }
        }
        const crs = tagCrs ?? autoCrs;
        const en = crs ? lonLatToProj(lat, lon, crs) : null;
        if (!en || !isFinite(en.E) || !isFinite(en.N)) {
          out.skipped++;
          if (out.errors.length < 50) out.errors.push(`L${li + 1}: cannot project lat/long (${lat}, ${lon})`);
          continue;
        }
        easting = en.E;
        northing = en.N;
      }

      // Record type: explicit column ('S'/'R'), else the file/column default.
      let rtype: 'S' | 'R' = defaultType;
      const rawType = (fields.rtype || '').trim().toUpperCase();
      if (rawType) {
        if (rawType[0] === 'S') rtype = 'S';
        else if (rawType[0] === 'R') rtype = 'R';
      }

      const pt: SPSPoint = {
        rtype,
        lineName: (fields.lineName || '').trim(),
        point: isFinite(num(fields.point)) ? num(fields.point) : 0,
        idx: (fields.idx || '').trim(),
        easting,
        northing,
        elevation: isFinite(num(fields.elevation)) ? num(fields.elevation) : 0,
        raw,
        lineNum: li + 1,
        // Geographic source coordinates are preserved verbatim; the E/N above is
        // derived from them, so keeping both lets a consumer avoid a round-trip.
        ...(isFinite(lat) ? { lat, lon } : {}),
      };
      if (rtype === 'S') out.sources.push(pt);
      else out.receivers.push(pt);
    }

    out.layout = 'coordcsv';
    if (out.skipped > 0) out.errors.unshift(`${out.skipped} record(s) skipped (coord parse failed)`);
    // Surface a clear, actionable error when the file had rows but produced no
    // points (e.g. an unexpected column layout the positional fallback misread),
    // rather than returning a silently-empty survey with only a skipped count.
    if (out.sources.length + out.receivers.length === 0 && out.skipped > 0) {
      out.errors.unshift('coordcsv: no points parsed - check the column layout (expected easting,northing[,elevation] or line,point,easting,northing,elevation; lat,long columns are also accepted)');
    }
  } catch (e) {
    // A parser must NEVER throw - surface the failure and return what we have.
    out.errors.push(`coordcsv: internal error - ${(e as Error).message}`);
  }
  return out;
}

/** Quote a CSV cell only when it contains a comma, quote, or newline. */
function csvCell(v: string): string {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Number → clean CSV string. Integers stay integer; non-integers are written at
 *  full double precision (trailing zeros trimmed by String()), so high-precision
 *  survey coordinates and geographic degrees survive the write losslessly rather
 *  than being truncated to 3 dp. */
function fmtNum(v: number): string {
  if (!isFinite(v)) return '';
  if (Number.isInteger(v)) return String(v);
  return String(v);
}

/** Build the `# CRS:` tag line for a projection, or '' when none is known. The tag
 *  MUST be readable back by {@link resolveCrsTag} so a parse→build→parse round-trip
 *  preserves the projection (an un-resolvable label silently loses the CRS). */
function crsTagLine(p?: SPSProjection): string {
  if (!p) return '';
  // Prefer an EPSG code from the projection's desc (we stamp it there on import).
  const epsg = p.desc && /EPSG:\d+/i.exec(p.desc);
  if (epsg) return `# CRS: ${epsg[0]}`;
  // UTM with no EPSG code (the common SPS-derived case): reverse-lookup the WGS84
  // UTM EPSG code so the tag carries a round-trippable code rather than a bare
  // "UTM 36N" label that searchEPSG can't read back.
  if (p.subtype === 'UTM' && p.zone != null) {
    const south = p.hemi === 'S';
    const code = 'EPSG:' + ((south ? 32700 : 32600) + p.zone);
    if (EPSG_DB.some((c) => c.code === code)) return `# CRS: ${code}`;
    // Fall back to a zone label resolveCrsTag's UTM heuristic still understands.
    return `# CRS: UTM zone ${p.zone}${p.hemi || 'N'}`;
  }
  const label = p.type || p.subtype || p.datum;
  return label ? `# CRS: ${label}` : '';
}

/**
 * Serialize an {@link SPSData} survey to a coordinate CSV file.
 *
 * CONTRACT (do not change this signature): `(data: SPSData) => {name,text}[]`.
 * Emits a `# CRS:` tag (when the survey carries a projection), a header row, and
 * one row per source/receiver: line,point,type,idx,easting,northing,elevation.
 * The `idx` column round-trips the SPS index/flag character (a recognised input
 * synonym) so an SPS→CSV→SPS pipeline does not silently discard it.
 */
export function buildCoordCsv(data: SPSData): { name: string; text: string }[] {
  const lines: string[] = [];
  const tag = crsTagLine(data.projection);
  if (tag) lines.push(tag);
  lines.push('line,point,type,idx,easting,northing,elevation');

  const emit = (p: SPSPoint): void => {
    lines.push(
      [
        csvCell(p.lineName || ''),
        csvCell(fmtNum(p.point)),
        p.rtype,
        csvCell(p.idx || ''),
        csvCell(fmtNum(p.easting)),
        csvCell(fmtNum(p.northing)),
        csvCell(fmtNum(p.elevation)),
      ].join(','),
    );
  };
  for (const p of data.sources) emit(p);
  for (const p of data.receivers) emit(p);

  return [{ name: 'coordinates.csv', text: lines.join('\n') + '\n' }];
}
