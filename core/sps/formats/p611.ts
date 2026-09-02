// seisconv-core / sps / formats - IOGP P6/11 (P6-11) bin-grid parser.
//
// P6/11 (IOGP Report 483-6) is the positioning bin-grid exchange format: instead
// of a list of S/R points it DEFINES a regular seismic acquisition GRID - a map
// CRS, a bin-grid origin (E/N), the bin-grid bearing/rotation, inline/crossline
// numbering (first inline/crossline + increments), bin size on each axis, and the
// grid extents/corners. It therefore maps onto {@link BinGrid}, not SPSData, and
// the dispatch returns kind:'bingrid'.
//
// FORMAT MODEL (per IOGP 483-6 + the EPSG "P6 I=J-90" bin-grid coordinate
// operation, method EPSG:1049): the grid is a 2-D affine map from bin (I,J) node
// indices to projected (E,N) governed by nine parameters -
//   - bin grid origin I / J          (the node label at the origin)
//   - bin grid origin Easting / Northing
//   - scale factor of the bin grid
//   - bin width on the I-axis / J-axis (map-grid distance of one bin)
//   - map grid bearing of the bin-grid J-axis (clockwise from grid north)
//   - bin node increment on the I-axis / J-axis
// Files carry these in an H-record header block. Real-world P6/11 is comma- and/or
// columnar-delimited and tolerant of vendor labelling, so this reader is a tolerant
// key/label matcher over the H6 records rather than a fixed-column scraper: it
// recognises the parameter by its row label (and, for H6,n,m structured rows, by
// the numeric tuple), never by a hard column. The map CRS, when present in the
// projection H-records, is lifted via the shared {@link spsExtractProjection}.
//
// SECURITY: like every parser in this codebase, this MUST be bounded and
// non-throwing. We cap the line count and per-line length (DoS), never allocate
// from an attacker-controlled count, and never index a dynamic object with an
// unvalidated key (prototype-pollution guard). Malformed input yields a
// (possibly empty) BinGrid - never an exception.
//
// PURE: no DOM, no Node - runs in the worker AND in unit tests.

import { emptyBinGrid, type BinGrid } from '../bingrid';
import { spsExtractProjection, type SPSHeader, type SPSProjection } from '../parse';

// -- DoS bounds (mirror the binary parsers' MAX_TRACES / MAX_SAMPLES discipline) --
/** Hard cap on lines we will scan. A bin-grid header is tens of lines; B6 bin-node
 *  blocks can be large but we only ever scan for the four grid CORNERS, so the cap
 *  bounds the worst case without allocating per record. */
const MAX_LINES = 2_000_000;
/** Per-line length cap. A conformant P6/11 record is ~80-256 cols; clip anything
 *  pathological so a multi-MB single line can't be carried verbatim into `raw`. */
const MAX_LINE_LEN = 4096;
/** Cap on the audit `raw` array so a hostile file can't pin O(file) lines in memory. */
const MAX_RAW = 4096;
/** Aggregate byte cap on the retained audit `raw` text. The line-count cap alone
 *  (MAX_RAW lines × MAX_LINE_LEN each) admits ~16 MB, which then crosses the
 *  worker→renderer structured-clone boundary on every binGrid() call. Stop pushing
 *  once the retained text exceeds this small budget so the cloned BinGrid stays small. */
const MAX_RAW_BYTES = 256 * 1024;
/** Hard cap on the total source length we will scan, so the up-front newline split
 *  cannot allocate O(file) strings from an attacker-controlled newline count. A
 *  conformant P6/11 header is tiny; this still admits very large real files. */
const MAX_TEXT_LEN = 64 * 1024 * 1024;

const D2R = Math.PI / 180;

/** Reject dynamic keys that would pollute Object.prototype (matches the obslog fix). */
function safeKey(k: string): boolean {
  return k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
}

/** Parse a finite float from a token, else NaN (never throws). */
function num(s: string | undefined): number {
  if (s == null) return NaN;
  const v = parseFloat(String(s).trim());
  return Number.isFinite(v) ? v : NaN;
}

/**
 * Parse a bearing/azimuth token. Accepts a plain DECIMAL-degree value or a
 * SPACE/COLON-separated sexagesimal "DDD MM SS.sss" form. Returns degrees in
 * [0,360), or NaN.
 *
 * NOTE: a packed dotted "DDD.MMSSsss" form is NOT decoded here - it is numerically
 * indistinguishable from a plain decimal degree value (e.g. "340.0" vs "340.3015")
 * with no reliable signal in the token alone, so guessing would silently corrupt
 * valid decimal bearings. P6/11 angle values in this reader are therefore treated
 * as decimal degrees (or the explicitly-separated DMS form above).
 */
function parseBearing(s: string | undefined): number {
  if (s == null) return NaN;
  const t = String(s).trim();
  if (!t) return NaN;
  // "DDD MM SS.s" (space/colon separated) → decimal degrees.
  const dms = t.match(/^(-?\d+(?:\.\d+)?)[:\s]+(\d+(?:\.\d+)?)[:\s]+(\d+(?:\.\d+)?)$/);
  if (dms) {
    const d = parseFloat(dms[1]);
    const m = parseFloat(dms[2]);
    const sec = parseFloat(dms[3]);
    if (Number.isFinite(d) && Number.isFinite(m) && Number.isFinite(sec)) {
      const sign = d < 0 ? -1 : 1;
      const v = Math.abs(d) + m / 60 + sec / 3600;
      return norm360(sign * v);
    }
  }
  const v = parseFloat(t);
  return Number.isFinite(v) ? norm360(v) : NaN;
}

function norm360(deg: number): number {
  let v = deg % 360;
  if (v < 0) v += 360;
  return v;
}

/**
 * Split a P6/11 record into trimmed fields. P6/11 is canonically comma-delimited;
 * we also accept tab or run-of-spaces so a columnar vendor variant still tokenises.
 * Double-quoted fields are honoured (a comma inside quotes does NOT split), so a
 * quoted survey name like `"DEMO, 3D"` survives as one field; surrounding quotes
 * are stripped and `""` is an escaped quote.
 */
function fields(line: string): string[] {
  if (line.includes(',')) {
    if (line.indexOf('"') < 0) return line.split(',').map((s) => s.trim());
    // Quote-aware comma split.
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
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }
  return line.trim().split(/[\t]+|\s{2,}/).map((s) => s.trim());
}

/**
 * Label → matcher table for the bin-grid scalar parameters. Each entry tests a
 * record's TEXT (case-insensitive, punctuation-flattened) and, when it matches,
 * the parameter's numeric value is read from the record's last numeric field.
 * Order matters: more-specific labels are tested before generic ones.
 */
interface ParamHit {
  set: (g: Mutable, v: number) => void;
  test: (flat: string) => boolean;
}

type Mutable = BinGrid & {
  // axis bearings as captured from the file before we reconcile them onto inlineAzimuth
  _jBearing?: number;
  _iBearing?: number;
};

/** Flatten a label for tolerant matching: lowercase, strip punctuation, collapse ws. */
function flat(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Last finite numeric field on a record (the data value of a "label, …, value" row). */
function lastNum(fs: string[]): number {
  for (let i = fs.length - 1; i >= 0; i--) {
    const v = num(fs[i]);
    if (Number.isFinite(v)) return v;
  }
  return NaN;
}

const PARAM_TABLE: ParamHit[] = [
  // origin easting / northing
  { test: (f) => /origin .*east/.test(f) || /east.* of .*origin/.test(f) || /\bbin grid origin .*e\b/.test(f), set: (g, v) => (g.originE = v) },
  { test: (f) => /origin .*north/.test(f) || /north.* of .*origin/.test(f) || /\bbin grid origin .*n\b/.test(f), set: (g, v) => (g.originN = v) },
  // origin bin-node labels (first inline = origin I, first crossline = origin J)
  { test: (f) => /origin .*\bi\b/.test(f) || /\binline\b.*origin/.test(f) || /first .*inline/.test(f) || /bin grid origin i/.test(f), set: (g, v) => (g.firstInline = v) },
  { test: (f) => /origin .*\bj\b/.test(f) || /crossline.*origin/.test(f) || /first .*cross/.test(f) || /bin grid origin j/.test(f), set: (g, v) => (g.firstCrossline = v) },
  // bin width per axis
  { test: (f) => /bin width.* i/.test(f) || /width on .*i/.test(f) || /\bi\b.*bin (size|width)/.test(f) || /inline bin (size|width)/.test(f), set: (g, v) => (g.binI = v) },
  { test: (f) => /bin width.* j/.test(f) || /width on .*j/.test(f) || /\bj\b.*bin (size|width)/.test(f) || /cross.*bin (size|width)/.test(f), set: (g, v) => (g.binJ = v) },
  // node increment per axis
  { test: (f) => /increment on .*i/.test(f) || /\bi\b.*node increment/.test(f) || /inline.*increment/.test(f), set: (g, v) => (g.incInline = v) },
  { test: (f) => /increment on .*j/.test(f) || /\bj\b.*node increment/.test(f) || /cross.*increment/.test(f), set: (g, v) => (g.incCrossline = v) },
  // bearings: J-axis (the format's primary), and optionally I-axis
  { test: (f) => /bearing.* j/.test(f) || /j.?axis.*bearing/.test(f) || /grid bearing.*j/.test(f), set: (g, v) => (g._jBearing = v) },
  { test: (f) => /bearing.* i/.test(f) || /i.?axis.*bearing/.test(f) || /grid bearing.*i/.test(f) || /inline azimuth/.test(f), set: (g, v) => (g._iBearing = v) },
  // node counts / extents
  { test: (f) => /number of .*inline/.test(f) || /\binlines?\b.*count/.test(f) || /n.?inline/.test(f), set: (g, v) => (g.nInline = Math.max(0, Math.trunc(v))) },
  { test: (f) => /number of .*cross/.test(f) || /cross.?lines?\b.*count/.test(f) || /n.?cross/.test(f), set: (g, v) => (g.nCrossline = Math.max(0, Math.trunc(v))) },
];

/**
 * Apply the structured H6 records IOGP defines (H6,n,m,…) by their numeric tuple,
 * which is unambiguous regardless of the descriptive label. The H6 sub-records we
 * recognise (per the EPSG P6 parameter list):
 *   H6,1,1 bin grid origin I        H6,1,2 bin grid origin J
 *   H6,1,3 bin grid origin Easting  H6,1,4 bin grid origin Northing
 *   H6,1,5 scale factor             H6,1,6 bin width I
 *   H6,1,7 bin width J              H6,1,8 map grid bearing of J-axis
 *   H6,1,9 increment I              H6,1,10 increment J
 * Vendors vary the exact numbering, so this is best-effort and the label matcher
 * above is the primary path; whichever yields a finite value wins (label first).
 */
function applyStructuredH6(g: Mutable, fs: string[]): void {
  // fs[0] = "H6"; fs[1] = group; fs[2] = item; trailing = value.
  if (fs.length < 4) return;
  const group = num(fs[1]);
  const item = num(fs[2]);
  const v = lastNum(fs);
  if (!Number.isFinite(v)) return;
  if (group !== 1) return; // group 1 = bin grid definition parameters
  switch (item) {
    case 1: if (!Number.isFinite(g.firstInline) || g.firstInline === 0) g.firstInline = v; break;
    case 2: if (!Number.isFinite(g.firstCrossline) || g.firstCrossline === 0) g.firstCrossline = v; break;
    case 3: if (!Number.isFinite(g.originE)) g.originE = v; break;
    case 4: if (!Number.isFinite(g.originN)) g.originN = v; break;
    // 5 = scale factor - not stored in BinGrid (corners use map-grid distances directly)
    case 6: if (!Number.isFinite(g.binI)) g.binI = v; break;
    case 7: if (!Number.isFinite(g.binJ)) g.binJ = v; break;
    case 8: if (g._jBearing == null) g._jBearing = norm360(v); break;
    case 9: if (g.incInline === 1) g.incInline = v; break;
    case 10: if (g.incCrossline === 1) g.incCrossline = v; break;
    default: break;
  }
}

/**
 * Compute the four grid corners (E/N, projected) from the origin, the I/J axis
 * bearings, the bin widths and the node counts.
 *
 * EXTENT CONVENTION: nInline / nCrossline are NODE counts, so the grid spans
 * (n - 1) bin INTERVALS on each axis - NOT n. The physical extents are therefore
 * Wi = (nInline - 1)·binI, Wj = (nCrossline - 1)·binJ. The renderer's overlay uses
 * the SAME (n - 1) convention, so the drawn outline and the interior guides agree
 * (using n·bin here over-extended the outline by exactly one bin on each axis).
 *
 * The I-axis unit vector points along bearing `iBearing` (clockwise from grid
 * north), the J-axis along the FILE's actual `jBearing` (which is NOT assumed to be
 * iBearing+90 - EPSG "I=J-90" handedness and sheared grids violate orthogonality).
 * A bearing θ (deg, clockwise from N) maps to (dE, dN) = (sin θ, cos θ). Corners are
 * origin + a·I + b·J for a∈{0,Wi}, b∈{0,Wj}, walked origin → +I → +I+J → +J.
 */
function computeCorners(g: Mutable): void {
  const { originE, originN } = g;
  if (!Number.isFinite(originE) || !Number.isFinite(originN)) return;
  if (g._iBearing == null && g._jBearing == null) return;
  const wi = g.nInline > 0 && Number.isFinite(g.binI) ? Math.max(0, g.nInline - 1) * g.binI : NaN;
  const wj = g.nCrossline > 0 && Number.isFinite(g.binJ) ? Math.max(0, g.nCrossline - 1) * g.binJ : NaN;
  if (!Number.isFinite(wi) || !Number.isFinite(wj)) return;
  const iB = g._iBearing != null ? g._iBearing : norm360((g._jBearing as number) - 90);
  const jB = g._jBearing != null ? g._jBearing : norm360((g._iBearing as number) + 90);
  const iE = Math.sin(iB * D2R), iN = Math.cos(iB * D2R);
  const jE = Math.sin(jB * D2R), jN = Math.cos(jB * D2R);
  const at = (a: number, b: number) => ({ e: originE + a * iE + b * jE, n: originN + a * iN + b * jN });
  g.corners = [at(0, 0), at(wi, 0), at(wi, wj), at(0, wj)];
}

/**
 * Parse IOGP P6/11 bin-grid text into a {@link BinGrid}.
 *
 * CONTRACT (do not change this signature): `(text: string) => BinGrid`. Malformed
 * input must NEVER throw - return a (possibly empty) BinGrid. Bounded + non-throwing.
 */
export function parseP611(text: string): BinGrid {
  const g = emptyBinGrid() as Mutable;
  try {
    let src = typeof text === 'string' ? text : '';
    // Bound the input BEFORE splitting so the newline split can't materialise an
    // O(file) array from an attacker-controlled newline count (the per-line and
    // line-count caps below only bound the scan loop, not the split allocation).
    if (src.length > MAX_TEXT_LEN) src = src.slice(0, MAX_TEXT_LEN);
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

    const projHeaders: SPSHeader[] = [];

    // Scan newline-delimited lines with an index loop (no full split) up to the
    // line cap, so neither the line array nor the per-line work is unbounded.
    let pos = 0;
    let rawBytes = 0; // running size of retained g.raw text (aggregate byte budget)
    for (let li = 0; li < MAX_LINES && pos <= src.length; li++) {
      let nl = src.indexOf('\n', pos);
      if (nl < 0) nl = src.length;
      let line: string | null = src.slice(pos, nl);
      pos = nl + 1;
      if (line.length && line.charCodeAt(line.length - 1) === 0x0d) line = line.slice(0, -1); // strip CR
      if (line == null) continue;
      if (line.length > MAX_LINE_LEN) line = line.slice(0, MAX_LINE_LEN);
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (g.raw.length < MAX_RAW && rawBytes + trimmed.length <= MAX_RAW_BYTES) {
        g.raw.push(trimmed);
        rawBytes += trimmed.length;
      }

      const fs = fields(line);
      if (!fs.length) continue;
      const tag = (fs[0] || '').toUpperCase();
      const c0 = trimmed[0].toUpperCase();

      // Comment / provenance.
      if (c0 === 'C') continue;

      // -- Survey name (H1 "Survey area" style record). --
      if (!g.name && (tag === 'H1' || tag === 'H01' || /\bsurvey\b/i.test(trimmed)) && /name|area|survey/i.test(trimmed)) {
        // the descriptive value is the last non-numeric field
        for (let i = fs.length - 1; i >= 1; i--) {
          const t = fs[i];
          if (t && !Number.isFinite(num(t))) { g.name = t.slice(0, 256); break; }
        }
      }

      // -- Projection / map-grid CRS H-records (reuse the SPS extractor). --
      // Carry any classic SPS-style projection header (H12/H14/H18/H19/H20/H22x…)
      // so a map CRS embedded in the P6/11 banner is recovered identically.
      if (c0 === 'H' && /^H\d/.test(tag)) {
        // Build a synthetic SPSHeader. P6/11 rows are "Hnn, descriptive label,
        // VALUE[, VALUE…]" - the DATA value is the TRAILING field(s), the middle
        // fields are the human label (which `spsExtractProjection` does not expect).
        // A spheroid row 'H12, Spheroid, WGS84, 6378137.0, 298.257' and a 7-param
        // Helmert row 'H14, …, dx, dy, dz, rx, ry, rz, ds' carry MULTIPLE trailing
        // numeric data fields, so taking only the LAST field would collapse "a invF"
        // (and the Helmert tuple) to a single number and the extractor's multi-number
        // patterns would never match. Join the contiguous trailing run of numeric
        // fields with a space; otherwise (single-token value like H18 "UTM" or H19
        // "36 North") use the last field.
        const code = tag.replace(/[^A-Z0-9]/g, '').slice(0, 4);
        if (code && safeKey(code)) {
          let val = '';
          if (fs.length > 1) {
            // Find the start of the contiguous trailing numeric run.
            let start = fs.length;
            while (start > 1 && Number.isFinite(num(fs[start - 1].replace(/;.*$/, '')))) start--;
            if (fs.length - start >= 2) {
              // Include the single non-numeric token immediately preceding the
              // numeric run (e.g. the spheroid name "WGS84" in a H12 row) so the
              // extractor can recover a datum/ellipsoid name alongside a + invF.
              const nameTok =
                start > 1 && fs[start - 1] && !Number.isFinite(num(fs[start - 1])) ? fs[start - 1].trim() : '';
              val = (nameTok ? nameTok + ' ' : '')
                + fs
                    .slice(start)
                    .map((t) => t.replace(/;.*$/, '').trim())
                    .filter((t) => t)
                    .join(' ');
            } else {
              val = fs[fs.length - 1].replace(/;.*$/, '').trim();
            }
          }
          val = val.slice(0, MAX_LINE_LEN);
          if (val) projHeaders.push({ code, val, raw: trimmed });
        }
      }

      // -- Structured H6 bin-grid parameter rows (H6,group,item,…,value). --
      if (tag === 'H6' || tag === 'H06') {
        applyStructuredH6(g, fs);
      }

      // -- Label-matched scalar parameters (the tolerant primary path). --
      const flatText = flat(trimmed);
      const v = lastNum(fs);
      if (Number.isFinite(v)) {
        for (const p of PARAM_TABLE) {
          if (p.test(flatText)) { p.set(g, v); break; }
        }
      } else {
        // bearings may carry a sexagesimal value lastNum can't read - retry those.
        for (const p of PARAM_TABLE) {
          if (/bearing/.test(flatText) && p.test(flatText)) {
            const b = parseBearing(fs[fs.length - 1]);
            if (Number.isFinite(b)) p.set(g, b);
            break;
          }
        }
      }
    }

    // -- Reconcile axis bearing onto inlineAzimuth. --
    // The BinGrid's `inlineAzimuth` is the bearing of the INLINE (I) axis. The P6
    // format primarily carries the J-axis bearing; under the EPSG "I=J-90"
    // convention the I-axis bearing = J-axis bearing - 90.
    if (g._iBearing != null) g.inlineAzimuth = norm360(g._iBearing);
    else if (g._jBearing != null) g.inlineAzimuth = norm360(g._jBearing - 90);

    // Carry the crossline (J) axis bearing EXPLICITLY: it is the file's actual
    // J-bearing when present (which is NOT always inline+90 - EPSG "I=J-90"
    // handedness / sheared grids), else inline+90 as a fallback. The renderer MUST
    // use this rather than assuming orthogonality.
    if (g._jBearing != null) g.crosslineAzimuth = norm360(g._jBearing);
    else if (g._iBearing != null) g.crosslineAzimuth = norm360(g._iBearing + 90);

    // -- Derive the four grid corners for overlay (origin + rotation + extents). --
    computeCorners(g);

    // -- Map CRS from the projection H-records (null when none present). --
    if (projHeaders.length) {
      const proj: SPSProjection = spsExtractProjection(projHeaders);
      // Only attach a CRS if the headers actually defined a projection type/datum.
      if (proj.type || proj.datum || proj.subtype || proj.helmert) g.crs = proj;
    }
  } catch {
    // Per the hard rule: malformed input never throws out of the parser. Return
    // whatever we accumulated (possibly the empty grid) and let the caller decide.
  }

  // Strip the private scratch fields before returning the public BinGrid.
  delete g._iBearing;
  delete g._jBearing;
  return g;
}
