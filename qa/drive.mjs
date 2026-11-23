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
//   SEISCONV_QA_SEGD  a real SEG-D for the batch step (else the first .segd in the
//                     `fuzzData` folder; with neither, the batch step skips)
//
// The harness is self-contained: it requires only that `npm run build` has produced
// dist/main.js + renderer/dist/app.js, and that `playwright` is installed.

import { _electron as electron } from 'playwright';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import {
  sleep, mockDialogs, gotoTab, openFile,
  APP_DIR, SHOTS, SEGY, sample, qaPath, qaPaths,
  launchEnv,
} from './harness.mjs';
import { resolveValue } from './local-paths.mjs';
import JSZip from 'jszip';

// -- Test files (override via env) ------------------------------------------
// SEGY comes from the shared harness. LE/SPS are exercised only by this full
// driver, so their defaults stay here - same env > qa/local-paths.json > default
// resolution (see harness qaPath/qaPaths).
const LE   = qaPath('le', sample('example-le.sgy'));
const SPS  = qaPaths('sps', [
  sample('example.s01'),
  sample('example.r01'),
  sample('example.x01'),
]);

// A real SEG-D for the batch step: the `segd` key (SEISCONV_QA_SEGD) if set, else
// the first .segd/.sgd directly in the `fuzzData` folder (SEISCONV_FUZZ_DATA). ''
// when neither is configured; the batch step then SKIPs instead of failing.
function findSegd() {
  const direct = resolveValue('segd', 'SEISCONV_QA_SEGD', '');
  if (direct) return direct;
  const root = resolveValue('fuzzData', 'SEISCONV_FUZZ_DATA', '');
  if (!root || !existsSync(root)) return '';
  try {
    const hit = readdirSync(root).filter((n) => /\.(segd|sgd)$/i.test(n)).sort()[0];
    return hit ? join(root, hit) : '';
  } catch { return ''; }
}
const SEGD = findSegd();

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
  console.log(`  SEGY = ${SEGY}\n  LE   = ${LE}\n  SPS  = ${SPS.join(' , ')}\n  SEGD = ${SEGD || '(not configured: batch step skips)'}\n`);

  let app, win;
  try {
    // Isolated profile (opt-in via SEISCONV_QA_USER_DATA_DIR): a throwaway
    // --user-data-dir so QA never fights the installed app's single-instance lock.
    const udd = process.env.SEISCONV_QA_USER_DATA_DIR;
    const launchArgs = udd ? ['.', `--user-data-dir=${udd}`] : ['.'];
    app = await electron.launch({ args: launchArgs, cwd: APP_DIR, env: launchEnv() });
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

  // -- 4c) SPS CREATION - seed a REAL coordinate CSV out of the survey loaded in
  // step 4, then import it back through the column-mapping wizard. Self-seeding
  // because the configured SPS input is a triplet with no CSV beside it, and
  // using the app's own coordcsv writer means
  // the fixture is real ITM/UTM survey data rather than a synthetic stub.
  //
  // The overlay assertion works with NO network: canvasBlank counts alpha < 8 as
  // transparent, so an untouched overlay reads blank and a drawn plan does not -
  // the basemap tiles are irrelevant to the verdict.
  const PLAN_CSV = join(tmpdir(), 'seisconv_qa_plan.csv');
  await step('tab-sps', 'panel-sps', '4c-plan-seed.png', async (notes) => {
    rmSync(PLAN_CSV, { force: true });
    await win.selectOption('#spsExpFormat', 'coordcsv');
    await app.evaluate(async ({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, PLAN_CSV);
    await win.click('#spsExpFormatBtn');
    await sleep(2500);
    const wrote = existsSync(PLAN_CSV);
    notes.push(`seed coordcsv written=${wrote}`);
    // On a PROFILE WITH NO SIGNATURE (a clean machine, or a QA run with its own
    // --user-data-dir) the first audited action opens the full-viewport audit modal,
    // which then covers the rail and makes every later step time out. Sign once here.
    await win.evaluate(() => {
      const inp = document.getElementById('auditSigInput');
      if (inp && !inp.value) inp.value = 'QA harness';
      if (document.getElementById('auditBack')?.classList.contains('open')) {
        document.getElementById('auditSigSave')?.click();
        document.getElementById('auditBack')?.classList.remove('open');
      }
    });
    await sleep(200);
    return { assertFail: wrote ? null : 'the coordcsv export did not write the seed file' };
  }, 'tab-sps-coordcsv');

  await step('tab-spscreate', 'panel-spscreate', '4d-sps-create.png', async (notes) => {
    const fails = [];
    await mockDialogs(app, [PLAN_CSV]);
    await win.click('#spsPlanImportBtn');
    await win.waitForFunction(() => document.getElementById('planImportBack')?.classList.contains('open'), null, { timeout: 10000 })
      .catch(() => notes.push('WARN: the import wizard did not open in 10s'));
    await win.click('#piPickFile');
    await win.waitForFunction(() => (document.getElementById('piMapRows')?.querySelectorAll('.pi-maprow').length || 0) > 0, null, { timeout: 15000 })
      .catch(() => notes.push('WARN: the column mapping did not populate in 15s'));

    const cols = await win.evaluate(() => document.getElementById('piMapRows')?.querySelectorAll('.pi-maprow').length || 0);
    const mapping = await win.evaluate(() => [...(document.getElementById('piMapRows')?.querySelectorAll('select') || [])].map((s) => s.value).join(','));
    const projOn = await win.evaluate(() => !!document.getElementById('piKindProj')?.classList.contains('on'));
    const crsTxt = (await win.textContent('#piCrsBtn'))?.trim() || '';
    const seedTag = existsSync(PLAN_CSV) ? (readFileSync(PLAN_CSV, 'utf8').match(/EPSG:\d+/i)?.[0] || '') : '';
    const gated = await win.evaluate(() => !!document.getElementById('piImport')?.disabled);
    notes.push(`columns=${cols} mapping=${mapping}`);
    notes.push(`projDetected=${projOn} crs="${crsTxt}" fileTag="${seedTag}"`);
    notes.push(`Import gated before a role is chosen=${gated}`);
    if (cols === 0) fails.push('the column mapping did not populate');
    if (!projOn) fails.push('projected coordinates were not auto-detected from an E/N coordcsv');
    if (seedTag && !crsTxt.includes(seedTag)) fails.push(`the file's ${seedTag} tag was not adopted (wizard shows "${crsTxt}")`);
    if (!/\bline\b/.test(mapping) || !/\bstation\b/.test(mapping)) fails.push(`line/station were not guessed: ${mapping}`);
    if (!gated) fails.push('Import was enabled before a role was chosen');

    await win.selectOption('#piRole', 'R');
    await sleep(300);
    await win.click('#piImport');
    await win.waitForFunction(() => !document.getElementById('planImportBack')?.classList.contains('open'), null, { timeout: 30000 })
      .catch(() => notes.push('WARN: the import did not finish in 30s'));
    await sleep(900);

    const count = (await win.textContent('#spsPlanCount'))?.trim() || '';
    const domRows = await win.evaluate(() => document.querySelectorAll('#spsPlanTblBody .plan-row').length);
    const legendRows = await win.evaluate(() => document.querySelectorAll('#spsPlanLegend .plan-lg').length);
    notes.push(`plan="${count}" tableRowsInDom=${domRows} legendRows=${legendRows}`);
    if (!/[1-9]/.test(count)) fails.push(`the plan is empty after import: "${count}"`);
    if (domRows === 0) fails.push('the point table rendered no rows');
    if (domRows > 80) fails.push(`virtualization broke: ${domRows} rows in the DOM`);
    if (legendRows === 0) fails.push('the legend rendered no lines');

    await win.click('#spsPlanFit');
    await sleep(900);
    const overlay = await canvasBlank(win, 'spsPlanCanvas', CANVAS_BG);
    notes.push(`plan overlay distinct=${overlay.distinct} reason=${overlay.reason || '-'}`);
    return {
      assertFail: fails.length ? fails.join('; ') : null,
      canvasFail: overlay.blank ? `spsPlanCanvas ${overlay.reason}` : null,
    };
  });

  // -- 5) VELOCITY - compute NMO semblance + canvas --
  await step('tab-vel', 'panel-vel', '5-velocity.png', async (notes) => {
    await win.click('#velComputeBtn');
    // Semblance is heavy. Wait for it to FINISH, not merely to start: the label passes
    // through "Computing..." on the way, and treating that as done made this step report a
    // blank canvas whenever semblance took longer than the settle sleep below. That is a
    // flaky gate, which is worse than no gate, because it cannot tell a real regression
    // from a slow machine.
    await win.waitForFunction(() => {
      const l = document.getElementById('velLabel');
      if (!l) return false;
      const t = l.textContent || '';
      return !/Open a file, then compute/.test(t) && !/Computing/i.test(t);
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
    await win.fill('#wbIndex', '1').catch(() => {});
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

  // -- 8) BATCH CONVERTER - folder pick, convert, no-overwrite, empty folder --
  // Real files are COPIED into a fresh temp dir (originals never touched): a SEG-Y
  // and a SEG-D in one input folder, a separate output folder, and a folder holding
  // only a subfolder. Runs after 4c, which signed the audit prompt the first
  // successful batch would otherwise raise over the window.
  await step('tab-conv', 'panel-conv', '8-batch.png', async (notes) => {
    if (!existsSync(SEGY) || !SEGD || !existsSync(SEGD)) {
      notes.push(`SKIP: needs a real SEG-Y and SEG-D (segy="${SEGY}", segd="${SEGD || 'not configured'}")`);
      return;
    }
    const fails = [];
    const root = mkdtempSync(join(tmpdir(), 'seisconv_qa_batch_'));
    try {
      const inDir = join(root, 'in');
      const outDir = join(root, 'out');
      const emptyDir = join(root, 'only_a_subfolder');
      mkdirSync(inDir); mkdirSync(outDir); mkdirSync(join(emptyDir, 'sub'), { recursive: true });
      const inputs = [SEGY, SEGD].map((p) => { const dst = join(inDir, basename(p)); copyFileSync(p, dst); return dst; });
      copyFileSync(SEGY, join(emptyDir, 'sub', basename(SEGY))); // a seismic file, but one level down
      const stem = (p) => basename(p).replace(/\.[^.]+$/, '');
      // Each showOpenDialog answers the next folder in the queue (folder pick, then
      // destination pick); the last answer repeats.
      const answerDirs = (dirs) => app.evaluate(async ({ dialog }, q) => {
        const queue = [...q];
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.length > 1 ? queue.shift() : queue[0]] });
      }, dirs);
      const statusText = async () => ((await win.textContent('#batchStatus')) || '').trim();
      const listOut = () => readdirSync(outDir).sort();

      await win.click('#modeBatch'); await sleep(250);
      // A known template ({name}) and SEG-Y Rev 1, so the expected names are fixed.
      await win.evaluate(() => { const t = document.getElementById('outNameTpl'); if (t) { t.value = '{name}'; t.dispatchEvent(new Event('input')); } });
      await win.click('#fmtChipsBatch [data-fmt="segy1"]'); await sleep(150);
      await answerDirs([inDir, outDir]);
      await win.click('#pickFolderBtn');
      await win.waitForFunction(() => !document.getElementById('batchFound')?.classList.contains('hidden'), null, { timeout: 10000 }).catch(() => {});
      const found = ((await win.textContent('#batchCount')) || '').trim();
      notes.push(`folder pick found=${found}`);
      if (found !== '2') fails.push(`expected 2 files found, got "${found}"`);
      await win.click('#pickOutBtn');
      await win.waitForFunction(() => !document.getElementById('runBatchBtn')?.disabled, null, { timeout: 10000 }).catch(() => {});

      // Run 1: both convert, each output named after its input.
      await win.click('#runBatchBtn');
      await win.waitForFunction(() => /Converted \d+ file/.test(document.getElementById('batchStatus')?.textContent || ''), null, { timeout: 60000 })
        .catch(() => fails.push('run 1 did not report success in 60s'));
      const s1 = await statusText();
      const want = inputs.map((p) => `${stem(p)}.sgy`).sort();
      const after1 = listOut();
      notes.push(`run 1 status="${s1.slice(0, 40)}" outputs=${after1.length}`);
      if (!/Converted 2 files/.test(s1)) fails.push(`run 1 status: "${s1}"`);
      for (const w of want) if (!after1.includes(w)) fails.push(`run 1 did not write ${w}`);
      const before = Object.fromEntries(want.map((w) => { const s = statSync(join(outDir, w)); return [w, `${s.size}/${s.mtimeMs}`]; }));

      // Run 2 into the same folder: nothing replaced, the new files get _2 names.
      await sleep(1100); // a rewrite would move mtime past filesystem granularity
      await win.click('#runBatchBtn');
      await win.waitForFunction(() => /Converted \d+ file.*new name/.test(document.getElementById('batchStatus')?.textContent || ''), null, { timeout: 60000 })
        .catch(() => fails.push('run 2 did not report its renamed outputs in 60s'));
      const after2 = listOut();
      const want2 = inputs.map((p) => `${stem(p)}_2.sgy`);
      notes.push(`run 2 outputs=${after2.length}`);
      for (const w of want2) if (!after2.includes(w)) fails.push(`run 2 did not write ${w}`);
      for (const w of want) {
        const s = statSync(join(outDir, w));
        if (`${s.size}/${s.mtimeMs}` !== before[w]) fails.push(`run 2 changed the existing ${w}`);
      }
      const rowSaysSavedAs = await win.evaluate(() => /saved as/.test(document.getElementById('batchFileList')?.textContent || ''));
      if (!rowSaysSavedAs) fails.push('the file rows do not show the "saved as" name');
      await win.locator('#batchStatus').scrollIntoViewIfNeeded().catch(() => {});
      await win.screenshot({ path: join(SHOTS, '8-batch-rerun.png') }).catch(() => {});

      // A folder holding only a subfolder: say so, hide the found banner, keep Convert off.
      await answerDirs([emptyDir]);
      await win.click('#pickFolderBtn');
      await win.waitForFunction(() => /No seismic files found directly in/.test(document.getElementById('batchStatus')?.textContent || ''), null, { timeout: 10000 })
        .catch(() => fails.push('no "No seismic files" message for a folder with only a subfolder'));
      const emptyState = await win.evaluate(() => ({
        foundHidden: !!document.getElementById('batchFound')?.classList.contains('hidden'),
        runDisabled: !!document.getElementById('runBatchBtn')?.disabled,
      }));
      notes.push(`empty folder: foundHidden=${emptyState.foundHidden} runDisabled=${emptyState.runDisabled}`);
      if (!emptyState.foundHidden) fails.push('#batchFound still visible after an empty-folder pick');
      if (!emptyState.runDisabled) fails.push('Convert still enabled after an empty-folder pick');
      await sleep(200);
    } finally {
      // Remove the temp copies whatever happened above (step() screenshots after this).
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    return { assertFail: fails.length ? fails.join('; ') : null };
  }, 'tab-conv-batch');

  // -- 9) PARAMETERS SHEET - fill a known job + logo, save the XLSX OFFLINE, read it
  //       back, then RELAUNCH the app and prove the sheet starts empty --
  // Every tile fetch in MAIN is made to fail (globalThis.fetch replaced for the
  // step, restored after), so this proves the "never fail the export because of
  // tiles" path: the workbook must still carry the Map sheet with a grey map and
  // the offline note. The logo is GENERATED here (a 120 x 60 PNG drawn with
  // nativeImage in main), so no binary is committed. The save dialog answers a temp
  // path; the file is unzipped and checked cell by cell, then removed. Last, the
  // app is closed and reopened on the same profile: nothing typed (fields, lines,
  // coordinates, logo) may survive a restart (Moshe, 23.11.2026).
  await step('tab-paramsheet', 'panel-paramsheet', '9-paramsheet.png', async (notes) => {
    const fails = [];
    const root = mkdtempSync(join(tmpdir(), 'seisconv_qa_ps_'));
    const out = join(root, 'qa_parameter_sheet.xlsx');
    const logoPath = join(root, 'qa_logo.png');
    const newSheet = async () => {
      await win.click('#psNewBtn');
      await win.waitForSelector('#confirmBack.open', { timeout: 5000 }).catch(() => {});
      await win.click('#confirmOk').catch(() => {});
      await sleep(250);
    };
    const fill = async (id, v) => { await win.fill('#' + id, String(v)); await win.locator('#' + id).dispatchEvent('change'); };
    try {
      // A small two-colour logo, encoded by Electron itself.
      await app.evaluate(async ({ nativeImage }) => {
        const w = 120, h = 60, bgra = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4, left = x < w / 2;
          bgra[o] = left ? 0x99 : 0x2a; bgra[o + 1] = left ? 0x4e : 0xa0; bgra[o + 2] = left ? 0x1f : 0xe6; bgra[o + 3] = 255;
        }
        return nativeImage.createFromBitmap(bgra, { width: w, height: h }).toPNG().toString('base64');
      }).then((b64) => writeFileSync(logoPath, Buffer.from(b64, 'base64')));
      await app.evaluate(async ({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, out);
      await app.evaluate(() => {
        globalThis.__qaRealFetch = globalThis.fetch;
        globalThis.fetch = async () => { throw new Error('tiles blocked by QA'); };
      });
      await newSheet();
      // Nothing is mandatory: on an EMPTY sheet Next is enabled, any step can be
      // opened, and Save on Review is enabled.
      const emptyNext = await win.evaluate(() => !document.getElementById('psNextBtn')?.disabled);
      await win.click('#psStep-review');
      const emptySave = await win.evaluate(() => !!document.getElementById('psExportBtn') && !document.getElementById('psExportBtn').disabled);
      notes.push(`empty sheet: next=${emptyNext} save=${emptySave}`);
      if (!emptyNext || !emptySave) fails.push('an empty sheet blocks Next or Save');
      await win.click('#psStep-job');
      // Job: the preset fills 10 m / 20 m, 2 ms, 480 channels.
      await fill('ps-job-jobType', 'Vibroseis 2D Reflection');
      await fill('ps-job-prospect', 'QA block');
      await fill('ps-job-startDate', '2027-01-05');
      // The logo, through the real button and the real main-process IPC.
      await mockDialogs(app, [logoPath]);
      await app.evaluate(async ({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, out);
      await win.click('#psLogoPick');
      await win.waitForSelector('#psLogoThumb', { state: 'visible', timeout: 10000 }).catch(() => fails.push('the logo thumbnail did not appear'));
      await win.click('#psNextBtn');
      // Geometry: three 12 km lines -> 1803 shots, nominal fold 120.
      await fill('ps-geom-lineLengthM', 12000);
      for (let i = 0; i < 3; i++) await win.click('#psAddLineBtn');
      for (let i = 0; i < 5; i++) await win.click('#psNextBtn');   // Source .. Coordinates
      const onCoords = ((await win.textContent('#psStepTitle')) || '').trim();
      if (onCoords !== 'Coordinates') fails.push(`expected the Coordinates step, got "${onCoords}"`);
      await win.fill('#psCoordText', 'id,E,N\nL1-S,200000,600000\nL1-E,212000,600000\nL2-S,200000,600500\nL2-E,212000,600500\n');
      await win.click('#psCoordRead');
      const detected = ((await win.textContent('#psDetectText')) || '').trim();
      notes.push(`detected: ${detected}`);
      if (!/EPSG:2039/.test(detected) || !/4 points on 2 lines/.test(detected)) fails.push(`detection said "${detected}"`);
      await win.click('#psCoordConfirm');
      // Geometry says Line 1..3, the coordinates say L1, L2: the step must say so and offer the fix.
      await win.waitForSelector('#psUseCoordLines', { state: 'visible', timeout: 10000 })
        .catch(() => fails.push('no line-name mismatch warning on the Coordinates step'));
      await win.selectOption('#psBasemap', 'satellite');
      await win.click('#psNextBtn');
      await win.waitForFunction(() => /Preview/.test(document.getElementById('psMapMsg')?.textContent || ''), null, { timeout: 15000 })
        .catch(() => fails.push('the review map preview did not draw'));
      if (!(await win.isVisible('#psReviewLogo').catch(() => false))) fails.push('Review does not show the logo');
      const map = await canvasBlank(win, 'psMapCanvas', { r: 0xec, g: 0xec, b: 0xec });
      if (map.blank) fails.push('review map canvas is blank: ' + map.reason);
      await win.click('#psExportBtn');
      await win.waitForFunction(() => /Saved|failed|Could not/.test(document.getElementById('psStatus')?.textContent || ''), null, { timeout: 60000 })
        .catch(() => fails.push('the export did not report in 60s'));
      const status = ((await win.textContent('#psStatus')) || '').trim();
      notes.push(`status: ${status.slice(0, 90)}`);
      if (!existsSync(out)) fails.push('no XLSX was written');
      else {
        const zip = await JSZip.loadAsync(readFileSync(out));
        const part = async (n) => (zip.file(n) ? zip.file(n).async('string') : '');
        const wb = await part('xl/workbook.xml');
        const names = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
        notes.push(`sheets: ${names.join(', ')}`);
        if (names.join('|') !== 'Parameters|Area|Map|About') fails.push(`sheets were ${names.join('|')}`);
        const s1 = await part('xl/worksheets/sheet1.xml');
        for (const want of ['Vibroseis 2D Reflection', '<v>480</v>', '<v>1803</v>', '<v>120</v>', '<v>46392</v>', 'Lines do not match the coordinates']) {
          if (!s1.includes(want)) fails.push(`Parameters sheet lacks ${want}`);
        }
        // The logo is the Parameters sheet's picture (title band); the map is the Map sheet's.
        const d1 = await part('xl/drawings/drawing1.xml');
        if (!/name="Logo"/.test(d1) || !/<xdr:row>0<\/xdr:row>/.test(d1)) fails.push('no logo drawing in the Parameters title band');
        if (!/drawing1\.xml/.test(await part('xl/worksheets/_rels/sheet1.xml.rels'))) fails.push('the Parameters sheet does not reference the logo drawing');
        const logo = zip.file('xl/media/image1.png') ? await zip.file('xl/media/image1.png').async('uint8array') : new Uint8Array(0);
        if (logo.length < 50 || logo[0] !== 0x89) fails.push(`embedded logo missing (${logo.length} bytes)`);
        const s2 = await part('xl/worksheets/sheet2.xml');
        if (!s2.includes('<v>212000</v>') || !s2.includes('L2-E')) fails.push('Area sheet lacks the points');
        const s3 = await part('xl/worksheets/sheet3.xml');
        if (!/Basemap not available \(offline\)/.test(s3)) fails.push('Map sheet lacks the offline note');
        const png = zip.file('xl/media/image2.png') ? await zip.file('xl/media/image2.png').async('uint8array') : new Uint8Array(0);
        if (png.length < 10000 || png[0] !== 0x89 || png[1] !== 0x50) fails.push(`embedded map PNG missing or tiny (${png.length} bytes)`);
        notes.push(`xlsx ${readFileSync(out).length} bytes, logo ${logo.length} bytes, map png ${png.length} bytes`);
      }
      await win.locator('#psMapCanvas').scrollIntoViewIfNeeded().catch(() => {});
      await win.screenshot({ path: join(SHOTS, '9b-paramsheet-map.png') }).catch(() => {});
      // Save as configuration (both opt-in groups left OFF), New sheet, load it back:
      // the parameters, lines and logo return; the coordinates and job details do not.
      const cfgPath = join(SHOTS, '_ps_cfg_example.seisparams');
      rmSync(cfgPath, { force: true });
      await app.evaluate(async ({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, cfgPath);
      await win.locator('#psCfgSaveBtn').scrollIntoViewIfNeeded().catch(() => {});
      await win.screenshot({ path: join(SHOTS, '_ps_cfg_review.png') }).catch(() => {});
      await win.click('#psCfgSaveBtn');
      await win.waitForSelector('#psCfgBack.open', { timeout: 5000 }).catch(() => fails.push('the save-configuration dialog did not open'));
      const boxesOff = await win.evaluate(() => !document.getElementById('psCfgCoords')?.checked && !document.getElementById('psCfgJob')?.checked);
      if (!boxesOff) fails.push('the configuration checkboxes are not off by default');
      await win.screenshot({ path: join(SHOTS, '_ps_cfg_save_dialog.png') }).catch(() => {});
      await win.click('#psCfgOk');
      await win.waitForFunction(() => /Saved configuration|failed|Could not/.test(document.getElementById('psStatus')?.textContent || ''), null, { timeout: 10000 })
        .catch(() => fails.push('saving the configuration did not report'));
      if (!existsSync(cfgPath)) fails.push('no .seisparams file was written');
      else {
        const cfgText = readFileSync(cfgPath, 'utf8');
        const cfg = JSON.parse(cfgText);
        if (cfg.format !== 'seisconv-paramsheet-config' || cfg.version !== 1) fails.push('the configuration header is wrong');
        if (/212000|QA block|2027-01-05/.test(cfgText)) fails.push('the configuration holds coordinates or job details it was told to leave out');
        notes.push(`config ${cfgText.length} bytes`);
      }
      await newSheet();
      await mockDialogs(app, [cfgPath]);
      await win.click('#psCfgLoadBtn');
      await win.waitForFunction(() => /Loaded configuration/.test(document.getElementById('undoToastMsg')?.textContent || ''), null, { timeout: 10000 })
        .catch(() => fails.push('no "Loaded configuration" toast'));
      const toast = ((await win.textContent('#undoToastMsg').catch(() => '')) || '').trim();
      notes.push(`load toast: ${toast}`);
      await win.screenshot({ path: join(SHOTS, '_ps_cfg_loaded.png') }).catch(() => {});
      const restored = await win.evaluate(() => ({
        jt: document.getElementById('ps-job-jobType')?.value, prospect: document.getElementById('ps-job-prospect')?.value,
        start: document.getElementById('ps-job-startDate')?.value, logo: !!document.getElementById('psLogoThumb'),
      }));
      if (restored.jt !== 'Vibroseis 2D Reflection' || !restored.logo) fails.push(`configuration did not restore the job type / logo (${JSON.stringify(restored)})`);
      if (restored.prospect || restored.start) fails.push('configuration restored job details that were left out');
      await win.click('#psStep-geometry');
      const lineRows = await win.evaluate(() => document.querySelectorAll('#psLines tr[data-path]').length);
      const lineLen = await win.inputValue('#ps-geom-lineLengthM').catch(() => '');
      if (lineRows !== 3 || lineLen !== '12000') fails.push(`configuration lines: ${lineRows} rows, length ${lineLen}`);
      await win.click('#psStep-coords');
      if (await win.evaluate(() => !!document.getElementById('psPtsTbl'))) fails.push('configuration restored coordinates that were left out');
      notes.push(`config load: lines=${lineRows} logo=${restored.logo}`);
      // Within the session, another tab and back keeps everything.
      await gotoTab(win, 'tab-conv', 'panel-conv');
      await gotoTab(win, 'tab-paramsheet', 'panel-paramsheet');
      await win.click('#psStep-job');
      const kept = await win.inputValue('#ps-job-jobType').catch(() => '');
      if (kept !== 'Vibroseis 2D Reflection' || !(await win.isVisible('#psLogoThumb').catch(() => false))) fails.push('switching tabs lost the sheet within the session');
    } finally {
      await app.evaluate(() => { if (globalThis.__qaRealFetch) { globalThis.fetch = globalThis.__qaRealFetch; delete globalThis.__qaRealFetch; } }).catch(() => {});
      await mockDialogs(app, []).catch(() => {});
    }

    // Relaunch on the same profile: the sheet must start completely empty.
    try {
      await app.close();
      const udd = process.env.SEISCONV_QA_USER_DATA_DIR;
      app = await electron.launch({ args: udd ? ['.', `--user-data-dir=${udd}`] : ['.'], cwd: APP_DIR, env: launchEnv() });
      win = await app.firstWindow();
      win.on('console', (m) => { if (m.type() === 'error') globalConsole.push(m.text()); });
      win.on('pageerror', (e) => globalPageErrors.push(e.message || String(e)));
      await win.waitForLoadState('domcontentloaded');
      await sleep(600);
      await gotoTab(win, 'tab-paramsheet', 'panel-paramsheet');
      const after = await win.evaluate(() => ({
        inputs: [...document.querySelectorAll('#psForm input:not([type=checkbox]), #psForm textarea')]
          .filter((e) => e.value !== '').map((e) => `${e.id}=${e.value}`),
        selects: document.getElementById('ps-job-geometry')?.value,
        logo: !!document.getElementById('psLogoThumb'),
        stored: ['seisconv.paramsheet', 'seisconv.paramsheet.clients'].filter((k) => localStorage.getItem(k) != null),
        steps: [...document.querySelectorAll('[id^=psSum-]')].map((e) => e.textContent).join(' | '),
      }));
      await win.click('#psStep-coords');
      const coordsEmpty = await win.evaluate(() => (document.getElementById('psCoordText')?.value || '') === '' && !document.getElementById('psPtsTbl'));
      await win.click('#psStep-geometry');
      const linesEmpty = await win.evaluate(() => document.querySelectorAll('#psLines tr').length <= 1);
      await win.click('#psStep-job');
      await win.screenshot({ path: join(SHOTS, '_ps_after_restart.png') }).catch(() => {});
      const doneSteps = await win.evaluate(() => [...document.querySelectorAll('[id^=psStep-].done')].map((e) => e.id));
      if (doneSteps.length) fails.push(`empty sheet shows done steps after visiting them: ${doneSteps.join(', ')}`);
      notes.push(`after restart: filled=${after.inputs.length} logo=${after.logo} stored=${after.stored.length} coordsEmpty=${coordsEmpty} linesEmpty=${linesEmpty} doneSteps=${doneSteps.length}`);
      if (after.inputs.length) fails.push(`fields survived a restart: ${after.inputs.join(', ')}`);
      if (after.logo) fails.push('the logo survived a restart');
      if (after.stored.length) fails.push(`still stored on disk: ${after.stored.join(', ')}`);
      if (!coordsEmpty) fails.push('coordinates survived a restart');
      if (!linesEmpty) fails.push('lines survived a restart');
    } catch (e) {
      fails.push('relaunch failed: ' + (e && e.message ? e.message : e));
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    return { assertFail: fails.length ? fails.join('; ') : null };
  });

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
