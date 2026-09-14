// scripts/release-check.mjs - the gates the release workflow runs, one subcommand each.
//
//   decide                                            what this workflow run should do (env driven)
//   agreement                                         every version fact agrees with package.json
//   attestation [--warn-only]                         .github/release-attestation.json matches HEAD
//   appx-identity <file.appx> --version X             the Microsoft Store package identity
//   update-check-presence <dist/main.js> --expect present|absent
//   sidecars <dir>                                    manual shot sidecars vs a fresh shots run
//
// Internal flags for testing: --root <dir> reads package.json and the version files from another
// tree, --file <path> reads another attestation file.
import { readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
// No npm package is imported at the top: the workflow's check job runs decide, agreement and
// attestation on a bare checkout without npm ci. jszip is loaded inside appx-identity only.
import {
  REPO_ROOT, readVersionFacts, changelogSection, compareSemver, parseSemver, boundHashes,
  parseArgs, privacyLabels, safeText, git, notice, warning, error,
} from './release-lib.mjs';

const STORE_IDENTITY = {
  Publisher: 'CN=FD8F9C0B-9789-4BB2-9695-152D89D690BC',
  ProcessorArchitecture: 'x64',
};
// First 16 hex characters of the SHA-256 of the Store identity name, so the name itself is not written in this file.
const STORE_NAME_SHA256_PREFIX = '9f341ff62ad0aa4a';

const pkgVersion = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

// ---------------------------------------------------------------- decide

/** gh api GET. null on 404; any other failure throws, so an auth or network error is never read as "absent". */
function ghApi(path) {
  const r = spawnSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw new Error(`gh could not be started: ${r.error.message}`);
  if (r.status === 0) return JSON.parse(r.stdout);
  if (/HTTP 404/.test(r.stderr)) return null;
  throw new Error(`gh api ${path} failed: ${r.stderr.trim()}`);
}

/** Pure decision table. mode null means the run must fail. */
export function decideMode(s) {
  const onMain = s.ref === 'refs/heads/main';
  const releaseChecks = () => {
    if (s.tagExists) return { mode: 'skip', level: 'notice', message: `v${s.version} already released` };
    if (s.latest && compareSemver(s.version, s.latest) <= 0) {
      return { mode: 'skip', level: 'warning', message: `${s.version} is not newer than the latest release v${s.latest}, nothing to release` };
    }
    return { mode: 'release', level: 'notice', message: `releasing v${s.version}` };
  };
  if (s.event === 'push') {
    if (!onMain) return { mode: 'skip', level: 'notice', message: `push to ${s.ref} is not main, nothing to release` };
    return releaseChecks();
  }
  if (s.event === 'workflow_dispatch') {
    if (s.storeOnly) {
      if (!s.tagExists) return { mode: null, level: 'error', message: `store_only needs tag v${s.version} to exist` };
      if (!onMain) return { mode: null, level: 'error', message: `store_only must run on main, not ${s.ref}` };
      const mode = s.dryRun ? 'store_only_dry' : 'store_only';
      return { mode, level: 'notice', message: `${mode} for v${s.version}` };
    }
    if (s.dryRun) return { mode: 'dry_run', level: 'notice', message: `dry run for ${s.version}` };
    if (!onMain) return { mode: null, level: 'error', message: `a real release must run on main, not ${s.ref}` };
    return releaseChecks();
  }
  return { mode: null, level: 'error', message: `unsupported event ${JSON.stringify(s.event)}` };
}

/** Workflow inputs arrive as the strings "true" / "false". Unset or empty gives `dflt`. */
export const inputFlag = (v, dflt) => (v === undefined || v === '' ? dflt : String(v).trim().toLowerCase() === 'true');

function cmdDecide(root) {
  const env = process.env;
  const event = env.GITHUB_EVENT_NAME;
  const ref = env.GITHUB_REF;
  const repo = env.GITHUB_REPOSITORY;
  if (!event || !ref || !repo) {
    error('decide: GITHUB_EVENT_NAME, GITHUB_REF and GITHUB_REPOSITORY must be set');
    return 1;
  }
  const version = pkgVersion(root);
  if (!parseSemver(version)) {
    error(`decide: package.json version ${JSON.stringify(version)} is not a semantic version`);
    return 1;
  }
  const sha = env.GITHUB_SHA || git(['rev-parse', 'HEAD'], { cwd: root });
  const tagRef = `refs/tags/v${version}`;
  const tag = ghApi(`repos/${repo}/git/ref/tags/v${version}`);
  // A prefix match can come back as an array, so demand the exact ref.
  const tagExists = tag !== null && [].concat(tag).some((o) => o && o.ref === tagRef);
  const latestTag = ghApi(`repos/${repo}/releases/latest`)?.tag_name ?? null;
  const latest = latestTag ? String(latestTag).replace(/^v/, '') : null;
  if (latest && !parseSemver(latest)) {
    error(`decide: the latest release tag ${latestTag} is not a semantic version`);
    return 1;
  }
  // An unset dry_run counts as a dry run, so a dispatch never publishes by omission.
  const dryRun = inputFlag(env.INPUT_DRY_RUN, true);
  const storeOnly = inputFlag(env.INPUT_STORE_ONLY, false);
  const d = decideMode({ event, ref, dryRun, storeOnly, tagExists, latest, version });
  ({ notice, warning, error })[d.level](d.message);
  const inputs = event === 'workflow_dispatch' ? ` dry_run=${dryRun} store_only=${storeOnly}` : '';
  console.log(`decide: event=${event} ref=${ref}${inputs} version=${version} sha=${sha.slice(0, 12)} `
    + `tag=${tagExists ? 'present' : 'absent'} latest=${latestTag ?? 'none'} mode=${d.mode ?? 'error'}`);
  if (!d.mode) return 1;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `version=${version}\nsha=${sha}\nmode=${d.mode}\n`);
  return 0;
}

// ---------------------------------------------------------------- agreement

function cmdAgreement(root) {
  const f = readVersionFacts(root);
  const x = f.packageJson;
  const bad = [];
  if (!parseSemver(x)) bad.push(`package.json version ${JSON.stringify(x)} is not a semantic version`);
  const same = [
    ['package-lock.json "version"', f.packageLock],
    ['package-lock.json packages[""].version', f.packageLockRoot],
    ['CITATION.cff version', f.citation],
    ['PRIVACY.md "Describes SeisConv version"', f.privacy],
    ['CHANGELOG.md first "## [" heading', f.changelog?.version ?? null],
  ];
  for (const [label, v] of same) {
    if (v !== x) bad.push(`${label} is ${v === null ? 'missing' : JSON.stringify(v)}, package.json says ${JSON.stringify(x)}`);
  }
  if (!f.changelog?.date) {
    bad.push('CHANGELOG.md first heading carries no " - YYYY-MM-DD" date');
  } else if (f.citationDate !== f.changelog.date) {
    bad.push(`CITATION.cff date-released is ${JSON.stringify(f.citationDate)}, CHANGELOG.md [${f.changelog.version}] is dated ${f.changelog.date}`);
  }
  if (f.changelog?.version === x) {
    const { body } = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), x);
    if (!body.trim()) bad.push(`CHANGELOG.md [${x}] section is empty`);
  }
  if (bad.length) {
    for (const b of bad) error(`agreement: ${b}`);
    console.log(`agreement: ${bad.length} mismatch${bad.length === 1 ? '' : 'es'}`);
    return 1;
  }
  console.log(`agreement: ok, every version fact says ${x}, released ${f.changelog.date}`);
  return 0;
}

// ---------------------------------------------------------------- attestation

const short = (h) => (typeof h === 'string' ? h.slice(0, 12) : JSON.stringify(h));

function cmdAttestation(root, file, warnOnly) {
  const path = file ? resolve(file) : join(root, '.github', 'release-attestation.json');
  const x = pkgVersion(root);
  const bad = [];
  let a = null;
  try {
    a = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    bad.push(`cannot read ${basename(path)} (${e.code || 'invalid JSON'})`);
  }
  if (a) {
    if (a.schema !== 1) bad.push(`schema is ${JSON.stringify(a.schema)}, expected 1`);
    if (a.version !== x) bad.push(`version is ${JSON.stringify(a.version)}, package.json says ${x}`);
    if (a.typecheck !== 'clean') bad.push(`typecheck is ${JSON.stringify(a.typecheck)}, expected "clean"`);
    if (a.coreTests?.failed !== 0) bad.push(`coreTests.failed is ${JSON.stringify(a.coreTests?.failed)}`);
    const q = a.qa || {};
    for (const k of ['failed', 'pageErrors', 'consoleErrors']) if (q[k] !== 0) bad.push(`qa.${k} is ${JSON.stringify(q[k])}`);
    if (!Number.isInteger(q.total) || q.passed !== q.total) bad.push(`qa.passed ${JSON.stringify(q.passed)} is not qa.total ${JSON.stringify(q.total)}`);
    const want = boundHashes(root, { mode: 'head' });
    const got = a.bound || {};
    for (const k of Object.keys(want)) if (got[k] !== want[k]) bad.push(`bound.${k} is ${short(got[k])}, HEAD has ${short(want[k])}`);
    for (const k of Object.keys(got)) if (!(k in want)) bad.push(`bound.${k} is not a bound key`);
  }
  if (bad.length) {
    const say = warnOnly ? warning : error;
    for (const b of bad) say(`attestation: ${b}`);
    console.log(`attestation: ${bad.length} problem${bad.length === 1 ? '' : 's'}${warnOnly ? ' (warn only)' : ''}`);
    return warnOnly ? 0 : 1;
  }
  console.log(`attestation: ok, ${x} attested at ${a.preparedAt ?? 'an unknown time'} and every bound hash matches HEAD`);
  return 0;
}

// ---------------------------------------------------------------- appx-identity

async function cmdAppxIdentity(file, version) {
  const v = parseSemver(version);
  if (!file || !v || v.pre.length) {
    error('appx-identity: usage appx-identity <file.appx> --version X.Y.Z');
    return 1;
  }
  // Loaded here, not at the top, so every other subcommand runs without npm ci.
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(readFileSync(resolve(file)));
  const entry = zip.file('AppxManifest.xml');
  if (!entry) {
    error(`appx-identity: ${basename(file)} has no AppxManifest.xml`);
    return 1;
  }
  const tag = /<Identity\b([^>]*?)\/?>/.exec(await entry.async('string'));
  if (!tag) {
    error('appx-identity: AppxManifest.xml has no <Identity> element');
    return 1;
  }
  // electron-builder writes Publisher single-quoted and the rest double-quoted.
  const attrs = {};
  for (const m of tag[1].matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1]] = m[2] ?? m[3];
  const want = { ...STORE_IDENTITY, Version: `${v.major}.${v.minor}.${v.patch}.0` };
  let bad = 0;
  const nameHash = createHash('sha256').update(attrs.Name ?? '', 'utf8').digest('hex').slice(0, 16);
  if (nameHash === STORE_NAME_SHA256_PREFIX) {
    console.log('  Name: matches the expected hash');
  } else {
    console.log('  Name: does not match the expected hash');
    error('appx-identity: Name does not match the expected Store identity name');
    bad++;
  }
  for (const [k, expected] of Object.entries(want)) {
    const got = attrs[k] ?? '(missing)';
    console.log(`  ${k}: ${got}`);
    if (got !== expected) { error(`appx-identity: ${k} is ${got}, expected ${expected}`); bad++; }
  }
  console.log(bad ? `appx-identity: ${bad} mismatch${bad === 1 ? '' : 'es'}` : `appx-identity: ok for ${version}`);
  return bad ? 1 : 0;
}

// ---------------------------------------------------------------- update-check-presence

function cmdUpdateCheckPresence(file, expect) {
  if (!file || (expect !== 'present' && expect !== 'absent')) {
    error('update-check-presence: usage update-check-presence <dist/main.js> --expect present|absent');
    return 1;
  }
  const present = readFileSync(resolve(file), 'utf8').includes('releases/latest');
  const state = present ? 'present' : 'absent';
  if (state !== expect) {
    error(`update-check-presence: releases/latest is ${state} in ${basename(file)}, expected ${expect}`);
    return 1;
  }
  console.log(`update-check-presence: releases/latest is ${state} in ${basename(file)}, as expected`);
  return 0;
}

// ---------------------------------------------------------------- sidecars

function cmdSidecars(root, dir) {
  const isSidecar = (f) => f.endsWith('.json') && f !== 'index.json';
  if (!dir || !existsSync(resolve(dir))) {
    warning('sidecars: the fresh shots directory does not exist, nothing compared');
    return 0;
  }
  // The committed side is read from HEAD, not from disk: the workflow regenerates the shots in
  // place, so docs/manual/img on disk may already be the fresh set.
  const committed = git(['ls-tree', '--name-only', 'HEAD', 'docs/manual/img/'], { cwd: root })
    .split('\n').map((p) => p.trim().split('/').pop()).filter(isSidecar).sort();
  const fresh = new Set(readdirSync(resolve(dir)).filter(isSidecar));
  let diffs = 0;
  const parse = (read) => { try { return JSON.parse(read()); } catch { return null; } };
  const differ = (f, field, a, b) => {
    if (a === b) return;
    diffs++;
    const withheld = privacyLabels(`${a ?? ''}\n${b ?? ''}`).length > 0;
    warning(withheld
      ? `sidecars: ${f} ${field} differs (values withheld by the privacy scan)`
      : `sidecars: ${f} ${field} differs: committed ${JSON.stringify(a ?? null)}, fresh ${JSON.stringify(b ?? null)}`);
  };
  for (const f of committed) {
    if (!fresh.has(f)) { diffs++; warning(`sidecars: ${f} is missing from the fresh shots`); continue; }
    const a = parse(() => git(['cat-file', 'blob', `HEAD:docs/manual/img/${f}`], { cwd: root }));
    const b = parse(() => readFileSync(join(resolve(dir), f), 'utf8'));
    if (!a || !b) { diffs++; warning(`sidecars: ${f} is not readable JSON on one side`); continue; }
    differ(f, 'name', a.name, b.name);
    differ(f, 'caption', a.caption, b.caption);
    const la = (a.callouts || []).map((c) => c.label);
    const lb = (b.callouts || []).map((c) => c.label);
    for (let i = 0; i < Math.max(la.length, lb.length); i++) differ(f, `callout ${i + 1} label`, la[i], lb[i]);
  }
  for (const f of fresh) if (!committed.includes(f)) { diffs++; warning(`sidecars: ${f} is new, not committed in docs/manual/img`); }
  console.log(`sidecars: compared ${committed.length} committed sidecars, ${diffs} difference${diffs === 1 ? '' : 's'}`);
  return 0;
}

// ---------------------------------------------------------------- CLI

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest, ['version', 'expect', 'root', 'file']);
  const root = opts.root ? resolve(opts.root) : REPO_ROOT;
  switch (cmd) {
    case 'decide': return cmdDecide(root);
    case 'agreement': return cmdAgreement(root);
    case 'attestation': return cmdAttestation(root, opts.file, Boolean(opts['warn-only']));
    case 'appx-identity': return cmdAppxIdentity(pos[0], opts.version);
    case 'update-check-presence': return cmdUpdateCheckPresence(pos[0], opts.expect);
    case 'sidecars':
      try { return cmdSidecars(root, pos[0]); } catch (e) { warning(`sidecars: ${safeText(e)}`); return 0; }
    default:
      console.log('usage: release-check.mjs decide | agreement | attestation [--warn-only] | '
        + 'appx-identity <file.appx> --version X | update-check-presence <main.js> --expect present|absent | sidecars <dir>');
      return 2;
  }
}

// Only as a script: importing decideMode for a test must not run a subcommand.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    error(`release-check: ${safeText(e)}`);
    process.exitCode = 1;
  }
}
