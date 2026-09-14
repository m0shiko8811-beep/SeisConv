// The sample-matrix hash contract, in ONE place.
//
// The contract itself is not defined here - it is defined in
// qa/oracle/README.md, "The hash contract", and was fixed before any comparison
// was ever run. This file is the single Node-side implementation of it, so the
// SEG-Y oracle (qa/oracle/ours.mjs) and the output-conformance harness
// (qa/conform/conform.mjs) cannot drift into hashing the same samples two
// slightly different ways. qa/oracle/oracle.py is the Python-side twin and is
// unchanged.
//
// Extracted verbatim from qa/oracle/ours.mjs. Nothing about the arithmetic,
// the normalisation or the byte order was altered in the move; ours.mjs now
// imports what it used to define, and its JSON output is byte-identical.
import { createHash } from 'node:crypto';

export const CANON_NAN = 0x7fc00000;
export const NEG_ZERO = 0x80000000;

/** Full-precision, format-identical decimal for one binary32 value. 9
 *  significant digits round-trip binary32 exactly; the exponent is padded to two
 *  digits so this matches Python's "%.8e" character for character. The hex bit
 *  pattern printed beside it is the authoritative comparison. */
export function canonDec(v) {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  return v.toExponential(8).replace(/e([+-])(\d)$/, 'e$10$2');
}

/** First and last `n` samples of one trace, as {hex, dec} pairs, read out of an
 *  ALREADY-NORMALISED bit array. */
export function preview(bits, base, ns, n = 8) {
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

/** Hash contract steps 1 to 7, on a rectangular trace-major matrix.
 *
 *  `traces` is any array of objects carrying a `samples` Float32Array (or null)
 *  - the ParsedFile.traces shape every SeisConv parser returns. `ns0` is the
 *  uniform sample count the caller has ALREADY established; this function does
 *  not decide uniformity, because refusing to hash a ragged file is a decision
 *  the caller must report in its own words.
 *
 *  Returns the normalised bit array as well as the digest so the caller can
 *  print previews out of exactly the bytes that were hashed. */
export function hashMatrix(traces, tc, ns0) {
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

  return {
    bits,
    normalised_nan: nNan,
    normalised_neg_zero: nNegZero,
    sample_matrix_sha256: createHash('sha256').update(hashBuf).digest('hex'),
    sample_matrix_values: total,
  };
}

/** The whole source-side answer for one ParsedFile, in the JSON shape the
 *  containers emit, so qa/conform/conform.mjs can diff a written file against
 *  its source the same way qa/oracle/compare.mjs diffs two readers.
 *
 *  Used for the formats that have no `ours.mjs` subprocess of their own
 *  (SEG-2, SEG-D, SU). SEG-Y keeps going through qa/oracle/ours.mjs, unchanged,
 *  because that is the file qa/oracle/compare.mjs also runs.
 *
 *  A ragged file is reported as ok:false with the reason, never silently
 *  concatenated - the same refusal ours.mjs makes. */
export function matrixOf(pd, impl) {
  const traces = pd.traces || [];
  const tc = traces.length;
  if (tc === 0) return { ok: false, impl, error: 'parser returned 0 traces' };
  const ns0 = traces[0].nSamples;
  let uniform = true;
  let withSamples = 0;
  for (const t of traces) {
    if (t.nSamples !== ns0) uniform = false;
    if (t.samples) withSamples++;
  }
  const out = {
    ok: true,
    impl,
    trace_count: tc,
    samples_per_trace: ns0,
    sample_interval_us: (pd.bh && pd.bh.sampleInt) || 0,
    ns_uniform: uniform,
    traces_with_samples: withSamples,
  };
  if (!uniform) {
    out.ok = false;
    out.error = 'ragged trace lengths - no rectangular sample matrix to hash';
    return out;
  }
  if (withSamples !== tc) {
    // Every trace must carry its samples or the hash covers only part of the
    // file. The SEG-Y path avoids this by passing Infinity as the sample-trace
    // cap; a parser with no such argument can still hit its own cap, and a
    // partial matrix must be refused, not hashed.
    out.ok = false;
    out.error = 'only ' + withSamples + ' of ' + tc + ' traces carry samples - the matrix would cover part of the file';
    return out;
  }
  Object.assign(out, hashMatrix(traces, tc, ns0));
  const mid = Math.floor(tc / 2);
  out.middle_trace_index = mid;
  out.trace0 = preview(out.bits, 0, ns0);
  out.trace_mid = preview(out.bits, mid * ns0, ns0);
  delete out.bits;
  return out;
}
