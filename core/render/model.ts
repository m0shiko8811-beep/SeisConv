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
