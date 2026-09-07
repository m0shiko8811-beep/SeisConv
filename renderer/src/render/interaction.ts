// seisconv-renderer - one interaction plumbing for every data canvas
//
// Before this module the tree carried five separate `*Interactions()` bodies,
// each free to drift in zoom factor, pan modifier and whether a double-click
// fitted at all. The result was that the Spectrum had wheel zoom but no pan and
// no double-click fit, the Velocity panel had no pan, and the Sweeps plots had
// no wheel zoom. This module owns the PLUMBING only - which DOM events are
// listened for, the click-versus-drag guard, and the single zoom step - and
// leaves every viewer's own zoom maths, clamps and fit exactly where they were.
// That is deliberate: `core/render/zoom.ts` documents two Y-anchor forms and two
// minimum-span floors that are algebraically equal but not bit-identical, and
// they must keep their existing behaviour per viewer.
//
// DOM-touching, so it lives here and not in `core/`, which is pure TS.

/** One zoom step. Wheel notch and toolbar +/- both use this, on every canvas,
 *  so a step means the same thing wherever the user is looking: the visible
 *  window halves (in) or doubles (out). */
export const PLOT_ZOOM_STEP = 2;

/** Factor for one wheel notch. Wheel up (deltaY < 0) zooms IN, so the factor is
 *  below 1 and the window narrows. */
export function wheelFactor(e: WheelEvent): number {
  return e.deltaY < 0 ? 1 / PLOT_ZOOM_STEP : PLOT_ZOOM_STEP;
}

export type PlotInteractionModel = {
  /** True when this canvas is visible and has data to interact with. */
  enabled(): boolean;
  /** Cursor pixel to a fraction of the plot rectangle, or null when outside. */
  frac(e: MouseEvent): { fx: number; fy: number } | null;
  /** Narrow (factor < 1) or widen the window about the fraction under the
   *  cursor. The viewer's own arithmetic; this module never computes a window. */
  zoomAt(fx: number, fy: number, factor: number): void;
  /** Pan by a pixel delta since the previous move. Omit for no pan. */
  panPx?(dx: number, dy: number): void;
  /** Reset to the full extent. Omit for no double-click fit. */
  fit?(): void;
  /** Redraw or re-fetch after a zoom or a pan. */
  after?(): void;
  /** Return true when the viewer takes this press for itself (a box-zoom drag,
   *  a first-break pick drag). The helper then does not start a pan. */
  claimDown?(e: MouseEvent): boolean;
  /** A press and release that never moved more than a few pixels. */
  click?(e: MouseEvent): void;
  /** Cursor to restore when a pan ends. Defaults to ''. */
  restCursor?(): string;
  /** Pan only while this returns true for the event (Sweeps keeps the plain
   *  left drag for its box zoom, so it pans on Shift). */
  panModifier?(e: MouseEvent): boolean;
};

/** A press that moves further than this many pixels is a drag, not a click. */
const CLICK_SLOP = 4;

/** How long a click is held before it acts, on canvases that also fit on a
 *  double-click. Windows' own double-click interval is 500 ms, but the two
 *  clicks of a deliberate double-click land far closer together than that;
 *  260 ms keeps single picking feeling immediate. */
const DBLCLICK_MS = 260;

const bound = new WeakSet<HTMLCanvasElement>();

/** Wire wheel zoom about the cursor, drag pan, and double-click fit onto one
 *  data canvas. Idempotent: a second call on the same canvas is ignored, so a
 *  draw function that re-runs cannot stack duplicate listeners. */
export function attachPlotInteraction(cv: HTMLCanvasElement, m: PlotInteractionModel): void {
  if (bound.has(cv)) return;
  bound.add(cv);

  cv.addEventListener('wheel', (e) => {
    if (!m.enabled()) return;
    e.preventDefault();
    const f = m.frac(e);
    if (!f || !Number.isFinite(f.fx) || !Number.isFinite(f.fy)) return;
    m.zoomAt(f.fx, f.fy, wheelFactor(e));
    m.after?.();
  }, { passive: false });

  let panning = false, lx = 0, ly = 0, moved = 0;

  cv.addEventListener('mousedown', (e) => {
    if (!m.enabled()) return;
    if (m.claimDown?.(e)) return;
    moved = 0;
    if (!m.panPx || (m.panModifier && !m.panModifier(e))) return;
    panning = true; lx = e.clientX; ly = e.clientY;
    cv.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    if (!m.enabled()) { panning = false; return; }
    const dx = e.clientX - lx, dy = e.clientY - ly;
    moved += Math.abs(dx) + Math.abs(dy);
    lx = e.clientX; ly = e.clientY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    m.panPx?.(dx, dy);
    m.after?.();
  });

  window.addEventListener('mouseup', () => {
    if (!panning) return;
    panning = false;
    cv.style.cursor = m.restCursor ? m.restCursor() : '';
  });

  // A double-click always delivers two plain `click` events first. On a canvas
  // that both places marks (`click`) and fits (`dblclick`), the first click would
  // create something the second click then acts on - on Velocity that was a
  // stray pick plus a "delete this pick?" modal instead of a fit. So when a
  // viewer has BOTH members the click is held for one double-click interval and
  // cancelled if a dblclick arrives; with no `fit` it still fires immediately.
  let pendingClick: number | null = null;
  let pendingEvent: MouseEvent | null = null;
  const cancelPendingClick = () => {
    if (pendingClick !== null) { clearTimeout(pendingClick); pendingClick = null; }
    pendingEvent = null;
  };
  /** Act on a held click at once. Two deliberate clicks in quick succession at
   *  different points (seeding two first-breaks) must both land, so a new press
   *  flushes the held one instead of replacing it. */
  const flushPendingClick = () => {
    const e = pendingEvent;
    cancelPendingClick();
    if (e) m.click!(e);
  };

  if (m.click) {
    cv.addEventListener('click', (e) => {
      // Chromium sets detail = 2 on the second click of a double-click; dropping
      // it means a double-click slower than the timer below still never acts on
      // whatever the first click made.
      if (!m.enabled() || moved > CLICK_SLOP || e.detail > 1) return;
      if (!m.fit) { m.click!(e); return; }
      flushPendingClick();
      pendingEvent = e;
      pendingClick = window.setTimeout(flushPendingClick, DBLCLICK_MS);
    });
  }

  if (m.fit) {
    cv.addEventListener('dblclick', () => {
      cancelPendingClick();
      if (!m.enabled()) return;
      m.fit!();
    });
  }
}
