// seisconv-core - Observer Log auto-numbering (pure, testable logic).
//
// The Observer Log "Trigger Watch" feature can behave like a shooting-system shot
// controller: on every trigger it auto-advances the Shot Point (SP) by a FIXED
// STEP and the File# / FFID by a counter, while every value stays inline-editable
// so the observer can correct a stuck / re-shot / skipped shot. This module holds
// ONLY the arithmetic - no DOM, no Electron, no I/O - so it can be unit-tested and
// reused by the renderer.
//
// SP model (fixed step, no SPS geometry needed):
//   nextSP = prevSP + (direction × step × interval)
// where `step` is the station move per shot, `direction` is +1 / -1 (up- or
// down-line), and `interval` is a multiplier the user can change at any time.
//
// Re-shoots / skips / drift are fixed by the observer editing a cell and then
// "Renumber rows below": recompute SP (and optionally File#) for every row AFTER a
// chosen anchor, using a (possibly changed) interval - see `renumberBelow`.

/** Fixed-step SP advance configuration. `dir` is +1 (up-line) or -1 (down-line). */
export interface SPStepCfg {
  step: number;
  dir: 1 | -1;
  interval: number;
}

/** Round to 6 decimals to keep floating-point SP arithmetic clean (SPs may be
 *  non-integer, e.g. 101.5); integers stay integers. */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** A finite number, or a sensible fallback when the input is not usable. */
function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Next Shot Point from the previous one by a FIXED step:
 *   nextSP = prevSP + (dir × step × interval)
 *
 * Returns `null` when `prevSP` is null / non-finite (blank or non-numeric SP) -
 * the caller then seeds a fresh row from the configured start SP instead. `step`
 * and `interval` default to 1 and `dir` to +1 when not finite / not -1.
 */
export function nextSP(prevSP: number | null | undefined, cfg: SPStepCfg): number | null {
  if (prevSP == null || !Number.isFinite(prevSP)) return null;
  const step = numOr(cfg?.step, 1);
  const interval = numOr(cfg?.interval, 1);
  const dir: 1 | -1 = cfg?.dir === -1 ? -1 : 1;
  return round6(prevSP + dir * step * interval);
}

/** Next File# / FFID: `prevFile + 1`, or `start` when there is no previous value. */
export function nextFile(prevFile: number | null | undefined, start: number): number {
  if (prevFile == null || !Number.isFinite(prevFile)) return Math.trunc(numOr(start, 1));
  return Math.trunc(prevFile) + 1;
}

/** One row's numbered fields for renumbering. `null` = blank / non-numeric. */
export interface RenumRow {
  sp: number | null;
  file: number | null;
}

/** Renumber options for `renumberBelow`. `interval` is the SIGNED per-row SP
 *  increment (already carries direction). `startFile` is optional: when provided
 *  the anchor row gets it and each following row advances by +1; when omitted the
 *  File# column is left untouched. */
export interface RenumOpts {
  startSP: number;
  interval: number;
  startFile?: number | null;
}

/**
 * Recompute SP (and optionally File#) for the anchor row `fromIndex` and every row
 * AFTER it, using a fixed `interval`. This is how re-shoots / skips / drift are
 * fixed and how the interval is recalculated:
 *
 *   rows[fromIndex].sp        = startSP
 *   rows[fromIndex + k].sp    = startSP + k × interval      (k = 1, 2, …)
 *
 * When `startFile` is a finite number:
 *   rows[fromIndex].file      = startFile
 *   rows[fromIndex + k].file  = startFile + k
 * otherwise every `file` is left exactly as it was.
 *
 * Pure: returns a NEW array of NEW row objects; the input is never mutated. Rows
 * before `fromIndex` are copied through unchanged. An out-of-range `fromIndex`
 * returns a faithful copy of the input.
 */
export function renumberBelow(rows: RenumRow[], fromIndex: number, opts: RenumOpts): RenumRow[] {
  const out: RenumRow[] = (rows ?? []).map((r) => ({ sp: r?.sp ?? null, file: r?.file ?? null }));
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= out.length) return out;
  const startSP = numOr(opts?.startSP, 0);
  const interval = numOr(opts?.interval, 1);
  const hasFile = opts?.startFile != null && Number.isFinite(opts.startFile);
  const startFile = hasFile ? Math.trunc(opts!.startFile as number) : 0;
  for (let k = 0; fromIndex + k < out.length; k++) {
    out[fromIndex + k].sp = round6(startSP + k * interval);
    if (hasFile) out[fromIndex + k].file = startFile + k;
  }
  return out;
}
