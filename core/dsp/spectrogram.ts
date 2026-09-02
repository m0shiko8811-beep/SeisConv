// seisconv-core / dsp - STFT spectrogram.
//
// Short-time Fourier transform of a single trace: slide a Hann-windowed frame
// across the trace, FFT each frame, and stack the half-spectrum magnitudes into
// a time × frequency image. Reveals how a trace's frequency content evolves down
// the record (dispersion, ringing, attenuation). Pure - no DOM, no deps. Reuses
// fft + nextPow2 from ./fft.

import { fft, nextPow2 } from './fft';

export interface Spectrogram {
  /** nFrames × nBins, row-major (row = time frame, col = freq bin). */
  mag: Float32Array;
  nFrames: number;
  nBins: number;
  freqs: Float32Array; // Hz, length nBins
  times: Float32Array; // s, length nFrames (frame-center time)
  maxMag: number; // peak magnitude (for normalized display)
  siUs: number; // echoed sample interval (µs)
}

/**
 * STFT magnitude of `samples`. Each frame is a `winLen`-sample Hann-windowed
 * slice taken every `hop` samples, zero-padded to nextPow2(winLen), FFT'd, and
 * its single-sided magnitude half-spectrum written as one ROW of a flat
 * nFrames×nBins row-major Float32Array. `siUs` is the sample interval (µs).
 *
 * Defaults: winLen 128 samples, hop = winLen/2 (50 % overlap). Both are clamped
 * to sane minimums so a degenerate request can't divide by zero or loop forever.
 */
export function spectrogram(
  samples: Float32Array,
  siUs: number,
  opts: { winLen?: number; hop?: number } = {},
): Spectrogram {
  const n = samples.length;
  const winLen = Math.max(2, (opts.winLen ?? 128) | 0);
  const hop = Math.max(1, (opts.hop ?? (winLen >> 1)) | 0);
  const N = nextPow2(winLen);
  const nBins = N >> 1;
  const fs = siUs > 0 ? 1e6 / siUs : 1; // sample rate (Hz)

  // Number of frames: every hop-th start whose window fits within the trace. At
  // least one frame so a short trace still produces a (zero-padded) column.
  const nFrames = n >= winLen ? Math.floor((n - winLen) / hop) + 1 : 1;

  const mag = new Float32Array(nFrames * nBins);
  const freqs = new Float32Array(nBins);
  const times = new Float32Array(nFrames);
  for (let k = 0; k < nBins; k++) freqs[k] = (k * fs) / N;
  const dt = fs > 0 ? 1 / fs : 1; // seconds per sample

  // Precompute the Hann window once (winLen samples).
  const win = new Float64Array(winLen);
  for (let i = 0; i < winLen; i++) win[i] = winLen > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (winLen - 1)) : 1;

  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let maxMag = 0;
  for (let f = 0; f < nFrames; f++) {
    const start = f * hop;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < winLen; i++) {
      const idx = start + i;
      re[i] = idx < n ? samples[idx] * win[i] : 0;
    }
    fft(re, im, false);
    const base = f * nBins;
    for (let k = 0; k < nBins; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mag[base + k] = m;
      if (m > maxMag) maxMag = m;
    }
    times[f] = (start + winLen / 2) * dt; // frame-center time (s)
  }

  return { mag, nFrames, nBins, freqs, times, maxMag, siUs };
}
