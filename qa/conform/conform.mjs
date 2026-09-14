// Output conformance: does what SeisConv WRITES conform to the SEG standard it
// claims to be?
//
// qa/oracle proves core/formats/segy.ts READS real field SEG-Y the way segyio
// does. Nothing proved anything about the writing side: `npm run
// test:crossformat` compares SeisConv's outputs against each other, which is
// self consistency, not conformance. This harness closes that gap for SEG-Y
// and for SEG-D.
//
//   npm run qa:conform
//
// Three layers, per fixture, per revision SeisConv writes:
//   a. STRUCTURAL   the declared layout closes exactly on the real file size,
//                   the same arithmetic qa/oracle/oracle.py uses.
//   b. RULE TABLE   every cited rule in qa/conform/rules.segy.json and
//                   qa/conform/rules.segd.json, each one extracted from a SEG
//                   PDF and carrying its document, section and page. A rule
//                   that cannot cite does not exist.
//   c. INDEPENDENT  the WRITTEN file is decoded by segyio inside the existing
//      READ         qa/oracle container and its sample matrix hash is compared
//                   against the source's, under the hash contract already fixed
//                   in qa/oracle/README.md.
//
// LAYER c NOW EXISTS FOR ALL FOUR FORMATS, in three containers:
//   SEG-Y       segyio          qa/oracle            seisconv-segy-oracle:1
//   SEG-D       sedaman         qa/oracle/segd       seisconv-segd-oracle:1
//   SEG-2, SU   ObsPy           qa/oracle/obspy      seisconv-obspy-oracle:1
//
// SEG-D used to print "NO READER EXISTS" here, on the stated grounds that no
// independent SEG-D implementation was available. THAT WAS WRONG. sedaman
// (LGPL-3.0, C++20, github.com/andalevor/sedaman) reads SEG-D Rev 1, 2 and 3,
// which is both of the revisions writeSEGD emits, and several other independent
// readers exist besides it. The line is now the same NOT RUN (no container)
// that SEG-Y prints, because a reader that exists but has not been run is a
// different statement from a reader that does not exist, and neither of them is
// agreement. Specification conformance and interoperability are different
// claims and this harness never blurs them.
//
// Exit codes (same contract as qa/oracle/compare.mjs):
//   0  everything agreed, or every fixture was skipped
//   1  at least one disagreement (a mandatory rule failed, the layout did not
//      close, or the independent read disagreed)
//   2  the oracle image is not built (or the docker daemon is unreachable) and
//      nothing else failed
//   3  the harness itself failed
//
// PRIVACY: fixtures are real field seismic. No path, file name, survey, site or
// job name is ever printed. Fixtures are "fixture A", "fixture B", "fixture C",
// and every line of captured child output is redacted before it reaches the
// console. The redaction code is the same three-layer scheme as
// qa/oracle/compare.mjs.
//
// WRITERS ARE NOT TOUCHED. writeSEGY is imported and called; nothing here
// re-implements any part of it, and nothing here is allowed to "fix" a failure.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveList, resolveValue } from '../local-paths.mjs';
import { parseSEGY } from '../../core/formats/segy.ts';
import { writeSEGY } from '../../core/formats/segy.ts';
import { parseSEGD } from '../../core/formats/segd.ts';
import { writeSEGD } from '../../core/formats/segd.ts';
import { parseSEG2 } from '../../core/formats/seg2.ts';
import { writeSEG2 } from '../../core/formats/seg2.ts';
import { writeSU } from '../../core/formats/su.ts';
// The source-side sample matrix for the formats that have no ours.mjs
// subprocess of their own. One implementation of the hash contract, shared with
// qa/oracle/ours.mjs, so the two cannot drift.
import { matrixOf } from '../oracle/hash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const ORACLE = join(REPO, 'qa', 'oracle');
const IMAGE = 'seisconv-segy-oracle:1';
// One image per independent implementation, each built from its own directory.
// They are separate because a reference decoder that also carries three other
// decoders' dependencies is not the narrow thing qa/oracle set out to be.
const IMAGE_SEGD = 'seisconv-segd-oracle:1';
const IMAGE_OBSPY = 'seisconv-obspy-oracle:1';
const OURS = join(ORACLE, 'ours.mjs');
const TSX_CLI = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const RULES = JSON.parse(readFileSync(join(HERE, 'rules.segy.json'), 'utf8'));
const RULES_SEGD = JSON.parse(readFileSync(join(HERE, 'rules.segd.json'), 'utf8'));
const EBCDIC = JSON.parse(readFileSync(join(HERE, 'ebcdic-appendix-f.json'), 'utf8'));
const RULES_SEG2 = JSON.parse(readFileSync(join(HERE, 'rules.seg2.json'), 'utf8'));
const RULES_SU = JSON.parse(readFileSync(join(HERE, 'rules.su.json'), 'utf8'));

// Bytes per sample keyed by the SEG-2 data format code, read off the byte 12
// table itself (SEG-2, section B2, printed page 6): "01h 16-bit fixed point" is
// two bytes per sample and so on. Code 3, 20 bit floating point (SEG-D), is
// deliberately absent: it packs two samples into five bytes, so it has no whole
// number of bytes per sample and the checks that need a width report themselves
// unresolvable rather than guessing one.
const SEG2_BPS = { 1: 2, 2: 4, 4: 4, 5: 8 };

// SU has exactly one sample width and no field in which to declare another.
// See rules.su.json "uncovered": this is an assumption, it is what makes the
// stride arithmetic close, and ObsPy's SU reader makes the same one.
const SU_BPS = 4;

// Bytes per sample keyed by the SEG-Y data sample format code. Read out of the
// standard, not out of core/: SEG-Y rev 2.0 Appendix A, printed pages 28 to 29
// (PDF 32 to 33), which states the sample byte count for every format code.
const BPS = { 1: 4, 2: 4, 3: 2, 4: 4, 5: 4, 6: 8, 7: 3, 8: 1, 9: 8, 10: 4, 11: 2, 12: 8, 15: 3, 16: 1 };

// The revisions SeisConv's writeSEGY can emit and that this table covers. Rev 0
// is deliberately absent: the 1975 document is not on this machine, so there is
// nothing to cite. See rules.segy.json "uncovered".
const WRITTEN_REVISIONS = [
  { arg: 1, declared: '1', label: 'SEG-Y rev 1' },
  { arg: 2, declared: '2.0', label: 'SEG-Y rev 2.0' },
];

// The two SEG-D writers registered in core/formats/registry.ts: `segd1` calls
// writeSEGD(pd, false) and `segd3` calls writeSEGD(pd, true). The declared
// revision is what the written file puts in General Header Block #2 byte 11,
// and it is what rules.segd.json's `appliesTo` keys off.
const WRITTEN_REVISIONS_SEGD = [
  { arg: false, declared: '1', label: 'SEG-D Rev 1' },
  { arg: true, declared: '3', label: 'SEG-D Rev 3' },
];

// Bytes per sample keyed by the SEG-D General Header Block #1 format code, read
// off the format-code row itself (SEG-D Rev 3.0 section 8.1 printed page 87,
// SEG-D Rev 2.1 section 8.1 printed page 38): "8058 32 bit IEEE" is four bytes
// per sample and so on. Codes whose sample is not a whole number of bytes
// (8015, 20 bit binary) and the multiplexed codes are deliberately absent: the
// layout walk reports itself unresolvable rather than guessing a width.
const SEGD_BPS = { 8022: 1, 8024: 2, 8036: 3, 8038: 4, 8042: 1, 8044: 2, 8048: 4, 8058: 4, 8080: 8 };

// ---------------------------------------------------------------- redaction
// Copied deliberately, flag for flag and layer for layer, from
// qa/oracle/compare.mjs. Fixtures are real field seismic; a survey, site or job
// name must never reach a console.
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

function redact(text) {
  let out = String(text === undefined || text === null ? '' : text);
  for (const s of SECRETS.slice().sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(esc(s), 'gi'), '<redacted>');
  }
  for (const re of PATTERNS) out = out.replace(re, '<redacted>');
  out = out.replace(/[A-Za-z]:[\\/][^\s"']*/g, '<redacted-path>');
  out = out.replace(/\/run\/desktop\/mnt\/host\/[^\s"']*/g, '<redacted-path>');
  out = out.replace(/\/[A-Za-z]\/[^\s"']*/g, '<redacted-path>');
  return out;
}

// ---------------------------------------------------------------- byte reads
// Every multi-byte read takes an explicit `le` flag so the whole layout can be
// re-evaluated in the other byte order. That is what makes the big-endian rule
// a real check rather than an assertion about a field nobody read.
const u8 = (b, o) => b[o];
const u16 = (b, o, le) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
const i16 = (b, o, le) => {
  const v = u16(b, o, le);
  return v >= 0x8000 ? v - 0x10000 : v;
};
const u32 = (b, o, le) =>
  (le
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24))
    : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
const i32 = (b, o, le) => {
  const v = u32(b, o, le);
  return v >= 0x80000000 ? v - 0x100000000 : v;
};
const f64 = (b, o, le) => {
  const dvw = new DataView(b.buffer, b.byteOffset + o, 8);
  return dvw.getFloat64(0, le);
};

function readField(buf, off, type, le) {
  switch (type) {
    case 'uint8': return u8(buf, off);
    case 'uint16be': return u16(buf, off, le);
    case 'int16be': return i16(buf, off, le);
    case 'uint32be': return u32(buf, off, le);
    case 'int32be': return i32(buf, off, le);
    case 'float64be': return f64(buf, off, le);
    default: throw new Error('unknown field type ' + type);
  }
}

// ---------------------------------------------------------------- structure
/** Resolve the layout the file DECLARES, reading every multi-byte field in the
 *  given byte order, and report whether it closes exactly on the real size.
 *
 *  This is qa/oracle/oracle.py's arithmetic, applied to the file SeisConv wrote:
 *    3600 + ext*3200 + traces * (240 + addHdr*240 + ns * bps)  ==  file size
 *  with the rev-2 override chain honoured (binary header bytes 3269-3272 for the
 *  sample count), because the standard says a nonzero extended field overrides
 *  the legacy one. */
function resolveLayout(buf, le, declaredRev) {
  const out = { le, ok: false, why: '' };
  out.size = buf.length;
  if (buf.length < 3600) {
    out.why = 'file is shorter than the fixed 3600-byte header';
    return out;
  }
  out.ext = i16(buf, 3504, le);
  if (out.ext < -1) {
    out.why = 'binary header bytes 3505-3506 hold ' + out.ext + ', which is not a defined value';
    return out;
  }
  if (out.ext === -1) {
    out.why = 'binary header bytes 3505-3506 declare a VARIABLE number of extended textual headers; ' +
      'resolving the layout needs the ((SEG: EndText)) stanza scan, which this harness does not do';
    return out;
  }
  out.extBytes = out.ext * 3200;
  out.dataStart = 3600 + out.extBytes;
  out.format = u16(buf, 3224, le);
  out.bps = BPS[out.format] || 0;
  if (!out.bps) {
    out.why = 'data sample format code ' + out.format + ' has no defined sample width';
    return out;
  }
  const nsLegacy = u16(buf, 3220, le);
  const nsExt = declaredRev === '2.0' ? u32(buf, 3268, le) : 0;
  out.samplesPerTrace = nsExt !== 0 ? nsExt : nsLegacy;
  out.samplesFrom = nsExt !== 0 ? 'binary header 3269-3272 (extended, overrides)' : 'binary header 3221-3222';
  out.additionalTraceHeaders = declaredRev === '2.0' ? u32(buf, 3506, le) : 0;
  if (out.samplesPerTrace <= 0) {
    out.why = 'declared samples per trace is ' + out.samplesPerTrace;
    return out;
  }
  out.stride = 240 + out.additionalTraceHeaders * 240 + out.samplesPerTrace * out.bps;
  const rem = out.size - out.dataStart;
  if (rem < 0) {
    out.why = 'the declared header block (' + out.dataStart + ' bytes) is larger than the file';
    return out;
  }
  out.traceCount = Math.floor(rem / out.stride);
  out.predicted = out.dataStart + out.traceCount * out.stride;
  out.leftover = rem % out.stride;
  out.ok = out.leftover === 0 && out.traceCount > 0;
  if (!out.ok) {
    out.why = out.traceCount === 0
      ? 'the file holds no whole trace at the declared stride of ' + out.stride + ' bytes'
      : out.leftover + ' byte(s) left over after ' + out.traceCount + ' trace(s) at a stride of ' + out.stride;
  }
  return out;
}

// ---------------------------------------------------------------- textual
/** Decode the 3200-byte Textual File Header WITHOUT using core/binary.ts.
 *
 *  The EBCDIC table comes from qa/conform/ebcdic-appendix-f.json, lifted out of
 *  SEG-Y rev 2.0 Appendix F by qa/conform/extract-ebcdic.mjs. Decoding SeisConv's
 *  own EBCDIC with SeisConv's own table would let a wrong table agree with its
 *  own wrong encoding, which is exactly the blind spot this harness exists to
 *  remove.
 *
 *  ASCII is tried first, then EBCDIC. Whichever leaves all 3200 bytes printable
 *  is the encoding; if neither does, the header is not decodable and the
 *  encoding rule fails. */
function decodeTextual(buf) {
  const raw = buf.subarray(0, 3200);
  const printable = (c) => c >= 0x20 && c <= 0x7e;

  let asciiOk = true;
  for (const b of raw) if (!printable(b)) { asciiOk = false; break; }
  if (asciiOk) return { encoding: 'ASCII', text: Array.from(raw, (b) => String.fromCharCode(b)).join(''), ok: true };

  const chars = [];
  let unmapped = null;
  let nonPrintable = null;
  for (const b of raw) {
    const key = b.toString(16).toUpperCase().padStart(2, '0');
    const target = EBCDIC.table[key];
    if (target === undefined) { if (unmapped === null) unmapped = key; break; }
    const c = parseInt(target, 16);
    if (!printable(c)) { if (nonPrintable === null) nonPrintable = key + ' -> ' + target; break; }
    chars.push(String.fromCharCode(c));
  }
  if (chars.length === 3200) return { encoding: 'EBCDIC', text: chars.join(''), ok: true };
  return {
    encoding: 'undecodable',
    text: '',
    ok: false,
    why: unmapped !== null
      ? 'byte 0x' + unmapped + ' is not in the ASCII printable range and is not in the standard\'s EBCDIC table'
      : nonPrintable !== null
        ? 'EBCDIC byte 0x' + nonPrintable + ' decodes to a non-printable character'
        : 'the textual header is shorter than 3200 bytes',
  };
}

const textualLines = (text) => Array.from({ length: 40 }, (_, i) => text.slice(i * 80, i * 80 + 80));

// ---------------------------------------------------------------- rule engine
/** Every place in the file the rule's field appears.
 *
 *  A `binaryHeader` (or textual/layout) rule has one spot, at its absolute
 *  offset. A `traceHeader` rule has one spot PER TRACE, at
 *  dataStart + i*stride + offset, and the rule has to hold in all of them. */
function readSpots(rule, ctx, le) {
  if (rule.scope !== 'traceHeader') {
    return { ok: true, values: [{ i: null, v: readField(ctx.buf, rule.offset0, rule.type, le) }] };
  }
  if (!ctx.layout.ok) return { ok: false, why: 'the layout did not resolve, so the traces cannot be walked' };
  const values = [];
  for (let i = 0; i < ctx.layout.traceCount; i++) {
    values.push({ i, v: readField(ctx.buf, ctx.layout.dataStart + i * ctx.layout.stride + rule.offset0, rule.type, le) });
  }
  return { ok: true, values };
}

/** Apply one rule row to one written file. Returns a verdict object, never
 *  throws for a data reason: an unevaluable rule reports SKIP with the reason,
 *  it does not quietly pass. */
function applyRule(rule, ctx) {
  const level = (rule.levelByRevision && rule.levelByRevision[ctx.declaredRev]) || rule.level;
  const base = { id: rule.id, level, bytes: rule.bytes, field: rule.field, citation: rule.citation };
  const skip = (why) => ({ ...base, status: 'SKIP', why });
  const pass = (expected, actual) => ({ ...base, status: 'PASS', expected, actual });
  const fail = (expected, actual) => ({ ...base, status: 'FAIL', expected, actual });
  const { buf, layout, textual } = ctx;
  const le = false; // the rule table describes big-endian SEG-Y; the byte order itself is its own rule

  // Preconditions, e.g. "only when the fixed length trace flag is set".
  if (rule.when) {
    const got = readField(buf, rule.when.offset0, rule.when.type, le);
    if (got !== rule.when.equals) {
      return skip('precondition not met: bytes at offset ' + rule.when.offset0 + ' are ' + got + ', rule applies only when ' + rule.when.equals);
    }
  }

  const c = rule.check;
  switch (c.kind) {
    case 'fileAtLeast':
      return buf.length >= c.bytes ? pass('at least ' + c.bytes + ' bytes', buf.length + ' bytes') : fail('at least ' + c.bytes + ' bytes', buf.length + ' bytes');

    case 'layoutCloses': {
      if (!layout.ok) return fail('layout closes exactly on the file size', layout.why);
      return pass(
        'closes exactly on the file size',
        layout.dataStart + ' + ' + layout.traceCount + ' x ' + layout.stride + ' = ' + layout.predicted + ' = file size (ns ' +
          layout.samplesPerTrace + ' from ' + layout.samplesFrom + ', format ' + layout.format + ' at ' + layout.bps + ' bytes/sample)',
      );
    }

    case 'byteOrderBigEndian': {
      const be = layout;
      const asLe = resolveLayout(buf, true, ctx.declaredRev);
      if (!be.ok) return fail('the layout closes when read big-endian', 'it does not: ' + be.why);
      if (asLe.ok) {
        return {
          ...base,
          status: 'INCONCLUSIVE',
          expected: 'the layout closes big-endian and NOT little-endian',
          actual: 'it closes in BOTH byte orders, so the order is not decidable from the file alone',
        };
      }
      return pass('closes big-endian, does not close little-endian', 'closes big-endian (' + be.traceCount + ' traces); little-endian: ' + asLe.why);
    }

    case 'lineGrid': {
      if (!textual.ok) return skip('the textual header did not decode: ' + textual.why);
      if (textual.text.length !== c.lines * c.cols) {
        return fail(c.lines + ' lines x ' + c.cols + ' columns = ' + c.lines * c.cols + ' characters', textual.text.length + ' characters');
      }
      const bad = textual.text.split('').findIndex((ch) => ch === '\r' || ch === '\n');
      if (bad >= 0) return fail('no line terminator inside the fixed grid', 'a line terminator at character ' + bad);
      return pass(c.lines + ' lines x ' + c.cols + ' columns', c.lines + ' lines x ' + c.cols + ' columns, no embedded line terminator');
    }

    case 'printableInOneEncoding':
      return textual.ok
        ? pass('every byte printable under EBCDIC or ASCII', 'decoded as ' + textual.encoding + ', all 3200 bytes printable')
        : fail('every byte printable under EBCDIC or ASCII', textual.why);

    case 'regex': {
      if (!textual.ok) return skip('the textual header did not decode: ' + textual.why);
      const re = new RegExp(c.pattern, c.flags || '');
      const m = re.exec(textual.text);
      return m
        ? pass('a SEG-Y revision marker somewhere in the header', 'found "' + m[0].trim() + '"')
        : fail('a SEG-Y revision marker somewhere in the header (pattern /' + c.pattern + '/' + (c.flags || '') + ')', 'no match in the 3200-byte header');
    }

    case 'lineMatches': {
      if (!textual.ok) return skip('the textual header did not decode: ' + textual.why);
      const line = textualLines(textual.text)[c.line - 1] || '';
      const re = new RegExp(c.pattern, c.flags || '');
      return re.test(line)
        ? pass('record C' + c.line + ' matching /' + c.pattern + '/', '"' + line.trimEnd() + '"')
        : fail('record C' + c.line + ' matching /' + c.pattern + '/', '"' + line.trimEnd() + '"');
    }

    case 'equals':
    case 'inSet':
    case 'inRange':
    case 'nonZero': {
      // A binary-header rule reads ONE field. A trace-header rule reads the same
      // field in EVERY trace, at dataStart + i*stride + offset. Reading a trace
      // header field at its bare within-trace offset would land inside the
      // textual header and silently report whatever padding lives there.
      const spot = readSpots(rule, ctx, le);
      if (!spot.ok) return skip(spot.why);
      const describe =
        c.kind === 'equals' ? String(c.value)
          : c.kind === 'inSet' ? 'one of {' + c.values.join(', ') + '}'
            : c.kind === 'inRange' ? c.min + ' to ' + c.max
              : 'non-zero';
      const holds = (v) =>
        c.kind === 'equals' ? v === c.value
          : c.kind === 'inSet' ? c.values.includes(v)
            : c.kind === 'inRange' ? v >= c.min && v <= c.max
              : v !== 0;
      const badSpot = spot.values.find((s) => !holds(s.v));
      if (badSpot) return fail(describe, badSpot.i === null ? String(badSpot.v) : 'trace ' + badSpot.i + ' carries ' + badSpot.v);
      return pass(describe, spot.values.length === 1 && spot.values[0].i === null
        ? String(spot.values[0].v)
        : 'all ' + spot.values.length + ' trace(s) hold, e.g. ' + spot.values[0].v);
    }

    case 'zeroOrEqualsField': {
      const v = readField(buf, rule.offset0, rule.type, le);
      const t = readField(buf, c.targetOffset0, c.targetType, le);
      if (v === 0) return pass('zero (no override) or equal to bytes ' + c.targetBytes, '0, so bytes ' + c.targetBytes + ' (' + t + ') stand');
      return v === t ? pass('equal to bytes ' + c.targetBytes + ' (' + t + ')', String(v)) : fail('zero, or equal to bytes ' + c.targetBytes + ' (' + t + ')', String(v));
    }

    case 'equalsBinaryField': {
      if (!layout.ok) return skip('the layout did not resolve, so the traces cannot be walked');
      const t = readField(buf, c.targetOffset0, c.targetType, le);
      for (let i = 0; i < layout.traceCount; i++) {
        const off = layout.dataStart + i * layout.stride + rule.offset0;
        const v = readField(buf, off, rule.type, le);
        if (v !== t) return fail('every trace carries ' + t + ' (binary header bytes ' + c.targetBytes + ')', 'trace ' + i + ' carries ' + v);
      }
      return pass('every trace carries ' + t + ' (binary header bytes ' + c.targetBytes + ')', 'all ' + layout.traceCount + ' trace(s) agree');
    }

    case 'sequenceFromOne': {
      if (!layout.ok) return skip('the layout did not resolve, so the traces cannot be walked');
      for (let i = 0; i < layout.traceCount; i++) {
        const off = layout.dataStart + i * layout.stride + rule.offset0;
        const v = readField(buf, off, rule.type, le);
        if (v !== i + 1) return fail('trace i carries i+1, starting at 1', 'trace ' + i + ' carries ' + v);
      }
      return pass('trace i carries i+1, starting at 1', '1 to ' + layout.traceCount + ', in order');
    }

    case 'nonDecreasing': {
      if (!layout.ok) return skip('the layout did not resolve, so the traces cannot be walked');
      let prev = null;
      for (let i = 0; i < layout.traceCount; i++) {
        const off = layout.dataStart + i * layout.stride + rule.offset0;
        const v = readField(buf, off, rule.type, le);
        if (prev !== null && v < prev) return fail('never decreases across the file', 'trace ' + i + ' carries ' + v + ' after ' + prev);
        prev = v;
      }
      return pass('never decreases across the file', 'runs to ' + prev + ' over ' + layout.traceCount + ' trace(s)');
    }

    default:
      return skip('unimplemented check kind "' + c.kind + '"');
  }
}

// ================================================================= SEG-D
// SEG-D is big-endian throughout and mixes packed BCD with plain unsigned
// binary, so it needs its own readers. Every one of them takes the block base
// and the rule's within-block offset, because a SEG-D field is defined by its
// position inside a 32-byte or 96-byte block, not by an absolute file offset.
const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];

/** Read `width` bytes as one big-endian unsigned integer. */
function uintAt(buf, off, width) {
  let v = 0;
  for (let i = 0; i < width; i++) v = v * 256 + buf[off + i];
  return v;
}

/** The nibbles of `width` bytes, most significant first. */
function nibbles(buf, off, width) {
  const out = [];
  for (let i = 0; i < width; i++) {
    out.push(buf[off + i] >> 4, buf[off + i] & 0x0f);
  }
  return out;
}

/** Decode packed BCD. Returns { ok, value, allF, badNibble }. A nibble above 9
 *  is not a decimal digit, so the field is not BCD at all and says so rather
 *  than silently decoding to some other number. */
function bcdAt(buf, off, width, skipHighNibble = false) {
  const ns = nibbles(buf, off, width);
  if (skipHighNibble) ns.shift();
  if (ns.every((n) => n === 0x0f)) return { ok: true, allF: true, value: null };
  const bad = ns.findIndex((n) => n > 9);
  if (bad >= 0) return { ok: false, allF: false, value: null, badNibble: ns[bad], badIndex: bad };
  return { ok: true, allF: false, value: ns.reduce((a, n) => a * 10 + n, 0) };
}

const hex4 = (buf, off) => Array.from({ length: 2 }, (_, i) => buf[off + i].toString(16).toUpperCase().padStart(2, '0')).join('');

// ---------------------------------------------------------------- structure
/** Resolve the record the SEG-D file DECLARES and report whether it closes
 *  exactly on the real size.
 *
 *  Everything here is read out of the file, never out of what the writer
 *  intended: the general header block count from byte 12, the scan type and
 *  channel set counts from bytes 28 and 29, the extended and external header
 *  counts from bytes 31 and 32, the channels per channel set and the trace
 *  header extension count and samples per trace from the descriptors and the
 *  trace headers themselves. Unlike SEG-Y this walks trace by trace instead of
 *  assuming one stride, because SEG-D lets each channel set differ.
 *
 *  A configuration the walk cannot resolve (an unknown format code, a trailer
 *  of unknown size) is reported as unresolvable with the reason. It never
 *  guesses, and it never passes by default. */
function resolveSegdLayout(buf, declaredRev) {
  const rev3 = declaredRev === '3';
  const out = { rev3, ok: false, why: '', size: buf.length, csds: [], traces: [] };
  if (buf.length < 64) {
    out.why = 'the file is shorter than General Header Blocks #1 and #2 (64 bytes)';
    return out;
  }
  const GH2 = 32;
  out.gh2Offset = GH2;
  out.csdSize = rev3 ? 96 : 32;

  out.formatCode = hex4(buf, 2);
  out.bps = SEGD_BPS[Number(out.formatCode)] || 0;
  if (!out.bps) {
    out.why = 'General Header Block #1 format code ' + out.formatCode + ' has no whole-byte sample width in this harness';
    return out;
  }

  // Number of ADDITIONAL 32-byte general header blocks; F means the real count
  // lives in General Header Block #2 bytes 23-24 (Rev 3 only).
  const ghNib = buf[11] >> 4;
  if (ghNib === 0x0f) {
    if (!rev3) {
      out.why = 'General Header Block #1 byte 12 declares F additional general header blocks, an escape only Rev 3 defines';
      return out;
    }
    out.additionalGeneralHeaders = uintAt(buf, GH2 + 22, 2);
    out.additionalFrom = 'General Header Block #2 bytes 23-24';
  } else {
    out.additionalGeneralHeaders = ghNib;
    out.additionalFrom = 'General Header Block #1 byte 12 upper nibble';
  }
  out.generalHeaderBlocks = 1 + out.additionalGeneralHeaders;
  out.generalHeaderBytes = 32 * out.generalHeaderBlocks;

  // The four packed-BCD counts in General Header Block #1 bytes 28 to 32, each
  // with its own documented escape to a binary field in block #2.
  const count = (off0, label, extOff, extWidth) => {
    if (buf[off0] === 0xff) {
      if (extOff === null) return { bad: label + ' is FF but this revision defines no extended field for it' };
      return { value: uintAt(buf, extOff, extWidth), from: 'General Header Block #2' };
    }
    const d = bcdAt(buf, off0, 1);
    if (!d.ok) return { bad: label + ' is not packed BCD (byte is 0x' + buf[off0].toString(16) + ')' };
    return { value: d.value, from: 'General Header Block #1' };
  };
  const scanTypes = count(27, 'scan types per record', null, 0);
  const channelSets = count(28, 'channel sets per scan type', GH2 + 3, 2);
  const skewBlocks = count(29, 'skew blocks', rev3 ? GH2 + 8 : null, 2);
  const extendedBlocks = count(30, 'extended header blocks', GH2 + 5, rev3 ? 3 : 2);
  const externalBlocks = count(31, 'external header blocks', rev3 ? GH2 + 27 : GH2 + 7, rev3 ? 3 : 2);
  for (const c of [scanTypes, channelSets, skewBlocks, extendedBlocks, externalBlocks]) {
    if (c.bad) {
      out.why = c.bad;
      return out;
    }
  }
  out.scanTypes = scanTypes.value;
  out.channelSetsPerScanType = channelSets.value;
  out.skewBlocks = skewBlocks.value;
  out.extendedHeaderBlocks = extendedBlocks.value;
  out.externalHeaderBlocks = externalBlocks.value;

  if (rev3) {
    const gt = uintAt(buf, GH2 + 12, 4);
    if (gt === 0xffffffff) {
      out.why = 'General Header Block #2 bytes 13-16 declare an UNKNOWN number of general trailer blocks (FFFFFFFF), so the record end is not computable from the header';
      return out;
    }
    out.generalTrailerBlocks = gt;
  } else {
    out.generalTrailerBlocks = uintAt(buf, GH2 + 12, 2);
  }
  out.trailerBytes = out.generalTrailerBlocks * 32;

  const scanTypeHeaderBytes = out.scanTypes * (out.channelSetsPerScanType * out.csdSize + out.skewBlocks * 32);
  out.headerBytes = out.generalHeaderBytes + scanTypeHeaderBytes + (out.extendedHeaderBlocks + out.externalHeaderBlocks) * 32;
  if (out.headerBytes > buf.length) {
    out.why = 'the declared header block (' + out.headerBytes + ' bytes) is larger than the file';
    return out;
  }
  if (out.scanTypes < 1 || out.channelSetsPerScanType < 1) {
    out.why = 'the file declares ' + out.scanTypes + ' scan type(s) and ' + out.channelSetsPerScanType + ' channel set(s) per scan type, so it declares no data';
    return out;
  }

  for (let s = 0; s < out.scanTypes; s++) {
    for (let c = 0; c < out.channelSetsPerScanType; c++) {
      const off = out.generalHeaderBytes + s * (out.channelSetsPerScanType * out.csdSize + out.skewBlocks * 32) + c * out.csdSize;
      const csd = { index: out.csds.length, offset: off, scanType: s + 1, set: c + 1 };
      if (rev3) {
        csd.channels = u24(buf, off + 20);
        csd.ns = uintAt(buf, off + 12, 4);
      } else {
        const ch = bcdAt(buf, off + 8, 2);
        if (!ch.ok || ch.allF) {
          out.why = 'channel set descriptor ' + (csd.index + 1) + ' bytes 9-10 are not packed BCD, so the channel count cannot be read';
          return out;
        }
        csd.channels = ch.value;
        csd.ns = null; // Rev 1 carries it per trace, in Trace Header Extension bytes 8-10
      }
      out.csds.push(csd);
    }
  }

  // Walk the data body trace by trace. Each trace declares its own number of
  // 32-byte extension blocks in demux trace header byte 10, and in Rev 1 its
  // own sample count in Trace Header Extension bytes 8-10.
  let off = out.headerBytes;
  for (const csd of out.csds) {
    for (let i = 0; i < csd.channels; i++) {
      if (off + 20 > buf.length) {
        out.why = 'the file ends inside the demux trace header of trace ' + (out.traces.length + 1);
        return out;
      }
      const the = buf[off + 9];
      if (the === 0) {
        out.why = 'trace ' + (out.traces.length + 1) + ' declares zero trace header extension blocks, so the samples-per-trace field the walk needs is not present';
        return out;
      }
      if (off + 20 + the * 32 > buf.length) {
        out.why = 'the file ends inside the trace header extensions of trace ' + (out.traces.length + 1);
        return out;
      }
      const ns = rev3 ? csd.ns : u24(buf, off + 20 + 7);
      if (!(ns > 0)) {
        out.why = 'trace ' + (out.traces.length + 1) + ' declares ' + ns + ' samples';
        return out;
      }
      const stride = 20 + the * 32 + ns * out.bps;
      out.traces.push({ offset: off, csdIndex: csd.index, the, ns, dataOffset: off + 20 + the * 32, stride });
      off += stride;
      if (off > buf.length) {
        out.why = 'trace ' + out.traces.length + ' runs ' + (off - buf.length) + ' byte(s) past the end of the file';
        return out;
      }
    }
  }
  out.dataEnd = off;
  out.predicted = off + out.trailerBytes;
  out.ok = out.predicted === buf.length && out.traces.length > 0;
  if (!out.ok) {
    out.why = out.traces.length === 0
      ? 'the file declares no traces'
      : 'the walk ended at ' + out.predicted + ' byte(s) but the file is ' + buf.length + ' byte(s)';
  }
  return out;
}

/** Every place in the file a SEG-D rule's field appears: one spot for a general
 *  header rule, one per channel set descriptor, one per trace. */
function segdSpots(rule, layout) {
  switch (rule.scope) {
    case 'generalHeader1': return [{ label: null, base: 0 }];
    case 'generalHeader2': return [{ label: null, base: 32 }];
    case 'channelSetDescriptor':
      return layout.csds.map((c) => ({ label: 'channel set ' + (c.index + 1), base: c.offset, csd: c }));
    case 'demuxTraceHeader':
      return layout.traces.map((t, i) => ({ label: 'trace ' + (i + 1), base: t.offset, trace: t, i }));
    case 'traceHeaderExtension1':
      return layout.traces.map((t, i) => ({ label: 'trace ' + (i + 1), base: t.offset + 20, trace: t, i }));
    default: return [];
  }
}

/** True when any sample in this channel set is not zero. Only the vertical
 *  stack rows use this, and only to decide whether a declared "the trace data
 *  was intentionally set to real zero" is contradicted by the file itself. */
function channelSetHasSignal(buf, layout, csd) {
  for (const t of layout.traces) {
    if (t.csdIndex !== csd.index) continue;
    for (let i = 0; i < t.ns; i++) {
      const o = t.dataOffset + i * layout.bps;
      for (let k = 0; k < layout.bps; k++) if (buf[o + k] !== 0) return true;
    }
  }
  return false;
}

/** Apply one SEG-D rule row to one written file. Same contract as applyRule:
 *  a verdict object, never a throw for a data reason, and an unevaluable rule
 *  reports SKIP with the reason rather than quietly passing. */
function applySegdRule(rule, ctx) {
  const level = (rule.levelByRevision && rule.levelByRevision[ctx.declaredRev]) || rule.level;
  const base = { id: rule.id, level, bytes: rule.bytes, field: rule.field, citation: rule.citation, citationCaveat: rule.citationCaveat };
  const skip = (why) => ({ ...base, status: 'SKIP', why });
  const pass = (expected, actual) => ({ ...base, status: 'PASS', expected, actual });
  const fail = (expected, actual) => ({ ...base, status: 'FAIL', expected, actual });
  const { buf, layout } = ctx;
  const c = rule.check;

  if (c.kind === 'fileAtLeast') {
    return buf.length >= c.bytes ? pass('at least ' + c.bytes + ' bytes', buf.length + ' bytes') : fail('at least ' + c.bytes + ' bytes', buf.length + ' bytes');
  }
  if (c.kind === 'layoutCloses') {
    if (!layout.ok) return fail('the declared layout closes exactly on the file size', layout.why);
    return pass('closes exactly on the file size',
      layout.headerBytes + ' header byte(s) + ' + layout.traces.length + ' trace(s) + ' + layout.trailerBytes +
      ' trailer byte(s) = ' + layout.predicted + ' = file size (' + layout.generalHeaderBlocks + ' general header block(s) from ' +
      layout.additionalFrom + ', ' + layout.scanTypes + ' scan type(s) x ' + layout.channelSetsPerScanType + ' channel set(s) of ' +
      layout.csdSize + ' bytes, format ' + layout.formatCode + ' at ' + layout.bps + ' byte(s)/sample)');
  }
  if (c.kind === 'generalHeaderBlockPresent') {
    if (!layout.ok && layout.generalHeaderBlocks === undefined) return skip('the layout did not resolve far enough to count the general header blocks: ' + layout.why);
    const seen = [];
    for (let b = 0; b < layout.generalHeaderBlocks; b++) {
      if (32 * b + 32 > buf.length) break;
      seen.push(buf[32 * b + 31]);
    }
    const want = c.id;
    return seen.includes(want)
      ? pass('a general header block whose byte 32 is ' + want, 'block ' + (seen.indexOf(want) + 1) + ' carries it')
      : fail('a general header block whose byte 32 is ' + want + ' (General Header Block #3)',
        layout.generalHeaderBlocks + ' general header block(s) are declared and their byte 32 values are {' + seen.join(', ') + '}');
  }

  if (!layout.ok && rule.scope !== 'generalHeader1' && rule.scope !== 'generalHeader2') {
    return skip('the layout did not resolve, so the ' + rule.scope + ' blocks cannot be located: ' + layout.why);
  }
  const spots = segdSpots(rule, layout);
  if (spots.length === 0) return skip('no ' + rule.scope + ' to read (the layout resolved none)');

  const where = (s) => (s.label ? s.label + ' ' : '');
  const off = (s) => s.base + (rule.offset0 || 0);
  const noun = rule.scope === 'channelSetDescriptor' ? 'channel set'
    : (rule.scope === 'demuxTraceHeader' || rule.scope === 'traceHeaderExtension1') ? 'trace' : 'block';

  // ---- checks that read one field per spot -------------------------------
  const perSpot = (fn) => {
    for (const s of spots) {
      if (off(s) + (rule.width || 1) > buf.length) return fail('a readable field', where(s) + 'field runs past the end of the file');
      const v = fn(s);
      if (v) return v;
    }
    return pass(perSpotExpected, spots.length === 1
      ? (spots[0].label ? spots[0].label + ' holds ' + perSpotActual : perSpotActual)
      : 'all ' + spots.length + ' ' + noun + 's hold, e.g. ' + perSpotActual);
  };
  let perSpotExpected = '';
  let perSpotActual = '';

  switch (c.kind) {
    case 'bcdInRange': {
      perSpotExpected = 'packed BCD, ' + c.min + ' to ' + c.max + (c.allowAllF ? ', or all F' : '');
      return perSpot((s) => {
        const d = bcdAt(buf, off(s), rule.width || 1, Boolean(c.skipHighNibble));
        if (d.allF) {
          if (!c.allowAllF) return fail(perSpotExpected, where(s) + 'is all F, which this field does not define as an escape');
          perSpotActual = 'all F (the extended field is in use)';
          return null;
        }
        if (!d.ok) return fail(perSpotExpected, where(s) + 'nibble ' + d.badIndex + ' is ' + d.badNibble + ', which is not a decimal digit');
        if (d.value < c.min || d.value > c.max) return fail(perSpotExpected, where(s) + 'holds ' + d.value);
        perSpotActual = String(d.value);
        return null;
      });
    }
    case 'uintInRange': {
      perSpotExpected = c.min + ' to ' + c.max;
      return perSpot((s) => {
        const v = uintAt(buf, off(s), rule.width || 1);
        if (v < c.min || v > c.max) return fail(perSpotExpected, where(s) + 'holds ' + v);
        perSpotActual = String(v);
        return null;
      });
    }
    case 'uintInSet': {
      perSpotExpected = 'one of {' + c.values.join(', ') + '}';
      return perSpot((s) => {
        const v = uintAt(buf, off(s), rule.width || 1);
        if (!c.values.includes(v)) return fail(perSpotExpected, where(s) + 'holds ' + v);
        perSpotActual = String(v);
        return null;
      });
    }
    case 'equals': {
      perSpotExpected = String(c.value);
      return perSpot((s) => {
        const v = uintAt(buf, off(s), rule.width || 1);
        if (v !== c.value) return fail(perSpotExpected, where(s) + 'holds ' + v);
        perSpotActual = String(v);
        return null;
      });
    }
    case 'majorMinorEquals': {
      perSpotExpected = 'major ' + c.major + ', minor ' + c.minor;
      return perSpot((s) => {
        const mj = buf[off(s)];
        const mn = buf[off(s) + 1];
        if (mj !== c.major || mn !== c.minor) return fail(perSpotExpected, where(s) + 'holds major ' + mj + ', minor ' + mn);
        perSpotActual = 'major ' + mj + ', minor ' + mn;
        return null;
      });
    }
    case 'hexDigitsInSet': {
      perSpotExpected = 'one of {' + c.values.join(', ') + '}';
      return perSpot((s) => {
        const h = hex4(buf, off(s));
        if (!c.values.includes(h)) return fail(perSpotExpected, where(s) + 'holds ' + h);
        perSpotActual = h;
        return null;
      });
    }
    case 'nibbleInRange':
    case 'nibbleInSet': {
      const half = c.half === 'high' ? 'upper' : 'lower';
      perSpotExpected = 'the ' + half + ' nibble ' + (c.kind === 'nibbleInSet' ? 'is one of {' + c.values.join(', ') + '}' : 'is ' + c.min + ' to ' + c.max);
      return perSpot((s) => {
        let v = c.half === 'high' ? buf[off(s)] >> 4 : buf[off(s)] & 0x0f;
        let from = 'the ' + half + ' nibble of the byte';
        // F in the upper nibble of General Header Block #1 byte 12 is the
        // documented escape to the two-byte count in block #2; follow it.
        if (c.half === 'high' && v === 0x0f && rule.scope === 'generalHeader1' && rule.offset0 === 11 && layout.additionalGeneralHeaders !== undefined) {
          v = layout.additionalGeneralHeaders;
          from = 'General Header Block #2 bytes 23-24, which byte 12 escapes to with F';
        }
        const bad = c.kind === 'nibbleInSet' ? !c.values.includes(v) : (v < c.min || v > c.max);
        if (bad) return fail(perSpotExpected, where(s) + 'holds ' + v + ' in ' + from);
        perSpotActual = v + ' (' + from + ')';
        return null;
      });
    }
    case 'bytesNoZero': {
      perSpotExpected = 'no zero byte anywhere in the ' + rule.width + '-byte field';
      return perSpot((s) => {
        for (let i = 0; i < rule.width; i++) {
          if (buf[off(s) + i] === 0) {
            let zeros = 0;
            for (let k = 0; k < rule.width; k++) if (buf[off(s) + k] === 0) zeros++;
            return fail(perSpotExpected, where(s) + 'holds ' + zeros + ' zero byte(s) of ' + rule.width +
              (zeros === rule.width ? ' - the field was never written' : ''));
          }
        }
        perSpotActual = 'no zero byte';
        return null;
      });
    }

    // ---- checks that relate two fields ------------------------------------
    case 'matchesCsdField': {
      perSpotExpected = 'equal to channel set descriptor bytes ' + c.csdBytes;
      return perSpot((s) => {
        const csd = layout.csds[s.trace.csdIndex];
        const want = uintAt(buf, csd.offset + c.csdOffset0, c.csdWidth);
        const got = uintAt(buf, off(s), rule.width || 1);
        if (got !== want) return fail(perSpotExpected, where(s) + 'holds ' + got + ' against ' + want + ' in its channel set descriptor');
        perSpotActual = got + ', matching its channel set descriptor';
        return null;
      });
    }
    case 'theCountMatchesDemux': {
      for (const s of spots) {
        const csd = s.csd;
        const v = layout.rev3 ? buf[csd.offset + 27] : (buf[csd.offset + 28] & 0x0f);
        if (v < c.min || v > c.max) {
          return fail(c.min + ' to ' + c.max + ', and equal to byte 10 of every demux trace header in the channel set', where(s) + 'declares ' + v);
        }
        for (const t of layout.traces) {
          if (t.csdIndex !== csd.index) continue;
          if (t.the !== v) {
            return fail('every trace in ' + where(s) + 'carries ' + v + ' in demux trace header byte 10',
              'a trace at file offset ' + t.offset + ' carries ' + t.the);
          }
        }
      }
      const first = layout.rev3 ? buf[layout.csds[0].offset + 27] : (buf[layout.csds[0].offset + 28] & 0x0f);
      return pass(c.min + ' to ' + c.max + ', and equal to byte 10 of every demux trace header in the channel set',
        first + ', and all ' + layout.traces.length + ' trace(s) agree');
    }
    case 'endTimeFormulaRev3': {
      for (const s of spots) {
        const o = s.base;
        const tf = i32(buf, o + 4, false);
        const te = i32(buf, o + 8, false);
        const ns = uintAt(buf, o + 12, 4);
        const sr = u24(buf, o + 23);
        const want = tf + ns * sr;
        if (te !== want) {
          return fail('TE = TF + NS * SR = ' + tf + ' + ' + ns + ' * ' + sr + ' = ' + want + ' microseconds',
            where(s) + 'declares TE = ' + te + ', which is ' + (want - te) + ' microsecond(s) short' +
            (sr > 0 && (want - te) === sr ? ' - exactly one sampling interval, the classic off-by-one where TE is set to the time of the LAST sample instead of one interval past it' : ''));
        }
      }
      const o0 = spots[0].base;
      return pass('TE = TF + NS * SR', 'TE = ' + i32(buf, o0 + 8, false) + ' microseconds in all ' + spots.length + ' channel set(s)');
    }
    case 'endTimeMatchesRecordLengthRev1': {
      if (layout.scanTypes !== 1) return skip('the file declares ' + layout.scanTypes + ' scan types; the rule speaks about a single scan type record');
      const erl = u24(buf, layout.gh2Offset + 14);
      if (erl === 0) return skip('General Header Block #2 bytes 15-17 hold zero, so no extended record length is in use to compare against');
      for (const s of spots) {
        const te2ms = uintAt(buf, s.base + 4, 2);
        if (te2ms * 2 !== erl) {
          return fail('channel set end time x 2 ms = the extended record length (' + erl + ' ms)',
            where(s) + 'declares ' + te2ms + ' x 2 = ' + te2ms * 2 + ' ms');
        }
      }
      return pass('channel set end time x 2 ms = the extended record length', erl + ' ms, in all ' + spots.length + ' channel set(s)');
    }
    case 'recordLengthFFFWhenExtended': {
      const erl = c.extendedField === 'rev3' ? uintAt(buf, 32 + 16, 4) : u24(buf, 32 + 14);
      const bytes = c.extendedField === 'rev3' ? 'bytes 17-20' : 'bytes 15-17';
      if (erl === 0) return skip('General Header Block #2 ' + bytes + ' hold zero, so the extended record length is not in use and the FFF requirement does not apply');
      const lo = buf[25] & 0x0f;
      const b27 = buf[26];
      const got = lo.toString(16).toUpperCase() + b27.toString(16).toUpperCase().padStart(2, '0');
      return lo === 0x0f && b27 === 0xff
        ? pass('the three record-length nibbles are FFF', 'FFF, with the extended record length holding ' + erl)
        : fail('the three record-length nibbles are FFF (the extended record length is in use, holding ' + erl + ')', 'they hold ' + got);
    }
    case 'verticalStackAgainstSamples': {
      for (const s of spots) {
        const v = buf[s.base + 29];
        if (v !== 0) continue;
        if (channelSetHasSignal(buf, layout, s.csd)) {
          return fail('a non-zero effective stack order, because the channel set carries data (1 means no stack)',
            where(s) + 'declares 0, which the standard defines as "the trace data was intentionally set to real zero", ' +
            'while the samples in that channel set are not all zero');
        }
      }
      return pass('zero only where the data really is zero', 'all ' + spots.length + ' channel set(s) agree with their samples');
    }
    case 'bcdSequenceFromOne': {
      const perSet = new Map();
      for (const s of spots) {
        const idx = s.trace.csdIndex;
        const nth = (perSet.get(idx) || 0) + 1;
        perSet.set(idx, nth);
        const d = bcdAt(buf, off(s), rule.width || 1);
        if (d.allF) {
          if (!c.allowAllF) return fail('packed BCD counting from 1 within the channel set', where(s) + 'is all F, which this field does not define as an escape');
          continue;
        }
        if (!d.ok) return fail('packed BCD counting from 1 within the channel set', where(s) + 'nibble ' + d.badIndex + ' is ' + d.badNibble + ', which is not a decimal digit');
        if (d.value !== nth) return fail('trace ' + nth + ' of its channel set carries ' + nth, where(s) + 'carries ' + d.value);
      }
      return pass('each channel set numbers its traces from 1 upwards, in packed BCD', '1 to ' + spots.length + ', in order');
    }
    default:
      return skip('unimplemented check kind "' + c.kind + '"');
  }
}


// ================================================================= SEG-2
// SEG-2 is the only format here that declares its own byte order, in the two
// bytes it opens with, and the only one whose records are found through a
// pointer array rather than by multiplying a stride. Every read below therefore
// takes the order those two bytes declared, and the walk follows the pointers.
//
// SEG-2 numbers its own bytes from ZERO. The offsets in this section and in
// rules.seg2.json are the document's own numbers, unlike the SEG-Y and SEG-D
// sections, which number from one.

/** A keyword read out of a file is UNTRUSTED TEXT. A free-form section that did
 *  not parse can hand back any bytes at all, and this harness must never print a
 *  fragment of a real survey or client name to a console. Anything that is not a
 *  plausible SEG-2 keyword is replaced rather than shown. */
const safeKeyword = (k) => (/^[A-Za-z0-9_.-]{1,40}$/.test(k) ? k : '<not a printable keyword>');

/** Walk one free-form string sub-block by its own two-byte offsets.
 *
 *  SEG-2 section C: every string starts with a two-byte offset to the next one,
 *  and a two-byte zero ends the list. The offsets ARE the list - there is no
 *  other way to find the second string - so a section written as plain lines
 *  with no offsets is not a shorter form of the format, it is unreadable, and
 *  this returns ok:false with the reason rather than an empty list.
 *
 *  Only KEYWORDS are captured. A SEG-2 value can be a client, survey or crew
 *  name and must never leave this process. */
function walkSeg2Strings(buf, start, end, le) {
  const items = [];
  let cur = start;
  for (let guard = 0; guard < 4096; guard++) {
    if (cur + 2 > end) {
      return { ok: false, items, why: 'the string list ran to the end of the block without the terminating zero offset' };
    }
    const off = u16(buf, cur, le);
    if (off === 0) return { ok: true, items, terminated: true };
    if (off < 3) {
      return { ok: false, items, why: 'the string at block offset ' + (cur - start) + ' declares a next-string offset of ' + off + ', too small to hold its own two-byte offset and a keyword' };
    }
    if (cur + off > end) {
      return { ok: false, items, why: 'the string at block offset ' + (cur - start) + ' declares a next-string offset of ' + off + ', which runs past the end of the block' };
    }
    let k = '';
    for (let j = cur + 2; j < cur + off && j < end; j++) {
      const ch = buf[j];
      if (ch === 0x20 || ch === 0x09 || ch === 0x00) break;
      k += String.fromCharCode(ch);
    }
    items.push({ keyword: k, at: cur - start, length: off });
    cur += off;
  }
  return { ok: false, items, why: 'more than 4096 strings in one block; refusing to keep walking' };
}

/** Resolve the record the SEG-2 file DECLARES and report whether it closes
 *  exactly on the real size.
 *
 *    32-byte File Descriptor Block
 *  + Trace Pointer Subblock of M bytes, starting at byte 32
 *  + optional free format section
 *  + for each of the N pointers: a Trace Descriptor Block of its own declared
 *    size, followed by a Data Block of its own declared size
 *  == the real file size
 *
 *  A gap BEFORE the first Trace Descriptor Block is legitimate: that is where
 *  the File Descriptor Block's own free format strings live. An overlap is not,
 *  and neither is a file that ends before or after the last Data Block. */
function resolveSeg2Layout(buf, forceLe) {
  const out = { ok: false, why: '', size: buf.length, tdbs: [], forced: forceLe !== undefined };
  if (buf.length < 32) {
    out.why = 'file is shorter than the 32-byte File Descriptor Block';
    return out;
  }
  out.firstByte = buf[0];
  if (buf[0] === 0x55 && buf[1] === 0x3a) out.le = true;
  else if (buf[0] === 0x3a && buf[1] === 0x55) out.le = false;
  else out.le = null;
  // With no declared order the fields are still read, little-endian, so the rows
  // about them can report a real value instead of skipping; the block-id and
  // byte-order rows are what fail in that case, which is the honest place for
  // the failure to land. `forceLe` overrides the declared order entirely, which
  // is how SEG2-FDB-04-INTEGER-BYTE-ORDER asks whether the OTHER order is the
  // one the integers were actually written in.
  const le = forceLe !== undefined ? forceLe : out.le === null ? true : out.le;
  out.readAs = le;
  out.blockId = u16(buf, 0, le);
  out.revision = u16(buf, 2, le);
  out.M = u16(buf, 4, le);
  out.N = u16(buf, 6, le);
  out.strTermSize = buf[8];
  out.strTerm = [buf[9], buf[10]];
  out.lineTermSize = buf[11];
  out.lineTerm = [buf[12], buf[13]];
  if (out.le === null) {
    out.why = 'bytes 0-1 are ' + hex4(buf, 0) + ', which is neither 553A nor 3A55, so the file declares no byte order';
    return out;
  }
  if (out.N < 1) {
    out.why = 'bytes 6-7 declare ' + out.N + ' traces';
    return out;
  }
  out.pointerArrayEnd = 32 + out.N * 4;
  if (out.pointerArrayEnd > buf.length) {
    out.why = 'the ' + out.N + ' declared trace pointers need ' + out.pointerArrayEnd + ' bytes and the file is ' + buf.length;
    return out;
  }
  out.pointers = [];
  for (let i = 0; i < out.N; i++) out.pointers.push(u32(buf, 32 + i * 4, le));

  let cursor = out.pointerArrayEnd;
  for (let i = 0; i < out.N; i++) {
    const at = out.pointers[i];
    if (at + 32 > buf.length) {
      out.why = 'trace pointer ' + i + ' points at byte ' + at + ', which leaves no room for a 32-byte Trace Descriptor Block in a ' + buf.length + '-byte file';
      return out;
    }
    if (at < cursor) {
      out.why = 'trace pointer ' + i + ' points at byte ' + at + ', which is inside a region already accounted for (it ends at ' + cursor + ')';
      return out;
    }
    const t = {
      index: i,
      at,
      blockId: u16(buf, at, le),
      blockSize: u16(buf, at + 2, le),
      dataSize: u32(buf, at + 4, le),
      nSamples: u32(buf, at + 8, le),
      formatCode: buf[at + 12],
    };
    t.bps = SEG2_BPS[t.formatCode] || 0;
    if (t.blockSize < 32) {
      out.why = 'the Trace Descriptor Block at byte ' + at + ' declares a size of ' + t.blockSize + ' bytes, smaller than its own fixed 32-byte part';
      return out;
    }
    t.dataAt = at + t.blockSize;
    t.end = t.dataAt + t.dataSize;
    if (t.end > buf.length) {
      out.why = 'the Trace Descriptor Block at byte ' + at + ' declares ' + t.blockSize + ' + ' + t.dataSize + ' bytes, which runs past the end of the ' + buf.length + '-byte file';
      return out;
    }
    t.strings = walkSeg2Strings(buf, at + 32, at + t.blockSize, le);
    out.tdbs.push(t);
    cursor = t.end;
  }
  out.predicted = cursor;
  out.gapBeforeFirstTdb = out.pointers[0] - out.pointerArrayEnd;
  out.ok = cursor === buf.length;
  if (!out.ok) {
    out.why = 'the declared blocks end at byte ' + cursor + ' and the file is ' + buf.length + ' bytes';
  }
  return out;
}

/** Apply one SEG-2 rule row to one written file. Same contract as applyRule and
 *  applySegdRule: a verdict object, never a throw for a data reason, and an
 *  unevaluable rule reports SKIP with the reason rather than quietly passing. */
function applySeg2Rule(rule, ctx) {
  const base = { id: rule.id, level: rule.level, bytes: rule.bytes, field: rule.field, citation: rule.citation, citationCaveat: rule.citationCaveat };
  const skip = (why) => ({ ...base, status: 'SKIP', why });
  const pass = (expected, actual) => ({ ...base, status: 'PASS', expected, actual });
  const fail = (expected, actual) => ({ ...base, status: 'FAIL', expected, actual });
  const { buf, layout } = ctx;
  const c = rule.check;

  // One scalar test, shared by the File Descriptor Block rows and the per-Trace
  // Descriptor Block rows, so a value cannot come to be judged one way in one
  // place and another way in another.
  const describe = () =>
    c.op === 'equals' ? String(c.value)
      : c.op === 'inSet' ? 'one of {' + c.values.join(', ') + '}'
        : c.op === 'inRange' ? c.min + ' to ' + c.max
          : c.op === 'divisibleBy' ? 'divisible by ' + c.value
            : 'non-zero';
  const holds = (v) =>
    c.op === 'equals' ? v === c.value
      : c.op === 'inSet' ? c.values.includes(v)
        : c.op === 'inRange' ? v >= c.min && v <= c.max
          : c.op === 'divisibleBy' ? v % c.value === 0
            : v !== 0;

  switch (c.kind) {
    case 'seg2BlockId': {
      if (layout.le === null) return fail('3A55 hexadecimal in the order the same two bytes declare', 'bytes 0-1 are ' + hex4(buf, 0) + ', which is neither byte order of it');
      return layout.blockId === c.value
        ? pass('3A55 hexadecimal (' + c.value + ')', hex4(buf, 0) + ' stored, read as ' + layout.blockId + ' ' + (layout.le ? 'low byte first' : 'low byte last'))
        : fail('3A55 hexadecimal (' + c.value + ')', String(layout.blockId));
    }

    case 'seg2ByteOrderMark':
      return layout.firstByte === 0x55 || layout.firstByte === 0x3a
        ? pass('55h (low byte first) or 3Ah (low byte last)', '0x' + layout.firstByte.toString(16).toUpperCase().padStart(2, '0') + ', so ' + (layout.le ? 'low byte first' : 'low byte last'))
        : fail('55h (low byte first) or 3Ah (low byte last)', '0x' + layout.firstByte.toString(16).toUpperCase().padStart(2, '0'));

    case 'seg2IntegerByteOrder': {
      if (layout.le === null) return skip('bytes 0-1 declare no byte order at all; see SEG2-FDB-00-BYTE-ORDER-MARK');
      const declared = layout.le ? 'low byte first' : 'low byte last';
      const otherWord = layout.le ? 'low byte last' : 'low byte first';
      if (layout.ok) {
        return pass('the integers read in the order bytes 0-1 declare (' + declared + ')',
          'the declared order resolves the whole record: ' + layout.N + ' trace(s) closing on ' + layout.predicted + ' bytes');
      }
      const other = resolveSeg2Layout(buf, !layout.le);
      if (other.ok) {
        return fail('the integers read in the order bytes 0-1 declare (' + declared + ')',
          'bytes 0-1 declare ' + declared + ' and nothing resolves that way (' + layout.why + '), but read ' + otherWord +
          ' the record resolves exactly: ' + other.N + ' trace(s), trace pointer subblock ' + other.M +
          ' bytes, closing on ' + other.predicted + ' of ' + buf.length + ' bytes. The byte-order mark and the integers behind it disagree.');
      }
      return {
        ...base,
        status: 'INCONCLUSIVE',
        expected: 'the integers read in the order bytes 0-1 declare (' + declared + ')',
        actual: 'the record resolves in NEITHER order, so which one the integers are in cannot be decided here - ' +
          declared + ': ' + layout.why + ' | ' + otherWord + ': ' + other.why,
      };
    }

    case 'seg2Scalar': {
      const v = layout[c.field];
      if (v === undefined) return skip('the File Descriptor Block did not resolve far enough to read ' + c.field);
      return holds(v) ? pass(describe(), String(v)) : fail(describe(), String(v));
    }

    case 'seg2NAtMostMOver4': {
      if (layout.M === undefined || layout.N === undefined) return skip('the File Descriptor Block did not resolve');
      const limit = Math.floor(layout.M / 4);
      return layout.N <= limit
        ? pass('N at most M/4', 'N=' + layout.N + ', M=' + layout.M + ', M/4=' + limit)
        : fail('N at most M/4 (M=' + layout.M + ', so at most ' + limit + ')', 'N=' + layout.N);
    }

    case 'seg2TerminatorChars': {
      const size = c.which === 'string' ? layout.strTermSize : layout.lineTermSize;
      const chars = c.which === 'string' ? layout.strTerm : layout.lineTerm;
      if (size === undefined) return skip('the File Descriptor Block did not resolve');
      if (size !== 1 && size !== 2) return skip('the declared terminator size is ' + size + ', so there is no defined number of characters to read');
      const used = chars.slice(0, size);
      const bad = used.findIndex((x) => x > 31);
      return bad < 0
        ? pass('every character in decimal 0 to 31', used.map((x) => 'decimal ' + x).join(', '))
        : fail('every character in decimal 0 to 31', 'character ' + (bad + 1) + ' is decimal ' + used[bad]);
    }

    case 'seg2PointersClearSubblock': {
      if (!layout.pointers || layout.M === undefined) return skip('the File Descriptor Block did not resolve');
      const floorAt = 32 + layout.M;
      const bad = layout.pointers.findIndex((x) => x < floorAt);
      return bad < 0
        ? pass('every trace pointer at or after byte 32 + M = ' + floorAt, 'the first is ' + layout.pointers[0])
        : fail('every trace pointer at or after byte 32 + M = ' + floorAt + ' (M=' + layout.M + ')',
          'trace pointer ' + bad + ' points at byte ' + layout.pointers[bad] + ', which is ' + (floorAt - layout.pointers[bad]) + ' byte(s) inside the declared Trace Pointer Subblock');
    }

    case 'seg2PerTdb': {
      if (!layout.tdbs.length) return skip('no Trace Descriptor Block resolved, so there is nothing to read');
      const bad = layout.tdbs.find((t) => !holds(t[c.field]));
      return bad
        ? fail(describe(), 'trace ' + bad.index + ' carries ' + bad[c.field])
        : pass(describe(), 'all ' + layout.tdbs.length + ' trace(s) hold, e.g. ' + layout.tdbs[0][c.field]);
    }

    case 'seg2SamplesFillDataBlock': {
      if (!layout.tdbs.length) return skip('no Trace Descriptor Block resolved, so there is nothing to read');
      const noWidth = layout.tdbs.find((t) => !t.bps);
      if (noWidth) {
        return skip('trace ' + noWidth.index + ' declares data format code ' + noWidth.formatCode +
          ', which has no whole number of bytes per sample (code 3 packs two samples into five bytes); the width is not guessed');
      }
      const bad = layout.tdbs.find((t) => t.nSamples * t.bps !== t.dataSize);
      return bad
        ? fail('samples x sample width = Data Block size', 'trace ' + bad.index + ' declares ' + bad.nSamples + ' samples x ' + bad.bps + ' bytes = ' + bad.nSamples * bad.bps + ', and a Data Block of ' + bad.dataSize + ' bytes')
        : pass('samples x sample width = Data Block size', 'all ' + layout.tdbs.length + ' trace(s) hold, e.g. ' + layout.tdbs[0].nSamples + ' x ' + layout.tdbs[0].bps + ' = ' + layout.tdbs[0].dataSize);
    }

    case 'seg2LayoutCloses': {
      if (!layout.ok) return fail('the declared blocks close exactly on the file size', layout.why);
      return pass('closes exactly on the file size',
        '32 + ' + (layout.N * 4) + ' pointer bytes' +
        (layout.gapBeforeFirstTdb > 0 ? ' + ' + layout.gapBeforeFirstTdb + ' free-format bytes' : '') +
        ' + ' + layout.N + ' trace(s) = ' + layout.predicted + ' = file size');
    }

    case 'seg2StringListWalks': {
      if (!layout.tdbs.length) return skip('no Trace Descriptor Block resolved, so there is no string list to walk');
      const bad = layout.tdbs.find((t) => !t.strings.ok);
      return bad
        ? fail('a list of two-byte-prefixed strings ending in a zero offset', 'trace ' + bad.index + ': ' + bad.strings.why)
        : pass('a list of two-byte-prefixed strings ending in a zero offset',
          'all ' + layout.tdbs.length + ' trace(s) walk, e.g. ' + layout.tdbs[0].strings.items.length + ' string(s)');
    }

    case 'seg2KeywordsUppercase': {
      if (!layout.tdbs.length) return skip('no Trace Descriptor Block resolved');
      if (layout.tdbs.some((t) => !t.strings.ok)) return skip('the string list did not walk, so there are no keywords to read; see SEG2-TDB-32-STRING-LIST-WALKS');
      for (const t of layout.tdbs) {
        for (const it of t.strings.items) {
          if (/[a-z]/.test(it.keyword) || /[ \t]/.test(it.keyword) || it.keyword === '') {
            return fail('an uppercase keyword with no embedded space', 'trace ' + t.index + ' carries "' + safeKeyword(it.keyword) + '"');
          }
        }
      }
      const n = layout.tdbs.reduce((a, t) => a + t.strings.items.length, 0);
      return pass('an uppercase keyword with no embedded space', 'all ' + n + ' keyword(s) hold');
    }

    case 'seg2KeywordsAlphabetical': {
      if (!layout.tdbs.length) return skip('no Trace Descriptor Block resolved');
      if (layout.tdbs.some((t) => !t.strings.ok)) return skip('the string list did not walk, so there is no order to judge; see SEG2-TDB-32-STRING-LIST-WALKS');
      for (const t of layout.tdbs) {
        // NOTE is the one string the document exempts, and it is always last.
        const ks = t.strings.items.map((x) => x.keyword).filter((k) => k !== 'NOTE');
        for (let i = 1; i < ks.length; i++) {
          if (ks[i] < ks[i - 1]) {
            return fail('keywords in alphabetical order, NOTE last',
              'trace ' + t.index + ' carries "' + safeKeyword(ks[i]) + '" after "' + safeKeyword(ks[i - 1]) + '"');
          }
        }
        const noteAt = t.strings.items.findIndex((x) => x.keyword === 'NOTE');
        if (noteAt >= 0 && noteAt !== t.strings.items.length - 1) {
          return fail('keywords in alphabetical order, NOTE last', 'trace ' + t.index + ' carries NOTE at position ' + (noteAt + 1) + ' of ' + t.strings.items.length);
        }
      }
      return pass('keywords in alphabetical order, NOTE last', 'all ' + layout.tdbs.length + ' trace(s) hold');
    }

    case 'seg2KeywordPresent': {
      if (!layout.tdbs.length) return skip('no Trace Descriptor Block resolved');
      if (layout.tdbs.some((t) => !t.strings.ok)) return skip('the string list did not walk, so no keyword can be found; see SEG2-TDB-32-STRING-LIST-WALKS');
      const bad = layout.tdbs.find((t) => !t.strings.items.some((x) => x.keyword === c.keyword));
      return bad
        ? fail(c.keyword + ' present in every Trace Descriptor Block', 'trace ' + bad.index + ' has ' + bad.strings.items.length + ' string(s) and none of them is ' + c.keyword)
        : pass(c.keyword + ' present in every Trace Descriptor Block', 'all ' + layout.tdbs.length + ' trace(s) carry it');
    }

    default:
      return skip('unimplemented check kind "' + c.kind + '"');
  }
}

// ================================================================= SU
// SU has no file-wide header, no magic number and no byte-order marker, so the
// only thing that can resolve it is the arithmetic: a whole number of equal
// records of 240 + ns*4 bytes, with ns read out of the first trace header. The
// same arithmetic in the other byte order is what decides the byte order, which
// is what ObsPy's SU reader does and what core/formats/su.ts's detectSU does -
// and detectSU is deliberately NOT imported here, because it is code under test
// and a layout resolved by the thing being checked checks nothing.

/** Resolve the SU record stride in ONE byte order and report whether it tiles
 *  the file exactly. */
function probeSuLayout(buf, le) {
  const r = { le, ok: false, why: '', size: buf.length };
  if (buf.length < 240) {
    r.why = 'file is shorter than one 240-byte trace header';
    return r;
  }
  r.ns = u16(buf, 114, le);
  r.sampleInt = u16(buf, 116, le);
  if (r.ns <= 0) {
    r.why = 'the first trace header declares ' + r.ns + ' samples read ' + (le ? 'little' : 'big') + '-endian';
    return r;
  }
  r.stride = 240 + r.ns * SU_BPS;
  r.traceCount = Math.floor(buf.length / r.stride);
  r.leftover = buf.length % r.stride;
  r.dataStart = 0;
  r.ok = r.leftover === 0 && r.traceCount > 0;
  if (!r.ok) {
    r.why = r.traceCount === 0
      ? 'the file holds no whole record at the declared stride of ' + r.stride + ' bytes'
      : r.leftover + ' byte(s) left over after ' + r.traceCount + ' record(s) at a stride of ' + r.stride;
  }
  return r;
}

/** Both orders, then the one that closes. Big-endian is tried first and wins a
 *  tie, the same tie-break qa/oracle/oracle.py uses for SEG-Y. */
function resolveSuLayout(buf) {
  const be = probeSuLayout(buf, false);
  const le = probeSuLayout(buf, true);
  const chosen = be.ok ? be : le.ok ? le : be;
  return { ...chosen, big: be, little: le, closesBig: be.ok, closesLittle: le.ok };
}

/** Apply one SU rule row to one written file. Same contract as every other
 *  applier in this file. */
function applySuRule(rule, ctx) {
  const base = { id: rule.id, level: rule.level, bytes: rule.bytes, field: rule.field, citation: rule.citation, citationCaveat: rule.citationCaveat };
  const skip = (why) => ({ ...base, status: 'SKIP', why });
  const pass = (expected, actual) => ({ ...base, status: 'PASS', expected, actual });
  const fail = (expected, actual) => ({ ...base, status: 'FAIL', expected, actual });
  const { buf, layout } = ctx;
  const c = rule.check;

  if (c.kind === 'suLayoutCloses') {
    if (!layout.ok) {
      return fail('a whole number of records of 240 + ns*4 bytes',
        'big-endian: ' + layout.big.why + ' | little-endian: ' + layout.little.why);
    }
    return pass('a whole number of records of 240 + ns*4 bytes',
      layout.traceCount + ' x ' + layout.stride + ' = ' + layout.size + ' = file size (ns ' + layout.ns +
      ' from trace-header bytes 115-116, read ' + (layout.le ? 'little' : 'big') + '-endian, 4 bytes/sample)');
  }

  if (c.kind === 'suByteOrderDecidable') {
    if (!layout.closesBig && !layout.closesLittle) {
      return fail('the stride closes in exactly one byte order',
        'it closes in neither - big-endian: ' + layout.big.why + ' | little-endian: ' + layout.little.why);
    }
    if (layout.closesBig && layout.closesLittle) {
      return {
        ...base,
        status: 'INCONCLUSIVE',
        expected: 'the stride closes in exactly one byte order',
        actual: 'it closes in BOTH (big-endian ns ' + layout.big.ns + ', little-endian ns ' + layout.little.ns +
          '), so the byte order is not decidable from the file alone and every SU reader must guess',
      };
    }
    return pass('the stride closes in exactly one byte order',
      'closes ' + (layout.closesBig ? 'big' : 'little') + '-endian only; ' +
      (layout.closesBig ? 'little' : 'big') + '-endian: ' + (layout.closesBig ? layout.little.why : layout.big.why));
  }

  if (c.kind === 'suTraceField') {
    if (!layout.ok) return skip('the layout did not resolve, so the traces cannot be walked');
    const at = (i) => readField(buf, i * layout.stride + rule.offset0, rule.type, layout.le);
    const first = at(0);
    if (c.op === 'equalsFirst') {
      for (let i = 1; i < layout.traceCount; i++) {
        const v = at(i);
        if (v !== first) return fail('every trace carries the first trace value, ' + first, 'trace ' + i + ' carries ' + v);
      }
      return pass('every trace carries the first trace value', 'all ' + layout.traceCount + ' trace(s) carry ' + first);
    }
    if (c.op === 'nonDecreasing') {
      let prev = null;
      for (let i = 0; i < layout.traceCount; i++) {
        const v = at(i);
        if (prev !== null && v < prev) return fail('never decreases across the file', 'trace ' + i + ' carries ' + v + ' after ' + prev);
        prev = v;
      }
      return pass('never decreases across the file', 'runs to ' + prev + ' over ' + layout.traceCount + ' trace(s)');
    }
    const describeSu = c.op === 'inRange' ? c.min + ' to ' + c.max : 'non-zero';
    const holdsSu = (v) => (c.op === 'inRange' ? v >= c.min && v <= c.max : v !== 0);
    for (let i = 0; i < layout.traceCount; i++) {
      const v = at(i);
      if (!holdsSu(v)) return fail(describeSu, 'trace ' + i + ' carries ' + v);
    }
    return pass(describeSu, 'all ' + layout.traceCount + ' trace(s) hold, e.g. ' + first);
  }

  return skip('unimplemented check kind "' + c.kind + '"');
}

// ---------------------------------------------------------------- containers
/** The isolation flags, verbatim from qa/oracle/compare.mjs so no two oracle
 *  images can drift apart: no network, read-only root, one read-only bind at a
 *  FIXED target so the container never learns the real file name, no
 *  capabilities, no privilege escalation.
 *
 *  ONE function for all three images. `image` and `target` are parameters
 *  because the images differ; the flags are not parameters, because they must
 *  not. `args` is the argument list the entrypoint takes after the image name -
 *  only the ObsPy image uses it, and only to be told "seg2" or "su", which
 *  leaks nothing. */
function dockerArgs(path, image, target, args = []) {
  return [
    'run', '--rm',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--mount', 'type=bind,source=' + path + ',target=' + target + ',readonly',
    image,
    ...args,
  ];
}

/** Distinguish "the image is not built" from "the docker daemon is not
 *  running". qa/oracle/compare.mjs conflates the two into a single non-zero
 *  status; both still exit 2 here, but the console says which.
 *
 *  Answers are cached per image: three images asked about repeatedly is three
 *  `docker image inspect` calls, not thirty, and a daemon that went away
 *  mid-run would otherwise be reported inconsistently between formats. */
const DOCKER_STATE = new Map();
function dockerState(image) {
  if (DOCKER_STATE.has(image)) return DOCKER_STATE.get(image);
  const r = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' });
  let out;
  if (r.error) out = { usable: false, kind: 'absent', image, detail: 'the docker CLI could not be started' };
  else if (r.status === 0) out = { usable: true, kind: 'ready', image, detail: '' };
  else {
    const err = String(r.stderr || '');
    const kind = /daemon|pipe|Cannot connect|connection refused/i.test(err) ? 'daemon' : 'image';
    out = { usable: false, kind, image, detail: redact(err.trim().split('\n')[0] || '') };
  }
  DOCKER_STATE.set(image, out);
  return out;
}

function runOurs(path) {
  const r = spawnSync(process.execPath, [TSX_CLI, OURS, path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

// Ten minutes. No reference decode of one field record should come close to it,
// and a container that wedges must not hang `npm run qa:conform` for ever -
// these run with --rm and no timeout of their own, so this is the only stop.
// A timeout comes back as a failed run, which oracleJson turns into a reason and
// the caller reports as NO CROSS-CHECK, never as agreement.
const CONTAINER_TIMEOUT_MS = 600000;

function runImage(path, image, target, args = []) {
  const r = spawnSync('docker', dockerArgs(path, image, target, args), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: CONTAINER_TIMEOUT_MS,
  });
  const killed = r.error && (r.error.code === 'ETIMEDOUT' || r.signal);
  return {
    stdout: r.stdout || '',
    stderr: killed
      ? 'the container was killed after ' + (CONTAINER_TIMEOUT_MS / 1000) + ' s without returning'
      : r.stderr || '',
    status: r.status,
  };
}

/** The SEG-Y oracle, at the target qa/oracle/oracle.py already reads from.
 *  Unchanged in behaviour; it is the same image and the same mount point. */
function runOracle(path) {
  return runImage(path, IMAGE, '/data/input.sgy');
}

/** Parse one oracle's stdout, and turn anything unusable into a reason rather
 *  than a throw. Shared by all three images so a container that died is
 *  reported the same way whichever one it was. */
function oracleJson(run) {
  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    parsed = null;
  }
  if (parsed && parsed.ok === true) return { ok: true, json: parsed };
  const why = parsed && parsed.error
    ? redact(parsed.error)
    : run.stderr
      ? redact(run.stderr).trim().split('\n').slice(-1)[0]
      : 'the container returned nothing usable';
  return { ok: false, json: parsed, why };
}

/** Compare a written file's independent read against the source matrix, under
 *  the hash contract fixed in qa/oracle/README.md. ONE comparator for SEG-2,
 *  SEG-D and SU, so a disagreement cannot come to be reported one way for one
 *  format and another way for another. SEG-Y keeps its own inline comparison
 *  because it additionally asserts about fields that legitimately CHANGE on
 *  write, which the others do not have. */
function compareMatrix(source, ref, label) {
  const carried = ['trace_count', 'samples_per_trace', 'sample_matrix_values',
    'normalised_nan', 'normalised_neg_zero', 'sample_matrix_sha256'];
  let bad = 0;
  for (const k of carried) {
    const a = source[k];
    const b = ref[k];
    const same = a === b;
    if (!same) bad++;
    console.log('    ' + (same ? 'ok  ' : 'DIFF') + '  ' + k.padEnd(22) +
      ' source(SeisConv)=' + JSON.stringify(a) + '  written(' + label + ')=' + JSON.stringify(b));
  }
  // The sample interval is reported but NOT counted: SEG-2 states it in seconds
  // in a free-form string and SEG-D Rev 1 states it in milliseconds in the
  // general header, so a rounding difference there is a unit conversion, not a
  // lost sample. It is printed because a factor of 1000 is exactly the mistake
  // worth seeing.
  console.log('    note  sample_interval_us     source(SeisConv)=' + JSON.stringify(source.sample_interval_us) +
    '  written(' + label + ')=' + JSON.stringify(ref.sample_interval_us) + '  (reported, not counted)');
  return bad;
}

// ---------------------------------------------------------------- fixtures
/** Walk `root` for the first SEG-Y whose big-endian format code is `want`.
 *  Sorted, so the pick is deterministic; nothing about the corpus is hardcoded.
 *  Copied from qa/oracle/compare.mjs so both harnesses resolve fixture C the
 *  same way - an IBM-float source is the one that exercises IBM to IEEE on the
 *  WRITE path, so silently skipping it would lose the case that matters most. */
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

/** Walk `root` for the first SEG-D whose General Header Block #2 byte 11
 *  (the major SEG-D revision number) is `want`. Same shape as findByFormat:
 *  sorted so the pick is deterministic, two bytes read per candidate, nothing
 *  about the corpus hardcoded. */
function findSegdByRevision(root, want, maxDepth = 3) {
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
      } else if (/\.(segd|sgd)$/i.test(e.name)) {
        let fd = null;
        try {
          if (statSync(p).size < 64) continue;
          const one = Buffer.alloc(1);
          fd = openSync(p, 'r');
          // General Header Block #2 starts at byte 33 (offset 32); its byte 11
          // is offset 42. SEG-D Rev 2.1 section 8.2, SEG-D Rev 3.0 section 8.2.
          if (readSync(fd, one, 0, 1, 42) === 1 && one[0] === want) return p;
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

function resolveSegdFixtures() {
  const corpus = resolveValue('xfmtDir', 'SEISCONV_XFMT_DIR', '');
  const pick = (key, envVar, wantRev) => {
    const explicit = resolveValue(key, envVar, '');
    if (explicit) return explicit;
    if (corpus && existsSync(corpus)) return findSegdByRevision(corpus, wantRev) || '';
    return '';
  };
  const out = [
    { label: 'fixture D', why: 'vendor SEG-D declaring revision 2 (qa key "segdRev2")', path: pick('segdRev2', 'SEISCONV_QA_SEGD_REV2', 2) },
    { label: 'fixture E', why: 'vendor SEG-D declaring revision 3 (qa key "segdRev3")', path: pick('segdRev3', 'SEISCONV_QA_SEGD_REV3', 3) },
  ];
  for (const f of out) {
    f.present = Boolean(f.path) && existsSync(f.path);
    if (f.present) guard(f.path);
  }
  return out;
}

/** Walk `root` for the first SEG-2 file. The File Descriptor Block identifier
 *  is the test, not the extension: SEG-2 is written as .dat, .seg2, .sg2 and
 *  plenty else, and two bytes read off the front settle it where a file name
 *  cannot. Sorted, so the pick is deterministic. */
function findSeg2(root, maxDepth = 3) {
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
      } else if (/\.(dat|seg2|sg2)$/i.test(e.name)) {
        let fd = null;
        try {
          if (statSync(p).size < 32) continue;
          const two = Buffer.alloc(2);
          fd = openSync(p, 'r');
          if (readSync(fd, two, 0, 2, 0) === 2 &&
            ((two[0] === 0x55 && two[1] === 0x3a) || (two[0] === 0x3a && two[1] === 0x55))) return p;
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

function resolveSeg2Fixtures() {
  let path = resolveValue('seg2', 'SEISCONV_QA_SEG2', '');
  if (!path) {
    // Same fallback shape as fixtures C, D and E: walk the already-configured
    // crossformat corpus in sorted order, reading two bytes per candidate.
    const corpus = resolveValue('xfmtDir', 'SEISCONV_XFMT_DIR', '');
    if (corpus && existsSync(corpus)) path = findSeg2(corpus) || '';
  }
  const out = [{ label: 'fixture F', why: 'vendor SEG-2 (qa key "seg2")', path }];
  for (const f of out) {
    f.present = Boolean(f.path) && existsSync(f.path);
    if (f.present) guard(f.path);
  }
  return out;
}

function resolveFixtures() {
  // Fixture C: explicit key or env var first, then the same crossformat-corpus
  // walk qa/oracle/compare.mjs falls back to.
  let ibm = resolveValue('oracleIbm', 'SEISCONV_ORACLE_IBM', '');
  if (!ibm) {
    const corpus = resolveValue('xfmtDir', 'SEISCONV_XFMT_DIR', '');
    if (corpus && existsSync(corpus)) ibm = findByFormat(corpus, 1) || '';
  }
  const out = [
    { label: 'fixture A', why: 'big-endian SEG-Y (qa key "segy")', path: resolveValue('segy', 'SEISCONV_QA_SEGY', '') },
    { label: 'fixture B', why: 'little-endian SEG-Y (qa key "le")', path: resolveValue('le', 'SEISCONV_QA_LE', '') },
    { label: 'fixture C', why: 'IBM-float SEG-Y, data format code 1 (qa key "oracleIbm")', path: ibm },
  ];
  for (const f of out) {
    f.present = Boolean(f.path) && existsSync(f.path);
    if (f.present) guard(f.path);
  }
  return out;
}

// ---------------------------------------------------------------- SU output
/** Write one SU file out of an already-parsed source and return its bytes and
 *  path, or null when the writer refused.
 *
 *  SU output is driven from inside each source's own section rather than from a
 *  section of its own, so it reuses the source sample matrix that section
 *  already produced instead of parsing a multi-megabyte file a second time. */
function emitSu(pd, tmp, tag) {
  console.log('\n  ---- written as SU (Seismic Unix) ----');
  let written;
  try {
    written = writeSU(pd);
  } catch (e) {
    console.log('    the writer refused: ' + redact(e && e.message ? e.message : String(e)));
    console.log('    (a writer refusing loudly is not a conformance failure; nothing was produced to check)');
    return null;
  }
  const buf = Buffer.from(written.buffer, written.byteOffset, written.byteLength);
  const outPath = join(tmp, 'w' + tag + '.su');
  writeFileSync(outPath, buf);
  guard(outPath);
  console.log('    wrote ' + statSync(outPath).size + ' bytes');
  return { buf, outPath };
}

/** Layers a, b and c for one written SU file. Returns the counts the caller
 *  folds into the run totals; the tally of rule failures is updated in place by
 *  printVerdicts, which is the same function SEG-Y, SEG-D and SEG-2 call. */
function runSuChecks(suOut, sourceMatrix, dockerObspy, tally, perRevisionApplied) {
  const { buf, outPath } = suOut;
  const out = { applied: 0, agreed: 0, disagreed: 0, noCrossCheck: 0 };

  // -------- layer a: structure ------------------------------------------
  const layout = resolveSuLayout(buf);
  const orderWord = layout.closesBig && layout.closesLittle ? 'undecidable'
    : layout.ok ? (layout.le ? 'little-endian' : 'big-endian') : 'unresolved';
  console.log('    declared: ' + layout.ns + ' sample(s) per trace, ' + layout.sampleInt +
    ' us, stride ' + layout.stride + ' bytes, ' + layout.traceCount + ' record(s), byte order ' + orderWord);
  if (!layout.ok) {
    console.log('    the declared layout does NOT close - big-endian: ' + layout.big.why +
      ' | little-endian: ' + layout.little.why);
  }

  // -------- layer b: the cited rule table --------------------------------
  const applicable = RULES_SU.rules.filter((r) => r.appliesTo.includes('su'));
  const verdicts = applicable.map((r) => applySuRule(r, { buf, layout }));
  out.applied = printVerdicts(verdicts, tally);
  perRevisionApplied.SU = (perRevisionApplied.SU || 0) + out.applied;
  console.log('    rules applied for SU: ' + out.applied + ' of ' + applicable.length +
    ' (' + (applicable.length - out.applied) + ' not evaluable on this file)');

  // -------- layer c: independent read of the WRITTEN file ----------------
  if (!dockerObspy.usable) {
    console.log('    independent read: NOT RUN (no container) - ' + IMAGE_OBSPY);
    out.noCrossCheck++;
    return out;
  }
  if (!sourceMatrix || sourceMatrix.ok !== true) {
    console.log('    independent read: NO CROSS-CHECK - the source has no comparable sample matrix');
    out.noCrossCheck++;
    return out;
  }
  const got = oracleJson(runImage(outPath, IMAGE_OBSPY, '/data/input.bin', ['su']));
  if (!got.ok) {
    console.log('    independent read: NO CROSS-CHECK - ObsPy could not read the WRITTEN file: ' + got.why);
    out.noCrossCheck++;
    return out;
  }
  let bad = compareMatrix(sourceMatrix, got.json, 'ObsPy');

  // SU carries no byte-order marker, so both sides had to DECIDE the order from
  // the arithmetic alone, independently. That makes this a real cross-check
  // rather than an echo, and a disagreement about it is counted.
  const ours = layout.ok ? (layout.le ? 'little' : 'big') : null;
  const theirs = got.json.byte_order;
  if (ours === null || theirs === null || theirs === undefined) {
    console.log('    note  byte_order             harness(arithmetic)=' + JSON.stringify(ours) +
      '  written(ObsPy autodetect)=' + JSON.stringify(theirs) + '  (one side did not resolve it; not counted)');
  } else {
    const sameOrder = ours === theirs;
    if (!sameOrder) bad++;
    console.log('    ' + (sameOrder ? 'ok  ' : 'DIFF') + '  byte_order             harness(arithmetic)=' +
      JSON.stringify(ours) + '  written(ObsPy autodetect)=' + JSON.stringify(theirs));
  }

  if (bad === 0) {
    console.log('    independent read: AGREE - ObsPy decoded the written SU to the same sample matrix as the source (SHA-256 ' + got.json.sample_matrix_sha256 + ')');
    out.agreed++;
  } else {
    console.log('    independent read: DISAGREE - ' + bad + ' compared field(s) differ.');
    out.disagreed++;
  }
  return out;
}

// ---------------------------------------------------------------- reporting
function citationLine(cit) {
  const c = Array.isArray(cit) ? cit : [cit];
  return c.map((x) => x.doc + ', ' + x.section + (x.table ? ', ' + x.table : '') +
    ', printed page ' + x.pagePrinted + ' (PDF page ' + x.pagePdf + ')').join('  |  ');
}

function citationQuotes(cit) {
  const c = Array.isArray(cit) ? cit : [cit];
  return c.map((x) => '        "' + x.quote + '"').join('\n');
}

/** Print one verdict list and fold it into the tally. Shared by SEG-Y and
 *  SEG-D so the two formats cannot drift into reporting a failure differently.
 *  Returns the number of rules that were actually APPLIED - a SKIP is not an
 *  applied rule and must never be counted as one. */
function printVerdicts(verdicts, tally) {
  let applied = 0;
  for (const v of verdicts) {
    const tag = v.status === 'PASS' ? 'ok  ' : v.status === 'FAIL' ? 'FAIL' : v.status === 'SKIP' ? 'skip' : 'INCO';
    if (v.status !== 'SKIP') applied++;
    const head = '    ' + tag + '  ' + v.id.padEnd(38) + ' bytes ' + String(v.bytes).padEnd(11) + ' [' + v.level + ']';
    if (v.status === 'PASS') {
      console.log(head + '  ' + v.actual);
    } else if (v.status === 'SKIP') {
      console.log(head + '  ' + v.why);
    } else {
      console.log(head);
      console.log('        field    : ' + v.field);
      console.log('        expected : ' + v.expected);
      console.log('        actual   : ' + v.actual);
      console.log('        cite     : ' + citationLine(v.citation));
      console.log(citationQuotes(v.citation));
      if (v.citationCaveat) console.log('        caveat   : ' + v.citationCaveat);
      if (v.status === 'FAIL') {
        if (v.level === 'mandatory') tally.mandatoryFailures++;
        else tally.recommendedFailures++;
      } else {
        tally.inconclusive++;
      }
    }
  }
  return applied;
}

// ---------------------------------------------------------------- main
function main() {
  console.log('Output conformance - the bytes SeisConv WRITES, against the cited SEG rules');
  console.log('rule tables: qa/conform/rules.segy.json  (' + RULES.rules.length + ' rows)   ' +
    'qa/conform/rules.segd.json  (' + RULES_SEGD.rules.length + ' rows)   ' +
    'qa/conform/rules.seg2.json  (' + RULES_SEG2.rules.length + ' rows)   ' +
    'qa/conform/rules.su.json  (' + RULES_SU.rules.length + ' rows)');
  console.log('EBCDIC table for the textual header: qa/conform/ebcdic-appendix-f.json  (' +
    EBCDIC.codesMapped + ' codes, ' + EBCDIC.selfChecked + ' self-checked against the character each row names)');

  loadForbidden();
  const fixtures = resolveFixtures();
  const live = fixtures.filter((f) => f.present);
  const segdFixtures = resolveSegdFixtures();
  const liveSegd = segdFixtures.filter((f) => f.present);
  const seg2Fixtures = resolveSeg2Fixtures();
  const liveSeg2 = seg2Fixtures.filter((f) => f.present);
  for (const f of fixtures.concat(segdFixtures).concat(seg2Fixtures)) {
    if (!f.present) {
      console.log('  (skip) ' + f.label + ' - no ' + f.why + ' configured; set the env var or the qa/local-paths.json key, see qa/README.md');
    }
  }
  if (live.length === 0 && liveSegd.length === 0 && liveSeg2.length === 0) {
    console.log('\nNo fixtures configured. SKIP (exit 0), matching the file-backed core tests.');
    return 0;
  }

  // One state per image, and the build command each one needs. The SEG-D image
  // is new: SEG-D used to have no independent reader here at all. It has one
  // now, but it has never been RUN - see qa/oracle/README.md, "What still needs
  // docker" - so a missing SEG-D image is reported as a container that is not
  // built, exactly like SEG-Y's, and never as agreement.
  const dockerSegy = dockerState(IMAGE);
  const dockerSegd = dockerState(IMAGE_SEGD);
  const dockerObspy = dockerState(IMAGE_OBSPY);
  const BUILDS = {
    [IMAGE]: 'docker build -t ' + IMAGE + ' qa/oracle',
    [IMAGE_SEGD]: 'docker build -t ' + IMAGE_SEGD + ' -f qa/oracle/segd/Dockerfile qa/oracle',
    [IMAGE_OBSPY]: 'docker build -t ' + IMAGE_OBSPY + ' -f qa/oracle/obspy/Dockerfile qa/oracle',
  };
  const needed = [];
  if (live.length > 0) needed.push({ st: dockerSegy, what: 'SEG-Y (segyio)' });
  if (liveSegd.length > 0) needed.push({ st: dockerSegd, what: 'SEG-D (sedaman)' });
  if (liveSeg2.length > 0 || live.length > 0) needed.push({ st: dockerObspy, what: 'SEG-2 and SU (ObsPy)' });
  const missing = needed.filter((n) => !n.st.usable);
  if (missing.length > 0) {
    console.log('\nThe independent-read layer is NOT fully available:');
    // "the daemon is down" is one fact about the machine, not three facts about
    // three images, so it is said once.
    if (missing.every((n) => n.st.kind === 'daemon')) {
      console.log('  the docker daemon is unreachable - ' + missing[0].st.detail);
      console.log('  Every oracle image needs it, so none of the three cross-checks below can run today.');
    } else {
      for (const n of missing) {
        if (n.st.kind === 'daemon') {
          console.log('  ' + n.what + ': the docker daemon is unreachable - ' + n.st.detail);
        } else if (n.st.kind === 'image') {
          console.log('  ' + n.what + ': the image ' + n.st.image + ' is not built. Build it once - this is the ONLY step that uses the network:');
          console.log('    ' + BUILDS[n.st.image]);
        } else {
          console.log('  ' + n.what + ': ' + n.st.detail);
        }
      }
    }
    console.log('  The structural and rule-table layers do NOT need a container and are run anyway.');
  }

  const tally = { mandatoryFailures: 0, recommendedFailures: 0, inconclusive: 0 };
  let crossChecked = 0;
  let crossDisagreed = 0;
  let noCrossCheck = 0;
  let rulesApplied = 0;
  let rulesAppliedSegd = 0;
  let rulesAppliedSeg2 = 0;
  let rulesAppliedSu = 0;
  const perRevisionApplied = {};

  const tmp = mkdtempSync(join(tmpdir(), 'seisconv-conform-'));
  guard(tmp);

  try {
    for (const f of live) {
      console.log('\n' + '='.repeat(78) + '\n' + f.label + '  -  ' + f.why + '\n' + '='.repeat(78));

      // Parse the source with the REAL parser, exactly the way qa/oracle/ours.mjs
      // does, including the Infinity sample cap so every trace carries samples.
      let pd;
      try {
        pd = parseSEGY(new Uint8Array(readFileSync(f.path)), Infinity);
      } catch (e) {
        console.log('  the parser could not read the source: ' + redact(e && e.message ? e.message : String(e)));
        tally.mandatoryFailures++;
        continue;
      }
      if (!pd.traces || pd.traces.length === 0) {
        console.log('  the parser returned no traces for this source; nothing to write.');
        noCrossCheck++;
        continue;
      }
      console.log('  source parsed: ' + pd.traces.length + ' trace(s), input format ' + pd.format + ' rev ' + (pd.revision || 0));

      // The source-side sample matrix, produced by qa/oracle/ours.mjs so the hash
      // contract is the one already agreed, not a second one invented here.
      let sourceOurs = null;
      const so = runOurs(f.path);
      try {
        sourceOurs = JSON.parse(so.stdout);
      } catch {
        sourceOurs = null;
      }

      for (const rev of WRITTEN_REVISIONS) {
        console.log('\n  ---- written as ' + rev.label + ' ----');

        let written;
        try {
          written = writeSEGY(pd, rev.arg);
        } catch (e) {
          console.log('    the writer refused: ' + redact(e && e.message ? e.message : String(e)));
          console.log('    (a writer refusing loudly is not a conformance failure; nothing was produced to check)');
          continue;
        }
        const buf = Buffer.from(written.buffer, written.byteOffset, written.byteLength);
        const outPath = join(tmp, 'w' + rev.arg + '.sgy');
        writeFileSync(outPath, buf);
        guard(outPath);
        console.log('    wrote ' + statSync(outPath).size + ' bytes');

        // -------- layer a: structure ------------------------------------
        const layout = resolveLayout(buf, false, rev.declared);
        const textual = decodeTextual(buf);
        console.log('    textual header decoded as ' + textual.encoding + (textual.ok ? '' : ' (' + textual.why + ')'));
        if (textual.ok) {
          const ls = textualLines(textual.text);
          console.log('    record  1: "' + ls[0].trimEnd() + '"');
          console.log('    record 40: "' + ls[39].trimEnd() + '"');
          const endAt = ls.findIndex((l) => /END\s+(TEXTUAL\s+HEADER|EBCDIC)/i.test(l));
          if (endAt >= 0 && endAt !== 39) {
            console.log('    the end-of-header marker is in record ' + (endAt + 1) + ': "' + ls[endAt].trimEnd() + '"');
          }
        }

        // -------- layer b: the cited rule table -------------------------
        const applicable = RULES.rules.filter((r) => r.appliesTo.includes(rev.declared));
        const ctx = { buf, layout, textual, declaredRev: rev.declared };
        const verdicts = applicable.map((r) => applyRule(r, ctx));

        const applied = printVerdicts(verdicts, tally);
        rulesApplied += applied;
        perRevisionApplied[rev.label] = (perRevisionApplied[rev.label] || 0) + applied;
        console.log('    rules applied for ' + rev.label + ': ' + applied + ' of ' + applicable.length +
          ' (' + (applicable.length - applied) + ' not evaluable on this file)');

        // -------- layer c: independent read of the WRITTEN file ---------
        if (!dockerSegy.usable) {
          console.log('    independent read: NOT RUN (no container) - ' + IMAGE);
          noCrossCheck++;
          continue;
        }
        if (!sourceOurs || sourceOurs.ok !== true) {
          console.log('    independent read: NO CROSS-CHECK - the source has no comparable sample matrix' +
            (sourceOurs && sourceOurs.error ? ' (' + redact(sourceOurs.error) + ')' : ''));
          noCrossCheck++;
          continue;
        }
        const g = runOracle(outPath);
        let ref = null;
        try {
          ref = JSON.parse(g.stdout);
        } catch {
          ref = null;
        }
        if (!ref || ref.ok !== true) {
          const why = ref && ref.error ? redact(ref.error) : 'the container returned nothing usable';
          console.log('    independent read: NO CROSS-CHECK - segyio could not read the WRITTEN file: ' + why);
          if (g.stderr) console.log(redact(g.stderr).split('\n').slice(-4).map((l) => '      ' + l).join('\n'));
          noCrossCheck++;
          continue;
        }

        // Only the quantities that must SURVIVE the conversion are compared
        // against the source. Format code, byte order and revision legitimately
        // change on write (an IBM-float little-endian source becomes big-endian
        // IEEE float32), so those are asserted about the WRITTEN file instead.
        const carried = ['trace_count', 'samples_per_trace', 'sample_interval_us', 'sample_matrix_values',
          'normalised_nan', 'normalised_neg_zero', 'sample_matrix_sha256'];
        let bad = 0;
        for (const k of carried) {
          const a = sourceOurs[k];
          const b = ref[k];
          const same = a === b;
          if (!same) bad++;
          console.log('    ' + (same ? 'ok  ' : 'DIFF') + '  ' + k.padEnd(22) + ' source(SeisConv)=' + JSON.stringify(a) + '  written(segyio)=' + JSON.stringify(b));
        }
        for (const [k, want] of [['data_format_code', 5], ['byte_order', 'big'], ['revision_major', rev.arg]]) {
          const got = ref[k];
          const same = got === want;
          if (!same) bad++;
          console.log('    ' + (same ? 'ok  ' : 'DIFF') + '  written.' + k.padEnd(13) + ' expected=' + JSON.stringify(want) + '  segyio read=' + JSON.stringify(got));
        }
        if (bad === 0) {
          console.log('    independent read: AGREE - segyio decoded the written file to the same sample matrix as the source (SHA-256 ' + ref.sample_matrix_sha256 + ')');
          crossChecked++;
        } else {
          console.log('    independent read: DISAGREE - ' + bad + ' compared field(s) differ.');
          crossDisagreed++;
        }
      }

      // ---- the same source, written as Seismic Unix ---------------------
      // SU output is exercised here rather than in a section of its own so it
      // reuses the source sample matrix qa/oracle/ours.mjs already produced for
      // this fixture, instead of parsing a multi-megabyte file a second time.
      const suOut = emitSu(pd, tmp, 'A' + live.indexOf(f));
      if (suOut) {
        const r = runSuChecks(suOut, sourceOurs, dockerObspy, tally, perRevisionApplied);
        rulesAppliedSu += r.applied;
        crossChecked += r.agreed;
        crossDisagreed += r.disagreed;
        noCrossCheck += r.noCrossCheck;
      }
    }

    // ============================================================ SEG-2
    // A real vendor SEG-2 in, SeisConv's SEG-2 and SU out. The source sample
    // matrix comes from qa/oracle/hash.mjs, the same contract qa/oracle/ours.mjs
    // applies to SEG-Y, so the two sides of the comparison were never two
    // different ideas of what a sample matrix is.
    for (const f of liveSeg2) {
      console.log('\n' + '='.repeat(78) + '\n' + f.label + '  -  ' + f.why + '\n' + '='.repeat(78));

      let pd;
      try {
        pd = parseSEG2(new Uint8Array(readFileSync(f.path)));
      } catch (e) {
        console.log('  the parser could not read the source: ' + redact(e && e.message ? e.message : String(e)));
        tally.mandatoryFailures++;
        continue;
      }
      if (!pd.traces || pd.traces.length === 0) {
        console.log('  the parser returned no traces for this source; nothing to write.');
        continue;
      }
      console.log('  source parsed: ' + pd.traces.length + ' trace(s), sample interval ' +
        (pd.bh && pd.bh.sampleInt) + ' us, data format code ' + (pd.bh && pd.bh.dataFmt) +
        (pd.errors && pd.errors.length ? ', parser notes: ' + redact(pd.errors.join('; ')) : ''));

      const sourceMatrix = matrixOf(pd, 'seisconv core/formats/seg2.ts');
      if (!sourceMatrix.ok) {
        console.log('  the source has no comparable sample matrix: ' + redact(sourceMatrix.error));
      }

      console.log('\n  ---- written as SEG-2 ----');
      let written;
      try {
        written = writeSEG2(pd);
      } catch (e) {
        console.log('    the writer refused: ' + redact(e && e.message ? e.message : String(e)));
        console.log('    (a writer refusing loudly is not a conformance failure; nothing was produced to check)');
        written = null;
      }
      if (written) {
        const buf = Buffer.from(written.buffer, written.byteOffset, written.byteLength);
        const outPath = join(tmp, 'w.seg2');
        writeFileSync(outPath, buf);
        guard(outPath);
        console.log('    wrote ' + statSync(outPath).size + ' bytes');

        // -------- layer a: structure ----------------------------------
        const layout = resolveSeg2Layout(buf);
        console.log('    declared: block id ' + hex4(buf, 0) + ' (' +
          (layout.le === null ? 'no byte order' : layout.le ? 'low byte first' : 'low byte last') +
          '), revision ' + layout.revision + ', trace pointer subblock ' + layout.M + ' bytes, ' +
          layout.N + ' trace(s), ' + layout.tdbs.length + ' trace descriptor block(s) resolved');
        if (!layout.ok) {
          console.log('    the declared layout does NOT close: ' + layout.why);
          if (layout.le !== null) {
            const other = resolveSeg2Layout(buf, !layout.le);
            if (other.ok) {
              console.log('    but it DOES close read ' + (other.le ? 'low byte last' : 'low byte first') +
                ' - ' + other.N + ' trace(s), subblock ' + other.M + ' bytes - so the byte-order mark and the integers disagree');
            }
          }
        }

        // -------- layer b: the cited rule table ------------------------
        const applicable = RULES_SEG2.rules.filter((r) => r.appliesTo.includes('1'));
        const verdicts = applicable.map((r) => applySeg2Rule(r, { buf, layout }));
        const applied = printVerdicts(verdicts, tally);
        rulesAppliedSeg2 += applied;
        perRevisionApplied['SEG-2'] = (perRevisionApplied['SEG-2'] || 0) + applied;
        console.log('    rules applied for SEG-2: ' + applied + ' of ' + applicable.length +
          ' (' + (applicable.length - applied) + ' not evaluable on this file)');

        // -------- layer c: independent read of the WRITTEN file --------
        if (!dockerObspy.usable) {
          console.log('    independent read: NOT RUN (no container) - ' + IMAGE_OBSPY);
          noCrossCheck++;
        } else if (!sourceMatrix.ok) {
          console.log('    independent read: NO CROSS-CHECK - the source has no comparable sample matrix');
          noCrossCheck++;
        } else {
          const got = oracleJson(runImage(outPath, IMAGE_OBSPY, '/data/input.bin', ['seg2']));
          if (!got.ok) {
            console.log('    independent read: NO CROSS-CHECK - ObsPy could not read the WRITTEN file: ' + got.why);
            noCrossCheck++;
          } else {
            const nBad = compareMatrix(sourceMatrix, got.json, 'ObsPy');
            if (got.json.free_form_keys) {
              console.log('    ObsPy read these free-form KEY NAMES back (values are never printed): ' +
                (got.json.free_form_keys.length ? got.json.free_form_keys.join(', ') : 'none'));
            }
            if (nBad === 0) {
              console.log('    independent read: AGREE - ObsPy decoded the written SEG-2 to the same sample matrix as the source (SHA-256 ' + got.json.sample_matrix_sha256 + ')');
              crossChecked++;
            } else {
              console.log('    independent read: DISAGREE - ' + nBad + ' compared field(s) differ.');
              crossDisagreed++;
            }
          }
        }
      }

      // ---- the same source, written as Seismic Unix ---------------------
      const suOut = emitSu(pd, tmp, 'F');
      if (suOut) {
        const r = runSuChecks(suOut, sourceMatrix, dockerObspy, tally, perRevisionApplied);
        rulesAppliedSu += r.applied;
        crossChecked += r.agreed;
        crossDisagreed += r.disagreed;
        noCrossCheck += r.noCrossCheck;
      }
    }

    // ============================================================ SEG-D
    // Same two layers, no third one. writeSEGD is imported and called; nothing
    // here re-implements any part of it, and nothing here may "fix" a failure.
    for (const f of liveSegd) {
      console.log('\n' + '='.repeat(78) + '\n' + f.label + '  -  ' + f.why + '\n' + '='.repeat(78));

      let pd;
      try {
        pd = parseSEGD(new Uint8Array(readFileSync(f.path)));
      } catch (e) {
        console.log('  the parser could not read the source: ' + redact(e && e.message ? e.message : String(e)));
        tally.mandatoryFailures++;
        continue;
      }
      if (!pd.traces || pd.traces.length === 0) {
        console.log('  the parser returned no traces for this source; nothing to write.');
        continue;
      }
      console.log('  source parsed: ' + pd.traces.length + ' trace(s), SEG-D rev ' + (pd.revision || 0) +
        ', sample interval ' + (pd.bh && pd.bh.sampleInt) + ' us' +
        (pd.errors && pd.errors.length ? ', parser notes: ' + redact(pd.errors.join('; ')) : ''));

      // The source-side sample matrix, under the contract in qa/oracle/hash.mjs
      // that qa/oracle/ours.mjs applies to SEG-Y. Computed once per fixture and
      // compared against BOTH written revisions.
      const sourceMatrix = matrixOf(pd, 'seisconv core/formats/segd.ts');
      if (!sourceMatrix.ok) {
        console.log('  the source has no comparable sample matrix: ' + redact(sourceMatrix.error));
      }

      for (const rev of WRITTEN_REVISIONS_SEGD) {
        console.log('\n  ---- written as ' + rev.label + ' ----');

        let written;
        try {
          written = writeSEGD(pd, rev.arg);
        } catch (e) {
          console.log('    the writer refused: ' + redact(e && e.message ? e.message : String(e)));
          console.log('    (a writer refusing loudly is not a conformance failure; nothing was produced to check)');
          continue;
        }
        const buf = Buffer.from(written.buffer, written.byteOffset, written.byteLength);
        const outPath = join(tmp, 'w' + (rev.arg ? 3 : 1) + '.segd');
        writeFileSync(outPath, buf);
        guard(outPath);
        console.log('    wrote ' + statSync(outPath).size + ' bytes');

        // -------- layer a: structure ------------------------------------
        const layout = resolveSegdLayout(buf, rev.declared);
        console.log('    declared: revision ' + buf[42] + '.' + buf[43] + ', format code ' + hex4(buf, 2) +
          ', ' + (layout.generalHeaderBlocks === undefined ? '?' : layout.generalHeaderBlocks) + ' general header block(s), ' +
          (layout.csds ? layout.csds.length : 0) + ' channel set descriptor(s) of ' + (layout.csdSize || '?') + ' bytes, ' +
          (layout.traces ? layout.traces.length : 0) + ' trace(s)');
        if (!layout.ok) console.log('    the declared layout does NOT close: ' + layout.why);

        // -------- layer b: the cited rule table -------------------------
        const applicable = RULES_SEGD.rules.filter((r) => r.appliesTo.includes(rev.declared));
        const ctx = { buf, layout, declaredRev: rev.declared };
        const verdicts = applicable.map((r) => applySegdRule(r, ctx));
        const applied = printVerdicts(verdicts, tally);
        rulesAppliedSegd += applied;
        perRevisionApplied[rev.label] = (perRevisionApplied[rev.label] || 0) + applied;
        console.log('    rules applied for ' + rev.label + ': ' + applied + ' of ' + applicable.length +
          ' (' + (applicable.length - applied) + ' not evaluable on this file)');

        // -------- layer c: independent read of the WRITTEN file ---------
        // This layer used to print "NO READER EXISTS". That was wrong: sedaman
        // reads SEG-D Rev 1, 2 and 3, which covers both revisions writeSEGD
        // emits. It has NOT been run - the daemon was down when it was wired -
        // so what prints below without a container is NOT RUN, which is the
        // same thing SEG-Y prints and is not agreement.
        if (!dockerSegd.usable) {
          console.log('    independent read: NOT RUN (no container) - ' + IMAGE_SEGD);
          noCrossCheck++;
        } else if (!sourceMatrix.ok) {
          console.log('    independent read: NO CROSS-CHECK - the source has no comparable sample matrix');
          noCrossCheck++;
        } else {
          const got = oracleJson(runImage(outPath, IMAGE_SEGD, '/data/input.sgd'));
          if (!got.ok) {
            console.log('    independent read: NO CROSS-CHECK - sedaman could not read the WRITTEN file: ' + got.why);
            noCrossCheck++;
          } else {
            let nBad = compareMatrix(sourceMatrix, got.json, 'sedaman');
            // The declared revision is asserted about the WRITTEN file rather
            // than carried from the source: a Rev 1 source written as Rev 3
            // legitimately changes it, which is the whole point of writing both.
            //
            // A field the READER did not expose is reported as a note and NOT
            // counted. sedaman's field names are not a published API, so a name
            // that moved between commits comes back null; counting that as a
            // disagreement would print "SeisConv disagrees with sedaman" and
            // exit 1 over a binding quirk. Same treatment sample_interval_us
            // already gets in compareMatrix.
            const wantRev = rev.arg ? 3 : 1;
            const gotRev = got.json.revision_major;
            if (gotRev === null || gotRev === undefined) {
              console.log('    note  written.revision_major expected=' + wantRev +
                '  sedaman did not expose it (not counted)');
            } else {
              const sameRev = gotRev === wantRev;
              if (!sameRev) nBad++;
              console.log('    ' + (sameRev ? 'ok  ' : 'DIFF') + '  written.revision_major expected=' +
                wantRev + '  sedaman read=' + JSON.stringify(gotRev));
            }
            if (nBad === 0) {
              console.log('    independent read: AGREE - sedaman decoded the written file to the same sample matrix as the source (SHA-256 ' + got.json.sample_matrix_sha256 + ')');
              crossChecked++;
            } else {
              console.log('    independent read: DISAGREE - ' + nBad + ' compared field(s) differ.');
              crossDisagreed++;
            }
          }
        }
      }
    }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* the temp directory is the OS's problem after this */
    }
  }

  const perRev = (prefix) => Object.entries(perRevisionApplied)
    .filter(([k]) => k.startsWith(prefix)).map(([k, v]) => k + ' ' + v).join(', ');

  const totalRules = rulesApplied + rulesAppliedSegd + rulesAppliedSeg2 + rulesAppliedSu;

  console.log('\n' + '='.repeat(78));
  console.log('RESULT');
  console.log('  cited rules applied      : ' + totalRules);
  console.log('    SEG-Y                  : ' + rulesApplied + '  ' + perRev('SEG-Y') +
    '   (independent read: segyio in qa/oracle)');
  console.log('    SEG-D                  : ' + rulesAppliedSegd + '  ' + perRev('SEG-D') +
    '   (independent read: sedaman in qa/oracle/segd)');
  console.log('    SEG-2                  : ' + rulesAppliedSeg2 + '  ' + perRev('SEG-2') +
    '   (independent read: ObsPy in qa/oracle/obspy)');
  console.log('    SU                     : ' + rulesAppliedSu + '  ' + perRev('SU') +
    '   (independent read: ObsPy in qa/oracle/obspy; the rule table is weak here on purpose, see rules.su.json _authority)');
  console.log('  mandatory rule failures  : ' + tally.mandatoryFailures);
  console.log('  recommended failures     : ' + tally.recommendedFailures + '  (reported, never fatal)');
  console.log('  inconclusive             : ' + tally.inconclusive);
  console.log('  independent read agreed  : ' + crossChecked);
  console.log('  independent read differed: ' + crossDisagreed);
  console.log('  not cross-checkable      : ' + noCrossCheck + '  (written files no container read: image missing, daemon down, or the reader refused the file)');
  console.log('  fixtures                 : ' + (live.length + liveSegd.length + liveSeg2.length) + ' run, ' +
    ((fixtures.length - live.length) + (segdFixtures.length - liveSegd.length) + (seg2Fixtures.length - liveSeg2.length)) + ' skipped');
  if (tally.mandatoryFailures === 0 && crossDisagreed === 0) {
    console.log('\n  Conformed against ' + totalRules + ' cited rules. That is what this says, and all it says:');
    console.log('  it is not a certificate, and it covers only the rules in qa/conform/rules.segy.json,');
    console.log('  rules.segd.json, rules.seg2.json and rules.su.json. Where the independent-read line above');
    console.log('  says NOT RUN, no second implementation read those bytes at all.');
  }

  if (tally.mandatoryFailures > 0 || crossDisagreed > 0) return 1;
  if (missing.length > 0) return 2;
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(redact(e && e.stack ? e.stack : String(e)));
  process.exitCode = 3;
}
