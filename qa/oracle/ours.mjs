// SeisConv side of the SEG-Y oracle cross-check.
//
// Calls the REAL parser - core/formats/segy.ts, the same module the worker and
// the app use - and emits the same JSON shape qa/oracle/oracle.py emits, so
// qa/oracle/compare.mjs can diff them key by key. Nothing here re-implements
// any part of the decode.
//
// Runs under tsx (`npx tsx qa/oracle/ours.mjs <file>`), which is how
// `npm run test:core` loads core modules; that is what lets an .mjs file import
// a .ts one.
//
// Usage:  tsx qa/oracle/ours.mjs <absolute-path-to-segy>
// Output: one JSON object on stdout. The path is never echoed.
import { readFileSync } from 'node:fs';
import { parseSEGY, parseSegyMeta } from '../../core/formats/segy.ts';
import { MAX_TRACES } from '../../core/types.ts';
// The hash contract lives in qa/oracle/hash.mjs so this file and
// qa/conform/conform.mjs cannot drift into two slightly different versions of
// it. The code there was moved out of here unchanged; this file's JSON output
// is byte-identical to what it was before the move.
import { hashMatrix, preview } from './hash.mjs';

function main() {
  const path = process.argv[2];
  if (!path) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'no file argument' }));
    return 2;
  }
  const bytes = new Uint8Array(readFileSync(path));
  const meta = parseSegyMeta(bytes);
  // Infinity as the sample-trace cap so EVERY trace gets its samples decoded -
  // the default MAX_SAMPLE_TRACES (2000) would leave deep traces sample-less and
  // the matrix hash would silently cover only part of the file.
  const pd = parseSEGY(bytes, Infinity);

  const traces = pd.traces;
  const tc = pd.traceCount;
  if (tc === 0) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'parser returned 0 traces', errors: pd.errors }));
    return 4;
  }

  const ns0 = traces[0].nSamples;
  let uniform = true;
  let withSamples = 0;
  for (const t of traces) {
    if (t.nSamples !== ns0) uniform = false;
    if (t.samples) withSamples++;
  }

  const result = {
    ok: true,
    impl: 'seisconv core/formats/segy.ts',
    byte_order: meta.le ? 'little' : 'big',
    trace_count: tc,
    samples_per_trace: ns0,
    sample_interval_us: meta.sampleInt,
    data_format_code: meta.format,
    revision_major: meta.revision,
    revision_minor: pd.bh.revMinor ?? 0,
    ext_headers: pd.bh.extHdrCnt ?? 0,
    // Not part of the diff, but the reason a rev-2 file walks at a wider stride.
    add_trace_header_bytes: meta.addHdrBytes,
    ns_uniform: uniform,
    traces_with_samples: withSamples,
    hit_max_traces: tc >= MAX_TRACES,
    parser_errors: pd.errors,
  };

  if (!uniform) {
    result.ok = false;
    result.error = 'ragged trace lengths - no rectangular sample matrix to hash';
    process.stdout.write(JSON.stringify(result));
    return 5;
  }

  // --- hash contract, steps 1-7 (see qa/oracle/README.md) ---------------
  // One implementation, in qa/oracle/hash.mjs, shared with the output
  // conformance harness.
  const m = hashMatrix(traces, tc, ns0);
  const bits = m.bits;
  result.normalised_nan = m.normalised_nan;
  result.normalised_neg_zero = m.normalised_neg_zero;
  result.sample_matrix_sha256 = m.sample_matrix_sha256;
  result.sample_matrix_values = m.sample_matrix_values;

  const mid = Math.floor(tc / 2);
  result.middle_trace_index = mid;
  result.trace0 = preview(bits, 0, ns0);
  result.trace_mid = preview(bits, mid * ns0, ns0);

  process.stdout.write(JSON.stringify(result));
  return 0;
}

process.exitCode = main();
