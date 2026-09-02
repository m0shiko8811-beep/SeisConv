// SeisConv - live-drive for the two hover read-outs (v0.6.0).
//
//  Feature 1 (SPS tab): hovering a station on the survey-grid canvas shows a
//    cursor tooltip with its type (S/R), line and point.
//  Feature 2 (File Viewer): hovering a trace on the section shows the trace AND
//    its station (receiver / source), resolved to the loaded SPS survey.
//
// Uses REAL paired field data (a SEG-Y line + its production SPS). Runs headed
// against an isolated --user-data-dir so it never fights the installed app's lock.
//
// USAGE:  SEISCONV_QA_USER_DATA_DIR=<temp> node qa/live_hover.mjs
//         Point HOVER_SEGY / HOVER_SPS (';'-separated) at a paired SEG-Y + SPS
//         set, or put { "le": ..., "hoverSps": [...] } in qa/local-paths.json.

import { launch, mockDialogs, gotoTab, openFile, loadSps, shot, sleep, DATA_ROOT, qaPath, qaPaths } from './harness.mjs';

const SEGY = process.env.HOVER_SEGY || qaPath('le', `${DATA_ROOT}\\Data_Games\\little-endian.sgy`);
const SPS = process.env.HOVER_SPS
  ? process.env.HOVER_SPS.split(';').map((s) => s.trim()).filter(Boolean)
  : qaPaths('hoverSps', [
      `${DATA_ROOT}\\SPS_Games\\NodesCheck20.s01`,
      `${DATA_ROOT}\\SPS_Games\\NodesCheck20.r01`,
      `${DATA_ROOT}\\SPS_Games\\NodesCheck20.x01`,
    ]);

const rectOf = (win, id) => win.evaluate((i) => {
  const el = document.getElementById(i); if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}, id);

async function main() {
  const { app, win, errors } = await launch();
  let ok = true;

  // --- Feature 1: SPS grid station tooltip -------------------------------
  await loadSps(app, win, SPS);
  await gotoTab(win, 'tab-sps', 'panel-sps'); // ensure grid view is active
  await sleep(400);
  const gr = await rectOf(win, 'spsCanvas');
  if (!gr) throw new Error('spsCanvas not found');

  // Sweep the canvas until the cursor lands on/near a station and the tooltip shows.
  let tipText = '', hit = null;
  outer:
  for (let y = gr.y + 12; y < gr.y + gr.h - 12; y += 9) {
    for (let x = gr.x + 12; x < gr.x + gr.w - 12; x += 9) {
      await win.mouse.move(x, y);
      const vis = await win.evaluate(() => {
        const t = document.getElementById('spsHoverTip');
        return t && getComputedStyle(t).display !== 'none' ? t.textContent : '';
      });
      if (vis) { tipText = vis.replace(/\s+/g, ' ').trim(); hit = { x, y }; break outer; }
    }
  }
  console.log('[F1] SPS grid hover tooltip:', JSON.stringify(tipText), 'at', hit);
  if (!/^[SR]\b/.test(tipText) || !/line/i.test(tipText) || !/point/i.test(tipText)) {
    console.error('[F1] FAIL - tooltip did not show type/line/point'); ok = false;
  }
  await shot(win, 'sps-hover.png');

  // --- Feature 2: File Viewer trace + station read-out -------------------
  await openFile(app, win, SEGY);
  await gotoTab(win, 'tab-section', 'panel-section');
  await sleep(600);
  // Scroll the hover read-out line into view so the screenshot captures it under
  // the section (it lives below the tall canvas otherwise).
  await win.evaluate(() => document.getElementById('secHover')?.scrollIntoView({ block: 'end' }));
  await sleep(200);
  const sr = await rectOf(win, 'secCanvas');
  if (!sr) throw new Error('secCanvas not found');

  // Hover a visible point of the section; wait for the async station suffix, read.
  const hx = sr.x + sr.w * 0.55, hy = sr.y + Math.min(sr.h * 0.7, sr.h - 30);
  await win.mouse.move(hx, hy);
  await sleep(300);
  await win.mouse.move(hx + 6, hy + 4); // nudge to (re)trigger the debounced fetch
  let secText = '';
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    secText = (await win.textContent('#secHover'))?.replace(/\s+/g, ' ').trim() || '';
    if (/station:/i.test(secText)) break;
  }
  console.log('[F2] File Viewer hover read-out:', JSON.stringify(secText));
  if (!/trace\s/i.test(secText) || !/station:/i.test(secText)) {
    console.error('[F2] FAIL - read-out missing trace or station'); ok = false;
  }
  await shot(win, 'viewer-hover.png');

  console.log('\npageerrors/console.errors:', errors.length);
  if (errors.length) console.log(errors.slice(0, 8).join('\n'));
  await app.close();
  console.log(`\nRESULT: ${ok && errors.length === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(ok && errors.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
