// seisconv-core / dsp - assisted (seeded) first-break picking.
//
// An ASSISTED, moveout-guided first-break engine. The user drops ≥2 SEED picks on
// the gather; this routine predicts a target time for EVERY trace (a moveout guide
// through the seeds), runs the STA/LTA detector GATED to a narrow ±window around
// that guide (so a far / low-SNR trace can't run off to distant noise), locks the
// SAME phase by cross-correlation against a reference wavelet, snaps to the chosen
// peak/trough/zero-cross with a sub-sample parabolic refine, and finally drops /
// re-picks any pick that violates the robust local moveout continuity.
//
// The whole point is that picks TRACK the gather instead of scattering: the guide
// window is what kills far-trace scatter. Auto-pick is a FIRST GUESS the operator
// edits - never a final answer.
//
// Pure - no DOM, no deps beyond sibling dsp helpers (applyAGC, pickSTALTA,
// crossCorrelate, median/mad). Bounded (FB_ASSIST_MAX_TRACES + per-trace sample
// caps inside pickSTALTA) and finite-guarded throughout; it NEVER throws and never
// emits a non-finite pick time (a no-pick / dead trace is `NaN`, which the caller
// treats as "no pick" and the overlay draws as a gap).

import { applyAGC } from './agc';
import { pickSTALTA } from './firstbreak';
import { crossCorrelate } from './correlate';
import { median, mad, MAD_SIGMA, clamp01 } from './robuststats';

/** Which phase a snapped pick locks onto. */
export type FBPolarity = 'peak' | 'trough' | 'zero';

/** Where a pick came from. The engine only ever emits 'seed' or 'auto'; 'edited'
 *  is reserved for the UI when the operator drags an auto pick. */
export type FBSource = 'seed' | 'auto' | 'edited';

/** A user-placed seed: an absolute trace index + the picked onset time (ms). */
export interface FBSeed {
  absIdx: number;
  tMs: number;
}

/** Assisted-pick tuning. Every field is optional with a conservative default; a
 *  non-finite / non-positive override falls back to the default (never poisons the
 *  detector). Windows are in milliseconds. */
export interface FBAssistOpts {
  /** STA window (ms). Default 8. */
  staMs?: number;
  /** LTA window (ms). Default 60. */
  ltaMs?: number;
  /** STA/LTA trigger ratio. Default 2.5. */
  threshold?: number;
  /** ± search half-window around the moveout guide (ms). The gate that kills
   *  far-trace scatter. Default 25. */
  windowMs?: number;
  /** Phase to snap onto. Default 'peak'. */
  polarity?: FBPolarity;
  /** Conditioning AGC window (ms) - equalises far-weak vs near-hot traces so each
   *  gets equal say. Default 200. */
  agcWindowMs?: number;
  /** Half-length of the cross-correlation reference wavelet (ms). Default 30. */
  refHalfMs?: number;
  /** MAD multiple for the continuity-QC outlier gate. Default 4. */
  continuityK?: number;
  /** A trace is DEAD when its RMS is below this fraction of the live-neighbour
   *  median RMS (the guide spans it; no pick). Default 0.02. */
  deadFrac?: number;
}

/** One pick (or no-pick) per input trace. */
export interface FBPick {
  /** Absolute trace index in the open file. */
  absIdx: number;
  /** Picked onset time (ms), or `NaN` for a dead / no-confident-pick trace. */
  tMs: number;
  /** Provenance - never auto-overwrites a 'seed'. */
  source: FBSource;
  /** 0..1 - |cross-correlation coefficient| vs the reference wavelet (how sure the
   *  phase lock is). Seeds report 1. */
  confidence: number;
  /** Signed ms off the robust local moveout trend (≈0 for inliers / seeds; large
   *  ⇒ flagged low-confidence). */
  deviation: number;
  /** True for a near-zero-RMS trace the guide spans (drawn as a gap). */
  dead: boolean;
}

/** Engine input. `traces`, `absIdx` and `offsets` are PARALLEL arrays over the
 *  gather's REAL adjacent traces (step 1 - never the display-strided columns). */
export interface FBAssistInput {
  traces: ArrayLike<Float32Array | null | undefined>;
  absIdx: number[];
  siUs: number;
  seeds: FBSeed[];
  /** Per-trace offset (parallel to `traces`); null / mostly-missing ⇒ the guide
   *  falls back to ordering by trace index. */
  offsets?: (number | null | undefined)[] | null;
  opts?: FBAssistOpts;
  /** Throttled progress callback (done, total) - the worker forwards it to the
   *  global progress bar. */
  onProgress?: (done: number, total: number) => void;
}

/** Engine output. `picks` and `guideMs` are parallel to the input traces. */
export interface FBAssistResult {
  picks: FBPick[];
  /** Moveout guide time (ms) per input trace (NaN only when there are no seeds). */
  guideMs: Float32Array;
  /** The ± half-window actually used (for the overlay's shaded search band). */
  windowMs: number;
  /** Whether real header offsets (not the trace index) ordered the guide. */
  hasOffsets: boolean;
}

/** Bound the trace COUNT regardless of caller (the worker also caps before this). */
export const FB_ASSIST_MAX_TRACES = 20_000;

/** Positive-finite override or a default. */
function posOr(v: number | undefined, d: number): number {
  return Number.isFinite(v as number) && (v as number) > 0 ? (v as number) : d;
}

/** A piecewise-linear moveout guide through the seed (key, time) pairs (sorted by
 *  key); the two end segments are EXTRAPOLATED so every trace - including the far
 *  ones beyond the outermost seed - gets a predicted time. Slopes are finite-guarded
 *  (a zero key span degrades to the seed's time rather than ±Infinity). */
function makeGuide(s: { k: number; t: number }[]): (k: number) => number {
  if (s.length === 0) return () => NaN;
  if (s.length === 1) return () => s[0].t;
  const slopeOf = (a: { k: number; t: number }, b: { k: number; t: number }): number => {
    const dk = b.k - a.k;
    const m = dk !== 0 ? (b.t - a.t) / dk : 0;
    return Number.isFinite(m) ? m : 0;
  };
  const first = s[0], last = s[s.length - 1];
  const headSlope = slopeOf(s[0], s[1]);
  const tailSlope = slopeOf(s[s.length - 2], s[s.length - 1]);
  return (k: number): number => {
    if (!Number.isFinite(k)) return NaN;
    if (k <= first.k) return first.t + headSlope * (k - first.k);
    if (k >= last.k) return last.t + tailSlope * (k - last.k);
    for (let j = 0; j < s.length - 1; j++) {
      if (k >= s[j].k && k <= s[j + 1].k) {
        return s[j].t + slopeOf(s[j], s[j + 1]) * (k - s[j].k);
      }
    }
    return last.t;
  };
}

/** A 2·half+1 sample window of `s` centred at sample `center` (rounded), zero-padded
 *  past the trace ends; non-finite samples become 0. */
function extractWindow(s: Float32Array, center: number, half: number): Float32Array {
  const out = new Float32Array(2 * half + 1);
  const c = Math.round(center);
  for (let j = -half; j <= half; j++) {
    const idx = c + j;
    const v = idx >= 0 && idx < s.length ? s[idx] : 0;
    out[j + half] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** Snap a pick time (ms) onto the nearest peak / trough / zero-crossing of `s`
 *  within ±`reach` samples, with a 3-point parabolic (peak/trough) or linear (zero)
 *  sub-sample refine. Returns the refined time (ms), or the input on any degeneracy.*/
function snapPhase(s: Float32Array, tMs: number, siUs: number, pol: FBPolarity, reach: number): number {
  const n = s.length;
  const c = Math.round((tMs * 1000) / siUs);
  if (!(n >= 3) || !(c >= 0 && c < n)) return tMs;
  const lo = Math.max(1, c - reach);
  const hi = Math.min(n - 2, c + reach);
  if (lo > hi) return tMs;

  if (pol === 'zero') {
    // Nearest sign change to `c`; linear-interpolate the exact crossing.
    let best = -1, bestDist = Infinity;
    for (let i = lo; i <= hi; i++) {
      const a = s[i], b = s[i + 1];
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b && a * b <= 0) {
        const d = Math.abs(i - c);
        if (d < bestDist) { bestDist = d; best = i; }
      }
    }
    if (best < 0) return tMs;
    const a = s[best], b = s[best + 1];
    const frac = clamp01(-a / (b - a)); // where between best and best+1 the line hits 0
    const sub = best + (Number.isFinite(frac) ? frac : 0);
    const ms = (sub * siUs) / 1000;
    return Number.isFinite(ms) ? ms : tMs;
  }

  // peak / trough - argmax / argmin of the conditioned trace in the window.
  const want = pol === 'trough' ? -1 : 1;
  let bi = -1, bv = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const v = want * (Number.isFinite(s[i]) ? s[i] : -Infinity * want);
    if (v > bv) { bv = v; bi = i; }
  }
  if (bi < 1 || bi >= n - 1) return tMs;
  const ym1 = want * s[bi - 1], y0 = want * s[bi], yp1 = want * s[bi + 1];
  let off = 0;
  const denom = ym1 - 2 * y0 + yp1;
  if (Number.isFinite(denom) && denom !== 0) {
    off = (0.5 * (ym1 - yp1)) / denom;
    if (!Number.isFinite(off) || Math.abs(off) > 1) off = 0;
  }
  const ms = ((bi + off) * siUs) / 1000;
  return Number.isFinite(ms) ? ms : tMs;
}

/**
 * Assisted, moveout-guided first-break picking. See the file header for the six
 * steps (condition → guide → window-constrained detect → xcorr snap → phase snap →
 * continuity QC). Returns one pick per input trace plus the guide curve + the
 * search half-window for the overlay. Never throws; never emits a non-finite tMs.
 */
export function assistFirstBreaks(input: FBAssistInput): FBAssistResult {
  const { siUs } = input;
  const o = input.opts ?? {};
  const staMs = posOr(o.staMs, 8);
  const ltaMs = posOr(o.ltaMs, 60);
  const threshold = posOr(o.threshold, 2.5);
  const windowMs = posOr(o.windowMs, 25);
  const polarity: FBPolarity = o.polarity === 'trough' || o.polarity === 'zero' ? o.polarity : 'peak';
  const agcWindowMs = posOr(o.agcWindowMs, 200);
  const refHalfMs = posOr(o.refHalfMs, 30);
  const continuityK = posOr(o.continuityK, 4);
  const deadFrac = Number.isFinite(o.deadFrac as number) && (o.deadFrac as number) >= 0 ? (o.deadFrac as number) : 0.02;

  const n = Math.min(input.traces.length, input.absIdx.length, FB_ASSIST_MAX_TRACES);
  const picks: FBPick[] = [];
  const guideMs = new Float32Array(n).fill(NaN);
  const onProgress = input.onProgress;
  if (n === 0 || !(siUs > 0)) return { picks, guideMs, windowMs, hasOffsets: false };

  const absIdx = input.absIdx;
  const traces = input.traces;
  const posByAbs = new Map<number, number>();
  for (let i = 0; i < n; i++) posByAbs.set(absIdx[i], i);

  // 1. Condition once (AGC ~200ms) + per-trace RMS + dead detection. AGC gives the
  //    weak far traces equal weight so the detector triggers on them too; near-zero
  //    RMS ⇒ dead (the guide still spans the gap).
  const cond: (Float32Array | null)[] = new Array(n).fill(null);
  const rms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = traces[i];
    if (!s || s.length === 0) { rms[i] = 0; continue; }
    let e = 0, m = 0;
    for (let k = 0; k < s.length; k++) { const v = s[k]; if (Number.isFinite(v)) { e += v * v; m++; } }
    rms[i] = m > 0 ? Math.sqrt(e / m) : 0;
    cond[i] = applyAGC(s as Float32Array, agcWindowMs, siUs, 'rms');
  }
  const liveRms: number[] = [];
  for (let i = 0; i < n; i++) if (rms[i] > 0) liveRms.push(rms[i]);
  const medRms = median(liveRms);
  const dead = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (rms[i] <= 0 || !cond[i]) dead[i] = 1;
    else if (medRms > 0 && rms[i] < deadFrac * medRms) dead[i] = 1;
  }

  // 2. Moveout guide - order by |offset| when the gather has real header offsets,
  //    else by trace index. Piecewise-linear between adjacent seeds, extrapolated.
  const offs = input.offsets;
  let validOff = 0;
  if (offs) for (let i = 0; i < n; i++) { const v = offs[i]; if (typeof v === 'number' && Number.isFinite(v)) validOff++; }
  const hasOffsets = !!offs && validOff > n * 0.5;
  const key = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (hasOffsets) { const v = offs![i]; key[i] = typeof v === 'number' && Number.isFinite(v) ? Math.abs(v) : absIdx[i]; }
    else key[i] = absIdx[i];
  }

  // Seed (key, time) pairs for seeds present in THIS set; sorted + merged by key.
  const seedAbs = new Set<number>();
  const seedTimeByAbs = new Map<number, number>();
  const rawKT: { k: number; t: number }[] = [];
  for (const sd of input.seeds) {
    const p = posByAbs.get(sd.absIdx);
    if (p === undefined || !Number.isFinite(sd.tMs)) continue;
    seedAbs.add(sd.absIdx);
    seedTimeByAbs.set(sd.absIdx, sd.tMs);
    rawKT.push({ k: key[p], t: sd.tMs });
  }
  rawKT.sort((a, b) => a.k - b.k);
  const seedKT: { k: number; t: number }[] = [];
  for (const e of rawKT) {
    const last = seedKT[seedKT.length - 1];
    if (last && Math.abs(e.k - last.k) < 1e-9) last.t = (last.t + e.t) / 2; // same offset ⇒ average
    else seedKT.push({ k: e.k, t: e.t });
  }

  const guideAt = makeGuide(seedKT);
  for (let i = 0; i < n; i++) guideMs[i] = guideAt(key[i]);

  // With fewer than two distinct seeds there is no moveout to follow - emit just the
  // seeds (the UI's empty-state asks for ≥2).
  if (seedKT.length < 2) {
    for (let i = 0; i < n; i++) {
      const abs = absIdx[i];
      if (seedAbs.has(abs)) picks.push({ absIdx: abs, tMs: seedTimeByAbs.get(abs)!, source: 'seed', confidence: 1, deviation: 0, dead: !!dead[i] });
    }
    return { picks, guideMs, windowMs, hasOffsets };
  }

  // Reference wavelet from the NEAR seed (smallest key) on its conditioned trace -
  // the phase every auto pick is cross-correlated against.
  const refHalfSamp = Math.max(2, Math.round((refHalfMs * 1000) / siUs));
  const snapReach = Math.max(2, Math.min(40, Math.round(refHalfSamp / 2)));
  let refPos = -1;
  for (let i = 0; i < n; i++) {
    if (!seedAbs.has(absIdx[i]) || !cond[i]) continue;
    if (refPos < 0 || key[i] < key[refPos]) refPos = i;
  }
  const ref = refPos >= 0 ? extractWindow(cond[refPos]!, (seedTimeByAbs.get(absIdx[refPos])! * 1000) / siUs, refHalfSamp) : null;

  // 3-5. Per-trace window-constrained detect → xcorr snap → phase snap.
  const PROG_EVERY = 64;
  for (let i = 0; i < n; i++) {
    const abs = absIdx[i];
    if (seedAbs.has(abs)) {
      picks.push({ absIdx: abs, tMs: seedTimeByAbs.get(abs)!, source: 'seed', confidence: 1, deviation: 0, dead: !!dead[i] });
    } else if (dead[i] || !cond[i]) {
      picks.push({ absIdx: abs, tMs: NaN, source: 'auto', confidence: 0, deviation: 0, dead: true });
    } else {
      const g = guideMs[i];
      const lo = g - windowMs, hi = g + windowMs;
      let t = Number.isFinite(g) ? pickSTALTA(cond[i], siUs, { staMs, ltaMs, threshold, minTimeMs: lo, maxTimeMs: hi }) : NaN;
      let conf = 0;
      if (Number.isFinite(t)) {
        // 4. Cross-correlation snap - lock the same phase as the reference wavelet.
        if (ref) {
          const win = extractWindow(cond[i]!, (t * 1000) / siUs, refHalfSamp);
          const cc = crossCorrelate(win, ref, siUs);
          if (Number.isFinite(cc.bestLagMs)) t = Math.max(lo, Math.min(hi, t + cc.bestLagMs));
          conf = Math.abs(cc.bestCoef);
        }
        // 5. Snap to the chosen phase + sub-sample refine (kept inside the window).
        const refined = snapPhase(cond[i]!, t, siUs, polarity, snapReach);
        if (Number.isFinite(refined)) t = Math.max(lo, Math.min(hi, refined));
      }
      picks.push({ absIdx: abs, tMs: Number.isFinite(t) ? t : NaN, source: 'auto', confidence: clamp01(conf), deviation: 0, dead: false });
    }
    if (onProgress && (i % PROG_EVERY === 0)) onProgress(i, n);
  }

  // 6. Continuity QC - residual = pick - guide along the gather; a robust median+MAD
  //    of those residuals defines the local moveout trend. A pick more than k·MAD off
  //    is re-picked in a tightened window centred on the trend; if it is still off it
  //    keeps the pick but is marked low-confidence (large deviation ⇒ flagged in red).
  const resid: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = picks[i];
    if (p.source === 'auto' && Number.isFinite(p.tMs) && Number.isFinite(guideMs[i])) resid.push(p.tMs - guideMs[i]);
  }
  const medRes = median(resid);
  const sigma = MAD_SIGMA * mad(resid, medRes);
  if (sigma > 0) {
    for (let i = 0; i < n; i++) {
      const p = picks[i];
      if (p.source !== 'auto' || !Number.isFinite(p.tMs) || !Number.isFinite(guideMs[i])) continue;
      let dev = p.tMs - guideMs[i] - medRes;
      if (Math.abs(dev) > continuityK * sigma) {
        // Re-pick in a half-width window centred on the robust trend.
        const gg = guideMs[i] + medRes;
        const W2 = windowMs / 2;
        const lo = gg - W2, hi = gg + W2;
        let t2 = pickSTALTA(cond[i]!, siUs, { staMs, ltaMs, threshold, minTimeMs: lo, maxTimeMs: hi });
        if (Number.isFinite(t2) && cond[i]) {
          if (ref) {
            const win = extractWindow(cond[i]!, (t2 * 1000) / siUs, refHalfSamp);
            const cc = crossCorrelate(win, ref, siUs);
            if (Number.isFinite(cc.bestLagMs)) t2 = Math.max(lo, Math.min(hi, t2 + cc.bestLagMs));
            p.confidence = clamp01(Math.abs(cc.bestCoef));
          }
          const refined = snapPhase(cond[i]!, t2, siUs, polarity, snapReach);
          if (Number.isFinite(refined)) t2 = Math.max(lo, Math.min(hi, refined));
          p.tMs = Number.isFinite(t2) ? t2 : p.tMs;
          dev = p.tMs - guideMs[i] - medRes;
        }
        // Still an outlier after the retry ⇒ keep it but flag it (halve confidence).
        if (Math.abs(dev) > continuityK * sigma) p.confidence = clamp01(p.confidence * 0.5);
      }
      p.deviation = Number.isFinite(dev) ? dev : 0;
    }
  }

  if (onProgress) onProgress(n, n);
  return { picks, guideMs, windowMs, hasOffsets };
}
