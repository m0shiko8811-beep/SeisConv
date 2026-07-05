// seisconv-core / dsp — NMO semblance (velocity analysis).
//
// Hyperbolic-moveout semblance over a velocity scan: for each (velocity, time)
// it NMO-corrects the gather and measures coherency (0..1). Uses header offsets
// when present, else a synthetic 25 m spacing. Ported from the SeisConv reference.

import type { Trace } from '../types';

export interface SemblanceResult {
  /** nV × nT, row-major (row = velocity), values 0..1. */
  semb: Float32Array;
  vels: number[];
  nT: number;
  dt: number;
  velMin: number;
  velMax: number;
  siUs: number;
  hasOffsets: boolean;
  offNote: string;
}

export function computeSemblance(traces: Trace[], siUs: number, velMin: number, velMax: number, velStep: number): SemblanceResult {
  const dt = siUs * 1e-6; // seconds
  // Time axis = the LONGEST trace, not traces[0]: on a mixed-length gather a short
  // first trace would truncate every longer one, and (with the per-trace bounds
  // check below) a short trace simply contributes no sample beyond its own end.
  let nT = 0;
  for (const tr of traces) if (tr.nSamples > nT) nT = tr.nSamples;
  // Guard the velocity scan: a non-finite / zero / negative velStep from the UI
  // (e.g. numVal('velStep')||50 lets -10 through) would make the scan loop never
  // advance → spin forever / exhaust memory. Clamp to a positive step and cap the
  // velocity count BEFORE allocating, so a hostile/garbage input can't DoS the worker.
  const step = Number.isFinite(velStep) && velStep > 0 ? velStep : 50;
  const lo = Number.isFinite(velMin) ? velMin : 0;
  const hi = Number.isFinite(velMax) ? velMax : lo;
  const MAX_VELS = 4096;
  const nVCap = Math.max(1, Math.min(Math.floor((hi - lo) / step) + 1, MAX_VELS));
  const vels: number[] = [];
  for (let i = 0; i < nVCap; i++) vels.push(lo + i * step);
  const nV = vels.length;

  // Offsets from headers, else synthetic (midpoint-centered, 25 m spacing).
  const rawOff = traces.map((tr) => {
    const o = tr.hdr?.offset;
    const n = typeof o === 'number' ? o : o != null ? parseFloat(o) : NaN;
    return isFinite(n) ? Math.abs(n) : null;
  });
  const validOff = rawOff.filter((x) => x !== null && x > 0);
  const hasOff = validOff.length > traces.length * 0.5;
  // When the gather has real header offsets, traces WITHOUT a valid offset get
  // `null` (and are skipped below) rather than a synthetic index*25 m offset on a
  // different distance scale — mixing the two scales on one gather biases the NMO
  // hyperbola and the stacking-velocity peak. Only when NO real offsets exist do
  // we fall back to a uniform synthetic spacing for the whole gather.
  const offsets = rawOff.map((off, i) =>
    hasOff ? (off !== null && off > 0 ? off : null) : Math.abs(i - traces.length / 2) * 25,
  );

  const semb = new Float32Array(nV * nT);
  for (let vi = 0; vi < nV; vi++) {
    const v2 = vels[vi] * vels[vi];
    for (let ti = 0; ti < nT; ti++) {
      const t0 = ti * dt;
      const t02 = t0 * t0;
      let sumA = 0;
      let sumA2 = 0;
      let n = 0;
      for (let j = 0; j < traces.length; j++) {
        const s = traces[j].samples;
        if (!s) continue;
        const x = offsets[j];
        if (x === null) continue; // no valid offset on a header-offset gather → skip
        const tNmo = Math.sqrt(Math.max(0, t02 + (x * x) / v2));
        const si = Math.round(tNmo / dt);
        // Bound `si` by THIS trace's real length, not the gather's max nT, so a
        // shorter trace never reads s[si] === undefined → NaN into the sums.
        if (si >= 0 && si < s.length) {
          const amp = s[si];
          sumA += amp;
          sumA2 += amp * amp;
          n++;
        }
      }
      if (n > 0 && sumA2 > 1e-10) semb[vi * nT + ti] = (sumA * sumA) / (n * sumA2);
    }
  }

  // Report the ACTUAL scanned velocity range (after clamping/capping) so the
  // renderer's axis matches the rows in `semb`, not the raw (possibly garbage) input.
  const scannedMin = vels[0];
  const scannedMax = vels[vels.length - 1];
  return { semb, vels, nT, dt, velMin: scannedMin, velMax: scannedMax, siUs, hasOffsets: hasOff, offNote: hasOff ? 'using header offsets' : 'synthetic offsets (25m spacing)' };
}
