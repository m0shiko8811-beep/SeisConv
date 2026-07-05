// seisconv-core / dsp — FFT-Hilbert analytic signal.
//
// Pure (no DOM, no deps). Computes the analytic signal z(t) = x(t) + i·H[x](t)
// via the frequency-domain Hilbert transform (zero the negative frequencies,
// double the positive ones), giving the instantaneous ENVELOPE |z| and the
// instantaneous PHASE arg(z). Shared by the Sweeps tab (designed-vs-measured
// phase-error QC) and the sweep generator's derived analysis.
//
// Numerical notes:
//  • The input is zero-padded to the next power of two for the FFT; the pad
//    causes mild edge distortion in the first/last few samples — QC consumers
//    should trim the edges (they do).
//  • The UNWRAPPED phase of a long sweep spans hundreds of cycles (hundreds of
//    thousands of degrees); Float32 resolution (~7 significant digits) is NOT
//    enough to compare phases to fractions of a degree at that magnitude, so
//    phase is returned as Float64Array.

import { fft, nextPow2 } from './fft';

export interface InstantaneousPhase {
  /** Unwrapped instantaneous phase in RADIANS (Float64 — see header note). */
  phaseRad: Float64Array;
  /** Instantaneous amplitude (Hilbert envelope), same length as the input. */
  envelope: Float32Array;
}

/**
 * FFT-Hilbert analytic signal → unwrapped instantaneous phase + envelope.
 * For x(t) = A(t)·cos(φ(t)) (A ≥ 0, slowly varying) this recovers φ(t) and A(t).
 */
export function instantaneousPhase(x: Float32Array | Float64Array): InstantaneousPhase {
  const n = x.length;
  const phaseRad = new Float64Array(n);
  const envelope = new Float32Array(n);
  if (n === 0) return { phaseRad, envelope };

  const N = nextPow2(Math.max(2, n));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < n; i++) re[i] = x[i];
  fft(re, im, false);

  // Analytic-signal filter: keep DC and Nyquist as-is, double the positive
  // frequencies, zero the negative ones.
  const half = N >> 1;
  for (let k = 1; k < half; k++) { re[k] *= 2; im[k] *= 2; }
  for (let k = half + 1; k < N; k++) { re[k] = 0; im[k] = 0; }
  fft(re, im, true);

  // Wrapped phase + envelope, then unwrap the phase (remove 2π jumps).
  let prev = 0;
  let offset = 0;
  for (let i = 0; i < n; i++) {
    envelope[i] = Math.hypot(re[i], im[i]);
    const w = Math.atan2(im[i], re[i]);
    if (i > 0) {
      let d = w - prev;
      if (d > Math.PI) offset -= 2 * Math.PI;
      else if (d < -Math.PI) offset += 2 * Math.PI;
    }
    prev = w;
    phaseRad[i] = w + offset;
  }
  return { phaseRad, envelope };
}

/** Wrap an angle in DEGREES into (−180, +180]. */
export function wrapDeg180(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}
