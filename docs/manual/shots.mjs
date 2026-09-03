// docs/manual/shots.mjs - the SeisConv user-manual screenshot set, regenerated in one command.
//
//   npm run manual:shots            build the fixtures, drive the BUILT app, write every image
//   npm run manual:shots -- --only sps,help    only the steps whose id contains one of these
//
// COMMITTED TOOLING, NOT A SCRATCH DRIVER. Every picture in the manual is produced here, by
// driving the real application through the real controls, so the whole set can be regenerated
// for the next release and a picture can never be older than the code it documents.
//
// THE DATA RULE. Nothing here ever opens a real survey. docs/manual/fixtures.mjs generates a
// deterministic synthetic SEG-Y set, a synthetic SPS 2.1 triplet and a pre-plot CSV at an
// obviously artificial origin (500000E 4000000N, UTM 36N). After each capture, `scanFrame()`
// reads the WHOLE window's visible text back and fails the shot if it finds a real path root,
// a machine/user name or a known real-site token. A picture that cannot be made safe is
// skipped and reported, never shipped.
//
// CALLOUTS. `capture()` takes a list of { sel, label }: it measures each element in the live
// page, paints a numbered marker over it, screenshots, then removes the overlay again. The
// same list is written next to the image as <name>.json, so the manual text references
// "callout 3" and nobody ever retypes a coordinate.
//
// OUTPUT. docs/manual/img/<name>.png + <name>.json, plus img/index.json (the manifest).
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { launch, mockDialogs, gotoTab, sleep, APP_DIR } from '../../qa/harness.mjs';
import { buildFixtures } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMG = join(HERE, 'img');

/** One window size for the whole set, so no two pictures in the manual disagree.
 *  The height is a REQUEST: Windows clamps the content box to the work area, so on a
 *  1080p screen every image comes out 1600x1032. That is fine - what matters is that
 *  all of them come out the SAME, and the run prints the size it actually got. */
const WIN = { w: 1600, h: 1180 };

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? String(process.argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null;
})();

// ---------------------------------------------------------------- frame safety
/**
 * Tokens that must never appear in a manual picture. Anything matching is a real
 * path root, this machine's identity, or a real site/survey name seen in this repo's
 * QA data. The check runs on the window's rendered text after every capture.
 */
const FORBIDDEN = [
  /Yagur/i, /NodesCheck/i, /GP-\d{4}/i, /SegY_Rev2/i, /Data_Games/i, /SPS_Games/i,
  // NOTE: the header byline "Made by Moshe Fridin" is the application's OWN credit and
  // belongs in the picture; only this machine's ACCOUNT name (moshef*) would be a leak.
  /moshef/i, /\bGII\b/i, /Geophysical Institute/i,
  /D:\\Projects/i, /D:\/Projects/i, /C:\\Users/i, /C:\/Users/i, /AppData/i,
  /Users[\\/][A-Za-z]/,
];

async function scanFrame(win) {
  const txt = await win.evaluate(() => document.body.innerText || '');
  const hits = [];
  for (const re of FORBIDDEN) { const m = txt.match(re); if (m) hits.push(m[0]); }
  return [...new Set(hits)];
}

// ---------------------------------------------------------------- callouts
/**
 * Paint numbered callout markers over the live page, screenshot, then remove them.
 * `marks` is [{ sel, label, at }] - `at` places the marker on the element's box
 * ('tl' default, 'tr', 'bl', 'br', 'c'). An element that is missing or invisible is
 * reported as a MISSING callout rather than silently dropped: a marker that points at
 * nothing means the manual text is about to describe a control that moved.
 */
async function paintCallouts(win, marks) {
  return win.evaluate(({ marks }) => {
    const host = document.createElement('div');
    host.id = '__manual_callouts';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:700 15px/1 Segoe UI,system-ui,sans-serif';
    const out = [];
    marks.forEach((m, i) => {
      const n = i + 1;
      const el = document.querySelector(m.sel);
      const r = el && el.getBoundingClientRect();
      // Off-viewport counts as MISSING, not as a marker clamped to the window edge: a
      // number sitting on the status bar and pointing at a control below the fold is worse
      // than no marker at all, because the manual text would then be wrong.
      const off = !el || !r || r.width < 1 || r.height < 1
        || r.bottom < 4 || r.top > innerHeight - 4 || r.right < 4 || r.left > innerWidth - 4;
      if (off) { out.push({ n, sel: m.sel, label: m.label, missing: true }); return; }
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;`
        + 'border:2px solid #ff9f1c;border-radius:6px;box-shadow:0 0 0 2px rgba(0,0,0,.55)';
      host.appendChild(box);
      const at = m.at || 'tl';
      const cx = at === 'tr' || at === 'br' ? r.right + 3 : at === 'c' ? r.left + r.width / 2 : r.left - 3;
      const cy = at === 'bl' || at === 'br' ? r.bottom + 3 : at === 'c' ? r.top + r.height / 2 : r.top - 3;
      const dot = document.createElement('div');
      dot.textContent = String(n);
      dot.style.cssText = `position:fixed;left:${Math.max(2, Math.min(innerWidth - 28, cx - 13))}px;`
        + `top:${Math.max(2, Math.min(innerHeight - 28, cy - 13))}px;width:26px;height:26px;border-radius:50%;`
        + 'background:#ff9f1c;color:#101317;display:flex;align-items:center;justify-content:center;'
        + 'box-shadow:0 2px 6px rgba(0,0,0,.7);border:2px solid #101317';
      host.appendChild(dot);
      out.push({ n, sel: m.sel, label: m.label, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } });
    });
    document.body.appendChild(host);
    return out;
  }, { marks });
}
async function clearCallouts(win) {
  await win.evaluate(() => document.getElementById('__manual_callouts')?.remove());
}

// ---------------------------------------------------------------- capture
const shots = [];
/**
 * Capture one manual picture. Writes img/<name>.png and img/<name>.json (the callout
 * key), records the frame-safety verdict, and returns the record.
 */
async function capture(win, name, caption, marks = [], opts = {}) {
  // Bring the region being documented into view first, so every marker is measured
  // against the frame that is actually photographed (a marker for a control below the
  // fold is reported as MISSING rather than clamped to the window edge).
  await win.mouse.move(1150, 62).catch(() => {});
  await win.evaluate(() => document.querySelectorAll('.undo-toast.show').forEach((e) => e.classList.remove('show')));
  await sleep(250);
  if (opts.scrollTo) {
    await win.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center', behavior: 'instant' }), opts.scrollTo);
    await sleep(400);
  }
  const painted = marks.length ? await paintCallouts(win, marks) : [];
  await sleep(120);
  const png = join(IMG, name + '.png');
  await win.screenshot({ path: png });
  await clearCallouts(win);
  const leaks = await scanFrame(win);
  const rec = {
    image: `img/${name}.png`, name, caption,
    callouts: painted.map((c) => ({ n: c.n, label: c.label, selector: c.sel, ...(c.missing ? { missing: true } : { rect: c.rect }) })),
    missingCallouts: painted.filter((c) => c.missing).map((c) => c.sel),
    frameLeaks: leaks,
    bytes: statSync(png).size,
  };
  writeFileSync(join(IMG, name + '.json'), JSON.stringify(rec, null, 2));
  shots.push(rec);
  const flag = leaks.length ? ` !! LEAK ${leaks.join('|')}` : '';
  const miss = rec.missingCallouts.length ? ` !! MISSING ${rec.missingCallouts.join('|')}` : '';
  console.log(`  shot ${name}.png (${(rec.bytes / 1024).toFixed(0)} kB, ${painted.length} callouts)${flag}${miss}`);
  return rec;
}

// ---------------------------------------------------------------- runner
const failures = [];
async function step(id, fn) {
  if (only && !only.some((o) => id.includes(o))) return;
  console.log(`\n[${id}]`);
  try { await fn(); } catch (e) { failures.push(`${id}: ${e.message}`); console.log(`  FAILED: ${e.message}`); }
}

/** Set a tick/toggle to `want`, whether it is a checkbox input or a class-toggled button. */
async function setCheck(win, sel, want) {
  const is = await win.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    return 'checked' in e && e.type === 'checkbox' ? !!e.checked : e.classList.contains('on');
  }, sel);
  if (is === null || is === want) return is;
  await win.click(sel).catch(() => {});
  await sleep(600);
  return !is;
}

/** Wait for a predicate in the page, quietly (a slow step is reported, not thrown). */
async function waitFor(win, fnBody, arg = null, timeout = 30000) {
  return win.waitForFunction(fnBody, arg, { timeout }).then(() => true).catch(() => false);
}

async function main() {
  // A --only run must NOT wipe the pictures it is not regenerating.
  if (!only) rmSync(IMG, { recursive: true, force: true });
  mkdirSync(IMG, { recursive: true });

  // Fixtures live OUTSIDE the repo, at a neutral path: the app shows the open file's
  // folder in places, and the OS temp dir carries this machine's user name, which the
  // frame-safety scan (rightly) rejects.
  const root = parsePath(APP_DIR).root;
  let fixDir = join(root, 'SeisConvDemo');
  try { mkdirSync(fixDir, { recursive: true }); } catch { fixDir = join(tmpdir(), 'seisconv-manual-fixtures'); }
  const F = buildFixtures(fixDir);
  console.log(`fixtures: ${F.dir}  (seed 0x${F.seed.toString(16)}, origin ${F.origin.east}E ${F.origin.north}N EPSG:${F.origin.epsg})`);

  // A FRESH Electron profile every run: an observer log built by a previous run is
  // remembered in localStorage, and the setup-wizard picture would then never be taken.
  const udd = join(tmpdir(), 'seisconv-manual-profile');
  rmSync(udd, { recursive: true, force: true });
  process.env.SEISCONV_QA_USER_DATA_DIR = udd; // harness.launch() passes this to Electron
  const { app, win, errors } = await launch();
  await app.evaluate(async ({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setResizable(true); w.unmaximize?.(); w.setContentSize(s.w, s.h); w.center();
  }, WIN);
  await sleep(600);

  // Dark theme + a signed audit profile, so no modal ambushes a later shot.
  await win.click('#themeDark').catch(() => {});
  await win.evaluate(() => {
    const i = document.getElementById('auditSigInput');
    if (i && !i.value) { i.value = 'Example Observer'; document.getElementById('auditSigSave')?.click(); }
    document.getElementById('auditBack')?.classList.remove('open');
  });
  await sleep(300);

  const size = await win.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
  console.log(`window: ${size.w}x${size.h} @${size.dpr}x`);

  // =================================================================== CONVERTER
  await step('conv', async () => {
    await gotoTab(win, 'tab-conv', 'panel-conv');
    await win.click('#modeSingle');
    await sleep(300);
    await capture(win, '01a-converter-mode-single', 'Converter, single-file mode, before a file is open', [
      { sel: '#modeSingle', label: 'Single-file mode: open one file, inspect it, export it' },
      { sel: '#modeBatch', label: 'Folder (batch) mode: convert every seismic file in a folder', at: 'tr' },
    ]);

    await mockDialogs(app, [F.segy1]);
    await win.click('#openBtn2');
    await waitFor(win, () => {
      const t = document.getElementById('fsTraces');
      return t && t.textContent.trim() && t.textContent.trim() !== '-';
    });
    await sleep(600);
    await capture(win, '01b-converter-single-loaded', 'Converter with a SEG-Y open: what was read, and the output format', [
      { sel: '#openBtn2', label: 'Open a seismic file' },
      { sel: '#singleFoundName', label: 'What SeisConv read: format, revision, trace count, sample count, interval' },
      { sel: '#fmtChips', label: 'Output format - one chip per single-file writer' },
    ]);
    await capture(win, '01c-converter-output-name', 'The same panel scrolled to the output-name builder and Convert', [
      { sel: '#outNameTpl', label: 'The name template, built from the ticks below it' },
      { sel: '#npDate', label: 'Each tick adds a part to the name' },
      { sel: '#outNameSep', label: 'Separator between the parts' },
      { sel: '#convertBtn', label: 'Convert & Save…', at: 'tr' },
    ], { scrollTo: '#convertBtn' });

    // BATCH: point the folder picker at the fixture folder (3 synthetic SEG-Ys).
    await win.click('#modeBatch');
    await sleep(300);
    await mockDialogs(app, [F.dir]);
    await win.click('#pickFolderBtn');
    await waitFor(win, () => {
      const c = document.getElementById('batchCount');
      return c && parseInt(c.textContent || '0', 10) > 0;
    }, null, 20000);
    await sleep(800);
    await capture(win, '02-converter-batch', 'Converter, folder (batch) mode with a folder scanned and a destination chosen', [
      { sel: '#pickFolderBtn', label: 'Pick the folder to scan' },
      { sel: '#batchFound', label: 'How many seismic files were found, and where', at: 'tr' },
    ]);
    await capture(win, '02b-converter-batch-run', 'The batch panel scrolled to the destination and the run button', [
      { sel: '#pickOutBtn', label: 'Pick the destination folder' },
      { sel: '#runBatchBtn', label: 'Convert every file found - disabled until a destination is set', at: 'tr' },
      { sel: '#clearBatchBtn', label: 'Clear the list', at: 'tr' },
    ], { scrollTo: '#runBatchBtn' });
    await win.click('#modeSingle');
    await sleep(300);
  });

  // =================================================================== TRACE
  await step('trace', async () => {
    await gotoTab(win, 'tab-trace', 'panel-trace');
    await sleep(600);
    // A MID-OFFSET trace: near the source the direct arrival is several times the
    // reflection amplitude and the auto scale flattens everything else, which makes a
    // picture that teaches nothing about reading a trace.
    await win.fill('#traceSlider', '20').catch(() => {});
    await win.evaluate(() => document.getElementById('traceSlider')?.dispatchEvent(new Event('input', { bubbles: true })));
    await sleep(700);
    await capture(win, '03-trace-inspector', 'Trace Inspector on one channel of the synthetic shot', [
      { sel: '#traceCanvas', label: 'The trace: time down, amplitude across (sample value, no physical unit)', at: 'tr' },
      { sel: '#tracePrev', label: 'Step between traces' },
      { sel: '#traceSpec', label: 'Switch this panel to the trace spectrum', at: 'tr' },
      { sel: '#traceToWb', label: 'Send this trace to the Trace Workbench', at: 'br' },
    ]);
  });

  // =================================================================== SECTION
  await step('section', async () => {
    await gotoTab(win, 'tab-section', 'panel-section');
    await sleep(1200);
    await setCheck(win, '#secAgc', false);
    await sleep(700);
    await capture(win, '04a-section-agc-off', 'File Viewer, variable density, AGC OFF - amplitude decays with time', [
      { sel: '#secAgc', label: 'AGC is OFF here' },
      { sel: '#secCanvas', label: 'The shot record: 96 traces, 2 s, three reflectors under the direct arrival', at: 'tr' },
    ]);
    await setCheck(win, '#secAgc', true);
    await sleep(900);
    await capture(win, '04b-section-agc-on', 'The same record with AGC ON - the deep reflectors become visible', [
      { sel: '#secAgc', label: 'AGC is ON: each trace is balanced in a sliding window', at: 'bl' },
      { sel: '#secGain', label: 'Display gain', at: 'tr' },
      { sel: '#secMode', label: 'Display mode: variable density, wiggle, variable area' },
      { sel: '#secColor', label: 'Colour map' },
    ]);

    // Health scan - a meaningful, populated state for the QC picture.
    await win.click('#secHealthBtn');
    await waitFor(win, () => {
      const l = document.getElementById('secHealthLabel') || document.getElementById('secHealthSummary');
      return l && l.textContent.trim().length > 0;
    }, null, 40000);
    await sleep(1200);
    await capture(win, '05-section-health-scan', 'Trace health scan: every trace judged against its local neighbours', [
      { sel: '#secHealthBtn', label: 'Run the health scan' },
      { sel: '#secHealthSensBtn', label: 'Tune per-detector sensitivity; the flag count updates live' },
      { sel: '#secHealthExportBtn', label: 'Export the flagged traces as CSV', at: 'tr' },
      { sel: '#secCanvas', label: 'Flagged traces are marked on the section', at: 'tr' },
    ]);
  });

  // =================================================================== SPECTRUM
  await step('spectrum', async () => {
    await gotoTab(win, 'tab-spectrum', 'panel-spectrum');
    const settle = () => waitFor(win, () => {
      const t = (document.getElementById('specLabel')?.textContent || '').trim();
      return t !== '' && !/^Computing/i.test(t) && !/Open a seismic file/i.test(t);
    }, null, 40000);
    await settle(); await sleep(700);
    await capture(win, '06a-spectrum-average', 'Spectrum tab: average amplitude spectrum over a trace range', [
      { sel: '#specDispAvg', label: 'Average spectrum' },
      { sel: '#specDispGram', label: 'Spectrogram' },
      { sel: '#specDispFk', label: 'F-K' },
      { sel: '#specCanvas', label: 'Amplitude against frequency, averaged over the trace range, with the peak and the -6 dB band marked', at: 'tr' },
    ]);
    await win.click('#specDispFk'); await settle(); await sleep(900);
    await capture(win, '06b-spectrum-fk', 'The same file as an F-K panel: the ground-roll fan spreads in wavenumber while the flat reflections stay near kx = 0', [
      { sel: '#specDispFk', label: 'F-K display selected' },
      { sel: '#specCanvas', label: 'Frequency against wavenumber over the whole record; slope f/kx is apparent velocity', at: 'tr' },
    ]);
    await win.click('#specDispAvg'); await settle();
  });

  // =================================================================== VELOCITY
  await step('velocity', async () => {
    await gotoTab(win, 'tab-vel', 'panel-vel');
    await win.click('#velComputeBtn');
    await waitFor(win, () => {
      const l = document.getElementById('velLabel');
      return l && !/Open a file, then compute/.test(l.textContent);
    }, null, 60000);
    await sleep(1000);
    await capture(win, '07-velocity-semblance', 'Velocity tab: NMO semblance over the synthetic shot, three reflectors', [
      { sel: '#velMin', label: 'Velocity scan range and step' },
      { sel: '#velComputeBtn', label: 'Compute semblance' },
      { sel: '#velCanvas', label: 'Semblance: time down, stacking velocity across; click a maximum to pick', at: 'tr' },
      { sel: '#velExportBtn', label: 'Export the picks as CSV', at: 'tr' },
    ]);
  });

  // =================================================================== WORKBENCH
  await step('workbench', async () => {
    await gotoTab(win, 'tab-workbench', 'panel-workbench');
    await win.click('#wbAddOpenBtn'); await sleep(500);
    await gotoTab(win, 'tab-trace', 'panel-trace');
    await win.fill('#traceSlider', '10').catch(() => {});
    await win.evaluate(() => document.getElementById('traceSlider')?.dispatchEvent(new Event('input', { bubbles: true })));
    await sleep(600);
    await win.click('#traceToWb').catch(() => {});
    await sleep(400);
    await gotoTab(win, 'tab-workbench', 'panel-workbench');
    // Overlay, not the side-by-side default: two traces drawn on the same axes is the
    // comparison this panel exists for, and the picture must match its own caption.
    await win.click('#wbModeOverlay').catch(() => {});
    await sleep(900);
    await capture(win, '08-workbench-overlay', 'Trace Workbench: two collected traces overlaid for comparison', [
      { sel: '#wbModeOverlay', label: 'Overlay (selected) or side-by-side' },
      { sel: '#wbCanvas', label: 'The comparison plot', at: 'tr' },
      { sel: '#wbAddOpenBtn', label: 'Add the current trace of the open file' },
    ]);
    await capture(win, '08b-workbench-collection', 'The collected traces and the export row, further down the same panel', [
      { sel: '#wbList', label: 'Everything collected so far' },
      { sel: '#wbExportFmt', label: 'Write the collection out in any supported format', at: 'tr' },
    ], { scrollTo: '#wbExportFmt' });
  });

  // =================================================================== SPS MAP
  await step('sps', async () => {
    await gotoTab(win, 'tab-sps', 'panel-sps');
    await mockDialogs(app, F.sps);
    await win.click('#spsLoadBtn');
    await waitFor(win, () => (document.getElementById('spsStats')?.textContent || '').trim().length > 0, null, 30000);
    await sleep(1200);
    await win.fill('#qcSrcInt', '100').catch(() => {});
    await win.fill('#qcRcvInt', '25').catch(() => {});
    await win.click('#spsQcBtn');
    await sleep(1800);
    await setCheck(win, '#spsShowXrefs', false);
    await capture(win, '09a-sps-map', 'SPS tab: the loaded survey on the grid view, QC run', [
      { sel: '#spsLoadBtn', label: 'Open an SPS survey (S / R / X)' },
      { sel: '#spsStats', label: 'What was loaded: sources, receivers, cross-references' },
      { sel: '#spsCanvas', label: 'The survey map', at: 'tr' },
      { sel: '#spsShowXrefs', label: 'The X-ref spider is OFF here', at: 'br' },
      { sel: '#qcResults', label: 'What QC found, against the intervals and tolerance beside it' },
    ]);
    await setCheck(win, '#spsShowXrefs', true); await sleep(700);
    await capture(win, '09b-sps-xref-spider', 'The same survey with the X-ref spider ON: every source drawn to its live receivers', [
      { sel: '#spsShowXrefs', label: 'X-ref spider ON' },
      { sel: '#spsCanvas', label: 'Each shot is now joined to the channels its X record lists', at: 'tr' },
      { sel: '#spsShowFold', label: 'Fold / coverage can be drawn over the same map' },
    ]);
    // The same survey on the REAL basemap. The survey grid above teaches the geometry;
    // this teaches where it sits on the ground, which is the whole point of the view.
    await win.click('#viewMap').catch(() => {});
    await waitFor(win, () => {
      const c = document.querySelector('#spsMap .leaflet-tile-pane');
      if (!c) return false;
      const t = c.querySelectorAll('img.leaflet-tile');
      return t.length > 0 && [...t].every((i) => i.classList.contains('leaflet-tile-loaded'));
    }, null, 45000);
    await sleep(1500);
    await capture(win, '09d-sps-real-map', 'The same survey on the real basemap: satellite imagery, with the layer picker and the bearing control', [
      { sel: '#viewMap', label: 'Real map: the survey drawn on satellite imagery instead of the plain grid' },
      { sel: '#viewGrid', label: 'Survey grid: the same stations on a plain plot' },
      { sel: '#spsMap', label: 'The layer picker at the top right switches satellite, streets and the two grey regional canvases', at: 'tr' },
      { sel: '#spsRotateCtl', label: 'Bearing: rotates the imagery and the stations together', at: 'br' },
    ]);
    await win.click('#viewGrid').catch(() => {});
    await sleep(600);
    await capture(win, '09c-sps-export', 'The SPS tab scrolled to the export row', [
      { sel: '#spsExpFormat', label: 'Write the survey out in any supported positioning format' },
      { sel: '#spsExpFormatBtn', label: 'Export…', at: 'tr' },
      { sel: '#spsExpGeotiffBtn', label: 'Georeferenced rasters as GeoTIFF', at: 'tr' },
      { sel: '#spsExpShpBtn', label: 'ESRI shapefile layers, zipped, with a .prj', at: 'br' },
    ], { scrollTo: '#spsExpFormat' });
  });

  // =================================================================== SPS HEADERS
  await step('sps-headers', async () => {
    await win.click('#spsHeadersBtn');
    await waitFor(win, () => document.getElementById('spsHeadersBack')?.classList.contains('open')
      && (document.getElementById('spsHdrGroups')?.children.length || 0) > 0, null, 20000);
    await sleep(600);
    await capture(win, '10a-sps-headers-view', 'SPS header editor: the H-record block as loaded', [
      { sel: '#spsHdrTabView', label: 'View: the H records exactly as they are in the files' },
      { sel: '#spsHdrTabCrs', label: 'CRS / Datum: the projection as a form' },
      { sel: '#spsHdrTabAdmin', label: 'Admin: survey area, date, client, contractor' },
      { sel: '#spsHdrTabRaw', label: 'Raw records: edit any H record directly' },
      { sel: '#spsHdrScope', label: 'Which of the three files the edit applies to', at: 'tr' },
    ]);
    await win.click('#spsHdrTabCrs'); await sleep(600);
    await capture(win, '10b-sps-headers-crs', 'The CRS / Datum tab, and the switch that decides whether coordinates move', [
      { sel: '#crsProjType', label: 'Projection type' },
      { sel: '#crsZone', label: 'Zone and hemisphere', at: 'tr' },
      { sel: '#crsModeLabel', label: 'Fix the LABEL only: the header is rewritten, the coordinates are untouched' },
      { sel: '#crsModeReproject', label: 'Reproject the COORDINATES too: this changes every station', at: 'br' },
      { sel: '#spsHdrExportBtn', label: 'Write the corrected S/R/X out as a ZIP', at: 'tr' },
    ]);
    await win.click('#spsHeadersClose'); await sleep(400);
  });

  // =================================================================== GEOTIFF
  await step('geotiff', async () => {
    await win.click('#spsExpGeotiffBtn');
    await waitFor(win, () => document.getElementById('geotiffBack')?.classList.contains('open'), null, 15000);
    await sleep(900);
    await win.click('#gtWholeBtn').catch(() => {});
    await sleep(500);
    await win.click('#gtResAuto').catch(() => {});
    await sleep(500);
    // Tick every raster, so the picture shows what the wizard can actually produce.
    for (const id of ['#gtLayerFold', '#gtLayerElev', '#gtLayerLayout']) await setCheck(win, id, true);
    await sleep(700);
    await capture(win, '11-geotiff-wizard', 'GeoTIFF export wizard, area and resolution set from the loaded survey', [
      { sel: '#gtWholeBtn', label: 'Use the whole survey plus a margin' },
      { sel: '#gtDragBtn', label: 'Or drag a box on the map instead', at: 'tr' },
      { sel: '#gtRes', label: 'Ground resolution, in units per pixel' },
      { sel: '#gtResAuto', label: 'The finest resolution this station spacing actually supports', at: 'tr' },
      { sel: '#gtLayerFold', label: 'Which rasters to write' },
      { sel: '#gtCrsSearch', label: 'CRS of the output raster', at: 'tr' },
      { sel: '#gtExportBtn', label: 'Write the GeoTIFF set as a ZIP', at: 'tr' },
    ]);
    await win.click('#geotiffClose').catch(() => {});
    await sleep(400);
  });

  // =================================================================== PLAN IMPORT
  await step('planimport', async () => {
    await gotoTab(win, 'tab-spscreate', 'panel-spscreate');
    await sleep(700);
    await mockDialogs(app, [F.plan]);
    await win.click('#spsPlanImportBtn');
    await waitFor(win, () => document.getElementById('planImportBack')?.classList.contains('open'), null, 15000);
    await win.click('#piPickFile');
    await waitFor(win, () => (document.getElementById('piMapRows')?.querySelectorAll('.pi-maprow').length || 0) > 0, null, 20000);
    await sleep(700);
    await capture(win, '12a-plan-import-mapping', 'Survey plan import: the file is read and its columns are mapped', [
      { sel: '#piPickFile', label: 'Choose the plan file (CSV / TSV / GeoJSON)' },
      { sel: '#piMapRows', label: 'One row per column in the file; SeisConv guesses, you correct', at: 'tr' },
      { sel: '#piKindProj', label: 'Projected easting/northing, or WGS84 lat/long' },
      { sel: '#piImport', label: 'Import stays disabled until the mapping, CRS and role are all set', at: 'tr' },
    ]);
    await win.selectOption('#piRole', 'R'); await sleep(500);
    await capture(win, '12b-plan-import-ready', 'The same wizard scrolled to the role and mode, with Import now enabled', [
      { sel: '#piRole', label: 'Role chosen: receivers - Import was disabled until this was set' },
      { sel: '#piModeReplace', label: 'Replace the current plan, or append to it' },
      { sel: '#piAsPreplot', label: 'Keep the stations exactly as given, rather than re-laying them' },
      { sel: '#piImport', label: 'Import is now enabled and names the point count', at: 'tr' },
    ], { scrollTo: '#piRole' });
    await win.click('#piImport');
    await waitFor(win, () => !document.getElementById('planImportBack')?.classList.contains('open'), null, 40000);
    await sleep(1200);
    await win.click('#spsPlanFit').catch(() => {});
    await sleep(1200);
    await setCheck(win, '#plTilesOn', true);
    // Give the tile layer time to actually paint: a picture of a half-loaded basemap is
    // worse than no basemap. Wait until Leaflet reports no tile still loading.
    await waitFor(win, () => {
      const c = document.querySelector('#spsCreateMap .leaflet-tile-pane');
      if (!c) return false;
      const t = c.querySelectorAll('img.leaflet-tile');
      return t.length > 0 && [...t].every((i) => i.classList.contains('leaflet-tile-loaded'));
    }, null, 45000);
    await sleep(1500);
    await capture(win, '13-sps-creation', 'SPS Creation with the imported plan on the satellite basemap, two lines drawn', [
      { sel: '#plTilesOn', label: 'The basemap layer and its opacity; the layer picker at the top right of the map chooses satellite, streets or a grey regional canvas' },
      { sel: '#spsPlanImportBtn', label: 'Import a plan from a file' },
      { sel: '#plModeAdd', label: 'Draw mode: view, add points, drag points' },
      { sel: '#spsPlanCanvas', label: 'The plan on the map', at: 'tr' },
      { sel: '#spsPlanTabPts', label: 'Points, Lines and Checks panes' },
      { sel: '#spsCreateCrsBtn', label: 'The CRS the survey will be generated in', at: 'tr' },
      { sel: '#spsCreateGenerate', label: 'Generate the SPS survey from this plan', at: 'tr' },
    ]);
  });

  // =================================================================== GENERATE 2D / 3D
  await step('generate2d', async () => {
    await win.click('#spsCreate2d'); await sleep(400);
    await win.click('#spsCreateGenerate');
    await waitFor(win, () => document.getElementById('spsWizardBack')?.classList.contains('open'), null, 15000);
    await sleep(800);
    await capture(win, '14-sps-generate-2d', 'SPS generate wizard, 2D: sources and receivers laid along each picked line', [
      { sel: '#spsCreate2d', label: '2D acquisition was chosen before opening the wizard' },
      { sel: '#cRcvInt', label: 'Receiver interval and numbering' },
      { sel: '#cSrcInt', label: 'Source interval and numbering', at: 'tr' },
      { sel: '#cRcvLineStart', label: 'Line and point numbering of the generated stations', at: 'br' },
    ]);
    await capture(win, '14b-sps-generate-2d-output', 'The lower half of the same wizard: the relation and the output files', [
      { sel: '#cRelType', label: 'The relation written into the X file' },
      { sel: '#cBaseName', label: 'Base name for the S / R / X files' },
      { sel: '#spsWizardCreate', label: 'Create & Save…', at: 'tr' },
    ], { scrollTo: '#cBaseName' });
    await win.click('#spsWizardCancel').catch(() => {});
    await sleep(500);
  });

  await step('generate3d', async () => {
    await win.click('#spsCreate3d'); await sleep(400);
    await win.click('#spsCreateGenerate');
    await waitFor(win, () => document.getElementById('spsWizardBack')?.classList.contains('open'), null, 15000);
    await sleep(800);
    await capture(win, '15-sps-generate-3d', 'The same wizard in 3D: the picked lines become receiver lines and source lines are generated across them', [
      { sel: '#spsCreate3d', label: '3D acquisition' },
      { sel: '#cRcvInt', label: 'Receiver interval along each picked line' },
      { sel: '#cSrcInt', label: 'Source interval along the generated source lines', at: 'tr' },
    ]);
    await capture(win, '15b-sps-generate-3d-lines', 'The 3D-only controls: how the source lines are laid across the receiver lines', [
      { sel: '#cSrcLineSpacing', label: 'Spacing of the generated source lines' },
      { sel: '#cAzimuth', label: 'Azimuth of the generated source lines', at: 'tr' },
      { sel: '#spsWizardCreate', label: 'Create & Save…', at: 'tr' },
    ], { scrollTo: '#cSrcLineSpacing' });
    await win.click('#spsWizardCancel').catch(() => {});
    await sleep(500);
    await win.click('#spsCreate2d').catch(() => {});
  });

  // =================================================================== GEOMETRY QC
  await step('geomqc', async () => {
    await gotoTab(win, 'tab-geomqc', 'panel-geomqc');
    await sleep(700);
    await win.click('#spsGeomChkBtn').catch(() => {});
    await sleep(2500);
    // The open SEG-Y is a DIFFERENT line from the loaded SPS survey, so this check finds a
    // real mismatch - which is what the tab exists to do. An all-green panel would teach
    // nothing about how a finding is read.
    await capture(win, '16-geometry-qc', 'Geometry QC finding a mismatch: the open file\'s receiver coordinates match no station in the loaded survey', [
      { sel: '#spsGeomChkBtn', label: 'Cross-check the headers against the survey' },
      { sel: '#geomChkTol', label: 'Match tolerance, in metres', at: 'tr' },
      { sel: '#spsGeomLoadBtn', label: 'Stamp the survey coordinates into the headers and save a new SEG-Y' },
      { sel: '#spsDeltaBtn', label: 'Or diff the as-laid survey against a pre-plot', at: 'tr' },
    ]);
  });

  // =================================================================== OBSERVER LOG
  await step('obslog', async () => {
    await gotoTab(win, 'tab-obslog', 'panel-obslog');
    await sleep(600);
    const gridVisible = async () => win.evaluate(() => {
      const g = document.getElementById('obslogGrid');
      return !!g && getComputedStyle(g).display !== 'none';
    });
    if (!(await gridVisible())) {
      await capture(win, '17a-obslog-setup', 'Observer Log setup: choose the column groups before the log is built', [
        { sel: '#ologBuildBtn', label: 'Build the log with the chosen columns', at: 'tr' },
      ], { scrollTo: '#ologBuildBtn' });
      await win.click('#ologBuildBtn');
      await waitFor(win, () => {
        const g = document.getElementById('obslogGrid');
        return !!g && getComputedStyle(g).display !== 'none';
      }, null, 20000);
    }
    // No hand-added blank rows: the log already carries one row per source imported from
    // the loaded SPS survey, which is the state a reader will actually meet.
    await sleep(500);
    await capture(win, '17b-obslog-grid', 'Observer Log with rows: the live grid, the time source and the auto-trigger', [
      { sel: '#ologAddRowBtn', label: 'Add a row by hand' },
      { sel: '#otwToggle', label: 'Trigger Watch: add a row the moment a shot fires', at: 'tr' },
      { sel: '#ologTsPc', label: 'Where the timestamp comes from: PC clock or NTP' },
      { sel: '#ologColsBtn', label: 'Edit the columns', at: 'tr' },
      { sel: '#ologSaveBtn', label: 'Save the log as JSON', at: 'tr' },
    ]);
  });

  // =================================================================== SWEEPS
  await step('sweeps', async () => {
    await gotoTab(win, 'tab-sweeps', 'panel-sweeps');
    await sleep(600);
    await win.fill('#swF0', '8').catch(() => {});
    await win.fill('#swF1', '96').catch(() => {});
    await win.fill('#swLen', '12000').catch(() => {});
    await win.click('#swBuildBtn');
    await sleep(2200);
    await capture(win, '18-sweeps', 'Sweeps: an 8-96 Hz, 12 s linear sweep and its Klauder wavelet', [
      { sel: '#swF0', label: 'Start and end frequency' },
      { sel: '#swLen', label: 'Sweep length and taper', at: 'tr' },
      { sel: '#swBuildBtn', label: 'Build the sweep and refresh every plot' },
      { sel: '#swSignalCanvas', label: 'The pilot signal', at: 'tr' },
      { sel: '#swKlauderCanvas', label: 'The Klauder wavelet this sweep will produce', at: 'tr' },
      { sel: '#swExpSheet', label: 'Export a printable sweep sheet', at: 'tr' },
    ]);
  });

  // =================================================================== WIFISYNC
  await step('wifisync', async () => {
    await gotoTab(win, 'tab-field', 'panel-field');
    // Choose a shared folder, so the panel is CONFIGURED rather than blank. The engine
    // itself is deliberately not started: a manual picture must not open sockets or ask
    // the firewall for anything on the machine that renders it.
    await mockDialogs(app, [F.dir]);
    await win.click('#fldPickFolder').catch(() => {});
    await sleep(1200);
    // A peers table with something IN it, so the Trust column is actually photographed.
    // These are not discovered machines: the two announcements are pushed down the real
    // 'seisconv:fieldEvent' channel from the main process, so the picture is drawn by the
    // application's own renderer while no socket is opened and nothing is discovered.
    // 192.168.137.x is the Windows hotspot subnet - a private, non-routable example.
    await app.evaluate(async ({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.send('seisconv:fieldEvent', { type: 'peer', action: 'found', ip: '192.168.137.42', port: 47824, role: 'both' });
      wc.send('seisconv:fieldEvent', { type: 'peer', action: 'pending', ip: '192.168.137.87', port: 47824, role: 'slave' });
    });
    await sleep(1500);
    // refreshField() runs on tab activation and CLEARS the approved list from the real
    // engine status (which is empty, nothing is running), so announce once more after it
    // has settled - otherwise only the pending row survives into the picture.
    await app.evaluate(async ({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.send('seisconv:fieldEvent', { type: 'peer', action: 'found', ip: '192.168.137.42', port: 47824, role: 'both' });
      wc.send('seisconv:fieldEvent', { type: 'peer', action: 'pending', ip: '192.168.137.87', port: 47824, role: 'slave' });
    });
    await sleep(700);
    await capture(win, '19-wifisync', 'WiFiSync: move files between two field machines with no network', [
      { sel: '#fldPickFolder', label: 'The folder kept mirror-identical with the peer' },
      { sel: '#fldStartBtn', label: 'Start WiFiSync on this machine' },
      { sel: '#fldAllowDelete', label: 'Off by default: a peer deleting a file does NOT delete your copy', at: 'bl' },
      { sel: '#fldPeerBody tr:nth-child(1) td:nth-child(4)', label: 'Trust: an approved machine, and Revoke to stop syncing with it', at: 'tr' },
      { sel: '#fldPeerBody tr:nth-child(2) td:nth-child(4)', label: 'Nothing is shared with a machine until you press Approve', at: 'br' },
      { sel: '#fldHsPass', label: 'The hotspot password - no default, you choose one (8+ characters)', at: 'tr' },
    ]);
  });

  // =================================================================== HELP
  await step('help', async () => {
    await win.click('#railHelp');
    await waitFor(win, () => document.getElementById('manualBack')?.classList.contains('open'), null, 10000);
    await sleep(400);
    // Open on "Getting started" - the first topic a reader of this manual will want.
    await win.evaluate(() => {
      const b = [...document.querySelectorAll('#manualNav button')].find((x) => /getting started/i.test(x.textContent || ''));
      b?.click();
    });
    await sleep(700);
    await capture(win, '20-help-modal', 'The in-app Help: the same source this manual\'s reference chapter is generated from', [
      { sel: '#manualNav', label: 'One topic per tab' },
      { sel: '#manualContent', label: 'What the tab is for, every control, and how to use it', at: 'tr' },
      { sel: '#manualClose', label: 'Close (Esc, or ? again)', at: 'tr' },
    ]);
    await win.click('#manualClose').catch(() => {});
    await sleep(300);
  });

  // =================================================================== report
  await app.close();

  // An --only run regenerates PART of the set, so it must MERGE into the manifest, not
  // replace it: writing only the shots just taken would silently delete every other
  // picture's entry and the manual would lose its captions.
  const fresh = shots.map((s) => ({ name: s.name, image: s.image, caption: s.caption, callouts: s.callouts.length, bytes: s.bytes }));
  let merged = fresh;
  if (only) {
    let prev = [];
    try { prev = JSON.parse(readFileSync(join(IMG, 'index.json'), 'utf8')).shots || []; } catch { prev = []; }
    const byName = new Map(prev.map((s) => [s.name, s]));
    for (const s of fresh) byName.set(s.name, s);
    merged = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  const manifest = {
    generated: 'docs/manual/shots.mjs',
    app: 'SeisConv',
    window: WIN,
    fixtures: { seed: F.seed, origin: F.origin, counts: F.counts },
    shots: merged,
  };
  writeFileSync(join(IMG, 'index.json'), JSON.stringify(manifest, null, 2));

  const total = readdirSync(IMG).filter((f) => f.endsWith('.png'))
    .reduce((a, f) => a + statSync(join(IMG, f)).size, 0);
  const leaky = shots.filter((s) => s.frameLeaks.length);
  const missing = shots.filter((s) => s.missingCallouts.length);

  console.log('\n================= MANUAL SHOTS REPORT =================');
  console.log(`images        : ${shots.length}`);
  console.log(`total size    : ${(total / 1024 / 1024).toFixed(2)} MB in ${IMG}`);
  console.log(`page/console  : ${errors.length} error(s)`);
  for (const e of errors.slice(0, 20)) console.log('   ' + e);
  console.log(`frame leaks   : ${leaky.length}`);
  for (const s of leaky) console.log(`   ${s.name}: ${s.frameLeaks.join(', ')}`);
  console.log(`bad callouts  : ${missing.length}`);
  for (const s of missing) console.log(`   ${s.name}: ${s.missingCallouts.join(', ')}`);
  console.log(`step failures : ${failures.length}`);
  for (const f of failures) console.log('   ' + f);
  const ok = !failures.length && !leaky.length && !missing.length && !errors.length;
  console.log(ok ? '\nALL GREEN' : '\nSEE THE LINES ABOVE');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
