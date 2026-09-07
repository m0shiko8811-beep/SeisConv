// seisconv-core / render - DOM-free render helpers.
//
// Amplitude normalization + decimation used by the canvas views. Keeping these
// pure means the renderer just maps numbers → pixels, and they stay testable.

/** Largest |sample| in the series (0 for an empty series). */
export function maxAbs(samples: Float32Array): number {
  let m = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > m) m = a;
  }
  return m;
}

/**
 * Robust normalization factor: the p-th percentile of |samples| (default 95th).
 * Falls back to 1 for empty/flat input so callers can divide safely.
 */
export function normFactorPercentile(samples: Float32Array, p = 0.95): number {
  const n = samples.length;
  if (!n) return 1;
  const abs = new Float64Array(n);
  for (let i = 0; i < n; i++) abs[i] = Math.abs(samples[i]);
  abs.sort();
  const idx = Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))));
  const f = abs[idx];
  return f > 1e-12 ? f : 1;
}

/**
 * Display-scaling defaults, in ONE place. The AGC window/type were previously
 * copy-pasted at three renderer call sites plus a disagreeing 200 ms fallback in
 * the worker, so a section could be drawn with a different AGC than the UI
 * claimed. Every caller now reads these.
 */
export const AGC_DEFAULT_WINDOW_MS = 250;
export const AGC_DEFAULT_TYPE: 'rms' | 'median' | 'mean' = 'rms';
/** Default across-trace percentile for the 'percentile' section scaling mode. */
export const SCALE_DEFAULT_PERCENTILE = 95;

/**
 * Percentile ACROSS a set of per-trace normalization factors - NOT across the
 * samples of one trace (that is `normFactorPercentile`). Used by the section's
 * 'percentile' scaling mode so one hot geophone cannot bury the whole record.
 * `p` is a percentage in [1, 100]. Returns 1 for empty/degenerate input so the
 * caller can always divide safely.
 */
export function normAcrossTraces(norms: ArrayLike<number>, p = SCALE_DEFAULT_PERCENTILE): number {
  const n = norms.length;
  if (!n) return 1;
  const finite: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = norms[i];
    if (Number.isFinite(v) && v > 0) finite.push(v);
  }
  if (!finite.length) return 1;
  finite.sort((a, b) => a - b);
  const q = Math.min(100, Math.max(1, Number.isFinite(p) ? p : SCALE_DEFAULT_PERCENTILE)) / 100;
  const idx = Math.min(finite.length - 1, Math.max(0, Math.round(q * (finite.length - 1))));
  const f = finite[idx];
  return f > 1e-12 ? f : 1;
}

/**
 * Decimate a series to at most `maxPoints` by min/max bucketing - preserves the
 * visual envelope (peaks/troughs) when a trace has far more samples than pixels.
 * Returns the original array when it already fits.
 */
export function decimateMinMax(samples: Float32Array, maxPoints: number): Float32Array {
  const n = samples.length;
  if (n <= maxPoints || maxPoints <= 0) return samples;
  const buckets = Math.floor(maxPoints / 2);
  const out = new Float32Array(buckets * 2);
  const step = n / buckets;
  for (let bIdx = 0; bIdx < buckets; bIdx++) {
    const start = Math.floor(bIdx * step);
    const end = Math.min(n, Math.floor((bIdx + 1) * step));
    let mn = samples[start];
    let mx = samples[start];
    for (let i = start + 1; i < end; i++) {
      const v = samples[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    out[bIdx * 2] = mn;
    out[bIdx * 2 + 1] = mx;
  }
  return out;
}
