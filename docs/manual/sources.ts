// docs/manual/sources.ts - every NUMBER and LIST in the manual, read from the code
// at generation time. Nothing here is retyped from memory: if a fact cannot be
// derived from source it is returned as a PLACEHOLDER (see `todo()`), which the
// generator renders as a loud marker so it can never be mistaken for fact.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listWriters } from '../../core/formats/registry';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A fact we could not source automatically. Rendered as a visible marker. */
export function todo(what: string): string {
  return `<span class="todo">[TO SOURCE: ${what}]</span>`;
}

export function pkg(): { version: string; description: string; license: string } {
  const p = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  return {
    version: String(p.version ?? ''),
    description: String(p.description ?? ''),
    license: String(p.license ?? ''),
  };
}

/**
 * Output formats. The registry (core/formats/registry.ts:74-82) is the list of writers
 * that EXIST; what the user actually SEES are the format chips in renderer/index.html,
 * and those two are deliberately not the same list: Tape Image is a batch-combine
 * target, so it appears in the folder-mode chip group (#fmtChipsBatch) and NOT in the
 * single-file one (#fmtChips) - renderer/src/app.ts also forces the selection back to
 * SEG-Y Rev 1 if the mode is switched to single while tpimage is picked (setConvMode).
 * We therefore read the chips out of the markup rather than assume 1:1 with the
 * registry, so the manual can never claim a count the app does not offer.
 */
export type WriterRow = { id: string; label: string; ext: string; single: boolean; batch: boolean };
export function writers(): WriterRow[] {
  const single = chipFormats('fmtChips');
  const batch = chipFormats('fmtChipsBatch');
  return listWriters().map((w) => ({
    id: w.id, label: w.label, ext: w.ext,
    single: single.includes(w.id), batch: batch.includes(w.id),
  }));
}
/** The `data-fmt` ids inside one chip group in renderer/index.html. */
function chipFormats(groupId: string): string[] {
  const html = readFileSync(join(REPO, 'renderer', 'index.html'), 'utf8');
  const g = new RegExp(`id="${groupId}"[^>]*>([\\s\\S]*?)</div>`).exec(html);
  if (!g) return [];
  return [...g[1].matchAll(/data-fmt="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The built-in CRS registry: how many systems, and how many of those are geographic
 * (lat/long) rather than projected - the picker searches all of them, so the reader
 * sees the full number. Counted from core/sps/epsg-registry.json, whose row count is
 * also what core/sps/epsgdb.ts `epsgCount()` returns at runtime.
 */
export function epsgStats(): { total: number; geographic: number; projected: number } | null {
  try {
    const j = JSON.parse(readFileSync(join(REPO, 'core', 'sps', 'epsg-registry.json'), 'utf8'));
    const rows: { m?: string }[] = Array.isArray(j.rows) ? j.rows : [];
    if (!rows.length) return null;
    const geographic = rows.filter((r) => r.m === 'GEO').length;
    return { total: rows.length, geographic, projected: rows.length - geographic };
  } catch { return null; }
}

/**
 * Keyboard shortcuts, read out of `onKeyDown` in renderer/src/app.ts. The KEYS are
 * parsed from the handler (so they cannot drift); the human wording comes from the
 * table below, keyed by the call the branch makes. An unmapped branch is emitted
 * with a placeholder rather than a guess.
 */
const ACTION_WORDS: Record<string, string> = {
  'zoomBy(1)': 'Zoom the whole UI in',
  'zoomBy(-1)': 'Zoom the whole UI out',
  'zoomReset()': 'Reset the UI zoom',
  'openManual': 'Open (or close) the in-app manual',
  'onOpen()': 'Open a seismic file',
  "switchTab('conv')": 'Go to the Converter in batch (folder) mode',
  'planUndo()': 'Undo the last survey-plan edit (SPS Creation tab only)',
  'navFile(-1)': 'Step to the previous seismic file in the same folder',
  'navFile(1)': 'Step to the next seismic file in the same folder',
  'switchTab(TABS[idx])': 'Jump straight to that tab',
};
/** The tab ids, in the rail's order, from `const TABS = [...]` in renderer/src/app.ts. */
export function tabs(): string[] {
  const src = readFileSync(join(REPO, 'renderer', 'src', 'app.ts'), 'utf8');
  const m = /const TABS = \[([^\]]*)\] as const;/.exec(src);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}

export type Shortcut = { keys: string; action: string };
export function shortcuts(): Shortcut[] {
  const src = readFileSync(join(REPO, 'renderer', 'src', 'app.ts'), 'utf8');
  const m = /function onKeyDown\(e: KeyboardEvent\) \{([\s\S]*?)\r?\n\}\r?\n/.exec(src);
  if (!m) return [{ keys: todo('shortcut keys'), action: todo('onKeyDown not found in renderer/src/app.ts') }];
  const out: Shortcut[] = [{
    keys: 'Esc',
    action: 'Close whatever is open: confirm dialog, modal, zoom viewer, box-select mode, or the undo toast',
  }];
  const lines = m[1].split('\n').map((l) => l.trim());
  // `if (e.ctrlKey || e.metaKey) { ... }` wraps the UI-zoom branches, so those inner
  // lines carry no modifier of their own - track the block instead of guessing.
  let ctrlBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^if \(e\.ctrlKey \|\| e\.metaKey\) \{$/.test(line)) { ctrlBlock = true; continue; }
    if (ctrlBlock && line === '}') { ctrlBlock = false; continue; }
    if (!line.startsWith('if (')) continue;
    const close = line.indexOf(') {');
    const cond = line.slice(4, close >= 0 ? close : line.length);
    const keys = [...cond.matchAll(/e\.key === '([^']+)'/g)].map((k) => k[1]);
    const range = /e\.key >= '(\d)' && e\.key <= '(\d)'/.exec(cond);
    if (!keys.length && !range) continue;
    if (keys.every((k) => k === 'Escape') && !range) continue; // summarised above
    // A branch may span a few lines (the tab-number one does), so look a little ahead.
    const body = (close >= 0 ? line.slice(close + 3) : '') || lines.slice(i + 1, i + 4).join(' ');
    const call = Object.keys(ACTION_WORDS).find((k) => body.includes(k)) ?? '';
    const mod = ctrlBlock || /(^|[^!])\bmod &&/.test(cond) || /(^|[^!])\be\.ctrlKey/.test(cond);
    const label = range ? `${range[1]} … ${range[2]}` : dedupe(keys.map(prettyKey)).join(' or ');
    out.push({
      keys: (mod ? 'Ctrl/Cmd + ' : '') + label,
      action: call ? ACTION_WORDS[call] : todo(`what \`${body.slice(0, 60).trim()}\` does`),
    });
  }
  return out;
}
function dedupe(a: string[]): string[] { return [...new Set(a)]; }
function prettyKey(k: string): string { return k.length === 1 ? k.toUpperCase() : k; }

/** Test totals, from an actual run of the core suite - never from memory. */
export function testCounts(): { passed: number; failed: number; skipped: number } | null {
  try {
    // Call tsx's CLI through node directly: spawning npx/npx.cmd needs a shell on
    // Windows, and passing args through a shell is exactly what we do not want.
    const tsxCli = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const out = execFileSync(process.execPath, [tsxCli, join(REPO, 'core', '__tests__', 'run.ts')], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const m = /passed:\s*(\d+)\s+failed:\s*(\d+)\s+skipped:\s*(\d+)/.exec(out);
    return m ? { passed: +m[1], failed: +m[2], skipped: +m[3] } : null;
  } catch { return null; }
}
