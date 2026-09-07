// seisconv-core / dsp - reduced-time (linear moveout) display.
//
// WHY this lives in core/dsp: it is a time-domain transform of the trace
// samples, exactly like ./gain.ts and ./agc.ts. Nothing about it is pixels.
//
// WHY the feature exists: on a raw shot record the first breaks form a curve,
// so a reversed geophone, a timing slip or a station planted at the wrong
// stake shows up as a subtle kink that is easy to miss. Shifting every trace
// by offset / velocity flattens the refracted first breaks into a straight
// horizontal line, and against a straight line the same error reads as an
// obvious STEP.
//
// Reference: Seismic Unix, src/su/main/stretching_moveout_resamp/sureduce.c.
// Self-doc: "SUREDUCE - convert traces to display in reduced time", parameter
// "rv=8.0   reducing velocity in km/sec", and the note that the operation is
// useful for plotting refraction seismic data. Its main loop is
//
//     bt = (fabs(off))/(rv*1000.0);
//     rnt = NINT(bt/dt);
//     ...
//     tr.data[i] = (i < (nt - rnt)) ? tr.data[j] : 0.0;
//
// so: the shift is |offset| / (rv * 1000) seconds, SU takes the ABSOLUTE
// offset (a split spread flattens on both wings), and SU rounds the shift to
// a whole sample and zero-fills. We keep the formula, the units and the
// absolute-offset default. We DEPART from SU in one stated way: the shift is
// applied with linear interpolation instead of NINT rounding, because the
// whole point is reading a small step in a flat line and rounding to the
// nearest sample injects up to half a sample of fake step. For a shift that
// is a whole number of samples the two agree exactly.
//
// UNITS, stated loudly because km/s versus m/s is the dangerous confusion
// here: reducingVelocityKmPerSec is KILOMETRES PER SECOND (SU's rv), offsets
// are METRES, times are SECONDS. 8 km/s is SU's default, not 8 m/s.
// A caller holding a SEG-Y file whose measurement-system byte says feet must
// convert to metres before calling; core does not guess units.
//
// Pure TypeScript: no DOM, no Electron.

/** Metres in a kilometre. SU's `rv*1000.0`, named so the conversion is visible. */
export const METRES_PER_KM = 1000;

/** SU's `rv=8.0` default, in km/s. */
export const SU_DEFAULT_REDUCING_VELOCITY_KM_PER_SEC = 8.0;

export interface ReduceParams {
  /** SU's `rv`, in KILOMETRES PER SECOND. Must be finite and > 0. */
  reducingVelocityKmPerSec: number;
  /** SU applies the shift to |offset| so both wings of a split spread flatten.
   *  Set true to use the signed offset instead (negative offset -> negative
   *  shift, data moves later). Default false = SU behaviour. */
  signedOffset?: boolean;
}

/** Why a trace could NOT be put into reduced time. Never overlaps with a real
 *  shift: a legitimate zero-offset trace is `ok: true` with shiftSeconds 0. */
export type ReduceFailure =
  | 'no-offset'      // offset header absent, null, or non-finite
  | 'bad-velocity'   // rv non-finite or <= 0
  | 'bad-timing'     // sample interval non-finite or <= 0
  | 'bad-trace';     // samples missing or empty

/** Discriminated union so "could not shift" and "shifted by zero" cannot be
 *  confused: the failure case carries NO samples field at all, so TypeScript
 *  refuses to let a caller read a buffer that was never produced. */
export type ReduceResult =
  | { ok: true; shiftSeconds: number; samples: Float32Array }
  | { ok: false; reason: ReduceFailure };

function finite(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * The SU shift, in SECONDS, for one trace: |offset| / (rv * 1000).
 * Returns null when the inputs cannot produce a shift, so a caller can never
 * mistake "unknown" for "zero". Offset in METRES, rv in KM/S.
 */
export function reducedTimeShiftSeconds(
  offsetMeters: number | null | undefined,
  reducingVelocityKmPerSec: number,
  signedOffset = false,
): number | null {
  if (!finite(offsetMeters)) return null;
  if (!finite(reducingVelocityKmPerSec) || reducingVelocityKmPerSec <= 0) return null;
  const x = signedOffset ? offsetMeters : Math.abs(offsetMeters);
  const shift = x / (reducingVelocityKmPerSec * METRES_PER_KM);
  // Defensive: a colossal offset over a tiny velocity could still overflow.
  return Number.isFinite(shift) ? shift : null;
}

/**
 * Record-level availability. Reduced time needs the offset header, so if no
 * trace in the record carries a usable non-zero offset the FEATURE cannot
 * work and the UI must say so rather than draw an unshifted section that
 * looks like it was reduced. All-zero offsets means the header was never
 * populated, which is the common SEG-2 / raw-SEG-D case.
 */
export function canReduce(offsetsMeters: ArrayLike<number | null | undefined>): boolean {
  for (let i = 0; i < offsetsMeters.length; i++) {
    const v = offsetsMeters[i];
    if (finite(v) && v !== 0) return true;
  }
  return false;
}

/**
 * Put one trace into reduced time.
 *
 * Output sample j sits at reduced time tau = j*dt, which is input time
 * tau + shift, so a positive shift moves the data EARLIER on screen (SU's
 * `data[i] = data[i+rnt]`). Samples pulled from outside the trace are zero,
 * as in SU.
 *
 * Performance: one pass, two multiplies and one lerp per sample, no
 * allocation inside the loop. Pass `out` (a per-record scratch buffer of at
 * least nSamples) to avoid allocating once per trace; with hundreds of traces
 * that is the difference between one buffer and hundreds.
 */
export function reduceTrace(
  samples: Float32Array | null | undefined,
  offsetMeters: number | null | undefined,
  sampleIntervalSeconds: number,
  params: ReduceParams,
  out?: Float32Array,
): ReduceResult {
  if (!samples || samples.length === 0) return { ok: false, reason: 'bad-trace' };
  if (!finite(params.reducingVelocityKmPerSec) || params.reducingVelocityKmPerSec <= 0) {
    return { ok: false, reason: 'bad-velocity' };
  }
  if (!finite(sampleIntervalSeconds) || sampleIntervalSeconds <= 0) {
    return { ok: false, reason: 'bad-timing' };
  }
  const shift = reducedTimeShiftSeconds(
    offsetMeters, params.reducingVelocityKmPerSec, params.signedOffset === true,
  );
  if (shift === null) return { ok: false, reason: 'no-offset' };

  const n = samples.length;
  const dst = out && out.length >= n ? out : new Float32Array(n);

  // Work in TIME, then convert once to a sample offset. Mapping straight from
  // sample index would silently ignore the sample interval, which is the class
  // of bug already fixed once in this app.
  const shiftSamples = shift / sampleIntervalSeconds;
  const whole = Math.floor(shiftSamples);
  const frac = shiftSamples - whole;

  if (frac === 0) {
    // Exact whole-sample shift: identical to SU's NINT path, and copying
    // avoids a pointless multiply-add per sample.
    for (let j = 0; j < n; j++) {
      const k = j + whole;
      dst[j] = k >= 0 && k < n ? samples[k] : 0;
    }
  } else {
    const g = 1 - frac;
    for (let j = 0; j < n; j++) {
      const k = j + whole;
      const a = k >= 0 && k < n ? samples[k] : 0;
      const b = k + 1 >= 0 && k + 1 < n ? samples[k + 1] : 0;
      dst[j] = g * a + frac * b;
    }
  }
  // A scratch buffer may be longer than this trace; hand back a view bounded
  // to n so stale samples from the previous trace can never be drawn.
  return { ok: true, shiftSeconds: shift, samples: dst.length === n ? dst : dst.subarray(0, n) };
}
