// seisconv-core / dsp - Trace-health QC (rebuilt: local baselines + tunable detectors).
//
// Scans every trace of an open shot/line and flags quality problems so a field crew
// can spot bad data fast - built to be RELIABLE, TUNABLE and TRANSPARENT:
//
//   • Every baseline is LOCAL (median + MAD over ±W physical neighbours), never one
//     global number. A gather's normal offset-amplitude decay + moveout therefore
//     don't false-flag a quiet far trace.
//   • Each detector emits a continuous DetectorResult {fired, score, confidence,
//     metric, baseline, reason} - not a bare boolean - so the UI can show "RMS 11×
//     local median, z=9.2σ" and re-threshold WITHOUT re-parsing.
//   • Classification (the threshold compare) is split from evidence computation, so
//     a sensitivity slider re-classifies cached evidence live (classifyTrace), while
//     the expensive evidence (RMS, MAD baselines, spectra, neighbour correlations)
//     is computed once in scanTraceHealth.
//
// Detector families:
//   DEAD     - absolute flat-line (std ≈ 0 vs peak) OR local-relative (gated RMS far
//              below the live-neighbour median), on an early/first-break time-gate so
//              a normal far-offset LATE decay is not "dead".
//   NOISY    - robust MAD z-score of local RMS (amplitude leg, with a ZCR pre-screen)
//              OR a spectral anomaly (dominant-freq / HF-fraction / one-bin 50-60 Hz
//              outlier vs neighbours).
//   AMP      - hot/weak amplitude: an explicit MAD-outlier-vs-neighbours class (both
//              tails) - the catch-all so a real bad trace doesn't slip the narrow families.
//   CLIPPED  - a contiguous at-rail RUN (true clipping) OR an isolated spike vs the
//              trace's own robust amplitude.
//   REVERSED - the weak one done right: a robust MEDIAN neighbour pilot (two disjoint
//              subsets), moveout-aligned by gating each window to its own first break +
//              a bounded best-lag correlation, flagged only on strong, coherent,
//              consistent negativity (so legitimate AVO far-offset reversal is NOT flagged).
//
// Pure - no DOM, no deps beyond sibling dsp modules. Robust + bounded: a normal trace
// flags nothing, empty/garbage input flags nothing and NEVER throws, and trace count +
// per-trace work are capped so a malformed file can't run away. SEG-Y/SEG-D amplitude
// carries no physical unit - every amplitude here is a raw sample value, never a voltage.

import { crossCorrelate } from './correlate';
import { amplitudeSpectrum } from './fft';
import { pickSTALTA } from './firstbreak';
import { clamp01, localMedianMAD, madZScore, median } from './robuststats';

// -- Public model ----------------------------------------------------------------

/** The five detector families. `amp` = hot/weak amplitude (sub-direction in reason). */
export type DetectorId = 'dead' | 'noisy' | 'amp' | 'clipped' | 'reversed';
/** All detector ids, in display/priority order (most actionable first). */
export const DETECTOR_IDS: readonly DetectorId[] = ['reversed', 'clipped', 'noisy', 'amp', 'dead'];

/** Per-detector sensitivity. Low = strict (fewer flags), High = loose (more flags). */
export type Sensitivity = 'low' | 'med' | 'high';

/** One detector's verdict for one trace - continuous, transparent, finite. */
export interface DetectorResult {
  id: DetectorId;
  /** Did this detector fire at the given thresholds? */
  fired: boolean;
  /** 0..1 how strongly the evidence exceeds the firing threshold (for sorting/colour). */
  score: number;
  /** 0..1 trust in the evidence (n, subset agreement, whether it ran) - NOT severity. */
  confidence: number;
  /** Headline measured value behind the flag (amplitude = sample value; z; corr; %…). */
  metric: number;
  /** The LOCAL baseline `metric` is judged against (NaN when not applicable). */
  baseline: number;
  /** Human-readable, carries metric-vs-baseline ("RMS 11× local median, z=9.2σ"). */
  reason: string;
}

/** A flagged trace: every FIRED detector + the worst (dominant) one and its severity. */
export interface TraceFinding {
  /** Position WITHIN the scanned array (the worker remaps to the absolute file index). */
  absIndex: number;
  detectors: DetectorResult[];
  worst: DetectorId;
  /** 0..1 worst-detector severity (how bad), distinct from confidence (how sure). */
  severity: number;
  confidence: number;
}

/** Per-trace evidence - every quantity a detector needs, computed ONCE and cached so
 *  the UI can re-classify live as the sensitivity changes. All finite except
 *  `polarityCoef` which is NaN when polarity was not evaluated for this trace. */
export interface TraceEvidence {
  n: number;            // samples used (0 = empty trace)
  std: number;          // real standard deviation (sample value)
  rms: number;          // full-trace RMS (sample value)
  peak: number;         // peak |amplitude| (sample value)
  rmsGated: number;     // RMS within the early/first-break gate (sample value)
  zcr: number;          // zero-crossing rate (sign changes / sample)
  flatRatio: number;    // std / peak (≈0 ⇒ flat line)
  deadRel: number;      // rmsGated / deadBaseline (live-neighbour median, gated)
  deadBaseline: number; // local median gated-RMS of live neighbours (for the reason text)
  rmsZ: number;         // signed robust MAD z-score of local RMS (amplitude outlier)
  ampBaseline: number;  // local median RMS of live neighbours (for the reason text)
  localN: number;       // live-neighbour count behind the amplitude baseline (confidence)
  specScore: number;    // ≥0 spectral-anomaly score (0 ⇒ not run / clean)
  domFreqHz: number;    // dominant frequency (display)
  hfFrac: number;       // high-frequency energy fraction (display)
  oneBinDom: number;    // single-bin spectral dominance 0..1 (monochromatic indicator)
  clipRunFrac: number;  // longest contiguous at-rail run / n
  spikeScore: number;   // peak / robust within-trace amplitude (isolated-glitch metric)
  polarityCoef: number; // signed worst-subset best-lag corr vs neighbour pilot (NaN = not run)
  polarityConf: number; // 0..1 polarity confidence (contributor count + subset agreement)
  polarityRan: boolean; // was the polarity test evaluated for this trace?
}

/** Tunable firing thresholds - the live-adjustable cutoffs (the neighbour window W and
 *  caps are fixed at scan time). Sensitivity Low/Med/High maps onto these. */
export interface HealthThresholds {
  flatEps: number;     // dead-abs:  flatRatio ≤ flatEps
  deadFrac: number;    // dead-rel:  deadRel < deadFrac
  hotZ: number;        // amp:       rmsZ ≥ hotZ ⇒ hot
  weakZ: number;       // amp:       rmsZ ≤ -weakZ ⇒ weak
  noiseZ: number;      // noisy:     rmsZ ≥ noiseZ (amplitude leg, with ZCR pre-screen)
  specK: number;       // noisy:     specScore ≥ specK (spectral leg)
  zcrAbs: number;      // noisy:     ZCR pre-screen gate for the amplitude leg
  clipRunFrac: number; // clipped:   clipRunFrac ≥ this
  spikeK: number;      // clipped:   spikeScore ≥ this (isolated spike)
  reverseCorr: number; // reversed:  polarityCoef ≤ -reverseCorr
  reverseConf: number; // reversed:  require polarityConf ≥ this
}

/** Honest coverage of a scan - never imply 100%. */
export interface HealthCoverage {
  scanned: number;          // traces actually scanned
  total: number;            // full trace count (filled by the worker)
  stride: number;           // 1-in-k sampling (1 = every trace)
  blocks: number;           // contiguous blocks sampled (adjacency for polarity)
  polarityRan: boolean;     // was polarity evaluated at all?
  polarityScanned: number;  // how many traces got a polarity verdict
}

export interface TraceHealthResult {
  evidence: TraceEvidence[];   // one per SCANNED trace (cached for live re-classification)
  findings: TraceFinding[];    // FLAGGED traces at the supplied thresholds
  coverage: HealthCoverage;
}

/** Scan options - thresholds + the fixed (scan-time) structural parameters. */
export interface TraceHealthOpts {
  thresholds?: Partial<HealthThresholds>;
  sensitivity?: Partial<Record<DetectorId, Sensitivity>>;
  /** Hard cap on traces scanned (the worker also caps + strides). */
  maxTraces?: number;
  /** Half-width (traces) of the local neighbour window for amplitude/dead baselines. */
  localWindow?: number;
  /** Neighbours each side used to build the polarity pilot. */
  neighbors?: number;
  /** Run the polarity (reversed) test at all. */
  polarity?: boolean;
  /** Skip polarity above this scanned-trace count (bounds CPU/memory). */
  polarityMax?: number;
  /** Skip the spectral noisy leg above this scanned-trace count. */
  specMax?: number;
  /** Block sizes (contiguous-adjacency groups) within the scanned array - neighbour
   *  windows never cross a block boundary, so strided block sampling stays physical. */
  blockSizes?: number[];
}

// -- Hard ceilings (defensive, independent of opts) -------------------------------
const HEALTH_MAX_TRACES = 200_000;
const HEALTH_MAX_SAMPLES = 2_000_000;
const SPEC_MAX_FFT = 4096;      // samples fed to the spectral FFT (zero-padded to pow2)
// DEAD time-gate (capture the arrival, exclude the late tail): a window around the
// first break for the live-relative RMS test.
const DEAD_GATE_PRE_MS = 25;
const DEAD_GATE_POST_MS = 220;
const DEAD_GATE_MS = 300;       // default early gate when a trace has no first-break pick
// REVERSED polarity window: a TIGHT window on the first-break wavelet only - wide
// gates let adjacent-trace moveout decorrelate normal neighbours (so a flip can't be
// told from poor coherence). Kept short so normal neighbours correlate strongly +
// a true flip reads strongly negative.
const POL_WIN_PRE_MS = 12;
const POL_WIN_POST_MS = 70;
const POL_MAX_LAG_MS = 8;       // ± lag searched for the polarity correlation
const POL_MIN_CONTRIB = 4;      // minimum live neighbours to run the two-subset polarity test
// HOT/WEAK absolute-ratio guards: a MAD z-score alone explodes where neighbours are
// near-identical (tiny MAD). Require the amplitude ALSO be off by a real ratio so a
// 1.7× trace in a uniform patch isn't called "10σ hot".
const HOT_MIN_RATIO = 2.5;      // rms ≥ this × local median ⇒ eligible for "hot"
const WEAK_MAX_RATIO = 0.4;     // rms ≤ this × local median ⇒ eligible for "weak"
const SPIKE_ISO_FRAC = 0.01;    // a spike must have < this fraction of "large" samples (isolated)

// -- Sensitivity presets ----------------------------------------------------------
// Low = strict (fewer flags), High = permissive (more flags). Conservative defaults.
const SENS: Record<DetectorId, Record<Sensitivity, Partial<HealthThresholds>>> = {
  dead: {
    low: { flatEps: 0.004, deadFrac: 0.04 },
    med: { flatEps: 0.010, deadFrac: 0.08 },
    high: { flatEps: 0.020, deadFrac: 0.15 },
  },
  noisy: {
    low: { noiseZ: 10, specK: 7, zcrAbs: 0.40 },
    med: { noiseZ: 8, specK: 5, zcrAbs: 0.34 },
    high: { noiseZ: 6, specK: 4, zcrAbs: 0.28 },
  },
  amp: {
    low: { hotZ: 9, weakZ: 9 },
    med: { hotZ: 6, weakZ: 6 },
    high: { hotZ: 4, weakZ: 4 },
  },
  clipped: {
    // spikeK is the peak/immediate-neighbour ratio (a single-sample glitch is huge;
    // an impulsive WAVELET peak is only ~1.5-2.5× its neighbours).
    low: { clipRunFrac: 0.05, spikeK: 10 },
    med: { clipRunFrac: 0.03, spikeK: 6 },
    high: { clipRunFrac: 0.015, spikeK: 4 },
  },
  reversed: {
    // Conservative by default: real shallow first-break windows scatter on field data,
    // so a true wiring reversal must read STRONGLY negative against a TRUSTWORTHY
    // (mutually-coherent) neighbour pilot. Low = only the most blatant; High surfaces
    // weaker candidates to review.
    low: { reverseCorr: 0.88, reverseConf: 0.7 },
    med: { reverseCorr: 0.8, reverseConf: 0.6 },
    high: { reverseCorr: 0.68, reverseConf: 0.45 },
  },
};

/** The Med-sensitivity defaults for every threshold (the baseline classification). */
export function defaultThresholds(): HealthThresholds {
  return thresholdsForSensitivity({});
}

/** Build the numeric thresholds from per-detector sensitivity levels (default Med)
 *  plus optional explicit Advanced overrides (`adv` wins). Pure + finite. */
export function thresholdsForSensitivity(
  levels: Partial<Record<DetectorId, Sensitivity>> = {},
  adv: Partial<HealthThresholds> = {},
): HealthThresholds {
  const out: Partial<HealthThresholds> = {};
  for (const id of DETECTOR_IDS) {
    const lvl: Sensitivity = levels[id] ?? 'med';
    Object.assign(out, SENS[id][lvl] ?? SENS[id].med);
  }
  // Advanced numeric overrides take precedence over the sensitivity preset.
  for (const k of Object.keys(adv) as (keyof HealthThresholds)[]) {
    const v = adv[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out as HealthThresholds;
}

// -- Per-trace statistics ---------------------------------------------------------

interface BasicStats {
  rms: number;
  peak: number;
  std: number;
  zcr: number;
  clipRunFrac: number;
  spikeScore: number;
  n: number;
}

/** Amplitude / zero-crossing / clip-run / spike statistics for one trace. Any
 *  non-finite sample is treated as 0 so a poisoned trace can't NaN-propagate. */
function basicStats(samples: Float32Array | null | undefined, clipPeakRatio: number): BasicStats {
  const len = samples ? samples.length : 0;
  if (len === 0) return { rms: 0, peak: 0, std: 0, zcr: 0, clipRunFrac: 0, spikeScore: 0, n: 0 };
  const N = Math.min(len, HEALTH_MAX_SAMPLES);
  const src = samples as Float32Array;
  let sum = 0, sumSq = 0, peak = 0, peakIdx = 0, crossings = 0, prevSign = 0;
  for (let i = 0; i < N; i++) {
    const raw = src[i];
    const v = Number.isFinite(raw) ? raw : 0;
    sum += v; sumSq += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) { peak = a; peakIdx = i; }
    const sign = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (sign !== 0) {
      if (prevSign !== 0 && sign !== prevSign) crossings++;
      prevSign = sign;
    }
  }
  const mean = sum / N;
  const meanSq = sumSq / N;
  const rms = Math.sqrt(Math.max(0, meanSq));
  const std = Math.sqrt(Math.max(0, meanSq - mean * mean));
  const zcr = N > 1 ? crossings / (N - 1) : 0;

  // Longest CONTIGUOUS at-rail run (real clipping = a flat top, not just a busy
  // fraction) + the count of "large" samples (for the spike isolation test).
  let longestRun = 0, largeCount = 0;
  if (peak > 0) {
    const railLevel = clipPeakRatio * peak;
    const halfPeak = 0.5 * peak;
    let run = 0;
    for (let i = 0; i < N; i++) {
      const raw = src[i];
      const a = Number.isFinite(raw) ? (raw < 0 ? -raw : raw) : 0;
      if (a >= railLevel) { run++; if (run > longestRun) longestRun = run; } else run = 0;
      if (a >= halfPeak) largeCount++;
    }
  }
  const clipRunFrac = N > 0 ? longestRun / N : 0;
  // Spike = a single non-physical glitch: the peak sample is ISOLATED (few large
  // samples in the whole trace) AND towers over its IMMEDIATE temporal neighbours.
  // The neighbour ratio is what tells a glitch (neighbours ~0 ⇒ huge ratio) from a
  // real impulsive WAVELET (peak's neighbours are within ~2× ⇒ small ratio), so an
  // impulsive first arrival is no longer mistaken for a spike.
  const largeFrac = N > 0 ? largeCount / N : 1;
  let spikeScore = 0;
  if (peak > 0 && largeFrac < SPIKE_ISO_FRAC && N >= 3) {
    const aL = peakIdx > 0 ? Math.abs(Number.isFinite(src[peakIdx - 1]) ? src[peakIdx - 1] : 0) : 0;
    const aR = peakIdx < N - 1 ? Math.abs(Number.isFinite(src[peakIdx + 1]) ? src[peakIdx + 1] : 0) : 0;
    const nbr = Math.max(aL, aR, peak * 1e-6);
    const r = peak / nbr;
    spikeScore = Number.isFinite(r) ? r : 0;
  }

  return {
    rms: Number.isFinite(rms) ? rms : 0,
    peak: Number.isFinite(peak) ? peak : 0,
    std: Number.isFinite(std) ? std : 0,
    zcr: Number.isFinite(zcr) ? zcr : 0,
    clipRunFrac: Number.isFinite(clipRunFrac) ? clipRunFrac : 0,
    spikeScore: Number.isFinite(spikeScore) ? spikeScore : 0,
    n: N,
  };
}

/** RMS of `samples` over the half-open sample window [g0, g1). Finite-guarded. */
function rmsWindow(samples: Float32Array, g0: number, g1: number): number {
  const lo = Math.max(0, g0 | 0);
  const hi = Math.min(samples.length, g1 | 0);
  if (hi <= lo) return 0;
  let sumSq = 0, k = 0;
  for (let i = lo; i < hi; i++) {
    const v = samples[i];
    if (Number.isFinite(v)) { sumSq += v * v; k++; }
  }
  if (k === 0) return 0;
  const r = Math.sqrt(sumSq / k);
  return Number.isFinite(r) ? r : 0;
}

/** First-break sample index for the time-gate (NaN-safe). Uses a coarse STA/LTA;
 *  returns -1 when there is no confident pick (caller falls back to an early gate). */
function firstBreakSample(samples: Float32Array, siUs: number): number {
  const fbMs = pickSTALTA(samples, siUs, { staMs: 22, ltaMs: 120, threshold: 3.2 });
  if (!Number.isFinite(fbMs) || fbMs < 0) return -1;
  const s = Math.round((fbMs * 1000) / siUs);
  return Number.isFinite(s) && s >= 0 && s < samples.length ? s : -1;
}

// -- Spectral character ------------------------------------------------------------

interface SpecStats { domFreqHz: number; hfFrac: number; oneBinDom: number; }

/** Dominant frequency, high-frequency energy fraction, and single-bin dominance of a
 *  trace (a cheap, robust spectral fingerprint for the noisy detector). Uses the first
 *  SPEC_MAX_FFT samples at the ORIGINAL sample rate (no aliasing downsample). */
function specStats(samples: Float32Array, siUs: number): SpecStats {
  const N = Math.min(samples.length, SPEC_MAX_FFT);
  if (N < 8) return { domFreqHz: 0, hfFrac: 0, oneBinDom: 0 };
  const chunk = samples.length === N ? samples : samples.subarray(0, N);
  const sp = amplitudeSpectrum(chunk, siUs);
  const amp = sp.amp, freqs = sp.freqs, nyq = sp.nyquist;
  let total = 0, hf = 0, maxA = 0, maxK = 1;
  const hfCut = 0.5 * nyq;
  for (let k = 1; k < amp.length; k++) { // skip DC (k=0)
    const a = Number.isFinite(amp[k]) ? amp[k] : 0;
    total += a;
    if (freqs[k] >= hfCut) hf += a;
    if (a > maxA) { maxA = a; maxK = k; }
  }
  if (!(total > 0)) return { domFreqHz: 0, hfFrac: 0, oneBinDom: 0 };
  const domFreqHz = Number.isFinite(freqs[maxK]) ? freqs[maxK] : 0;
  return { domFreqHz, hfFrac: clamp01(hf / total), oneBinDom: clamp01(maxA / total) };
}

// -- Polarity (reversed) helpers ----------------------------------------------------

/** Strongest signed correlation coefficient of `a` vs `b` within ±maxLag samples of
 *  zero lag (a small window - the windows are first-break aligned, so a far negative
 *  side-lobe under moveout can't masquerade as a true reversal). */
function bestSignedCoefNearZero(a: Float32Array, b: Float32Array, siUs: number, maxLagSamples: number): number {
  const cc = crossCorrelate(a, b, siUs);
  if (cc.corr.length === 0) return 0;
  const zeroIdx = b.length - 1; // crossCorrelate centres zero-lag at index (b.length - 1)
  const lag = Math.min(maxLagSamples, cc.corr.length - 1);
  let best = 0, bestAbs = -1;
  for (let k = zeroIdx - lag; k <= zeroIdx + lag; k++) {
    if (k < 0 || k >= cc.corr.length) continue;
    const c = cc.corr[k];
    const av = c < 0 ? -c : c;
    if (av > bestAbs) { bestAbs = av; best = c; }
  }
  return Number.isFinite(best) ? best : 0;
}

/** Sample-wise MEDIAN of unit-RMS-normalized gated windows (a robust pilot immune to
 *  one bad contributor). `wins` all share length L. Empty → an all-zero pilot. */
function medianPilot(wins: Float32Array[], L: number): Float32Array {
  const out = new Float32Array(L);
  if (wins.length === 0) return out;
  const col = new Float64Array(wins.length);
  for (let k = 0; k < L; k++) {
    for (let w = 0; w < wins.length; w++) col[w] = wins[w][k];
    out[k] = median(col);
  }
  return out;
}

/** Unit-RMS-normalized gated window of `samples` starting `preSamp` before the
 *  first-break sample `fbSamp`, length `L`. Sign-preserving (polarity is about shape,
 *  not amplitude). Returns null when the window carries no energy. */
function gatedWindow(samples: Float32Array, fbSamp: number, preSamp: number, L: number): Float32Array | null {
  const start = Math.max(0, (fbSamp < 0 ? 0 : fbSamp) - preSamp);
  const w = new Float32Array(L);
  let sumSq = 0;
  for (let k = 0; k < L; k++) {
    const idx = start + k;
    const v = idx < samples.length ? samples[idx] : 0;
    const f = Number.isFinite(v) ? v : 0;
    w[k] = f; sumSq += f * f;
  }
  const r = Math.sqrt(sumSq / L);
  if (!(r > 0)) return null;
  const inv = 1 / r;
  for (let k = 0; k < L; k++) w[k] *= inv;
  return w;
}

// -- Classification (the live re-thresholding step) ----------------------------------

/** Classify one trace's cached evidence at the given thresholds → every detector's
 *  result + the finding (null when nothing fired). Pure + finite; this is what a
 *  sensitivity-slider move calls, with NO re-parse. */
export function classifyTrace(ev: TraceEvidence, absIndex: number, thr: HealthThresholds): { results: DetectorResult[]; finding: TraceFinding | null } {
  const results: DetectorResult[] = [];

  // DEAD -----------------------------------------------------------------------
  {
    const empty = ev.n === 0;
    const deadAbs = !empty && ev.peak > 0 && ev.flatRatio <= thr.flatEps;
    const deadRelFired = !empty && Number.isFinite(ev.deadRel) && ev.deadRel >= 0 && ev.deadBaseline > 0 && ev.deadRel < thr.deadFrac;
    const fired = empty || deadAbs || deadRelFired;
    const sev = clamp01(Math.max(
      thr.flatEps > 0 && ev.peak > 0 ? 1 - ev.flatRatio / thr.flatEps : 0,
      thr.deadFrac > 0 && ev.deadBaseline > 0 ? 1 - ev.deadRel / thr.deadFrac : 0,
      empty ? 1 : 0,
    ));
    const reason = empty
      ? 'all-zero / no samples'
      : deadAbs
        ? `flat line (std/peak ${fmt(ev.flatRatio, 4)} ≤ ${fmt(thr.flatEps, 3)})`
        : `gated RMS ${fmt(ev.rmsGated, 3)} = ${fmt(ev.deadRel, 2)}× live-neighbour median ${fmt(ev.deadBaseline, 3)} (< ${fmt(thr.deadFrac, 2)}×)`;
    const conf = empty ? 1 : clamp01((ev.deadBaseline > 0 ? 0.6 : 0.4) + 0.4 * Math.min(1, ev.n / 400));
    const dead: DetectorResult = { id: 'dead', fired, score: fired ? sev : 0, confidence: conf, metric: ev.rmsGated, baseline: ev.deadBaseline, reason };
    results.push(dead);
    // A dead/flat trace carries no signal, so its amplitude / spectral / polarity
    // metrics are meaningless - report ONLY "dead" rather than piling on weak/noisy/etc.
    if (fired) return { results, finding: { absIndex, detectors: [dead], worst: 'dead', severity: clamp01(dead.score), confidence: clamp01(dead.confidence) } };
  }

  // NOISY ----------------------------------------------------------------------
  {
    const ampLeg = ev.rmsZ >= thr.noiseZ && ev.zcr >= thr.zcrAbs;
    const specLeg = ev.specScore >= thr.specK;
    const fired = ev.n > 0 && (ampLeg || specLeg);
    const sev = clamp01(Math.max(
      ampLeg && thr.noiseZ > 0 ? (ev.rmsZ - thr.noiseZ) / thr.noiseZ : 0,
      specLeg && thr.specK > 0 ? (ev.specScore - thr.specK) / thr.specK : 0,
    ));
    const reason = specLeg
      ? `spectral anomaly (dom ${fmt(ev.domFreqHz, 1)} Hz, HF ${fmt(ev.hfFrac * 100, 0)}%, one-bin ${fmt(ev.oneBinDom * 100, 0)}%, score ${fmt(ev.specScore, 1)})`
      : `high-frequency energy (z=${fmt(ev.rmsZ, 1)}σ, ZCR ${fmt(ev.zcr, 3)})`;
    const conf = clamp01((ampLeg && specLeg ? 0.85 : 0.55) + 0.25 * Math.min(1, ev.localN / 8));
    results.push({ id: 'noisy', fired, score: fired ? sev : 0, confidence: conf, metric: specLeg ? ev.specScore : ev.rmsZ, baseline: thr.specK, reason });
  }

  // AMP (hot / weak) -------------------------------------------------------------
  {
    // Require BOTH a MAD z-score AND a real amplitude ratio, so a tiny-MAD patch can't
    // inflate a 1.7× trace into a "10σ" false alarm.
    const ratio = ev.ampBaseline > 0 ? ev.rms / ev.ampBaseline : (ev.rms > 0 ? Infinity : 1);
    const hot = ev.n > 0 && ev.rmsZ >= thr.hotZ && ratio >= HOT_MIN_RATIO;
    const weak = ev.n > 0 && ev.ampBaseline > 0 && ev.rmsZ <= -thr.weakZ && ratio <= WEAK_MAX_RATIO;
    const fired = hot || weak;
    const thrUsed = hot ? thr.hotZ : thr.weakZ;
    const sev = clamp01(thrUsed > 0 ? (Math.abs(ev.rmsZ) - thrUsed) / thrUsed : 0);
    const reason = hot
      ? `hot - RMS ${fmt(ev.rms, 3)} ≫ local median ${fmt(ev.ampBaseline, 3)} (z=+${fmt(ev.rmsZ, 1)}σ)`
      : `weak - RMS ${fmt(ev.rms, 3)} ≪ local median ${fmt(ev.ampBaseline, 3)} (z=${fmt(ev.rmsZ, 1)}σ)`;
    const conf = clamp01((Number.isFinite(ev.rmsZ) ? 0.45 : 0.2) + 0.45 * Math.min(1, ev.localN / 8));
    results.push({ id: 'amp', fired, score: fired ? sev : 0, confidence: conf, metric: ev.rms, baseline: ev.ampBaseline, reason });
  }

  // CLIPPED / SPIKY --------------------------------------------------------------
  {
    const railed = ev.n > 0 && ev.peak > 0 && ev.clipRunFrac >= thr.clipRunFrac;
    const spiky = ev.n > 0 && ev.spikeScore >= thr.spikeK;
    const fired = railed || spiky;
    const sev = clamp01(Math.max(
      railed ? ev.clipRunFrac / Math.max(1e-6, 2 * thr.clipRunFrac) : 0,
      spiky && thr.spikeK > 0 ? (ev.spikeScore - thr.spikeK) / thr.spikeK : 0,
    ));
    const reason = railed
      ? `clipped - contiguous at-rail run ${fmt(ev.clipRunFrac * 100, 1)}% of trace`
      : `spike - peak ${fmt(ev.spikeScore, 0)}× the trace's robust amplitude`;
    const conf = railed ? 0.85 : clamp01(thr.spikeK > 0 ? 0.4 + 0.4 * Math.min(1, ev.spikeScore / (2 * thr.spikeK)) : 0.5);
    results.push({ id: 'clipped', fired, score: fired ? sev : 0, confidence: conf, metric: railed ? ev.clipRunFrac * 100 : ev.spikeScore, baseline: railed ? thr.clipRunFrac * 100 : thr.spikeK, reason });
  }

  // REVERSED POLARITY -------------------------------------------------------------
  {
    const ran = ev.polarityRan && Number.isFinite(ev.polarityCoef);
    const fired = ran && ev.polarityCoef <= -thr.reverseCorr && ev.polarityConf >= thr.reverseConf;
    const sev = clamp01(ran ? (-ev.polarityCoef - thr.reverseCorr) / Math.max(1e-6, 1 - thr.reverseCorr) : 0);
    const reason = !ran
      ? 'polarity not evaluated (no adjacent-neighbour pilot)'
      : `flipped vs neighbour pilot - corr ${fmt(ev.polarityCoef, 2)} (both subsets), confidence ${fmt(ev.polarityConf, 2)}`;
    results.push({ id: 'reversed', fired, score: fired ? sev : 0, confidence: clamp01(ev.polarityConf), metric: ev.polarityCoef, baseline: -thr.reverseCorr, reason });
  }

  // Build the finding from the fired detectors (worst = highest severity, priority tie-break).
  const fired = results.filter((r) => r.fired);
  if (fired.length === 0) return { results, finding: null };
  let worst = fired[0];
  for (const r of fired) {
    if (r.score > worst.score + 1e-9) worst = r;
    else if (Math.abs(r.score - worst.score) <= 1e-9 && DETECTOR_IDS.indexOf(r.id) < DETECTOR_IDS.indexOf(worst.id)) worst = r;
  }
  return {
    results,
    finding: { absIndex, detectors: fired, worst: worst.id, severity: clamp01(worst.score), confidence: clamp01(worst.confidence) },
  };
}

/** Compact finite-safe number formatter for reason strings. */
function fmt(v: number, dp: number): string {
  if (!Number.isFinite(v)) return '-';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(Math.min(dp, 3));
  return v.toFixed(dp);
}

// -- The scan: compute evidence once, classify with the supplied thresholds ----------

/**
 * Scan an array of traces for quality problems. `traces[i]` is whatever the worker
 * handed in (already the scanned/strided subset, with `blockSizes` marking contiguous
 * groups). `absIndex` in each evidence/finding is the position WITHIN that array - the
 * worker remaps it to the absolute file trace index. Never throws; a normal trace
 * flags nothing.
 */
export function scanTraceHealth(
  traces: ArrayLike<Float32Array | null | undefined>,
  sampleIntUs: number,
  opts: TraceHealthOpts = {},
): TraceHealthResult {
  const count = Math.min(
    traces ? traces.length : 0,
    HEALTH_MAX_TRACES,
    opts.maxTraces && opts.maxTraces > 0 ? Math.floor(opts.maxTraces) : HEALTH_MAX_TRACES,
  );
  const siUs = Number.isFinite(sampleIntUs) && sampleIntUs > 0 ? sampleIntUs : 2000;
  const thr = thresholdsForSensitivity(opts.sensitivity ?? {}, opts.thresholds ?? {});
  const emptyCov: HealthCoverage = { scanned: 0, total: 0, stride: 1, blocks: 0, polarityRan: false, polarityScanned: 0 };
  if (count <= 0) return { evidence: [], findings: [], coverage: emptyCov };

  const localWindow = clampInt(opts.localWindow, 1, 64, 6);
  const neighbors = clampInt(opts.neighbors, 1, 64, 8);
  const polarityMax = opts.polarityMax && opts.polarityMax > 0 ? Math.floor(opts.polarityMax) : 8000;
  const specMax = opts.specMax && opts.specMax > 0 ? Math.floor(opts.specMax) : 8000;
  const doPolarity = (opts.polarity ?? true) && count <= polarityMax;
  const doSpec = count <= specMax;
  const clipPeakRatio = 0.985;

  // Block membership: neighbour windows never cross a contiguous-block boundary.
  const blockStart = new Int32Array(count);
  const blockEnd = new Int32Array(count); // inclusive
  let blocks = 0;
  {
    const sizes = opts.blockSizes && opts.blockSizes.length ? opts.blockSizes : [count];
    let i = 0;
    for (const raw of sizes) {
      const sz = Math.max(0, Math.min(count - i, Math.floor(raw)));
      if (sz <= 0) continue;
      for (let j = i; j < i + sz; j++) { blockStart[j] = i; blockEnd[j] = i + sz - 1; }
      i += sz; blocks++;
      if (i >= count) break;
    }
    if (i < count) { for (let j = i; j < count; j++) { blockStart[j] = i; blockEnd[j] = count - 1; } blocks++; }
  }

  // -- Pass 1: per-trace basic stats + gated RMS + first-break sample + spectra --
  const stats: BasicStats[] = new Array(count);
  const rms = new Float64Array(count);
  const rmsGated = new Float64Array(count);
  const fbSamp = new Int32Array(count);
  const domFreq = new Float64Array(count);
  const hfFrac = new Float64Array(count);
  const oneBin = new Float64Array(count);
  const live = new Uint8Array(count); // a usable (non-empty, non-flat) trace
  const deadPre = Math.max(1, Math.round((DEAD_GATE_PRE_MS * 1000) / siUs));
  const deadPost = Math.max(2, Math.round((DEAD_GATE_POST_MS * 1000) / siUs));
  const defGateSamp = Math.max(2, Math.round((DEAD_GATE_MS * 1000) / siUs));
  for (let i = 0; i < count; i++) {
    const s = traces[i] ?? null;
    const st = basicStats(s, clipPeakRatio);
    stats[i] = st;
    rms[i] = st.rms;
    const isLive = st.n > 0 && st.std > 0 && st.peak > 0;
    live[i] = isLive ? 1 : 0;
    if (s && st.n > 0) {
      const fb = firstBreakSample(s, siUs);
      fbSamp[i] = fb;
      const g0 = fb >= 0 ? Math.max(0, fb - deadPre) : 0;
      const g1 = fb >= 0 ? Math.min(st.n, fb + deadPost) : Math.min(st.n, defGateSamp);
      rmsGated[i] = rmsWindow(s, g0, g1);
      if (doSpec && isLive) { const sp = specStats(s, siUs); domFreq[i] = sp.domFreqHz; hfFrac[i] = sp.hfFrac; oneBin[i] = sp.oneBinDom; }
    } else { fbSamp[i] = -1; rmsGated[i] = 0; }
  }

  // Robust survey-wide RMS floor (for the live predicate + a fallback baseline scale).
  const liveRms: number[] = [];
  for (let i = 0; i < count; i++) if (live[i]) liveRms.push(rms[i]);
  const medianRms = median(liveRms);
  const deadFloorRms = medianRms > 0 ? medianRms * 1e-3 : 0;

  // -- Pass 2: local baselines (amplitude z + dead-relative + spectral z) --
  const evidence: TraceEvidence[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const st = stats[i];
    const bs = blockStart[i], be = blockEnd[i];
    // Amplitude baseline: live neighbours' RMS (exclude self, clamp to block).
    const amp = localMedianMAD(rms, i, localWindow, {
      excludeSelf: true, lo: bs, hi: be,
      keep: (_v, j) => live[j] === 1,
      fallbackMed: medianRms,
    });
    const ampFloor = medianRms > 0 ? medianRms * 0.05 : 0;
    const rmsZ = amp.n > 0 ? madZScore(rms[i], amp.median, amp.mad, ampFloor) : 0;
    // Dead-relative baseline: live neighbours' GATED RMS.
    const deadBase = localMedianMAD(rmsGated as unknown as ArrayLike<number>, i, localWindow, {
      excludeSelf: true, lo: bs, hi: be,
      keep: (_v, j) => live[j] === 1,
      fallbackMed: 0,
    });
    const deadRel = deadBase.n >= 3 && deadBase.median > 0 ? rmsGated[i] / deadBase.median : NaN;
    // Spectral anomaly score - deliberately CONSERVATIVE (spectra vary legitimately
    // with offset, so a generic dominant-frequency outlier is NOT evidence of noise).
    // Two specific noise signatures only:
    //   • broadband HF noise: a HIGH absolute high-frequency fraction AND an upper-tail
    //     MAD-outlier vs neighbours;
    //   • monochromatic mains: a sharp single bin near 50/60 Hz (power-line hum).
    let specScore = 0;
    if (doSpec && live[i]) {
      const hfB = localMedianMAD(hfFrac as unknown as ArrayLike<number>, i, localWindow, { excludeSelf: true, lo: bs, hi: be, keep: (_v, j) => live[j] === 1 });
      const zHf = hfB.n >= 3 ? Math.max(0, madZScore(hfFrac[i], hfB.median, hfB.mad, 0.03)) : 0;
      const hfLeg = hfFrac[i] >= 0.35 ? zHf : 0; // only when the absolute HF energy is high
      const f = domFreq[i];
      const nearMains = Math.abs(f - 50) <= 2 || Math.abs(f - 60) <= 2;
      const mainsLeg = nearMains && oneBin[i] >= 0.45 ? 8 + 6 * oneBin[i] : 0;
      specScore = Math.max(hfLeg, mainsLeg);
    }
    const peak = st.peak;
    evidence[i] = {
      n: st.n,
      std: st.std,
      rms: st.rms,
      peak,
      rmsGated: rmsGated[i],
      zcr: st.zcr,
      flatRatio: peak > 0 ? st.std / peak : (st.n === 0 ? 0 : 1),
      deadRel: Number.isFinite(deadRel) ? deadRel : NaN,
      deadBaseline: deadBase.median,
      rmsZ: Number.isFinite(rmsZ) ? rmsZ : 0,
      ampBaseline: amp.median,
      localN: amp.n,
      specScore: Number.isFinite(specScore) ? specScore : 0,
      domFreqHz: domFreq[i],
      hfFrac: hfFrac[i],
      oneBinDom: oneBin[i],
      clipRunFrac: st.clipRunFrac,
      spikeScore: st.spikeScore,
      polarityCoef: NaN,
      polarityConf: 0,
      polarityRan: false,
    };
  }

  // -- Pass 3 (optional): polarity via a robust two-subset median neighbour pilot --
  let polarityScanned = 0;
  if (doPolarity) {
    const polPre = Math.max(1, Math.round((POL_WIN_PRE_MS * 1000) / siUs));
    const polPost = Math.max(2, Math.round((POL_WIN_POST_MS * 1000) / siUs));
    const L = Math.max(2, polPre + polPost);
    // Pre-build each LIVE trace's first-break-aligned, unit-RMS gated window (tight on
    // the first-break wavelet so normal neighbours stay coherent + a flip reads strong).
    // EXCLUDE spiky traces: a glitch corrupts the STA/LTA pick + dominates the window,
    // so they neither get a polarity verdict nor pollute a neighbour's pilot.
    const gw: (Float32Array | null)[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const s = traces[i];
      const eligible = !!s && live[i] === 1 && evidence[i].spikeScore < 8;
      gw[i] = eligible ? gatedWindow(s as Float32Array, fbSamp[i], polPre, L) : null;
    }
    const maxLag = Math.max(1, Math.round((POL_MAX_LAG_MS * 1000) / siUs));
    for (let i = 0; i < count; i++) {
      const wi = gw[i];
      if (!wi) continue;
      const bs = blockStart[i], be = blockEnd[i];
      // Gather live neighbours into one full pilot + two interleaved disjoint subsets.
      const all: Float32Array[] = [], subA: Float32Array[] = [], subB: Float32Array[] = [];
      let toggle = 0, contributors = 0;
      const lo = Math.max(bs, i - neighbors), hi = Math.min(be, i + neighbors);
      for (let j = lo; j <= hi; j++) {
        if (j === i) continue;
        const wj = gw[j];
        if (!wj) continue;
        all.push(wj);
        (toggle === 0 ? subA : subB).push(wj);
        toggle ^= 1; contributors++;
      }
      if (contributors < POL_MIN_CONTRIB || subA.length < 2 || subB.length < 2) continue;
      // The METRIC is the signed correlation against the FULL median pilot - SYMMETRIC
      // under a flip (flipping trace i exactly negates it), so a fully-wired-backwards
      // trace reads the negative of a normal one (no max/min asymmetry to hide it).
      const pilot = medianPilot(all, L);
      const coef = bestSignedCoefNearZero(wi, pilot, siUs, maxLag);
      // CONFIDENCE = is the PILOT trustworthy? The neighbours must be mutually coherent
      // (agree with the pilot) before a lone negative trace can be called "reversed".
      // Where the neighbourhood itself is incoherent (a processed image, near-surface
      // chaos, mispicks) the neighbours DON'T agree → low confidence → no flag, no
      // matter how negative |coef| is. That is what stops the false-alarm storm.
      const cohVals: number[] = [];
      for (const wj of all) cohVals.push(bestSignedCoefNearZero(wj, pilot, siUs, maxLag));
      const coherence = clamp01(median(cohVals)); // high+positive ⇒ neighbours agree
      // Plus the two-subset sign-agreement gate: the reversal must read the SAME strong
      // sign against two disjoint neighbour subsets (not a one-sided fluke).
      const coefA = bestSignedCoefNearZero(wi, medianPilot(subA, L), siUs, maxLag);
      const coefB = bestSignedCoefNearZero(wi, medianPilot(subB, L), siUs, maxLag);
      const sameStrongSign = Math.sign(coefA) === Math.sign(coefB) && Math.abs(coefA) >= 0.3 && Math.abs(coefB) >= 0.3;
      const conf = clamp01(Math.min(1, contributors / 8) * coherence * (sameStrongSign ? 1 : 0.3));
      evidence[i].polarityCoef = Number.isFinite(coef) ? coef : NaN;
      evidence[i].polarityConf = conf;
      evidence[i].polarityRan = true;
      polarityScanned++;
    }
  }

  // -- Classify with the supplied thresholds --
  const findings: TraceFinding[] = [];
  for (let i = 0; i < count; i++) {
    const { finding } = classifyTrace(evidence[i], i, thr);
    if (finding) findings.push(finding);
  }

  return {
    evidence,
    findings,
    coverage: {
      scanned: count, total: count, stride: 1, blocks,
      polarityRan: doPolarity && polarityScanned > 0, polarityScanned,
    },
  };
}

function clampInt(v: number | undefined, lo: number, hi: number, def: number): number {
  if (!Number.isFinite(v as number) || !((v as number) > 0)) return def;
  return Math.max(lo, Math.min(hi, Math.floor(v as number)));
}

// -- Flat (struct-of-arrays) evidence transport --------------------------------------
// The worker packs TraceEvidence into one Float32 buffer (+ small index arrays) and
// the renderer unpacks it to re-classify live. EVIDENCE_FIELDS fixes the column order
// so both ends stay in sync - change it in ONE place.
export const EVIDENCE_FIELDS = [
  'n', 'std', 'rms', 'peak', 'rmsGated', 'zcr',
  'flatRatio', 'deadRel', 'deadBaseline',
  'rmsZ', 'ampBaseline', 'localN',
  'specScore', 'domFreqHz', 'hfFrac', 'oneBinDom',
  'clipRunFrac', 'spikeScore',
  'polarityCoef', 'polarityConf', 'polarityRan',
] as const;
export const EVIDENCE_STRIDE = EVIDENCE_FIELDS.length;

/** Write one trace's evidence into the flat buffer at row `i`. NaN polarityCoef is
 *  preserved (Float32 NaN survives the transfer); polarityRan is 1/0. */
export function writeEvidence(flat: Float32Array, i: number, ev: TraceEvidence): void {
  const b = i * EVIDENCE_STRIDE;
  flat[b + 0] = ev.n;
  flat[b + 1] = ev.std;
  flat[b + 2] = ev.rms;
  flat[b + 3] = ev.peak;
  flat[b + 4] = ev.rmsGated;
  flat[b + 5] = ev.zcr;
  flat[b + 6] = ev.flatRatio;
  flat[b + 7] = ev.deadRel;
  flat[b + 8] = ev.deadBaseline;
  flat[b + 9] = ev.rmsZ;
  flat[b + 10] = ev.ampBaseline;
  flat[b + 11] = ev.localN;
  flat[b + 12] = ev.specScore;
  flat[b + 13] = ev.domFreqHz;
  flat[b + 14] = ev.hfFrac;
  flat[b + 15] = ev.oneBinDom;
  flat[b + 16] = ev.clipRunFrac;
  flat[b + 17] = ev.spikeScore;
  flat[b + 18] = ev.polarityCoef;
  flat[b + 19] = ev.polarityConf;
  flat[b + 20] = ev.polarityRan ? 1 : 0;
}

/** Read one trace's evidence back out of the flat buffer at row `i`. */
export function readEvidence(flat: Float32Array, i: number): TraceEvidence {
  const b = i * EVIDENCE_STRIDE;
  return {
    n: flat[b + 0],
    std: flat[b + 1],
    rms: flat[b + 2],
    peak: flat[b + 3],
    rmsGated: flat[b + 4],
    zcr: flat[b + 5],
    flatRatio: flat[b + 6],
    deadRel: flat[b + 7],
    deadBaseline: flat[b + 8],
    rmsZ: flat[b + 9],
    ampBaseline: flat[b + 10],
    localN: flat[b + 11],
    specScore: flat[b + 12],
    domFreqHz: flat[b + 13],
    hfFrac: flat[b + 14],
    oneBinDom: flat[b + 15],
    clipRunFrac: flat[b + 16],
    spikeScore: flat[b + 17],
    polarityCoef: flat[b + 18],
    polarityConf: flat[b + 19],
    polarityRan: flat[b + 20] >= 0.5,
  };
}
