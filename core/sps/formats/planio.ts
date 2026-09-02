// seisconv-core / sps / formats - SURVEY-PLAN import + export (pre-generation).
//
// A "plan" is the geometry a user is still DESIGNING: acquisition lines made of
// points that may or may not carry station numbers, in WGS84 degrees or in a
// projected grid. It is not yet an SPSData - there is no S/R split, no X-file and
// possibly no CRS - so it gets its own row model and its own readers/writers.
//
// WHY NOT parseCoordCsv: that reader maps columns AUTOMATICALLY and offers the
// caller no say. The plan importer is explicitly a column-mapping wizard - the user
// states which column is the line, the station, the latitude, the longitude and the
// elevation - so the mapping arrives as a parameter. The two share a vocabulary
// (SYNONYMS / normToken / splitCsvLine / looksLikeHeader / resolveCrsTagCRS are
// imported from coordcsv) rather than duplicating it.
//
// SECURITY: the column mapping is a PlanField[] indexed by COLUMN POSITION whose
// values come from a closed union, so no string derived from file text is ever used
// as an object key. The one input-derived string that survives is the line NAME, and
// that is both isSafeKey-checked and grouped through a Map, never a plain object.
//
// PURE: no DOM, no Node - runs in the worker, in the renderer bundle, and in tests.

import {
  isCommentOrBlank,
  looksLikeHeader,
  normToken,
  splitCsvLine,
  SYNONYMS,
  type FieldName,
} from './coordcsv';

// -- DoS bounds (mirror coordcsv's discipline: never allocate from an input count) --
/** Hard cap on parsed rows. */
export const PLAN_MAX_POINTS = 2_000_000;
/** Hard cap on the length of any single line we will tokenize. */
const MAX_LINE_LEN = 64 * 1024;
/** Hard cap on the columns tracked for a row (defends a line of all-separators). */
const MAX_COLS = 4096;
/** Hard cap on the total number of physical lines scanned. */
const MAX_LINES = 8_000_000;
/** Hard cap on reported per-row problems before they collapse to a count. */
const MAX_REPORTED_ERRORS = 50;
/** Rows returned in a sniff preview. */
const PREVIEW_ROWS = 25;
/** Lines sampled when scoring delimiters. */
const SNIFF_LINES = 20;
/** Hard cap on GeoJSON features read. */
const MAX_JSON_FEATURES = 2_000_000;

/** The four separators a survey export in the wild actually uses. `'ws'` is one or
 *  more spaces/tabs, which is how fixed-width-ish text dumps come out. */
export type Delim = ',' | '\t' | ';' | 'ws';

/**
 * What a source column maps to. `'skip'` means ignored.
 *
 * CLOSED UNION - the mapping is an array indexed by column position whose values
 * come from here and never from file text, so no dynamic object key derived from
 * input can exist.
 */
export type PlanField = 'line' | 'station' | 'lat' | 'lon' | 'easting' | 'northing' | 'elev' | 'type' | 'skip';

/** Every value a mapping select may take, in the order the UI should list them. */
export const PLAN_FIELDS: PlanField[] = ['skip', 'line', 'station', 'lat', 'lon', 'easting', 'northing', 'elev', 'type'];

/** Human labels for {@link PLAN_FIELDS} - kept here so core and UI never disagree. */
export const PLAN_FIELD_LABELS: Record<PlanField, string> = {
  skip: 'Ignore',
  line: 'Line',
  station: 'Station',
  lat: 'Latitude',
  lon: 'Longitude',
  easting: 'Easting',
  northing: 'Northing',
  elev: 'Elevation',
  type: 'Type (S/R)',
};

/** coordcsv's SPSPoint field names projected onto the plan vocabulary. */
const FIELD_FROM_SYNONYM: Record<FieldName, PlanField> = {
  lineName: 'line',
  point: 'station',
  rtype: 'type',
  easting: 'easting',
  northing: 'northing',
  elevation: 'elev',
  lat: 'lat',
  lon: 'lon',
  idx: 'skip',
};

// -- sniffing -----------------------------------------------------------------

export interface CsvSniff {
  /** The winning delimiter. */
  delim: Delim;
  /** True when the first data-ish line names columns rather than holding values. */
  hasHeader: boolean;
  /** Header cells, or synthetic `Column 1..N` when there is no header row. */
  header: string[];
  /** Up to {@link PREVIEW_ROWS} tokenized data rows. */
  rows: string[][];
  /** Bounded count of non-comment, non-blank data rows (header excluded). */
  totalDataRows: number;
  /** Per-column field guess, index-aligned with `header`. */
  guess: PlanField[];
  /** The raw `# CRS:` / `# EPSG:` line, when the file carries one. */
  crsTag?: string;
  /** Bounded diagnostics worth showing the user. */
  notes: string[];
}

/** Tokenize one line under a delimiter. Comma uses coordcsv's quote-aware splitter;
 *  the other three use a plain split (quoted TSV is not a thing in survey exports,
 *  and generalising `splitCsvLine` would change a frozen parser). Bounded. */
export function tokenizePlanLine(line: string, delim: Delim): string[] {
  if (delim === ',') return splitCsvLine(line);
  const parts = delim === 'ws' ? line.trim().split(/[ \t]+/) : line.split(delim);
  return parts.length > MAX_COLS ? parts.slice(0, MAX_COLS) : parts;
}

/** Median of a numeric array (already-sorted not required). Empty -> 0. */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Population variance. Empty -> 0. */
function variance(xs: number[]): number {
  if (!xs.length) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
}

/** Separator occurrences on one line, for delimiter scoring. */
function countSep(line: string, delim: Delim): number {
  if (delim === 'ws') {
    const m = line.trim().match(/[ \t]+/g);
    return m ? m.length : 0;
  }
  let n = 0;
  for (let i = 0; i < line.length; i++) if (line[i] === delim) n++;
  return n;
}

/** Strip a UTF-8 BOM and normalize line endings. */
function bodyLines(text: string): string[] {
  let body = text || '';
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  return body.replace(/\r/g, '').split('\n');
}

/** Clip a pathologically long line before any per-character work. */
function clip(line: string): string {
  return line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) : line;
}

/** Numeric cell value, or NaN. Blank is NaN, not 0. */
function num(s: string): number {
  const t = (s || '').trim();
  if (!t) return NaN;
  const v = parseFloat(t);
  return isFinite(v) ? v : NaN;
}

/**
 * Choose the delimiter, detect a header, preview a bounded slice, and guess a
 * column mapping. NEVER throws - a file it cannot make sense of comes back with an
 * empty preview and a note, not an exception.
 */
export function sniffPlanCsv(text: string, opts?: { delim?: Delim; previewRows?: number }): CsvSniff {
  const out: CsvSniff = { delim: ',', hasHeader: false, header: [], rows: [], totalDataRows: 0, guess: [], notes: [] };
  try {
    const lines = bodyLines(text);
    const previewWanted = Math.max(1, Math.min(200, opts?.previewRows ?? PREVIEW_ROWS));

    // -- the leading comment block may carry a CRS tag --
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) continue;
      if (t.startsWith('#') || t.startsWith(';')) {
        if (!out.crsTag && /crs|epsg|coordinate|projection/i.test(t)) out.crsTag = t;
        continue;
      }
      break;
    }

    // -- collect the data-ish lines we will reason over --
    const sample: string[] = [];
    let scanned = 0;
    for (const raw of lines) {
      if (++scanned > MAX_LINES) break;
      if (isCommentOrBlank(raw)) continue;
      sample.push(clip(raw));
      if (sample.length >= SNIFF_LINES) break;
    }
    if (!sample.length) {
      out.notes.push('no data rows found');
      return out;
    }

    // -- delimiter: highest median count >= 1, ties broken by lowest variance --
    if (opts?.delim) {
      out.delim = opts.delim;
    } else {
      const candidates: Delim[] = [',', '\t', ';', 'ws'];
      let best: Delim | null = null;
      let bestMed = 0;
      let bestVar = Infinity;
      for (const d of candidates) {
        const counts = sample.map((l) => countSep(l, d));
        const med = median(counts);
        if (med < 1) continue;
        const v = variance(counts);
        if (med > bestMed || (med === bestMed && v < bestVar)) {
          best = d;
          bestMed = med;
          bestVar = v;
        }
      }
      // A single column (no separator anywhere) is not an error - it is a file we
      // cannot map, and the user is told rather than silently given garbage.
      out.delim = best ?? ',';
      if (!best) out.notes.push('no delimiter detected - the file looks single-column');
    }

    // -- header --
    const firstCells = tokenizePlanLine(sample[0], out.delim);
    if (looksLikeHeader(firstCells)) {
      out.hasHeader = true;
    } else {
      // Relaxed second clause: a header whose tokens miss the synonym table (e.g.
      // "L,ST,LAT,LON") is still a header - nothing in it parses as a number.
      const numeric = firstCells.filter((c) => isFinite(num(c))).length;
      const nonEmpty = firstCells.filter((c) => (c || '').trim() !== '').length;
      out.hasHeader = numeric === 0 && nonEmpty >= 2;
    }

    const dataSample = out.hasHeader ? sample.slice(1) : sample;
    const widths = (out.hasHeader ? [firstCells, ...dataSample.map((l) => tokenizePlanLine(l, out.delim))] : sample.map((l) => tokenizePlanLine(l, out.delim))).map((r) => r.length);
    const nCols = Math.min(MAX_COLS, Math.max(...widths, 0));
    const wMin = Math.min(...widths);
    const wMax = Math.max(...widths);
    if (wMin !== wMax) out.notes.push(`columns vary: ${wMin}..${wMax}`);

    out.header = out.hasHeader
      ? Array.from({ length: nCols }, (_, c) => (firstCells[c] || '').trim() || `Column ${c + 1}`)
      : Array.from({ length: nCols }, (_, c) => `Column ${c + 1}`);

    // -- bounded preview, read past the sample so it can exceed SNIFF_LINES --
    let seenData = 0;
    let scanned2 = 0;
    let headerConsumed = !out.hasHeader;
    for (const raw of lines) {
      if (++scanned2 > MAX_LINES) break;
      if (isCommentOrBlank(raw)) continue;
      if (!headerConsumed) { headerConsumed = true; continue; }
      seenData++;
      if (out.rows.length < previewWanted) out.rows.push(tokenizePlanLine(clip(raw), out.delim));
      if (seenData >= PLAN_MAX_POINTS) { out.notes.push(`row cap (${PLAN_MAX_POINTS}) reached`); break; }
    }
    out.totalDataRows = seenData;

    out.guess = guessColumns(out.header, out.rows, out.hasHeader);
  } catch (e) {
    out.notes.push(`sniff failed - ${(e as Error).message}`);
  }
  return out;
}

/** Per-column numeric character, used by the value-range guesser. */
interface ColStat {
  n: number;          // non-empty cells seen
  numeric: number;    // cells that parsed as a number
  min: number;
  max: number;
  frac: boolean;      // at least one non-integer value
}

function columnStats(rows: string[][], nCols: number): ColStat[] {
  const st: ColStat[] = Array.from({ length: nCols }, () => ({ n: 0, numeric: 0, min: Infinity, max: -Infinity, frac: false }));
  for (const r of rows) {
    for (let c = 0; c < nCols; c++) {
      const cell = (r[c] || '').trim();
      if (!cell) continue;
      st[c].n++;
      const v = num(cell);
      if (!isFinite(v)) continue;
      st[c].numeric++;
      if (v < st[c].min) st[c].min = v;
      if (v > st[c].max) st[c].max = v;
      if (!Number.isInteger(v)) st[c].frac = true;
    }
  }
  return st;
}

/**
 * Guess a column mapping: header synonyms first, then value ranges for whatever is
 * still unmapped. Elevation is NEVER guessed from values - a column of plausible
 * small numbers is far more often a station count than a height, and silently
 * inventing elevations is worse than leaving them blank.
 */
export function guessColumns(header: string[], rows: string[][], hasHeader: boolean): PlanField[] {
  const nCols = header.length;
  const guess: PlanField[] = Array.from({ length: nCols }, () => 'skip');
  const taken = new Set<PlanField>();

  // -- pass 1: header synonyms (the same table the automatic reader uses) --
  if (hasHeader) {
    for (let c = 0; c < nCols; c++) {
      const syn = SYNONYMS[normToken(header[c])];
      if (!syn) continue;
      const f = FIELD_FROM_SYNONYM[syn];
      if (!f || f === 'skip' || taken.has(f)) continue;
      guess[c] = f;
      taken.add(f);
    }
  }

  // -- pass 2: value ranges over the preview --
  const st = columnStats(rows, nCols);
  const free = (c: number) => guess[c] === 'skip';
  const allNumeric = (c: number) => st[c].n > 0 && st[c].numeric === st[c].n;
  const inRange = (c: number, lo: number, hi: number) => allNumeric(c) && st[c].min >= lo && st[c].max <= hi;

  // Geographic degrees: fractional, and inside the coordinate ranges. Requiring a
  // fractional value is what stops a small integer id column being read as a
  // latitude - a real latitude is essentially never a whole number.
  if (!taken.has('lat') && !taken.has('lon')) {
    let latC = -1;
    let lonC = -1;
    for (let c = 0; c < nCols; c++) {
      if (!free(c) || !st[c].frac) continue;
      if (latC < 0 && inRange(c, -90, 90)) { latC = c; continue; }
      if (latC >= 0 && lonC < 0 && inRange(c, -180, 180)) { lonC = c; break; }
    }
    if (latC >= 0 && lonC >= 0) {
      guess[latC] = 'lat'; taken.add('lat');
      guess[lonC] = 'lon'; taken.add('lon');
    }
  }

  // Projected metres: a survey grid coordinate is a large number. 1e4..1e8 covers
  // every UTM/ITM/national grid; a small local grid falls outside it and has to be
  // mapped by hand, which the wizard makes a one-click fix.
  if (!taken.has('easting') && !taken.has('northing')) {
    const big: number[] = [];
    for (let c = 0; c < nCols && big.length < 2; c++) {
      if (free(c) && (inRange(c, 1e4, 1e8) || inRange(c, -1e8, -1e4))) big.push(c);
    }
    if (big.length === 2) {
      guess[big[0]] = 'easting'; taken.add('easting');
      guess[big[1]] = 'northing'; taken.add('northing');
    }
  }

  // Two leading whole-number columns are line then station - the universal
  // convention, and the same order coordcsv's positional fallback assumes.
  const ints: number[] = [];
  for (let c = 0; c < nCols; c++) if (free(c) && allNumeric(c) && !st[c].frac && st[c].max <= 1e7) ints.push(c);
  if (!taken.has('line') && !taken.has('station') && ints.length >= 2) {
    guess[ints[0]] = 'line'; taken.add('line');
    guess[ints[1]] = 'station'; taken.add('station');
  } else if (!taken.has('station') && ints.length >= 1) {
    guess[ints[0]] = 'station'; taken.add('station');
  }

  return guess;
}

// -- parsing ------------------------------------------------------------------

/** One parsed row, still in whatever coordinate frame the file used. */
export interface PlanRow {
  /** Line name as written. `''` when the file has no line column. */
  line: string;
  /** Station number, or null when absent / unparseable. */
  station: number | null;
  /** `(lat, lon)` when `coordKind === 'geo'`, else `(easting, northing)`. */
  a: number;
  b: number;
  elev: number | null;
  type: 'S' | 'R' | null;
  /** 1-based physical line number in the source text, for error messages. */
  srcLine: number;
}

export interface PlanParseResult {
  rows: PlanRow[];
  coordKind: 'geo' | 'proj';
  skipped: number;
  /** Bounded, each `L<n>: <reason>`. */
  errors: string[];
  /** True when a cap stopped the read before the end of the file. */
  truncated: boolean;
}

/**
 * Decide whether a coordinate pair is geographic. Geographic iff EVERY sampled
 * value fits the degree ranges; one projected metre value is enough to rule it out.
 * Ambiguity (a local grid whose numbers happen to look like degrees) is resolved by
 * the user - the guess is always shown and always overridable.
 */
export function guessCoordKind(a: number[], b: number[]): 'geo' | 'proj' {
  let seen = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (!isFinite(a[i]) || !isFinite(b[i])) continue;
    seen++;
    if (Math.abs(a[i]) > 90 || Math.abs(b[i]) > 180) return 'proj';
  }
  return seen ? 'geo' : 'proj';
}

/** Locate the two coordinate columns for a requested kind, falling back to the
 *  other pair when the requested one is not mapped. Returns null when neither is. */
function coordCols(map: PlanField[], want: 'geo' | 'proj' | 'auto'): { a: number; b: number; from: 'geo' | 'proj' } | null {
  const idx = (f: PlanField) => map.indexOf(f);
  const lat = idx('lat'), lon = idx('lon');
  const e = idx('easting'), n = idx('northing');
  const geo = lat >= 0 && lon >= 0 ? { a: lat, b: lon, from: 'geo' as const } : null;
  const proj = e >= 0 && n >= 0 ? { a: e, b: n, from: 'proj' as const } : null;
  if (want === 'geo') return geo ?? proj;
  if (want === 'proj') return proj ?? geo;
  // 'auto' mirrors coordcsv's precedence: projected coordinates win when present.
  return proj ?? geo;
}

/**
 * Parse the whole text against an EXPLICIT column mapping.
 *
 * CONTRACT: never throws. Every rejected row is counted in `skipped` and, up to
 * {@link MAX_REPORTED_ERRORS}, described in `errors` with its physical line number.
 */
export function parsePlanCsv(
  text: string,
  map: PlanField[],
  opts: { delim: Delim; hasHeader: boolean; coordKind: 'geo' | 'proj' | 'auto'; swapAB?: boolean },
): PlanParseResult {
  const out: PlanParseResult = { rows: [], coordKind: 'geo', skipped: 0, errors: [], truncated: false };
  const note = (m: string) => { if (out.errors.length < MAX_REPORTED_ERRORS) out.errors.push(m); };
  try {
    const cols = coordCols(map, opts.coordKind);
    if (!cols) {
      out.coordKind = opts.coordKind === 'proj' ? 'proj' : 'geo';
      out.errors.push('no coordinate columns mapped - set a Latitude + Longitude pair or an Easting + Northing pair');
      return out;
    }
    const iLine = map.indexOf('line');
    const iStn = map.indexOf('station');
    const iElev = map.indexOf('elev');
    const iType = map.indexOf('type');
    const swap = !!opts.swapAB;

    const lines = bodyLines(text);
    let headerConsumed = !opts.hasHeader;
    let scanned = 0;

    for (let li = 0; li < lines.length; li++) {
      if (++scanned > MAX_LINES) { out.errors.push('line cap reached - file truncated'); out.truncated = true; break; }
      const raw = lines[li];
      if (isCommentOrBlank(raw)) continue;
      if (!headerConsumed) { headerConsumed = true; continue; }
      if (out.rows.length >= PLAN_MAX_POINTS) { out.errors.push(`point cap (${PLAN_MAX_POINTS}) reached - file truncated`); out.truncated = true; break; }

      const cells = tokenizePlanLine(clip(raw), opts.delim);
      const need = Math.max(cols.a, cols.b) + 1;
      if (cells.length < need) {
        out.skipped++;
        note(`L${li + 1}: fewer than ${need} columns`);
        continue;
      }

      let a = num(cells[cols.a]);
      let b = num(cells[cols.b]);
      if (swap) { const t = a; a = b; b = t; }
      if (!isFinite(a) || !isFinite(b)) {
        out.skipped++;
        note(`L${li + 1}: coordinate not numeric [${raw.slice(0, 40).trimEnd()}]`);
        continue;
      }

      const lineName = iLine >= 0 ? (cells[iLine] || '').trim() : '';
      const stnRaw = iStn >= 0 ? num(cells[iStn]) : NaN;
      const elevRaw = iElev >= 0 ? num(cells[iElev]) : NaN;
      let type: 'S' | 'R' | null = null;
      if (iType >= 0) {
        const t = (cells[iType] || '').trim().toUpperCase();
        if (t[0] === 'S') type = 'S';
        else if (t[0] === 'R') type = 'R';
      }

      out.rows.push({
        line: lineName,
        station: isFinite(stnRaw) ? Math.round(stnRaw) : null,
        a, b,
        elev: isFinite(elevRaw) ? elevRaw : null,
        type,
        srcLine: li + 1,
      });
    }

    // -- decide the frame, then range-check anything claimed to be geographic --
    out.coordKind =
      opts.coordKind === 'auto'
        ? guessCoordKind(out.rows.map((r) => r.a), out.rows.map((r) => r.b))
        : opts.coordKind;

    if (out.coordKind === 'geo') {
      const kept: PlanRow[] = [];
      for (const r of out.rows) {
        if (Math.abs(r.a) > 90) { out.skipped++; note(`L${r.srcLine}: latitude out of range (${r.a})`); continue; }
        if (Math.abs(r.b) > 180) { out.skipped++; note(`L${r.srcLine}: longitude out of range (${r.b})`); continue; }
        kept.push(r);
      }
      out.rows = kept;
    }

    if (out.skipped > MAX_REPORTED_ERRORS) out.errors.push(`...and ${out.skipped - MAX_REPORTED_ERRORS} more skipped row(s)`);
  } catch (e) {
    out.errors.push(`plan CSV: internal error - ${(e as Error).message}`);
  }
  return out;
}

/**
 * Read a GeoJSON survey plan. Point features become one row each; a LineString
 * becomes one row per vertex, in order. Properties are read for line/station/
 * elevation/type when present. Coordinates are `[lon, lat]` per RFC 7946, so the
 * result is always geographic.
 *
 * CONTRACT: never throws - a malformed document returns an error, not an exception.
 */
export function parsePlanGeoJson(text: string): PlanParseResult {
  const out: PlanParseResult = { rows: [], coordKind: 'geo', skipped: 0, errors: [], truncated: false };
  const note = (m: string) => { if (out.errors.length < MAX_REPORTED_ERRORS) out.errors.push(m); };
  try {
    const doc = JSON.parse(text) as unknown;
    const feats: unknown[] =
      Array.isArray(doc) ? doc
      : doc && typeof doc === 'object' && Array.isArray((doc as { features?: unknown[] }).features) ? (doc as { features: unknown[] }).features
      : doc && typeof doc === 'object' && (doc as { type?: string }).type === 'Feature' ? [doc]
      : [];
    if (!feats.length) {
      out.errors.push('GeoJSON: no features found');
      return out;
    }

    let seen = 0;
    for (const f of feats) {
      if (++seen > MAX_JSON_FEATURES) { out.errors.push('GeoJSON: feature cap reached'); out.truncated = true; break; }
      if (!f || typeof f !== 'object') continue;
      const geom = (f as { geometry?: { type?: string; coordinates?: unknown } }).geometry;
      if (!geom || typeof geom !== 'object') continue;
      // Properties come from file text; read the handful of names we know and never
      // iterate the object, so a hostile key is simply never touched.
      const pr = ((f as { properties?: Record<string, unknown> }).properties || {}) as Record<string, unknown>;
      const gLine = pr.line != null ? String(pr.line).trim() : '';
      const gStn = Number(pr.station ?? pr.point);
      const gElev = Number(pr.elev ?? pr.elevation ?? pr.z);
      const gTypeRaw = pr.type != null ? String(pr.type).trim().toUpperCase() : '';
      const gType: 'S' | 'R' | null = gTypeRaw[0] === 'S' ? 'S' : gTypeRaw[0] === 'R' ? 'R' : null;

      const push = (pair: unknown, ord: number) => {
        if (out.rows.length >= PLAN_MAX_POINTS) { out.truncated = true; return; }
        if (!Array.isArray(pair) || pair.length < 2) { out.skipped++; note(`GeoJSON: bad coordinate pair in feature ${seen}`); return; }
        const lon = Number(pair[0]);
        const lat = Number(pair[1]);
        if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          out.skipped++;
          note(`GeoJSON: coordinate out of range in feature ${seen} (${lat}, ${lon})`);
          return;
        }
        out.rows.push({
          line: gLine,
          station: isFinite(gStn) ? Math.round(gStn) : ord,
          a: lat, b: lon,
          elev: isFinite(gElev) ? gElev : null,
          type: gType,
          srcLine: seen,
        });
      };

      if (geom.type === 'Point') push(geom.coordinates, out.rows.length + 1);
      else if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
        // A LineString has no per-vertex station, so ordinals stand in.
        (geom.coordinates as unknown[]).forEach((c, i) => push(c, i + 1));
      } else if (geom.type === 'MultiPoint' && Array.isArray(geom.coordinates)) {
        (geom.coordinates as unknown[]).forEach((c, i) => push(c, i + 1));
      }
    }
    if (!out.rows.length && !out.errors.length) out.errors.push('GeoJSON: no Point or LineString geometry found');
  } catch (e) {
    out.errors.push(`GeoJSON: parse failed - ${(e as Error).message}`);
  }
  return out;
}

/**
 * Names that must never reach a plain-object key path downstream. Note this is NOT
 * `isSafeKey`: that also demands an `[A-Za-z0-9_]` charset, which would throw away
 * perfectly ordinary survey line names such as `LN-0001-26`.
 */
const DANGEROUS_LINE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Group parsed rows into named lines, preserving row order within each line and
 * first-seen order between them.
 *
 * A Map, not a plain object: the keys are line names taken straight from file text,
 * and a Map has no prototype to pollute. A name that would be dangerous as an object
 * key anywhere downstream is dropped rather than silently renamed - a rename would
 * put stations on a line the user never asked for.
 */
export function groupPlanRows(rows: PlanRow[], fallbackName = '1'): { name: string; rows: PlanRow[] }[] {
  const byName = new Map<string, PlanRow[]>();
  for (const r of rows) {
    const name = (r.line || '').trim() || fallbackName;
    if (DANGEROUS_LINE_NAMES.has(name)) continue;
    const bucket = byName.get(name);
    if (bucket) bucket.push(r);
    else byName.set(name, [r]);
  }
  return [...byName.entries()].map(([name, rs]) => ({ name, rows: rs }));
}

// -- writers ------------------------------------------------------------------

/** One point of a plan being exported. Derived metrics are optional. */
export interface PlanExportPoint {
  lat: number;
  lon: number;
  station: number | null;
  elev: number | null;
  easting?: number | null;
  northing?: number | null;
  cumM?: number | null;
  segM?: number | null;
  azDeg?: number | null;
}

/** One acquisition line of a plan being exported. */
export interface PlanExportLine {
  name: string;
  kind?: 'preplot' | 'resample';
  points: PlanExportPoint[];
}

/** Quote a CSV cell only when it contains a comma, quote, or newline. */
function csvCell(v: string): string {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Full-precision number -> string, blank for non-finite. Matches coordcsv's choice
 *  so high-precision survey coordinates and degrees survive a write losslessly. */
function fmtNum(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '';
  return String(v);
}

/** Fixed-decimal number -> string, blank for non-finite. For derived metrics only. */
function fmtFixed(v: number | null | undefined, dp: number): string {
  if (v == null || !isFinite(v)) return '';
  return v.toFixed(dp);
}

/**
 * Serialize a plan to CSV.
 *
 * Columns are a superset of the standalone map editor's export, and every name is a
 * `coordcsv` synonym, so the file round-trips through BOTH this module's importer
 * and `parseCoordCsv` (i.e. it can be opened straight into the SPS tab). The three
 * derived columns are unmapped there and are simply ignored.
 */
export function buildPlanCsv(lines: PlanExportLine[], crsTag?: string): string {
  const out: string[] = [];
  if (crsTag) out.push(crsTag.startsWith('#') ? crsTag : `# CRS: ${crsTag}`);
  out.push('line,station,lat,lon,elev,easting,northing,cum_m,seg_m,azimuth_deg');
  for (const ln of lines || []) {
    for (const p of ln.points || []) {
      out.push([
        csvCell(ln.name),
        p.station == null ? '' : String(p.station),
        fmtNum(p.lat),
        fmtNum(p.lon),
        fmtNum(p.elev),
        fmtNum(p.easting),
        fmtNum(p.northing),
        fmtFixed(p.cumM, 1),
        fmtFixed(p.segM, 1),
        fmtFixed(p.azDeg, 1),
      ].join(','));
    }
  }
  return out.join('\n') + '\n';
}

/** Serialize a plan to GeoJSON: one LineString per line plus one Point per station. */
export function buildPlanGeoJson(lines: PlanExportLine[]): string {
  const feats: unknown[] = [];
  for (const ln of lines || []) {
    const pts = (ln.points || []).filter((p) => isFinite(p.lat) && isFinite(p.lon));
    if (pts.length >= 2) {
      feats.push({
        type: 'Feature',
        properties: { line: ln.name, kind: ln.kind ?? null, stations: pts.length },
        geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) },
      });
    }
    for (const p of pts) {
      feats.push({
        type: 'Feature',
        properties: {
          line: ln.name,
          station: p.station,
          elev: p.elev,
          cum_m: p.cumM == null || !isFinite(p.cumM) ? null : +p.cumM.toFixed(1),
          kind: ln.kind ?? null,
        },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      });
    }
  }
  return JSON.stringify({ type: 'FeatureCollection', features: feats }, null, 1) + '\n';
}

/** Escape the five XML metacharacters. Applied to every text node we emit, because
 *  a line name comes from the user and `&` alone would produce invalid KML. */
function xmlEsc(s: string): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Serialize a plan to KML: one Folder per line, with its track and its stations. */
export function buildPlanKml(lines: PlanExportLine[]): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
  out.push('<name>Survey plan</name>');
  for (const ln of lines || []) {
    const pts = (ln.points || []).filter((p) => isFinite(p.lat) && isFinite(p.lon));
    if (!pts.length) continue;
    const nm = xmlEsc(ln.name);
    out.push(`<Folder><name>Line ${nm}</name>`);
    if (pts.length >= 2) {
      const coords = pts.map((p) => `${p.lon},${p.lat},${isFinite(p.elev as number) ? p.elev : 0}`).join(' ');
      out.push(`<Placemark><name>Line ${nm}</name><LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString></Placemark>`);
    }
    for (const p of pts) {
      const label = xmlEsc(p.station == null ? '' : String(p.station));
      out.push(`<Placemark><name>${label}</name><Point><coordinates>${p.lon},${p.lat},${isFinite(p.elev as number) ? p.elev : 0}</coordinates></Point></Placemark>`);
    }
    out.push('</Folder>');
  }
  out.push('</Document></kml>');
  return out.join('\n') + '\n';
}
