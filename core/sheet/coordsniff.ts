// seisconv-core / sheet - understand a pasted or loaded coordinate list.
//
// One entry point, sniffCoords(text, opts), takes whatever the planner has: a
// pasted TXT/CSV list, a KML file or a GeoJSON file, and works out by itself
//   - the layout: delimiter, header row, which columns are id / X / Y / line;
//   - the coordinate type: decimal degrees, degrees-minutes-seconds, or metres;
//   - a proposed CRS: WGS84 for degrees and KML, the CRS a GeoJSON names, else
//     a guess from the value ranges (ITM, the old Israeli grid, a UTM zone).
// The guess is NEVER applied silently: the result says how sure it is
// (`confident`) and lists the alternatives (`candidates`) so the UI can ask.
//
// Malformed lines are collected into `skipped`, never thrown. Input is bounded:
// text length, line count, line length, point count.
//
// Pure: no DOM / Electron.

export const SNIFF_MAX_CHARS = 4_000_000;
export const SNIFF_MAX_LINES = 50_000;
export const SNIFF_MAX_LINE_LEN = 2000;
export const SNIFF_MAX_POINTS = 2000;
const MAX_SKIPPED = 200;

export type CoordKind = 'degrees' | 'dms' | 'projected' | 'unknown';

export interface SniffPoint { id: string; x: number; y: number; group?: string }
export interface CrsGuess { code: string; name: string }

export interface SniffResult {
  format: 'text' | 'kml' | 'geojson';
  kind: CoordKind;
  /** x = longitude / Easting, y = latitude / Northing. */
  points: SniffPoint[];
  delimiter: 'comma' | 'semicolon' | 'tab' | 'space' | '';
  hasHeader: boolean;
  /** Column indexes used (-1 when none). */
  columns: { id: number; x: number; y: number; group: number };
  crs: CrsGuess | null;
  candidates: CrsGuess[];
  confident: boolean;
  /** Degrees whose latitude / longitude order could not be told apart. */
  orderAmbiguous: boolean;
  /** The list closes on itself (first point == last point). */
  closed: boolean;
  skipped: { line: number; text: string; reason: string }[];
  truncated: boolean;
  /** One line for the confirm box, e.g. "projected metres, ITM ... , 6 points". */
  summary: string;
}

export interface SniffOpts {
  fileName?: string;
  /** EPSG code the user already chose for the job (breaks range ties). */
  hintCode?: string;
  /** Force the X/Y order of a text list: 'xy' = first coordinate column is X
   *  (Easting / longitude), 'yx' = it is Y (Northing / latitude). */
  order?: 'xy' | 'yx';
}

/** Names for the codes this module can propose. */
export function crsGuessName(code: string): string {
  const c = code.toUpperCase();
  if (c === 'EPSG:4326') return 'WGS 84 (latitude / longitude)';
  if (c === 'EPSG:2039') return 'Israel 1993 / Israeli TM Grid (ITM)';
  if (c === 'EPSG:28193') return 'Palestine 1923 / Israeli CS Grid (old Israeli grid)';
  const u = /^EPSG:(326|327)(\d\d)$/.exec(c);
  if (u) return `WGS 84 / UTM zone ${+u[2]}${u[1] === '326' ? 'N' : 'S'}`;
  if (c === '') return 'Local grid (no geographic position)';
  return code;
}
const guess = (code: string): CrsGuess => ({ code, name: crsGuessName(code) });

/** UTM EPSG code for a longitude / latitude. */
export function utmCodeFor(lat: number, lon: number): string {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return `EPSG:${lat >= 0 ? 326 : 327}${String(zone).padStart(2, '0')}`;
}

/** The metric grid a geographic point list is best drawn in: ITM inside
 *  Israel, otherwise the UTM zone (same rule as the SPS Creation tab). */
export function suggestGridCode(lat: number, lon: number): string {
  if (lon >= 34 && lon <= 36 && lat >= 29.5 && lat <= 33.5) return 'EPSG:2039';
  return utmCodeFor(lat, lon);
}

// -- field parsing ---------------------------------------------------------------

interface Field { v: number; dms: boolean; axis?: 'lat' | 'lon'; decimals: number }

const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const NUM_COMMA_RE = /^[+-]?\d+,\d+$/;
const DMS_RE = /^([NSEW])?\s*([+-]?\d{1,3}(?:\.\d+)?)\s*[°º:dD]\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′:mM]?\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:["″]|''|[sS])?)?)?\s*([NSEW])?$/i;

/** Parse one field as a coordinate number (plain, decimal comma, or DMS). */
export function parseCoordField(raw: string, allowDecimalComma = false): Field | null {
  const s = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (!s || s.length > 40) return null;
  if (NUM_RE.test(s)) {
    const v = Number(s);
    if (!Number.isFinite(v)) return null;
    const dot = s.indexOf('.');
    return { v, dms: false, decimals: dot >= 0 ? s.replace(/[eE].*$/, '').length - dot - 1 : 0 };
  }
  if (allowDecimalComma && NUM_COMMA_RE.test(s)) {
    const v = Number(s.replace(',', '.'));
    return Number.isFinite(v) ? { v, dms: false, decimals: s.length - s.indexOf(',') - 1 } : null;
  }
  const m = DMS_RE.exec(s);
  if (m && /[°º:dD'′"″NSEWnsew]/.test(s)) {
    const hem = (m[1] || m[5] || '').toUpperCase();
    const deg = Number(m[2]);
    const min = m[3] ? Number(m[3]) : 0;
    const sec = m[4] ? Number(m[4]) : 0;
    if (![deg, min, sec].every(Number.isFinite) || min >= 60 || sec >= 60) return null;
    let v = Math.abs(deg) + min / 60 + sec / 3600;
    if (deg < 0 || /^-/.test(m[2]) || hem === 'S' || hem === 'W') v = -v;
    const axis = hem === 'N' || hem === 'S' ? 'lat' : hem === 'E' || hem === 'W' ? 'lon' : undefined;
    return { v, dms: true, axis, decimals: 6 };
  }
  return null;
}

// -- range tests -------------------------------------------------------------------

interface Range { min: number; max: number }
function rangeOf(vals: number[]): Range {
  let min = Infinity, max = -Infinity;
  for (const v of vals) { if (v < min) min = v; if (v > max) max = v; }
  return { min, max };
}
const within = (r: Range, lo: number, hi: number) => r.min >= lo && r.max <= hi;

const isItm = (e: Range, n: Range) => within(e, 100_000, 300_000) && within(n, 350_000, 850_000);
const isIcs = (e: Range, n: Range) => within(e, 90_000, 310_000) && (within(n, -200_000, 340_000) || within(n, 850_000, 1_150_000));
const isUtm = (e: Range, n: Range) => within(e, 100_000, 900_000) && within(n, 0, 10_000_000) && n.max > 1_000_000;

/** Decide the CRS for projected metres from the value ranges (+ a hint). */
function proposeProjected(e: Range, n: Range, hint: string): { crs: CrsGuess | null; candidates: CrsGuess[]; confident: boolean } {
  const h = (hint || '').toUpperCase();
  const hintUtm = /^EPSG:32[67]\d\d$/.test(h);
  if (h === 'EPSG:2039' && isItm(e, n)) return { crs: guess(h), candidates: [guess(h)], confident: true };
  if (h === 'EPSG:28193' && isIcs(e, n)) return { crs: guess(h), candidates: [guess(h)], confident: true };
  if (hintUtm && isUtm(e, n)) return { crs: guess(h), candidates: [guess(h)], confident: true };
  if (isItm(e, n)) return { crs: guess('EPSG:2039'), candidates: [guess('EPSG:2039')], confident: true };
  if (isIcs(e, n)) return { crs: guess('EPSG:28193'), candidates: [guess('EPSG:28193'), guess('')], confident: false };
  if (isUtm(e, n)) {
    // Israel sits in zone 36N; its easternmost edge reaches into 37N. The zone
    // cannot be read from the numbers, so the user is asked.
    const israel = within(n, 3_200_000, 3_750_000) && within(e, 550_000, 800_000);
    const c = israel ? [guess('EPSG:32636'), guess('EPSG:32637')] : [];
    return { crs: c[0] ?? null, candidates: c, confident: false };
  }
  return { crs: null, candidates: [guess('')], confident: false };
}

// -- grouping -----------------------------------------------------------------------

/** Group points into lines from their ids ("L1-S", "L1-E", "L2_1" ...) when that
 *  gives at least two groups of at least two points each - or ONE group whose
 *  ids end in start / end words ("M1-S", "M1-E"), which is one line given by its
 *  ends. A plain numbered list ("P1".."P5") stays ungrouped. */
function groupFromIds(pts: SniffPoint[]): void {
  if (pts.some((p) => p.group)) return;
  let endWords = true;
  const pre = pts.map((p) => {
    const m = /^(.*?[A-Za-z].*?)[-_ :.]?(start|end|s|e|a|b|\d+)$/i.exec(p.id.trim());
    if (m && /^\d+$/.test(m[2])) endWords = false;
    return m && m[1] ? m[1].replace(/[-_ :.]+$/, '') : '';
  });
  if (pre.some((g) => !g)) return;
  const count = new Map<string, number>();
  for (const g of pre) count.set(g, (count.get(g) ?? 0) + 1);
  if ([...count.values()].some((c) => c < 2)) return;
  if (count.size < 2 && !(count.size === 1 && endWords)) return;
  pts.forEach((p, i) => { p.group = pre[i]; });
}

// -- the three formats --------------------------------------------------------------

function emptyResult(format: SniffResult['format']): SniffResult {
  return {
    format, kind: 'unknown', points: [], delimiter: '', hasHeader: false,
    columns: { id: -1, x: -1, y: -1, group: -1 }, crs: null, candidates: [], confident: false,
    orderAmbiguous: false, closed: false, skipped: [], truncated: false, summary: '',
  };
}

function pushSkip(r: SniffResult, line: number, text: string, reason: string): void {
  if (r.skipped.length < MAX_SKIPPED) r.skipped.push({ line, text: text.slice(0, 120), reason });
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => { const n = Number(d); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; })
    .replace(/&amp;/g, '&')
    .trim();
}

function sniffKml(text: string, r: SniffResult): void {
  const marks = text.match(/<Placemark\b[\s\S]*?<\/Placemark>/gi) || [];
  let auto = 0;
  for (const pm of marks.slice(0, 5000)) {
    if (r.points.length >= SNIFF_MAX_POINTS) { r.truncated = true; break; }
    const nm = /<name>([\s\S]*?)<\/name>/i.exec(pm);
    const name = nm ? decodeXml(nm[1]).slice(0, 80) : '';
    const isLine = /<LineString\b/i.test(pm) || /<Polygon\b/i.test(pm);
    const coordBlocks = pm.match(/<coordinates>([\s\S]*?)<\/coordinates>/gi) || [];
    const grp = isLine ? (name || `Line ${++auto}`) : undefined;
    let k = 0;
    for (const blk of coordBlocks) {
      const body = blk.replace(/<\/?coordinates>/gi, '');
      for (const tup of body.trim().split(/\s+/)) {
        if (!tup) continue;
        if (r.points.length >= SNIFF_MAX_POINTS) { r.truncated = true; break; }
        const [lon, lat] = tup.split(',').map(Number);
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          pushSkip(r, 0, tup, 'not a longitude,latitude pair');
          continue;
        }
        k++;
        const id = isLine ? `${grp}-${k}` : (name || `P${r.points.length + 1}`);
        r.points.push({ id, x: lon, y: lat, group: grp });
      }
    }
  }
  r.kind = 'degrees';
  r.crs = guess('EPSG:4326');
  r.candidates = [r.crs];
  r.confident = true;
}

function geojsonCrsCode(obj: unknown): string {
  const name = (obj as { crs?: { properties?: { name?: unknown } } })?.crs?.properties?.name;
  if (typeof name !== 'string') return '';
  const m = /EPSG:{1,2}(\d{4,5})\b/i.exec(name);
  if (m) return `EPSG:${m[1]}`;
  if (/CRS84/i.test(name)) return 'EPSG:4326';
  return '';
}

function sniffGeoJson(text: string, r: SniffResult, hint: string): boolean {
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return false; }
  if (!obj || typeof obj !== 'object') return false;
  const raw: SniffPoint[] = [];
  let auto = 0;
  const addCoords = (coords: unknown, grp: string | undefined, name: string, depth: number): void => {
    if (depth > 4 || !Array.isArray(coords)) return;
    if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      if (raw.length >= SNIFF_MAX_POINTS) { r.truncated = true; return; }
      const x = coords[0], y = coords[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) { pushSkip(r, 0, JSON.stringify(coords).slice(0, 60), 'not a number'); return; }
      const id = grp ? `${grp}-${raw.filter((p) => p.group === grp).length + 1}` : (name || `P${raw.length + 1}`);
      raw.push({ id, x, y, group: grp });
      return;
    }
    for (const c of coords.slice(0, SNIFF_MAX_POINTS)) addCoords(c, grp, name, depth + 1);
  };
  const doGeom = (g: unknown, name: string): void => {
    if (!g || typeof g !== 'object') return;
    const type = (g as { type?: unknown }).type;
    const coords = (g as { coordinates?: unknown }).coordinates;
    if (type === 'Point') addCoords(coords, undefined, name, 0);
    else if (type === 'MultiPoint') addCoords(coords, undefined, '', 0);
    else if (type === 'LineString' || type === 'Polygon' || type === 'MultiLineString' || type === 'MultiPolygon') {
      addCoords(coords, name || `Line ${++auto}`, name, 0);
    } else if (type === 'GeometryCollection') {
      const gs = (g as { geometries?: unknown }).geometries;
      if (Array.isArray(gs)) for (const x of gs.slice(0, 5000)) doGeom(x, name);
    }
  };
  const featName = (f: unknown): string => {
    const p = (f as { properties?: Record<string, unknown> })?.properties;
    if (!p || typeof p !== 'object') return '';
    for (const k of ['name', 'Name', 'NAME', 'id', 'ID', 'title', 'label']) {
      if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
      const v = p[k];
      if (typeof v === 'string' || typeof v === 'number') return String(v).slice(0, 80);
    }
    return '';
  };
  const type = (obj as { type?: unknown }).type;
  if (type === 'FeatureCollection') {
    const fs = (obj as { features?: unknown }).features;
    if (!Array.isArray(fs)) return false;
    for (const f of fs.slice(0, 5000)) doGeom((f as { geometry?: unknown })?.geometry, featName(f));
  } else if (type === 'Feature') {
    doGeom((obj as { geometry?: unknown }).geometry, featName(obj));
  } else if (typeof type === 'string') {
    doGeom(obj, '');
  } else {
    return false;
  }
  r.points = raw;
  const named = geojsonCrsCode(obj);
  const xs = rangeOf(raw.map((p) => p.x)), ys = rangeOf(raw.map((p) => p.y));
  const looksDeg = raw.length > 0 && within(xs, -180, 180) && within(ys, -90, 90);
  if (named) {
    r.crs = guess(named);
    r.candidates = [r.crs];
    r.confident = true;
    r.kind = named === 'EPSG:4326' ? 'degrees' : 'projected';
  } else if (looksDeg) {
    // RFC 7946: a GeoJSON without a crs member is WGS84 longitude / latitude.
    r.kind = 'degrees';
    r.crs = guess('EPSG:4326');
    r.candidates = [r.crs];
    r.confident = true;
  } else if (raw.length) {
    r.kind = 'projected';
    const p = proposeProjected(xs, ys, hint);
    r.crs = p.crs; r.candidates = p.candidates; r.confident = p.confident;
  }
  return true;
}

const HDR_X = /^(x|e|east|easting|lon|long|longitude|lng)$/;
const HDR_Y = /^(y|n|north|northing|lat|latitude)$/;
const HDR_ID = /^(id|name|point|pt|pointid|station|stn|sp|label|no|num|number|ptname)$/;
const HDR_GROUP = /^(line|linename|lineno|group)$/;
const normHdr = (s: string) => s.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z]/g, '');

function splitLine(line: string, delim: string): string[] {
  if (delim === ' ') return line.replace(/([°º'′"″])\s+/g, '$1').trim().split(/\s+/);
  return line.split(delim);
}

function sniffText(text: string, r: SniffResult, opts: SniffOpts): void {
  const all = text.split(/\r\n|\r|\n/);
  if (all.length > SNIFF_MAX_LINES) r.truncated = true;
  const lines: { no: number; s: string }[] = [];
  for (let i = 0; i < Math.min(all.length, SNIFF_MAX_LINES); i++) {
    const s = all[i];
    const t = s.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    if (s.length > SNIFF_MAX_LINE_LEN) { pushSkip(r, i + 1, s, 'line too long'); continue; }
    lines.push({ no: i + 1, s });
  }
  if (!lines.length) return;

  // Delimiter: the candidate that gives the most lines with >= 2 coordinate fields.
  const cands: { d: string; label: SniffResult['delimiter'] }[] = [
    { d: '\t', label: 'tab' }, { d: ';', label: 'semicolon' }, { d: ',', label: 'comma' }, { d: ' ', label: 'space' },
  ];
  const probe = lines.slice(0, 60);
  let best = cands[3], bestScore = -1;
  for (const c of cands) {
    if (c.d !== ' ' && !probe.some((l) => l.s.includes(c.d))) continue;
    let score = 0;
    for (const l of probe) {
      const f = splitLine(l.s, c.d);
      if (f.length < 2) continue;
      if (f.filter((x) => parseCoordField(x, c.d !== ',')).length >= 2) score++;
    }
    if (score > bestScore) { best = c; bestScore = score; }
  }
  r.delimiter = best.label;
  const dc = best.d !== ',';

  // Header: a first line with fewer than two numeric fields and some letters.
  let start = 0;
  let header: string[] | null = null;
  const first = splitLine(lines[0].s, best.d);
  if (first.filter((x) => parseCoordField(x, dc)).length < 2 && /[A-Za-z]/.test(lines[0].s)) {
    header = first.map((h) => normHdr(h));
    r.hasHeader = true;
    start = 1;
  }

  // Parse every data row into fields.
  const rows: { no: number; raw: string; f: string[]; p: (Field | null)[] }[] = [];
  for (let i = start; i < lines.length; i++) {
    const f = splitLine(lines[i].s, best.d).map((x) => x.trim());
    rows.push({ no: lines[i].no, raw: lines[i].s, f, p: f.map((x) => parseCoordField(x, dc)) });
  }
  if (!rows.length) return;
  const width = Math.max(...rows.map((x) => x.f.length));
  // Numeric columns: parse in >= 80 % of rows.
  const numericCols: number[] = [];
  for (let c = 0; c < width; c++) {
    const ok = rows.filter((x) => x.p[c]).length;
    if (ok >= Math.max(1, Math.ceil(rows.length * 0.8))) numericCols.push(c);
  }

  let xc = -1, yc = -1, idc = -1, gc = -1;
  if (header) {
    header.forEach((h, c) => {
      if (xc < 0 && HDR_X.test(h)) xc = c;
      else if (yc < 0 && HDR_Y.test(h)) yc = c;
      else if (idc < 0 && HDR_ID.test(h)) idc = c;
      else if (gc < 0 && HDR_GROUP.test(h)) gc = c;
    });
  }
  const headerOrdered = xc >= 0 && yc >= 0;
  if (!headerOrdered) {
    xc = -1; yc = -1;
    if (numericCols.length >= 2) {
      const colVals = (c: number) => rows.map((x) => x.p[c]?.v).filter((v): v is number => v != null);
      const idLike = (c: number) => {
        const v = colVals(c);
        return v.length > 0 && v.every((n) => Number.isInteger(n) && Math.abs(n) < 100_000);
      };
      let a = numericCols[0], b = numericCols[1];
      if (numericCols.length >= 3 && idLike(numericCols[0]) && !idLike(numericCols[1])) {
        a = numericCols[1]; b = numericCols[2];
        if (idc < 0) idc = numericCols[0];
      }
      xc = a; yc = b;
    }
    if (idc < 0) {
      // A text first column is the point id.
      for (let c = 0; c < width; c++) {
        if (c === xc || c === yc) continue;
        if (rows.some((x) => x.f[c] && !x.p[c])) { idc = c; break; }
      }
    }
  }
  if (xc < 0 || yc < 0) {
    for (const x of rows) pushSkip(r, x.no, x.raw, 'no two coordinate columns found');
    return;
  }

  // Values of the two coordinate columns, row by row.
  const pairs: { no: number; raw: string; a: Field; b: Field; id: string; group?: string }[] = [];
  for (const x of rows) {
    const a = x.p[xc], b = x.p[yc];
    if (!a || !b) { pushSkip(r, x.no, x.raw, 'coordinate is not a number'); continue; }
    if (pairs.length >= SNIFF_MAX_POINTS) { r.truncated = true; break; }
    const id = idc >= 0 && x.f[idc] ? x.f[idc].replace(/^["']|["']$/g, '').slice(0, 80) : '';
    const group = gc >= 0 && x.f[gc] ? x.f[gc].replace(/^["']|["']$/g, '').slice(0, 80) : undefined;
    pairs.push({ no: x.no, raw: x.raw, a, b, id, group });
  }
  if (!pairs.length) return;

  const ra = rangeOf(pairs.map((p) => p.a.v)), rb = rangeOf(pairs.map((p) => p.b.v));
  const anyDms = pairs.some((p) => p.a.dms || p.b.dms);
  const maxDec = (fs: Field[]) => { const d = fs.map((f) => f.decimals).sort((p, q) => p - q); return d[Math.floor(d.length / 2)] ?? 0; };
  const span = Math.max(ra.max - ra.min, rb.max - rb.min);
  const degRange = within(ra, -180, 180) && within(rb, -180, 180) && (within(ra, -90, 90) || within(rb, -90, 90));
  const degLike = anyDms || (degRange && (span <= 5 || maxDec(pairs.map((p) => p.a)) >= 4));

  // Which column is X (Easting / longitude)?
  let aIsX = true;
  let ambiguous = false;
  if (degLike) {
    r.kind = anyDms ? 'dms' : 'degrees';
    const axA = pairs.find((p) => p.a.axis)?.a.axis, axB = pairs.find((p) => p.b.axis)?.b.axis;
    if (headerOrdered) aIsX = true;
    else if (axA || axB) aIsX = axA === 'lon' || axB === 'lat';
    else if (!within(ra, -90, 90)) aIsX = true;            // |a| > 90: a is longitude
    else if (!within(rb, -90, 90)) aIsX = false;
    else if (within(ra, 29, 34) && within(rb, 34, 36.5)) aIsX = false;   // Israel: lat, lon
    else if (within(ra, 34, 36.5) && within(rb, 29, 34)) aIsX = true;
    else { aIsX = false; ambiguous = true; }               // people write lat first
  } else {
    r.kind = 'projected';
    if (headerOrdered) aIsX = true;
    else if ((isItm(ra, rb) || isUtm(ra, rb))) aIsX = true;
    else if ((isItm(rb, ra) || isUtm(rb, ra))) aIsX = false;
    else aIsX = true;
  }
  if (opts.order) { aIsX = opts.order === 'xy'; ambiguous = false; }
  r.orderAmbiguous = ambiguous;
  r.columns = { id: idc, x: aIsX ? xc : yc, y: aIsX ? yc : xc, group: gc };

  r.points = pairs.map((p, i) => ({
    id: p.id || `P${i + 1}`,
    x: aIsX ? p.a.v : p.b.v,
    y: aIsX ? p.b.v : p.a.v,
    group: p.group || undefined,
  }));

  if (degLike) {
    r.crs = guess('EPSG:4326');
    r.candidates = [r.crs];
    r.confident = !ambiguous;
  } else {
    const ex = rangeOf(r.points.map((p) => p.x)), ny = rangeOf(r.points.map((p) => p.y));
    const p = proposeProjected(ex, ny, opts.hintCode || '');
    r.crs = p.crs; r.candidates = p.candidates; r.confident = p.confident;
  }
}

/** Understand a coordinate list. Never throws. */
export function sniffCoords(input: string, opts: SniffOpts = {}): SniffResult {
  let text = typeof input === 'string' ? input : '';
  const name = (opts.fileName || '').toLowerCase();
  const trimmed = text.trimStart();
  let r: SniffResult;
  let truncated = false;
  if (text.length > SNIFF_MAX_CHARS) { text = text.slice(0, SNIFF_MAX_CHARS); truncated = true; }
  try {
    if (name.endsWith('.kml') || /^<\?xml[\s\S]{0,400}<kml\b/i.test(trimmed) || /^<kml\b/i.test(trimmed)) {
      r = emptyResult('kml');
      sniffKml(text, r);
    } else if (name.endsWith('.geojson') || name.endsWith('.json') || trimmed.startsWith('{')) {
      r = emptyResult('geojson');
      if (!sniffGeoJson(text, r, opts.hintCode || '')) {
        r = emptyResult('text');
        sniffText(text, r, opts);
      }
    } else {
      r = emptyResult('text');
      sniffText(text, r, opts);
    }
  } catch {
    r = emptyResult('text');
    pushSkip(r, 0, '', 'the list could not be read');
  }
  r.truncated = r.truncated || truncated;
  groupFromIds(r.points);
  const pts = r.points;
  // Closed = first point == last point, for an ungrouped list or a single ring.
  const nGroups = new Set(pts.map((p) => p.group).filter(Boolean)).size;
  r.closed = nGroups <= 1 && pts.length >= 4 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y;
  r.summary = sniffSummary(r);
  return r;
}

/** "projected metres, Israel ... (EPSG:2039), 6 points". */
export function sniffSummary(r: SniffResult): string {
  const kind = r.kind === 'degrees' ? 'decimal degrees' : r.kind === 'dms' ? 'degrees-minutes-seconds' : r.kind === 'projected' ? 'projected metres' : 'unknown coordinates';
  const crs = r.crs ? `${r.crs.name}${r.crs.code ? ` (${r.crs.code})` : ''}` : 'coordinate system not recognised';
  const n = r.points.length;
  const groups = new Set(r.points.map((p) => p.group).filter(Boolean)).size;
  // One closed ring is an outline (a KML / GeoJSON polygon), not "1 line".
  const lines = groups && !(r.closed && groups === 1) ? ` on ${groups} line${groups === 1 ? '' : 's'}` : '';
  return `${kind}, ${crs}, ${n} point${n === 1 ? '' : 's'}${lines}${r.closed ? ', closed outline' : ''}`;
}
