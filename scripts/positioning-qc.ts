// seisconv — POSITIONING-FORMAT QC harness (REAL Israeli SPS survey data)
//
// Validates the NEW positioning-format readers/writers in core/sps/formats by
// round-tripping a REAL SPS survey triplet (.s01 / .r01 / .x01) through every
// format and asserting that the survey geometry survives.
//
// What it checks, per format:
//   1. P1/11      buildP111(real) -> parseP111 -> per-point E/N/elev/line/point/idx
//                 preserved (within 1e-3 m); source/receiver counts preserved.
//   2. coord-CSV  buildCoordCsv(real) -> parseCoordCsv -> same per-point assertions
//                 PLUS the CRS tag must survive the round-trip.
//   3. SEG-P1     (read-only — no writer) synthesize a spec-compliant SEG-P1 file
//                 FROM the real source points (fixed 80-col record), parseSegP1 it,
//                 assert E/N/elev match. SEG-P1 grid fields are integer DECIMETRES,
//                 so the inherent tolerance is 0.05 m (half a decimetre).
//   4. P6/11      (read-only) synthesize a realistic bin grid from the real survey
//                 extent (origin = min E / min N, 25x25 m bins, a plausible inline
//                 azimuth, node counts spanning the extent), write a spec-shaped
//                 P6/11 H-record header block, parseP611 it, assert origin / bin
//                 sizes / azimuth / corners read back correctly.
//
// REAL DATA (read-only — the user's own files; never modified):
//   default  ./samples/sps/EPSG_2039/survey  (ITM / EPSG:2039)
//   env      SEISCONV_SPS_DIR + SEISCONV_SPS_BASE point at any other triplet (e.g. a UTM 36N survey).
//
// Run:
//   npx tsx scripts/positioning-qc.ts        (from the repo root)
//   SEISCONV_SPS_DIR="./samples/sps/survey" SEISCONV_SPS_BASE=survey npx tsx scripts/positioning-qc.ts
//
// Exits nonzero on any FAIL.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSPSText, mergeSPSData, type SPSData, type SPSPoint } from '../core/sps/parse';
import { parseP111, buildP111 } from '../core/sps/formats/p111';
import { parseCoordCsv, buildCoordCsv } from '../core/sps/formats/coordcsv';
import { parseSegP1 } from '../core/sps/formats/segp1';
import { parseP611 } from '../core/sps/formats/p611';

// ── Config: default to the bundled ITM sample triplet so it runs with no args. ──
const DEFAULT_DIR = './samples/sps/EPSG_2039';
const DEFAULT_BASE = 'survey';
const DIR = process.env.SEISCONV_SPS_DIR || DEFAULT_DIR;
const BASE = process.env.SEISCONV_SPS_BASE || DEFAULT_BASE;

// Per-point match tolerances.
const TOL_EXACT = 1e-3; // P1/11 + coord-CSV carry full-precision metres → 1e-3 m.
// SEG-P1 grid fields are integer DECIMETRES, so writing a metres value quantizes
// it to the nearest 0.1 m → max round-trip error is half a decimetre = 0.05 m.
// We allow 0.051 m so a value sitting exactly on the round-half boundary (e.g.
// 651970.85 → 6519709 dm → 651970.9 m, delta 0.05 m) is not flagged by a float
// representation a hair above 0.05. This tolerance is the format's inherent
// quantization, NOT loose validation — sub-0.06 m is below SEG-P1's resolution.
const TOL_SEGP1 = 0.051;
const TOL_GRID = 1e-3; // bin-grid origin / bin size.
const TOL_AZ = 1e-6; // azimuth, degrees.
const TOL_CORNER = 1e-3; // corner E/N, metres.

// ── Tiny assertion plumbing ──
interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
function fmtN(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : String(v);
}

/** Read one SPS sidecar; returns '' (with a note) if missing so a partial triplet
 *  still exercises whatever is present rather than aborting the whole run. */
function readMaybe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Load + merge a real .s01/.r01/.x01 triplet into one SPSData. */
function loadTriplet(dir: string, base: string): { data: SPSData; loaded: string[]; missing: string[] } {
  const parts: { ext: string; data: SPSData }[] = [];
  const loaded: string[] = [];
  const missing: string[] = [];
  for (const ext of ['s01', 'r01', 'x01']) {
    const path = join(dir, `${base}.${ext}`);
    const text = readMaybe(path);
    if (text == null) {
      missing.push(`${base}.${ext}`);
      continue;
    }
    loaded.push(`${base}.${ext}`);
    parts.push({ ext, data: parseSPSText(text) });
  }
  if (!parts.length) throw new Error(`No SPS files readable under ${dir} for base "${base}"`);
  let merged = parts[0].data;
  for (let i = 1; i < parts.length; i++) merged = mergeSPSData(merged, parts[i].data);
  return { data: merged, loaded, missing };
}

// ── Per-point comparison (the heart of every round-trip check) ──
interface PointCmp {
  total: number;
  matched: number;
  mismatches: { idx: number; field: string; a: number | string; b: number | string }[];
}

/** Compare two point arrays positionally. Asserts lineName/point/idx exactly and
 *  E/N/elevation within `tol`. Returns the matched count + first few mismatches. */
function comparePoints(orig: SPSPoint[], back: SPSPoint[], tol: number): PointCmp {
  const out: PointCmp = { total: orig.length, matched: 0, mismatches: [] };
  if (orig.length !== back.length) {
    out.mismatches.push({ idx: -1, field: 'count', a: orig.length, b: back.length });
    return out;
  }
  for (let i = 0; i < orig.length; i++) {
    const a = orig[i];
    const b = back[i];
    let ok = true;
    const push = (field: string, av: number | string, bv: number | string) => {
      ok = false;
      if (out.mismatches.length < 8) out.mismatches.push({ idx: i, field, a: av, b: bv });
    };
    // Identity fields — exact.
    if ((a.lineName || '').trim() !== (b.lineName || '').trim()) push('lineName', a.lineName, b.lineName);
    if (a.point !== b.point) push('point', a.point, b.point);
    if ((a.idx || '') !== (b.idx || '')) push('idx', a.idx, b.idx);
    // Coordinate fields — within tolerance.
    if (Math.abs(a.easting - b.easting) > tol) push('easting', fmtN(a.easting), fmtN(b.easting));
    if (Math.abs(a.northing - b.northing) > tol) push('northing', fmtN(a.northing), fmtN(b.northing));
    if (Math.abs((a.elevation || 0) - (b.elevation || 0)) > tol) push('elevation', fmtN(a.elevation), fmtN(b.elevation));
    if (ok) out.matched++;
  }
  return out;
}

/** Coordinate-only comparison (SEG-P1 carries no line/point identity reliably from
 *  a synthesized file the same way — we synthesize identity too, but assert coords
 *  as the load-bearing geometry). */
function compareCoords(orig: SPSPoint[], back: SPSPoint[], tol: number): PointCmp {
  const out: PointCmp = { total: orig.length, matched: 0, mismatches: [] };
  if (orig.length !== back.length) {
    out.mismatches.push({ idx: -1, field: 'count', a: orig.length, b: back.length });
    return out;
  }
  for (let i = 0; i < orig.length; i++) {
    const a = orig[i];
    const b = back[i];
    let ok = true;
    const push = (field: string, av: number | string, bv: number | string) => {
      ok = false;
      if (out.mismatches.length < 8) out.mismatches.push({ idx: i, field, a: av, b: bv });
    };
    if (Math.abs(a.easting - b.easting) > tol) push('easting', fmtN(a.easting), fmtN(b.easting));
    if (Math.abs(a.northing - b.northing) > tol) push('northing', fmtN(a.northing), fmtN(b.northing));
    if (Math.abs((a.elevation || 0) - (b.elevation || 0)) > tol) push('elevation', fmtN(a.elevation), fmtN(b.elevation));
    if (ok) out.matched++;
  }
  return out;
}

// ── SEG-P1 synthesis (spec-compliant fixed-column record) ──
//
// Column map verified against core/sps/formats/segp1.ts (0-based, end-exclusive):
//   col(ln,1,17)   line name        (cols 2-17, 1-based)
//   intField(17,25) shotpoint       (cols 18-25)
//   col(25,26)     reshoot/idx      (col 26)
//   packedDMS(26,35) latitude       (cols 27-35)
//   packedDMS(35,45) longitude      (cols 36-45)
//   gridField(45,53) easting        (cols 46-53)   ── integer DECIMETRES (no '.')
//   gridField(53,61) northing       (cols 54-61)   ── integer DECIMETRES
//   gridField(61,66) elevation      (cols 62-66)   ── integer DECIMETRES
// We emit the integer-decimetres convention (the IHS/AccuMap variant the reader
// auto-detects when no decimal point is present), so the reader divides by 10.
function padCols(s: string, width: number): string {
  return (s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length));
}
/** Right-justify an integer string into a fixed field (SEG-P1 numeric fields are
 *  right-aligned). Truncates from the LEFT if it overflows (should never for real
 *  Israeli coordinates, which fit). */
function rjInt(v: number, width: number): string {
  const s = String(Math.round(v));
  return s.length >= width ? s.slice(s.length - width) : ' '.repeat(width - s.length) + s;
}
function buildSegP1FromSources(srcs: SPSPoint[]): string {
  const lines: string[] = [];
  lines.push('HSEG-P1 synthetic post-plot — generated by positioning-qc from real SPS source points');
  lines.push('HCOORDINATE SYSTEM: projected grid, metres');
  for (const s of srcs) {
    let ln = ' '; // col 1: blank record id → shotpoint (classifyRtype default 'S')
    ln += padCols(s.lineName || '', 16); // cols 2-17
    ln += rjInt(s.point, 8); // cols 18-25
    ln += ' '; // col 26 reshoot/idx
    ln += padCols('', 9); // cols 27-35 latitude (left blank — grid carries the position)
    ln += padCols('', 10); // cols 36-45 longitude
    ln += rjInt(s.easting * 10, 8); // cols 46-53 easting in DECIMETRES
    ln += rjInt(s.northing * 10, 8); // cols 54-61 northing in DECIMETRES
    ln += rjInt((s.elevation || 0) * 10, 5); // cols 62-66 elevation in DECIMETRES
    lines.push(ln);
  }
  return lines.join('\n') + '\n';
}

// ── P6/11 synthesis (spec-shaped H6 bin-grid header) ──
//
// Built from the real survey extent. Origin = (minE, minN); 25x25 m bins; a
// plausible inline azimuth; node counts spanning the extent. We emit the
// structured H6,group,item,value rows that applyStructuredH6 understands PLUS a
// label row for the J-axis bearing (the format's primary bearing), so parseP611
// recovers origin / bin sizes / bearing / node counts → corners.
interface SynthGrid {
  originE: number;
  originN: number;
  binI: number;
  binJ: number;
  nInline: number;
  nCrossline: number;
  jBearing: number; // map grid bearing of the J (crossline) axis, deg CW from N
}
function synthesizeBinGrid(pts: SPSPoint[]): SynthGrid {
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const p of pts) {
    if (p.easting < minE) minE = p.easting;
    if (p.northing < minN) minN = p.northing;
    if (p.easting > maxE) maxE = p.easting;
    if (p.northing > maxN) maxN = p.northing;
  }
  const binI = 25, binJ = 25;
  const spanE = Math.max(1, maxE - minE);
  const spanN = Math.max(1, maxN - minN);
  // Node counts span the extent (node count = intervals + 1).
  const nInline = Math.max(2, Math.ceil(spanE / binI) + 1);
  const nCrossline = Math.max(2, Math.ceil(spanN / binJ) + 1);
  return { originE: minE, originN: minN, binI, binJ, nInline, nCrossline, jBearing: 35 };
}
function buildP611(g: SynthGrid): string {
  const L: string[] = [];
  L.push('H6,P6/11 synthetic bin grid — generated by positioning-qc');
  L.push('H1,Survey area,name,QC-SYNTH-GRID');
  // Structured H6,group,item,value rows (group 1 = bin-grid definition).
  L.push(`H6,1,1,bin grid origin I,1`);
  L.push(`H6,1,2,bin grid origin J,1`);
  L.push(`H6,1,3,bin grid origin Easting,${g.originE}`);
  L.push(`H6,1,4,bin grid origin Northing,${g.originN}`);
  L.push(`H6,1,5,scale factor,1.0`);
  L.push(`H6,1,6,bin width on I axis,${g.binI}`);
  L.push(`H6,1,7,bin width on J axis,${g.binJ}`);
  L.push(`H6,1,8,map grid bearing of bin grid J axis,${g.jBearing}`);
  L.push(`H6,1,9,bin node increment on I axis,1`);
  L.push(`H6,1,10,bin node increment on J axis,1`);
  // Node-count rows (label-matched path).
  L.push(`H6,number of inlines,${g.nInline}`);
  L.push(`H6,number of crosslines,${g.nCrossline}`);
  return L.join('\n') + '\n';
}

// Expected corners under the same convention parseP611's computeCorners uses:
//   I-axis bearing = jBearing - 90; extents = (n-1)*bin; corner = origin + a*I + b*J.
function expectedCorners(g: SynthGrid): { e: number; n: number }[] {
  const D2R = Math.PI / 180;
  const jB = g.jBearing;
  const iB = ((jB - 90) % 360 + 360) % 360;
  const wi = (g.nInline - 1) * g.binI;
  const wj = (g.nCrossline - 1) * g.binJ;
  const iE = Math.sin(iB * D2R), iN = Math.cos(iB * D2R);
  const jE = Math.sin(jB * D2R), jN = Math.cos(jB * D2R);
  const at = (a: number, b: number) => ({ e: g.originE + a * iE + b * jE, n: g.originN + a * iN + b * jN });
  return [at(0, 0), at(wi, 0), at(wi, wj), at(0, wj)];
}

// ── Main ──
function main(): number {
  console.log('seisconv — POSITIONING-FORMAT QC (real Israeli SPS data)');
  console.log('========================================================');
  console.log(`dir:  ${DIR}`);
  console.log(`base: ${BASE}`);
  console.log('');

  let real: SPSData;
  let loaded: string[];
  let missing: string[];
  try {
    const r = loadTriplet(DIR, BASE);
    real = r.data;
    loaded = r.loaded;
    missing = r.missing;
  } catch (e) {
    // No local corpus → SKIP (exit 0), matching the file-backed-tests philosophy.
    // This gate only runs where a real SPS triplet is present.
    console.log(`SKIP: no real SPS triplet at "${DIR}" (base "${BASE}").`);
    console.log('      Set SEISCONV_SPS_DIR + SEISCONV_SPS_BASE to a local .s01/.r01/.x01 triplet to run this gate.');
    console.log(`      (${(e as Error).message})`);
    return 0;
  }

  // ── Real survey stats ──
  const proj = real.projection;
  const allPts = [...real.sources, ...real.receivers];
  const ext = (() => {
    let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
    for (const p of allPts) {
      if (p.easting < minE) minE = p.easting;
      if (p.northing < minN) minN = p.northing;
      if (p.easting > maxE) maxE = p.easting;
      if (p.northing > maxN) maxN = p.northing;
    }
    return { minE, minN, maxE, maxN };
  })();
  console.log('REAL SURVEY STATS');
  console.log('-----------------');
  console.log(`  files loaded:   ${loaded.join(', ')}${missing.length ? `   (missing: ${missing.join(', ')})` : ''}`);
  console.log(`  sources:        ${real.sources.length}`);
  console.log(`  receivers:      ${real.receivers.length}`);
  console.log(`  xrefs:          ${real.xrefs.length}`);
  console.log(`  layout:         ${real.layout}`);
  console.log(`  parse errors:   ${real.errors.length}   skipped: ${real.skipped}`);
  console.log(
    `  projection:     type=${proj?.type ?? '-'}  subtype=${proj?.subtype ?? '-'}  zone=${proj?.zone ?? '-'}${proj?.hemi ? proj.hemi : ''}  datum=${proj?.datum ?? '-'}  desc=${proj?.desc ?? '-'}`,
  );
  console.log(
    `  extent (E/N):   E ${fmtN(ext.minE)} … ${fmtN(ext.maxE)}    N ${fmtN(ext.minN)} … ${fmtN(ext.maxN)}`,
  );
  console.log('');

  const checks: Check[] = [];
  const addCheck = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // ── 1. P1/11 round-trip ──
  {
    const files = buildP111(real);
    const text = files[0].text;
    const back = parseP111(text);
    const cs = comparePoints(real.sources, back.sources, TOL_EXACT);
    const cr = comparePoints(real.receivers, back.receivers, TOL_EXACT);
    const countOk = back.sources.length === real.sources.length && back.receivers.length === real.receivers.length;
    const ok = countOk && cs.matched === cs.total && cr.matched === cr.total && cs.mismatches.length === 0 && cr.mismatches.length === 0;
    let detail = `sources ${cs.matched}/${cs.total} matched, receivers ${cr.matched}/${cr.total} matched (tol ${TOL_EXACT} m)`;
    if (!ok) {
      const ms = [...cs.mismatches, ...cr.mismatches].slice(0, 6).map((m) => `${m.field}@${m.idx}: ${m.a} vs ${m.b}`);
      detail += `  FIRST MISMATCHES: ${ms.join(' | ')}`;
    }
    addCheck('P1/11 point round-trip', ok, detail);
  }

  // ── 2. coord-CSV round-trip (+ CRS tag survives) ──
  {
    const files = buildCoordCsv(real);
    const text = files[0].text;
    const back = parseCoordCsv(text);
    // buildCoordCsv emits ALL points as one stream (sources then receivers); the
    // reader assigns rtype from the 'type' column, so sources/receivers split back.
    const cs = comparePoints(real.sources, back.sources, TOL_EXACT);
    const cr = comparePoints(real.receivers, back.receivers, TOL_EXACT);
    const countOk = back.sources.length === real.sources.length && back.receivers.length === real.receivers.length;
    // CRS tag survival: the rebuilt projection must resolve to the same subtype
    // (and zone, for UTM). Only assert when the real survey carried a projection.
    const tagLine = text.split('\n').find((l) => /^#\s*crs/i.test(l)) || '';
    let crsOk = true;
    let crsDetail = 'no projection on source survey — CRS tag not required';
    if (proj && proj.subtype) {
      const bp = back.projection;
      crsOk = !!bp && bp.subtype === proj.subtype && (proj.subtype !== 'UTM' || bp.zone === proj.zone);
      crsDetail = `tag="${tagLine.trim()}" → subtype ${bp?.subtype ?? '-'}${bp?.zone != null ? ' zone ' + bp.zone : ''} (orig subtype ${proj.subtype}${proj.zone != null ? ' zone ' + proj.zone : ''})`;
    }
    const ptOk = countOk && cs.matched === cs.total && cr.matched === cr.total;
    const ok = ptOk && crsOk;
    let detail = `sources ${cs.matched}/${cs.total}, receivers ${cr.matched}/${cr.total} matched (tol ${TOL_EXACT} m); CRS: ${crsDetail}`;
    if (!ptOk) {
      const ms = [...cs.mismatches, ...cr.mismatches].slice(0, 6).map((m) => `${m.field}@${m.idx}: ${m.a} vs ${m.b}`);
      detail += `  FIRST MISMATCHES: ${ms.join(' | ')}`;
    }
    addCheck('coord-CSV point round-trip + CRS tag', ok, detail);
  }

  // ── 3. SEG-P1 read-only (synthesize from real source points, then parse) ──
  {
    if (!real.sources.length) {
      addCheck('SEG-P1 synth → parse', false, 'no source points to synthesize from');
    } else {
      const text = buildSegP1FromSources(real.sources);
      const back = parseSegP1(text);
      // SEG-P1's default rtype for blank-id records is 'S', so all land in sources.
      const cc = compareCoords(real.sources, back.sources, TOL_SEGP1);
      const countOk = back.sources.length === real.sources.length;
      const ok = countOk && cc.matched === cc.total && cc.mismatches.length === 0;
      let detail = `${cc.matched}/${cc.total} source coords matched (tol ${TOL_SEGP1} m — decimetre quantization); parsed sources=${back.sources.length}, skipped=${back.skipped}`;
      if (!ok) {
        const ms = cc.mismatches.slice(0, 6).map((m) => `${m.field}@${m.idx}: ${m.a} vs ${m.b}`);
        detail += `  FIRST MISMATCHES: ${ms.join(' | ')}`;
      }
      addCheck('SEG-P1 synth → parse (E/N/elev)', ok, detail);
    }
  }

  // ── 4. P6/11 read-only (synthesize a realistic bin grid, then parse) ──
  {
    if (!allPts.length) {
      addCheck('P6/11 synth → parse', false, 'no points to derive an extent from');
    } else {
      const g = synthesizeBinGrid(allPts);
      const text = buildP611(g);
      const grid = parseP611(text);
      const expCorners = expectedCorners(g);
      const probs: string[] = [];
      const near = (got: number, exp: number, tol: number, label: string) => {
        if (!Number.isFinite(got) || Math.abs(got - exp) > tol) probs.push(`${label}: got ${fmtN(got)} exp ${fmtN(exp)}`);
      };
      near(grid.originE, g.originE, TOL_GRID, 'originE');
      near(grid.originN, g.originN, TOL_GRID, 'originN');
      near(grid.binI, g.binI, TOL_GRID, 'binI');
      near(grid.binJ, g.binJ, TOL_GRID, 'binJ');
      near(grid.nInline, g.nInline, 0.5, 'nInline');
      near(grid.nCrossline, g.nCrossline, 0.5, 'nCrossline');
      // inlineAzimuth = jBearing - 90 (the reader's I=J-90 convention).
      const expIaz = ((g.jBearing - 90) % 360 + 360) % 360;
      near(grid.inlineAzimuth, expIaz, TOL_AZ, 'inlineAzimuth');
      near(grid.crosslineAzimuth, g.jBearing, TOL_AZ, 'crosslineAzimuth(J)');
      // corners
      if (!grid.corners || grid.corners.length !== 4) {
        probs.push(`corners: got ${grid.corners?.length ?? 0} (expected 4)`);
      } else {
        for (let i = 0; i < 4; i++) {
          near(grid.corners[i].e, expCorners[i].e, TOL_CORNER, `corner${i}.E`);
          near(grid.corners[i].n, expCorners[i].n, TOL_CORNER, `corner${i}.N`);
        }
      }
      const ok = probs.length === 0;
      let detail = `origin (${fmtN(g.originE)}, ${fmtN(g.originN)})  bin ${g.binI}x${g.binJ}  nodes ${g.nInline}x${g.nCrossline}  J-bearing ${g.jBearing}° → inlineAz ${fmtN(grid.inlineAzimuth)}°; 4 corners`;
      if (!ok) detail += `  PROBLEMS: ${probs.slice(0, 8).join(' | ')}`;
      addCheck('P6/11 synth → parse (origin/bin/azimuth/corners)', ok, detail);
    }
  }

  // ── Final PASS/FAIL block ──
  console.log('RESULTS (PASS/FAIL per format)');
  console.log('------------------------------');
  let allOk = true;
  for (const c of checks) {
    if (!c.ok) allOk = false;
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}`);
    console.log(`         ${c.detail}`);
  }
  console.log('');
  console.log(allOk ? '==> OVERALL: PASS — all formats round-trip real data cleanly.' : '==> OVERALL: FAIL — see mismatches above.');
  return allOk ? 0 : 1;
}

process.exit(main());
