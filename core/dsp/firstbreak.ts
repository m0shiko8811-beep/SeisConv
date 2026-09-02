// seisconv-core / dsp - First-break picking (STA/LTA).
//
// Classic short-term-average / long-term-average energy-ratio onset detector,
// used for refraction first breaks / near-surface QC. For each trace it builds an
// energy characteristic function (amplitude²), then scans a trailing short window
// against a trailing long window; the first sample where STA/LTA crosses
// `threshold` (within the optional [minTimeMs, maxTimeMs] gate) is the pick.
//
// Pure - no DOM, no deps. Bounded (per-trace sample cap) and finite-guarded; a
// flat/zero/empty trace yields no pick (NaN) and the picker NEVER throws.

/** STA/LTA picker parameters. Windows are in milliseconds; the picker converts
 *  them to samples with the trace's sample interval. */
export interface STALTAOpts {
  /** Short-term-average window length (ms). */
  staMs: number;
  /** Long-term-average window length (ms); should exceed staMs. */
  ltaMs: number;
  /** Trigger ratio - the first sample where STA/LTA ≥ threshold is the pick. */
  threshold: number;
  /** Latest accepted pick time (ms); ≤0 / omitted = scan to the trace end. */
  maxTimeMs?: number;
  /** Earliest accepted pick time (ms); gates out an early mute / DC start. ≤0 /
   *  omitted = no early gate. */
  minTimeMs?: number;
}

/** Per-trace scan cap - bound the prefix-sum allocation + loop regardless of a
 *  (malformed) over-long trace. 2M samples ≈ 16 MB of Float64 prefix sums. */
export const FB_MAX_SAMPLES = 2_000_000;

/**
 * Pick the first-break time (ms) of a single trace via STA/LTA. Returns `NaN`
 * when there is no confident pick (flat/zero trace, too few samples, the ratio
 * never crosses `threshold` inside the gate) or when any input is non-finite -
 * callers must treat NaN as "no pick". Never throws.
 */
export function pickSTALTA(
  samples: Float32Array | null | undefined,
  sampleIntUs: number,
  opts: STALTAOpts,
): number {
  const n = samples ? samples.length : 0;
  if (n < 2 || !(sampleIntUs > 0)) return NaN;
  const { staMs, ltaMs, threshold } = opts;
  if (!Number.isFinite(staMs) || !Number.isFinite(ltaMs) || !Number.isFinite(threshold)) return NaN;
  if (!(staMs > 0) || !(ltaMs > 0) || !(threshold > 0)) return NaN;

  const N = Math.min(n, FB_MAX_SAMPLES);
  // Window lengths in samples (LTA strictly longer than STA so the ratio is meaningful).
  const sta = Math.max(1, Math.round((staMs * 1000) / sampleIntUs));
  const lta = Math.max(sta + 1, Math.round((ltaMs * 1000) / sampleIntUs));
  if (sta + lta >= N) return NaN; // not enough samples for a lagged LTA + STA window

  const src = samples as Float32Array;
  // Characteristic function = energy (amp²); prefix-summed for O(1) window sums.
  const P = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    const v = src[i];
    const e = Number.isFinite(v) ? v * v : 0;
    P[i + 1] = P[i] + e;
  }
  // A tiny fraction of the trace's mean energy: the LTA floor. It keeps the ratio
  // finite when the pre-arrival background is silent (a clean onset out of quiet
  // still triggers) and scales with the trace, so the detector stays gain-invariant.
  const meanE = P[N] / N;
  const floor = meanE > 0 ? meanE * 1e-4 : 1e-12;

  // Sample gates from the optional time bounds (clamped to the scannable range).
  const minMs = Number.isFinite(opts.minTimeMs as number) && (opts.minTimeMs as number) > 0 ? (opts.minTimeMs as number) : 0;
  const maxMs = Number.isFinite(opts.maxTimeMs as number) && (opts.maxTimeMs as number) > 0 ? (opts.maxTimeMs as number) : 0;
  const minSamp = Math.floor((minMs * 1000) / sampleIntUs);
  // Start once the STA window plus a few background samples are available - the LTA
  // "ramps up" (a partial window) until it reaches its full length, so an EARLY
  // near-offset first break isn't masked by requiring a full sta+lta lead-in.
  const start = Math.max(sta + 4, minSamp);
  const end = maxMs > 0 ? Math.min(N, Math.ceil((maxMs * 1000) / sampleIntUs)) : N;

  for (let i = start; i < end; i++) {
    // STA = trailing short window ending at i; LTA = the (up to `lta`) samples ending
    // JUST BEFORE the STA window - the lagged background. When new energy enters the
    // STA window the ratio spikes against the quiet pre-arrival LTA: the onset.
    const lend = i - sta;
    const ltaStart = Math.max(0, lend - lta + 1);
    const ltaCount = lend - ltaStart + 1; // ≥ 1 (partial near the trace start)
    const staAvg = (P[i + 1] - P[i + 1 - sta]) / sta;
    const ltaAvg = (P[lend + 1] - P[ltaStart]) / ltaCount;
    const ratio = staAvg / Math.max(ltaAvg, floor);
    if (Number.isFinite(ratio) && ratio >= threshold) {
      const ms = (i * sampleIntUs) / 1000;
      return Number.isFinite(ms) ? ms : NaN;
    }
  }
  return NaN;
}

/**
 * Pick first-break times (ms) for an array of traces. Returns a Float32Array of
 * the same length; entry i is the pick time of trace i, or `NaN` when that trace
 * has no confident pick (or is null). Bounding the trace COUNT is the caller's
 * job (the worker strides + caps); this loop is otherwise allocation-light.
 */
export function pickFirstBreaks(
  traces: ArrayLike<Float32Array | null | undefined>,
  sampleIntUs: number,
  opts: STALTAOpts,
): Float32Array {
  const out = new Float32Array(traces.length);
  for (let i = 0; i < traces.length; i++) out[i] = pickSTALTA(traces[i], sampleIntUs, opts);
  return out;
}
