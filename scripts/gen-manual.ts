// Generate MANUAL.md from the in-app Help content (renderer/src/manual.ts), so the
// two can never drift apart. Run from the repo root:  npm run gen:manual
//
// The help strings are hand-authored HTML fragments (they are injected into the
// modal as innerHTML), so the only work here is turning that small, KNOWN subset
// of tags into Markdown: <b>, <i>, <span class="kbd">, <span class="mono">, and
// the handful of entities the topics use. Anything unexpected is left visible
// rather than silently swallowed, so a new tag shows up in review.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MANUAL, type HelpTopic } from '../renderer/src/manual';

/** One inline HTML fragment from a help topic → Markdown. */
function md(html: string): string {
  let s = html;
  s = s.replace(/<span class="kbd"[^>]*>(.*?)<\/span>/g, (_m, t) => '`' + strip(t) + '`');
  s = s.replace(/<span class="mono">(.*?)<\/span>/g, (_m, t) => '`' + strip(t) + '`');
  s = s.replace(/<b>(.*?)<\/b>/g, '**$1**');
  s = s.replace(/<i>(.*?)<\/i>/g, '*$1*');
  return entities(s);
}
function strip(s: string): string { return entities(s.replace(/<[^>]+>/g, '')); }
function entities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&copy;/g, '©')
    .replace(/&minus;/g, '−');
}

function topicMd(t: HelpTopic): string {
  const out: string[] = [`## ${md(t.title)}`, '', md(t.what), ''];
  const list = (h: string, items: string[], ordered = false) => {
    if (!items || !items.length) return;
    out.push(`### ${h}`, '');
    items.forEach((it, i) => out.push(`${ordered ? `${i + 1}.` : '-'} ${md(it)}`));
    out.push('');
  };
  list('Controls', t.controls);
  for (const sec of t.sections ?? []) list(md(sec.h), sec.items, sec.ordered);
  list('How to use it', t.steps, true);
  list('Tips', t.tips ?? []);
  list('Good to know', t.notes ?? []);
  return out.join('\n');
}

// Same topic order the Help modal's nav uses: 'general' first, then app tab order.
const ORDER = ['general', 'conv', 'trace', 'section', 'sps', 'spscreate', 'vel',
  'spectrum', 'workbench', 'obslog', 'geomqc', 'sweeps', 'field'];

const parts = [
  '# SeisConv - Manual',
  '',
  '<!-- GENERATED FILE - DO NOT EDIT BY HAND.',
  '     Source: renderer/src/manual.ts (the in-app Help, opened with `?`).',
  '     Regenerate with:  npm run gen:manual  -->',
  '',
  'This is the same content the app shows under **?** (Help), one topic per tab.',
  'Key hints use **Ctrl** on Windows/Linux and **Cmd** on macOS; the app shows the',
  'right glyph for your OS automatically.',
  '',
  '---',
  '',
];
const seen = new Set<string>();
for (const k of [...ORDER, ...Object.keys(MANUAL)]) {
  if (seen.has(k) || !MANUAL[k]) continue;
  seen.add(k);
  parts.push(topicMd(MANUAL[k]), '---', '');
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
writeFileSync(join(root, 'MANUAL.md'), parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf8');
console.log(`MANUAL.md written from renderer/src/manual.ts (${seen.size} topics)`);
