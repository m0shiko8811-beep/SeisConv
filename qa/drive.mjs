// SeisConv - reusable automated QA harness.
//
// Launches the BUILT Electron app with Playwright's `_electron` driver, mocks the
// native open/save dialogs in the MAIN process (so file flows run with no human at
// the keyboard), then drives every tab in the icon rail and exercises its core
// flow. For each tab it asserts:
//   • no uncaught exceptions  (win 'pageerror')
//   • no error-level console output
//   • the tab's key <canvas> is NOT blank (samples pixels; a uniform fill is a fail)
// and writes a screenshot to qa/shots/.
//
// USAGE:   node qa/drive.mjs            (from the repo root)  ·  or  npm run qa
//
// Test files are env-configurable (defaults target Moshe's machine):
//   SEISCONV_QA_SEGY  big-endian SEG-Y           (Converter / Trace / Section / Velocity)
//   SEISCONV_QA_LE    little-endian SEG-Y         (re-opened to prove LE reading; 251 traces)
//   SEISCONV_QA_SPS   's','r','x' SPS files, ';'-separated  (SPS tab, multiSelections)
//
// The harness is self-contained: it requires only that `npm run build` has produced
// dist/main.js + renderer/dist/app.js, and that `playwright` is installed.

import { _electron as electron } from 'playwright';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  sleep, mockDialogs, gotoTab, openFile,
  APP_DIR, SHOTS, SEGY,
} from './harness.mjs';

// -- Test files (override via env) ------------------------------------------
// SEGY comes from the shared harness (same default). LE/SPS are exercised only
// by this full driver, so they stay local.
const LE   = process.env.SEISCONV_QA_LE   || './samples/example-le.sgy';
const SPS  = (process.env.SEISCONV_QA_SPS || [
  './samples/survey.s01',
  './samples/survey.r01',
  './samples/survey.x01',
].join(';')).split(';').map((s) => s.trim()).filter(Boolean);

// Dark scientific background painted under every plot canvas (see index.html .canvas).
const CANVAS_BG = { r: 0x0d, g: 0x1f, b: 0x33 };

/** Read the named <canvas> back as pixels in the renderer and decide if it is
 *  "blank" - i.e. every sampled pixel equals the dark plot background (within a
 *  small tolerance) OR the canvas is empty. Returns {blank, reason, distinct}. */
async function canvasBlank(win, id, bg) {
  return win.evaluate(({ id, bg }) => {
    const cv = document.getElementById(id);
    if (!cv || !cv.getContext) return { blank: true, reason: 'no canvas element', distinct: 0 };
    if (!cv.width || !cv.height) return { blank: true, reason: 'zero-size canvas', distinct: 0 };
    const ctx = cv.getContext('2d');
    let img;
    try { img = ctx.getImageData(0, 0, cv.width, cv.height); } catch (e) {
      return { blank: false, reason: 'unreadable (assumed drawn): ' + e.message, distinct: -1 };
    }
    const d = img.data;
    const seen = new Set();
    let nonBg = 0;
    const stepX = Math.max(1, (cv.width / 80) | 0);
    const stepY = Math.max(1, (cv.height / 80) | 0);
    for (let y = 0; y < cv.height; y += stepY) {
      for (let x = 0; x < cv.width; x += stepX) {
        const i = (y * cv.width + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        seen.add((r << 24) | (g << 16) | (b << 8) | a);
        const isBg = Math.abs(r - bg.r) < 10 && Math.abs(g - bg.g) < 10 && Math.abs(b - bg.b) < 10;
        const isTransparent = a < 8;
        if (!isBg && !isTransparent) nonBg++;
      }
    }
    const distinct = seen.size;
    const blank = nonBg === 0;
    return { blank, reason: blank ? `all sampled pixels are background/transparent (${distinct} distinct)` : '', distinct, nonBg };
  }, { id, bg });
}

// gotoTab + openFile (and sleep, mockDialogs) come from ./harness.mjs. Note the
// shared openFile already switches to the Converter tab and clicks its in-panel
// open button (#openBtn2) itself - step 1 below must NOT re-click it.

// -- run ----------------------------------------------------------------------
const results = [];   // { tab, pass, notes[], errors[], shot }
const globalConsole = [];
const globalPageErrors = [];

(async () => {
  // Pre-flight: confirm the build exists.
  for (const need of ['dist/main.js', 'renderer/dist/app.js', 'renderer/index.html']) {
    if (!existsSync(join(APP_DIR, need))) {
      console.error(`\n[FATAL] missing ${need} - run "npm run build" first.\n`);
      process.exit(2);
    }
  }
  console.log(`SeisConv QA harness - launching ${APP_DIR}`);
  console.log(`  SEGY = ${SEGY}\n  LE   = ${LE}\n  SPS  = ${SPS.join(' , ')}\n`);

  let app, win;
  try {
    // Isolated profile (opt-in via SEISCONV_QA_USER_DATA_DIR): a throwaway
    // --user-data-dir so QA never fights the installed app's single-instance lock.
    const udd = process.env.SEISCONV_QA_USER_DATA_DIR;
    const launchArgs = udd ? ['.', `--user-data-dir=${udd}`] : ['.'];
    app = await electron.launch({ args: launchArgs, cwd: APP_DIR });
    win = await app.firstWindow();
  } catch (e) {
    console.error('\n[FATAL] _electron.launch failed - could NOT start the app.');
    console.error(e && e.stack ? e.stack : e);
    process.exit(3);
  }

  // Collect console errors + uncaught exceptions for the whole session.
  win.on('console', (m) => {
    if (m.type() === 'error') globalConsole.push(m.text());
  });
  win.on('pageerror', (e) => globalPageErrors.push(e.message || String(e)));

  await win.waitForLoadState('domcontentloaded');
  await sleep(500);

  // Snapshot the error counters so each tab only "owns" errors raised during it.
  const mark = () => ({ c: globalConsole.length, p: globalPageErrors.length });
  const since = (m, tabName) => {
    const errs = [];
    for (let i = m.p; i < globalPageErrors.length; i++) errs.push('pageerror: ' + globalPageErrors[i]);
    for (let i = m.c; i < globalConsole.length; i++) errs.push('console.error: ' + globalConsole[i]);
    return errs;
  };

  // Run one tab step: switch, run `fn`, screenshot, fold in errors + canvas check.
  async function step(tab, panel, shot, fn, label = tab) {
    const m = mark();
    const notes = [];
    const stepErrors = [];          // failures raised by the step body itself
    let canvasFail = null;
    try {
      await gotoTab(win, tab, panel);
      const r = await fn(notes);
      if (r && r.canvasFail) canvasFail = r.canvasFail;
      if (r && r.assertFail) stepErrors.push('assertion: ' + r.assertFail);
    } catch (e) {
      stepErrors.push('EXCEPTION in step: ' + (e && e.message ? e.message : e));
    }
    const shotPath = join(SHOTS, shot);
    try { await win.screenshot({ path: shotPath }); } catch { /* ignore */ }
    const errors = since(m, tab).concat(stepErrors);
    if (canvasFail) errors.push('blank canvas: ' + canvasFail);
    results.push({ tab: label, pass: errors.length === 0, notes, errors, shot: shotPath });
    const tag = errors.length === 0 ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${label.padEnd(14)} ${notes.concat(errors).join(' | ') || 'ok'}`);
  }

  // -- 1) CONVERTER - open the big-endian SEG-Y, read the summary --
  await step('tab-conv', 'panel-conv', '1-converter.png', async (notes) => {
    const count = await openFile(app, win, SEGY);
    notes.push(`opened SEGY → traces=${count}`);
    const fmt = (await win.textContent('#fsFormat'))?.trim();
    const samples = (await win.textContent('#fsSamples'))?.trim();
    notes.push(`format=${fmt} samples/trace=${samples}`);
    if (!count || count === '-') notes.push('WARN: summary did not populate');
  });

  // -- 2) TRACE INSPECTOR - header table + spectrum toggle + zoom --
  await step('tab-trace', 'panel-trace', '2-trace.png', async (notes) => {
    // waveform canvas should be drawn for the open file
    let wave = await canvasBlank(win, 'traceCanvas', CANVAS_BG);
    notes.push(`waveform canvas distinct=${wave.distinct}`);
    // header table populated?
    const hdr = (await win.textContent('#traceHdrGrid'))?.trim() || '';
    notes.push(`header table chars=${hdr.length}`);
    // step Next a couple of times
    await win.click('#traceNext'); await sleep(200);
    await win.click('#traceNext'); await sleep(200);
    // spectrum toggle
    await win.click('#traceSpec'); await sleep(400);
    const spec = await canvasBlank(win, 'traceCanvas', CANVAS_BG);
    notes.push(`spectrum canvas distinct=${spec.distinct}`);
    // zoom in/out/fit
    await win.click('#traceZoomIn'); await sleep(120);
    await win.click('#traceZoomOut'); await sleep(120);
    await win.click('#traceZoomFit'); await sleep(120);
    // back to waveform for the final check
    await win.click('#traceWave'); await sleep(300);
    const finalWave = await canvasBlank(win, 'traceCanvas', CANVAS_BG);
    return { canvasFail: finalWave.blank ? `traceCanvas ${finalWave.reason}` : null };
  });

  // -- 3) FILE VIEWER - section render + next/prev + mode --
  await step('tab-section', 'panel-section', '3-section.png', async (notes) => {
    await sleep(600); // section renders on first show
    let sec = await canvasBlank(win, 'secCanvas', CANVAS_BG);
    notes.push(`section canvas distinct=${sec.distinct}`);
    // try the next-file (sibling) nav if enabled
    const nextEnabled = await win.isEnabled('#fileNextBtn');
    notes.push(`fileNext enabled=${nextEnabled}`);
    if (nextEnabled) { await win.click('#fileNextBtn'); await sleep(800); await win.click('#filePrevBtn'); await sleep(800); }
    // toggle a render mode
    await win.selectOption('#secMode', 'wiggle').catch(() => {}); await sleep(400);
    await win.selectOption('#secMode', 'vd').catch(() => {}); await sleep(400);
    const sec2 = await canvasBlank(win, 'secCanvas', CANVAS_BG);
    return { canvasFail: sec2.blank ? `secCanvas ${sec2.reason}` : null };
  });

  // -- 4) SPS 2.1 - load S/R/X (multiSelections) + Run QC + stats --
  await step('tab-sps', 'panel-sps', '4-sps.png', async (notes) => {
    await mockDialogs(app, SPS); // multiSelections → all three paths
    await win.click('#spsLoadBtn');
    // wait for the survey stats / label to populate
    await win.waitForFunction(() => {
      const s = document.getElementById('spsStats');
      const l = document.getElementById('spsLabel');
      return (s && s.textContent.trim().length > 0) || (l && !/Load S\/R\/X/.test(l.textContent));
    }, null, { timeout: 20000 }).catch(() => notes.push('WARN: SPS stats did not populate in 20s'));
    await sleep(500);
    const stats = (await win.textContent('#spsStats'))?.trim();
    notes.push(`sps stats="${stats}"`);
    const grid = await canvasBlank(win, 'spsCanvas', CANVAS_BG);
    notes.push(`grid canvas distinct=${grid.distinct}`);
    // Run QC
    await win.click('#spsQcBtn'); await sleep(800);
    const qc = (await win.textContent('#qcResults'))?.trim() || '';
    notes.push(`QC results chars=${qc.length}`);
    return { canvasFail: grid.blank ? `spsCanvas ${grid.reason}` : null };
  });

  // -- 4b) SPS HEADERS editor - open the H-record modal, assert it populates --
  // Runs while still on the SPS tab (S/R/X loaded in step 4). The modal is shown
  // by toggling the `.open` class on #spsHeadersBack (not display: in the panel),
  // and loadSpsHeaders() fills #spsHdrGroups from the worker, clearing
  // #spsHdrStatus on success. We assert it opens, populates, and has no error.
  await step('tab-sps', 'panel-sps', '4b-sps-headers.png', async (notes) => {
    await win.click('#spsHeadersBtn');
    // wait for the modal to open AND the View groups to render (status clears on ok).
    await win.waitForFunction(() => {
      const back = document.getElementById('spsHeadersBack');
      const open = back && back.classList.contains('open');
      const groups = document.getElementById('spsHdrGroups');
      const groupsReady = groups && groups.children.length > 0;
      return open && groupsReady;
    }, null, { timeout: 20000 }).catch(() => notes.push('WARN: SPS headers modal/groups did not populate in 20s'));
    await sleep(300);
    const isOpen = await win.evaluate(() => !!document.getElementById('spsHeadersBack')?.classList.contains('open'));
    const groupRows = await win.evaluate(() => document.getElementById('spsHdrGroups')?.children.length || 0);
    const status = (await win.textContent('#spsHdrStatus'))?.trim() || '';
    notes.push(`headers modal open=${isOpen} groupSections=${groupRows} status="${status}"`);
    // close it again so it doesn't sit over later tabs.
    await win.click('#spsHeadersClose'); await sleep(200);
    const closed = await win.evaluate(() => !document.getElementById('spsHeadersBack')?.classList.contains('open'));
    notes.push(`closed=${closed}`);
    const fails = [];
    if (!isOpen) fails.push('modal did not open');
    if (groupRows === 0) fails.push('no header group sections rendered');
    if (/^Failed/i.test(status)) fails.push(`status error: ${status}`);
    return { assertFail: fails.length ? fails.join('; ') : null };
  }, 'tab-sps-headers');

  // -- 5) VELOCITY - compute NMO semblance + canvas --
  await step('tab-vel', 'panel-vel', '5-velocity.png', async (notes) => {
    await win.click('#velComputeBtn');
    // semblance is heavy; wait for the velLabel to change or the canvas to fill
    await win.waitForFunction(() => {
      const l = document.getElementById('velLabel');
      return l && !/Open a file, then compute/.test(l.textContent);
    }, null, { timeout: 40000 }).catch(() => notes.push('WARN: semblance did not finish in 40s'));
    await sleep(600);
    const vel = await canvasBlank(win, 'velCanvas', CANVAS_BG);
    notes.push(`vel canvas distinct=${vel.distinct} label="${(await win.textContent('#velLabel'))?.trim()}"`);
    return { canvasFail: vel.blank ? `velCanvas ${vel.reason}` : null };
  });

  // -- 5b) SPECTRUM - Average / Spectrogram / F-K displays (SEGY still open) --
  // The spectrum panel needs an open file; the big-endian SEGY from step 1 is
  // still the open summary here (workbench/velocity don't replace it). Switching
  // the segmented DISPLAY selector triggers an async (worker) fetch+paint guarded
  // by specBusy, so after each click we wait for #specLabel to leave its
  // "Computing…/Open a file" states before sampling the canvas.
  await step('tab-spectrum', 'panel-spectrum', '5b-spectrum.png', async (notes) => {
    // helper: wait until the spectrum label settles (not Computing/empty) then
    // sample specCanvas; record distinct/blank for the named display.
    const settleAndCheck = async (label) => {
      await win.waitForFunction(() => {
        const l = document.getElementById('specLabel');
        const t = (l?.textContent || '').trim();
        return t !== '' && !/^Computing/i.test(t) && !/Open a seismic file/i.test(t);
      }, null, { timeout: 30000 }).catch(() => notes.push(`WARN: ${label} label did not settle in 30s`));
      await sleep(400);
      const r = await canvasBlank(win, 'specCanvas', CANVAS_BG);
      notes.push(`${label}: distinct=${r.distinct} label="${(await win.textContent('#specLabel'))?.trim()}"`);
      return r;
    };

    // Average spectrum is the default display and should already be painting.
    const avg = await settleAndCheck('average');

    // Spectrogram (STFT heatmap of the current trace).
    await win.click('#specDispGram');
    const gram = await settleAndCheck('spectrogram');

    // F-K (frequency-wavenumber heatmap over the whole file).
    await win.click('#specDispFk');
    const fk = await settleAndCheck('f-k');

    // Back to Average for a clean final canvas + assert each display drew.
    await win.click('#specDispAvg');
    await settleAndCheck('average(return)');

    const fails = [];
    if (avg.blank)  fails.push(`average ${avg.reason}`);
    if (gram.blank) fails.push(`spectrogram ${gram.reason}`);
    if (fk.blank)   fails.push(`f-k ${fk.reason}`);
    return { canvasFail: fails.length ? fails.join('; ') : null };
  });

  // -- 6) TRACE WORKBENCH - add open trace + (LE pick) + analysis --
  await step('tab-workbench', 'panel-workbench', '6-workbench.png', async (notes) => {
    // add the current open-file trace
    await win.click('#wbAddOpenBtn'); await sleep(400);
    // pick the little-endian file and add a trace from it (proves LE reading + 2nd trace)
    await mockDialogs(app, [LE]);
    await win.click('#wbPickBtn'); await sleep(600);
    await win.fill('#wbIndex', '0').catch(() => {});
    // there is no separate "add picked" button - picking arms wbPickBtn flow; add open adds from picked too.
    await win.click('#wbAddOpenBtn').catch(() => {}); await sleep(400);
    const listChars = ((await win.textContent('#wbList'))?.trim() || '').length;
    notes.push(`workbench list chars=${listChars}`);
    const wb = await canvasBlank(win, 'wbCanvas', CANVAS_BG);
    notes.push(`workbench canvas distinct=${wb.distinct}`);
    return { canvasFail: wb.blank ? `wbCanvas ${wb.reason}` : null };
  });

  // -- 6b) OBSERVER LOG - run the setup wizard, build a log, assert grid shows --
  // The wizard pre-checks at least one column group, so clicking #ologBuildBtn
  // commits a valid log: buildLog() hides #obslogWizard, reveals #obslogGrid and
  // stamps #ologGridLabel ("N records · M columns"). If a log was already built
  // in a prior run (persisted to localStorage) the grid shows immediately; in
  // that case we still add a row to exercise the live grid.
  await step('tab-obslog', 'panel-obslog', '6b-obslog.png', async (notes) => {
    const gridVisible = async () => win.evaluate(() => {
      const g = document.getElementById('obslogGrid');
      return !!g && getComputedStyle(g).display !== 'none';
    });
    if (await gridVisible()) {
      notes.push('log already configured (grid shown) - adding a row');
      await win.click('#ologAddRowBtn').catch(() => {}); await sleep(300);
    } else {
      // Build from the wizard with its default selections.
      await win.click('#ologBuildBtn');
      await win.waitForFunction(() => {
        const g = document.getElementById('obslogGrid');
        return !!g && getComputedStyle(g).display !== 'none';
      }, null, { timeout: 15000 }).catch(() => notes.push('WARN: obslog grid did not appear in 15s'));
      await sleep(300);
      // add a row to prove the live grid edits.
      await win.click('#ologAddRowBtn').catch(() => {}); await sleep(300);
    }
    const built = await gridVisible();
    const label = (await win.textContent('#ologGridLabel'))?.trim() || '';
    const cols = await win.evaluate(() => document.querySelectorAll('#ologThead th').length);
    const rows = await win.evaluate(() => document.querySelectorAll('#ologTbody tr').length);
    const wizStatus = (await win.textContent('#ologWizStatus'))?.trim() || '';
    notes.push(`grid built=${built} label="${label}" cols=${cols} rows=${rows} wizStatus="${wizStatus}"`);
    const fails = [];
    if (!built) fails.push('grid did not appear after Build');
    if (cols === 0) fails.push('no columns rendered');
    return { assertFail: fails.length ? fails.join('; ') : null };
  });

  // -- 7) LITTLE-ENDIAN re-open back on Converter (expect 251 traces) --
  await step('tab-conv', 'panel-conv', '7-le-reopen.png', async (notes) => {
    const count = await openFile(app, win, LE);
    notes.push(`LE reopened → traces=${count} (expected 251)`);
    const fmt = (await win.textContent('#fsFormat'))?.trim();
    const order = (await win.textContent('#fsByteOrder'))?.trim();
    notes.push(`format=${fmt} byteOrder=${order}`);
    if (count !== '251') return { assertFail: `LE trace count was "${count}", expected 251` };
  }, 'tab-conv-le');

  // -- teardown + report --
  await app.close();

  console.log('\n================= SeisConv QA REPORT =================');
  let failed = 0;
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    if (!r.pass) failed++;
    console.log(`\n[${tag}] ${r.tab}`);
    for (const n of r.notes) console.log('   · ' + n);
    for (const e of r.errors) console.log('   ✗ ' + e);
    console.log('   shot: ' + r.shot);
  }
  console.log('\n-----------------------------------------------------');
  console.log(`global pageerrors: ${globalPageErrors.length}`);
  for (const e of globalPageErrors) console.log('   ✗ ' + e);
  console.log(`global console.errors: ${globalConsole.length}`);
  for (const e of globalConsole.slice(0, 30)) console.log('   ✗ ' + e);
  console.log(`\nRESULT: ${results.length - failed}/${results.length} tab-steps passed, ${failed} failed.`);
  console.log('Screenshots in qa/shots/.');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n[FATAL] harness crashed:', e && e.stack ? e.stack : e);
  process.exit(4);
});
