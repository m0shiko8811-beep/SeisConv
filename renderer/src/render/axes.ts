// seisconv-renderer - shared axis drawing for the single-trace canvases
//
// DOM-touching (it strokes and fills on a 2d context), so it lives here and NOT
// in `core/`, which is pure TS per CLAUDE.md. The pure tick arithmetic lives in
// `core/render/ticks`.
//
// CONVERGED (P2-8): the tree used to carry four time-axis implementations, all
// of them splitting the visible window into a fixed number of equal parts. After
// a zoom that produced labels like 137, 688 and 1239 ms, which nobody can read
// off a screen at 2am. All four now go through `drawMsTimeAxis`, which puts the
// labels on ROUND numbers (`niceStep` from core/render/ticks) and lets the count
// fall out of the window. Each caller still chooses its own picture - gridlines
// or labels only, and roughly how many intervals it wants.
//
// TICK ENDPOINT: inclusive, with a slack of `step * 1e-6`. The tree was
// inconsistent - two loops tested `v <= hi + 1e-6` and the survey grid tested a
// bare `v <= hi`, which is four ticks against three over 0 to 0.3 at step 0.1.
// Inclusive is the correct one, because the loops ACCUMULATE (`v += step`) and
// 0.1 + 0.1 + 0.1 is 0.30000000000000004, so a bare `<=` silently drops the tick
// that sits exactly on a real data bound. The slack is made relative to the step
// rather than an absolute 1e-6 so it means the same thing on an axis in seconds
// as on one in microseconds.

import { niceStep, tickValues } from '../../../core/render/ticks';

/** Decimals needed to tell two neighbouring ticks apart at `step`. A 250 ms step
 *  wants none, a 0.5 ms step wants one. Bounded so a pathological step cannot ask
 *  for a 300-character label. */
export function tickDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  return Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
}

/** The shared time axis for every seismic panel: ms labels down the left edge on
 *  ROUND numbers, with optional gridlines across the plot.
 *
 *  `target` is roughly how many intervals the caller wants; the actual count
 *  follows from the nice step, so a zoomed window gets readable labels instead of
 *  the window split into fixed fractions. Every number reaching the canvas is
 *  finite-guarded, and a window with no positive span draws nothing at all rather
 *  than a NaN label. */
export function drawMsTimeAxis(
  ctx: CanvasRenderingContext2D,
  o: {
    ML: number; MT: number; pw: number; ph: number;
    t0Ms: number; t1Ms: number;
    target?: number;
    grid?: string | null;   // gridline colour, or null for labels only
    labelX?: number;
  },
): void {
  const { ML, MT, pw, ph, t0Ms, t1Ms } = o;
  if (![ML, MT, pw, ph, t0Ms, t1Ms].every(Number.isFinite)) return;
  if (!(pw > 0) || !(ph > 0) || !(t1Ms > t0Ms)) return;
  const step = niceStep(t1Ms - t0Ms, o.target ?? 5);
  const dp = tickDecimals(step);
  const labelX = o.labelX ?? 6;
  for (const v of tickValues(t0Ms, t1Ms, step, step * 1e-6)) {
    const y = MT + ((v - t0Ms) / (t1Ms - t0Ms)) * ph;
    if (!Number.isFinite(y) || y < MT - 0.5 || y > MT + ph + 0.5) continue;
    ctx.fillText(v.toFixed(dp) + ' ms', labelX, y + 3);
    if (o.grid) {
      ctx.strokeStyle = o.grid;
      ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + pw, y); ctx.stroke();
    }
  }
}

/** Paint a two-line display-state strip into a canvas top margin.
 *
 *  Every viewer states its own transform chain on line 1 and its polarity /
 *  amplitude declaration on line 2, in the same place, the same size and the
 *  same order, so a screenshot of any panel carries what was done to the data.
 *  Extracted verbatim from the File Viewer's `drawSecStateStrip`, which is why
 *  the section's pixels are unchanged by the move.
 *
 *  Narrow canvases shrink the font to 9px and then drop whole trailing ITEMS,
 *  so the strip can never overflow into the plot or off the right edge. The
 *  caller allows for it with `withStrip()` on its margins.
 *
 *  WHY WHOLE ITEMS: the old cut was per character, so at 1240 px the section
 *  read "SEG-Y byte 3259 = 3: on a vibrator record the seismic s..." - a code
 *  with its meaning severed, which looks like information and is not. Every
 *  caller already builds its line as an array of independent clauses in
 *  priority order, so cutting on that boundary always leaves a set of complete,
 *  true statements, and the count of what was dropped points at the export,
 *  which still prints the line in full. */
export const STRIP_SEP = ' · ';

/** Canvases that carry a "Save image…" button, and can therefore honestly send
 *  a reader to the export for the items the width could not hold. Every other
 *  canvas that draws a strip (the attribute profile, the zoom modal, the sweep
 *  signal plot) tells the reader to widen the window instead - a promise of an
 *  export that does not exist would be worse than the truncation it explains. */
const STRIP_EXPORTABLE = new Set([
  'secCanvas', 'traceCanvas', 'wbCanvas', 'velCanvas', 'specCanvas', 'gatherCanvas',
]);

export function drawStateStrip(
  ctx: CanvasRenderingContext2D, W: number,
  line1: string | readonly string[], line2: string | readonly string[],
) {
  const items1 = typeof line1 === 'string' ? [line1] : line1.slice();
  const items2 = typeof line2 === 'string' ? [line2] : line2.slice();
  stripByCanvas.set(ctx.canvas, { line1: items1.join(STRIP_SEP), line2: items2.join(STRIP_SEP) });
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const avail = Math.max(40, W - 12);
  const fits = (s: string) => ctx.measureText(s).width <= avail;
  const where = STRIP_EXPORTABLE.has(ctx.canvas.id) ? 'in the export' : 'if you widen the window';
  const put = (items: string[], y: number, color: string) => {
    ctx.font = '10px Consolas, monospace';
    let out = items.join(STRIP_SEP);
    if (!fits(out)) {
      ctx.font = '9px Consolas, monospace';
      let n = items.length;
      while (n > 1 && !fits(out)) {
        n -= 1;
        const cut = items.length - n;
        out = items.slice(0, n).join(STRIP_SEP) + `${STRIP_SEP}+${cut} more ${where}`;
      }
      // Even the single highest-priority item cannot be shown whole here. Say
      // that plainly rather than paint half a sentence.
      if (!fits(out)) out = `Display state: too narrow to show, it is readable ${where}`;
      if (!fits(out)) out = `Display state: ${where}`;
    }
    ctx.fillStyle = color;
    ctx.fillText(out, 6, y);
  };
  put(items1, 12, '#c8d2e0');
  put(items2, 25, '#9fb0c4');
  ctx.restore();
}

/** The UNTRUNCATED strip text last painted into each canvas.
 *
 *  The on-screen strip drops whole trailing clauses when the canvas is too narrow
 *  to hold them, and on the File Viewer that cut usually eats the excursion and
 *  the flattened-by-the-display percentage. An operator can open the Display popover
 *  and read them; whoever reads an exported image months later cannot. So the
 *  full text is kept here and the image export prints the remainder underneath.
 *
 *  Keyed per canvas, and weakly: `drawSection` paints the section's strip and then
 *  the attribute profile's strip on a DIFFERENT canvas, so one shared "last strip"
 *  would hand the section export the attribute wording. */
const stripByCanvas = new WeakMap<HTMLCanvasElement, { line1: string; line2: string }>();

/** The full strip text last drawn into `cv`, or null if it has never carried one. */
export function stateStripFor(cv: HTMLCanvasElement): { line1: string; line2: string } | null {
  return stripByCanvas.get(cv) ?? null;
}

/** Forget `cv`'s strip text. The image export calls this BEFORE its redraw, so a
 *  panel that draws no strip at all (the average amplitude spectrum) cannot
 *  inherit the wording of whatever shared the canvas before it. */
export function clearStateStrip(cv: HTMLCanvasElement): void {
  stripByCanvas.delete(cv);
}
