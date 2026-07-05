// seisconv-core / dsp — FFT + amplitude spectrum.
//
// Iterative radix-2 Cooley–Tukey FFT (in-place, bit-reversal permutation).
// Pure — no DOM, no deps. Powers the Trace Inspector's frequency-spectrum
// (amplitude vs Hz) QC view, a standard SEG-Y QC tool.

/** Smallest power of two >= n (>= 1). */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * In-place iterative radix-2 FFT. `re`/`im` are equal-length arrays whose length
 * must be a power of two; both are transformed in place. `inverse` runs the
 * inverse transform (with the 1/N normalization).
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fft length must be a power of two, got ${n}`);

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

export interface Spectrum {
  freqs: Float32Array; // Hz, length N/2
  amp: Float32Array; // single-sided amplitude, length N/2
  nyquist: number; // Hz
}

/**
 * Single-sided amplitude spectrum of a real trace. Applies a Hann window to cut
 * spectral leakage, zero-pads to the next power of two, and returns amplitude
 * vs frequency in Hz. `siUs` is the sample interval in microseconds.
 */
export function amplitudeSpectrum(samples: Float32Array, siUs: number): Spectrum {
  const n0 = samples.length;
  const N = nextPow2(Math.max(2, n0));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let winSum = 0;
  for (let i = 0; i < n0; i++) {
    const w = n0 > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n0 - 1)) : 1; // Hann
    winSum += w;
    re[i] = samples[i] * w;
  }
  fft(re, im, false);
  const half = N >> 1;
  const fs = siUs > 0 ? 1e6 / siUs : 1; // sample rate (Hz)
  const amp = new Float32Array(half);
  const freqs = new Float32Array(half);
  // Normalize by the window's coherent gain (sum of window) so a unit-amplitude
  // tone reads its true amplitude — not by n0 (which under-reads ~2x for Hann).
  const norm = winSum > 0 ? winSum : 1;
  for (let k = 0; k < half; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    amp[k] = (k === 0 ? mag : 2 * mag) / norm; // single-sided amplitude
    freqs[k] = (k * fs) / N;
  }
  return { freqs, amp, nyquist: fs / 2 };
}
