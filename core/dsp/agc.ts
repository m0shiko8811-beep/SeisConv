// seisconv-core / dsp — Automatic Gain Control.
//
// Prefix-sum implementation: O(n) per trace regardless of window size.
// Ported verbatim from the SeisConv reference. Pure — no DOM.

export type AGCType = 'rms' | 'median' | 'mean';

/**
 * Window-normalize a trace. `windowMs` is the AGC window in milliseconds,
 * `siUs` the sample interval in microseconds. Returns a new Float32Array.
 */
export function applyAGC(samples: Float32Array, windowMs: number, siUs: number, type: AGCType = 'rms'): Float32Array {
  const n = samples.length;
  if (!n) return samples;
  const halfW = Math.max(1, Math.round((windowMs * 500) / siUs)); // 500 = 1000ms / 2
  const out = new Float32Array(n);

  if (type === 'rms') {
    const sq = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) sq[i + 1] = sq[i] + samples[i] * samples[i];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - halfW);
      const b = Math.min(n, i + halfW + 1);
      const rms = Math.sqrt((sq[b] - sq[a]) / (b - a));
      out[i] = rms > 1e-10 ? samples[i] / rms : 0;
    }
  } else if (type === 'median') {
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - halfW);
      const b = Math.min(n, i + halfW + 1);
      const win = Array.from(samples.slice(a, b)).map(Math.abs).sort((x, y) => x - y);
      const med = win[Math.floor(win.length / 2)] || 1e-10;
      out[i] = med > 1e-10 ? samples[i] / med : 0;
    }
  } else {
    const ab = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) ab[i + 1] = ab[i] + Math.abs(samples[i]);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - halfW);
      const b = Math.min(n, i + halfW + 1);
      const mean = (ab[b] - ab[a]) / (b - a);
      out[i] = mean > 1e-10 ? samples[i] / mean : 0;
    }
  }
  return out;
}
