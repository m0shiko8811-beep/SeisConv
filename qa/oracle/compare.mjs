// SEG-Y oracle cross-check: SeisConv's parser vs segyio, on real field data.
//
// Runs both sides over the same file and diffs the JSON they produce. The
// SeisConv side is qa/oracle/ours.mjs (the real core/formats/segy.ts, under
// tsx). The reference side is qa/oracle/oracle.py running inside the container
// built from qa/oracle/Dockerfile, with the network off, the root filesystem
// read-only, and the fixture bind-mounted read-only at a fixed path.
//
//   npm run qa:oracle
//
// Exit codes:  0 all fixtures agree (or every fixture was skipped)
//              1 at least one disagreement
//              2 the oracle image is not built yet
//              3 the harness itself failed
//
// PRIVACY: fixtures are real field seismic. No path, file name, survey name or
// directory name is ever printed - fixtures are called "fixture A", "fixture B",
// "fixture C", and every line of captured child stderr is redacted before it
// reaches the console.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveList, resolveValue } from '../local-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const IMAGE = 'seisconv-segy-oracle:1';
const OURS = join(HERE, 'ours.mjs');
const TSX_CLI = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');

// Scalar fields compared key-for-key. The sample-matrix hash is the one that
// matters; the rest are the cheap header cross-checks that make a hash
// mismatch interpretable.
const COMPARED = [
  'trace_count',
  'samples_per_trace',
  'sample_interval_us',
  'data_format_code',
  'revision_major',
  'byte_order',
  'sample_matrix_values',
  'normalised_nan',
  'normalised_neg_zero',
  'sample_matrix_sha256',
];

// ---------------------------------------------------------------- redaction
// Fixtures are real field seismic. A survey, site or job name must never reach a
// console. Three layers, because each one alone has a hole:
//   1. every SEGMENT of every fixture path, not just the file name - Docker
//      Desktop rewrites a mount error into /run/desktop/mnt/host/d/<...>, so a
//      name two directories up would otherwise walk straight out;
//   2. the site vocabulary in `forbiddenTerms` (qa/local-paths.json), the same
//      per-machine denylist `npm run manual:shots` uses;
//   3. a catch-all for anything still shaped like an absolute host path.
const SECRETS = [];
const PATTERNS = [];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function addSecret(s) {
  if (s && s.length > 2 && !SECRETS.includes(s)) SECRETS.push(s);
}

function guard(p) {
  if (!p) return p;
  const norm = p.replace(/\\/g, '/');
  addSecret(p);
  addSecret(norm);
  addSecret(basename(p));
  addSecret(basename(dirname(p)));
  for (const seg of norm.split('/')) {
    addSecret(seg);
    addSecret(seg.replace(/\.[^.]*$/, ''));
  }
  return p;
}

/** Compile the per-machine site denylist. Entries are regex SOURCES (see
 *  qa/README.md); one that will not compile falls back to a literal match
 *  rather than being silently dropped. */
function loadForbidden() {
  let terms = [];
  try {
    terms = resolveList('forbiddenTerms', 'SEISCONV_FORBIDDEN_TERMS', []);
  } catch {
    terms = [];
  }
  for (const t of terms) {
    if (!t) continue;
    try {
      PATTERNS.push(new RegExp(t, 'gi'));
    } catch {
      PATTERNS.push(new RegExp(esc(t), 'gi'));
    }
  }
}

/** Strip every known real path fragment and site term out of text before it is
 *  printed. Applied to all captured child-process output and error strings. */
function redact(text) {
  let out = String(text === undefined || text === null ? '' : text);
  for (const s of SECRETS.slice().sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(esc(s), 'gi'), '<redacted>');
  }
  for (const re of PATTERNS) out = out.replace(re, '<redacted>');
  // Belt and braces, in the three shapes an absolute host path can arrive in.
  out = out.replace(/[A-Za-z]:[\\/][^\s"']*/g, '<redacted-path>');
  out = out.replace(/\/run\/desktop\/mnt\/host\/[^\s"']*/g, '<redacted-path>');
  out = out.replace(/\/[A-Za-z]\/[^\s"']*/g, '<redacted-path>');
  return out;
}

// ---------------------------------------------------------------- fixtures
/** Walk `root` for the first SEG-Y whose big-endian format code is `want`.
 *  Sorted, so the pick is deterministic; nothing about the corpus is hardcoded. */
function findByFormat(root, want, maxDepth = 3) {
  const hit = (dir, depth) => {
    if (depth > maxDepth) return null;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const r = hit(p, depth + 1);
        if (r) return r;
      } else if (/\.(sgy|segy)$/i.test(e.name)) {
        // Read only the 2 bytes of the format code, not the whole file - the
        // corpus can be thousands of multi-megabyte files.
        let fd = null;
        try {
          if (statSync(p).size < 3600) continue;
          const two = Buffer.alloc(2);
          fd = openSync(p, 'r');
          if (readSync(fd, two, 0, 2, 3224) === 2 && two.readUInt16BE(0) === want) return p;
        } catch {
          /* unreadable file - just skip it */
        } finally {
          if (fd !== null) {
            try {
              closeSync(fd);
            } catch {
              /* already gone */
            }
          }
        }
      }
    }
    return null;
  };
  return hit(root, 0);
}

function resolveFixtures() {
  const out = [];
  out.push({ label: 'fixture A', why: 'big-endian SEG-Y (qa key "segy")', path: resolveValue('segy', 'SEISCONV_QA_SEGY', '') });
  out.push({ label: 'fixture B', why: 'little-endian SEG-Y (qa key "le")', path: resolveValue('le', 'SEISCONV_QA_LE', '') });

  // Fixture C exists because the headline question is about IBM float, and the
  // two standing QA fixtures are both IEEE float32 (format 5). Explicit key or
  // env var first; otherwise the first format-1 file in the crossformat corpus.
  let ibm = resolveValue('oracleIbm', 'SEISCONV_ORACLE_IBM', '');
  if (!ibm) {
    const corpus = resolveValue('xfmtDir', 'SEISCONV_XFMT_DIR', '');
    if (corpus && existsSync(corpus)) ibm = findByFormat(corpus, 1) || '';
  }
  out.push({ label: 'fixture C', why: 'IBM-float SEG-Y, data format code 1', path: ibm });

  for (const f of out) {
    f.present = Boolean(f.path) && existsSync(f.path);
    if (f.present) guard(f.path);
  }
  return out;
}

// ---------------------------------------------------------------- runners
function runOurs(path) {
  const r = spawnSync(process.execPath, [TSX_CLI, OURS, path], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, error: r.error };
}

/** The isolation flags, in one place, so the README and the run cannot drift.
 *  --network none        no network at all inside the container
 *  --read-only           container root filesystem is read-only; it writes nothing
 *  --mount ...,readonly  exactly one bind, the fixture, read-only, at a fixed
 *                        target so the container never learns the real file name
 *  --cap-drop ALL, --security-opt no-new-privileges  nothing here needs privilege
 */
function dockerArgs(path) {
  return [
    'run', '--rm',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--mount', 'type=bind,source=' + path + ',target=/data/input.sgy,readonly',
    IMAGE,
  ];
}

function runOracle(path) {
  const r = spawnSync('docker', dockerArgs(path), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, error: r.error };
}

function imagePresent() {
  const r = spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' });
  return r.status === 0;
}

// ---------------------------------------------------------------- printing
/** Deep clone with object keys sorted, so the two blobs line up field for field.
 *  (A replacer array on JSON.stringify would filter NESTED keys too - it drops
 *  every sub-object key that is not also a top-level key.) */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/** JSON with the sample previews folded onto one line each, so a blob stays
 *  readable in a terminal. */
function show(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  const folded = {};
  for (const k of ['trace0', 'trace_mid']) {
    if (clone[k]) {
      folded[k] = clone[k];
      delete clone[k];
    }
  }
  const lines = [JSON.stringify(sortKeys(clone), null, 2)];
  for (const k of Object.keys(folded)) {
    const v = folded[k];
    lines.push(k + '.first8  ' + v.first8.map((s) => s.hex + ' ' + s.dec).join('  '));
    lines.push(k + '.last8   ' + v.last8.map((s) => s.hex + ' ' + s.dec).join('  '));
  }
  return lines.join('\n');
}

function firstPreviewDiff(a, b) {
  for (const k of ['trace0', 'trace_mid']) {
    const pa = a && a[k];
    const pb = b && b[k];
    if (!pa || !pb) continue;
    for (const half of ['first8', 'last8']) {
      const xs = pa[half] || [];
      const ys = pb[half] || [];
      for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
        const x = xs[i];
        const y = ys[i];
        if (!x || !y || x.hex !== y.hex) {
          const ax = x ? x.hex + ' (' + x.dec + ')' : 'absent';
          const ay = y ? y.hex + ' (' + y.dec + ')' : 'absent';
          return k + '.' + half + '[' + i + ']  ours=' + ax + '  segyio=' + ay;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- main
function main() {
  console.log('SEG-Y oracle cross-check - SeisConv core/formats/segy.ts vs segyio');
  console.log('image: ' + IMAGE);

  loadForbidden();
  const fixtures = resolveFixtures();
  const live = fixtures.filter((f) => f.present);

  for (const f of fixtures) {
    if (!f.present) {
      console.log('  ⊘ ' + f.label + '  (skipped: no ' + f.why +
        ' configured - set the env var or the qa/local-paths.json key; see qa/README.md)');
    }
  }
  if (live.length === 0) {
    console.log('\nNo fixtures configured. SKIP (exit 0), matching the file-backed core tests.');
    return 0;
  }

  if (!imagePresent()) {
    console.log('\nThe oracle image is not built. Build it once - this is the ONLY step that uses the network:');
    console.log('  docker build -t ' + IMAGE + ' qa/oracle');
    return 2;
  }

  let failures = 0;
  let matched = 0;
  let noCrossCheck = 0;
  for (const f of live) {
    console.log('\n' + '='.repeat(78) + '\n' + f.label + '  -  ' + f.why + '\n' + '='.repeat(78));

    const o = runOurs(f.path);
    let ours = null;
    try {
      ours = JSON.parse(o.stdout);
    } catch {
      console.log('  SeisConv side produced no parsable JSON.');
      if (o.stderr) console.log(redact(o.stderr).split('\n').slice(-12).join('\n'));
      failures++;
      continue;
    }

    const g = runOracle(f.path);
    let ref = null;
    try {
      ref = JSON.parse(g.stdout);
    } catch {
      ref = null;
    }

    console.log('\n--- SeisConv (core/formats/segy.ts) ---');
    console.log(show(ours));
    console.log('\n--- segyio (containerised reference) ---');
    if (ref) {
      console.log(show(ref));
    } else {
      console.log('  no parsable JSON from the container.');
      if (g.stderr) console.log(redact(g.stderr).split('\n').slice(-12).join('\n'));
    }

    console.log('\n--- diff ---');
    if (!ref || ref.ok !== true) {
      const why = ref && ref.error ? redact(ref.error) : 'container returned nothing usable';
      console.log('  segyio could NOT read this file: ' + why);
      if (ref && ref.attempts) {
        for (const a of ref.attempts) {
          console.log('    endian=' + a.endian + ' opened=' + a.opened + ' consistent=' + a.consistent +
            (a.error ? ' error=' + redact(a.error) : '') +
            (a.opened ? ' predicted_size=' + a.predicted_size + ' file_size=' + a.file_size : ''));
        }
      }
      console.log('  VERDICT: NO CROSS-CHECK for this fixture (the reference has no answer to compare against).');
      noCrossCheck++;
      continue;
    }
    if (ours.ok !== true) {
      console.log('  SeisConv side could not produce a matrix: ' + ours.error);
      failures++;
      continue;
    }

    let bad = 0;
    for (const k of COMPARED) {
      const a = ours[k];
      const b = ref[k];
      const same = a === b;
      if (!same) bad++;
      const va = k === 'sample_matrix_sha256' ? String(a) : JSON.stringify(a);
      const vb = k === 'sample_matrix_sha256' ? String(b) : JSON.stringify(b);
      console.log('  ' + (same ? 'OK  ' : 'DIFF') + '  ' + k.padEnd(22) + ' ours=' + va + '  segyio=' + vb);
    }
    const pd = firstPreviewDiff(ours, ref);
    if (pd) console.log('  DIFF  first differing printed sample: ' + pd);

    if (bad === 0) {
      console.log('  VERDICT: MATCH - the decoded sample matrix is byte-identical (SHA-256 ' + ours.sample_matrix_sha256 + ').');
      matched++;
    } else {
      console.log('  VERDICT: MISMATCH - ' + bad + ' compared field(s) disagree.');
      failures++;
    }
  }

  // Count every state. "No disagreement" alone would read as a clean sweep and
  // quietly hide a fixture the reference could not read at all.
  console.log('\n' + '='.repeat(78));
  console.log('RESULT: ' + matched + ' matched, ' + noCrossCheck + ' not cross-checkable, ' +
    failures + ' disagreed  (of ' + live.length + ' fixture(s) run, ' +
    (fixtures.length - live.length) + ' skipped)');
  return failures === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(redact(e && e.stack ? e.stack : String(e)));
  process.exitCode = 3;
}
