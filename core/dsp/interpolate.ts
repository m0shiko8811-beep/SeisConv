// seisconv-core / dsp - interpolation & resampling.
//
// First of the "not just data" processing ops: composable, pure functions over
// trace samples. Heavy runs happen in the worker thread. More ops (AGC, filters,
// gain) follow the same pure-function shape.

import type { ParsedFile, Trace } from '../types';

/**
 * Linearly resample a sample series to `newLength` points. Endpoints are
 * preserved; same-length input returns a copy.
 */
export function resampleLinear(samples: Float32Array, newLength: number): Float32Array {
  const n = samples.length;
  if (newLength <= 0 || n === 0) return new Float32Array(0);
  if (newLength === n) return samples.slice();
  const out = new Float32Array(newLength);
  if (n === 1) {
    out.fill(samples[0]);
    return out;
  }
  if (newLength === 1) {
    // Avoid (newLength - 1) === 0 → Infinity → NaN; collapse to the first sample.
    out[0] = samples[0];
    return out;
  }
  const scale = (n - 1) / (newLength - 1);
  for (let i = 0; i < newLength; i++) {
    const x = i * scale;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, n - 1);
    const t = x - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

/**
 * Resample every trace to a new sample interval (µs) by linear interpolation.
 * Returns a NEW ParsedFile; the input is not mutated.
 */
export function resampleToInterval(pf: ParsedFile, newIntervalUs: number): ParsedFile {
  const oldSi = pf.bh.sampleInt ?? 0;
  if (!oldSi || newIntervalUs <= 0) {
    throw new Error('resampleToInterval: need a positive source and target sample interval');
  }
  const ratio = oldSi / newIntervalUs;
  const traces: Trace[] = pf.traces.map((tr) => {
    if (!tr.samples) return { ...tr };
    const newLen = Math.max(1, Math.round(tr.nSamples * ratio));
    return { ...tr, samples: resampleLinear(tr.samples, newLen), nSamples: newLen };
  });
  return {
    ...pf,
    traces,
    bh: { ...pf.bh, sampleInt: newIntervalUs, samplesTrace: traces[0]?.nSamples ?? pf.bh.samplesTrace },
  };
}
