// Cross-format equivalence sweep.
//
//   npx tsx scripts/test-crossformat.ts [--limit N] [--dir <SINGLE_IMAGE_1>]
//
// The strongest correctness test available to this project: the acquisition
// system wrote THE SAME SHOTS in four formats (SEG-D rev 2, SEG-D rev 3, SEG-Y
// rev 0, SEG-Y rev 2). Those files are ground truth nobody here authored, so
// decoding all four and comparing sample-for-sample exercises the SEG-D readers,
// both SEG-Y revisions, IBM-float vs IEEE decoding, byte-order detection and the
// header maps at once - and any disagreement is a real defect in one of them.
//
// The README claims SEG-D decodes bit-identical to the vendor's own SEG-Y. This
// is the check that claim has to survive.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAny } from '../core/index';

// Local paired SEG-D/SEG-Y corpus (developer machine). Override with --dir or
// SEISCONV_XFMT_DIR; the script reports "no corpus" when the directory is absent.
const DEFAULT_DIR = process.env.SEISCONV_XFMT_DIR || 'D:/Projects/SeisconvApp/Data_Games';

const argv = process.argv.slice(2);
const arg = (name: string, dflt: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ROOT = arg('--dir', DEFAULT_DIR);
const LIMIT = parseInt(arg('--limit', '40'), 10);

// `lossy` marks a variant stored in IBM floating point. IBM float carries a
// 24-bit mantissa behind a HEXADECIMAL exponent, so a value sitting just above a
// hex-exponent boundary keeps only 21 significant bits: worst-case relative
// quantisation is 16 * 2^-24 = 2^-20 ~ 9.5e-7. Comparing such a file to an IEEE
// one at exactly zero difference would report the vendor's own encoding as our
// bug, so those pairs get that tolerance - and nothing looser.
const IBM_REL_TOL = Math.pow(2, -20);

const VARIANTS = [
  { dir: 'SEGD_Rev_2', ext: '.segd', label: 'SEG-D r2', lossy: false },
  { dir: 'SEGD_Rev_3', ext: '.segd', label: 'SEG-D r3', lossy: false },
  { dir: 'SEGY_REV_0', ext: '.sgy', label: 'SEG-Y r0', lossy: true },
  { dir: 'SEGY_Rev_2', ext: '.sgy', label: 'SEG-Y r2', lossy: false },
];

interface Decoded {
  label: string;
  lossy: boolean;
  traceCount: number;
  nSamples: number;
  sampleInt: number;
  format: string;
  traces: Float32Array[];
  errors: string[];
}

function decode(path: string, label: string, lossy: boolean): Decoded | null {
  try {
    const pf = parseAny(new Uint8Array(readFileSync(path)), path);
    return {
      label,
      lossy,
      traceCount: pf.traceCount,
      nSamples: pf.traces[0]?.samples.length ?? 0,
      sampleInt: (pf.traces[0] as { sampleInt?: number } | undefined)?.sampleInt ?? 0,
      format: pf.format,
      traces: pf.traces.map((t) => t.samples),
      errors: pf.errors ?? [],
    };
  } catch (e) {
    console.log(`  THREW on ${label}: ${(e as Error).message}`);
    return null;
  }
}

/** Compare two decodes trace-for-trace, returning the worst absolute difference. */
function compare(a: Decoded, b: Decoded): { ok: boolean; why: string; worst: number; worstRel: number; worstTrace: number; tol: number } {
  // An IBM-float file on either side makes the pair lossy.
  const tol = a.lossy || b.lossy ? IBM_REL_TOL : 0;
  if (a.traceCount !== b.traceCount) return { ok: false, why: `trace count ${a.traceCount} vs ${b.traceCount}`, worst: NaN, worstRel: NaN, worstTrace: -1, tol };
  let worst = 0;
  let worstRel = 0;
  let worstTrace = -1;
  for (let t = 0; t < a.traces.length; t++) {
    const x = a.traces[t], y = b.traces[t];
    if (x.length !== y.length) return { ok: false, why: `trace ${t} length ${x.length} vs ${y.length}`, worst: NaN, worstRel: NaN, worstTrace: t, tol };
    for (let i = 0; i < x.length; i++) {
      const d = Math.abs(x[i] - y[i]);
      if (d > worst) { worst = d; worstTrace = t; }
      // Relative to the larger magnitude, so a near-zero sample cannot inflate
      // the ratio into a false alarm.
      const mag = Math.max(Math.abs(x[i]), Math.abs(y[i]));
      if (mag > 1e-9) { const r = d / mag; if (r > worstRel) worstRel = r; }
    }
  }
  return { ok: true, why: '', worst, worstRel, worstTrace, tol };
}

const shots = existsSync(join(ROOT, VARIANTS[0].dir))
  ? readdirSync(join(ROOT, VARIANTS[0].dir)).filter((f) => f.toLowerCase().endsWith('.segd')).map((f) => f.replace(/\.[^.]+$/, '')).sort()
  : [];
if (!shots.length) {
  console.error(`No shots found under ${ROOT}. Pass --dir <SINGLE_IMAGE_1 folder>.`);
  process.exit(2);
}
const picked = shots.slice(0, Math.max(1, LIMIT));
console.log(`Cross-format equivalence: ${picked.length} of ${shots.length} shots\nroot: ${ROOT}\n`);

let checked = 0, mismatches = 0, missing = 0, threw = 0;
const worstByPair: Record<string, { worst: number; shot: string; tol: number; abs: number }> = {};
const failures: string[] = [];

for (const shot of picked) {
  const decs: Decoded[] = [];
  for (const v of VARIANTS) {
    const p = join(ROOT, v.dir, shot + v.ext);
    if (!existsSync(p)) { missing++; continue; }
    const d = decode(p, v.label, v.lossy);
    if (!d) { threw++; continue; }
    decs.push(d);
  }
  if (decs.length < 2) continue;

  // Every variant is compared against the FIRST one present, so a single bad
  // reader shows up against all three of the others rather than hiding.
  const base = decs[0];
  for (let i = 1; i < decs.length; i++) {
    const other = decs[i];
    const key = `${base.label} vs ${other.label}`;
    const r = compare(base, other);
    checked++;
    if (!r.ok) {
      mismatches++;
      const msg = `${shot} ${key}: ${r.why}`;
      failures.push(msg);
      if (failures.length <= 12) console.log(`  MISMATCH ${msg}`);
      continue;
    }
    const prev = worstByPair[key];
    if (!prev || r.worstRel > prev.worst) worstByPair[key] = { worst: r.worstRel, shot, tol: r.tol, abs: r.worst };
    if (r.worstRel > r.tol) {
      mismatches++;
      const msg = `${shot} ${key}: worst relative ${r.worstRel.toExponential(3)} exceeds tolerance ${r.tol.toExponential(3)} (abs ${r.worst}, trace ${r.worstTrace})`;
      failures.push(msg);
      if (failures.length <= 12) console.log(`  DIFF ${msg}`);
    }
  }
}

console.log('\n-- worst RELATIVE sample difference per pair --');
for (const [k, v] of Object.entries(worstByPair)) {
  const verdict = v.worst === 0
    ? 'BIT-IDENTICAL'
    : `${v.worst.toExponential(3)} rel (abs ${v.abs.toExponential(3)}) vs tol ${v.tol.toExponential(3)} -> ${v.worst <= v.tol ? 'within IBM-float quantisation' : 'OVER TOLERANCE'}  [shot ${v.shot}]`;
  console.log(`  ${k.padEnd(24)} ${verdict}`);
}
console.log(`\ncomparisons: ${checked}   mismatches: ${mismatches}   missing files: ${missing}   parser throws: ${threw}`);
if (failures.length > 12) console.log(`(${failures.length - 12} further failures not shown)`);
process.exitCode = mismatches || threw ? 1 : 0;
