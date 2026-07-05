// seisconv-core / sps — fixed-column SPS 2.1 S/R/X writer.
//
// The missing counterpart to {@link parseSPSText}: serialise an SPSData back to
// the three 80-column SPS 2.1 files (.s sources, .r receivers, .x cross-ref).
// Every column is placed EXACTLY where the parser reads it (the single source of
// truth is `SPS_COORD_SPANS['SPS2.1']` for E/N/elev and the documented ID / X
// offsets), so `parseSPSText(buildSPS(d))` reproduces line/point/idx/E/N/elev and
// the X src+rcv line/point ranges + channel ranges. Pure — no DOM/Node/Electron.

import { SPS_COORD_SPANS, type SPSData, type SPSPoint, type SPSProjection, type SPSXref } from './parse';
import { fitNum, generateProjHeaders, type CRS } from './reproject';

// ── SPS 2.1 fixed columns (0-based, end-exclusive) — mirror parse.ts ──
// S/R record: record-id col 0; line 1..11; point 11..21; point-index char 23;
// E/N/elev from SPS_COORD_SPANS['SPS2.1'] (E 46..55, N 55..65, elev 65..71).
const SR = { idCol: 0, lineStart: 1, lineEnd: 11, ptStart: 11, ptEnd: 21, idxCol: 23, elevWidth: 6 };
// X record (SPS 2.1 spec form): tape 1..7, ffid 7..15, srcLine 17..27,
// srcPt 27..37, srcIdx 37, fromCh 38..43, toCh 43..48, chIncr 48, rcvLine 49..59,
// rcvPtFrom 59..69, rcvPtTo 69..79, rcvIdx 79.
const X = {
  tapeStart: 1, tapeEnd: 7, ffidStart: 7, ffidEnd: 15, srcLineStart: 17, srcLineEnd: 27,
  srcPtStart: 27, srcPtEnd: 37, srcIdxCol: 37, fromChStart: 38, fromChEnd: 43, toChStart: 43,
  toChEnd: 48, chIncrCol: 48, rcvLineStart: 49, rcvLineEnd: 59, rcvPtFromStart: 59, rcvPtFromEnd: 69,
  rcvPtToStart: 69, rcvPtToEnd: 79, rcvIdxCol: 79,
};

/** Write `txt` into a fixed-width char buffer at `start` (clipped to the buffer). */
function put(buf: string[], start: number, txt: string): void {
  for (let i = 0; i < txt.length && start + i < buf.length; i++) buf[start + i] = txt[i];
}

/**
 * Right-justify a STRING into exactly `width` columns (clip from the left tail if
 * it overflows so it never pushes later columns). Used for line names / tape ids
 * whose value is textual, not numeric.
 */
export function padSPSField(s: string, width: number): string {
  s = (s ?? '').trim();
  return s.length > width ? s.slice(0, width) : s.padStart(width);
}

/**
 * Right-justify a NUMBER into exactly `width` columns. Integers print without a
 * decimal point (clean SPS output that still re-parses); non-integers defer to
 * {@link fitNum} (keeps as many of 2 decimals as fit, clipping the integer part
 * only as a last resort). A non-finite value yields a blank field (the parser
 * then skips it rather than reading garbage) — callers guard finiteness upstream.
 */
export function fmtSPSNum(v: number, width: number): string {
  if (!isFinite(v)) return ' '.repeat(width);
  if (Number.isInteger(v)) {
    const s = String(v);
    return s.length > width ? s.slice(0, width) : s.padStart(width);
  }
  return fitNum(v, width);
}

function xs(x: SPSXref, k: string): string {
  const v = x[k];
  return v == null ? '' : String(v);
}
function xn(x: SPSXref, k: string): number {
  const v = x[k];
  return typeof v === 'number' ? v : v != null ? parseFloat(String(v)) : NaN;
}

/** Serialise one S/R point to an 80-column SPS 2.1 line (trailing blanks trimmed). */
function buildPointLine(p: SPSPoint): string {
  const SP = SPS_COORD_SPANS['SPS2.1'];
  const buf = new Array(80).fill(' ');
  buf[SR.idCol] = p.rtype;
  put(buf, SR.lineStart, padSPSField(p.lineName || '', SR.lineEnd - SR.lineStart));
  put(buf, SR.ptStart, fmtSPSNum(p.point, SR.ptEnd - SR.ptStart));
  if (p.idx) buf[SR.idxCol] = p.idx[0];
  put(buf, SP.eStart, fmtSPSNum(p.easting, SP.eEnd - SP.eStart));
  put(buf, SP.nStart, fmtSPSNum(p.northing, SP.nEnd - SP.nStart));
  put(buf, SP.tail, fmtSPSNum(p.elevation, SR.elevWidth));
  return buf.join('').replace(/\s+$/, '');
}

/** Serialise one cross-reference to an 80-column SPS 2.1 X line. */
function buildXLine(x: SPSXref): string {
  const buf = new Array(80).fill(' ');
  buf[0] = 'X'; // record identifier (col 0) — without it the parser skips the line
  put(buf, X.tapeStart, padSPSField(xs(x, 'tape'), X.tapeEnd - X.tapeStart));
  put(buf, X.ffidStart, fmtSPSNum(xn(x, 'ffid'), X.ffidEnd - X.ffidStart));
  put(buf, X.srcLineStart, padSPSField(xs(x, 'srcLine'), X.srcLineEnd - X.srcLineStart));
  put(buf, X.srcPtStart, fmtSPSNum(xn(x, 'srcPt'), X.srcPtEnd - X.srcPtStart));
  const srcIdx = xs(x, 'srcIdx');
  if (srcIdx) buf[X.srcIdxCol] = srcIdx[0];
  const fromCh = xn(x, 'fromCh');
  put(buf, X.fromChStart, fmtSPSNum(isFinite(fromCh) ? fromCh : 1, X.fromChEnd - X.fromChStart));
  put(buf, X.toChStart, fmtSPSNum(xn(x, 'toCh'), X.toChEnd - X.toChStart));
  const chIncr = xn(x, 'chIncr');
  buf[X.chIncrCol] = String(isFinite(chIncr) && chIncr >= 1 ? Math.round(chIncr) : 1).slice(0, 1);
  const rcvLine = xs(x, 'rcvLine') || xs(x, 'rcvLineFrom');
  put(buf, X.rcvLineStart, padSPSField(rcvLine, X.rcvLineEnd - X.rcvLineStart));
  put(buf, X.rcvPtFromStart, fmtSPSNum(xn(x, 'rcvPtFrom'), X.rcvPtFromEnd - X.rcvPtFromStart));
  put(buf, X.rcvPtToStart, fmtSPSNum(xn(x, 'rcvPtTo'), X.rcvPtToEnd - X.rcvPtToStart));
  const rcvIdx = xs(x, 'rcvIdx');
  if (rcvIdx) buf[X.rcvIdxCol] = rcvIdx[0];
  return buf.join('').replace(/\s+$/, '');
}

/**
 * Bridge an {@link SPSProjection} (parser model) to a {@link CRS} so the H-record
 * block can be generated by {@link generateProjHeaders} (the reprojector's single
 * source of truth). Only the fields generateProjHeaders consumes are mapped.
 */
function crsFromProjection(p: SPSProjection): CRS {
  const epsg = (p.desc || '').match(/EPSG:\d+/i);
  return {
    code: epsg ? epsg[0].toUpperCase() : '',
    name: p.desc || p.type || p.datum || 'Custom',
    subtype: p.subtype || p.type || 'TM',
    zone: p.zone ?? undefined,
    hemi: p.hemi ?? undefined,
    a: p.a ?? undefined,
    f: p.invF ? 1 / p.invF : undefined,
    lon0: p.centralMeridian ?? undefined,
    lat0: p.latOrigin ?? undefined,
    k0: p.scaleFactor ?? undefined,
    FE: p.falseEasting ?? undefined,
    FN: p.falseNorthing ?? undefined,
    helmert: p.helmert ?? undefined,
  };
}

/** Sanitise a free-text header value to one printable ASCII line (clipped). */
function hVal(s: string): string {
  return (s ?? '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 46);
}

/** One H-record: the `H<code> <label>` text padded to col 32, then the value. */
function hLine(idLabel: string, value: string): string {
  return idLabel.padEnd(32) + value;
}

/**
 * The full canonical SPS 2.1 header block, led by **H00** — the SPS-format-version
 * record every downstream application reads first to identify the file's type and
 * revision. Identification + administrative records carry the values we know
 * (survey name, date written, projection) and `N/A` otherwise, in the same order
 * and fixed-column layout real acquisition software (e.g. OMNI) writes, so a
 * generated survey opens cleanly anywhere. The projection records come from the
 * shared {@link generateProjHeaders} so they stay byte-identical to a reprojected
 * file; the few records it doesn't emit (vertical datum, standard parallel, lat/long
 * scale factor, and the H14 note) are filled in here to complete the block.
 */
function buildHeaderBlock(data: SPSData, surveyName: string, dateWritten?: string): string[] {
  const name = hVal(surveyName) || 'survey';
  const dw = hVal(dateWritten || '') || 'N/A';
  const lines: string[] = [
    hLine('H00 SPS format version num.', 'SPS 2.1;'),
    hLine('H01 Description of survey area', ',' + name + ';'),
    hLine('H02 Date of survey', 'N/A,N/A;'),
    hLine('H021Post-plot date of issue', 'N/A;'),
    hLine('H022Tape/disk identifier', 'N/A;'),
    hLine('H023Line sequence number', 'N/A;'),
    hLine('H26 Date file written', dw + ';'),
    hLine('H03 Client', ';'),
    hLine('H04 Geophysical contractor', 'N/A;'),
    hLine('H05 Positioning contractor', 'N/A;'),
    hLine('H06 Pos. proc. contractor', 'N/A;'),
    hLine('H07 Field computer system(s)', 'N/A;'),
    hLine('H08 Coordinate location', 'N/A;'),
    hLine('H09 Offset from coord. location', 'N/A;'),
    hLine('H10 Clock time w.r.t GMT', 'N/A;'),
  ];
  // Projection block — shared records from generateProjHeaders, interleaved with
  // the static ones in canonical order so the file reads like a real survey header.
  if (data.projection) {
    const p = generateProjHeaders(crsFromProjection(data.projection));
    const push = (code: string): void => { if (p[code]) lines.push(p[code]); };
    push('H12'); push('H14');
    lines.push('H26 H14 are datum transformation parameters to WGS84');
    lines.push(hLine('H17 Vertical datum description', 'N/A;'));
    push('H18'); push('H19'); push('H20'); push('H201');
    lines.push(hLine('H210Lat. of standard parallel(s)', 'N/A;'));
    push('H220'); push('H231'); push('H232'); push('H241');
    lines.push(hLine('H242Lat., long. scale factor', 'N/A;'));
  }
  lines.push(hLine('H30 Project code and description', 'N/A,,N/A;'));
  lines.push(hLine('H31 Line number format', 'N/A;'));
  return lines;
}

/**
 * Serialise an {@link SPSData} to the three SPS 2.1 files. Returns
 * `[{name:'<base>.s'},{name:'<base>.r'},{name:'<base>.x'}]`; the round-trip
 * contract is `parseSPSText` of each output reproduces the source/receiver/xref
 * line/point/idx/E/N/elev and X line/point + channel ranges.
 *
 * - `baseName` — file stem (default `survey`).
 * - `emitHeaders` — prepend the full canonical SPS 2.1 header block (led by **H00**,
 *   the format-version record) to every file via {@link buildHeaderBlock}: the
 *   identification + administrative records plus the projection block from
 *   `data.projection`. Without it, no header records are written.
 * - `dateWritten` — value for the `H26 Date file written` record (e.g.
 *   `2026-06-28 14:43:31`); the caller supplies it because the pure core / worker
 *   can't read the clock. Defaults to `N/A`.
 * - `xRecordForm` — only `'SPS2.1'` is supported (default); accepted for forward
 *   compatibility.
 */
export function buildSPS(
  data: SPSData,
  opts?: { baseName?: string; emitHeaders?: boolean; xRecordForm?: 'SPS2.1'; dateWritten?: string },
): { name: string; text: string }[] {
  const base = (opts?.baseName || 'survey').trim() || 'survey';
  let headerLines: string[] = [];
  if (opts?.emitHeaders) {
    headerLines = buildHeaderBlock(data, base, opts.dateWritten);
  }
  const sLines = data.sources.map(buildPointLine);
  const rLines = data.receivers.map(buildPointLine);
  const xLines = data.xrefs.map(buildXLine);
  const join = (body: string[]): string => [...headerLines, ...body].join('\n');
  return [
    { name: `${base}.s`, text: join(sLines) },
    { name: `${base}.r`, text: join(rLines) },
    { name: `${base}.x`, text: join(xLines) },
  ];
}
