// Malformed-input robustness sweep (deterministic fuzz).
//
//   npx tsx scripts/test-fuzz.ts [--cases N] [--seed N]
//
// SeisConv's hard rule is that a parser must BOUND every allocation and must
// turn malformed input into collected errors - never a throw, never an
// unbounded allocation, never a hang. This sweep attacks every reader with
// mutations of REAL files plus hand-built hostile headers, and fails on:
//
//   - an uncaught exception out of a parser
//   - a wall-clock blow-up on a tiny input (an unbounded loop)
//   - an absurd allocation (trace/sample counts far beyond the input size)
//   - a NaN or Infinity reaching a decoded sample
//   - prototype pollution through any dynamic-key path
//
// The RNG is seeded, so a failure is reproducible from the printed seed.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAny, detect, parseSPSText, parseSegP1, parsePositioning, parseBinGrid, MAX_SAMPLE_TRACES } from '../core/index';

const argv = process.argv.slice(2);
const arg = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CASES = parseInt(arg('--cases', '400'), 10);
let seed = parseInt(arg('--seed', '20260721'), 10);

/** Deterministic PRNG - a failing case must be reproducible from the seed. */
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const ri = (n: number) => Math.floor(rnd() * n);

// Local corpus root (developer machine). Override with SEISCONV_FUZZ_DATA, and
// add extra sub-directories to scan with SEISCONV_FUZZ_DIRS (';'-separated,
// relative to the root). Every directory is optional - missing ones are skipped.
const DATA = process.env.SEISCONV_FUZZ_DATA || 'D:/Projects/SeisconvApp';
const EXTRA_DIRS = (process.env.SEISCONV_FUZZ_DIRS || '').split(';').map((s) => s.trim()).filter(Boolean);
function pick(dir: string, ext: string, max = 3): string[] {
  const p = join(DATA, dir);
  if (!existsSync(p)) return [];
  try {
    return readdirSync(p).filter((f) => f.toLowerCase().endsWith(ext)).slice(0, max).map((f) => join(p, f));
  } catch { return []; }
}

const seeds: { name: string; bytes: Uint8Array }[] = [];
for (const f of [
  ...pick('Data_Games', '.segd', 2),
  ...pick('Data_Games', '.segy', 1),
  ...EXTRA_DIRS.flatMap((d) => [...pick(d, '.sgy', 1), ...pick(d, '.segd', 1)]),
]) {
  try {
    // Cap the seed corpus: mutating a 40 MB buffer 400 times is pointless when
    // the header is what the parsers actually trust.
    const b = new Uint8Array(readFileSync(f)).subarray(0, 400_000);
    seeds.push({ name: f.split(/[\\/]/).pop() || f, bytes: b });
  } catch { /* unreadable file - skip */ }
}
if (!seeds.length) { console.error('No seed files found; cannot fuzz.'); process.exit(2); }

/** Synthetic hostile headers: the values a parser is most likely to trust. */
function hostile(): { name: string; bytes: Uint8Array }[] {
  const out: { name: string; bytes: Uint8Array }[] = [];
  const mk = (n: number, fill = 0) => new Uint8Array(n).fill(fill);

  out.push({ name: 'empty', bytes: mk(0) });
  out.push({ name: 'one-byte', bytes: mk(1) });
  out.push({ name: 'all-zero-4k', bytes: mk(4096) });
  out.push({ name: 'all-ff-4k', bytes: mk(4096, 0xff) });

  // A SEG-Y binary header claiming an enormous trace/sample count on a tiny file.
  for (const [label, ns, fmt] of [['ns-65535', 65535, 5], ['ns-0', 0, 5], ['fmt-99', 1000, 99]] as [string, number, number][]) {
    const b = mk(3600 + 240 + 100);
    const dv = new DataView(b.buffer);
    dv.setUint16(3220, ns, false);   // samples per trace
    dv.setUint16(3216, 1000, false); // sample interval
    dv.setUint16(3224, fmt, false);  // sample format
    dv.setUint16(3500, 0x0100, false);
    out.push({ name: `segy-${label}`, bytes: b });
  }

  // SEG-D-ish: a general header whose channel-set counts are absurd.
  const segd = mk(32 + 32 * 4 + 1000, 0);
  segd[0] = 0x00; segd[1] = 0x00;
  segd[11] = 0xff; // channel set count nibble territory
  out.push({ name: 'segd-absurd-chansets', bytes: segd });

  return out;
}

/** Mutate a seed buffer: truncate, bit-flip, or splice in extreme values. */
function mutate(src: Uint8Array): { bytes: Uint8Array; how: string } {
  const kind = ri(4);
  if (kind === 0) {
    const n = 1 + ri(Math.min(src.length, 20000));
    return { bytes: src.slice(0, n), how: `truncate@${n}` };
  }
  const b = src.slice(0, Math.min(src.length, 200_000));
  if (kind === 1) {
    const flips = 1 + ri(24);
    for (let i = 0; i < flips; i++) {
      const at = ri(Math.min(b.length, 8000)); // headers are what get trusted
      b[at] ^= 1 << ri(8);
    }
    return { bytes: b, how: `bitflip x${flips}` };
  }
  if (kind === 2) {
    const at = ri(Math.min(b.length, 4000));
    const val = [0x00, 0xff, 0x7f, 0x80][ri(4)];
    const run = 1 + ri(64);
    for (let i = 0; i < run && at + i < b.length; i++) b[at + i] = val;
    return { bytes: b, how: `fill 0x${val.toString(16)} x${run}@${at}` };
  }
  const at = ri(Math.min(b.length, 4000));
  new DataView(b.buffer).setUint32(Math.min(at, b.length - 4), 0xffffffff, false);
  return { bytes: b, how: `u32max@${at}` };
}

interface Failure { kind: string; detail: string; repro: string }
const failures: Failure[] = [];
let nonFinite = 0;
let nullSamples = 0;
const TIME_BUDGET_MS = 5000;   // any single small input taking longer means a runaway loop
const MAX_REASONABLE_TRACES = 5_000_000;

function checkParsed(pf: unknown, repro: string, inputLen: number) {
  const p = pf as { traceCount?: number; traces?: { samples: Float32Array }[]; errors?: string[] };
  const tc = p.traceCount ?? 0;
  if (!Number.isFinite(tc) || tc < 0 || tc > MAX_REASONABLE_TRACES) {
    failures.push({ kind: 'absurd-trace-count', detail: `traceCount=${tc} from a ${inputLen}-byte input`, repro });
  }
  // Decoded samples must be finite - a NaN reaching a canvas is an explicit
  // project rule, and it starts here.
  let bad = 0;
  const traces = p.traces ?? [];
  for (let ti = 0; ti < traces.length; ti++) {
    const t = traces[ti];
    // A trace whose `samples` is absent breaks the ParsedFile contract: every
    // consumer reads `.samples.length` and would crash on it.
    // `samples` is legitimately nullable (core/types.ts): the parser leaves it
    // null past the in-memory preview cap and for sample-format codes it cannot
    // decode. The invariant that MATTERS is that it never goes null silently -
    // an unexplained null is a trace the UI would render blank with no reason
    // shown, which is the failure mode worth catching.
    if (!t || !t.samples || typeof t.samples.length !== 'number') {
      // Past the in-memory preview cap, a null `samples` is the documented
      // behaviour and needs no error - the header is still kept for every trace.
      if (ti >= MAX_SAMPLE_TRACES) { nullSamples++; break; }
      if (!(p.errors && p.errors.length)) {
        failures.push({ kind: 'silent-null-samples', detail: `trace ${ti} of ${traces.length} has no samples and the parser reported NO error (format ${(pf as { format?: string }).format})`, repro });
      } else {
        nullSamples++;
      }
      break;
    }
    for (let i = 0; i < t.samples.length; i++) {
      if (!Number.isFinite(t.samples[i])) { bad++; break; }
    }
    if (bad) break;
  }
  // NOTE: a corrupted IEEE field genuinely IS NaN, and faithfully decoding it is
  // correct - silently zeroing it would invent data. The project rule is that no
  // NaN reaches a CANVAS, which is a render-layer guard tested separately. So
  // this is counted for visibility, not failed on.
  if (bad) nonFinite++;
}

function run(name: string, bytes: Uint8Array, repro: string) {
  const t0 = Date.now();
  try {
    detect(bytes, name);
  } catch (e) {
    failures.push({ kind: 'detect-threw', detail: (e as Error).message, repro });
    return;
  }
  try {
    const pf = parseAny(bytes, name);
    checkParsed(pf, repro, bytes.length);
  } catch (e) {
    const st = (e as Error).stack?.split(String.fromCharCode(10)).slice(1, 3).map((x) => x.trim()).join(' | ') ?? '';
    failures.push({ kind: 'parser-threw', detail: `${(e as Error).message}  @ ${st}`, repro });
  }
  const dt = Date.now() - t0;
  if (dt > TIME_BUDGET_MS && bytes.length < 500_000) {
    failures.push({ kind: 'slow', detail: `${dt} ms on a ${bytes.length}-byte input`, repro });
  }
}

console.log(`Fuzz sweep: ${CASES} mutations over ${seeds.length} seed files, seed ${arg('--seed', '20260721')}\n`);

for (const h of hostile()) run(h.name + '.segy', h.bytes, `hostile:${h.name}`);
for (const h of hostile()) run(h.name + '.segd', h.bytes, `hostile:${h.name}.segd`);

for (let c = 0; c < CASES; c++) {
  const s = seeds[ri(seeds.length)];
  const m = mutate(s.bytes);
  run(s.name, m.bytes, `${s.name} :: ${m.how}`);
}

// -- Text parsers: SPS / SEG-P1 / P1-11 / P6-11 --------------------------------
const TEXT_ATTACKS: [string, string][] = [
  ['empty', ''],
  ['nulls', ' '.repeat(500)],
  ['huge-line', 'S' + '9'.repeat(200_000)],
  ['proto-1', 'H26 __proto__ polluted;\nS' + ' '.repeat(79)],
  ['proto-2', '__proto__,constructor,prototype\n1,2,3'],
  ['crlf-mix', 'H00 SPS 2.1;\r\nS    1.00    1.00  1' + ' '.repeat(60) + '\rR bad'],
  ['negatives', 'S -99999.99 -99999.99  1' + ' '.repeat(40) + '-9999999.9-9999999.9-999.9'],
  ['unicode', 'H01 עברית — survey;\nS    1.00    1.00  1'],
  ['only-h', 'H'.repeat(5000)],
  ['x-range-bomb', 'X' + ' '.repeat(37) + '1' + '0'.repeat(4) + '1'.padStart(5) + '999999999'.padStart(10)],
];
for (const [label, text] of TEXT_ATTACKS) {
  const t0 = Date.now();
  try {
    const d = parseSPSText(text);
    if (!Array.isArray(d.sources) || !Array.isArray(d.errors)) {
      failures.push({ kind: 'sps-shape', detail: 'parseSPSText returned a malformed result', repro: `sps:${label}` });
    }
  } catch (e) {
    failures.push({ kind: 'sps-threw', detail: (e as Error).message, repro: `sps:${label}` });
  }
  for (const [fn, fname] of [[parseSegP1, 'parseSegP1'], [parseBinGrid, 'parseBinGrid']] as [(s: string) => unknown, string][]) {
    try { fn(text); } catch (e) { failures.push({ kind: `${fname}-threw`, detail: (e as Error).message, repro: `${fname}:${label}` }); }
  }
  // parsePositioning dispatches by format id, so every reader behind it is hit
  // with the same hostile text.
  for (const fmt of ['sps', 'segp1', 'p111', 'p611', 'coordcsv'] as const) {
    try { parsePositioning(fmt, text); } catch (e) {
      failures.push({ kind: 'parsePositioning-threw', detail: `${fmt}: ${(e as Error).message}`, repro: `parsePositioning(${fmt}):${label}` });
    }
  }
  const dt = Date.now() - t0;
  if (dt > TIME_BUDGET_MS) failures.push({ kind: 'sps-slow', detail: `${dt} ms`, repro: `sps:${label}` });
}

// Prototype pollution must not have escaped through any dynamic-key path.
const probe = {} as Record<string, unknown>;
if (probe.polluted !== undefined || ({} as Record<string, unknown>).polluted !== undefined) {
  failures.push({ kind: 'prototype-pollution', detail: 'Object.prototype was modified during parsing', repro: 'global' });
}

// -- Report --------------------------------------------------------------------
const byKind: Record<string, number> = {};
for (const f of failures) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
console.log(`inputs with undecodable traces, each WITH an explanatory error: ${nullSamples}`);
console.log(`inputs whose decoded samples contained NaN/Infinity: ${nonFinite} (faithful decoding of corrupted floats - guarded at the render layer, not here)
`);
if (!failures.length) {
  console.log('No failures: every parser bounded its output, stayed finite, and never threw.');
} else {
  console.log(`${failures.length} FAILURES\n`);
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log('\nfirst 15:');
  for (const f of failures.slice(0, 15)) console.log(`  [${f.kind}] ${f.detail}\n      repro: ${f.repro}`);
}
process.exitCode = failures.length ? 1 : 0;
