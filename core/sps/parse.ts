// seisconv-core / sps - SPS 2.1 (+ legacy) parser.
//
// Parses Shell Processing Support point files (S = sources, R = receivers,
// X = cross-reference) plus the H-record header block (datum / projection /
// Helmert). Column layouts vary widely between vendors, so several are tried.
// Ported verbatim from the SeisConv reference. Pure - no DOM.

export interface SPSHeader {
  code: string;
  val: string;
  raw: string;
}

export interface SPSPoint {
  rtype: 'S' | 'R';
  lineName: string;
  point: number;
  idx: string;
  easting: number;
  northing: number;
  elevation: number;
  raw: string;
  lineNum: number;
  /** Geographic latitude / longitude (signed decimal degrees) when the source
   *  format carried them directly (e.g. a lat/long-only SEG-P1 record). Optional -
   *  most formats only carry projected E/N. */
  lat?: number;
  lon?: number;
  upholeMs?: number;
  srcType?: string;
  date?: string;
  time?: string;
  ffid?: number;
  staticMs?: number;
}

export type SPSXref = Record<string, string | number | undefined>;

export interface HelmertParams7 {
  dx: number;
  dy: number;
  dz: number;
  rx: number;
  ry: number;
  rz: number;
  ds: number;
}

export interface SPSProjection {
  type: string | null;
  subtype: string | null;
  zone: number | null;
  hemi: 'N' | 'S' | null;
  datum: string | null;
  ellipsoid: string | null;
  a: number | null;
  invF: number | null;
  units: string;
  unitFactor: number;
  centralMeridian: number | null;
  latOrigin: number | null;
  falseEasting: number | null;
  falseNorthing: number | null;
  scaleFactor: number | null;
  helmert: HelmertParams7 | null;
  source: string;
  desc?: string;
}

export interface SPSData {
  sources: SPSPoint[];
  receivers: SPSPoint[];
  xrefs: SPSXref[];
  headers: SPSHeader[];
  errors: string[];
  skipped: number;
  layout: string | null;
  projection?: SPSProjection;
}

// -- H-record human-readable labels --
//
// SPS 2.1 carries a short description in cols 5-32 of every H-record; when a file
// omits it (or carries a terse/non-standard one) this map supplies a canonical
// human label per code so the Header Viewer/Editor always has something to show.
export const SPS_HEADER_LABELS: Record<string, string> = {
  H00: 'SPS format / revision',
  H01: 'Survey / area',
  H011: 'Survey block',
  H02: 'Date of survey',
  H03: 'Client',
  H04: 'Geophysical contractor',
  H05: 'Positioning contractor',
  H06: 'Processing contractor',
  H07: 'Field computer system',
  H08: 'Coordinate location',
  H09: 'Offset from coordinate / clock time',
  H10: 'Date format',
  H100: 'Note',
  H11: 'Geodetic datum / spheroid info',
  H12: 'Geodetic datum, -spheroid',
  H13: 'Geodetic datum (local)',
  H14: 'Geodetic datum parameters', // SPS rev 2.1: 7-parameter transformation to WGS84
  H15: 'Vertical datum',
  H16: 'Vertical datum description',
  H17: 'Offset between geodetic & vertical datum',
  H18: 'Projection type',
  H19: 'Projection zone',
  H20: 'Description of grid units',
  H201: 'Factor to meters',
  H21: 'Description of height units',
  H211: 'Factor to meters (height)',
  H22: 'Projection parameters',
  H220: 'Long. of central meridian',
  H221: 'Lat. of central parallel',
  H222: 'Standard parallel 1',
  H223: 'Standard parallel 2',
  H23: 'Grid origin',
  H231: 'Grid origin',
  H232: 'Grid coord. at origin',
  H24: 'Scale factor',
  H241: 'Scale factor',
  H25: 'Spheroid / datum shift parameters',
  H26: 'Bearing / azimuth reference',
  H30: 'Line number / range',
  H31: 'Receiver line interval',
  H32: 'Source line interval',
  H33: 'Receiver station interval',
  H34: 'Source station interval',
  H35: 'Source / receiver type',
};

/** Human-readable description for an H-record. Prefers the description column
 *  embedded in the raw line (cols 5-32) when present; else the canonical label
 *  map; else the bare code. */
export function spsHeaderDesc(code: string, raw?: string): string {
  if (raw) {
    // Description column = cols 5-32 (0-based 4..31), i.e. after the 4-char code.
    const embedded = raw.substring(4, 32).trim();
    if (embedded) return embedded;
  }
  return SPS_HEADER_LABELS[code] || code;
}

// -- fixed-column helpers --
function sfloat(s: string, a: number, b: number): number {
  const v = (s || '').substring(a, b).trim();
  return v ? parseFloat(v) : NaN;
}
function sstr(s: string, a: number, b: number): string {
  return (s || '').substring(a, Math.min(b, (s || '').length)).trim();
}

/**
 * The 4-char H-record code of a raw SPS line (cols 1-4, trimmed), matching how
 * {@link parseSPSText} reads it: pad the line to ≥4 chars, take cols 0-4, trim.
 * Returns '' when the line is not an H-record. Single source of truth so the
 * parser, the reprojector and the Header Editor agree on what code a line is -
 * the old reproject `substring(0,3)+digit-check` produced a different code for a
 * non-digit 4th char and could miss the record the parser saw.
 */
export function hRecCode(raw: string): string {
  const ln = (raw || '').padEnd(4, ' ');
  if (ln[0]?.toUpperCase() !== 'H') return '';
  return ln.substring(0, 4).trim();
}

/**
 * Fixed E/N column spans for each detected S/R layout (end-exclusive, 0-based),
 * the single source of truth shared by {@link spsParseCoords} (read) and the
 * reprojector (write-back). `tail` is the first column AFTER the coordinate block
 * (elevation/flags), so a rewriter can splice `prefix + E + N + line.slice(tail)`.
 * Layout 'D' (whitespace-delimited) has no fixed columns → no entry → callers
 * fall back to leaving the line unchanged rather than mis-columning it.
 */
export const SPS_COORD_SPANS: Record<string, { eStart: number; eEnd: number; nStart: number; nEnd: number; tail: number }> = {
  'SPS2.1': { eStart: 46, eEnd: 55, nStart: 55, nEnd: 65, tail: 65 },
  A: { eStart: 14, eEnd: 24, nStart: 24, nEnd: 34, tail: 34 },
  B: { eStart: 14, eEnd: 26, nStart: 26, nEnd: 38, tail: 38 },
  C: { eStart: 13, eEnd: 23, nStart: 23, nEnd: 33, tail: 33 },
};

/**
 * Point code (SPS 2.1 cols 25-26, e.g. 'KL' = killed) of an S/R record that is
 * SPS 2.1-shaped but carries NO coordinates - blank/non-numeric E/N fields
 * (cols 47-65). Dead/killed stations are legitimately recorded this way; without
 * this check such a record falls through the legacy column layouts and becomes a
 * phantom station (field case: R 399/253 'KL' → phantom line "39", easting 253).
 * Returns null when the record doesn't match (i.e. it should go through the
 * normal layout ladder).
 */
export function spsCoordlessCode(ln: string): string | null {
  // E/N fields must carry no digits at all (blank or non-numeric)…
  if (/\d/.test((ln || '').substring(46, 65))) return null;
  // …while the record is still 2.1-shaped: numeric point number in cols 12-21,
  // a digit-or-blank point index in col 24, and a 1-2 LETTER point code in
  // cols 25-26. Coordinate-bearing legacy layouts put digits in cols 25-26
  // (part of their E/N fields), so they can never match.
  if (!isFinite(sfloat(ln, 11, 21))) return null;
  if (!/^[0-9 ]?$/.test(ln[23] ?? '')) return null;
  const code = sstr(ln, 24, 26);
  return /^[A-Za-z]{1,2}$/.test(code) ? code : null;
}

/** Try multiple SPS column layouts - real files vary considerably. */
export function spsParseCoords(ln: string): { e: number; n: number; z?: number; layout: string } | null {
  // SPS 2.1 SPEC - X cols 47-55, Y 56-65, Z 66-71
  let e = sfloat(ln, 46, 55), n = sfloat(ln, 55, 65);
  const z = sfloat(ln, 65, 71);
  if (isFinite(e) && isFinite(n) && (Math.abs(e) > 1 || Math.abs(n) > 1)) return { e, n, z, layout: 'SPS2.1' };
  // A coordinate-less SPS 2.1 record (dead/KL station) must NOT fall through to
  // the legacy layouts - its point-number columns would misparse as coordinates.
  // Returning null also keeps the reprojector from splicing new coordinates into
  // the wrong columns of such a record.
  if (spsCoordlessCode(ln) != null) return null;
  e = sfloat(ln, 14, 24); n = sfloat(ln, 24, 34);
  if (isFinite(e) && isFinite(n) && (Math.abs(e) > 0 || Math.abs(n) > 0)) return { e, n, layout: 'A' };
  e = sfloat(ln, 14, 26); n = sfloat(ln, 26, 38);
  if (isFinite(e) && isFinite(n) && (Math.abs(e) > 0 || Math.abs(n) > 0)) return { e, n, layout: 'B' };
  e = sfloat(ln, 13, 23); n = sfloat(ln, 23, 33);
  if (isFinite(e) && isFinite(n) && (Math.abs(e) > 0 || Math.abs(n) > 0)) return { e, n, layout: 'C' };
  // whitespace-delimited fallback
  const parts = ln.trim().split(/\s+/).slice(1);
  const nums: number[] = [];
  for (const p of parts) {
    const v = parseFloat(p);
    if (isFinite(v) && Math.abs(v) > 10) nums.push(v);
  }
  if (nums.length >= 2) return { e: nums[0], n: nums[1], layout: 'D' };
  return null;
}

// -- H-record value parsers --
function spsParseDMSlat(s: string): number | null {
  s = (s || '').replace(/[;,]/g, '').trim();
  const m = s.match(/^(\d{3})(\d{2})(\d{2}\.\d+)([NS])/i);
  if (!m) return null;
  const v = parseInt(m[1]) + parseInt(m[2]) / 60 + parseFloat(m[3]) / 3600;
  return m[4].toUpperCase() === 'S' ? -v : v;
}
function spsParseDMSlon(s: string): number | null {
  const m = /^(\d{2,3})(\d{2})(\d{2}\.\d*)([EW])?/.exec(s.trim());
  if (!m) return null;
  let deg = parseInt(m[1]) + parseInt(m[2]) / 60 + parseFloat(m[3]) / 3600;
  if (m[4] === 'W') deg = -deg;
  return deg;
}
function spsParseFalseEN(s: string): { fe: number | null; fn: number | null } {
  const me = /(-?\d+\.\d*)\s*E/i.exec(s);
  const mn = /(-?\d+\.\d*)\s*N/i.exec(s);
  return { fe: me ? parseFloat(me[1]) : null, fn: mn ? parseFloat(mn[1]) : null };
}

/** Extract datum/projection/Helmert from the parsed H records. */
export function spsExtractProjection(headers: SPSHeader[]): SPSProjection {
  const get = (code: string): string | null => {
    const h = headers.find((h) => h.code === code);
    return h ? h.val : null;
  };
  const proj: SPSProjection = {
    type: null, subtype: null, zone: null, hemi: null, datum: null, ellipsoid: null,
    a: null, invF: null, units: 'meters', unitFactor: 1.0,
    centralMeridian: null, latOrigin: null, falseEasting: null, falseNorthing: null,
    scaleFactor: null, helmert: null, source: 'headers',
  };

  const h12 = get('H12');
  if (h12) {
    const nums = h12.match(/(\d[\d.]+)\s+([\d.]+)\s*;?\s*$/);
    if (nums) {
      proj.a = parseFloat(nums[1]);
      proj.invF = parseFloat(nums[2]);
    }
    const datumText = h12.replace(/\s*[\d.]+\s*[\d.]+\s*;?\s*$/, '').trim();
    proj.datum = datumText || null;
    proj.ellipsoid = datumText || null;
  }

  const h14 = get('H14');
  if (h14) {
    const v = h14.replace(/;.*$/, '').trim();
    const nums = (v.match(/[+-]?\d+\.?\d*/g) || []).map(parseFloat);
    if (nums.length >= 3 && isFinite(nums[0]) && isFinite(nums[1]) && isFinite(nums[2])) {
      proj.helmert = { dx: nums[0], dy: nums[1], dz: nums[2], rx: nums[3] || 0, ry: nums[4] || 0, rz: nums[5] || 0, ds: nums[6] || 0 };
    }
  }

  const h18 = get('H18'); if (h18) proj.type = h18.replace(/[;]/g, '').trim();
  const h20 = get('H20'); if (h20) proj.units = h20.replace(/[,.;]/g, '').trim().toLowerCase();
  const h201 = get('H201'); if (h201) { const f = parseFloat(h201); if (isFinite(f) && f > 0) proj.unitFactor = f; }
  const h220 = get('H220'); if (h220) { const v = spsParseDMSlon(h220); if (v != null) proj.centralMeridian = v; }
  const h231 = get('H231'); if (h231) { const v = spsParseDMSlat(h231); if (v != null) proj.latOrigin = v; }
  const h232 = get('H232'); if (h232) { const { fe, fn } = spsParseFalseEN(h232); proj.falseEasting = fe; proj.falseNorthing = fn; }
  const h241 = get('H241'); if (h241) { const f = parseFloat(h241); if (isFinite(f) && f > 0) proj.scaleFactor = f; }

  const KNOWN: Record<string, { subtype: string; latOrigin?: number; desc?: string }> = {
    'ISRAEL GRID (NEW)': { subtype: 'TM', latOrigin: 31.734393611, desc: 'ITM (EPSG:2039)' },
    'ISRAEL GRID NEW': { subtype: 'TM', latOrigin: 31.734393611, desc: 'ITM (EPSG:2039)' },
    ITM: { subtype: 'TM', latOrigin: 31.734393611, desc: 'ITM (EPSG:2039)' },
    'ISRAELI TM': { subtype: 'TM', latOrigin: 31.734393611, desc: 'ITM (EPSG:2039)' },
    'ISRAEL GRID (OLD)': { subtype: 'TM', latOrigin: 31.734393611, desc: 'ICS Old Israeli Grid (EPSG:28193)' },
    'TRANSVERSE MERCATOR': { subtype: 'TM' },
    TM: { subtype: 'TM' },
    UTM: { subtype: 'UTM' },
  };

  const typeKey = (proj.type || '').toUpperCase().replace(/\s+/g, ' ').replace(/[,.;]/g, '');
  let known = KNOWN[typeKey];
  if (!known) {
    if (/\bITM\b/.test(typeKey) || /ISRAEL/.test(typeKey)) known = KNOWN['ITM'];
    else if (/\bUTM\b/.test(typeKey)) known = KNOWN['UTM'];
    else if (/TRANSVERSE MERCATOR/.test(typeKey) || /\bTM\b/.test(typeKey)) known = KNOWN['TM'];
  }
  if (known) {
    proj.subtype = proj.subtype || known.subtype;
    if (known.latOrigin != null && proj.latOrigin == null) proj.latOrigin = known.latOrigin;
    if (known.desc) proj.desc = known.desc;
  }

  if (proj.subtype === 'UTM' || typeKey === 'UTM') {
    proj.subtype = 'UTM';
    const h19 = get('H19');
    if (h19) {
      // The zone is the first STANDALONE 1-2 digit number anywhere in the value,
      // not just at the start. Vendors write "11 (120W - 114W ...)", our own
      // generateProjHeaders writes "Zone 36, North", and some tools write "36N" -
      // anchoring at the start meant SeisConv could not read back the H19 it had
      // just written, so the zone silently fell back to 36 (or to whatever H220
      // implied). The digit lookaround keeps "120" from being read as zone 12.
      const h19t = h19.trim();
      const zm = /(?<!\d)(\d{1,2})(?!\d)/.exec(h19t);
      if (zm) proj.zone = parseInt(zm[1]);
      // Hemisphere: the word "south", or an S/N letter attached to the zone number
      // ("36S"). The trailing (?![A-Za-z]) stops the "S" of an unrelated word from
      // being read as "southern".
      const adj = /(?<!\d)\d{1,2}\s*([NnSs])(?![A-Za-z])/.exec(h19t);
      proj.hemi = /south/i.test(h19t) || (adj && /s/i.test(adj[1])) ? 'S' : 'N';
    }
    if (proj.zone == null && proj.centralMeridian != null) proj.zone = Math.round((proj.centralMeridian + 183) / 6);
    if (proj.centralMeridian == null && proj.zone != null) proj.centralMeridian = proj.zone * 6 - 183;
    proj.hemi = proj.hemi || 'N';
  }

  return proj;
}

/** Parse the full text of one SPS file. */
export function parseSPSText(text: string): SPSData {
  const out: SPSData = { sources: [], receivers: [], xrefs: [], headers: [], errors: [], skipped: 0, layout: null };
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.length && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  const layoutCounts: Record<string, number> = {};
  // Allocation-DoS caps: a crafted/huge positioning file could otherwise grow the
  // source/receiver/x-ref arrays without bound (one object per record). Cap each
  // category (mirrors the binary parsers' MAX_TRACES discipline); once a cap is hit
  // we stop pushing to that category and record one diagnostic.
  const MAX_SPS_SOURCES = 500_000, MAX_SPS_RECEIVERS = 500_000, MAX_SPS_XREFS = 2_000_000;
  let cappedS = false, cappedR = false, cappedX = false;

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    if (!raw.trim()) continue;
    const ln = raw.padEnd(80, ' ');
    const t = ln[0].toUpperCase();

    if (t === 'H') {
      const code = ln.substring(0, 4).trim();
      // Cap the stored value AND raw line length. A conformant H-record is 80
      // cols; a hostile multi-MB H line would otherwise be carried verbatim into
      // the headerList IPC payload and saved ZIP rewrites (the EDIT path already
      // clamps, but pass-through records did not). 4096 is far beyond any real
      // record yet bounds the worst case.
      const MAX_H_LEN = 4096;
      const val = ln.substring(32).replace(/;.*$/, '').trim().slice(0, MAX_H_LEN);
      out.headers.push({ code, val, raw: raw.length > MAX_H_LEN ? raw.slice(0, MAX_H_LEN) : raw });
      continue;
    }
    if (t === 'P' || t === '!' || t === ' ') continue;
    if (t !== 'S' && t !== 'R' && t !== 'X') continue;

    if (t === 'S' || t === 'R') {
      // Coordinate-less SPS 2.1 record (dead/killed station, e.g. code KL): keep
      // the station identity (line/point/index) so counts and X-ref existence
      // checks stay true, but with non-finite coordinates so plots/offsets skip
      // it. Previously it fell through to a legacy layout → phantom station.
      const clCode = spsCoordlessCode(ln);
      const coords = clCode != null ? { e: NaN, n: NaN, z: NaN, layout: 'SPS2.1' } : spsParseCoords(ln);
      if (!coords) {
        out.skipped++;
        out.errors.push(`L${li + 1}: ${t} record - cannot parse coords: [${ln.substring(10, 40).trimEnd()}]`);
        continue;
      }
      layoutCounts[coords.layout] = (layoutCounts[coords.layout] || 0) + 1;
      const isSPS21 = coords.layout === 'SPS2.1';
      const lineName = isSPS21 ? sstr(ln, 1, 11) : sstr(ln, 1, 7);
      const point = isSPS21 ? sfloat(ln, 11, 21) || 0 : sfloat(ln, 7, 15) || sfloat(ln, 7, 11) || 0;
      const idxCh = isSPS21 ? ln[23] || '' : ln[15] || '';
      const elev = coords.z != null && isFinite(coords.z) ? coords.z : sfloat(ln, 34, 40) || sfloat(ln, 38, 44);
      const base: SPSPoint = {
        rtype: t,
        lineName,
        point,
        idx: idxCh.trim() || '',
        easting: coords.e,
        northing: coords.n,
        elevation: elev,
        raw,
        lineNum: li + 1,
      };
      if (clCode != null)
        out.errors.push(`L${li + 1}: ${t} ${lineName}/${point} - coordinate-less station (code ${clCode}); kept without coordinates`);
      if (t === 'S') {
        if (isSPS21) {
          // SPS rev 2.1 point record (spec, 1-based): point code 25-26, static
          // correction 27-30, point depth 31-34, seismic datum 35-38, uphole time
          // 39-40, water depth 41-46, E 47-55, N 56-65, elevation 66-71, day of
          // year 72-74, time hhmmss 75-80.
          //
          // These used to read at the LEGACY layout's offsets regardless of the
          // detected layout, which for a 2.1 file sliced digits straight out of
          // the easting/northing: a real survey came back with uphole 694 and
          // "date" 94786. from the easting 694786.9. Fabricated values, exported
          // into CSV (and now shapefiles) as if they were recorded field data.
          base.upholeMs = sfloat(ln, 38, 40);
          base.srcType = sstr(ln, 24, 26);
          base.date = sstr(ln, 71, 74); // day of year (I3), not a calendar date
          base.time = sstr(ln, 74, 80);
          // The 2.1 point record has no field record number - leaving ffid unset
          // is correct; the FFID lives in the X (relation) record.
        } else {
          base.upholeMs = sfloat(ln, 40, 46) || sfloat(ln, 44, 50);
          base.srcType = sstr(ln, 46, 48) || sstr(ln, 50, 52);
          base.date = sstr(ln, 48, 54);
          base.time = sstr(ln, 54, 58);
          base.ffid = sfloat(ln, 58, 62);
        }
        if (out.sources.length < MAX_SPS_SOURCES) out.sources.push(base);
        else if (!cappedS) { cappedS = true; out.errors.push(`source records capped at ${MAX_SPS_SOURCES} (DoS guard)`); }
      } else {
        // Static correction: cols 27-30 in 2.1, legacy offsets otherwise.
        base.staticMs = isSPS21 ? sfloat(ln, 26, 30) : sfloat(ln, 40, 46) || sfloat(ln, 44, 50);
        if (out.receivers.length < MAX_SPS_RECEIVERS) out.receivers.push(base);
        else if (!cappedR) { cappedR = true; out.errors.push(`receiver records capped at ${MAX_SPS_RECEIVERS} (DoS guard)`); }
      }
    } else {
      // X record: SPS 2.1 spec vs legacy short-format (auto-detect)
      const specSrcPt = sfloat(ln, 27, 37);
      const isSpec = isFinite(specSrcPt) && Math.abs(specSrcPt) > 0;
      let xr: SPSXref;
      if (isSpec) {
        xr = {
          tape: sstr(ln, 1, 7), ffid: sfloat(ln, 7, 15), srcLine: sstr(ln, 17, 27), srcPt: specSrcPt,
          srcIdx: ln.substring(37, 38).trim(), fromCh: sfloat(ln, 38, 43), toCh: sfloat(ln, 43, 48),
          chIncr: sfloat(ln, 48, 49) || 1, rcvLine: sstr(ln, 49, 59), rcvPtFrom: sfloat(ln, 59, 69),
          rcvPtTo: sfloat(ln, 69, 79), rcvIdx: ln.substring(79, 80).trim(),
          rcvLineFrom: sstr(ln, 49, 59), rcvLineTo: sstr(ln, 49, 59), layout: 'SPS2.1', raw, lineNum: li + 1,
        };
      } else {
        xr = {
          srcLine: sstr(ln, 1, 7), srcPt: sfloat(ln, 7, 11), srcIdx: ln[11]?.trim() || '', ffid: sfloat(ln, 12, 16),
          rcvLineFrom: sstr(ln, 22, 28), rcvPtFrom: sfloat(ln, 28, 32), rcvIdxFrom: ln[32]?.trim() || '',
          rcvLineTo: sstr(ln, 33, 39), rcvPtTo: sfloat(ln, 39, 43), rcvIdxTo: ln[43]?.trim() || '',
          rcvPtIncr: sfloat(ln, 47, 50) || 1, rcvLine: sstr(ln, 22, 28), layout: 'legacy', raw, lineNum: li + 1,
        };
      }
      if (out.xrefs.length < MAX_SPS_XREFS) out.xrefs.push(xr);
      else if (!cappedX) { cappedX = true; out.errors.push(`x-ref records capped at ${MAX_SPS_XREFS} (DoS guard)`); }
    }
  }

  const topLayout = Object.entries(layoutCounts).sort((a, b) => b[1] - a[1])[0];
  out.layout = topLayout ? topLayout[0] : 'unknown';
  if (out.skipped > 0) out.errors.unshift(`${out.skipped} record(s) skipped (coord parse failed)`);
  out.projection = spsExtractProjection(out.headers);
  return out;
}

/** Detect whether a file holds S, R, or X records (by extension, then content). */
export function detectSPSType(filename: string, firstLines?: string): 'S' | 'R' | 'X' | 'mixed' {
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (['s', 's01', 's1', 's02', 's2'].includes(ext)) return 'S';
  if (['r', 'r01', 'r1', 'r02', 'r2'].includes(ext)) return 'R';
  if (['x', 'x01', 'x1', 'x02', 'x2'].includes(ext)) return 'X';
  const lines = (firstLines || '').split('\n').slice(0, 30).filter((l) => l.trim());
  const counts: Record<string, number> = { S: 0, R: 0, X: 0 };
  for (const l of lines) {
    const t = l[0]?.toUpperCase();
    if (t && counts[t] != null) counts[t]++;
  }
  const max = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return max && max[1] > 0 ? (max[0] as 'S' | 'R' | 'X') : 'mixed';
}

/** Merge two parsed SPS files (e.g. an S file + an R file), de-duplicating points. */
export function mergeSPSData(a: SPSData, b: SPSData): SPSData {
  // Round a coordinate to its nearest integer for the dedup key; non-finite
  // values (unparsed coords) collapse to a stable 'nan' token so two records
  // that are truly identical still match.
  const rc = (v: number) => (isFinite(v) ? String(Math.round(v)) : 'nan');
  // Include rounded E/N in the key so a station from set B with the SAME
  // line|point|idx as set A is kept when its coordinates differ - production
  // sets routinely reuse numbering across surveys. Re-loading the identical
  // file still collapses (same line|point|idx|E|N), so duplicates don't double.
  const keyOf = (p: SPSPoint) => `${(p.lineName || '').trim()}|${p.point}|${p.idx || ''}|${rc(p.easting)}|${rc(p.northing)}`;
  const seen = new Set<string>();
  const dedup = (arr: SPSPoint[]): SPSPoint[] => {
    const out: SPSPoint[] = [];
    for (const p of arr) {
      const k = keyOf(p);
      if (!seen.has(k)) { seen.add(k); out.push(p); }
    }
    return out;
  };
  const sources = dedup([...a.sources, ...b.sources]);
  seen.clear();
  const receivers = dedup([...a.receivers, ...b.receivers]);
  const xseen = new Set<string>();
  const xrefs: SPSXref[] = [];
  for (const x of [...a.xrefs, ...b.xrefs]) {
    // Add a relation discriminator (the receiver range END + channel range) so
    // two genuinely-distinct relations that share src/ffid/rcvLineFrom/rcvPtFrom
    // but differ in their receiver span aren't dropped. An exact re-load of the
    // same X-file still collapses, since every component matches.
    const k = `${x.srcLine}|${x.srcPt}|${x.ffid}|${x.rcvLineFrom}|${x.rcvPtFrom}|${x.rcvPtTo}|${x.fromCh ?? ''}|${x.toCh ?? ''}`;
    if (!xseen.has(k)) { xseen.add(k); xrefs.push(x); }
  }
  const projection = a.projection && a.projection.type ? a.projection : b.projection && b.projection.type ? b.projection : undefined;
  // De-duplicate H-record headers: an S file and an R file from the same survey
  // carry identical project headers, and re-loading a file would otherwise double
  // every shared record in the Viewer/Raw editor. Key on the full raw line (the
  // exact 80-col text) so genuinely-distinct records survive while exact repeats
  // collapse. Fall back to code|val when raw is empty.
  const hseen = new Set<string>();
  const headers: SPSHeader[] = [];
  for (const h of [...a.headers, ...b.headers]) {
    const k = h.raw && h.raw.length ? h.raw : `${h.code}␟${h.val}`;
    if (!hseen.has(k)) { hseen.add(k); headers.push(h); }
  }
  return {
    sources, receivers, xrefs,
    headers,
    errors: [...a.errors, ...b.errors],
    skipped: a.skipped + b.skipped,
    layout: a.layout || b.layout,
    projection,
  };
}
