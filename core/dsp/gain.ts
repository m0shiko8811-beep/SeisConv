// seisconv-core / dsp - display gain family (Seismic Unix `sugain` semantics).
//
// WHY this exists: the app had only two display gains, at opposite extremes -
// a flat multiplier, and AGC. AGC divides every window by its OWN level, so a
// dying geophone does not go quiet under it: its noise floor is what gets
// stretched toward full scale. What is destroyed is the amplitude evidence -
// brightness can no longer tell a weak channel from a healthy one, in either
// direction. That is fatal for spread QC. `tpow`/`epow` brighten late arrivals with a factor that depends
// ONLY on time, identically for every trace, so relative amplitude BETWEEN
// channels survives and a bad channel still reads as bad.
//
// Reference: Seismic Unix, src/su/main/amplitudes/sugain.c (+ its gain() in
// lib/gain-style helpers). Self-doc operation order, quoted from the source:
//
//   out(t) = scale * BAL{CLIP[AGC{[t^tpow * exp(epow * t^etpow) * (in(t)-bias)]^gpow}]}
//
// and the if-chain in gain() runs, in order:
//   bias, tpow, epow, gpow, agc/gagc, trap, clip, pclip, nclip, qclip, qbal,
//   pbal, mbal, maxbal, scale
//
// This module implements the subset that is a DISPLAY gain: tpow, epow (with
// etpow), gpow, pbal, scale. It keeps SU's order, which matters: gpow before
// tpow compresses a different picture than tpow before gpow. AGC is separate and
// already correct in ./agc.ts, so it is not duplicated here; a caller that wants
// AGC applies it between the gpow and pbal stages to stay faithful to SU.
//
// Pure TypeScript: no DOM, no Electron. Runs in Node, the worker and the browser.

/** Largest magnitude a Float32 can hold. Anything past this stores as Infinity. */
const F32_MAX = 3.4028234663852886e38;

/** Gain stages, in SU's application order. All fields optional; the defaults are
 *  SU's own defaults, so `{}` is the identity gain ("none" / raw). */
export interface GainParams {
  /** multiply sample at time t by t^tpow. SU default 0 (off). */
  tpow?: number;
  /** multiply by exp(epow * t^etpow). SU default 0 (off). */
  epow?: number;
  /** exponent applied to t inside the epow exponential. SU default 1. */
  etpow?: number;
  /** signed power: sign(x) * |x|^gpow. SU default 1 (off). Must be > 0. */
  gpow?: number;
  /** balance the trace by its own RMS. SU flag, default false. */
  pbal?: boolean;
  /** overall constant multiplier, applied LAST. SU default 1. */
  scale?: number;
}

function num(v: number | undefined, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/**
 * Store a double into a Float32 slot without ever letting NaN or Infinity reach
 * a canvas (CLAUDE.md hard rule). The NaN test comes FIRST because Math.min /
 * Math.max propagate NaN. Overflow saturates rather than becoming Infinity: the
 * float32 range, not the double range, is the real boundary, so exp(700) is
 * finite as a double yet stores as Infinity unless clamped here.
 */
function safe32(v: number): number {
  if (!(v === v)) return 0;
  if (v > F32_MAX) return F32_MAX;
  if (v < -F32_MAX) return -F32_MAX;
  return v;
}

/** Per-sample time factor cache. Consecutive traces in a record share the same
 *  geometry and parameters, so the pow/exp loop runs ONCE per record, not once
 *  per trace. Keyed on everything the table depends on. */
let cacheKey = '';
let cacheTab: Float64Array | null = null;

/**
 * The combined tpow * epow factor per SAMPLE INDEX, for time `t = t0Sec + i*dtSec`.
 * tpow and epow are independent multiplies so they commute and fold into one
 * table; that halves the per-sample work in the hot loop.
 *
 * t = 0: SU sets the first factor to 0 - `tpowfac[0] = (tmin == 0.0) ? 0.0 :
 * pow(tmin, tpow);` - guarding pow(0, negative) = Inf. We match that exactly.
 * DIVERGENCE, deliberate: we extend the rule to t < 0 as well (possible with a
 * negative delay-recording time), because pow(negative, fractional) is NaN in
 * both C and JS and NaN must not reach a canvas. SU's epow factor at t = 0 is
 * exp(epow * 0) = 1, i.e. unchanged, and that is preserved: the zeroing rule
 * applies to the t^etpow term inside the exponent, per SU, not to the result.
 *
 * Returns null when neither stage is active, so the caller can skip the multiply.
 */
export function timeFactors(n: number, dtSec: number, t0Sec: number, tpow: number, epow: number, etpow: number): Float64Array | null {
  if (n <= 0) return null;
  if (tpow === 0 && epow === 0) return null;
  // A missing or nonsensical sample interval means there is no usable time axis.
  // Treat it as no time-dependence rather than throwing or emitting NaN.
  const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;
  const t0 = Number.isFinite(t0Sec) ? t0Sec : 0;
  const key = `${n}|${dt}|${t0}|${tpow}|${epow}|${etpow}`;
  if (key === cacheKey && cacheTab && cacheTab.length === n) return cacheTab;
  const tab = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dt;
    let f = 1;
    if (tpow !== 0) f *= t > 0 ? Math.pow(t, tpow) : 0;
    if (epow !== 0) {
      const te = t > 0 ? Math.pow(t, etpow) : 0;
      const e = Math.exp(epow * te);
      // exp can overflow to Infinity long before the sample multiply; saturating
      // here keeps the whole table finite so the hot loop needs no extra branch.
      f *= e > F32_MAX ? F32_MAX : e;
    }
    tab[i] = Number.isFinite(f) ? f : (f > 0 ? F32_MAX : 0);
  }
  cacheKey = key;
  cacheTab = tab;
  return tab;
}

/**
 * Signed power, SU's form: `(val >= 0) ? pow(val, gpow) : -pow(-val, gpow)`,
 * with SU's sqrt / val*|val| fast paths for gpow 0.5 and 2. Polarity is exact by
 * construction - the sign is carried outside the magnitude, never through pow -
 * which matters because SeisConv decodes and displays polarity from the header.
 * gpow <= 0 is rejected (pow(0, -k) = Inf, and 0 would stop mapping to 0), as is
 * a non-finite gpow; both fall back to identity.
 */
export function signedPow(x: number, gpow: number): number {
  if (!Number.isFinite(gpow) || gpow <= 0 || gpow === 1) return x;
  if (!Number.isFinite(x)) return 0;
  if (x === 0) return 0;
  if (gpow === 0.5) return x > 0 ? Math.sqrt(x) : -Math.sqrt(-x);
  if (gpow === 2) return x * Math.abs(x);
  return x > 0 ? Math.pow(x, gpow) : -Math.pow(-x, gpow);
}

/**
 * RMS of a trace: sqrt(sum(x^2)/n), SU's `rmsq = sqrt(rmsq / nt)`. Non-finite
 * samples are skipped rather than poisoning the sum. Returns 0 for an empty or
 * all-zero trace, and SU's `if (rmsq)` guard means such a trace is left alone.
 */
export function traceRms(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (Number.isFinite(v)) s += v * v;
  }
  const r = Math.sqrt(s / n);
  return Number.isFinite(r) ? r : 0;
}

/**
 * Apply the gain family to ONE trace, in SU's documented order:
 *   tpow -> epow -> gpow -> pbal -> scale
 *
 * `dtSec` is the sample interval and `t0Sec` the time of sample 0, both in
 * SECONDS, so t is real time and not a sample index. The unit is in the name on
 * purpose: agc.ts next door takes microseconds, and mixing the two would be the
 * same class of defect as mapping by sample number instead of time.
 *
 * Pass `out` to reuse a buffer across traces and avoid a per-trace allocation.
 * Every write goes through safe32, so the output is always finite.
 */
export function applyGain(
  samples: Float32Array,
  dtSec: number,
  t0Sec: number,
  params: GainParams = {},
  out?: Float32Array,
): Float32Array {
  const n = samples.length;
  const dst = out && out.length === n ? out : new Float32Array(n);
  if (!n) return dst;

  const tpow = num(params.tpow, 0);
  const epow = num(params.epow, 0);
  const etpow = num(params.etpow, 1);
  const gpowRaw = num(params.gpow, 1);
  const gpow = Number.isFinite(gpowRaw) && gpowRaw > 0 ? gpowRaw : 1;
  const scale = num(params.scale, 1);
  const tab = timeFactors(n, dtSec, t0Sec, tpow, epow, etpow);
  const doG = gpow !== 1;

  // Stage 1-3 in one pass: time factor, then the signed power.
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    let v = Number.isFinite(s) ? s : 0;   // no-NaN rule outranks strict identity
    if (tab) v *= tab[i];
    if (doG) v = signedPow(v, gpow);
    dst[i] = safe32(v);
  }

  // Stage 4: pbal, on the ALREADY gained trace, exactly where SU puts it.
  let post = scale;
  if (params.pbal) {
    const rms = traceRms(dst);
    if (rms > 0) post /= rms;             // SU's `if (rmsq)` guard
  }
  // Stage 5: scale, folded into the same pass as pbal since both are constants.
  if (post !== 1 && Number.isFinite(post)) {
    for (let i = 0; i < n; i++) dst[i] = safe32(dst[i] * post);
  }
  return dst;
}

/** Identity. The ONLY basis under which an absolute amplitude claim is
 *  defensible, so it stays a named mode rather than "scale = 1". Non-finite
 *  input samples are still zeroed - nothing non-finite may reach a canvas. */
export function gainNone(samples: Float32Array, out?: Float32Array): Float32Array {
  return applyGain(samples, 0, 0, {}, out);
}

/** Constant multiplier. Relative amplitude between traces survives untouched. */
export function gainFixed(samples: Float32Array, scale: number, out?: Float32Array): Float32Array {
  return applyGain(samples, 0, 0, { scale }, out);
}

/** t^tpow - spherical-divergence style correction. Time-varying but identical
 *  for every trace, so a weak channel still reads as weak. */
export function gainTpow(samples: Float32Array, dtSec: number, t0Sec: number, tpow: number, out?: Float32Array): Float32Array {
  return applyGain(samples, dtSec, t0Sec, { tpow }, out);
}

/** exp(epow * t^etpow) - exponential (attenuation) compensation. */
export function gainEpow(samples: Float32Array, dtSec: number, t0Sec: number, epow: number, etpow = 1, out?: Float32Array): Float32Array {
  return applyGain(samples, dtSec, t0Sec, { epow, etpow }, out);
}

/** sign(x) * |x|^gpow. Compresses the dynamic range while preserving polarity
 *  and the ORDERING of amplitudes, so a weak channel stays the weakest. */
export function gainGpow(samples: Float32Array, gpow: number, out?: Float32Array): Float32Array {
  return applyGain(samples, 0, 0, { gpow }, out);
}

/**
 * Trace equalisation: divide by the trace's own RMS (SU `pbal=1`).
 *
 * NOTE for callers: this is NOT the same as the existing "Per trace" scale basis
 * in the section view, which divides by `normFactorPercentile` (the 95th
 * percentile of |x| within the trace, core/render/model.ts:20), nor is it
 * `normAcrossTraces` (model.ts:49), which is a percentile ACROSS per-trace norms
 * for the whole record. Percentile-of-|x| and RMS are different statistics, so
 * nothing is reused here. Like AGC, this mode equalises traces and therefore
 * DESTROYS the amplitude evidence: channels can no longer be compared by
 * brightness, in either direction. It is not a QC mode.
 */
export function gainPbal(samples: Float32Array, out?: Float32Array): Float32Array {
  return applyGain(samples, 0, 0, { pbal: true }, out);
}
