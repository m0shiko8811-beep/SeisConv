// seisconv-core - plot-frame margins and the plot rectangle
//
// Every viewer in `renderer/src/app.ts` computes the same two subtractions to
// get its plot rect, and several of them retype the four margin numbers as bare
// literals. The worst case is the Spectrum pair: `app.ts:2692` (draw side,
// drawSpectrum) and `app.ts:12726` (hit-test side, specPlotFrac) declare the
// same four numbers independently, with nothing making them agree. They DO
// agree at eaff5dd; the point of this module is that nothing was keeping them
// that way.
//
// Pure TS. No DOM, no Electron. Canvas-side concerns - the `clientWidth || 900`
// fallback sizes, the dpr transform, the background fill - deliberately stay in
// the renderer; only the arithmetic lives here.

/** The four plot-frame margins, in CSS pixels. */
export type Margins = { ML: number; MR: number; MT: number; MB: number };

/** A plot rectangle in CSS pixels, top-left origin. */
export type PlotRect = { x: number; y: number; w: number; h: number };

/** File Viewer section: the display-state strip is painted INSIDE the canvas,
 *  so it is part of the top margin. `app.ts:2989-2990`. */
export const SEC_STRIP_H = 24;
export const SEC_MARGINS: Margins = { ML: 58, MR: 12, MT: 10 + SEC_STRIP_H, MB: 24 };

/** Trace Inspector. `app.ts:2994`. The Workbench retypes these same four as
 *  bare literals at `:5646` (drawPreviewTrace), `:5850` (drawWorkbench) and
 *  `:6111` (wbDrawDiff), which is why they are exported under a second name
 *  rather than folded together - the values match, the intent may not. */
export const TRC_MARGINS: Margins = { ML: 60, MR: 14, MT: 14 + SEC_STRIP_H, MB: 26 };

/** Trace Workbench (`app.ts:5646`, `:5850`, `:6111`). Same four numbers as
 *  TRC_MARGINS today; kept separate so a future divergence is a deliberate
 *  edit rather than an accident. */
export const WB_MARGINS: Margins = { ML: 60, MR: 14, MT: 14, MB: 26 };

/** The same margins with room for a display-state strip added to the top. The
 *  strip is painted INSIDE the canvas, so it is part of the top margin; the
 *  small preview / difference / correlation cards keep the plain margins
 *  because they carry no strip of their own. */
export function withStrip(m: Margins): Margins {
  return { ML: m.ML, MR: m.MR, MT: m.MT + SEC_STRIP_H, MB: m.MB };
}

/** Trace Workbench MAIN canvas (`drawWorkbench`), which carries a strip. The
 *  preview and difference plots keep {@link WB_MARGINS}. */
export const WB_MAIN_MARGINS: Margins = withStrip(WB_MARGINS);

/** Spectrum Average view. Draw side `app.ts:2692`, hit-test side `:12726`. */
export const SPEC_AVG_MARGINS: Margins = { ML: 56, MR: 16, MT: 18, MB: 28 };

/** Spectrogram / F-K heatmaps. `app.ts:12181` (SPEC_M). MR leaves room for the
 *  colour bar AND its numeric ticks. */
export const SPEC_HEAT_MARGINS: Margins = { ML: 56, MR: 92, MT: 14, MB: 30 };

/** Velocity / semblance panel. `app.ts:11867` (velGeom). MR leaves room for the
 *  semblance colour bar and its ticks. */
export const VEL_MARGINS: Margins = { ML: 56, MR: 92, MT: 12, MB: 28 };

/** The plot rectangle for a canvas of W x H CSS pixels.
 *
 *  This is the `const pw = W - ML - MR, ph = H - MT - MB` pair retyped at
 *  `app.ts:2693`, `:5647`, `:5851`, `:6112`, `:11904`, `:12732` and elsewhere,
 *  plus the (ML, MT) origin those sites pass to strokeRect / drawImage.
 *
 *  Deliberately UNGUARDED: the call sites disagree about what to do with a
 *  degenerate rect (`:5648` bails on `pw < 4 || ph < 4`, `:12730` returns null
 *  on `pw <= 0 || ph <= 0`, velGeom checks nothing), so w and h are returned as
 *  computed - negative and NaN included - and the caller keeps its own test.
 *  See `guards.plotUsable`. */
export function plotRect(W: number, H: number, m: Margins): PlotRect {
  return { x: m.ML, y: m.MT, w: W - m.ML - m.MR, h: H - m.MT - m.MB };
}

/** Plot width only, for sites that need one axis. */
export function plotWidth(W: number, m: Margins): number { return W - m.ML - m.MR; }

/** Plot height only. */
export function plotHeight(H: number, m: Margins): number { return H - m.MT - m.MB; }
