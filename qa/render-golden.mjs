// SeisConv - pixel-hash render oracle.
//
// Proves canvas draw output is byte-identical before/after a refactor. Opens the
// user's REAL SEG-Y/SPS data (same resolution as qa/drive.mjs / qa/harness.mjs),
// drives every canvas viewer through a matrix of display states, and hashes each
// resulting canvas's raw pixel data (getImageData, not toDataURL, so no PNG
// encoder is in the loop).
//
// USAGE (from repo root):
//   node qa/render-golden.mjs --update     write qa/golden-render.json
//   node qa/render-golden.mjs              compare against qa/golden-render.json, exit 1 on any mismatch
//
// Requires "npm run build" to have produced dist/main.js + renderer/dist/app.js.
//
// DETERMINISM: every state change here is followed by a REAL completion signal,
// never a fixed sleep alone -
//   - secMode / secColor / secScaleMode are synchronous redraws (see
//     renderer/src/app.ts redrawSection/paintSection) - we wait two animation
//     frames so the paint has committed, no more.
//   - secAgc is an async worker refetch (refetchSection sets #secLabel to
//     "Rendering..." then fetches) - we wait for that label to leave
//     "Rendering...".
//   - every spectrum display (average / spectrogram / f-k) and the Linear/dB
//     toggle goes through the same async specBusy path - we wait for #specLabel
//     to leave both "Computing..." and the empty/"Open a seismic file" states.
//     This is the exact bug qa/drive.mjs had for Velocity: "Computing..." also
//     matches a substring check that isn't careful, so the wait must positively
//     exclude it, not just wait for "non-initial" text.
//   - Velocity's semblance compute uses the same careful wait already proven in
//     qa/drive.mjs (exclude both the initial label AND "Computing").
//   - Trace Workbench mode/invert are synchronous redraws - two-rAF wait.
//   - Trace Inspect waveform/spectrum toggle - two-rAF wait (sync canvas redraw).
//   - the section's own zoom (secZoomAt -> fetchSectionWindow) is async and its
//     ONLY honest signal is #secLabel, which the fetch loop writes AFTER
//     drawSection - so we snapshot the label, act, and wait for it to differ.
//   - the box-zoom popup: a TRACE zoom re-windows in memory, a SECTION zoom
//     re-fetches from the worker; both call drawZoom BEFORE rewriting #zoomTitle,
//     so a changed title is a post-paint signal for either kind.
//   - health scan / assisted fill both redraw the section inside the same
//     synchronous tail that writes their readout, so the settled readout is the
//     signal (and the health state is DROPPED if the scan flagged nothing, since
//     the overlay would then draw nothing at all).
//
// PAGE-COORDINATE GESTURES ARE LAYOUT-SENSITIVE. Four states are produced by a
// real mouse gesture at absolute page coordinates on #secCanvas - zoom:section and
// zoom:section:mag (the box drag) and section:fb-seeds / section:fb-filled (the two
// seed clicks). openSecPanels() below opens the Display and Health panels, so
// ANYTHING that changes the height of those panels moves #secCanvas down the page,
// the gesture lands on a different trace/time, and those four hashes legitimately
// move while every other secCanvas state stays byte-identical. If you add a control
// to #secHealthBar or #secDisplayPanel, expect exactly those four and no others.
//
// CAPTURE ORDER IS LOAD-BEARING: never hash a canvas BEFORE an existing capture
// of that same canvas. getImageData is a GPU read-back and Chromium flips a
// canvas to software raster after a few of them, which nudges antialiasing.
// Measured: one extra early hash of #specCanvas moved spectrum:average:db and
// nothing else. New states on an already-covered canvas go AFTER the old ones.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launch, mockDialogs, gotoTab, openFile, sleep, SEGY, SPS, sample, qaPath,
} from './harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = join(__dirname, 'golden-render.json');
const UPDATE = process.argv.includes('--update');

const LE = qaPath('le', sample('example-le.sgy'));

// -- pixel hashing (in the renderer, over raw ImageData bytes) --------------
async function hashCanvas(win, id) {
  return win.evaluate((cid) => {
    const cv = document.getElementById(cid);
    if (!cv || !cv.getContext) return { ok: false, reason: 'no canvas element' };
    if (!cv.width || !cv.height) return { ok: false, reason: 'zero-size canvas' };
    const ctx = cv.getContext('2d');
    let img;
    try { img = ctx.getImageData(0, 0, cv.width, cv.height); } catch (e) {
      return { ok: false, reason: 'unreadable: ' + e.message };
    }
    const d = img.data;
    // FNV-1a 32-bit over every byte, plus a second independent accumulator
    // (sum of bytes at odd/even offsets) so a hash collision needs BOTH to
    // agree by chance - cheap insurance, still one pass over the buffer.
    let h1 = 0x811c9dc5 | 0;
    let sumEven = 0, sumOdd = 0;
    for (let i = 0; i < d.length; i++) {
      h1 ^= d[i];
      h1 = Math.imul(h1, 16777619);
      if (i & 1) sumOdd = (sumOdd + d[i]) >>> 0; else sumEven = (sumEven + d[i]) >>> 0;
    }
    const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
    return { ok: true, hash: `${hex(h1)}-${hex(sumEven)}-${hex(sumOdd)}`, w: cv.width, h: cv.height, bytes: d.length };
  }, id);
}

// two committed animation frames = "the synchronous redraw I just triggered has painted"
async function twoFrames(win) {
  await win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function waitSecIdle(win) {
  await win.waitForFunction(() => {
    const l = document.getElementById('secLabel');
    return !l || !/Rendering/i.test(l.textContent || '');
  }, null, { timeout: 20000 });
  await twoFrames(win);
}

// Wait for a DOM element's text to change away from `before`. Used for the
// ASYNC repaints whose only honest completion signal is the readout the repaint
// itself writes AFTER the draw call (section window fetch, zoom-popup refetch).
async function waitTextChanged(win, id, before, note) {
  await win.waitForFunction(([eid, prev]) => {
    const el = document.getElementById(eid);
    return !!el && (el.textContent || '') !== prev;
  }, [id, before], { timeout: 30000 })
    .catch(() => { throw new Error(`#${id} text did not change (${note})`); });
  await twoFrames(win);
}

// Press the mouse at one plot fraction of a canvas and release at another, i.e.
// the rubber-band box gesture. Fractions, not pixels, so the gesture lands in
// the same DATA region whatever the canvas happens to measure.
async function dragBox(win, sel, fx0, fy0, fx1, fy1) {
  const el = win.locator(sel);
  await el.scrollIntoViewIfNeeded();
  const bb = await el.boundingBox();
  if (!bb) throw new Error(`${sel}: no bounding box (not laid out)`);
  const vp = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const px = (fx) => bb.x + fx * bb.width;
  const py = (fy) => Math.min(vp.h - 4, bb.y + fy * bb.height);
  if (bb.y >= vp.h - 8 || bb.x >= vp.w - 8) throw new Error(`${sel}: off-viewport, drag not deliverable`);
  await win.mouse.move(px(fx0), py(fy0));
  await win.mouse.down();
  await win.mouse.move(px((fx0 + fx1) / 2), py((fy0 + fy1) / 2));
  await win.mouse.move(px(fx1), py(fy1));
  await win.mouse.up();
}

/** Open the File Viewer's two collapsed toolbar sections (idempotent). */
async function openSecPanels(win) {
  for (const [btn, panel] of [['#secDisplayBtn', '#secDisplayPanel'], ['#secHealthToggle', '#secHealthWrap']]) {
    const shown = await win.evaluate((sel) => document.querySelector(sel)?.style.display === 'block', panel);
    if (!shown) await win.click(btn);
  }
}

/** Click a control that lives in a HIDDEN panel (no actionability check - the
 *  whole point of the hidden-tab states is that the element is not visible). */
async function clickHidden(win, id) {
  const ok = await win.evaluate((eid) => {
    const el = document.getElementById(eid);
    if (!el) return false;
    el.click();
    return true;
  }, id);
  if (!ok) throw new Error(`clickHidden: #${id} not found`);
  await twoFrames(win);
}

async function waitSpecIdle(win, timeoutNote) {
  await win.waitForFunction(() => {
    const l = document.getElementById('specLabel');
    const t = (l?.textContent || '').trim();
    return t !== '' && !/^Computing/i.test(t) && !/Open a seismic file/i.test(t);
  }, null, { timeout: 30000 }).catch(() => { throw new Error(`specLabel did not settle (${timeoutNote})`); });
  await twoFrames(win);
}

// -- run ----------------------------------------------------------------------
const golden = {};   // key -> { hash, w, h }
const mismatches = [];
const excluded = [];

function record(key) { return key; }

async function main() {
  for (const need of ['dist/main.js', 'renderer/dist/app.js', 'renderer/index.html']) {
    if (!existsSync(join(__dirname, '..', need))) {
      console.error(`[FATAL] missing ${need} - run "npm run build" first.`);
      process.exit(2);
    }
  }

  const { app, win, errors } = await launch();
  const results = {};

  async function capture(key, canvasId) {
    const r = await hashCanvas(win, canvasId);
    if (!r.ok) throw new Error(`${key}: canvas unreadable (${r.reason})`);
    results[key] = { hash: r.hash, w: r.w, h: r.h };
  }

  try {
    // NOTE ON CAPTURE ORDER - drawSpecEmpty is captured at the very END of the
    // run, not here at startup where it is also on screen. Measured: hashing
    // #specCanvas once BEFORE the existing spectrum states moved the pre-existing
    // spectrum:average:db hash (ed405c1e... -> 72d2922a..., same 1116x514) while
    // leaving all 143 others alone. getImageData is a GPU read-back, and Chromium
    // switches a canvas to software raster after a few of them, which nudges the
    // antialiasing. So the rule for this file is: NEVER add a capture on a canvas
    // BEFORE an existing capture of that same canvas - only after it.

    // -- open the real SEG-Y (same file every viewer below reuses) --
    const count = await openFile(app, win, SEGY);
    if (!count || count === '-') throw new Error('SEGY did not open (summary did not populate)');
    console.log(`Opened SEGY (${SEGY}) -> traces=${count}`);

    // ================= FILE VIEWER (secCanvas) =================
    // Full matrix: display mode x colour map x scale mode x AGC on/off.
    await gotoTab(win, 'tab-section', 'panel-section');
    // The File Viewer's gain / AGC / clip / excursion / scale controls live in the
    // collapsed #secDisplayPanel, and the health tools in #secHealthWrap. Playwright
    // will not act on a display:none element, so open both here. The canvas is sized
    // by CSS (height:60vh), so opening a panel moves the canvas DOWN but does not
    // resize it: the captured pixels are unaffected.
    await openSecPanels(win);
    await win.waitForFunction(() => {
      const cv = document.getElementById('secCanvas');
      return cv && cv.width > 0;
    }, null, { timeout: 15000 });
    await waitSecIdle(win);

    const modes = ['vd', 'wiggle', 'va', 'vdwig'];
    // grayL ("Gray (perceptual)") added alongside the four existing maps - it
    // rides the same full mode x scale x agc matrix as the others so it gets
    // the same coverage, no separate reasoning needed for it.
    const colors = ['seismic', 'gray', 'amber', 'viridis', 'grayL'];
    const scales = ['max', 'pct', 'trace'];
    let agcState = await win.isChecked('#secAgc');

    for (const agc of [false, true]) {
      if (agc !== agcState) {
        await win.click('#secAgc');
        agcState = agc;
        await waitSecIdle(win);
      }
      for (const scale of scales) {
        await win.selectOption('#secScaleMode', scale);
        await twoFrames(win);
        for (const mode of modes) {
          await win.selectOption('#secMode', mode);
          await twoFrames(win);
          for (const color of colors) {
            await win.selectOption('#secColor', color);
            await twoFrames(win);
            await capture(`section:mode=${mode}:color=${color}:scale=${scale}:agc=${agc}`, 'secCanvas');
          }
        }
      }
    }
    const mainMatrixCount = modes.length * colors.length * scales.length * 2;
    console.log(`section: ${mainMatrixCount} states captured (main matrix)`);

    // -- clip / excursion, as two SEPARATE small sweeps, not crossed into the
    // matrix above. Both are numeric inputs (#secClip, #secExc), not selects.
    // Crossing them into the main matrix would multiply an already-120-state
    // grid by 2-3x for no benefit, since clip and excursion are independent
    // knobs that don't interact with colour map at all. Instead: reset to one
    // fixed baseline (seismic / pct / agc off) and vary one knob at a time.
    await win.selectOption('#secColor', 'seismic');
    await win.selectOption('#secScaleMode', 'pct');
    if (agcState) { await win.click('#secAgc'); agcState = false; await waitSecIdle(win); }

    // Excursion only changes pixels in wiggle / va / vdwig (it scales how far
    // a sample deflects) - pure VD mode never reads it, so 'vd' is excluded
    // here on purpose, per the task instructions.
    await win.fill('#secClip', '100');
    for (const mode of ['wiggle', 'va', 'vdwig']) {
      await win.selectOption('#secMode', mode);
      await twoFrames(win);
      for (const exc of ['0.5', '1', '2']) {
        await win.fill('#secExc', exc);
        await twoFrames(win);
        await capture(`section:exc-sweep:mode=${mode}:exc=${exc}`, 'secCanvas');
      }
    }
    await win.fill('#secExc', '1'); // restore default

    // Clip changes the saturation point of the display, which every draw mode
    // reads (including 'vd') - so this sweep covers all four modes at one
    // non-default value (90); 100 is already the implicit default baseline
    // exercised throughout the main matrix above, so it is not repeated here.
    for (const mode of modes) {
      await win.selectOption('#secMode', mode);
      await twoFrames(win);
      await win.fill('#secClip', '90');
      await twoFrames(win);
      await capture(`section:clip-sweep:mode=${mode}:clip=90`, 'secCanvas');
    }
    await win.fill('#secClip', '100'); // restore default

    const clipExcCount = 3 * 3 + modes.length;
    console.log(`section: ${clipExcCount} states captured (clip/excursion sweeps)`);

    // -- NEW STATES, appended AFTER every capture above, never interleaved into
    // the matrix. The file's own rule at the top: capture order on one canvas is
    // load-bearing, so a new state that sits BEFORE an existing one can nudge that
    // existing hash for reasons that have nothing to do with the change.
    //
    // Four added colour maps (two perceptually-uniform diverging maps and the two
    // positive-black greys), the 'raw' scale basis, and the display gain-law
    // family. The laws are pure redraws in the renderer (no worker refetch), so
    // two frames is the honest signal, exactly as for secMode / secColor.
    await win.selectOption('#secMode', 'vd');
    await win.selectOption('#secScaleMode', 'pct');
    await twoFrames(win);
    for (const color of ['berlin', 'vik', 'grayPosBlack', 'grayLPosBlack']) {
      await win.selectOption('#secColor', color);
      await twoFrames(win);
      await capture(`section:newmap:mode=vd:color=${color}`, 'secCanvas');
    }
    await win.selectOption('#secColor', 'seismic');
    await twoFrames(win);

    // 'raw' basis: full scale is the sample value 1. Covered in vd and wiggle,
    // since the basis feeds the raster and the wiggle path by different routes.
    for (const mode of ['vd', 'wiggle']) {
      await win.selectOption('#secMode', mode);
      await win.selectOption('#secScaleMode', 'raw');
      await twoFrames(win);
      await capture(`section:scale=raw:mode=${mode}`, 'secCanvas');
    }
    await win.selectOption('#secScaleMode', 'pct');
    await win.selectOption('#secMode', 'vd');
    await twoFrames(win);

    // Gain laws. 'fixed' is the default already covered by the whole matrix
    // above, so it is not repeated; the exponent laws are captured at their
    // default exponent, which is what the picker offers.
    for (const law of ['none', 'tpow', 'epow', 'gpow', 'pbal']) {
      await win.selectOption('#secGainLaw', law);
      await twoFrames(win);
      await capture(`section:gainlaw=${law}:mode=vd`, 'secCanvas');
    }
    await win.selectOption('#secGainLaw', 'fixed');
    await twoFrames(win);
    console.log(`section: ${4 + 2 + 5} states captured (new maps / raw basis / gain laws)`);

    // ================= TRACE INSPECT (traceCanvas) =================
    await gotoTab(win, 'tab-trace', 'panel-trace');
    await win.waitForFunction(() => {
      const cv = document.getElementById('traceCanvas');
      return cv && cv.width > 0;
    }, null, { timeout: 15000 });
    await twoFrames(win);
    await capture('trace:waveform', 'traceCanvas');
    await win.click('#traceSpec');
    await win.waitForFunction(() => {
      const cv = document.getElementById('traceCanvas');
      return cv && cv.width > 0;
    }, null, { timeout: 15000 });
    await twoFrames(win);
    await capture('trace:spectrum', 'traceCanvas');
    await win.click('#traceWave'); // leave it back on waveform
    await twoFrames(win);

    // ================= SPECTRUM: average / spectrogram / f-k =================
    await gotoTab(win, 'tab-spectrum', 'panel-spectrum');
    await waitSpecIdle(win, 'initial average');
    await capture('spectrum:average:linear', 'specCanvas');
    await win.click('#specDbDb');
    await waitSpecIdle(win, 'average dB');
    await capture('spectrum:average:db', 'specCanvas');
    await win.click('#specDbLin'); // restore
    await waitSpecIdle(win, 'average restore linear');

    await win.click('#specDispGram');
    await waitSpecIdle(win, 'spectrogram');
    await capture('spectrum:spectrogram', 'specCanvas');

    await win.click('#specDispFk');
    await waitSpecIdle(win, 'f-k');
    await capture('spectrum:fk', 'specCanvas');

    await win.click('#specDispAvg');
    await waitSpecIdle(win, 'average return');

    // ================= TRACE WORKBENCH (wbCanvas) =================
    // Needs two traces collected (matches qa/drive.mjs step 6) so side-by-side
    // vs overlay actually differ. mode x invert = 4 states.
    await gotoTab(win, 'tab-workbench', 'panel-workbench');
    await win.click('#wbAddOpenBtn'); await sleep(400);
    if (existsSync(LE)) {
      await mockDialogs(app, [LE]);
      await win.click('#wbPickBtn'); await sleep(600);
      await win.fill('#wbIndex', '0').catch(() => {});
      await win.click('#wbAddOpenBtn').catch(() => {}); await sleep(400);
    } else {
      excluded.push('workbench: second (LE) trace skipped - LE fixture not found, matrix ran on one trace only');
    }
    await win.waitForFunction(() => {
      const cv = document.getElementById('wbCanvas');
      return cv && cv.width > 0;
    }, null, { timeout: 15000 });
    let invertState = false; // Invert starts off
    for (const mode of ['side', 'overlay']) {
      await win.click(mode === 'side' ? '#wbModeSide' : '#wbModeOverlay');
      await twoFrames(win);
      for (const inv of [false, true]) {
        if (inv !== invertState) { await win.click('#wbInvertBtn'); invertState = inv; }
        await twoFrames(win);
        await capture(`workbench:mode=${mode}:invert=${inv}`, 'wbCanvas');
      }
    }

    // -- wbRenderPreview / drawPreviewTrace, wbDrawCorr, wbDrawDiff --
    // All three are already painted by the collection flow above (the preview by
    // #wbPickBtn + #wbIndex, the analysis pair automatically once two traces are
    // collected). These are READ-ONLY captures: no click, no state change, so the
    // four workbench matrix hashes above are untouched.
    const previewReady = await win.evaluate(() =>
      /trace \d+ of/.test(document.getElementById('wbPreviewLabel')?.textContent || ''));
    if (previewReady) await capture('workbench:preview-trace', 'wbPreviewCanvas');
    else excluded.push('workbench:preview-trace - #wbPreviewLabel never showed a loaded trace (no picked file)');

    const analysisReady = await win.evaluate(() =>
      /^best lag/.test(document.getElementById('wbCorrReadout')?.textContent || ''));
    if (analysisReady) {
      await capture('workbench:corr', 'wbCorrCanvas');
      await capture('workbench:diff', 'wbDiffCanvas');
    } else {
      excluded.push('workbench:corr / workbench:diff - fewer than two traces collected, the Analysis card stayed empty');
    }

    // -- wbZoomAt (Phase 1 step 1.6 anchor family). Synchronous redraw. --
    await win.click('#wbZoomIn');
    await twoFrames(win);
    await capture('workbench:zoomed', 'wbCanvas');
    await win.click('#wbZoomFit');
    await twoFrames(win);

    // ================= VELOCITY (velCanvas) =================
    // No display-mode controls to matrix over - one deterministic computed
    // state. Reuses the exact "wait for finish, not just leave the initial
    // text" fix qa/drive.mjs needed (label passes through "Computing...").
    await gotoTab(win, 'tab-vel', 'panel-vel');
    await win.click('#velComputeBtn');
    await win.waitForFunction(() => {
      const l = document.getElementById('velLabel');
      if (!l) return false;
      const t = l.textContent || '';
      return !/Open a file, then compute/.test(t) && !/Computing/i.test(t);
    }, null, { timeout: 40000 }).catch(() => { throw new Error('velocity semblance did not finish in 40s'); });
    await twoFrames(win);
    await capture('velocity:semblance', 'velCanvas');

    // -- velZoomAt / heatZoomAt (anchor family). Synchronous redraw. --
    await win.click('#velZoomIn');
    await twoFrames(win);
    await capture('velocity:zoomed', 'velCanvas');
    await win.click('#velZoomFit');
    await twoFrames(win);

    // ============================================================================
    // PHASE 0 WIDENING - everything below is APPENDED after the pre-existing
    // matrix on purpose, so no state above can be perturbed by it.
    // ============================================================================

    // ================= SPECTRUM ZOOM (specAvgZoomAt / heatZoomAt) =================
    // All three are synchronous redraws once the payload exists (specZoomButton
    // calls the draw directly); only the DISPLAY switches are async, and those
    // reuse waitSpecIdle.
    await gotoTab(win, 'tab-spectrum', 'panel-spectrum');
    await waitSpecIdle(win, 'average before zoom');
    await win.click('#specAvgZoomIn');
    await twoFrames(win);
    await capture('spectrum:average:zoomed', 'specCanvas');
    await win.click('#specAvgZoomFit');
    await twoFrames(win);

    await win.click('#specDispGram');
    await waitSpecIdle(win, 'spectrogram before zoom');
    await win.click('#specGramZoomIn');
    await twoFrames(win);
    await capture('spectrum:spectrogram:zoomed', 'specCanvas');
    await win.click('#specGramZoomFit');
    await twoFrames(win);

    await win.click('#specDispFk');
    await waitSpecIdle(win, 'f-k before zoom');
    await win.click('#specFkZoomIn');
    await twoFrames(win);
    await capture('spectrum:fk:zoomed', 'specCanvas');
    await win.click('#specFkZoomFit');
    await twoFrames(win);
    await win.click('#specDispAvg');
    await waitSpecIdle(win, 'average return after zoom');

    // ================= TRACE INSPECT: zoom + box-zoom popup =================
    await gotoTab(win, 'tab-trace', 'panel-trace');
    await twoFrames(win);

    // traceZoomAt (anchor family) - synchronous redraw.
    await win.click('#traceZoomIn');
    await twoFrames(win);
    await capture('trace:zoomed', 'traceCanvas');
    await win.click('#traceZoomFit');
    await twoFrames(win);

    // drawZoom, TRACE kind. Arm the magnifier, drag a box, and the popup opens
    // synchronously (openTraceZoom re-windows samples already in memory), so the
    // real signal is "the popup is open AND its canvas has been sized".
    await win.click('#traceBoxZoom');
    await dragBox(win, '#traceCanvas', 0.30, 0.25, 0.72, 0.62);
    await win.waitForFunction(() => {
      const back = document.getElementById('zoomBack');
      const cv = document.getElementById('zoomCanvas');
      return !!back && back.classList.contains('open') && !!cv && cv.width > 0;
    }, null, { timeout: 15000 });
    await twoFrames(win);
    await capture('zoom:trace', 'zoomCanvas');
    // In-popup magnify, trace kind: zoomMagCommit re-windows in place and calls
    // drawZoom BEFORE it rewrites #zoomTitle, so a changed title proves the paint.
    let ztBefore = await win.textContent('#zoomTitle');
    await win.click('#zoomMagIn');
    await waitTextChanged(win, 'zoomTitle', ztBefore, 'trace magnify');
    await capture('zoom:trace:mag', 'zoomCanvas');
    await win.click('#zoomClose');
    await win.click('#traceBoxZoom');   // disarm the magnifier mode
    await twoFrames(win);

    // ================= FILE VIEWER: zoom, box-zoom popup, overlays =================
    await gotoTab(win, 'tab-section', 'panel-section');
    // The File Viewer's gain / AGC / clip / excursion / scale controls live in the
    // collapsed #secDisplayPanel, and the health tools in #secHealthWrap. Playwright
    // will not act on a display:none element, so open both here. The canvas is sized
    // by CSS (height:60vh), so opening a panel moves the canvas DOWN but does not
    // resize it: the captured pixels are unaffected.
    await openSecPanels(win);
    // Pin an explicit display baseline for every state below (the matrix above
    // left #secMode on the last clip-sweep value), so these states do not depend
    // on the order the sweeps happened to finish in.
    await win.selectOption('#secMode', 'vd');
    await win.selectOption('#secColor', 'seismic');
    await win.selectOption('#secScaleMode', 'pct');
    await twoFrames(win);
    await waitSecIdle(win);

    // secZoomAt (anchor family). fetchSectionWindow is ASYNC: it writes #secLabel
    // only AFTER drawSection, so a changed label is a true post-paint signal.
    let secLblBefore = await win.textContent('#secLabel');
    await win.click('#secZoomIn');
    await waitTextChanged(win, 'secLabel', secLblBefore, 'section zoom in');
    await waitSecIdle(win);
    await capture('section:zoomed', 'secCanvas');
    secLblBefore = await win.textContent('#secLabel');
    await win.click('#secZoomFit');
    await waitTextChanged(win, 'secLabel', secLblBefore, 'section zoom fit');
    await waitSecIdle(win);

    // drawZoom, SECTION kind. openSectionZoom re-fetches the boxed sub-window from
    // the worker; #zoomTitle is written after the fetch resolves and the popup is
    // only painted on the following animation frame, so we wait for the popup to
    // be open with a sized canvas AND a real title.
    await win.click('#secBoxZoom');
    await dragBox(win, '#secCanvas', 0.32, 0.22, 0.70, 0.60);
    await win.waitForFunction(() => {
      const back = document.getElementById('zoomBack');
      const cv = document.getElementById('zoomCanvas');
      const t = document.getElementById('zoomTitle')?.textContent || '';
      return !!back && back.classList.contains('open') && !!cv && cv.width > 0 && /^Zoom · traces/.test(t);
    }, null, { timeout: 25000 });
    await twoFrames(win);
    await capture('zoom:section', 'zoomCanvas');
    // In-popup magnify, section kind: zoomMagFetchSection draws and THEN sets the
    // title inside the same loop iteration, so a changed title is post-paint.
    ztBefore = await win.textContent('#zoomTitle');
    await win.click('#zoomMagIn');
    await waitTextChanged(win, 'zoomTitle', ztBefore, 'section magnify');
    await capture('zoom:section:mag', 'zoomCanvas');
    await win.click('#zoomClose');
    await win.click('#secBoxZoom');     // disarm the magnifier mode
    await twoFrames(win);
    await waitSecIdle(win);

    // -- secDrawHealthOverlay (overlay-only draw site) --
    // secRunHealth awaits the worker, then secReclassifyHealth redraws the section
    // WITH the overlay and only then writes #secHealthSummary, so the settled
    // summary is a post-paint signal.
    await win.click('#secHealthBtn');
    await win.waitForFunction(() => {
      const t = document.getElementById('secHealthSummary')?.textContent || '';
      return /flagged \/|no problems|failed|not available/i.test(t);
    }, null, { timeout: 60000 }).catch(() => { throw new Error('health scan did not settle in 60s'); });
    await twoFrames(win);
    const healthSummary = (await win.textContent('#secHealthSummary')) || '';
    const flagged = Number((healthSummary.match(/^(\d+) flagged/) || [])[1] || 0);
    if (flagged > 0) {
      await capture('section:health-overlay', 'secCanvas');
    } else {
      // secDrawHealthOverlay returns on its first line when byAbs is empty, so a
      // zero-flag scan would record a state that does NOT exercise the draw site.
      excluded.push(`section:health-overlay - the scan flagged 0 traces ("${healthSummary.trim()}"), so the overlay draws nothing`);
    }
    await win.click('#secHealthClearBtn');
    await twoFrames(win);
    await waitSecIdle(win);

    // -- secDrawFbOverlay (the other overlay-only draw site) --
    // Entering First-breaks mode shows a sub-bar, which relays out the section
    // canvas; that is real, observable behaviour and the hash records it.
    await win.click('#secFbToggle');
    await win.waitForFunction(() => {
      const bar = document.getElementById('secFbBar');
      return !!bar && bar.style.display !== 'none';
    }, null, { timeout: 10000 });
    await twoFrames(win);
    // Two seeds at fixed plot fractions. fbPlaceSeed redraws synchronously, and a
    // Playwright click moves+presses+releases at one point so the pan guard
    // (moved > 4 px) can never swallow it.
    const secBox = await (async () => {
      const el = win.locator('#secCanvas');
      await el.scrollIntoViewIfNeeded();
      return el.boundingBox();
    })();
    if (!secBox) throw new Error('#secCanvas has no bounding box for first-break seeding');
    const vpH = await win.evaluate(() => window.innerHeight);
    const seedY = (fy) => Math.min(vpH - 4, secBox.y + fy * secBox.height);
    await win.mouse.click(secBox.x + 0.30 * secBox.width, seedY(0.30));
    await twoFrames(win);
    await win.mouse.click(secBox.x + 0.70 * secBox.width, seedY(0.45));
    await twoFrames(win);
    // The shared click plumbing holds a click for one double-click interval (so a
    // double-click fits instead of acting on what the first click made), so give
    // the seeds that long to land before reading the button.
    const seeds = await win.waitForFunction(() =>
      (document.getElementById('secFbFillBtn') || {}).disabled !== true,
      null, { timeout: 5000 }).then(() => true).catch(() => false);
    if (!seeds) {
      excluded.push('section:fb-overlay - two seed clicks did not enable Assisted fill, so no guide/pick overlay was drawn');
    } else {
      await capture('section:fb-seeds', 'secCanvas');
      // secRunFirstBreaks' finally block sets fbPending=false, relabels the button
      // and redraws the section, all synchronously after the await resolves.
      await win.click('#secFbFillBtn');
      await win.waitForFunction(() => {
        const b = document.getElementById('secFbFillBtn');
        const r = document.getElementById('secFbReadout')?.textContent || '';
        return !!b && b.textContent === 'Assisted fill' && /^(Filled|Assisted fill failed)/.test(r);
      }, null, { timeout: 60000 }).catch(() => { throw new Error('assisted fill did not settle in 60s'); });
      await twoFrames(win);
      const fbReadout = (await win.textContent('#secFbReadout')) || '';
      if (/^Filled/.test(fbReadout)) await capture('section:fb-filled', 'secCanvas');
      else excluded.push(`section:fb-filled - assisted fill did not succeed ("${fbReadout.trim()}")`);
      await win.click('#secFbClearBtn');
      await twoFrames(win);
    }
    await win.click('#secFbToggle');    // leave First-breaks mode
    await twoFrames(win);
    await waitSecIdle(win);

    // ================= SWEEPS (drawSweepXY / swBlankCanvas) =================
    // Reachable and deterministic: generateSweep is a pure function of the form,
    // and the form's values are plain HTML defaults (only the named PRESETS are
    // persisted in localStorage, never the live inputs). Every field the sweep
    // depends on is written explicitly anyway, so a stale profile cannot drift it.
    await gotoTab(win, 'tab-sweeps', 'panel-sweeps');
    await win.selectOption('#swType', 'linear').catch(() => {});
    for (const [sel, v] of [
      ['#swF0', '8'], ['#swF1', '96'], ['#swLen', '12000'],
      ['#swTaperIn', '300'], ['#swTaperOut', '300'], ['#swPhase', '0'], ['#swAmp', '1'],
    ]) await win.fill(sel, v);
    await win.selectOption('#swTaperType', 'cosine').catch(() => {});
    await win.click('#swBuildBtn');
    await win.waitForFunction(() => /^Built \d+ samples\./.test(document.getElementById('swStatus')?.textContent || ''),
      null, { timeout: 30000 }).catch(() => { throw new Error('sweep build did not report "Built N samples."'); });
    await twoFrames(win);
    await capture('sweeps:signal', 'swSignalCanvas');
    await capture('sweeps:freq', 'swFreqCanvas');
    await capture('sweeps:spectrum', 'swSpectrumCanvas');
    await capture('sweeps:klauder', 'swKlauderCanvas');

    // boxToWindow (the sweep half of Phase 1 step 1.6): swZoomFromBox maps the
    // drag to a data window and repaints synchronously through swZoomSet.
    await dragBox(win, '#swFreqCanvas', 0.30, 0.30, 0.70, 0.70);
    await twoFrames(win);
    await capture('sweeps:freq:boxzoom', 'swFreqCanvas');

    // swBlankCanvas for the four builder canvases IS reachable now that the Sweeps
    // tab carries its own Clear (#swClearBtn) wired through clearActiveTab(); it used
    // to hang off #headerClearBtn, an element that never existed in the HTML. The
    // OTHER swBlankCanvas caller blanks the QC canvases, which still need a MEASURED
    // sweep file we have no fixture for.
    await win.click('#swClearBtn');
    await twoFrames(win);
    await capture('sweeps:blank:signal', 'swSignalCanvas');
    await capture('sweeps:blank:klauder', 'swKlauderCanvas');
    excluded.push('swBlankCanvas on the QC canvases (sweeps:qc:blank:*) - needs a measured-sweep fixture');

    // ================= HIDDEN-TAB DRAWS (clientWidth === 0 fallbacks) =========
    // LAST, because they deliberately leave the canvases at their fallback size.
    // We are parked on the Sweeps tab, so #panel-section and #panel-trace are
    // display:none and every canvas in them reports clientWidth 0. Neither
    // redrawSection nor renderTrace guards on visibility, so the draw really runs
    // and the `|| 900` / `|| 500` / `|| 800` / `|| 460` fallbacks decide cv.width
    // and cv.height - which is exactly what the hash reads back. Phase 1 must not
    // parameterise those numbers without moving these two hashes.
    const hidden = await win.evaluate(() => ({
      sec: document.getElementById('panel-section')?.style.display,
      trc: document.getElementById('panel-trace')?.style.display,
    }));
    if (hidden.sec !== 'none' || hidden.trc !== 'none') {
      excluded.push('hidden-tab fallback states - the section/trace panels were not hidden as expected');
    } else {
      // paintSection via the #secMode change listener (redrawSection).
      await win.evaluate(() => {
        const s = document.getElementById('secMode');
        s.value = 'wiggle';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await twoFrames(win);
      await capture('section:hidden-fallback', 'secCanvas');
      // drawTraceCore via traceZoomButton -> renderTrace.
      await clickHidden(win, 'traceZoomIn');
      await capture('trace:hidden-fallback', 'traceCanvas');
    }

    // ================= drawSpecEmpty =================
    // LAST capture of the run, and the last one on #specCanvas (see the capture
    // -order note at the top of main). The Spectrum tab's own Clear runs
    // clearSpectrum(), which drops the cached payloads and repaints the empty
    // placeholder; the open seismic file is left untouched. clearSpectrum sets
    // #specLabel AFTER drawSpecEmpty, so the settled label is a post-paint signal.
    await gotoTab(win, 'tab-spectrum', 'panel-spectrum');
    await waitSpecIdle(win, 'average before clear');
    await win.click('#specClearBtn');
    await win.waitForFunction(() =>
      /Open a seismic file to analyse its spectrum/.test(document.getElementById('specLabel')?.textContent || ''),
      null, { timeout: 15000 });
    await twoFrames(win);
    await capture('spectrum:empty', 'specCanvas');

    // ================= NEAR-TRACE GATHER (gatherCanvas) =================
    // Placed at the very END of the run. #gatherCanvas is a brand-new canvas with
    // no earlier capture, and putting its getImageData read-backs after every
    // existing one means it cannot perturb a pre-existing hash (see the capture
    // -order note at the top of main).
    //
    // The gather reads EVERY seismic file in the SEG-Y's folder through the
    // single-threaded worker, so each Run is slow; the completion signal is the
    // panel's own note, which runGather writes AFTER drawGatherPanel.
    await gotoTab(win, 'tab-section', 'panel-section');
    await clickHidden(win, 'secGatherBtn');
    async function runGather(fields) {
      await win.evaluate((f) => {
        for (const [id, v] of Object.entries(f)) {
          const el = document.getElementById(id);
          if (!el) throw new Error('gather control missing: ' + id);
          el.value = v;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, fields);
      await win.evaluate(() => { document.getElementById('gatherNote').textContent = ''; });
      await clickHidden(win, 'gatherRun');
      await win.waitForFunction(() =>
        /records drawn/i.test(document.getElementById('gatherNote')?.textContent || ''),
        null, { timeout: 300000 });
      await twoFrames(win);
    }
    // #secMode was left on 'wiggle' by the hidden-fallback state above, so set it
    // explicitly here rather than inherit whatever ran last.
    async function setSecMode(mode) {
      await win.evaluate((m) => {
        const s = document.getElementById('secMode');
        s.value = m;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, mode);
      await twoFrames(win);
    }
    await setSecMode('vd');
    await runGather({ gatherSelectBy: 'channel', gatherChannel: '12' });
    await capture('gather:by=channel:ch=12:mode=vd', 'gatherCanvas');
    // Same gather matrix, redrawn through the File Viewer's OTHER display modes -
    // this is the assertion that the gather really does go through paintSection.
    await setSecMode('wiggle');
    await capture('gather:by=channel:ch=12:mode=wiggle', 'gatherCanvas');
    await setSecMode('vd');
    // The plain trace-position selector, which needs no header at all.
    await runGather({ gatherSelectBy: 'index', gatherIndex: '0' });
    await capture('gather:by=index:pos=0:mode=vd', 'gatherCanvas');
    await clickHidden(win, 'gatherClose');

    // ================= PER-TRACE ATTRIBUTE PROFILE (secAttrCanvas) =================
    // Also a brand-new canvas, also after every existing capture. Its numbers come
    // from the trace-health scan, and the earlier health step DROPS that scan when
    // nothing was flagged, so run the scan here rather than assume it survived.
    await clickHidden(win, 'secHealthBtn');
    await win.waitForFunction(() =>
      /scanned/i.test(document.getElementById('secHealthSummary')?.textContent || ''),
      null, { timeout: 180000 });
    await twoFrames(win);
    await clickHidden(win, 'secAttrToggle');
    await win.waitForFunction(() => {
      const c = document.getElementById('secAttrCanvas');
      const w = document.getElementById('secAttrWrap');
      return c && c.width > 0 && w && getComputedStyle(w).display !== 'none';
    }, null, { timeout: 60000 });
    await twoFrames(win);
    await capture('section:attr-strip', 'secAttrCanvas');
    // The profile is redrawn by drawSection off the section's OWN plot rectangle,
    // so a data zoom must move it. secZoomAt refetches, and #secLabel is written
    // after the draw, which is the honest post-paint signal.
    const attrLbl = await win.textContent('#secLabel');
    await clickHidden(win, 'secZoomIn');
    await waitTextChanged(win, 'secLabel', attrLbl, 'section zoom for the attribute profile');
    await capture('section:attr-strip:zoomed', 'secAttrCanvas');

    // ================= REDUCED TIME (secCanvas, on an offset-bearing record) ====
    // At the very END of the run, after every other #secCanvas capture, so these
    // read-backs cannot perturb a pre-existing hash (see the capture-order note at
    // the top of main). Reduced time NEEDS the source-receiver offset header, and
    // the file the matrix above uses reports offset 0 on every trace - so this
    // block opens the LE record, which carries real offsets, and covers both the
    // available and the unavailable path.
    if (existsSync(LE)) {
      await openFile(app, win, LE);
      await gotoTab(win, 'tab-section', 'panel-section');
      await waitSecIdle(win);
      await openSecPanels(win);
      await setSecMode('vd');
      const reduceOk = await win.evaluate(() => {
        const el = document.getElementById('secReduce');
        return !!el && !el.disabled;
      });
      if (!reduceOk) {
        excluded.push('section:reduce=* - the LE record reported no usable offset header, so reduced time was unavailable');
      } else {
        await capture('section:reduce=off:offsets:mode=vd', 'secCanvas');
        await win.evaluate(() => {
          const b = document.getElementById('secReduce');
          b.checked = true;
          b.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await twoFrames(win);
        for (const v of ['8', '20']) {
          await win.evaluate((val) => {
            const el = document.getElementById('secReduceVel');
            el.value = val;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, v);
          await twoFrames(win);
          await capture(`section:reduce=on:v=${v}:mode=vd`, 'secCanvas');
        }
        await setSecMode('wiggle');
        await capture('section:reduce=on:v=20:mode=wiggle', 'secCanvas');
        await setSecMode('vd');
        await win.evaluate(() => {
          const b = document.getElementById('secReduce');
          b.checked = false;
          b.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await twoFrames(win);
      }

      // ---- TRACE SPACING BY A HEADER VALUE ----
      // Same record, which carries real offsets AND a channel number, so both the
      // header axis and the raster/wiggle blit paths are exercised. The fallback
      // path is captured afterwards on the SEG-Y the matrix uses, whose offset
      // header is 0 on every trace.
      async function setSpacing(v) {
        await win.evaluate((val) => {
          const el = document.getElementById('secSpacing');
          el.value = val;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, v);
        await twoFrames(win);
      }
      const spacingOk = await win.evaluate(() => !!document.getElementById('secSpacing'));
      if (!spacingOk) {
        excluded.push('section:spacing=* - #secSpacing not found');
      } else {
        await setSecMode('vd');
        await setSpacing('offset');
        await capture('section:spacing=offset:mode=vd', 'secCanvas');
        await setSecMode('wiggle');
        await capture('section:spacing=offset:mode=wiggle', 'secCanvas');
        await setSecMode('vd');
        await setSpacing('channel');
        await capture('section:spacing=channel:mode=vd', 'secCanvas');
        // Both new transforms at once - the reduce runs on the matrix, the spacing
        // on the layout, and they have to compose.
        if (reduceOk) {
          await setSpacing('offset');
          await win.evaluate(() => {
            const b = document.getElementById('secReduce');
            b.checked = true;
            b.dispatchEvent(new Event('change', { bubbles: true }));
          });
          await twoFrames(win);
          await capture('section:spacing=offset:reduce=on:v=20:mode=vd', 'secCanvas');
          await win.evaluate(() => {
            const b = document.getElementById('secReduce');
            b.checked = false;
            b.dispatchEvent(new Event('change', { bubbles: true }));
          });
          await twoFrames(win);
        }
        // The stated fallback: a record whose offset header is 0 on every trace
        // must space evenly and say why on the strip.
        await openFile(app, win, SEGY);
        await gotoTab(win, 'tab-section', 'panel-section');
        await waitSecIdle(win);
        await openSecPanels(win);
        await setSecMode('vd');
        await setSpacing('offset');
        await capture('section:spacing=offset:fallback:mode=vd', 'secCanvas');
        await setSpacing('trace');
      }

      // ---- DISPLAY CLIP x REDUCED TIME, together ----
      // The clip sweep above runs at #secClip 90 and then RESTORES 100, so every
      // reduced-time state captured before this line ran with the clip inactive:
      // the set had no state where a clip below 100 and reduced time were on at
      // once. That was a hole, not a covered case. The clip level is a percentile
      // over the panel and reduced time rewrites the panel, so the hole is exactly
      // where an exposure that moves when it must not can hide - and one did: the
      // level was measured on the SHIFTED matrix, whose zero-fill diluted the
      // percentile and darkened a record nothing had been done to. This state
      // guards the fix. Placed at the very END of the secCanvas captures, per the
      // capture-order rule at the top of this file; the fallback above left the
      // offset-less SEG-Y open, so the offset-bearing record is reopened here.
      if (reduceOk) {
        await openFile(app, win, LE);
        await gotoTab(win, 'tab-section', 'panel-section');
        await waitSecIdle(win);
        await openSecPanels(win);
        await setSecMode('vd');
        await win.fill('#secClip', '90');
        await win.evaluate(() => {
          const el = document.getElementById('secReduceVel');
          el.value = '8';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await win.evaluate(() => {
          const b = document.getElementById('secReduce');
          b.checked = true;
          b.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await twoFrames(win);
        await capture('section:clip=90:reduce=on:v=8:mode=vd', 'secCanvas');
        await win.fill('#secClip', '100');
        await win.evaluate(() => {
          const b = document.getElementById('secReduce');
          b.checked = false;
          b.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await twoFrames(win);
      }
    } else {
      excluded.push('section:reduce=* and section:spacing=* - LE fixture not found');
    }

    console.log(`\nCaptured ${Object.keys(results).length} canvas states.`);
    if (errors.length) {
      console.log(`\nWARNING: ${errors.length} console/page error(s) during the run:`);
      for (const e of errors.slice(0, 20)) console.log('   ' + e);
    }
  } finally {
    await app.close();
  }

  // ================= compare / update =================
  if (UPDATE) {
    writeFileSync(GOLDEN_PATH, JSON.stringify(results, null, 2) + '\n', 'utf8');
    console.log(`\n[UPDATE] wrote ${Object.keys(results).length} golden hashes to ${GOLDEN_PATH}`);
    if (excluded.length) { console.log('\nExcluded from the matrix:'); for (const e of excluded) console.log('  - ' + e); }
    process.exit(0);
  }

  if (!existsSync(GOLDEN_PATH)) {
    console.error(`[FATAL] no golden file at ${GOLDEN_PATH} - run with --update first.`);
    process.exit(2);
  }
  const prior = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));

  const priorKeys = new Set(Object.keys(prior));
  const curKeys = new Set(Object.keys(results));
  for (const key of curKeys) {
    if (!priorKeys.has(key)) { mismatches.push(`NEW STATE (not in golden): ${key}`); continue; }
    const a = prior[key], b = results[key];
    if (a.hash !== b.hash || a.w !== b.w || a.h !== b.h) {
      mismatches.push(`MISMATCH ${key}: golden=${a.hash} (${a.w}x${a.h}) now=${b.hash} (${b.w}x${b.h})`);
    }
  }
  for (const key of priorKeys) {
    if (!curKeys.has(key)) mismatches.push(`MISSING STATE (in golden, not captured this run): ${key}`);
  }

  console.log('\n================= render-golden REPORT =================');
  console.log(`golden states: ${priorKeys.size}   captured states: ${curKeys.size}`);
  if (excluded.length) { console.log('\nExcluded from the matrix:'); for (const e of excluded) console.log('  - ' + e); }
  if (mismatches.length) {
    console.log(`\n${mismatches.length} MISMATCH(ES):`);
    for (const m of mismatches) console.log('  ✗ ' + m);
    console.log('\nRESULT: FAIL');
    process.exit(1);
  }
  console.log('\nRESULT: PASS - every canvas state matches the golden pixel hashes.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[FATAL] render-golden crashed:', e && e.stack ? e.stack : e);
  process.exit(4);
});
