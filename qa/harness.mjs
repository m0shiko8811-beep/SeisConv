// SeisConv QA harness — reusable Playwright _electron helpers.
// Import from drive.mjs, verify.mjs, or any throwaway qa/_check.mjs so the
// launch / mock-dialog / open-file / tab / screenshot boilerplate is written once.
import { _electron as electron } from 'playwright';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = resolve(__dirname, '..');           // repo root (package.json main=dist/main.js)
export const SHOTS = join(__dirname, 'shots');
mkdirSync(SHOTS, { recursive: true });

// Default real-data files (override via env).
export const SEGY = process.env.SEISCONV_QA_SEGY || './samples/example.segy';
export const SPS = (process.env.SEISCONV_QA_SPS || [
  './samples/survey.s01',
  './samples/survey.r01',
  './samples/survey.x01',
].join(';')).split(';').map((s) => s.trim()).filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch the BUILT app; returns { app, win, errors } where errors collects
 *  pageerrors + console.error for the whole session. */
export async function launch() {
  const app = await electron.launch({ args: ['.'], cwd: APP_DIR });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push('pageerror: ' + (e.message || e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await win.waitForLoadState('domcontentloaded');
  await sleep(500);
  return { app, win, errors };
}

/** Point the MAIN-process open dialog at `paths`; save dialog cancels (write
 *  flows complete without touching disk). */
export async function mockDialogs(app, paths) {
  await app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p });
    dialog.showSaveDialog = async () => ({ canceled: true });
  }, paths);
}

/** Click a rail tab and wait for its panel to be visible. The rail click is made
 *  robust against an intermittent actionability TIMEOUT (a transient toast/re-render
 *  briefly over the rail after a heavy step, e.g. workbench → obslog): wait for the
 *  tab to be visible + scroll it into view + click, falling back to a forced click.
 *  The panel-visible wait below stays the REAL assertion that the tab switched —
 *  this only stabilises HOW we click, it does not mask a tab that fails to open. */
export async function gotoTab(win, tabId, panelId) {
  const tab = win.locator('#' + tabId);
  try {
    await tab.waitFor({ state: 'visible', timeout: 8000 });
    await tab.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    await tab.click({ timeout: 6000 });
  } catch {
    await tab.click({ force: true, timeout: 6000 }).catch(() => {});
  }
  await win.waitForFunction((pid) => {
    const el = document.getElementById(pid);
    return el && getComputedStyle(el).display !== 'none';
  }, panelId, { timeout: 8000 }).catch(() => {});
  await sleep(250);
}

/** Open a seismic file via the Converter's in-panel open button (#openBtn2),
 *  waiting until the summary reflects THIS file. Returns the trace-count text.
 *  (The global header Open was removed in the Phase 2 IA refactor; each data tab
 *  now carries its own Open SEG-Y. The Converter wizard's #openBtn2 still opens.) */
export async function openFile(app, win, path) {
  await mockDialogs(app, [path]);
  await win.click('#tab-conv'); await sleep(150);
  await win.click('#openBtn2');
  const base = path.replace(/\\/g, '/').split('/').pop();
  await win.waitForFunction((b) => {
    const t = document.getElementById('fsTraces');
    const name = (document.getElementById('singleFoundName')?.textContent || document.getElementById('fiName')?.textContent || '').trim();
    return t && t.textContent.trim() && t.textContent.trim() !== '—' && name.includes(b);
  }, base, { timeout: 30000 }).catch(() => {});
  return (await win.textContent('#fsTraces'))?.trim();
}

/** Load an SPS triplet on the SPS tab (multiSelections). */
export async function loadSps(app, win, paths = SPS) {
  await gotoTab(win, 'tab-sps', 'panel-sps');
  await mockDialogs(app, paths);
  await win.click('#spsLoadBtn');
  await win.waitForFunction(() => { const s = document.getElementById('spsStats'); return s && s.textContent.trim().length > 0; }, null, { timeout: 20000 }).catch(() => {});
  await sleep(400);
}

/** Screenshot to qa/shots/<name>.png. */
export async function shot(win, name) {
  const p = join(SHOTS, name.endsWith('.png') ? name : name + '.png');
  await win.screenshot({ path: p }).catch(() => {});
  return p;
}
