// seisconv-core / dsp - f-k (frequency-wavenumber) spectrum.
//
// 2-D FFT of a seismic section: first transform each trace TIME → FREQUENCY,
// then transform ACROSS traces SPACE → WAVENUMBER. The resulting |F(kx, f)|
// image separates events by apparent velocity (slope = f/kx), the basis of f-k
// filtering, dip analysis, and aliasing QC. Pure - no DOM, no deps. Reuses
// fft + nextPow2 from ./fft.

import { fft, nextPow2 } from './fft';

export interface FkSpectrum {
  /** nF × nKx, row-major (row = frequency, col = wavenumber). */
  mag: Float32Array;
  nKx: number;
  nF: number;
  kAxis: Float32Array; // wavenumber (cycles / distance-unit), length nKx, fftshifted (kx=0 centred)
  fAxis: Float32Array; // frequency (Hz), length nF (positive half)
  maxMag: number; // peak magnitude (for normalized display)
}

/**
 * f-k spectrum of a section. `matrix` is a row-major nTraces×nSamples Float32
 * array (row = trace). Both dimensions are zero-padded to a power of two; we FFT
 * each trace (time → freq), then FFT each frequency row across traces (space →
 * wavenumber). The output keeps the POSITIVE-frequency half-plane and is
 * fftshifted along kx so kx = 0 sits in the centre column.
 *
 * `siUs` is the sample interval (µs) → frequency axis; `dx` is the trace spacing
 * (default 1) → wavenumber axis. Magnitudes are |complex|.
 */
export function fkSpectrum(
  matrix: Float32Array,
  nTraces: number,
  nSamples: number,
  siUs: number,
  dx = 1,
): FkSpectrum {
  const nt = Math.max(1, nTraces | 0);
  const ns = Math.max(1, nSamples | 0);
  const NT = nextPow2(ns); // padded time length
  const NX = nextPow2(nt); // padded space length
  const nF = NT >> 1; // positive-frequency half
  const nKx = NX; // full (signed) wavenumber axis, fftshifted

  // Stage 1 - time → frequency per trace. Store the half-spectrum (nF bins) of
  // every trace as complex columns in two NX×nF buffers (row = trace index).
  // (We pad the SPACE axis to NX up-front; rows >= nt stay zero.)
  const tre = new Float64Array(NX * nF);
  const tim = new Float64Array(NX * nF);
  const re = new Float64Array(NT);
  const im = new Float64Array(NT);
  for (let t = 0; t < nt; t++) {
    re.fill(0);
    im.fill(0);
    const base = t * ns;
    for (let s = 0; s < ns; s++) re[s] = matrix[base + s];
    fft(re, im, false);
    const off = t * nF;
    for (let k = 0; k < nF; k++) { tre[off + k] = re[k]; tim[off + k] = im[k]; }
  }

  // Stage 2 - space → wavenumber per frequency. For each freq bin f, gather the
  // complex value of every trace at f into a length-NX column, FFT it, fftshift,
  // and write magnitudes into row f of the output (row-major nF×nKx).
  const mag = new Float32Array(nF * nKx);
  const cre = new Float64Array(NX);
  const cim = new Float64Array(NX);
  const halfX = NX >> 1;
  let maxMag = 0;
  for (let f = 0; f < nF; f++) {
    for (let t = 0; t < NX; t++) {
      if (t < nt) { cre[t] = tre[t * nF + f]; cim[t] = tim[t * nF + f]; }
      else { cre[t] = 0; cim[t] = 0; }
    }
    fft(cre, cim, false);
    const rowBase = f * nKx;
    // fftshift: bin j of the FFT maps to output column ((j + NX/2) mod NX) so
    // kx = 0 lands in the centre. Equivalently, output column c reads source bin
    // (c + NX/2) mod NX.
    for (let c = 0; c < nKx; c++) {
      const j = (c + halfX) % NX;
      const m = Math.sqrt(cre[j] * cre[j] + cim[j] * cim[j]);
      mag[rowBase + c] = m;
      if (m > maxMag) maxMag = m;
    }
  }

  // Axes. Frequency: positive half, Hz. Wavenumber: signed, fftshifted, in
  // cycles per distance-unit (kx ∈ [-1/(2dx), +1/(2dx)) at the Nyquist edges).
  const fs = siUs > 0 ? 1e6 / siUs : 1; // sample rate (Hz)
  const fAxis = new Float32Array(nF);
  for (let k = 0; k < nF; k++) fAxis[k] = (k * fs) / NT;
  const kAxis = new Float32Array(nKx);
  const dk = dx !== 0 ? 1 / (NX * dx) : 1; // wavenumber bin width
  for (let c = 0; c < nKx; c++) kAxis[c] = (c - halfX) * dk; // centred at kx=0

  return { mag, nKx, nF, kAxis, fAxis, maxMag };
}
