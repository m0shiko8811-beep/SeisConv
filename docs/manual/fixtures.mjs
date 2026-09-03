// docs/manual/fixtures.mjs - DETERMINISTIC synthetic data for the manual screenshots.
//
//   node docs/manual/fixtures.mjs [outDir]     write the fixture set and print the paths
//   import { buildFixtures } from './fixtures.mjs'
//
// WHY THIS EXISTS, AND THE ONE RULE IT ENFORCES
// --------------------------------------------
// Every picture in the user manual is captured by driving the built app (docs/manual/shots.mjs).
// The data those pictures show must NEVER be a real survey: a screenshot published a real
// survey georeferenced to the metre once already. So the manual's data is generated here,
// from a FIXED SEED, at an obviously artificial origin:
//
//     easting 500000, northing 4000000, UTM zone 36N (EPSG:32636)
//
// and with obviously artificial names (SYNTH_*). Same seed in, same bytes out, so a
// screenshot regenerated for the next release shows the same numbers as the one before it
// and a diff of the picture set is meaningful.
//
// WHAT IT WRITES
//   SYNTH_LINE1_101.sgy / _102 / _103   SEG-Y Rev 1, written byte by byte (no core import):
//                                       big-endian, IEEE float (format code 5), 96 traces of
//                                       1000 samples at 2 ms, split-spread geometry with
//                                       three NMO reflectors, ground roll and seeded noise.
//   SYNTH_SURVEY.s01 / .r01 / .x01      SPS 2.1 fixed-column triplet: a small orthogonal 3D
//                                       patch - 4 receiver lines of 48 stations and 3 source
//                                       lines of 6 shots - with an H-record block describing
//                                       UTM 36N. Deliberately 3D, not a single straight line:
//                                       a 2D line makes the map, the X-ref spider and the fold
//                                       raster all degenerate, and a picture of a degenerate
//                                       case teaches nothing.
//   SYNTH_PLAN.csv                      A survey plan pre-plot for the plan import wizard
//                                       (line, station, easting, northing, elevation).
//
// Pure Node ESM on purpose: shots.mjs imports it directly, with no build step and no
// dependency on core/, so the fixture set cannot drift with a core refactor mid-release.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------- constants
/** Artificial survey origin. NOT a real site - see the header comment. */
export const ORIGIN = { east: 500000, north: 4000000, epsg: 32636, zone: 36, hemi: 'N' };
/** Fixed seed: the whole fixture set is a pure function of this number. */
export const SEED = 0x5e15c0;

const N_CH = 96;           // channels in one shot record (the SEG-Y spread)
const RCV_INT = 25;        // m, receiver station interval along a receiver line
const SRC_INT = 100;       // m, source station interval along a source line
const RCV_LINES = 4;       // receiver lines, running E-W
const RCV_PER_LINE = 48;   // stations on each receiver line
const RCV_LINE_SP = 200;   // m between receiver lines
const SRC_LINES = 3;       // source lines, running N-S
const SRC_PER_LINE = 6;    // shots on each source line
const SRC_LINE_SP = 400;   // m between source lines
const NS = 1000;           // samples per trace
const DT_US = 2000;        // 2 ms
const FFIDS = [101, 102, 103];

// ---------------------------------------------------------------- seeded RNG
/** mulberry32 - small, fast, and exactly reproducible across Node versions. */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- SEG-Y bytes
const A2E = buildAsciiToEbcdic();
/** IBM cp037 EBCDIC table for the printable ASCII range - the textual header is
 *  EBCDIC in a conforming SEG-Y file, and SeisConv displays it decoded. */
function buildAsciiToEbcdic() {
  const m = new Uint8Array(128).fill(0x40); // default: EBCDIC space
  const put = (s, start) => { for (let i = 0; i < s.length; i++) m[s.charCodeAt(i)] = start + i; };
  put('abcdefghi', 0x81); put('jklmnopqr', 0x91); put('stuvwxyz', 0xa2);
  put('ABCDEFGHI', 0xc1); put('JKLMNOPQR', 0xd1); put('STUVWXYZ', 0xe2);
  put('0123456789', 0xf0);
  const pairs = { ' ': 0x40, '.': 0x4b, '<': 0x4c, '(': 0x4d, '+': 0x4e, '|': 0x4f, '&': 0x50,
    '!': 0x5a, '$': 0x5b, '*': 0x5c, ')': 0x5d, ';': 0x5e, '-': 0x60, '/': 0x61, ',': 0x6b,
    '%': 0x6c, '_': 0x6d, '>': 0x6e, '?': 0x6f, ':': 0x7a, '#': 0x7b, '@': 0x7c, "'": 0x7d,
    '=': 0x7e, '"': 0x7f };
  for (const k of Object.keys(pairs)) m[k.charCodeAt(0)] = pairs[k];
  return m;
}

/** The 3200-byte EBCDIC textual header: 40 lines of 80 columns, "C 1".."C40". */
function textualHeader(lines) {
  const buf = Buffer.alloc(3200, 0x40);
  for (let i = 0; i < 40; i++) {
    const tag = 'C' + String(i + 1).padStart(2, ' ') + ' ';
    const text = (tag + (lines[i] || '')).slice(0, 80).padEnd(80, ' ');
    for (let c = 0; c < 80; c++) buf[i * 80 + c] = A2E[text.charCodeAt(c) & 0x7f];
  }
  return buf;
}

/**
 * One synthetic shot record. Split spread: channel 1..96 straddles the source, so
 * the section shows a symmetric direct arrival and three hyperbolic reflectors -
 * a picture that actually teaches something, which an empty or flat panel does not.
 */
function shotTraces(ffid, rand) {
  const dt = DT_US / 1e6;
  const refl = [{ t0: 0.22, v: 1800 }, { t0: 0.46, v: 2400 }, { t0: 0.78, v: 3000 }];
  const ricker = (t, f) => { const x = Math.PI * f * t; return (1 - 2 * x * x) * Math.exp(-x * x); };
  const out = [];
  for (let ch = 1; ch <= N_CH; ch++) {
    const off = (ch - (N_CH + 1) / 2) * RCV_INT;
    const aoff = Math.abs(off);
    const s = new Float32Array(NS);
    for (let i = 0; i < NS; i++) {
      const t = i * dt;
      let v = 0;
      // direct arrival (1600 m/s), tapering with offset
      v += 1.4 * ricker(t - aoff / 1600, 45) * Math.exp(-aoff / 700);
      // ground roll: slow, low frequency, strong near offsets
      v += 0.9 * ricker(t - aoff / 420, 9) * Math.exp(-aoff / 900);
      // three NMO reflectors
      for (let k = 0; k < refl.length; k++) {
        const { t0, v: vel } = refl[k];
        const tt = Math.sqrt(t0 * t0 + (off * off) / (vel * vel));
        v += (0.85 - 0.15 * k) * ricker(t - tt, 30 - 5 * k);
      }
      // spherical divergence + seeded band-limited noise
      v *= 1 / (1 + 2.2 * t);
      v += 0.022 * (rand() - 0.5);
      s[i] = v * 1000;
    }
    out.push({ ch, off, samples: s });
  }
  return out;
}

/** Write one SEG-Y Rev 1 file, byte by byte, big-endian, format code 5 (IEEE float). */
function writeSegy(path, ffid, srcE, srcN, rand) {
  const traces = shotTraces(ffid, rand);
  const txt = textualHeader([
    'SEISCONV USER MANUAL - SYNTHETIC DEMONSTRATION DATA',
    'THIS FILE CONTAINS NO REAL SURVEY. SEE DOCS/MANUAL/FIXTURES.MJS',
    'CLIENT      : EXAMPLE CLIENT',
    'AREA        : SYNTHETIC TEST AREA',
    'LINE        : SYNTH-LINE-1',
    `FIELD RECORD: ${ffid}`,
    'GEOMETRY    : SPLIT SPREAD, 96 CHANNELS, 25 M GROUP INTERVAL',
    `SAMPLES     : ${NS} AT ${DT_US / 1000} MS`,
    'FORMAT      : SEG-Y REVISION 1, IEEE FLOAT (CODE 5), BIG ENDIAN',
    'CRS         : UTM ZONE 36N (EPSG:32636), ARTIFICIAL ORIGIN 500000E 4000000N',
  ]);
  const bin = Buffer.alloc(400, 0);
  bin.writeInt32BE(1, 0);              // 3201-3204 job id
  bin.writeInt32BE(1, 4);              // line number
  bin.writeInt32BE(1, 8);              // reel number
  bin.writeInt16BE(N_CH, 12);         // 3213 traces per ensemble
  bin.writeInt16BE(DT_US, 16);         // 3217 sample interval (us)
  bin.writeInt16BE(DT_US, 18);         // 3219 sample interval, original
  bin.writeInt16BE(NS, 20);            // 3221 samples per trace
  bin.writeInt16BE(NS, 22);            // 3223 samples per trace, original
  bin.writeInt16BE(5, 24);             // 3225 data sample format = IEEE float
  bin.writeInt16BE(1, 28);             // 3229 trace sorting = as recorded
  bin.writeInt16BE(1, 54);             // 3255 measurement system = metres
  bin.writeUInt16BE(0x0100, 300);      // 3501 SEG-Y revision 1.0
  bin.writeInt16BE(1, 302);            // 3503 fixed length trace flag
  bin.writeInt16BE(0, 304);            // 3505 extended textual headers

  const parts = [txt, bin];
  for (const t of traces) {
    const h = Buffer.alloc(240, 0);
    h.writeInt32BE(t.ch, 0);                       //   1 trace seq in line
    h.writeInt32BE(t.ch, 4);                       //   5 trace seq in file
    h.writeInt32BE(ffid, 8);                       //   9 original field record
    h.writeInt32BE(t.ch, 12);                      //  13 trace number in field record
    h.writeInt32BE(ffid, 16);                      //  17 energy source point
    h.writeInt32BE(ffid * 1000 + t.ch, 20);        //  21 ensemble (CDP)
    h.writeInt32BE(t.ch, 24);                      //  25 trace no. within ensemble
    h.writeInt16BE(1, 28);                         //  29 trace id = seismic data
    h.writeInt32BE(Math.round(t.off), 36);         //  37 source-receiver offset
    h.writeInt32BE(120, 40);                       //  41 receiver group elevation
    h.writeInt32BE(122, 44);                       //  45 surface elevation at source
    h.writeInt32BE(2, 48);                         //  49 source depth below surface
    h.writeInt16BE(1, 68);                         //  69 elevation scalar
    h.writeInt16BE(1, 70);                         //  71 coordinate scalar
    h.writeInt32BE(Math.round(srcE), 72);          //  73 source X
    h.writeInt32BE(Math.round(srcN), 76);          //  77 source Y
    h.writeInt32BE(Math.round(ORIGIN.east + (t.ch - 1) * RCV_INT), 80); //  81 group X
    h.writeInt32BE(Math.round(srcN), 84);              //  85 group Y
    h.writeInt16BE(1, 88);                         //  89 coordinate units = length
    h.writeUInt16BE(NS, 114);                      // 115 samples in this trace
    h.writeUInt16BE(DT_US, 116);                   // 117 sample interval
    h.writeInt16BE(2026, 156);                     // 157 year
    h.writeInt16BE(60, 158);                       // 159 day of year
    h.writeInt16BE(9, 160);                        // 161 hour
    h.writeInt16BE(30, 162);                       // 163 minute
    h.writeInt16BE((ffid - 100) * 5, 164);         // 165 second
    h.writeInt16BE(1, 166);                        // 167 time basis = local
    const d = Buffer.alloc(NS * 4);
    for (let i = 0; i < NS; i++) d.writeFloatBE(t.samples[i], i * 4);
    parts.push(h, d);
  }
  writeFileSync(path, Buffer.concat(parts));
  return path;
}

// ---------------------------------------------------------------- SPS 2.1 text
// Fixed columns, mirroring core/sps/write.ts (which mirrors core/sps/parse.ts):
// S/R  id col 0 | line 1..11 | point 11..21 | idx col 23 | E 46..55 | N 55..65 | elev 65..71
// X    id col 0 | tape 1..7 | ffid 7..15 | srcLine 17..27 | srcPt 27..37 | srcIdx 37
//      fromCh 38..43 | toCh 43..48 | chIncr 48 | rcvLine 49..59 | rcvPtFrom 59..69
//      rcvPtTo 69..79 | rcvIdx 79
function col(width) { return (v) => String(v).padStart(width).slice(-width); }
function place(buf, start, txt) { for (let i = 0; i < txt.length && start + i < buf.length; i++) buf[start + i] = txt[i]; }
function srLine(rtype, lineName, point, east, north, elev) {
  const b = new Array(80).fill(' ');
  b[0] = rtype;
  place(b, 1, col(10)(lineName));
  place(b, 11, col(10)(point));
  b[23] = '1';
  place(b, 46, col(9)(east.toFixed(1)));
  place(b, 55, col(10)(north.toFixed(1)));
  place(b, 65, col(6)(elev.toFixed(1)));
  return b.join('').replace(/\s+$/, '');
}
function xLine(ffid, srcLine, srcPt, fromCh, toCh, rcvLine, rcvFrom, rcvTo) {
  const b = new Array(80).fill(' ');
  b[0] = 'X';
  place(b, 1, col(6)('SYNTH'));
  place(b, 7, col(8)(ffid));
  place(b, 17, col(10)(srcLine));
  place(b, 27, col(10)(srcPt));
  b[37] = '1';
  place(b, 38, col(5)(fromCh));
  place(b, 43, col(5)(toCh));
  b[48] = '1';
  place(b, 49, col(10)(rcvLine));
  place(b, 59, col(10)(rcvFrom));
  place(b, 69, col(10)(rcvTo));
  b[79] = '1';
  return b.join('').replace(/\s+$/, '');
}
/** H-record: 4-char code, description in cols 4..32, value from col 32. */
function hLine(code, desc, val) {
  const b = new Array(80).fill(' ');
  place(b, 0, code.padEnd(4).slice(0, 4));
  place(b, 4, String(desc).slice(0, 27));
  place(b, 32, String(val).slice(0, 48));
  return b.join('').replace(/\s+$/, '');
}
function spsHeaders(kind) {
  const cm = ORIGIN.zone * 6 - 183;
  return [
    hLine('H00', 'SPS format version', 'SPS 2.1'),
    hLine('H01', 'Survey area', 'SYNTHETIC TEST AREA'),
    hLine('H02', 'Date of issue', '2026-03-01'),
    hLine('H03', 'Client', 'EXAMPLE CLIENT'),
    hLine('H04', 'Geophysical contractor', 'EXAMPLE CONTRACTOR'),
    hLine('H05', 'File type', kind),
    hLine('H12', 'Geodetic datum', 'WGS84 6378137.0 298.257223563'),
    hLine('H18', 'Map projection', 'UTM'),
    hLine('H19', 'Projection zone', `Zone ${ORIGIN.zone}, North`),
    hLine('H20', 'Grid units', 'meters'),
    hLine('H220', 'Central meridian', `${cm} 00 00.00 E`),
    hLine('H231', 'Latitude of origin', '0 00 00.00 N'),
    hLine('H232', 'Grid coord. at origin', '500000.00 0.00'),
    hLine('H241', 'Scale factor', '0.9996'),
    hLine('H26', 'Bearing reference', 'GRID NORTH'),
    hLine('H31', 'Receiver line interval', String(RCV_LINE_SP)),
    hLine('H32', 'Source line interval', String(SRC_LINE_SP)),
    hLine('H33', 'Receiver station interval', String(RCV_INT)),
    hLine('H34', 'Source station interval', String(SRC_INT)),
    hLine('H99', 'Note', 'SYNTHETIC DATA - NOT A REAL SURVEY'),
  ];
}

/** Ground elevation, a smooth deterministic ridge - gives the elevation raster and
 *  the profile plots something with shape rather than a flat plane. */
function elevAt(x, y = 0) { return 110 + 18 * Math.sin(x / 900) + 7 * Math.cos(x / 310) + 9 * Math.sin(y / 500); }

const CRLF = String.fromCharCode(13, 10); // SPS files are CRLF-terminated
function buildSps(dir, rand) {
  const jitter = () => 0.3 * (rand() - 0.5); // seeded, tiny: real stations are never exact
  // Receiver lines run E-W; source lines run N-S across them. Small enough to read on
  // one page, orthogonal enough that fold, the spider and the layout raster all mean something.
  const rcv = [];
  for (let l = 0; l < RCV_LINES; l++) {
    const y = l * RCV_LINE_SP;
    for (let i = 0; i < RCV_PER_LINE; i++) {
      const x = i * RCV_INT;
      rcv.push({ line: String(1000 + l * 10), pt: 1 + i, e: ORIGIN.east + x, n: ORIGIN.north + y, z: elevAt(x, y) + jitter() });
    }
  }
  const src = [];
  for (let l = 0; l < SRC_LINES; l++) {
    const x = 150 + l * SRC_LINE_SP;
    for (let i = 0; i < SRC_PER_LINE; i++) {
      const y = i * SRC_INT;
      src.push({ line: String(2000 + l), pt: 101 + i, e: ORIGIN.east + x, n: ORIGIN.north + y, z: elevAt(x, y) + jitter(), yIdx: i, lIdx: l });
    }
  }
  // Live spread: each shot records the TWO receiver lines nearest to it, 48 channels
  // each. That is what makes the X-ref spider a fan instead of a straight line.
  const xs = [];
  src.forEach((p, k) => {
    const nearest = Math.max(0, Math.min(RCV_LINES - 2, Math.round((p.n - ORIGIN.north) / RCV_LINE_SP) - 1));
    for (let j = 0; j < 2; j++) {
      const rl = String(1000 + (nearest + j) * 10);
      xs.push(xLine(101 + k, p.line, p.pt, 1 + j * RCV_PER_LINE, (j + 1) * RCV_PER_LINE, rl, 1, RCV_PER_LINE));
    }
  });
  const sTxt = [...spsHeaders('SOURCE'), ...src.map((p) => srLine('S', p.line, p.pt, p.e, p.n, p.z))].join(CRLF) + CRLF;
  const rTxt = [...spsHeaders('RECEIVER'), ...rcv.map((p) => srLine('R', p.line, p.pt, p.e, p.n, p.z))].join(CRLF) + CRLF;
  const xTxt = [...spsHeaders('RELATION'), ...xs].join(CRLF) + CRLF;
  const paths = {
    s: join(dir, 'SYNTH_SURVEY.s01'),
    r: join(dir, 'SYNTH_SURVEY.r01'),
    x: join(dir, 'SYNTH_SURVEY.x01'),
  };
  writeFileSync(paths.s, sTxt, 'ascii');
  writeFileSync(paths.r, rTxt, 'ascii');
  writeFileSync(paths.x, xTxt, 'ascii');
  return { paths, rcv, src, xs };
}

/** The pre-plot CSV the survey-plan import wizard reads (projected E/N + EPSG tag). */
function buildPlanCsv(dir) {
  const rows = ['# SYNTHETIC PRE-PLOT - NOT A REAL SURVEY - EPSG:32636'];
  rows.push('line,station,easting,northing,elevation');
  for (let i = 0; i < 40; i++) {
    const x = i * 50;
    rows.push(`1000,${1 + i},${(ORIGIN.east + x).toFixed(1)},${(ORIGIN.north + 0.4 * x).toFixed(1)},${elevAt(x, 0.4 * x).toFixed(1)}`);
  }
  for (let i = 0; i < 25; i++) {
    const y = i * 50;
    rows.push(`1010,${1 + i},${(ORIGIN.east + 1200).toFixed(1)},${(ORIGIN.north + 480 + y).toFixed(1)},${elevAt(1200, 480 + y).toFixed(1)}`);
  }
  const p = join(dir, 'SYNTH_PLAN.csv');
  writeFileSync(p, rows.join('\r\n') + '\r\n', 'ascii');
  return p;
}

// ---------------------------------------------------------------- entry point
/**
 * Generate the whole fixture set into `dir` (default: a stable folder under the OS
 * temp dir, so the fixtures are never committed and never sit beside real data).
 * Returns every path the screenshot driver needs.
 */
export function buildFixtures(dir = join(tmpdir(), 'seisconv-manual-fixtures')) {
  mkdirSync(dir, { recursive: true });
  const rand = rng(SEED); // ONE stream, consumed in a fixed order -> reproducible
  const segy = FFIDS.map((ffid, i) =>
    writeSegy(join(dir, `SYNTH_LINE1_${ffid}.sgy`), ffid,
      ORIGIN.east + 150 + i * SRC_INT, ORIGIN.north + i * SRC_INT, rand));
  const sps = buildSps(dir, rand);
  const plan = buildPlanCsv(dir);
  return {
    dir, segy, segy1: segy[0],
    sps: [sps.paths.s, sps.paths.r, sps.paths.x],
    plan, origin: ORIGIN, seed: SEED,
    counts: {
      traces: N_CH, samples: NS, dtMs: DT_US / 1000,
      sources: SRC_LINES * SRC_PER_LINE, receivers: RCV_LINES * RCV_PER_LINE,
      xrefs: SRC_LINES * SRC_PER_LINE * 2,
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('fixtures.mjs')) {
  const f = buildFixtures(process.argv[2]);
  console.log(JSON.stringify(f, null, 2));
}
