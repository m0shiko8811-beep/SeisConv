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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseSEGY, parseSegyMeta } from '../../core/formats/segy.ts';
import { MAX_TRACES } from '../../core/types.ts';

const CANON_NAN = 0x7fc00000;
const NEG_ZERO = 0x80000000;

/** Full-precision, format-identical decimal for one binary32 value. 9
 *  significant digits round-trip binary32 exactly; the exponent is padded to two
 *  digits so this matches Python's "%.8e" character for character. The hex bit
 *  pattern printed beside it is the authoritative comparison. */
function canonDec(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  return v.toExponential(8).replace(/e([+-])(\d)$/, 'e$10$2');
}

function preview(bits, base, ns, n = 8) {
  const buf = new ArrayBuffer(4);
  const u = new Uint32Array(buf);
  const f = new Float32Array(buf);
  const one = (i) => {
    u[0] = bits[base + i];
    return { hex: u[0].toString(16).padStart(8, '0'), dec: canonDec(f[0]) };
  };
  const first8 = [];
  const last8 = [];
  for (let i = 0; i < n && i < ns; i++) first8.push(one(i));
  for (let i = Math.max(0, ns - n); i < ns; i++) last8.push(one(i));
  return { first8, last8 };
}

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

  // --- hash contract, steps 1-5 (see qa/oracle/README.md) ---------------
  const total = tc * ns0;
  const f32 = new Float32Array(total);
  for (let t = 0; t < tc; t++) {
    const s = traces[t].samples;
    if (s) f32.set(s.subarray(0, ns0), t * ns0);
  }
  const bits = new Uint32Array(f32.buffer, f32.byteOffset, total);
  let nNan = 0;
  let nNegZero = 0;
  for (let i = 0; i < total; i++) {
    const b = bits[i];
    // NaN: exponent all ones AND a nonzero mantissa.
    if ((b & 0x7f800000) === 0x7f800000 && (b & 0x007fffff) !== 0) {
      bits[i] = CANON_NAN;
      nNan++;
    } else if (b === NEG_ZERO) {
      bits[i] = 0;
      nNegZero++;
    }
  }

  // Serialise as LITTLE-ENDIAN binary32 regardless of host byte order.
  let hashBuf;
  if (Buffer.from(new Uint32Array([1]).buffer)[0] === 1) {
    hashBuf = Buffer.from(bits.buffer, bits.byteOffset, total * 4);
  } else {
    hashBuf = Buffer.alloc(total * 4);
    for (let i = 0; i < total; i++) hashBuf.writeUInt32LE(bits[i], i * 4);
  }

  result.normalised_nan = nNan;
  result.normalised_neg_zero = nNegZero;
  result.sample_matrix_sha256 = createHash('sha256').update(hashBuf).digest('hex');
  result.sample_matrix_values = total;

  const mid = Math.floor(tc / 2);
  result.middle_trace_index = mid;
  result.trace0 = preview(bits, 0, ns0);
  result.trace_mid = preview(bits, mid * ns0, ns0);

  process.stdout.write(JSON.stringify(result));
  return 0;
}

process.exitCode = main();
