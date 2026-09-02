// seisconv-core / sps / formats - SEG-P1 positioning parser (READ-ONLY).
//
// SEG-P1 is the (now deprecated) SEG post-plot positioning point format: a fixed
// 80-column ASCII record per shot/receiver point carrying a line name, a point
// (shotpoint) number, geographic lat/long AND a projected UTM easting/northing +
// elevation, preceded by an 'H'-prefixed free-text header block (up to 20 records)
// that may name the ellipsoid / grid / UTM zone.
//
// It maps onto the SAME SPSData model as SPS so every downstream view (geometry,
// fold, QC, export) is format-agnostic. There is NO writer: SEG-P1 is deprecated,
// so this module is read-only by design.
//
// Documented column layout (1-based, per the SEG-P1 spec / IHS AccuMap reference):
//   col  1      record identifier (space, or a vendor S/R/V/E code)
//   cols 2-17   line name           (left-justified ASCII)
//   cols 18-25  shotpoint / point   (integer)
//   col  26     reshoot code        (space or A-Z)
//   cols 27-35  latitude            "ddmmssssh"  (h = N/S)   - hundredths-of-sec
//   cols 36-45  longitude           "dddmmssssh" (h = E/W)
//   cols 46-53  UTM easting         (integer, DECIMETRES)
//   cols 54-61  UTM northing        (integer, DECIMETRES)
//   cols 62-66  elevation           (integer, DECIMETRES)
//   cols 67-80  optional time / extra text
//
// PURE: no DOM, no Node - runs in the worker AND in unit tests.

import { spsExtractProjection, type SPSData, type SPSPoint, type SPSHeader, type SPSProjection } from '../parse';
import { latLonToProj, type Projection } from '../../coords';

// -- DoS bounds (mirror the binary parsers' MAX_TRACES / MAX_SAMPLES discipline) --
/** Hard cap on total point records materialized from one file. */
const MAX_POINTS = 2_000_000;
/** Hard cap on the per-line length we will inspect/store (a conformant record is
 *  80 cols; this bounds a hostile multi-MB single line without touching real data). */
const MAX_LINE_LEN = 4096;
/** SEG-P1's header block is "up to twenty records"; bound how many H lines we
 *  retain so a file that is ALL 'H' lines can't grow the header payload unbounded. */
const MAX_HEADERS = 4096;

/** A fresh, empty SPSData. */
function emptySPSData(): SPSData {
  return { sources: [], receivers: [], xrefs: [], headers: [], errors: [], skipped: 0, layout: null };
}

/** Fixed-column slice, end-exclusive, 0-based, trimmed. */
function col(s: string, a: number, b: number): string {
  return s.substring(a, b).trim();
}

/** Parse an integer field; returns NaN when blank/garbage (never throws). */
function intField(s: string, a: number, b: number): number {
  const v = col(s, a, b);
  if (!v) return NaN;
  // SEG-P1 numeric fields are signed integers; tolerate a leading sign and stray
  // non-digits by extracting the leading signed-integer token.
  const m = /^[+-]?\d+/.exec(v);
  return m ? parseInt(m[0], 10) : NaN;
}

/**
 * Parse a grid (E/N/elevation) field, returning a value already SCALED TO METRES.
 *
 * SEG-P1 has two field conventions for grid coordinates:
 *  - the IHS/AccuMap variant uses integer DECIMETRES (no decimal point) → /10 → m;
 *  - the original SEG-P1 / Golden Software SP1 variant uses F-format FLOATING-POINT
 *    grid units in METRES (a decimal point present) → used as-is.
 * We detect the form per field: a '.' means floating-point metres (no /10); a pure
 * integer is decimetres. This avoids the 10× position error a meters file ('660000.0')
 * would otherwise suffer. Returns NaN when blank/garbage (never throws).
 */
function gridFieldMetres(s: string, a: number, b: number): number {
  const v = col(s, a, b);
  if (!v) return NaN;
  // Floating-point form (decimal point present) → already metres, do NOT divide.
  if (v.indexOf('.') >= 0) {
    const m = /^[+-]?\d*\.\d+|^[+-]?\d+\.\d*/.exec(v);
    const f = m ? parseFloat(m[0]) : NaN;
    return isFinite(f) ? f : NaN;
  }
  // Pure-integer form → DECIMETRES; scale to metres.
  const mi = /^[+-]?\d+/.exec(v);
  const iv = mi ? parseInt(mi[0], 10) : NaN;
  return isFinite(iv) ? iv / 10 : NaN;
}

/** Map an {@link SPSProjection} onto the coords {@link Projection} that
 *  {@link latLonToProj} consumes (forward-direction param names). */
function toProj(p: SPSProjection): Projection {
  return {
    subtype: p.subtype ?? undefined,
    zone: p.zone ?? undefined,
    hemi: p.hemi ?? undefined,
    a: p.a ?? undefined,
    invF: p.invF ?? undefined,
    f: p.invF ? 1 / p.invF : undefined,
    lon0: p.centralMeridian ?? undefined,
    lat0: p.latOrigin ?? undefined,
    k0: p.scaleFactor ?? undefined,
    FE: p.falseEasting ?? undefined,
    FN: p.falseNorthing ?? undefined,
    helmert: p.helmert ?? undefined,
  };
}

/**
 * Parse a SEG-P1 packed geographic field "DDMMSSss[h]" (latitude, 2-digit degrees)
 * or "DDDMMSSss[h]" (longitude, 3-digit degrees), where SSss is seconds in
 * hundredths and h ∈ {N,S,E,W}. Returns signed decimal degrees, or null when the
 * field is blank / not in that form (e.g. a vendor that left it empty).
 *
 * `degDigits` is 2 for latitude, 3 for longitude.
 */
function parsePackedDMS(field: string, degDigits: number): number | null {
  let s = (field || '').trim();
  if (!s) return null;
  let sign = 1;
  // Trailing hemisphere letter (preferred) or a leading +/- sign.
  const hemi = s.slice(-1).toUpperCase();
  if (hemi === 'N' || hemi === 'S' || hemi === 'E' || hemi === 'W') {
    if (hemi === 'S' || hemi === 'W') sign = -1;
    s = s.slice(0, -1).trim();
  } else if (s[0] === '+' || s[0] === '-') {
    if (s[0] === '-') sign = -1;
    s = s.slice(1);
  }
  // Some vendors write a decimal-degree form "gg.ggggg" / "ggg.ggggg" instead of
  // the packed integer form - honour a plain decimal when present.
  if (s.includes('.') && !/^\d+$/.test(s.replace('.', ''))) return null;
  if (s.includes('.')) {
    const dec = parseFloat(s);
    return isFinite(dec) ? sign * dec : null;
  }
  // Packed integer form: need at least degDigits + 4 (MMSS) digits to be meaningful.
  if (!/^\d+$/.test(s)) return null;
  if (s.length < degDigits + 2) return null;
  const deg = parseInt(s.slice(0, degDigits), 10);
  const min = parseInt(s.slice(degDigits, degDigits + 2), 10);
  // Remaining digits are seconds in hundredths: "SSss" → SS.ss.
  const secRaw = s.slice(degDigits + 2);
  const sec = secRaw ? parseInt(secRaw, 10) / Math.pow(10, Math.max(0, secRaw.length - 2)) : 0;
  if (!isFinite(deg) || !isFinite(min) || !isFinite(sec)) return null;
  const v = deg + min / 60 + sec / 3600;
  return isFinite(v) ? sign * v : null;
}

/**
 * Derive an {@link SPSProjection} from the SEG-P1 'H' header block when it names a
 * UTM zone / datum. The header is free text, so we keyword-scan: a UTM zone, a
 * north/south hemisphere, and a coarse datum/ellipsoid token. When nothing
 * recognizable is present we return undefined so the user's CRS picker fills it.
 *
 * We reuse the SPS H-record machinery by synthesizing the few H-codes
 * {@link spsExtractProjection} understands (H18 projection type, H19 UTM zone,
 * H12 datum) - keeping a single source of truth for projection inference.
 */
function projectionFromHeaderText(headerLines: string[]): SPSProjection | undefined {
  const text = headerLines.join('\n');
  const up = text.toUpperCase();
  const synth: SPSHeader[] = [];

  // UTM zone, e.g. "UTM ZONE 36N", "UTM 31 NORTH", "ZONE 50S".
  const zoneM = /\bUTM[^0-9]{0,12}?(?:ZONE\s*)?(\d{1,2})\s*([NS]|NORTH|SOUTH)?/i.exec(up)
    || /\bZONE\s*(\d{1,2})\s*([NS]|NORTH|SOUTH)\b/i.exec(up);
  const isUTM = /\bUTM\b/.test(up);
  if (isUTM) {
    synth.push({ code: 'H18', val: 'UTM', raw: '' });
    if (zoneM) {
      const zone = parseInt(zoneM[1], 10);
      const h = (zoneM[2] || '').toUpperCase();
      const south = h === 'S' || h === 'SOUTH';
      if (zone >= 1 && zone <= 60) {
        synth.push({ code: 'H19', val: `${zone} ${south ? 'South' : 'North'}`, raw: '' });
      }
    }
  } else if (/TRANSVERSE\s+MERCATOR/.test(up) || /\bTM\b/.test(up)) {
    synth.push({ code: 'H18', val: 'Transverse Mercator', raw: '' });
  }

  // Datum / ellipsoid keyword (coarse - the H12 free-text parser tolerates it).
  let datum: string | null = null;
  if (/\bWGS\s*-?\s*84\b/.test(up)) datum = 'WGS84';
  else if (/\bNAD\s*-?\s*83\b/.test(up)) datum = 'NAD83';
  else if (/\bNAD\s*-?\s*27\b/.test(up)) datum = 'NAD27';
  else if (/\bGRS\s*-?\s*80\b/.test(up)) datum = 'GRS80';
  else if (/\bCLARKE\b/.test(up)) datum = 'Clarke';
  else if (/\bED\s*-?\s*50\b/.test(up)) datum = 'ED50';
  if (datum) synth.push({ code: 'H12', val: datum, raw: '' });

  if (!synth.length) return undefined;
  const proj = spsExtractProjection(synth);
  proj.source = 'segp1-header';
  return proj;
}

/**
 * Classify a SEG-P1 record's identifier column into a source/receiver rtype.
 * SEG-P1 post-plot files most commonly use a blank id (shotpoints) - so the
 * default is 'S'. Some vendors stamp a single-letter code; we honour the obvious
 * ones (R = receiver, V/G = geophone group → receiver; S/E = energy/source).
 * `headerDefault` lets a header keyword bias an all-blank file.
 */
function classifyRtype(idChar: string, headerDefault: 'S' | 'R'): 'S' | 'R' {
  const c = (idChar || '').trim().toUpperCase();
  if (c === 'R' || c === 'V' || c === 'G') return 'R';
  if (c === 'S' || c === 'E') return 'S';
  return headerDefault;
}

/**
 * Parse SEG-P1 positioning text into the shared {@link SPSData} model.
 *
 * Malformed input NEVER throws - problems land in `errors` / `skipped`. Obeys the
 * codebase DoS rules (MAX_POINTS, per-line + header caps; no allocation from an
 * unbounded attacker-controlled count/length).
 */
export function parseSegP1(text: string): SPSData {
  const out = emptySPSData();
  if (typeof text !== 'string' || !text) return out;

  const rawLines = text.replace(/\r/g, '').split('\n');
  if (rawLines.length && rawLines[0].charCodeAt(0) === 0xfeff) rawLines[0] = rawLines[0].slice(1);

  const headerLines: string[] = [];
  let truncatedHeaders = false;

  // First pass over the leading 'H' block to learn a default source/receiver bias.
  // (SEG-P1 is overwhelmingly a shotpoint file; the header rarely overrides this.)
  let headerDefault: 'S' | 'R' = 'S';

  // Pre-scan the leading 'H' block so the header-derived projection is available
  // WHILE parsing point records - a lat/long-only record must be projected to E/N
  // using this projection (otherwise its real position would be silently lost). We
  // collect the header lines again below; this is only the projection pre-pass.
  for (let li = 0; li < rawLines.length; li++) {
    const r = rawLines[li];
    if (!r || !r.trim()) continue;
    const rr = r.length > MAX_LINE_LEN ? r.slice(0, MAX_LINE_LEN) : r;
    if (rr[0].toUpperCase() === 'H') {
      if (headerLines.length < MAX_HEADERS) headerLines.push(rr);
      continue;
    }
    // First non-header, non-blank line ends the leading header block.
    if (rr[0] !== '*' && rr[0] !== '!' && rr[0] !== '#') break;
  }
  const headerProj = projectionFromHeaderText(headerLines);
  const headerProjCoords = headerProj ? toProj(headerProj) : null;
  // Reset the accumulator the main pass rebuilds (it also appends to out.headers).
  headerLines.length = 0;

  for (let li = 0; li < rawLines.length; li++) {
    const rawFull = rawLines[li];
    if (!rawFull || !rawFull.trim()) continue;

    // Bound the per-line work - never inspect/store more than MAX_LINE_LEN chars.
    const raw = rawFull.length > MAX_LINE_LEN ? rawFull.slice(0, MAX_LINE_LEN) : rawFull;
    const first = raw[0].toUpperCase();

    // -- header block --
    if (first === 'H') {
      if (headerLines.length < MAX_HEADERS) {
        const hVal = raw.slice(1).trim();
        headerLines.push(raw);
        out.headers.push({ code: 'H', val: hVal, raw });
        if (/\bRECEIVER\b/i.test(hVal) && !/\bSOURCE\b/i.test(hVal)) headerDefault = 'R';
      } else {
        truncatedHeaders = true;
      }
      continue;
    }

    // Skip blank-id comment leaders that aren't data (e.g. '*', '!').
    if (first === '*' || first === '!' || first === '#') continue;

    // -- point record --
    if (out.sources.length + out.receivers.length >= MAX_POINTS) {
      out.errors.push(`SEG-P1: record cap (${MAX_POINTS}) reached - remaining records ignored.`);
      break;
    }

    // Pad to the fixed 80 columns so short lines read as blank tails (never throw).
    const ln = raw.length < 80 ? raw.padEnd(80, ' ') : raw;

    const lineName = col(ln, 1, 17);
    const point = intField(ln, 17, 25);
    const idxChar = col(ln, 25, 26); // reshoot code → used as idx
    const lat = parsePackedDMS(col(ln, 26, 35), 2);
    const lon = parsePackedDMS(col(ln, 35, 45), 3);
    // Easting / Northing / Elevation - gridFieldMetres returns METRES (it handles
    // both the integer-decimetres and the F-format float-metres conventions).
    let easting = gridFieldMetres(ln, 45, 53);
    let northing = gridFieldMetres(ln, 53, 61);
    const elevation = gridFieldMetres(ln, 61, 66);

    let hasGrid = isFinite(easting) && isFinite(northing) && (Math.abs(easting) > 0 || Math.abs(northing) > 0);
    const hasGeo = lat != null && lon != null;

    if (!isFinite(point) && !hasGrid && !hasGeo) {
      // Nothing usable on this line - count it as skipped and keep going.
      out.skipped++;
      out.errors.push(`L${li + 1}: SEG-P1 record - no point/coords parsed: [${col(ln, 0, 26)}]`);
      continue;
    }

    // Geographic-only record (lat/long present, grid E/N absent): the spec allows
    // this. Project lat/lon → E/N with the header-derived projection so the real
    // position is NOT lost. With no usable projection we cannot place the point on
    // the projected grid - skip it (counted) rather than emit a silent (0,0).
    if (hasGeo && !hasGrid) {
      if (headerProjCoords && headerProjCoords.subtype) {
        const en = latLonToProj(lat as number, lon as number, headerProjCoords, isFinite(elevation) ? elevation : 0);
        if (isFinite(en.E) && isFinite(en.N)) {
          easting = en.E;
          northing = en.N;
          hasGrid = true;
        }
      }
      if (!hasGrid) {
        out.skipped++;
        out.errors.push(
          `L${li + 1}: SEG-P1 geographic-only record (lat/long, no grid E/N) - no header projection to place it; record dropped.`,
        );
        continue;
      }
    }

    const rtype = classifyRtype(col(ln, 0, 1), headerDefault);

    const pt: SPSPoint = {
      rtype,
      lineName,
      point: isFinite(point) ? point : 0,
      idx: idxChar || '',
      easting: isFinite(easting) ? easting : 0,
      northing: isFinite(northing) ? northing : 0,
      elevation: isFinite(elevation) ? elevation : 0,
      raw,
      lineNum: li + 1,
    };
    // Always carry the geographic coordinates when the record supplied them.
    if (lat != null) pt.lat = lat;
    if (lon != null) pt.lon = lon;
    if (rtype === 'S') out.sources.push(pt);
    else out.receivers.push(pt);
  }

  if (truncatedHeaders) out.errors.push(`SEG-P1: header cap (${MAX_HEADERS}) reached - extra H records ignored.`);
  if (out.skipped > 0) out.errors.unshift(`${out.skipped} record(s) skipped (SEG-P1 parse failed)`);

  out.layout = 'SEG-P1';
  if (headerProj) out.projection = headerProj;
  return out;
}

// -- SEG-P1 writer --------------------------------------------------------------

/** Fixed columns of a SEG-P1 point record (0-based, end-exclusive) - the SAME
 *  spans {@link parseSegP1} reads, so writer and reader can never drift. */
const P1W = {
  idCol: 0, lineStart: 1, lineEnd: 17, ptStart: 17, ptEnd: 25, idxCol: 25,
  latStart: 26, latEnd: 35, lonStart: 35, lonEnd: 45,
  eStart: 45, eEnd: 53, nStart: 53, nEnd: 61, zStart: 61, zEnd: 66,
};

/**
 * Metres -> the zero-padded integer DECIMETRES a SEG-P1 grid field holds.
 *
 * Decimetres are not a stylistic choice: an 8-column field cannot hold a UTM
 * northing in decimal metres (3624098.3 is nine characters), and the format
 * solves that by storing tenths of a metre as a pure integer. A value that still
 * does not fit returns null so the caller can report it rather than emit a
 * truncated coordinate that would silently read back as a different place.
 */
function dmField(metres: number, width: number): string | null {
  if (!isFinite(metres)) return ' '.repeat(width);
  const dm = Math.round(metres * 10);
  const neg = dm < 0;
  const digits = String(Math.abs(dm));
  // A negative value spends one column on the sign.
  if (digits.length > width - (neg ? 1 : 0)) return null;
  return (neg ? '-' : '') + digits.padStart(width - (neg ? 1 : 0), '0');
}

/** Right-justified integer for the point-number field; blank when non-finite. */
function ptField(v: number, width: number): string {
  if (!isFinite(v)) return ' '.repeat(width);
  const s = String(Math.round(v));
  return s.length > width ? s.slice(0, width) : s.padStart(width);
}

/**
 * Serialise an {@link SPSData} survey to SEG-P1 text.
 *
 * Writes PROJECTED grid records (easting / northing / elevation) and leaves the
 * lat/long fields blank, which the spec allows and the parser accepts. Geographic
 * output is not emitted because it would require re-deriving lat/long from the
 * grid and would lose precision on the way back.
 *
 * A station whose coordinates cannot fit the fixed fields is SKIPPED with an
 * explanatory line in `errors` - never truncated into a wrong position.
 */
export function writeSegP1(data: SPSData, opts?: { surveyName?: string }): { text: string; errors: string[] } {
  const errors: string[] = [];
  const lines: string[] = [];
  const proj = data.projection;

  lines.push('H ' + (opts?.surveyName || 'SEISCONV SEG-P1 EXPORT'));
  if (proj) {
    const zone = proj.subtype === 'UTM' && proj.zone != null ? ` ZONE ${proj.zone} ${proj.hemi === 'S' ? 'SOUTH' : 'NORTH'}` : '';
    // The datum string comes straight from the source H12, which is fixed-column
    // and often carries padding or a doubled name ("WGS84       WGS84"). Collapse
    // the runs so the SEG-P1 header reads cleanly.
    const datum = (proj.datum || 'UNKNOWN').toUpperCase().replace(/\s+/g, ' ').trim();
    lines.push(`H GRID: ${(proj.type || proj.subtype || 'PROJECTED').toUpperCase()}${zone}  DATUM ${datum}`);
  } else {
    lines.push('H GRID: UNKNOWN - no projection in the source survey');
    errors.push('The source survey carries no projection, so the SEG-P1 header cannot name a grid or datum.');
  }
  lines.push('H COORDINATES ARE GRID EASTING/NORTHING IN DECIMETRES');

  const emit = (p: SPSPoint) => {
    const e = dmField(p.easting, P1W.eEnd - P1W.eStart);
    const n = dmField(p.northing, P1W.nEnd - P1W.nStart);
    const z = dmField(isFinite(p.elevation) ? p.elevation : NaN, P1W.zEnd - P1W.zStart);
    if (e === null || n === null || z === null) {
      errors.push(`${p.rtype} ${p.lineName}/${p.point}: coordinates do not fit the SEG-P1 fixed fields (E ${p.easting}, N ${p.northing}, Z ${p.elevation}) - station omitted.`);
      return;
    }
    const buf = new Array(80).fill(' ');
    const put = (start: number, s: string) => { for (let i = 0; i < s.length && start + i < 80; i++) buf[start + i] = s[i]; };
    buf[P1W.idCol] = p.rtype === 'R' ? 'R' : 'S';
    put(P1W.lineStart, (p.lineName || '').trim().slice(0, P1W.lineEnd - P1W.lineStart));
    put(P1W.ptStart, ptField(p.point, P1W.ptEnd - P1W.ptStart));
    if (p.idx) buf[P1W.idxCol] = p.idx[0];
    put(P1W.eStart, e);
    put(P1W.nStart, n);
    put(P1W.zStart, z);
    lines.push(buf.join('').replace(/\s+$/, ''));
  };

  for (const s of data.sources) emit(s);
  for (const r of data.receivers) emit(r);
  return { text: lines.join('\n') + '\n', errors };
}
