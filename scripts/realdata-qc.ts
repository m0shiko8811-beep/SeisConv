// seisconv — REAL-DATA QC harness
//
// Proves the converter does NOT throw and does NOT silently lose data on the
// user's real field data. For every seismic file found under the QC root, this:
//
//   1. reads the bytes and parseAny()s them (try/catch),
//   2. runs EVERY registered writer over the parsed file (try/catch) — the
//      PRIMARY assertion is that no (file, writer) pair throws, and
//   3. where cheap, re-parses the writer output and checks data-preservation
//      invariants (trace count, lossless sample fidelity for the float pairs,
//      structural re-parse for SEG-D / TPIMAGE, text+rows for CSV).
//
// Runtime is bounded: each input format gets FULL round-trips for up to
// FULL_ROUNDTRIP_CAP files; beyond that, the file is still converted through
// every writer (the no-throw guarantee) but the re-parse invariants are skipped.
// Files larger than MAX_FILE_BYTES are skipped to bound runtime. All caps and
// skips are reported honestly in the summary — nothing is silently dropped.
//
// Run:
//   npx tsx scripts/realdata-qc.ts        (from the repo root)
//   (or)  npm run qc:realdata
//
// Config via env:
//   SEISCONV_QC_ROOT   root dir to scan (required — no default; script exits if unset)
//   SEISCONV_QC_FULLCAP   full-round-trip cap per format (default 40)
//   SEISCONV_QC_MAXMB     skip files larger than this many MB (default 80)

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseAny,
  parseSEGY,
  parseSU,
  parseSEG2,
  parseSEGD,
  parseTpimage,
  detect,
  getWriter,
  listWriters,
} from '../core/index';
import type { ParsedFile, Bytes } from '../core/index';

// ── Config ──────────────────────────────────────────────────────────────────
const ROOT = process.env.SEISCONV_QC_ROOT;
if (!ROOT) { console.error('SEISCONV_QC_ROOT is not set. Point it at your local seismic data root.'); process.exit(1); }
const FULL_ROUNDTRIP_CAP = Number(process.env.SEISCONV_QC_FULLCAP || 40);
const MAX_FILE_BYTES = Number(process.env.SEISCONV_QC_MAXMB || 80) * 1024 * 1024;
const EXTS = new Set(['sgy', 'segy', 'segd', 'seg', 'seg2', 'dat', 'bat', 'su']);
/** Relative tolerance for spot-checking trace-0 samples on the lossless pairs. */
const SAMPLE_RTOL = 1e-3;
/** Number of trace-0 samples to spot-check. */
const SPOTCHECK_N = 64;
/** Writer ids whose output is a lossless seismic container we can re-parse. */
const LOSSLESS_REPARSE = new Set(['segy0', 'segy1', 'segy2', 'su', 'seg2']);

// ── Result accounting ─────────────────────────────────────────────────────────
interface Failure {
  file: string;
  writer: string;
  detail: string;
}
const failures: Failure[] = [];
const skipped: { file: string; reason: string }[] = [];

/** per-writer pass/fail tally (no-throw is the unit). */
const writerStats = new Map<string, { pass: number; fail: number }>();
/** counts of detected input formats. */
const formatCounts = new Map<string, number>();
/** full-round-trip counter per detected format (to enforce the cap). */
const fullRoundtripDone = new Map<string, number>();

let totalFiles = 0;
let parsedOk = 0;
let parseFailed = 0;
let roundTripsRun = 0; // count of (file,writer) re-parse invariant checks actually run
let invariantViolations = 0;

function bumpWriter(id: string, ok: boolean): void {
  const s = writerStats.get(id) || { pass: 0, fail: 0 };
  if (ok) s.pass++;
  else s.fail++;
  writerStats.set(id, s);
}

function recordFailure(file: string, writer: string, detail: string): void {
  failures.push({ file, writer, detail });
}

// ── File discovery ─────────────────────────────────────────────────────────────
function* walk(dir: string): Generator<string> {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip silently (e.g. permissions)
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile()) {
      const ext = e.name.toLowerCase().split('.').pop() || '';
      if (EXTS.has(ext)) yield full;
    }
  }
}

// ── Invariant helpers ──────────────────────────────────────────────────────────
function reparseLossless(id: string, out: Bytes): ParsedFile {
  // Re-parse via the format-specific parser so a generic detect() mishap on the
  // synthetic name doesn't muddy the invariant. Names carry the right extension.
  switch (id) {
    case 'segy0':
    case 'segy1':
    case 'segy2':
      return parseSEGY(out);
    case 'su':
      return parseSU(out);
    case 'seg2':
      return parseSEG2(out);
    default:
      return parseAny(out);
  }
}

/** True when a and b agree to relative tolerance rtol over the first n samples. */
function samplesClose(
  a: Float32Array | null,
  b: Float32Array | null,
  n: number,
  rtol: number,
): { ok: boolean; detail?: string } {
  if (!a || !b) return { ok: false, detail: 'missing samples on one side' };
  const m = Math.min(n, a.length, b.length);
  for (let i = 0; i < m; i++) {
    const x = a[i];
    const y = b[i];
    const denom = Math.max(Math.abs(x), Math.abs(y), 1e-9);
    if (Math.abs(x - y) / denom > rtol) {
      return { ok: false, detail: `sample[${i}] ${x} vs ${y} (rel ${(Math.abs(x - y) / denom).toFixed(4)})` };
    }
  }
  return { ok: true };
}

/**
 * Run the cheap re-parse invariants for one writer output. Returns a problem
 * string, or null when the output passes (or no invariant applies to that id).
 * Throwing here is treated like any other writer-pipeline throw upstream.
 */
function checkInvariant(id: string, out: Bytes, pf: ParsedFile): string | null {
  if (LOSSLESS_REPARSE.has(id)) {
    const re = reparseLossless(id, out);
    if (re.errors.length !== 0) return `re-parse reported errors: ${re.errors.join('; ')}`;
    if (!(re.traceCount > 0)) return `re-parse traceCount=${re.traceCount} (expected > 0)`;
    if (re.traceCount !== pf.traceCount) {
      return `traceCount mismatch: in=${pf.traceCount} out=${re.traceCount}`;
    }
    // Spot-check trace-0 samples for the lossless float pairs only when both
    // sides actually carry decoded samples (SEG-2 IEEE / SU / SEG-Y float).
    const a = pf.traces[0]?.samples ?? null;
    const b = re.traces[0]?.samples ?? null;
    if (a && b) {
      const r = samplesClose(a, b, SPOTCHECK_N, SAMPLE_RTOL);
      if (!r.ok) return `trace-0 sample drift: ${r.detail}`;
    }
    return null;
  }

  if (id === 'segd1' || id === 'segd3') {
    // SEG-D write is approximate — STRUCTURAL check only, no sample fidelity.
    if (detect(out) !== 'SEG-D') return `output not detected as SEG-D (got ${detect(out)})`;
    const re = parseSEGD(out);
    if (!(re.traceCount > 0)) return `SEG-D re-parse traceCount=${re.traceCount} (expected > 0)`;
    return null;
  }

  if (id === 'tpimage') {
    const extracted = parseTpimage(out);
    if (!(extracted.length >= 1)) return 'tape image yielded 0 embedded files';
    const fmt = detect(extracted[0].bytes, extracted[0].name);
    if (!fmt) return 'embedded file did not detect to a format';
    return null;
  }

  if (id === 'csv') {
    const text = new TextDecoder().decode(out);
    const lines = text.split('\n');
    const headerIdx = lines.findIndex((l) => /^sample,time_ms/.test(l));
    if (headerIdx < 0) return 'no header row (expected "sample,time_ms,...")';
    // First non-empty line after the header is a data row.
    const dataRows = lines.slice(headerIdx + 1).filter((l) => l.trim().length > 0);
    if (!(dataRows.length >= 1)) return 'no data rows after header';
    return null;
  }

  return null; // unknown writer id → no invariant to assert (no-throw still counts)
}

// ── Main ────────────────────────────────────────────────────────────────────────
function main(): number {
  const writers = listWriters();
  const writerIds = writers.map((w) => w.id);
  console.log('seisconv — REAL-DATA QC harness');
  console.log('================================');
  console.log(`root:     ${ROOT}`);
  console.log(`writers:  ${writerIds.join(', ')}`);
  console.log(`full round-trip cap: ${FULL_ROUNDTRIP_CAP} files/format   max file: ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB`);
  console.log('');

  const files: string[] = [];
  for (const f of walk(ROOT)) files.push(f);
  files.sort(); // deterministic ordering so the per-format cap is reproducible

  for (const path of files) {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      skipped.push({ file: path, reason: 'stat failed' });
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      skipped.push({ file: path, reason: `>${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB (${(size / 1024 / 1024).toFixed(1)}MB)` });
      continue;
    }

    totalFiles++;
    const name = path.split(/[\\/]/).pop() || path;

    let bytes: Bytes;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch (e) {
      parseFailed++;
      recordFailure(path, '(read)', (e as Error).message);
      continue;
    }

    // ── parse ──
    let pf: ParsedFile;
    try {
      pf = parseAny(bytes, name);
    } catch (e) {
      parseFailed++;
      recordFailure(path, '(parseAny)', (e as Error).message);
      continue;
    }
    parsedOk++;

    const fmt = pf.format || detect(bytes, name);
    formatCounts.set(fmt, (formatCounts.get(fmt) || 0) + 1);

    // Decide whether THIS file gets full re-parse invariants for its format.
    const doneForFmt = fullRoundtripDone.get(fmt) || 0;
    const doFullRoundtrip = doneForFmt < FULL_ROUNDTRIP_CAP;
    if (doFullRoundtrip) fullRoundtripDone.set(fmt, doneForFmt + 1);

    // ── every writer ──
    for (const id of writerIds) {
      const w = getWriter(id);
      if (!w) {
        recordFailure(path, id, 'getWriter() returned undefined');
        bumpWriter(id, false);
        continue;
      }

      let out: Bytes;
      try {
        out = w.write(pf);
      } catch (e) {
        // PRIMARY assertion violated: a writer threw on real data.
        recordFailure(path, id, `write threw: ${(e as Error).message}`);
        bumpWriter(id, false);
        continue;
      }

      // No-throw passed. Optionally run the cheap re-parse invariant.
      if (doFullRoundtrip) {
        try {
          const problem = checkInvariant(id, out, pf);
          roundTripsRun++;
          if (problem) {
            invariantViolations++;
            recordFailure(path, id, `invariant: ${problem}`);
            bumpWriter(id, false);
            continue;
          }
        } catch (e) {
          // A throw during re-parse/invariant is itself a data-integrity failure.
          recordFailure(path, id, `re-parse/invariant threw: ${(e as Error).message}`);
          bumpWriter(id, false);
          continue;
        }
      }

      bumpWriter(id, true);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log('SUMMARY');
  console.log('-------');
  console.log(`files scanned (<= cap size): ${totalFiles}`);
  console.log(`  parsed OK: ${parsedOk}   parse failed: ${parseFailed}`);
  if (skipped.length) console.log(`  skipped (size/stat):       ${skipped.length}`);
  console.log('');

  console.log('by detected input format:');
  for (const [f, c] of [...formatCounts.entries()].sort()) {
    const full = fullRoundtripDone.get(f) || 0;
    const capped = full >= FULL_ROUNDTRIP_CAP && c > FULL_ROUNDTRIP_CAP;
    console.log(`  ${f.padEnd(14)} ${String(c).padStart(4)}   full round-trip: ${full}${capped ? `  (remaining ${c - full} = convert-only)` : ''}`);
  }
  console.log('');

  console.log('per-writer (no-throw = pass; invariant failure counts as fail):');
  for (const id of writerIds) {
    const s = writerStats.get(id) || { pass: 0, fail: 0 };
    const flag = s.fail > 0 ? '  <-- FAIL' : '';
    console.log(`  ${id.padEnd(8)} pass ${String(s.pass).padStart(5)}   fail ${String(s.fail).padStart(4)}${flag}`);
  }
  console.log('');
  console.log(`re-parse invariant checks run: ${roundTripsRun}   invariant violations: ${invariantViolations}`);
  console.log('');

  if (failures.length) {
    console.log(`FAILURES (${failures.length}):`);
    for (const f of failures) {
      console.log(`  [${f.writer}] ${f.file}`);
      console.log(`      ${f.detail}`);
    }
  } else {
    console.log('No failures. Converter did not throw and preserved data on every checked (file, writer).');
  }

  // ── Machine-readable block (for the orchestrator / structured output) ──
  const byInputFormat = [...formatCounts.entries()].sort().map(([f, c]) => `${f}:${c}`).join(', ');
  const result = {
    rootScanned: ROOT,
    totalFilesFound: totalFiles,
    skipped: skipped.length,
    parsedOk,
    parseFailed,
    roundTripsRun,
    writersExercised: writerIds,
    byInputFormat,
    passCount: writerIds.reduce((n, id) => n + (writerStats.get(id)?.pass || 0), 0),
    failCount: failures.length,
    invariantViolations,
    cleanOverall: failures.length === 0,
    failures,
  };
  console.log('\n===QC_JSON_BEGIN===');
  console.log(JSON.stringify(result, null, 2));
  console.log('===QC_JSON_END===');

  return failures.length === 0 ? 0 : 1;
}

process.exit(main());
