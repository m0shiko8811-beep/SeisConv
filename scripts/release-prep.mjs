// scripts/release-prep.mjs - prepares a release on this machine. CI cannot run the Electron QA
// harness (its field data is not in the repository), so the full local gate runs here and its
// counts are written to .github/release-attestation.json, bound to the tree they were measured
// on. It never commits and never pushes: that stays a human step.
//
//   node scripts/release-prep.mjs <X> [--date YYYY-MM-DD] [--skip-shots]
//   node scripts/release-prep.mjs [X] --attest-only        attest the current version, no edits
//   node scripts/release-prep.mjs <X> --plan               print the ordered steps, run nothing
//   node scripts/release-prep.mjs --self-test [--scratch <dir>]   the pure file edits, on copies
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  REPO_ROOT, parseArgs, parseSemver, compareSemver, isIsoDate, today, readVersionFacts,
  editCitation, editPrivacy, editChangelog, parseCoreSummary, parseQaSummary, boundHashes,
  privacyLabels, safeText, git, warning, error,
} from './release-lib.mjs';

const isWin = process.platform === 'win32';
const ATTESTATION = '.github/release-attestation.json';
const VERSION_FILES = ['package.json', 'package-lock.json', 'CITATION.cff', 'PRIVACY.md', 'CHANGELOG.md'];

function childEnv() {
  const env = { ...process.env };
  // Set in some shells, and it turns every Electron launch into a silent plain Node run.
  delete env.ELECTRON_RUN_AS_NODE;
  env.SEISCONV_QA_USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'seisconv-qa-'));
  return env;
}

/** Run npm with inherited output. `capture` tees stdout/stderr so summary lines can be parsed. */
function npm(args, { capture = false, cwd = REPO_ROOT } = {}) {
  const env = childEnv();
  // npm is a .cmd on Windows, which Node only starts through a shell. Every argument here is
  // ours (fixed script names, a validated version), so one joined command line is safe.
  const [cmd, cmdArgs] = isWin ? [['npm', ...args].join(' '), []] : ['npm', args];
  console.log(`> npm ${args.join(' ')}`);
  return new Promise((done, fail) => {
    const child = spawn(cmd, cmdArgs, { cwd, env, shell: isWin, stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    if (capture) {
      child.stdout.on('data', (c) => { process.stdout.write(c); out += c; });
      child.stderr.on('data', (c) => { process.stderr.write(c); out += c; });
    }
    child.on('error', fail);
    child.on('close', (code) => {
      try { rmSync(env.SEISCONV_QA_USER_DATA_DIR, { recursive: true, force: true }); } catch { /* Electron may still hold a file */ }
      if (code === 0) done(out);
      else fail(new Error(`npm ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function seisconvRunning() {
  if (isWin) {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq SeisConv.exe', '/NH'], { encoding: 'utf8' });
    return !r.error && /SeisConv\.exe/i.test(r.stdout || '');
  }
  const r = spawnSync('pgrep', ['-x', 'SeisConv'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

const readRepo = (f) => readFileSync(join(REPO_ROOT, f), 'utf8');

/** The ordered checks and steps. --plan prints exactly this list, so the plan cannot drift from the run. */
function buildSteps(o) {
  const list = [];
  const check = (title, run) => list.push({ kind: 'check', title, run });
  const step = (title, run) => list.push({ kind: 'step', title, run });
  const state = { coreTests: null, qa: null };

  if (o.attestOnly) {
    // The attestation for a rollout commit is made on a worktree branch before that commit
    // reaches main, so attest-only needs the tree to contain public main, not to be main.
    check('git fetch origin, then origin/main is an ancestor of HEAD', () => {
      const f = spawnSync('git', ['fetch', 'origin'], { cwd: REPO_ROOT, stdio: 'inherit' });
      if (f.error || f.status !== 0) throw new Error('git fetch origin failed');
      const r = spawnSync('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
      if (r.error || (r.status !== 0 && r.status !== 1)) throw new Error(`git merge-base failed: ${(r.stderr || '').trim()}`);
      if (r.status === 1) throw new Error('origin/main is not an ancestor of HEAD, so this tree does not contain public main');
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
      warning(branch === 'HEAD' ? 'attesting on a detached HEAD, not on main' : `attesting on branch ${branch}${branch === 'main' ? '' : ', not main'}`);
    });
  } else {
    check('branch is main', () => {
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
      if (branch !== 'main') throw new Error(`on branch ${branch}, release-prep only runs on main`);
    });
    check('git fetch origin, then HEAD equals origin/main', () => {
      const r = spawnSync('git', ['fetch', 'origin'], { cwd: REPO_ROOT, stdio: 'inherit' });
      if (r.error || r.status !== 0) throw new Error('git fetch origin failed');
      const head = git(['rev-parse', 'HEAD']);
      const main = git(['rev-parse', 'origin/main']);
      if (head !== main) throw new Error(`HEAD ${head.slice(0, 12)} is not origin/main ${main.slice(0, 12)}`);
    });
  }
  if (o.attestOnly) {
    check(`every version fact says ${o.version}`, () => {
      const f = readVersionFacts(REPO_ROOT);
      const off = Object.entries({ packageLock: f.packageLock, packageLockRoot: f.packageLockRoot, citation: f.citation, privacy: f.privacy, changelog: f.changelog?.version })
        .filter(([, v]) => v !== o.version).map(([k]) => k);
      if (off.length) throw new Error(`version facts disagree with ${o.version}: ${off.join(', ')} (run release-check agreement)`);
    });
  } else {
    check(`${o.version} is newer than package.json ${o.current}`, () => {
      if (compareSemver(o.version, o.current) <= 0) throw new Error(`${o.version} is not newer than ${o.current}`);
    });
    check(`no tag v${o.version} on origin`, () => {
      if (git(['ls-remote', '--tags', 'origin', `refs/tags/v${o.version}`])) throw new Error(`tag v${o.version} already exists on origin`);
    });
    check('CHANGELOG.md has a non-empty [Unreleased] section', () => { editChangelog(readRepo('CHANGELOG.md'), o.version, o.date); });
  }
  check('qa/local-paths.json exists', () => {
    // Without it the QA harness cannot reach the field data and the privacy scan loses its site terms.
    if (!existsSync(join(REPO_ROOT, 'qa', 'local-paths.json'))) throw new Error('qa/local-paths.json is missing, see qa/local-paths.example.json');
  });
  check('warn if SeisConv.exe is running', () => {
    if (seisconvRunning()) warning('SeisConv.exe is running; close it if the QA harness or the shots misbehave');
  });

  if (!o.attestOnly) {
    step(`npm version ${o.version} --no-git-tag-version`, () => npm(['version', o.version, '--no-git-tag-version']));
    step(`CITATION.cff, PRIVACY.md and CHANGELOG.md say ${o.version}, released ${o.date}`, () => {
      applyEdits(REPO_ROOT, o.version, o.date);
    });
  }
  step('npm run typecheck', () => npm(['run', 'typecheck']));
  step('npm run build', () => npm(['run', 'build']));
  step('npm run test:core, counts captured', async () => {
    const c = parseCoreSummary(await npm(['run', 'test:core'], { capture: true }));
    if (!c) throw new Error('no "passed: N failed: N skipped: N" line in the test:core output');
    if (c.failed) throw new Error(`test:core: ${c.failed} failed`);
    state.coreTests = c;
  });
  step('npm run qa, counts captured', async () => {
    const q = parseQaSummary(await npm(['run', 'qa'], { capture: true }));
    if (!q) throw new Error('no RESULT / global pageerrors / global console.errors lines in the qa output');
    if (q.failed || q.passed !== q.total || q.pageErrors || q.consoleErrors) {
      throw new Error(`qa: ${q.passed}/${q.total} passed, ${q.failed} failed, ${q.pageErrors} page errors, ${q.consoleErrors} console errors`);
    }
    state.qa = q;
  });
  if (!o.attestOnly && !o.skipShots) {
    step('npm run manual:shots', () => npm(['run', 'manual:shots']));
    step('npm run gen:manual', () => npm(['run', 'gen:manual']));
  }
  step(`write ${ATTESTATION}, bound to the working tree`, () => {
    const att = {
      schema: 1,
      version: o.version,
      preparedAt: new Date().toISOString(),
      typecheck: 'clean',
      coreTests: state.coreTests,
      qa: state.qa,
      bound: boundHashes(REPO_ROOT, { mode: 'worktree' }),
    };
    const text = `${JSON.stringify(att, null, 2)}\n`;
    const hits = privacyLabels(text);
    if (hits.length) throw new Error(`the attestation hits the privacy scan (${hits.join(', ')}), not written`);
    writeFileSync(join(REPO_ROOT, ATTESTATION), text);
    console.log(`wrote ${ATTESTATION}; commit every change under the bound directories with it, or CI will not match`);
  });
  step('warn if README.md states another test count', () => {
    const m = /(\d+) passed, (\d+) failed, (\d+) skipped/.exec(readRepo('README.md'));
    const c = state.coreTests;
    if (m && (+m[1] !== c.passed || +m[2] !== c.failed || +m[3] !== c.skipped)) {
      warning(`README.md states ${m[1]} passed, ${m[2]} failed, ${m[3]} skipped; this build has ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped`);
    }
  });
  step('show git diff --stat and a suggested commit message', () => {
    spawnSync('git', ['diff', '--stat'], { cwd: REPO_ROOT, stdio: 'inherit' });
    console.log(`\nsuggested commit message:\n  ${o.attestOnly ? `chore(release): attest ${o.version}` : `release(${o.version}): <what this release brings>`}`);
    console.log('nothing was committed or pushed');
  });
  return list;
}

/** The pure version edits for the three hand-written files, in place under `root`. */
function applyEdits(root, version, date) {
  const edit = (f, fn) => writeFileSync(join(root, f), fn(readFileSync(join(root, f), 'utf8')));
  // Validate every edit before writing any, so a refusal leaves no half-edited tree.
  const next = {
    'CHANGELOG.md': editChangelog(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version, date),
    'CITATION.cff': editCitation(readFileSync(join(root, 'CITATION.cff'), 'utf8'), version, date),
    'PRIVACY.md': editPrivacy(readFileSync(join(root, 'PRIVACY.md'), 'utf8'), version),
  };
  for (const [f, text] of Object.entries(next)) edit(f, () => text);
}

// ---------------------------------------------------------------- self-test (pure edits on copies)

async function selfTest(scratch) {
  const dir = scratch ? resolve(scratch) : mkdtempSync(join(tmpdir(), 'seisconv-prep-test-'));
  mkdirSync(dir, { recursive: true });
  for (const f of VERSION_FILES) copyFileSync(join(REPO_ROOT, f), join(dir, f));
  const read = (f) => readFileSync(join(dir, f), 'utf8');
  const results = [];
  const check = async (name, fn) => {
    try { results.push({ ok: true, name, note: await fn() }); } catch (e) { results.push({ ok: false, name, note: e.message }); }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const throws = (fn, re) => { try { fn(); } catch (e) { return re.test(e.message); } return false; };
  const endings = (t) => ({ crlf: t.split('\r\n').length - 1, lf: t.split('\n').length - 1 });
  const eol = read('CHANGELOG.md').includes('\r\n') ? '\r\n' : '\n';

  await check('a CHANGELOG without [Unreleased] is refused', () => {
    assert(throws(() => editChangelog(read('CHANGELOG.md'), '0.8.5', '2026-09-15'), /no "## \[Unreleased\]" section/), 'did not refuse');
    return 'refused';
  });
  await check('an empty [Unreleased] is refused', () => {
    const withEmpty = read('CHANGELOG.md').replace('## [0.8.4]', `## [Unreleased]${eol}${eol}## [0.8.4]`);
    assert(throws(() => editChangelog(withEmpty, '0.8.5', '2026-09-15'), /is empty/), 'did not refuse');
    return 'refused';
  });

  const before = {};
  await check('edits on copies: every fact says 0.8.5, dates agree, endings kept, only the intended lines changed', async () => {
    const filled = read('CHANGELOG.md').replace('## [0.8.4]', `## [Unreleased]${eol}${eol}### Added${eol}${eol}- A self-test entry.${eol}${eol}## [0.8.4]`);
    writeFileSync(join(dir, 'CHANGELOG.md'), filled);
    for (const f of VERSION_FILES) before[f] = read(f);
    await npm(['version', '0.8.5', '--no-git-tag-version', '--ignore-scripts'], { cwd: dir });
    applyEdits(dir, '0.8.5', '2026-09-15');
    const f = readVersionFacts(dir);
    for (const [k, v] of Object.entries({ packageJson: f.packageJson, packageLock: f.packageLock, packageLockRoot: f.packageLockRoot, citation: f.citation, privacy: f.privacy, changelog: f.changelog?.version })) {
      assert(v === '0.8.5', `${k} is ${v}`);
    }
    assert(f.citationDate === '2026-09-15' && f.changelog.date === '2026-09-15', 'dates do not agree');
    assert(f.privacyEffectiveDate === readVersionFacts(REPO_ROOT).privacyEffectiveDate, 'PRIVACY.md effective date changed');
    const changed = {};
    for (const file of VERSION_FILES) {
      const a = before[file];
      const b = read(file);
      assert(JSON.stringify(endings(a)) === JSON.stringify(endings(b)), `${file} line endings changed`);
      const la = a.split('\n');
      const lb = b.split('\n');
      changed[file] = la.filter((l, i) => l !== lb[i]).length;
    }
    const want = { 'package.json': 1, 'package-lock.json': 2, 'CITATION.cff': 2, 'PRIVACY.md': 1, 'CHANGELOG.md': 1 };
    for (const [file, n] of Object.entries(want)) assert(changed[file] === n, `${file}: ${changed[file]} lines changed, expected ${n}`);
    assert(/^## \[0\.8\.5\] - 2026-09-15\r?\n\r?\n### Added\r?\n\r?\n- A self-test entry\./m.test(read('CHANGELOG.md')), 'CHANGELOG heading edit is wrong');
    return Object.entries(changed).map(([k, n]) => `${k} ${n}`).join(', ');
  });
  await check('release-check agreement passes on the edited copies', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'release-check.mjs'), 'agreement', '--root', dir], { encoding: 'utf8' });
    assert(r.status === 0, `agreement exited ${r.status}: ${safeText(r.stdout.trim())}`);
    return r.stdout.trim();
  });

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${safeText(r.note)}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`self-test: ${results.length - failed}/${results.length} passed`);
  if (!scratch) rmSync(dir, { recursive: true, force: true });
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------- CLI

async function main(argv) {
  const { pos, opts } = parseArgs(argv, ['date', 'scratch']);
  if (opts['self-test']) return selfTest(opts.scratch);
  const current = readVersionFacts(REPO_ROOT).packageJson;
  const attestOnly = Boolean(opts['attest-only']);
  const version = attestOnly ? (pos[0] ?? current) : pos[0];
  if (!version || !parseSemver(version)) {
    console.log('usage: release-prep.mjs <X> [--date YYYY-MM-DD] [--skip-shots] | [X] --attest-only | <X> --plan | --self-test');
    return 2;
  }
  if (attestOnly && version !== current) {
    error(`release-prep: --attest-only attests the current version ${current}, not ${version}`);
    return 1;
  }
  const date = opts.date ?? today();
  if (!isIsoDate(date)) {
    error(`release-prep: --date ${JSON.stringify(date)} is not YYYY-MM-DD`);
    return 1;
  }
  const o = { version, current, date, attestOnly, skipShots: Boolean(opts['skip-shots']) };
  const list = buildSteps(o);
  if (opts.plan) {
    console.log(`release-prep plan for ${version}${attestOnly ? ' (attest only)' : `, dated ${date}`}:`);
    list.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s.kind === 'check' ? 'check' : 'step '}  ${s.title}`));
    console.log('nothing was run (--plan)');
    return 0;
  }
  for (const [i, s] of list.entries()) {
    console.log(`\n[${i + 1}/${list.length}] ${s.title}`);
    try {
      await s.run();
    } catch (e) {
      const edited = !attestOnly && list.slice(0, i).some((x) => x.kind === 'step');
      error(`release-prep ${s.kind === 'check' ? 'refused' : 'stopped'}: ${safeText(e)}${edited ? ' (files are already edited, see git diff)' : ''}`);
      return 1;
    }
  }
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  error(`release-prep: ${safeText(e)}`);
  process.exitCode = 1;
}
