// scripts/release-notes.mjs - the GitHub release body and the Microsoft Store "What's new" text,
// both built from one CHANGELOG section so neither can drift from the changelog.
//
//   node scripts/release-notes.mjs <X> --github --facts facts.json [--out file]
//   node scripts/release-notes.mjs <X> --store  --facts facts.json [--out file]
//   node scripts/release-notes.mjs --self-test
//
// facts.json: {version, commit, coreTests:{passed,failed,skipped},
//   qa:{passed,total,failed,pageErrors,consoleErrors}, pages:{A4,Letter},
//   installer:{name,size,sha256}, appx:{name,size,sha256}}
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  REPO_ROOT, REPO_SLUG, UPDATE_NOTES_MAX, CRITICAL_RE,
  changelogSection, parseArgs, privacyLabels, safeText, error,
} from './release-lib.mjs';

export const STORE_MAX = 1500;
export const STORE_CLOSING = 'See the release notes on GitHub for the full list.';

const isCount = (n) => Number.isInteger(n) && n >= 0;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const chars = (s) => [...s].length; // the Store counts characters, not UTF-16 units

function checkFacts(version, facts, full) {
  const bad = [];
  if (!facts || facts.version !== version) bad.push(`facts.version is ${JSON.stringify(facts?.version)}, expected ${version}`);
  if (full) {
    for (const k of ['passed', 'failed', 'skipped']) if (!isCount(facts?.coreTests?.[k])) bad.push(`facts.coreTests.${k} is not a count`);
    for (const k of ['passed', 'total', 'failed', 'pageErrors', 'consoleErrors']) if (!isCount(facts?.qa?.[k])) bad.push(`facts.qa.${k} is not a count`);
    if (!(Number.isInteger(facts?.pages?.A4) && facts.pages.A4 > 0)) bad.push('facts.pages.A4 is not a page count');
  }
  if (bad.length) throw new Error(bad.join('; '));
}

/** Take the SEISCONV_CRITICAL line out of a section body. One at most: the app honours only the first. */
export function extractCritical(body) {
  const lines = body.split('\n');
  const hits = [];
  lines.forEach((l, i) => { const m = CRITICAL_RE.exec(l); if (m) hits.push({ i, reason: m[1].replace(/\s+/g, ' ').trim() }); });
  if (!hits.length) return { reason: null, body };
  if (hits.length > 1) throw new Error('the section has more than one SEISCONV_CRITICAL line');
  const { i, reason } = hits[0];
  if (!reason) throw new Error('the SEISCONV_CRITICAL line carries no reason');
  lines.splice(i, 1);
  // Do not leave a double blank line where the marker stood.
  if (i > 0 && i < lines.length && !lines[i - 1].trim() && !lines[i].trim()) lines.splice(i, 1);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return { reason, body: lines.join('\n') };
}

/** The GitHub release body, in the format of the published v0.8.4 release. */
export function githubBody(version, sectionBody, facts) {
  checkFacts(version, facts, true);
  const { reason, body } = extractCritical(sectionBody);
  if (!body.trim()) throw new Error(`CHANGELOG section [${version}] is empty`);
  const { coreTests: t, qa } = facts;
  const errs = qa.pageErrors === 0 && qa.consoleErrors === 0
    ? 'zero page errors and zero console errors'
    : `${plural(qa.pageErrors, 'page error')} and ${plural(qa.consoleErrors, 'console error')}`;
  const installer = facts.installer?.name || `SeisConv-Setup-${version}.exe`;
  const head = [
    ...(reason ? [`SEISCONV_CRITICAL: ${reason}`, ''] : []),
    `**Windows 10/11, 64-bit.** Download \`${installer}\` below and run it.`, '',
    'The installer is not code-signed, so SmartScreen will warn on first run: **More info**, then **Run anyway**.', '',
    `The ${facts.pages.A4}-page manual is attached as a PDF in both A4 and Letter.`, '',
    '---', '',
  ].join('\n');
  const foot = `**Verified for this build:** typecheck clean, ${t.passed} tests passed / ${t.failed} failed / ${t.skipped} skipped, `
    + `and the ${qa.total}-tab UI harness at ${qa.passed}/${qa.total} with ${errs}.`;
  const text = `${head}\n${body}\n\n${foot}\n`;
  if (reason) {
    // The in-app check only scans the first UPDATE_NOTES_MAX characters (electron/main.ts:688).
    const lineEnd = text.indexOf('\n');
    if (!CRITICAL_RE.test(text.slice(0, lineEnd)) || lineEnd >= UPDATE_NOTES_MAX) {
      throw new Error(`the SEISCONV_CRITICAL line does not end inside the first ${UPDATE_NOTES_MAX} characters`);
    }
  }
  return text;
}

const plainMd = (s) => s
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\*\*/g, '')
  .replace(/`/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** The short form of one item: its bold lead when it opens with one, otherwise its first sentence. */
export function storeLead(raw) {
  const text = raw.replace(/\s+/g, ' ').trim();
  const bold = /^\*\*(.+?)\*\*/.exec(text);
  if (bold) return plainMd(bold[1]);
  const plain = plainMd(text);
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(plain);
  return sentence ? sentence[1] : plain;
}

/**
 * Bullets and `>` quote blocks of a section, each reduced to its lead. A whole bullet runs to
 * hundreds of characters, so whole bullets would leave room for one or two items in the Store
 * field. Headings and loose paragraphs are dropped.
 */
export function storeItems(body) {
  const items = [];
  let cur = null;
  const close = () => { if (cur) items.push(storeLead(cur.parts.join(' '))); cur = null; };
  for (const line of body.split('\n')) {
    if (!line.trim() || /^#/.test(line)) { close(); continue; }
    if (/^\s*>/.test(line)) {
      const inner = line.replace(/^\s*>\s?/, '');
      if (!inner.trim()) { close(); continue; }
      if (cur?.kind !== 'quote') { close(); cur = { kind: 'quote', parts: [] }; }
      cur.parts.push(inner.trim());
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) { close(); cur = { kind: 'bullet', parts: [bullet[1]] }; continue; }
    // A wrapped continuation line joins the item it belongs to.
    if (cur) cur.parts.push(line.trim().replace(/^[-*+]\s+/, ''));
  }
  close();
  return items.filter(Boolean);
}

/** Store "What's new" text: at most STORE_MAX characters, cut after the last whole bullet. */
export function storeText(version, sectionBody, facts) {
  checkFacts(version, facts, false);
  const { reason, body } = extractCritical(sectionBody);
  const items = storeItems(body);
  if (!items.length) throw new Error(`CHANGELOG section [${version}] has no bullets for the store text`);
  const out = [`New in ${version}:`];
  if (reason) out.push(`Important: ${plainMd(reason)}`);
  const size = (lines) => chars([...lines, STORE_CLOSING].join('\n'));
  let kept = 0;
  for (const it of items) {
    if (size([...out, `- ${it}`]) > STORE_MAX) break;
    out.push(`- ${it}`);
    kept++;
  }
  if (!kept) throw new Error(`the first bullet alone does not fit the ${STORE_MAX} character store limit`);
  out.push(STORE_CLOSING);
  return { text: out.join('\n'), kept, total: items.length };
}

// ---------------------------------------------------------------- self-test

const EMBEDDED_HEAD = [
  '**Windows 10/11, 64-bit.** Download `SeisConv-Setup-0.8.4.exe` below and run it.', '',
  'The installer is not code-signed, so SmartScreen will warn on first run: **More info**, then **Run anyway**.', '',
  'The 101-page manual is attached as a PDF in both A4 and Letter.', '',
  '---', '',
];
const EMBEDDED_FOOT = '**Verified for this build:** typecheck clean, 493 tests passed / 0 failed / 4 skipped, '
  + 'and the 12-tab UI harness at 12/12 with zero page errors and zero console errors.';

function liveBody(tag) {
  const r = spawnSync('gh', ['release', 'view', tag, '--repo', REPO_SLUG, '--json', 'body'], { encoding: 'utf8', timeout: 60000 });
  if (r.error || r.status !== 0) return null;
  try { return JSON.parse(r.stdout).body; } catch { return null; }
}

function selfTest() {
  const results = [];
  const check = (name, fn) => {
    try { results.push({ ok: true, name, note: fn() }); } catch (e) { results.push({ ok: false, name, note: e.message }); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const facts084 = {
    version: '0.8.4', coreTests: { passed: 493, failed: 0, skipped: 4 },
    qa: { passed: 12, total: 12, failed: 0, pageErrors: 0, consoleErrors: 0 }, pages: { A4: 101 },
  };
  const facts090 = { ...facts084, version: '0.9.0' };
  let built084 = '';

  check('(a) v0.8.4 body rebuilt from CHANGELOG equals the live release body', () => {
    built084 = githubBody('0.8.4', changelogSection(changelog, '0.8.4').body, facts084);
    const live = liveBody('v0.8.4');
    if (live !== null) {
      if (built084 !== live) {
        let i = 0;
        while (i < built084.length && built084[i] === live[i]) i++;
        throw new Error(`differs at character ${i} (line ${built084.slice(0, i).split('\n').length}); built ${built084.length} chars, live ${live.length}`);
      }
      return `identical to the live body, ${live.length} chars`;
    }
    const lines = built084.split('\n');
    assert(EMBEDDED_HEAD.every((l, i) => lines[i] === l), 'header lines differ from the embedded copy');
    assert(lines[lines.length - 2] === EMBEDDED_FOOT && lines[lines.length - 1] === '', 'footer line differs from the embedded copy');
    return 'gh or network unavailable, compared the embedded header and footer lines only';
  });

  const bullet = (i) => `- **Change ${i}.** The \`tool${i}\` now reads [the spec](https://example.com/${i}) and\n  keeps a wrapped tail for item ${i}.`;
  const reason = 'files written by 0.8.9 carry a wrong sample interval, re-export them';

  check('(b) a critical line deep in a long section moves to the top', () => {
    const before = Array.from({ length: 60 }, (_, i) => bullet(i)).join('\n');
    const after = Array.from({ length: 20 }, (_, i) => bullet(60 + i)).join('\n');
    const section = `\n### Fixed\n\n${before}\n- SEISCONV_CRITICAL: ${reason}\n${after}`;
    assert(section.indexOf('SEISCONV_CRITICAL') > UPDATE_NOTES_MAX, 'fixture is not long enough to prove anything');
    const text = githubBody('0.9.0', section, facts090);
    assert(text.startsWith(`SEISCONV_CRITICAL: ${reason}\n\n**Windows 10/11, 64-bit.**`), 'critical line is not the first line');
    assert(text.split('SEISCONV_CRITICAL').length === 2, 'marker appears more than once');
    const scanned = text.slice(0, UPDATE_NOTES_MAX).split('\n').map((l) => CRITICAL_RE.exec(l)).find(Boolean);
    assert(scanned && scanned[1] === reason, 'marker not found in the first 4000 characters');
    assert(storeText('0.9.0', section, facts090).text.startsWith(`New in 0.9.0:\nImportant: ${reason}\n- `), 'store text does not lead with the reason');
    return `marker was at ${section.indexOf('SEISCONV_CRITICAL')} in the section, now at 0`;
  });

  check('(c) store items are bold leads or first sentences, at most 1500 characters, cut after a whole item', () => {
    const leadItem = (i) => `- **Change ${i} makes \`tool${i}\` read [the spec](https://example.com/${i}) and keeps a lead long enough to matter.** A tail that\n  wraps onto a second line and must not appear.`;
    const leadPlain = (i) => `- Change ${i} makes tool${i} read the spec and keeps a lead long enough to matter.`;
    const sentenceItem = (i) => `- Item ${i} has no bold lead, so its first sentence stands in. A second sentence that\n  wraps and must not appear.`;
    const sentencePlain = (i) => `- Item ${i} has no bold lead, so its first sentence stands in.`;
    const quote = '> **Re-export any file an earlier version wrote.** Defects in\n> the `writers` are fixed below.';
    const items = Array.from({ length: 40 }, (_, i) => (i % 2 ? sentenceItem(i) : leadItem(i)));
    const section = `\n### Added\n\nA loose paragraph that is not a bullet.\n\n${quote}\n\n${items.join('\n')}`;
    const { text, kept, total } = storeText('0.9.0', section, facts090);
    assert(chars(text) <= STORE_MAX, `store text is ${chars(text)} characters`);
    assert(kept < total, 'fixture did not force a cut');
    const expected = ['New in 0.9.0:', '- Re-export any file an earlier version wrote.',
      ...Array.from({ length: kept - 1 }, (_, i) => (i % 2 ? sentencePlain(i) : leadPlain(i))), STORE_CLOSING];
    assert(text === expected.join('\n'), 'kept items are not the plain leads in order');
    assert(!/\*\*|`|\]\(|^>|must not appear/m.test(text), 'markdown or tail text survived');
    const next = `- ${storeItems(section)[kept]}`;
    assert(chars(`${text}\n${next}`) > STORE_MAX, 'cut one item too early');
    const real = storeText('0.8.4', changelogSection(changelog, '0.8.4').body, facts084);
    assert(chars(real.text) <= STORE_MAX && real.text.endsWith(`\n${STORE_CLOSING}`), 'v0.8.4 store text breaks the limit');
    assert(real.text.includes('\n- Re-export any file an earlier version wrote.\n'), 'v0.8.4 store text lost the re-export warning');
    return `${chars(text)} chars, ${kept} of ${total} items kept; v0.8.4 store text ${chars(real.text)} chars, ${real.kept} of ${real.total} items`;
  });

  check('(d) a missing or empty section is an error', () => {
    let threw = false;
    try { changelogSection(changelog, '9.9.9'); } catch (e) { threw = /no "## \[9\.9\.9\]" section/.test(e.message); }
    assert(threw, 'missing section did not throw');
    threw = false;
    try { githubBody('0.9.0', '\n\n', facts090); } catch (e) { threw = /is empty/.test(e.message); }
    assert(threw, 'empty section did not throw');
    return 'both threw';
  });

  check('(e) the privacy scan reports labels only', () => {
    const labels = privacyLabels('saved under C:\\Users\\someone\\AppData\\x');
    assert(labels.length > 0 && labels.every((l) => /^(site|generic)#\d+$/.test(l)), 'expected label-only hits');
    const hits = privacyLabels(built084);
    assert(hits.length === 0, `rebuilt v0.8.4 body hits ${hits.join(', ')}`);
    return `planted path gave ${labels.join(', ')}; v0.8.4 body clean`;
  });

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${safeText(r.note)}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`self-test: ${results.length - failed}/${results.length} passed`);
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------- CLI

function main(argv) {
  const { pos, opts } = parseArgs(argv, ['facts', 'out']);
  if (opts['self-test']) return selfTest();
  const version = pos[0];
  if (!version || Boolean(opts.github) === Boolean(opts.store) || !opts.facts) {
    console.log('usage: release-notes.mjs <X> (--github | --store) --facts facts.json [--out file] | --self-test');
    return 2;
  }
  // Windows PowerShell 5.1 writes UTF-8 with a BOM, which JSON.parse rejects.
  const facts = JSON.parse(readFileSync(resolve(opts.facts), 'utf8').replace(/^\uFEFF/, ''));
  const section = changelogSection(readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8'), version);
  const text = opts.github ? githubBody(version, section.body, facts) : storeText(version, section.body, facts).text;
  const hits = privacyLabels(text);
  if (hits.length) {
    error(`release-notes: privacy scan hit ${hits.join(', ')}, nothing written`);
    return 1;
  }
  if (opts.out) {
    writeFileSync(resolve(opts.out), text);
    console.log(`release-notes: wrote ${opts.github ? 'GitHub body' : 'store text'} to ${basename(opts.out)} (${chars(text)} characters)`);
  } else {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    error(`release-notes: ${safeText(e)}`);
    process.exitCode = 1;
  }
}
