// seisconv-core / dsp - cross-correlation & trace difference.
//
// Pure (no DOM, no deps) QC ops for the Trace Workbench's ANALYSIS view:
//  • crossCorrelate - FFT-based normalized cross-correlation; the peak is a
//    correlation coefficient in [-1,1] and its lag (ms) tells you how far one
//    trace is shifted in time relative to the other.
//  • difference - sample-wise A - B (resampling B to A's length first) plus the
//    RMS amplitudes and the B/A gain ratio.

import { fft, nextPow2 } from './fft';
import { resampleLinear } from './interpolate';

export interface CrossCorrelation {
  lags: Float32Array; // lag axis in ms, centred so index of 0-lag is the middle
  corr: Float32Array; // normalized correlation coefficient per lag, in [-1,1]
  bestLagMs: number; // lag (ms) at the strongest |corr|
  bestCoef: number; // the (signed) correlation coefficient at that lag
}

/**
 * FFT-based normalized cross-correlation of two real traces `a` and `b`.
 *
 * Zero-pads both to nextPow2(a.length + b.length - 1), forward-FFTs each,
 * multiplies A · conj(B), inverse-FFTs, and takes the real part as the raw
 * cross-correlation sequence. The result is normalized by √(energyA·energyB)
 * so the peak is a correlation coefficient in [-1,1]. The sequence is rotated so
 * the zero lag sits in the centre; `lags` is the matching lag axis in ms
 * (`sampleIntUs/1000` per sample). `bestLagMs`/`bestCoef` report the strongest
 * |corr| - a positive lag means `a` is delayed relative to `b`.
 */
export function crossCorrelate(
  a: Float32Array,
  b: Float32Array,
  sampleIntUs: number,
): CrossCorrelation {
  const na = a.length;
  const nb = b.length;
  if (na === 0 || nb === 0) {
    return { lags: new Float32Array(0), corr: new Float32Array(0), bestLagMs: 0, bestCoef: 0 };
  }

  const L = na + nb - 1; // full linear cross-correlation length
  const N = nextPow2(L);

  // Forward-FFT a (zero-padded to N).
  const ar = new Float64Array(N);
  const ai = new Float64Array(N);
  let energyA = 0;
  for (let i = 0; i < na; i++) { ar[i] = a[i]; energyA += a[i] * a[i]; }
  fft(ar, ai, false);

  // Forward-FFT b (zero-padded to N).
  const br = new Float64Array(N);
  const bi = new Float64Array(N);
  let energyB = 0;
  for (let i = 0; i < nb; i++) { br[i] = b[i]; energyB += b[i] * b[i]; }
  fft(br, bi, false);

  // Spectral product A · conj(B) → cross-correlation in the frequency domain.
  const pr = new Float64Array(N);
  const pi = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    // (ar + i·ai)(br - i·bi) = (ar·br + ai·bi) + i(ai·br - ar·bi)
    pr[i] = ar[i] * br[i] + ai[i] * bi[i];
    pi[i] = ai[i] * br[i] - ar[i] * bi[i];
  }
  fft(pr, pi, true); // inverse → real part is the raw cross-correlation

  // The circular result has lag k at index k for k≥0 and lag -m at index N-m.
  // Unwrap into a centred linear sequence of length L: lags -(nb-1)…(na-1).
  const corr = new Float32Array(L);
  const lags = new Float32Array(L);
  const msPerSample = sampleIntUs / 1000;
  const norm = Math.sqrt(energyA * energyB) || 1; // guard zero-energy traces
  const zero = nb - 1; // index of the 0-lag sample in the centred sequence

  let bestCoef = 0;
  let bestLagMs = 0;
  let bestAbs = -1;
  for (let k = 0; k < L; k++) {
    const lag = k - zero; // signed lag in samples
    const idx = lag >= 0 ? lag : N + lag; // map onto the circular FFT output
    const c = pr[idx] / norm;
    corr[k] = c;
    lags[k] = lag * msPerSample;
    const abs = Math.abs(c);
    if (abs > bestAbs) { bestAbs = abs; bestCoef = c; bestLagMs = lags[k]; }
  }

  return { lags, corr, bestLagMs, bestCoef };
}

export interface TraceDifference {
  diff: Float32Array; // sample-wise A - B (B resampled to A's length), length = a.length
  rmsA: number; // RMS amplitude of A
  rmsB: number; // RMS amplitude of B (after resampling to A's length)
  rmsDiff: number; // RMS amplitude of the difference
  gainRatio: number; // rmsB / rmsA (0 when A is silent)
}

/** Root-mean-square of a sample series (0 for an empty array). */
function rms(x: Float32Array): number {
  const n = x.length;
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i] * x[i];
  return Math.sqrt(s / n);
}

/**
 * Sample-wise difference A - B. When the traces differ in length, `b` is linearly
 * resampled to `a.length` first so the subtraction lines up. Returns the
 * difference trace plus RMS amplitudes of A, B and (A - B), and the B/A gain
 * ratio (guarded against a silent A).
 */
export function difference(a: Float32Array, b: Float32Array): TraceDifference {
  const n = a.length;
  const bAligned = b.length === n ? b : resampleLinear(b, n);
  // resampleLinear returns an empty array when b has no samples (a dead/empty
  // trace), so bAligned can be shorter than n. Treat any missing B sample as 0
  // rather than reading undefined → NaN-poisoning diff and every RMS below.
  const mb = bAligned.length;
  const diff = new Float32Array(n);
  for (let i = 0; i < n; i++) diff[i] = a[i] - (i < mb ? bAligned[i] : 0);
  const rmsA = rms(a);
  const rmsB = rms(bAligned);
  return {
    diff,
    rmsA,
    rmsB,
    rmsDiff: rms(diff),
    gainRatio: rmsA > 0 ? rmsB / rmsA : 0,
  };
}
