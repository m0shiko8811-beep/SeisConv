// seisconv-core / dsp - robust statistics primitives.
//
// Small, pure, finite-guarded helpers shared by trace-health QC and first-break
// picking: the MEDIAN, the median-absolute-deviation (MAD), a robust MAD-based
// z-score, and a LOCAL (sliding neighbour-window) median + MAD. "Robust" = barely
// moved by a few wild outliers - exactly what QC needs, so one bad trace cannot
// shift the baseline its neighbours are judged against.
//
// Every function tolerates empty / NaN / Infinity input without throwing and returns
// a finite number (0 or a sane fallback), so nothing here can poison a downstream
// draw. No DOM, no deps.

/** Makes the MAD a consistent estimator of σ for a normal distribution. */
export const MAD_SIGMA = 1.4826;

/** Median of a numeric array. Ignores non-finite entries. Returns `fallback`
 *  (default 0) when no finite value remains. Does NOT mutate the input. */
export function median(arr: ArrayLike<number>, fallback = 0): number {
  const a: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (Number.isFinite(v)) a.push(v);
  }
  const n = a.length;
  if (n === 0) return fallback;
  a.sort((x, y) => x - y);
  const m = n >> 1;
  const med = n % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  return Number.isFinite(med) ? med : fallback;
}

/** Median-absolute-deviation about the median (raw, UNSCALED - multiply by
 *  MAD_SIGMA for a σ estimate). Robust measure of spread; 0 for a degenerate
 *  (all-equal or empty) sample. Pass a precomputed `med` to avoid re-sorting. */
export function mad(arr: ArrayLike<number>, med?: number): number {
  const m = med === undefined ? median(arr) : med;
  const dev: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (Number.isFinite(v)) dev.push(Math.abs(v - m));
  }
  const d = median(dev);
  return Number.isFinite(d) ? d : 0;
}

/** Robust z-score of `x` against a sample described by its `med` and raw `madRaw`:
 *  z = (x - med) / (MAD_SIGMA·madRaw). When the MAD is 0 (a degenerate, all-equal
 *  sample) the scale falls back to `floor` so the result stays finite instead of
 *  blowing up to ±Infinity. Returns 0 for any non-finite input. */
export function madZScore(x: number, med: number, madRaw: number, floor = 0): number {
  if (!Number.isFinite(x) || !Number.isFinite(med)) return 0;
  let scale = MAD_SIGMA * (Number.isFinite(madRaw) ? madRaw : 0);
  if (!(scale > 0)) scale = Number.isFinite(floor) && floor > 0 ? floor : 0;
  if (!(scale > 0)) return 0;
  const z = (x - med) / scale;
  return Number.isFinite(z) ? z : 0;
}

/** Result of a local (windowed) robust-stat query. `n` is how many kept neighbours
 *  the median/MAD were built from (0 ⇒ the window was empty and `median` is the
 *  fallback). */
export interface LocalStat {
  median: number;
  mad: number;
  n: number;
}

/** LOCAL median + MAD of `arr` over the window [i-W, i+W], with optional
 *  `excludeSelf` and a `keep(value, index)` predicate (e.g. keep only LIVE
 *  neighbours). Non-finite values are always dropped. Returns the supplied
 *  `fallbackMed` with `n = 0` when the window keeps nothing - so a local baseline
 *  can never be built from an empty/dead patch. */
export function localMedianMAD(
  arr: ArrayLike<number>,
  i: number,
  W: number,
  opts: { excludeSelf?: boolean; keep?: (v: number, j: number) => boolean; fallbackMed?: number; lo?: number; hi?: number } = {},
): LocalStat {
  const n = arr.length;
  const lo = Math.max(0, opts.lo ?? 0, i - W);
  const hi = Math.min(n - 1, opts.hi ?? n - 1, i + W);
  const win: number[] = [];
  for (let j = lo; j <= hi; j++) {
    if (opts.excludeSelf && j === i) continue;
    const v = arr[j];
    if (!Number.isFinite(v)) continue;
    if (opts.keep && !opts.keep(v, j)) continue;
    win.push(v);
  }
  if (win.length === 0) return { median: opts.fallbackMed ?? 0, mad: 0, n: 0 };
  const med = median(win);
  return { median: med, mad: mad(win, med), n: win.length };
}

/** Clamp `x` into [0, 1]; non-finite → 0. Handy for severity/confidence/alpha. */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
