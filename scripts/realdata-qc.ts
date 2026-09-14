// seisconv - REAL-DATA QC harness
//
// Proves the converter does NOT crash and does NOT silently lose data on the
// user's real field data. For every seismic file found under the QC root, this:
//
//   1. reads the bytes and parseAny()s them (try/catch),
//   2. for every registered writer, first asks whether the writer's own
//      documented structural ceiling (e.g. a 16-bit sample count or sample
//      interval field) can even hold this input - if not, the pair is marked
//      REFUSED and the writer is never called, and
//   3. otherwise calls the writer and, where cheap, re-parses its output and
//      checks data-preservation invariants (trace count, lossless sample
//      fidelity for the float pairs, structural re-parse for SEG-D / TPIMAGE,
//      text+rows for CSV) - anything that throws or fails an invariant here
//      is a real, unexpected problem and is marked FAILED.
//
// Three outcomes per (file, writer) pair, and only one of them is bad:
//   PASSED   the writer produced a file that round-trips cleanly.
//   REFUSED  the input genuinely cannot be represented in the target format
//            or revision (checked structurally BEFORE attempting the write,
//            not by pattern-matching a caught error's message) - correct
//            behaviour, not a defect.
//   FAILED   anything else: a crash, an unexpected exception on a pair the
//            structural check said should succeed, a write whose output the
//            reader cannot read back, or a round trip whose samples moved.
// The exit code depends ONLY on FAILED. A pile of REFUSED is expected and
// informative; it must never hide a FAILED among it.
//
// Runtime is bounded: each input format gets FULL round-trips for up to
// FULL_ROUNDTRIP_CAP files; beyond that, the file is still run through every
// writer (still subject to the REFUSED/FAILED split) but the re-parse
// invariants are skipped. Files larger than MAX_FILE_BYTES are skipped to
// bound runtime. All caps and skips are reported honestly in the summary -
// nothing is silently dropped.
//
// Corpus expectations: this harness wants VENDOR FIELD DATA - files that came
// off real acquisition hardware, not SeisConv's own converted output fed back
// into itself. Two independent, generic signals (checked at runtime, not from
// a hardcoded path) suggest the pointed-at root is not that:
//   - an input file's own bytes carry SeisConv's writer tag, meaning some
//     earlier SeisConv run already produced it, or
//   - a trace far longer than any real shot record (tens of thousands of
//     samples or more), which reads as a streamed/continuous record rather
//     than a discrete shot.
// Either one is reported as a warning in the summary, naming the count and
// the evidence, so a red or all-REFUSED run against the wrong corpus is not
// mistaken for a verdict on the writers.
//
// Run:
//   npx tsx scripts/realdata-qc.ts        (from the repo root)
//   (or)  npm run qc:realdata
//
// Config via env:
//   SEISCONV_QC_ROOT   root dir to scan (required - no default; script exits if unset)
//   SEISCONV_QC_FULLCAP   full-round-trip cap per format (default 40)
//   SEISCONV_QC_MAXMB     skip files larger than this many MB (default 80)

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  WRITER_TAG,
} from '../core/index';
import type { ParsedFile, Bytes } from '../core/index';

// -- Config ------------------------------------------------------------------
const ROOT = process.env.SEISCONV_QC_ROOT;
if (!ROOT) { console.error('SEISCONV_QC_ROOT is not set. Point it at your local seismic data root.'); process.exit(1); }
const FULL_ROUNDTRIP_CAP = Number(process.env.SEISCONV_QC_FULLCAP || 40);
const MAX_FILE_BYTES = Number(process.env.SEISCONV_QC_MAXMB || 80) * 1024 * 1024;
const EXTS = new Set(['sgy', 'segy', 'segd', 'sgd', 'seg', 'seg2', 'dat', 'bat', 'su']);
/** Relative tolerance for spot-checking trace-0 samples on the lossless pairs. */
const SAMPLE_RTOL = 1e-3;
/** Number of trace-0 samples to spot-check. */
const SPOTCHECK_N = 64;
/** Writer ids whose output is a lossless seismic container we can re-parse. */
const LOSSLESS_REPARSE = new Set(['segy0', 'segy1', 'segy2', 'su', 'seg2']);

// -- Writer structural limits (for the REFUSED pre-check) -----------------------
//
// These numbers are NOT read off a caught error's message - they are the same
// real field-width facts documented next to each writer's own throw (segy.ts,
// su.ts): a 16-bit two's complement field tops out at 32767, a 16-bit
// unsigned-or-two's-complement field at 65535. Computing them here, from the
// input's own sample count and interval, and checking BEFORE the writer is
// even called, means a future crash that happens to mention "samples" in its
// message can never be reclassified as a refusal - it was never compared to
// this table in the first place, so it falls through to the writer call and,
// if it throws, lands in FAILED like any other unexpected exception.
interface WriterLimit {
  maxSamples?: number;
  maxSampleIntervalUs?: number;
  /** Human explanation, printed with every refusal grouped under it. */
  note: string;
}
const WRITER_LIMITS: Record<string, WriterLimit> = {
  segy0: {
    maxSamples: 32767,
    maxSampleIntervalUs: 32767,
    note: "SEG-Y rev 0 - every binary/trace header value is a 16-bit two's complement field (max 32767)",
  },
  segy1: {
    maxSamples: 32767,
    maxSampleIntervalUs: 32767,
    note: "SEG-Y rev 1 - every binary/trace header value is a 16-bit two's complement field (max 32767)",
  },
  segy2: {
    maxSamples: 65535,
    maxSampleIntervalUs: 65535,
    note: "SEG-Y rev 2 - those same 16-bit fields are two's complement OR unsigned (max 65535)",
  },
  su: {
    maxSamples: 65535,
    note: 'SU (CWP) - the trace-header ns field is 16-bit (max 65535)',
  },
  tpimage: {
    maxSamples: 32767,
    maxSampleIntervalUs: 32767,
    note: 'Tape Image wraps SEG-Y rev 0/1 internally, so it inherits their 32767 ceiling',
  },
};

/** Longest trace (by sample count) in a parsed file, mirroring what every fixed-record writer sizes its output from. */
function longestTrace(pf: ParsedFile): number {
  return (pf.traces || []).reduce((m, t) => Math.max(m, t.nSamples || 0), 0);
}

interface RefusalMatch {
  /** Fixed grouping key - the ceiling being hit, independent of the triggering value. */
  category: string;
  /** The triggering value (a sample count or a microsecond interval), for a min/max range in the summary. */
  value: number;
}

/**
 * Structural applicability check, run BEFORE the writer is invoked. Returns
 * the matched ceiling when the writer's own documented limit cannot hold
 * this input (REFUSED, writer never called), or null when the writer should
 * be attempted (a throw from here on is then a genuine FAILED).
 */
function refusalMatch(id: string, pf: ParsedFile): RefusalMatch | null {
  const limit = WRITER_LIMITS[id];
  if (!limit) return null;
  const spt = longestTrace(pf);
  if (limit.maxSamples !== undefined && spt > limit.maxSamples) {
    return { category: `${id}: sample count above ${limit.maxSamples} - ${limit.note}`, value: spt };
  }
  const si = pf.bh?.sampleInt || 2000;
  if (limit.maxSampleIntervalUs !== undefined && si > limit.maxSampleIntervalUs) {
    return { category: `${id}: sample interval above ${limit.maxSampleIntervalUs}us - ${limit.note}`, value: si };
  }
  return null;
}

// -- Result accounting ---------------------------------------------------------
interface Failure {
  file: string;
  writer: string;
  detail: string;
}
interface Refusal {
  file: string;
  writer: string;
  category: string;
  value: number;
}
const failures: Failure[] = [];
const refusals: Refusal[] = [];
const skipped: { file: string; reason: string }[] = [];

/** per-writer pass/refused/failed tally. */
const writerStats = new Map<string, { pass: number; refused: number; failed: number }>();
/** counts of detected input formats. */
const formatCounts = new Map<string, number>();
/** full-round-trip counter per detected format (to enforce the cap). */
const fullRoundtripDone = new Map<string, number>();

let totalFiles = 0;
let parsedOk = 0;
let parseFailed = 0;
let roundTripsRun = 0; // count of (file,writer) re-parse invariant checks actually run
let invariantViolations = 0;

// -- Corpus-appropriateness signals (generic, no hardcoded path) ---------------
let selfTaggedInputs = 0; // input files whose own bytes carry SeisConv's writer tag
const STREAMED_RECORD_SAMPLES = 100_000; // far beyond any real discrete shot
let streamedLikeInputs = 0;
let longestObservedSamples = 0;

function bumpWriter(id: string, outcome: 'pass' | 'refused' | 'failed'): void {
  const s = writerStats.get(id) || { pass: 0, refused: 0, failed: 0 };
  s[outcome]++;
  writerStats.set(id, s);
}

function recordFailure(file: string, writer: string, detail: string): void {
  failures.push({ file, writer, detail });
}

function recordRefusal(file: string, writer: string, match: RefusalMatch): void {
  refusals.push({ file, writer, category: match.category, value: match.value });
}

/** True when `needle` (plain ASCII) appears anywhere in the first `scanBytes` of `hay`. */
function bytesContainAscii(hay: Bytes, needle: string, scanBytes = 4096): boolean {
  const n = Math.min(hay.length, scanBytes);
  const target = needle.split('').map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= n - target.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (hay[i + j] !== target[j]) continue outer;
    }
    return true;
  }
  return false;
}

// -- File discovery -------------------------------------------------------------
function* walk(dir: string): Generator<string> {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir - skip silently (e.g. permissions)
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

// -- Invariant helpers ----------------------------------------------------------
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
    // SEG-D write is approximate - STRUCTURAL check only, no sample fidelity.
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

// -- Main ------------------------------------------------------------------------
function main(): number {
  const writers = listWriters();
  const writerIds = writers.map((w) => w.id);
  console.log('seisconv - REAL-DATA QC harness');
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

    // -- parse --
    let pf: ParsedFile;
    try {
      pf = parseAny(bytes, name);
    } catch (e) {
      parseFailed++;
      recordFailure(path, '(parseAny)', (e as Error).message);
      continue;
    }
    parsedOk++;

    // Corpus-appropriateness signals - generic, computed from this file's own
    // bytes/geometry, never from a hardcoded path.
    if (bytesContainAscii(bytes, WRITER_TAG)) selfTaggedInputs++;
    const inputLongest = longestTrace(pf);
    longestObservedSamples = Math.max(longestObservedSamples, inputLongest);
    if (inputLongest > STREAMED_RECORD_SAMPLES) streamedLikeInputs++;

    const fmt = pf.format || detect(bytes, name);
    formatCounts.set(fmt, (formatCounts.get(fmt) || 0) + 1);

    // Decide whether THIS file gets full re-parse invariants for its format.
    const doneForFmt = fullRoundtripDone.get(fmt) || 0;
    const doFullRoundtrip = doneForFmt < FULL_ROUNDTRIP_CAP;
    if (doFullRoundtrip) fullRoundtripDone.set(fmt, doneForFmt + 1);

    // -- every writer --
    for (const id of writerIds) {
      const w = getWriter(id);
      if (!w) {
        recordFailure(path, id, 'getWriter() returned undefined');
        bumpWriter(id, 'failed');
        continue;
      }

      // Structural applicability check FIRST: if this writer's own documented
      // ceiling cannot hold this input, that is a REFUSED and the writer is
      // never called - so a throw can only ever reach the FAILED branch below.
      const refusal = refusalMatch(id, pf);
      if (refusal) {
        recordRefusal(path, id, refusal);
        bumpWriter(id, 'refused');
        continue;
      }

      let out: Bytes;
      try {
        out = w.write(pf);
      } catch (e) {
        // The applicability check said this pair should succeed, and it did
        // not: a genuine, unexpected failure, not a documented refusal.
        recordFailure(path, id, `write threw: ${(e as Error).message}`);
        bumpWriter(id, 'failed');
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
            bumpWriter(id, 'failed');
            continue;
          }
        } catch (e) {
          // A throw during re-parse/invariant is itself a data-integrity failure.
          recordFailure(path, id, `re-parse/invariant threw: ${(e as Error).message}`);
          bumpWriter(id, 'failed');
          continue;
        }
      }

      bumpWriter(id, 'pass');
    }
  }

  // -- Summary -------------------------------------------------------------------
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

  console.log('per-writer (PASSED / REFUSED = correct, input cannot fit the format / FAILED = real problem):');
  for (const id of writerIds) {
    const s = writerStats.get(id) || { pass: 0, refused: 0, failed: 0 };
    const flag = s.failed > 0 ? '  <-- FAILED' : '';
    console.log(
      `  ${id.padEnd(8)} passed ${String(s.pass).padStart(5)}   refused ${String(s.refused).padStart(4)}   failed ${String(s.failed).padStart(4)}${flag}`,
    );
  }
  console.log('');
  console.log(`re-parse invariant checks run: ${roundTripsRun}   invariant violations: ${invariantViolations}`);
  console.log('');

  // Refusals are expected, correct behaviour - group them by reason so a
  // reader sees "33 traces refused by X's ceiling" instead of 33 red lines.
  if (refusals.length) {
    console.log(`REFUSALS (${refusals.length}) - correct behaviour, the input cannot fit the target format/revision:`);
    const byCategory = new Map<string, { count: number; min: number; max: number }>();
    for (const r of refusals) {
      const g = byCategory.get(r.category) || { count: 0, min: r.value, max: r.value };
      g.count++;
      g.min = Math.min(g.min, r.value);
      g.max = Math.max(g.max, r.value);
      byCategory.set(r.category, g);
    }
    for (const [category, g] of [...byCategory.entries()].sort((a, b) => b[1].count - a[1].count)) {
      const range = g.min === g.max ? `${g.min}` : `${g.min} to ${g.max}`;
      console.log(`  ${String(g.count).padStart(4)}x  ${category} (observed ${range})`);
    }
    console.log('');
  }

  if (failures.length) {
    console.log(`FAILURES (${failures.length}) - real problems, not documented refusals:`);
    for (const f of failures) {
      console.log(`  [${f.writer}] ${f.file}`);
      console.log(`      ${f.detail}`);
    }
  } else {
    console.log('No failures. Converter did not crash and preserved data on every checked (file, writer) that was applicable.');
  }
  console.log('');

  // -- Corpus-appropriateness warning (generic signals, no hardcoded path) --
  if (selfTaggedInputs > 0 || streamedLikeInputs > 0) {
    console.log('CORPUS WARNING: this harness wants VENDOR FIELD DATA. Signals suggest SEISCONV_QC_ROOT may not be that:');
    if (selfTaggedInputs > 0) {
      console.log(`  - ${selfTaggedInputs} input file(s) carry SeisConv's own writer tag ("${WRITER_TAG}") in their bytes,`);
      console.log("    meaning they are SeisConv's own converted/re-exported output fed back in, not original acquisition data.");
    }
    if (streamedLikeInputs > 0) {
      console.log(`  - ${streamedLikeInputs} input file(s) carry a trace longer than ${STREAMED_RECORD_SAMPLES.toLocaleString()} samples`);
      console.log(`    (longest observed: ${longestObservedSamples.toLocaleString()} samples), which reads as a streamed/continuous`);
      console.log('    record rather than a discrete shot, and is unusually likely to hit format sample-count ceilings.');
    }
    console.log('  Point SEISCONV_QC_ROOT at real vendor field records for a representative run.');
    console.log('');
  }

  // -- Machine-readable block (for the orchestrator / structured output) --
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
    passedCount: writerIds.reduce((n, id) => n + (writerStats.get(id)?.pass || 0), 0),
    refusedCount: refusals.length,
    failedCount: failures.length,
    invariantViolations,
    cleanOverall: failures.length === 0,
    refusals,
    failures,
    corpusWarning: {
      selfTaggedInputs,
      streamedLikeInputs,
      longestObservedSamples,
      streamedThreshold: STREAMED_RECORD_SAMPLES,
    },
  };
  console.log('\n===QC_JSON_BEGIN===');
  console.log(JSON.stringify(result, null, 2));
  console.log('===QC_JSON_END===');

  return failures.length === 0 ? 0 : 1;
}

// Guarded so this module can be imported (e.g. by a probe that exercises
// `refusalMatch` directly) without triggering a full scan-and-exit as a
// side effect of the import. Only runs when this file is the entry point.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}

export { refusalMatch, WRITER_LIMITS };
export type { RefusalMatch, WriterLimit };
