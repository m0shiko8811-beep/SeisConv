// scripts/release-lib.mjs - helpers shared by release-check, release-notes and release-prep.
// Plain Node and git only, so the same code runs on this laptop and on an ubuntu runner.
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Namespace import: scanTextIds may not be exported yet, and a named import of a missing
// export would fail at link time instead of falling back.
import * as frameSafety from '../docs/manual/frame-safety.mjs';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_SLUG = 'm0shiko8811-beep/SeisConv';
export const BOUND_DIRS = ['core', 'electron', 'renderer', 'workers', 'build', 'qa', 'scripts', 'docs'];

// electron/main.ts:539 UPDATE_NOTES_MAX. The update check only reads this much of a release
// body before core/version.ts parseCriticalReason looks for the marker.
export const UPDATE_NOTES_MAX = 4000;
export const CRITICAL_RE = /^[\s>*+-]{0,8}SEISCONV_CRITICAL\s*:\s*(.*)$/;

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// ---------------------------------------------------------------- output

// GitHub annotations end at a newline, so a multi-line message must be escaped to stay whole.
const escAnno = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
export const notice = (m) => console.log(`::notice::${escAnno(m)}`);
export const warning = (m) => console.log(`::warning::${escAnno(m)}`);
export const error = (m) => console.log(`::error::${escAnno(m)}`);

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Tiny argv parser: positionals plus `--flag` / `--key value`. */
export function parseArgs(argv, valueFlags = []) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    if (valueFlags.includes(key)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      opts[key] = argv[++i];
    } else {
      opts[key] = true;
    }
  }
  return { pos, opts };
}

// ---------------------------------------------------------------- semver

export function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v ?? '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/** -1, 0 or 1 by semver 2.0 precedence (build metadata ignored). Throws on an invalid version. */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x) throw new Error(`not a semantic version: ${JSON.stringify(a)}`);
  if (!y) throw new Error(`not a semantic version: ${JSON.stringify(b)}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  // A release outranks every pre-release of the same version.
  if (!x.pre.length || !y.pre.length) {
    if (x.pre.length === y.pre.length) return 0;
    return x.pre.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------- version facts

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const first = (text, re) => { const m = re.exec(text); return m ? m[1] : null; };
const HEADING_RE = /^## \[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?[ \t]*\r?$/m;

/** Every place the version is written down, as read from `root`. Missing values are null. */
export function readVersionFacts(root = REPO_ROOT) {
  const read = (f) => readFileSync(join(root, f), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const cit = read('CITATION.cff');
  const priv = read('PRIVACY.md');
  const heading = HEADING_RE.exec(read('CHANGELOG.md'));
  return {
    packageJson: pkg.version ?? null,
    packageLock: lock.version ?? null,
    packageLockRoot: lock.packages?.['']?.version ?? null,
    citation: first(cit, /^version:\s*"([^"]*)"\s*$/m),
    citationDate: first(cit, /^date-released:\s*"([^"]*)"\s*$/m),
    privacy: first(priv, /Describes SeisConv version (\S+?)\.\s*$/m),
    privacyEffectiveDate: first(priv, /^Effective date: (\d{4}-\d{2}-\d{2})\./m),
    changelog: heading ? { version: heading[1], date: heading[2] ?? null } : null,
  };
}

/**
 * The CHANGELOG section for `version`: the text between its `## [version]` heading and the next
 * `## [` heading, CR stripped, trailing blank lines trimmed. The leading blank line is kept on
 * purpose: the published release bodies carry it.
 */
export function changelogSection(text, version) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const head = new RegExp(`^## \\[${escRe(version)}\\](?:\\s+-\\s+(\\d{4}-\\d{2}-\\d{2}))?\\s*$`);
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  const date = head.exec(lines[at])[1] ?? null;
  let end = lines.findIndex((l, i) => i > at && /^## \[/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(at + 1, end);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return { date, body: body.join('\n') };
}

// ---------------------------------------------------------------- pure file edits (release-prep)
// Each edit rewrites line CONTENT only, so a CRLF checkout stays CRLF and an LF one stays LF.

function replaceLine(text, re, make, what) {
  let hit = false;
  const out = text.replace(re, (...m) => { hit = true; return make(...m); });
  if (!hit) throw new Error(`${what} not found`);
  return out;
}

export function editCitation(text, version, date) {
  let t = replaceLine(text, /^version:[ \t]*"[^"]*"/m, () => `version: "${version}"`, 'CITATION.cff version line');
  t = replaceLine(t, /^date-released:[ \t]*"[^"]*"/m, () => `date-released: "${date}"`, 'CITATION.cff date-released line');
  return t;
}

export function editPrivacy(text, version) {
  return replaceLine(text, /Describes SeisConv version \S+?\.(?=[ \t]*\r?$)/m,
    () => `Describes SeisConv version ${version}.`, 'PRIVACY.md "Describes SeisConv version" sentence');
}

/** Turn `## [Unreleased]` into `## [version] - date`. Refuses a missing or empty section. */
export function editChangelog(text, version, date) {
  const section = changelogSection(text, 'Unreleased');
  if (!section.body.trim()) throw new Error('CHANGELOG.md [Unreleased] section is empty');
  return replaceLine(text, /^## \[Unreleased\][ \t]*(?=\r?$)/m, () => `## [${version}] - ${date}`, 'CHANGELOG.md [Unreleased] heading');
}

// ---------------------------------------------------------------- test summaries

/** `passed: N   failed: N   skipped: N` from npm run test:core output (last one wins). */
export function parseCoreSummary(output) {
  const all = [...stripAnsi(output).matchAll(/passed:\s*(\d+)\s+failed:\s*(\d+)\s+skipped:\s*(\d+)/g)];
  if (!all.length) return null;
  const m = all[all.length - 1];
  return { passed: +m[1], failed: +m[2], skipped: +m[3] };
}

/** RESULT and global error counts from npm run qa output. */
export function parseQaSummary(output) {
  const t = stripAnsi(output);
  const r = [...t.matchAll(/RESULT:\s*(\d+)\/(\d+) tab-steps passed, (\d+) failed\./g)].pop();
  const pe = [...t.matchAll(/global pageerrors:\s*(\d+)/g)].pop();
  const ce = [...t.matchAll(/global console\.errors:\s*(\d+)/g)].pop();
  if (!r || !pe || !ce) return null;
  return { passed: +r[1], total: +r[2], failed: +r[3], pageErrors: +pe[1], consoleErrors: +ce[1] };
}

// ---------------------------------------------------------------- git

export function gitRun(args, { cwd = REPO_ROOT, env = process.env } = {}) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git could not be started: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function git(args, opts) {
  const r = gitRun(args, opts);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/**
 * sha256 of package-lock.json with its two root version fields removed. Hashed as re-serialised
 * JSON, not raw bytes: the committed blob is LF and a Windows checkout is CRLF, and both must
 * give the same answer.
 */
export function dependenciesHash(lockText) {
  const lock = JSON.parse(lockText);
  delete lock.version;
  if (lock.packages && lock.packages['']) delete lock.packages[''].version;
  return createHash('sha256').update(JSON.stringify(lock)).digest('hex');
}

/**
 * Tree ids of the directories a release attestation is bound to, plus the dependency hash.
 * mode 'head': what is committed. mode 'worktree': what a commit of the working tree would
 * contain, built in a throwaway index so the real index is never touched.
 */
export function boundHashes(root = REPO_ROOT, { mode = 'head' } = {}) {
  const out = {};
  if (mode === 'head') {
    for (const d of BOUND_DIRS) {
      const r = gitRun(['rev-parse', '--verify', '--quiet', `HEAD:${d}`], { cwd: root });
      if (r.status !== 0) throw new Error(`bound directory "${d}" does not exist at HEAD`);
      out[d] = r.stdout.trim();
    }
    out.dependencies = dependenciesHash(git(['cat-file', 'blob', 'HEAD:package-lock.json'], { cwd: root }));
    return out;
  }
  if (mode !== 'worktree') throw new Error(`boundHashes: unknown mode ${JSON.stringify(mode)}`);
  for (const d of BOUND_DIRS) if (!existsSync(join(root, d))) throw new Error(`bound directory "${d}" does not exist`);
  const tmp = mkdtempSync(join(tmpdir(), 'seisconv-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
  try {
    git(['read-tree', 'HEAD'], { cwd: root, env });
    git(['add', '-A', '--', ...BOUND_DIRS], { cwd: root, env });
    for (const d of BOUND_DIRS) out[d] = git(['write-tree', `--prefix=${d}/`], { cwd: root, env });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  out.dependencies = dependenciesHash(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  return out;
}

// ---------------------------------------------------------------- privacy scan

// Same contract as frame-safety's scanTextIds: labels only, never the matched text.
function scanTextIdsLocal(txt, list, siteCount) {
  const ids = [];
  list.forEach((re, i) => {
    if (re.test(String(txt))) ids.push(i < siteCount ? `site#${i}` : `generic#${i - siteCount}`);
  });
  return ids;
}

let scanNoted = false;
/** Labels of every forbidden pattern found in `text`. Never returns or prints a matched term. */
export function privacyLabels(text) {
  const terms = frameSafety.siteTerms();
  const list = frameSafety.buildForbidden(terms, { quiet: true });
  if (!terms.length && !scanNoted) {
    scanNoted = true;
    console.log('privacy scan: no site terms on this machine, generic path patterns only');
  }
  const scan = typeof frameSafety.scanTextIds === 'function' ? frameSafety.scanTextIds : scanTextIdsLocal;
  return scan(String(text), list, terms.length);
}

/**
 * Printable form of a message or an error. An fs error is reduced to its code and file name,
 * since its message carries the full path; anything left is withheld on a privacy scan hit.
 */
export function safeText(x) {
  if (x && typeof x === 'object' && x.code && x.path) return safeText(`${x.code} ${String(x.path).split(/[\\/]/).pop()}`);
  const text = x instanceof Error ? x.message : String(x);
  const hits = privacyLabels(text);
  return hits.length ? `(text withheld, privacy scan hit ${hits.join(', ')})` : text;
}
