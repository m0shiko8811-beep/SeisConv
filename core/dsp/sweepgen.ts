// seisconv-core / dsp - vibroseis sweep generator + sweep-QC helpers (Sweeps tab).
//
// Pure (no DOM, no deps beyond sibling dsp modules). Generates a vibroseis PILOT
// sweep from a Pelton-style specification and provides the analysis helpers the
// Sweeps tab shares between its Builder and its designed-vs-measured QC panel:
//
//  • generateSweep / generateSweepAtRate - phase-continuous sweep synthesis.
//    s(t) = A(t)·cos(φ(t)),  φ(t) = φ₀ + 2π·∫₀ᵗ f(τ)dτ  (trapezoid-integrated so
//    segmented sweeps are phase-continuous at every join by construction).
//  • Sweep types (NO pseudo-random - deliberately unsupported):
//      linear  - f moves linearly f0→f1.
//      dbhz    - spectral shaping of `slope` dB per Hz: dwell time per Hz
//                ∝ 10^(slope·(f-f0)/10)  (closed-form frequency law below).
//      dboct   - spectral shaping of `slope` dB per octave: dwell ∝ f^p with
//                p = slope·log₂(10)/10.
//      tpower  - Pelton T-power: sweep RATE df/dt ∝ tⁿ (n = `slope`), i.e.
//                f(t) = f0 + (f1-f0)·(t/T)ⁿ⁺¹ - dwells at the start frequency.
//  • Tapers (Pelton types): 'cosine' (half-cosine ramp) and 'blackman'.
//  • klauderAnalysis - autocorrelation (Klauder) wavelet + peak/side-lobe metrics.
//  • thdEstimate - total-harmonic-distortion vs time of a measured sweep whose
//    designed instantaneous frequency is known (windowed-FFT harmonic ratio).
//  • buildSVText / parseSVText - the Pelton SCIO ".SV" sweep-definition table
//    (fixed 2048 samples/s; three fixed-width 7-char columns per CRLF line:
//    sample number int32 · envelope int16 0-32767 ≡ 0-10 V · phase int16 with
//    ±180° ≡ ±32768, i.e. degrees × 65536/360).
//
// Honesty note: the generator's `advisories` are DISPLAY-ONLY guidance echoed
// from vibrator-electronics practice; the vibrator's own limits (hold-down,
// reaction-mass stroke, pump flow) always govern what the machine really does.

import { crossCorrelate } from './correlate';
import { fft, nextPow2 } from './fft';
import { wrapDeg180 } from './hilbert';

export type SweepType = 'linear' | 'dbhz' | 'dboct' | 'tpower';
export type SweepTaperType = 'blackman' | 'cosine';

/** One segment of a (possibly segmented) sweep. Frequencies in Hz, length ms. */
export interface SweepSegment {
  type: SweepType;
  f0: number;
  f1: number;
  lengthMs: number;
  /** Shaping parameter: dbhz → dB/Hz · dboct → dB/octave · tpower → exponent n
   *  (df/dt ∝ tⁿ). Ignored for 'linear'. Defaults per type (defaultSlope). */
  slope?: number;
  /** Per-segment taper overrides (ms). When absent, the FIRST segment inherits
   *  the spec's taperInMs and the LAST inherits taperOutMs; middles get 0. */
  taperInMs?: number;
  taperOutMs?: number;
}

/** Full sweep specification (Pelton-style; the Sweeps tab's Builder form). */
export interface SweepSpec {
  type: SweepType;
  f0: number;                 // start frequency, Hz (0.1-999.9)
  f1: number;                 // end frequency, Hz (0.1-999.9)
  lengthMs: number;           // sweep length, ms (1-65535)
  taperInMs: number;          // start taper, ms
  taperOutMs: number;         // end taper, ms
  taperType: SweepTaperType;
  initialPhaseDeg: number;    // φ₀ (degrees; 180 flips polarity)
  sampleIntervalUs: number;   // pilot rate: 250 | 500 | 1000 | 2000 (default 500)
  amplitude: number;          // 0-1 of full scale
  slope?: number;             // top-level shaping parameter (see SweepSegment)
  segments?: SweepSegment[];  // ≤16; when present, overrides type/f0/f1/lengthMs
}

export const SWEEP_SAMPLE_INTERVALS_US = [250, 500, 1000, 2000] as const;
export const MAX_SWEEP_SEGMENTS = 16;

export const DEFAULT_SWEEP_SPEC: SweepSpec = {
  type: 'linear',
  f0: 8,
  f1: 96,
  lengthMs: 12000,
  taperInMs: 300,
  taperOutMs: 300,
  taperType: 'cosine',
  initialPhaseDeg: 0,
  sampleIntervalUs: 500,
  amplitude: 1,
};

/** Default shaping parameter per sweep type (see SweepSegment.slope). */
export function defaultSlope(type: SweepType): number {
  switch (type) {
    case 'dbhz': return 0.1;   // +0.1 dB per Hz
    case 'dboct': return 3;    // +3 dB per octave
    case 'tpower': return 2;   // df/dt ∝ t²
    default: return 0;
  }
}

export interface SweepMeta {
  nSamples: number;
  sampleIntervalUs: number;
  durationMs: number;
  fMin: number;
  fMax: number;
  nSegments: number;
  /** Display-only physical guidance (never enforced - the vibrator governs). */
  advisories: string[];
}

export interface SweepResult {
  /** The pilot samples: A(t)·cos(φ(t)), peak |amplitude| ≤ spec.amplitude. */
  samples: Float32Array;
  /** Instantaneous (designed) frequency per sample, Hz. */
  freqOfT: Float32Array;
  /** Envelope per sample (taper × amplitude), 0…spec.amplitude. */
  envelope: Float32Array;
  /** UNWRAPPED designed phase per sample, DEGREES, including initialPhaseDeg.
   *  Float64: a long sweep spans ~10⁵ degrees - Float32 can't hold fractions of
   *  a degree at that magnitude (needed by the .SV table + phase QC). */
  phaseDeg: Float64Array;
  meta: SweepMeta;
}

type EffSegment = Required<Omit<SweepSegment, 'slope' | 'taperInMs' | 'taperOutMs'>> & {
  slope: number; taperInMs: number; taperOutMs: number;
};

/** Resolve the spec into 1-16 concrete segments with tapers/slopes filled in. */
function effectiveSegments(spec: SweepSpec): EffSegment[] {
  const raw: SweepSegment[] = spec.segments?.length
    ? spec.segments
    : [{ type: spec.type, f0: spec.f0, f1: spec.f1, lengthMs: spec.lengthMs, slope: spec.slope }];
  const last = raw.length - 1;
  return raw.map((s, i) => ({
    type: s.type,
    f0: s.f0,
    f1: s.f1,
    lengthMs: s.lengthMs,
    slope: s.slope ?? (spec.segments?.length ? defaultSlope(s.type) : (spec.slope ?? defaultSlope(s.type))),
    taperInMs: s.taperInMs ?? (i === 0 ? spec.taperInMs : 0),
    taperOutMs: s.taperOutMs ?? (i === last ? spec.taperOutMs : 0),
  }));
}

const FREQ_MIN = 0.1;
const FREQ_MAX = 999.9;

/** Validate a spec → array of human-readable problems ([] = valid). `forRateHz`
 *  overrides the Nyquist check's rate (the fixed-rate .SV path); by default the
 *  spec's own sampleIntervalUs is checked against the allowed set + Nyquist. */
export function validateSweepSpec(spec: SweepSpec, forRateHz?: number): string[] {
  const errs: string[] = [];
  const segs = spec.segments?.length ? spec.segments : null;
  if (segs && segs.length > MAX_SWEEP_SEGMENTS) {
    errs.push(`too many segments (${segs.length}); the Pelton model allows at most ${MAX_SWEEP_SEGMENTS}`);
  }
  const checkFreq = (f: number, what: string) => {
    if (!Number.isFinite(f) || f < FREQ_MIN || f > FREQ_MAX) {
      errs.push(`${what} must be ${FREQ_MIN}-${FREQ_MAX} Hz (got ${f})`);
    }
  };
  const checkSeg = (s: SweepSegment, label: string) => {
    checkFreq(s.f0, `${label} start frequency`);
    checkFreq(s.f1, `${label} end frequency`);
    if (!Number.isFinite(s.lengthMs) || s.lengthMs < 1) errs.push(`${label} length must be ≥ 1 ms`);
    const ti = s.taperInMs ?? 0;
    const to = s.taperOutMs ?? 0;
    if (ti < 0 || to < 0) errs.push(`${label} tapers must be ≥ 0 ms`);
    else if (Number.isFinite(s.lengthMs) && ti + to > s.lengthMs) {
      errs.push(`${label} tapers (${ti}+${to} ms) exceed its length (${s.lengthMs} ms)`);
    }
    const sl = s.slope;
    if (sl != null && Number.isFinite(sl)) {
      if (s.type === 'dbhz' && Math.abs(sl) > 10) errs.push(`${label} dB/Hz slope must be within ±10 (got ${sl})`);
      if (s.type === 'dboct' && Math.abs(sl) > 24) errs.push(`${label} dB/octave slope must be within ±24 (got ${sl})`);
      if (s.type === 'tpower' && (sl < 0 || sl > 10)) errs.push(`${label} T-power exponent must be 0-10 (got ${sl})`);
    } else if (sl != null) {
      errs.push(`${label} shaping parameter is not a number`);
    }
  };
  if (segs) {
    segs.forEach((s, i) => checkSeg(s, `segment ${i + 1}`));
    const total = segs.reduce((a, s) => a + (Number.isFinite(s.lengthMs) ? s.lengthMs : 0), 0);
    if (total > 65535) errs.push(`total sweep length ${Math.round(total)} ms exceeds 65535 ms`);
  } else {
    checkSeg({ type: spec.type, f0: spec.f0, f1: spec.f1, lengthMs: spec.lengthMs, slope: spec.slope, taperInMs: spec.taperInMs, taperOutMs: spec.taperOutMs }, 'sweep');
    if (Number.isFinite(spec.lengthMs) && spec.lengthMs > 65535) errs.push(`sweep length ${spec.lengthMs} ms exceeds 65535 ms`);
  }
  if (!(spec.amplitude > 0 && spec.amplitude <= 1)) errs.push(`amplitude must be in (0, 1] (got ${spec.amplitude})`);
  if (!Number.isFinite(spec.initialPhaseDeg)) errs.push('initial phase must be a number (degrees)');
  // Rate + Nyquist: the highest designed frequency must be representable.
  let rate = forRateHz;
  if (rate == null) {
    if (!(SWEEP_SAMPLE_INTERVALS_US as readonly number[]).includes(spec.sampleIntervalUs)) {
      errs.push(`pilot sample interval must be one of ${SWEEP_SAMPLE_INTERVALS_US.join('/')} µs (got ${spec.sampleIntervalUs})`);
      rate = undefined;
    } else {
      rate = 1e6 / spec.sampleIntervalUs;
    }
  }
  if (rate) {
    const nyq = rate / 2;
    const all = segs ?? [{ f0: spec.f0, f1: spec.f1 } as SweepSegment];
    const fMax = Math.max(...all.map((s) => Math.max(s.f0, s.f1)));
    if (Number.isFinite(fMax) && fMax > nyq) {
      errs.push(`highest sweep frequency ${fMax} Hz exceeds Nyquist ${nyq} Hz at this sample interval - pick a finer interval`);
    }
  }
  return errs;
}

/** Instantaneous frequency (Hz) within `seg` at local time τ (seconds). */
function freqAt(seg: EffSegment, tau: number): number {
  const T = seg.lengthMs / 1000;
  if (tau <= 0) return seg.f0;
  if (tau >= T) return seg.f1;
  const { f0, f1 } = seg;
  const x = tau / T;
  switch (seg.type) {
    case 'dbhz': {
      const beta = (seg.slope * Math.LN10) / 10; // dwell/Hz ∝ e^{β(f-f0)}
      if (Math.abs(beta) < 1e-12 || f0 === f1) return f0 + (f1 - f0) * x;
      const D = Math.expm1(beta * (f1 - f0));
      return f0 + Math.log1p(x * D) / beta;
    }
    case 'dboct': {
      if (Math.abs(seg.slope) < 1e-12 || f0 === f1) return f0 + (f1 - f0) * x;
      const p = (seg.slope * Math.log2(10)) / 10; // dwell/Hz ∝ f^p
      const q = p + 1;
      if (Math.abs(q) < 1e-9) return f0 * Math.pow(f1 / f0, x); // dwell ∝ 1/f
      const A0 = Math.pow(f0, q);
      const A1 = Math.pow(f1, q);
      return Math.pow(A0 + x * (A1 - A0), 1 / q);
    }
    case 'tpower': {
      const n = Math.max(0, seg.slope);
      return f0 + (f1 - f0) * Math.pow(x, n + 1);
    }
    default:
      return f0 + (f1 - f0) * x;
  }
}

/** Taper ramp value for progress x ∈ [0,1] (0 = fully tapered, 1 = full). */
function taperRamp(x: number, type: SweepTaperType): number {
  const c = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return type === 'blackman'
    ? 0.42 - 0.5 * Math.cos(Math.PI * c) + 0.08 * Math.cos(2 * Math.PI * c)
    : 0.5 - 0.5 * Math.cos(Math.PI * c);
}

/** Envelope factor (0…1) within `seg` at local time τ (seconds). */
function envAt(seg: EffSegment, tau: number, taperType: SweepTaperType): number {
  const T = seg.lengthMs / 1000;
  let w = 1;
  const ti = seg.taperInMs / 1000;
  const to = seg.taperOutMs / 1000;
  if (ti > 0 && tau < ti) w *= taperRamp(tau / ti, taperType);
  if (to > 0 && tau > T - to) w *= taperRamp((T - tau) / to, taperType);
  return w < 0 ? 0 : w;
}

/**
 * Generate the sweep at an ARBITRARY sample rate (Hz). Used by generateSweep
 * (pilot rates) and by the fixed-2048-sps .SV table; QC also uses it to render
 * the designed sweep at a measured file's rate. Throws on an invalid spec.
 */
export function generateSweepAtRate(spec: SweepSpec, sampleRateHz: number): SweepResult {
  if (!(sampleRateHz > 0) || !Number.isFinite(sampleRateHz)) {
    throw new Error(`invalid sweep sample rate ${sampleRateHz} Hz`);
  }
  const errs = validateSweepSpec(spec, sampleRateHz);
  if (errs.length) throw new Error('Invalid sweep spec: ' + errs.join(' · '));

  const segs = effectiveSegments(spec);
  const durationMs = segs.reduce((a, s) => a + s.lengthMs, 0);
  // Segment boundaries in ms. Sample times are ALSO computed in ms (k · msPerSample,
  // exact in FP for every supported rate) so boundary comparisons don't drift.
  const startMs: number[] = [];
  const endMs: number[] = [];
  let acc = 0;
  for (const s of segs) { startMs.push(acc); acc += s.lengthMs; endMs.push(acc); }

  const msPerSample = 1000 / sampleRateHz;
  const dt = 1 / sampleRateHz;
  const n = Math.round((durationMs / 1000) * sampleRateHz) + 1; // t = 0 … duration inclusive

  const samples = new Float32Array(n);
  const freqOfT = new Float32Array(n);
  const envelope = new Float32Array(n);
  const phaseDeg = new Float64Array(n);

  let seg = 0;
  let phase = (spec.initialPhaseDeg * Math.PI) / 180; // radians, unwrapped
  let prevF = 0;
  const RAD2DEG = 180 / Math.PI;
  for (let k = 0; k < n; k++) {
    const tMs = k * msPerSample;
    while (seg < segs.length - 1 && tMs >= endMs[seg] - 1e-9) seg++;
    const tau = (tMs - startMs[seg]) / 1000;
    const f = freqAt(segs[seg], tau);
    if (k > 0) phase += Math.PI * (prevF + f) * dt; // 2π · (f₋+f)/2 · dt (trapezoid)
    prevF = f;
    const env = spec.amplitude * envAt(segs[seg], tau, spec.taperType);
    samples[k] = env * Math.cos(phase);
    freqOfT[k] = f;
    envelope[k] = env;
    phaseDeg[k] = phase * RAD2DEG;
  }

  const fMin = Math.min(...segs.map((s) => Math.min(s.f0, s.f1)));
  const fMax = Math.max(...segs.map((s) => Math.max(s.f0, s.f1)));
  const advisories: string[] = [
    'Force setpoint: typical practice runs the fundamental force at 50-80% of the vibrator’s hold-down weight. That is set on the vibrator electronics - this pilot only defines phase and relative envelope.',
  ];
  if (fMin < 10) {
    advisories.push(`Low-frequency end (${fMin} Hz): below ~10 Hz the reaction-mass displacement limit, not the force setpoint, usually caps output - expect reduced fundamental force there.`);
  }
  advisories.push('These advisories are guidance only; the vibrator’s own limits govern.');

  return {
    samples,
    freqOfT,
    envelope,
    phaseDeg,
    meta: {
      nSamples: n,
      sampleIntervalUs: 1e6 / sampleRateHz,
      durationMs,
      fMin,
      fMax,
      nSegments: segs.length,
      advisories,
    },
  };
}

/** Generate the pilot sweep at the spec's own sample interval (µs, from the
 *  allowed {250, 500, 1000, 2000} set - validated). Throws on an invalid spec. */
export function generateSweep(spec: SweepSpec): SweepResult {
  const errs = validateSweepSpec(spec);
  if (errs.length) throw new Error('Invalid sweep spec: ' + errs.join(' · '));
  return generateSweepAtRate(spec, 1e6 / spec.sampleIntervalUs);
}

// -- Klauder (autocorrelation) wavelet ----------------------------------------

export interface KlauderAnalysis {
  /** Lag axis, ms - centred, index of lag 0 in the middle. */
  lagsMs: Float32Array;
  /** Normalized autocorrelation wavelet (peak = 1 at lag 0). */
  wavelet: Float32Array;
  /** 20·log₁₀(peak / largest |side lobe| beyond the first zero crossing), dB.
   *  Capped at 120 dB when no side lobe is measurable. */
  peakSidelobeDb: number;
  /** Main-lobe width: distance between the first zero crossings either side of
   *  lag 0, ms (0 when no crossing is found inside the window). */
  mainLobeMs: number;
}

/**
 * Autocorrelate `pilot` with itself (the Klauder wavelet - what a spike becomes
 * after correlation with this sweep) windowed to ±halfWindowMs, plus the
 * peak/side-lobe metrics resolution QC cares about.
 */
export function klauderAnalysis(pilot: Float32Array, siUs: number, halfWindowMs = 250): KlauderAnalysis {
  const n = pilot.length;
  if (n === 0) {
    return { lagsMs: new Float32Array(0), wavelet: new Float32Array(0), peakSidelobeDb: 0, mainLobeMs: 0 };
  }
  const { corr } = crossCorrelate(pilot, pilot, siUs);
  const zero = n - 1; // centred sequence of length 2n-1; lag 0 in the middle
  const peak = Math.abs(corr[zero]) || 1;
  const half = Math.max(2, Math.min(zero, Math.round((halfWindowMs * 1000) / siUs)));
  const m = 2 * half + 1;
  const wavelet = new Float32Array(m);
  const lagsMs = new Float32Array(m);
  const msPerSample = siUs / 1000;
  for (let i = 0; i < m; i++) {
    wavelet[i] = corr[zero - half + i] / peak;
    lagsMs[i] = (i - half) * msPerSample;
  }
  // First zero crossing to the right of the peak → main-lobe edge.
  let zc = 0;
  for (let i = 1; i <= half; i++) {
    if ((wavelet[half + i - 1] > 0) !== (wavelet[half + i] > 0)) { zc = i; break; }
  }
  const mainLobeMs = zc > 0 ? 2 * zc * msPerSample : 0;
  // Largest |side lobe| beyond the first zero crossing (both sides).
  let side = 0;
  if (zc > 0) {
    for (let i = zc; i <= half; i++) {
      const a = Math.abs(wavelet[half + i]);
      const b = Math.abs(wavelet[half - i]);
      if (a > side) side = a;
      if (b > side) side = b;
    }
  }
  const peakSidelobeDb = side > 0 ? Math.min(120, 20 * Math.log10(1 / side)) : 120;
  return { lagsMs, wavelet, peakSidelobeDb, mainLobeMs };
}

// -- THD (total harmonic distortion) vs time ---------------------------------

export interface ThdSeries {
  /** Window-centre times, ms. */
  timesMs: Float32Array;
  /** THD per window, PERCENT: 100·√(ΣₕAₕ²)/A₁ over harmonics h = 2…maxHarmonic. */
  thdPct: Float32Array;
  avgPct: number;
  maxPct: number;
}

/**
 * Estimate harmonic distortion of a MEASURED sweep against its DESIGNED
 * instantaneous frequency: windowed-FFT amplitude at the fundamental f(t) vs
 * the harmonics 2f…maxHarmonic·f (those below Nyquist). The window widens
 * automatically at low frequencies (≥ 4 fundamental cycles) so the fundamental
 * and 2nd harmonic stay resolvable. Windows with no measurable 2nd harmonic
 * below Nyquist are skipped.
 */
export function thdEstimate(
  measured: Float32Array,
  freqOfT: Float32Array,
  siUs: number,
  opts: { windowMs?: number; maxHarmonic?: number } = {},
): ThdSeries {
  const baseWinMs = opts.windowMs ?? 250;
  const maxH = Math.max(2, opts.maxHarmonic ?? 5);
  const n = Math.min(measured.length, freqOfT.length);
  const empty = { timesMs: new Float32Array(0), thdPct: new Float32Array(0), avgPct: 0, maxPct: 0 };
  if (n < 8 || !(siUs > 0)) return empty;
  const fs = 1e6 / siUs;
  const nyq = fs / 2;
  const msPerSample = siUs / 1000;

  const times: number[] = [];
  const thds: number[] = [];
  const hop = Math.max(1, Math.round((n - 1) / 48)); // ~48 evaluation points
  for (let c = 0; c < n; c += hop) {
    const fc = freqOfT[c];
    if (!(fc > 0.5)) continue;
    if (2 * fc >= nyq * 0.95) continue; // no room for even the 2nd harmonic
    const winSec = Math.max(baseWinMs / 1000, 4 / fc);
    const half = Math.round((winSec * fs) / 2);
    if (c - half < 0 || c + half >= n) continue; // interior windows only
    const m = 2 * half + 1;
    const N = nextPow2(m * 2); // ×2 zero-pad for finer bin interpolation
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < m; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1)); // Hann
      re[i] = measured[c - half + i] * w;
    }
    fft(re, im, false);
    const binHz = fs / N;
    // Peak |X| in a band around f. The chirp smears each line by ~rate·window
    // (scaled by the harmonic number) - cover that plus a few bins, but never
    // half the harmonic spacing so adjacent lines can't be confused.
    const smear = Math.abs(freqOfT[Math.min(n - 1, c + half)] - freqOfT[Math.max(0, c - half)]);
    const ampAt = (f: number, h: number): number => {
      let band = (h * smear) / 2 + Math.max(2 * binHz, 0.05 * fc);
      band = Math.min(band, 0.4 * fc);
      const k0 = Math.max(1, Math.floor((f - band) / binHz));
      const k1 = Math.min((N >> 1) - 1, Math.ceil((f + band) / binHz));
      let best = 0;
      for (let k = k0; k <= k1; k++) {
        const a = Math.hypot(re[k], im[k]);
        if (a > best) best = a;
      }
      return best;
    };
    const A1 = ampAt(fc, 1);
    if (!(A1 > 0)) continue;
    let sum2 = 0;
    for (let h = 2; h <= maxH; h++) {
      const fh = h * fc;
      if (fh >= nyq) break;
      const Ah = ampAt(fh, h);
      sum2 += Ah * Ah;
    }
    times.push(c * msPerSample);
    thds.push((100 * Math.sqrt(sum2)) / A1);
  }
  if (times.length === 0) return empty;
  let sum = 0;
  let max = 0;
  for (const v of thds) { sum += v; if (v > max) max = v; }
  return {
    timesMs: Float32Array.from(times),
    thdPct: Float32Array.from(thds),
    avgPct: sum / thds.length,
    maxPct: max,
  };
}

// -- Pelton SCIO ".SV" sweep-definition table ---------------------------------

/** The SCIO sweep table's fixed sample rate (samples per second). */
export const SV_RATE_HZ = 2048;

const pad7 = (v: number): string => String(v).padStart(7, ' ');

/**
 * Build the SCIO `.SV` sweep-definition text for `spec`: one CRLF line per
 * sample at the fixed 2048 samples/s, three right-justified 7-character
 * columns - sample number (int32, 1-based: sample 1 ↔ t = 0), envelope
 * (int16, 0-32767 ≡ 0-10 V full scale) and phase (int16, degrees × 65536/360,
 * ±180° wrapping to ±32768).
 */
export function buildSVText(spec: SweepSpec): string {
  const r = generateSweepAtRate(spec, SV_RATE_HZ);
  const n = r.meta.nSamples;
  const lines = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const envInt = Math.max(0, Math.min(32767, Math.round(r.envelope[i] * 32767)));
    let phInt = Math.round((wrapDeg180(r.phaseDeg[i]) * 65536) / 360);
    phInt = ((phInt + 32768) & 0xffff) - 32768; // +180° (=+32768) wraps to -32768
    lines[i] = pad7(i + 1) + pad7(envInt) + pad7(phInt);
  }
  return lines.join('\r\n') + '\r\n';
}

export interface ParsedSV {
  /** 1-based sample numbers as read from columns 1-7. */
  sampleNum: Int32Array;
  /** Envelope as a FRACTION of full scale (int16 / 32767 → 0…1 ≡ 0-10 V). */
  envFrac: Float32Array;
  /** Phase in degrees, wrapped to [-180, +180) (int16 × 360/65536). */
  phaseDeg: Float32Array;
}

/** Parse an SCIO `.SV` table (fixed-width columns; blank lines skipped). */
export function parseSVText(text: string): ParsedSV {
  const rows = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const nums = new Int32Array(rows.length);
  const env = new Float32Array(rows.length);
  const ph = new Float32Array(rows.length);
  let n = 0;
  for (const line of rows) {
    const a = parseInt(line.slice(0, 7), 10);
    const b = parseInt(line.slice(7, 14), 10);
    const c = parseInt(line.slice(14, 21), 10);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) continue;
    nums[n] = a;
    env[n] = b / 32767;
    ph[n] = (c * 360) / 65536;
    n++;
  }
  return {
    sampleNum: nums.subarray(0, n),
    envFrac: env.subarray(0, n),
    phaseDeg: ph.subarray(0, n),
  };
}
