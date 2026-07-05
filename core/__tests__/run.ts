// seisconv-core — self-contained test runner
//
// No test framework: uses only Node built-ins (node:fs, node:assert) so it runs
// under `npx tsx` (or any TS runner) without installing project dependencies.
//
//   npx --yes tsx core/__tests__/run.ts        (from the repo root)
//
// Validates the ported parsers/writers/coords against the real sample data in
// the directory pointed to by SEISCONV_DATA (round-trip invariants + golden-value print).

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  parseAny,
  parseSEGY,
  parseSegyMeta,
  decodeSegyTrace,
  parseSU,
  parseSEG2,
  parseSEGD,
  parseTpimage,
  writeSEGY,
  writeSU,
  writeSEG2,
  writeSEGD,
  writeTapeImage,
  writeTapeImageMulti,
  writeCSV,
  detect,
  detectEx,
  isIX1SegdTape,
  latLonToUTM,
  utmToLatLon,
  latLonToITM,
  itmToLatLon,
  parseWithRegistry,
  listWriters,
  resampleLinear,
  resampleToInterval,
  applyAGC,
  getColor,
  colorSeismic,
  maxAbs,
  normFactorPercentile,
  decimateMinMax,
  parseSPSText,
  detectSPSType,
  parseSegP1,
  runSPSQC,
  checkGeometry,
  loadGeometry,
  encodeScalar,
  compareSPS,
  applyScalar,
  reprojectSPS,
  buildSPS,
  buildRenumberMaps,
  applyRenumberToData,
  renumberSPSText,
  generateSPS,
  CREATE_DEFAULTS,
  EPSG_DB,
  searchEPSG,
  crsFromSpec,
  lonLatToProj,
  projToLatLon,
  computeSemblance,
  pickSTALTA,
  pickFirstBreaks,
  assistFirstBreaks,
  median,
  mad,
  madZScore,
  localMedianMAD,
  scanTraceHealth,
  classifyTrace,
  thresholdsForSensitivity,
  defaultThresholds,
  readEvidence,
  writeEvidence,
  EVIDENCE_STRIDE,
  fft,
  amplitudeSpectrum,
  nextPow2,
  generateSweep,
  generateSweepAtRate,
  validateSweepSpec,
  klauderAnalysis,
  thdEstimate,
  buildSVText,
  parseSVText,
  instantaneousPhase,
  wrapDeg180,
  DEFAULT_SWEEP_SPEC,
  SV_RATE_HZ,
  rIEEE,
  parseP611,
  parsePositioning,
  parseCoordCsv,
  buildCoordCsv,
  parseP111,
  buildP111,
  detectPositioningFormat,
  parseTriggerLine,
  parseUdpTrigger,
  parseScsLogLine,
  scsLogKey,
  isScsTrigTouch,
  scsTrigCollapse,
  SCS_TRIG_WINDOW_MS,
  TRIGGER_TEXT_MAX,
  nextSP,
  nextFile,
  renumberBelow,
  TRIGGER_SYSTEMS,
  DEFAULT_TRIG_SYSTEM,
  resolveTrigSystem,
  migrateTrigSystemId,
  isTrigSystemId,
  geodeFileMode,
  geodeFileSyncId,
  GEODE_FILE_SYNC_MODES,
  buildXlsx,
  type SheetTable,
} from '../index';
import { bytesToBase64, base64ToBytes } from '../base64';
import JSZip from 'jszip';
import type { ParsedFile, SPSData, SPSPoint, Trace, TraceGeom } from '../index';
import {
  // WiFiSync pure port (core/field)
  computeDiff,
  applyEmptyManifestGuard,
  safeJoin,
  validateRelPath,
  PathEscapeError,
  RateLimiter,
  encodeBeacon,
  decodeBeacon,
  sameSubnet,
  encodeManifestResponse,
  decodeManifestResponse,
  encodeFileRequest,
  decodeFileRequest,
  encodeFileResponseHeader,
  decodeFileResponseHeader,
  manifestToJson,
  manifestFromJson,
  buildManifestFromEntries,
  mergeManifest,
  hasLiveRecord,
  tombstonesToRecords,
  addTombstoneEntry,
  removeTombstoneEntry,
  complementRole,
  roleToByte,
  byteToRole,
  MTIME_TOLERANCE,
  TCP_FILE_PORT,
  MAGIC,
  type FileRecord,
  type Manifest,
} from '../index';

const DATA = process.env.SEISCONV_DATA || '';
if (!DATA) { console.warn('SEISCONV_DATA not set — file-backed tests will be skipped (unit-only mode).'); }
const SEGY = `${DATA}/00000186_SegY_Rev2.segy`;
const GEODE = `${DATA}/1006.dat`;
const BATCH_DIR = `${DATA}/Raw Original Data/GP_393_26_SegY`;

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(e as Error).message}`);
  }
}

function skip(name: string, why: string): void {
  skipped++;
  console.log(`  ⊘ ${name}  (skipped: ${why})`);
}

/** Async variant of test() — awaits the body so Promise-returning checks tally. */
async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${(e as Error).message}`);
  }
}

function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/** Compare two Float32Arrays for exact equality over the first `n` samples. */
function samplesEqual(a: Float32Array | null, b: Float32Array | null, n: number): boolean {
  if (!a || !b) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log('\nseisconv-core test run\n----------------------');

// ── SEG-Y ──────────────────────────────────────────────────────────────────
console.log('\n[SEG-Y]');
if (existsSync(SEGY)) {
  const bytes = readBytes(SEGY);

  test('detect() identifies SEG-Y', () => {
    assert.equal(detect(bytes, '00000186_SegY_Rev2.segy'), 'SEG-Y');
  });

  const pf = parseSEGY(bytes);
  console.log(
    `      golden: revision=${pf.revision} traceCount=${pf.traceCount} ` +
      `samplesTrace=${pf.bh.samplesTrace} sampleInt=${pf.bh.sampleInt}us dataFmt=${pf.bh.dataFmt}`,
  );

  test('parses traces with no errors', () => {
    assert.equal(pf.errors.length, 0, `errors: ${pf.errors.join('; ')}`);
    assert.ok(pf.traceCount > 0, 'expected > 0 traces');
  });

  test('first trace sample count matches header', () => {
    const t0 = pf.traces[0];
    assert.ok(t0.samples, 'first trace has samples');
    assert.equal(t0.samples!.length, t0.nSamples);
  });

  test('SEG-Y → writeSEGY → re-parse is sample-exact (IEEE float)', () => {
    const out = writeSEGY(pf, 2);
    const re = parseSEGY(out);
    assert.equal(re.traceCount, pf.traceCount, 'trace count preserved');
    const n = Math.min(pf.traces[0].nSamples, 65535);
    assert.ok(samplesEqual(pf.traces[0].samples, re.traces[0].samples, n), 'trace-0 samples identical');
  });

  test('SEG-Y → writeSEGY preserves srcX/srcY', () => {
    const out = writeSEGY(pf, 2);
    const re = parseSEGY(out);
    assert.equal(re.traces[0].hdr.srcX, pf.traces[0].hdr.srcX, 'srcX parity');
    assert.equal(re.traces[0].hdr.srcY, pf.traces[0].hdr.srcY, 'srcY parity');
  });

  test('SEG-Y → writeSU → parseSU round-trips samples', () => {
    const su = writeSU(pf);
    const re = parseSU(su);
    assert.equal(re.traceCount, pf.traceCount, 'trace count preserved');
    assert.ok(samplesEqual(pf.traces[0].samples, re.traces[0].samples, pf.traces[0].nSamples), 'trace-0 samples identical');
  });
} else {
  skip('SEG-Y suite', `${SEGY} not found`);
}

// ── SEG-Y streaming building blocks (synthetic, fixture-free) ─────────────────
// parseSegyMeta + decodeSegyTrace are the reusable header/trace primitives the
// streaming reader (Phase 2) builds on. These run with no sample data.
console.log('\n[SEG-Y building blocks]');
{
  // Build a minimal big-endian IEEE-float32 (format 5) SEG-Y in memory: 3200-byte
  // textual + 400-byte binary header, then `count` traces of `ns` samples. Returns
  // the buffer + the exact samples written so the decode can be checked bit-for-bit.
  const buildSegy = (opts: { ns: number; count: number; rev?: number; addHdr?: number; sampleInt?: number }) => {
    const { ns, count } = opts;
    const rev = opts.rev ?? 1;
    const addHdr = opts.addHdr ?? 0;
    const sampleInt = opts.sampleInt ?? 2000;
    const bps = 4; // IEEE float32
    const addHdrBytes = (rev >= 2 ? addHdr : 0) * 240;
    const tsz = 240 + addHdrBytes + ns * bps;
    const buf = new Uint8Array(3600 + count * tsz);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < 3200; i++) buf[i] = 0x20; // ASCII textual header (b[0] not EBCDIC)
    view.setUint16(3200 + 16, sampleInt, false); // sample interval µs
    view.setUint16(3200 + 20, ns, false); // samples/trace
    view.setUint16(3200 + 24, 5, false); // data sample format = IEEE float32
    view.setUint16(3200 + 300, rev === 2 ? 0x0200 : rev === 1 ? 0x0100 : 0, false); // revision
    view.setInt16(3200 + 304, 0, false); // fixed extended-header count = 0
    view.setUint32(3200 + 306, rev >= 2 ? addHdr : 0, false); // max additional trace headers
    const allSamples: number[][] = [];
    let off = 3600;
    for (let t = 0; t < count; t++) {
      view.setInt32(off + 72, 660000 + t, false); // srcX
      view.setInt32(off + 76, 3550000 + t, false); // srcY
      view.setUint16(off + 114, ns, false); // nSamples
      view.setUint16(off + 116, sampleInt, false); // sampInt
      const samples: number[] = [];
      const base = off + 240 + addHdrBytes;
      for (let i = 0; i < ns; i++) {
        const v = (t + 1) * 1.5 - i * 0.25; // multiples of 0.25 → exact in float32
        samples.push(v);
        view.setFloat32(base + i * bps, v, false);
      }
      allSamples.push(samples);
      off += tsz;
    }
    return { buf, allSamples, tsz };
  };

  test('parseSegyMeta resolves byte order, format, ns, sampleInt, revision, dataStart', () => {
    const { buf } = buildSegy({ ns: 4, count: 1 });
    const meta = parseSegyMeta(buf);
    assert.equal(meta.le, false, 'big-endian detected');
    assert.equal(meta.isEbcdic, false, 'ASCII textual header');
    assert.equal(meta.format, 5, 'IEEE float32 format');
    assert.equal(meta.bps, 4, 'bps for format 5');
    assert.equal(meta.defaultNs, 4, 'binary-header samples/trace');
    assert.equal(meta.sampleInt, 2000, 'sample interval');
    assert.equal(meta.revision, 1, 'rev1 major');
    assert.equal(meta.addHdrBytes, 0, 'no additional trace headers pre-rev2');
    assert.equal(meta.dataStart, 3600, 'first trace right after the 3600-byte header');
  });

  test('decodeSegyTrace decodes a known trace: samples + stride + header fields', () => {
    const { buf, allSamples, tsz } = buildSegy({ ns: 4, count: 1 });
    const meta = parseSegyMeta(buf);
    const res = decodeSegyTrace(buf, meta.dataStart, meta, true);
    assert.ok(res, 'decoded a trace');
    assert.equal(res!.stride, tsz, `stride = 240 + ns*bps (${tsz})`);
    assert.equal(res!.trace.nSamples, 4);
    assert.equal(res!.trace.dataFmt, 5);
    assert.equal(res!.trace.hdr.srcX, 660000, 'srcX header field');
    assert.equal(res!.trace.hdr.srcY, 3550000, 'srcY header field');
    assert.ok(res!.trace.samples, 'samples decoded');
    for (let i = 0; i < 4; i++) assert.equal(res!.trace.samples![i], allSamples[0][i], `sample[${i}]`);
  });

  test('decodeSegyTrace withSamples=false keeps the header, drops samples, same stride', () => {
    const { buf, tsz } = buildSegy({ ns: 4, count: 1 });
    const meta = parseSegyMeta(buf);
    const res = decodeSegyTrace(buf, meta.dataStart, meta, false);
    assert.ok(res);
    assert.equal(res!.trace.samples, null, 'no samples when withSamples=false');
    assert.equal(res!.trace.nSamples, 4, 'header sample count still reported');
    assert.equal(res!.stride, tsz, 'stride unaffected by withSamples');
  });

  test('parseSegyMeta + decodeSegyTrace reproduce parseSEGY exactly (multi-trace walk)', () => {
    const { buf, allSamples } = buildSegy({ ns: 6, count: 3 });
    const pf = parseSEGY(buf);
    assert.equal(pf.traceCount, 3, 'three traces walked');
    const meta = parseSegyMeta(buf);
    let off = meta.dataStart;
    for (let t = 0; t < 3; t++) {
      const res = decodeSegyTrace(buf, off, meta, true);
      assert.ok(res, `trace ${t} decoded`);
      assert.equal(res!.trace.nSamples, pf.traces[t].nSamples, `nSamples[${t}]`);
      assert.ok(samplesEqual(res!.trace.samples, pf.traces[t].samples, res!.trace.nSamples), `samples[${t}] match parseSEGY`);
      for (let i = 0; i < allSamples[t].length; i++) {
        assert.equal(res!.trace.samples![i], allSamples[t][i], `golden sample[${t}][${i}]`);
      }
      off += res!.stride;
    }
    assert.equal(off, buf.length, 'walk consumed the whole buffer');
  });

  test('rev2 additional trace headers widen the stride (parseSEGY agrees end-to-end)', () => {
    const { buf, tsz } = buildSegy({ ns: 4, count: 2, rev: 2, addHdr: 1 });
    const meta = parseSegyMeta(buf);
    assert.equal(meta.revision, 2, 'rev2');
    assert.equal(meta.addHdrBytes, 240, 'one additional 240-byte trace header');
    const res = decodeSegyTrace(buf, meta.dataStart, meta, true);
    assert.ok(res);
    assert.equal(res!.stride, tsz, `stride includes addHdrBytes (${tsz})`);
    assert.equal(parseSEGY(buf).traceCount, 2, 'both rev2 traces walked at the wide stride');
  });

  test('parseSegyMeta never throws on a sub-header buffer', () => {
    assert.doesNotThrow(() => {
      const meta = parseSegyMeta(new Uint8Array(100));
      assert.ok(Number.isFinite(meta.dataStart), 'dataStart finite even on a tiny buffer');
    });
  });
}

// ── SEG-2 / Geode .dat ───────────────────────────────────────────────────────
console.log('\n[SEG-2 / Geode .dat]');
if (existsSync(GEODE)) {
  const bytes = readBytes(GEODE);

  test('detect() identifies SEG-2 from .dat', () => {
    assert.equal(detect(bytes, '1006.dat'), 'SEG-2');
  });

  const pf = parseAny(bytes, '1006.dat');
  console.log(
    `      golden: format=${pf.format} traceCount=${pf.traceCount} ` +
      `samplesTrace=${pf.bh.samplesTrace} sampleInt=${pf.bh.sampleInt}us dataFmt=${pf.bh.dataFmt}`,
  );

  test('parses Geode traces', () => {
    assert.equal(pf.format, 'SEG-2');
    assert.ok(pf.traceCount > 0, 'expected > 0 traces');
    assert.ok(pf.bh.sampleInt && pf.bh.sampleInt > 0, 'sample interval populated');
  });

  test('first Geode trace has decoded samples', () => {
    const t0 = pf.traces[0];
    assert.ok(t0.samples && t0.samples.length === t0.nSamples, 'samples decoded');
  });
} else {
  skip('SEG-2 suite', `${GEODE} not found`);
}

// ── Batch SEG-Y ──────────────────────────────────────────────────────────────
console.log('\n[Batch SEG-Y]');
if (existsSync(BATCH_DIR)) {
  const files = readdirSync(BATCH_DIR).filter((f) => /\.sgy$/i.test(f));
  test(`batch parses ${files.length} .sgy files with no errors`, () => {
    assert.ok(files.length > 0, 'found .sgy files');
    for (const f of files) {
      const pf = parseAny(readBytes(`${BATCH_DIR}/${f}`), f);
      assert.equal(pf.errors.length, 0, `${f}: ${pf.errors.join('; ')}`);
      assert.ok(pf.traceCount > 0, `${f}: expected > 0 traces`);
    }
  });
} else {
  skip('Batch suite', `${BATCH_DIR} not found`);
}

// ── Coordinates ───────────────────────────────────────────────────────────────
console.log('\n[Coordinates]');
test('UTM forward/inverse round-trips (< 1e-6 deg)', () => {
  const lat = 32.0853;
  const lon = 34.7818; // Tel Aviv, UTM zone 36N
  const en = latLonToUTM(lat, lon, 36, 'N');
  const ll = utmToLatLon(en.E, en.N, 36, 'N');
  assert.ok(Math.abs(ll.lat - lat) < 1e-6, `lat err ${Math.abs(ll.lat - lat)}`);
  assert.ok(Math.abs(ll.lon - lon) < 1e-6, `lon err ${Math.abs(ll.lon - lon)}`);
});

test('ITM forward/inverse round-trips (< 1e-6 deg)', () => {
  const lat = 32.0853;
  const lon = 34.7818;
  const en = latLonToITM(lat, lon);
  const ll = itmToLatLon(en.E, en.N);
  assert.ok(Math.abs(ll.lat - lat) < 1e-6, `lat err ${Math.abs(ll.lat - lat)}`);
  assert.ok(Math.abs(ll.lon - lon) < 1e-6, `lon err ${Math.abs(ll.lon - lon)}`);
});

test('ITM lands a Tel Aviv point in the Israeli grid range', () => {
  const en = latLonToITM(32.0853, 34.7818);
  // New Israeli Grid: easting ~120k-280k, northing ~380k-790k
  assert.ok(en.E > 120000 && en.E < 280000, `E out of range: ${en.E}`);
  assert.ok(en.N > 380000 && en.N < 790000, `N out of range: ${en.N}`);
  console.log(`      golden: Tel Aviv ITM E=${en.E.toFixed(2)} N=${en.N.toFixed(2)}`);
});

// ── base64 (I/O bridge) ───────────────────────────────────────────────────────
console.log('\n[base64]');
test('base64 round-trips arbitrary byte lengths', () => {
  for (const len of [0, 1, 2, 3, 4, 5, 255, 1000, 65537]) {
    const a = new Uint8Array(len);
    for (let i = 0; i < len; i++) a[i] = (i * 31 + 7) & 0xff;
    const b = base64ToBytes(bytesToBase64(a));
    assert.equal(b.length, len, `length mismatch at len ${len}`);
    for (let i = 0; i < len; i++) assert.equal(b[i], a[i], `byte ${i} mismatch at len ${len}`);
  }
});
test('base64 encoding matches Node Buffer reference', () => {
  const a = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 65, 66, 67]);
  assert.equal(bytesToBase64(a), Buffer.from(a).toString('base64'));
});

// ── Format registry ──────────────────────────────────────────────────────────
console.log('\n[registry]');
test('registry lists writers and dispatches detect→parser', () => {
  const ids = listWriters().map((w) => w.id);
  assert.ok(ids.includes('segy1') && ids.includes('segy0') && ids.includes('su'), `writers: ${ids.join(',')}`);
  if (existsSync(SEGY)) {
    const pf = parseWithRegistry(readBytes(SEGY), '00000186_SegY_Rev2.segy');
    assert.equal(pf.format, 'SEG-Y');
    assert.ok(pf.traceCount > 0);
  }
});

// ── Processing (interpolation) ────────────────────────────────────────────────
console.log('\n[processing]');
test('resampleLinear preserves endpoints, length, and ramp values', () => {
  const a = Float32Array.from([0, 1, 2, 3]);
  const up = resampleLinear(a, 7);
  assert.equal(up.length, 7);
  assert.equal(up[0], 0);
  assert.equal(up[6], 3);
  assert.ok(Math.abs(up[3] - 1.5) < 1e-6, `midpoint ${up[3]}`);
  assert.deepEqual(Array.from(resampleLinear(a, 4)), [0, 1, 2, 3]);
  // regression: downsample to a single point must not produce NaN
  const one = resampleLinear(a, 1);
  assert.equal(one.length, 1);
  assert.ok(Number.isFinite(one[0]), `newLength=1 produced ${one[0]}`);
});
test('resampleToInterval rescales trace sample count when interval changes', () => {
  const ramp = resampleLinear(Float32Array.from([0, 100]), 101);
  const pf: any = {
    format: 'SEG-Y', revision: 0, bh: { sampleInt: 500, samplesTrace: 101 },
    traceCount: 1, errors: [], traces: [{ hdr: {}, samples: ramp, nSamples: 101 }],
  };
  const rs = resampleToInterval(pf, 1000);
  assert.equal(rs.bh.sampleInt, 1000);
  assert.equal(rs.traces[0].nSamples, 51);
  assert.ok(rs.traces[0].samples != null);
});

// ── Render engine (N1) ────────────────────────────────────────────────────────
console.log('\n[render engine]');
test('AGC normalizes a constant-amplitude trace to ~1', () => {
  const s = new Float32Array(200).fill(5);
  const rms = applyAGC(s, 50, 1000, 'rms');
  assert.equal(rms.length, 200);
  assert.ok(Math.abs(rms[100] - 1) < 1e-6, `rms mid ${rms[100]}`);
  assert.ok(Number.isFinite(rms[0]) && Number.isFinite(rms[199]));
  assert.ok(Math.abs(applyAGC(s, 50, 1000, 'mean')[100] - 1) < 1e-6);
});
console.log('\n[dsp: robust stats + first breaks + trace health]');
test('robust stats: median / mad / madZScore / localMedianMAD — finite + outlier-proof', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([]), 0);
  assert.equal(median([NaN, Infinity, 7]), 7); // non-finite dropped
  // MAD of [1,2,3,4,5] about 3 = median(|.-3|)=median(2,1,0,1,2)=1.
  assert.equal(mad([1, 2, 3, 4, 5]), 1);
  // A single wild outlier barely moves median/MAD (the whole point).
  assert.equal(median([1, 2, 3, 4, 1000]), 3);
  // z-score: 11 against med 3, MAD 1 → (11-3)/(1.4826·1) ≈ 5.4σ.
  const z = madZScore(11, 3, 1);
  assert.ok(z > 5 && z < 6, `z ${z}`);
  assert.equal(madZScore(NaN, 3, 1), 0); // non-finite x → 0
  assert.equal(madZScore(5, 3, 0), 0);   // zero scale, no floor → 0 (no Infinity)
  // localMedianMAD over a window, keeping only "live" (>0) neighbours, excluding self.
  const arr = [10, 0, 11, 9, 0, 10, 100];
  const ls = localMedianMAD(arr, 2, 2, { excludeSelf: true, keep: (v) => v > 0 });
  assert.ok(ls.n >= 2 && Number.isFinite(ls.median) && Number.isFinite(ls.mad), `n${ls.n} med${ls.median}`);
  assert.doesNotThrow(() => localMedianMAD([], 0, 3));
});
test('STA/LTA first-break picker lands near a known onset; flat/empty → no pick (NaN)', () => {
  const si = 2000; // 2 ms / sample
  const n = 400;
  const s = new Float32Array(n);
  const onset = 150; // sample index of the onset
  for (let i = onset; i < n; i++) s[i] = Math.sin((2 * Math.PI * (i - onset)) / 14) * Math.exp(-(i - onset) / 90);
  const pick = pickSTALTA(s, si, { staMs: 20, ltaMs: 120, threshold: 3 });
  assert.ok(Number.isFinite(pick), `pick ${pick}`);
  const pickSamp = (pick * 1000) / si;
  assert.ok(Math.abs(pickSamp - onset) < 30, `pick sample ${pickSamp} vs onset ${onset}`);
  assert.ok(Number.isNaN(pickSTALTA(new Float32Array(n), si, { staMs: 20, ltaMs: 120, threshold: 3 })), 'flat → NaN');
  assert.ok(Number.isNaN(pickSTALTA(new Float32Array(0), si, { staMs: 20, ltaMs: 120, threshold: 3 })), 'empty → NaN');
  const picks = pickFirstBreaks([s, new Float32Array(n)], si, { staMs: 20, ltaMs: 120, threshold: 3 });
  assert.equal(picks.length, 2);
  assert.ok(Number.isFinite(picks[0]) && Number.isNaN(picks[1]));
});
test('assisted first breaks: seeded moveout fill tracks the true onsets across the gather (near & far)', () => {
  const si = 1000; // 1 ms / sample → tMs == sample index, easy to assert
  const nS = 600, N = 24;
  const rng = (() => { let a = 13 >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  // A few-cycle wavelet whose POSITIVE peak sits exactly at `c`.
  const wavelet = (out: Float32Array, c: number, amp: number) => {
    for (let i = 0; i < out.length; i++) { const k = i - c; out[i] += amp * Math.cos((2 * Math.PI * k) / 18) * Math.exp(-(k * k) / (2 * 9 * 9)); }
  };
  const peakSamp = (i: number) => 86 + i * 7; // linear moveout, peak sample of trace i
  const traces: Float32Array[] = [], absIdx: number[] = [], offsets: number[] = [];
  for (let i = 0; i < N; i++) {
    const s = new Float32Array(nS);
    wavelet(s, peakSamp(i), 1 / (1 + i * 0.05));        // far traces weaker (AGC must equalise them)
    for (let k = 0; k < nS; k++) s[k] += (rng() - 0.5) * 0.01;
    traces.push(s); absIdx.push(i); offsets.push(100 + i * 50);
  }
  // Seed first / middle / last at the true peak time (ms == sample for si=1ms).
  const seeds = [0, 12, 23].map((i) => ({ absIdx: i, tMs: peakSamp(i) }));
  const r = assistFirstBreaks({ traces, absIdx, siUs: si, seeds, offsets, opts: { windowMs: 25, polarity: 'peak' } });
  assert.equal(r.picks.length, N);
  assert.ok(r.hasOffsets, 'real offsets should order the guide');
  const byAbs = new Map(r.picks.map((p) => [p.absIdx, p]));
  for (let i = 0; i < N; i++) {
    const p = byAbs.get(i)!;
    assert.ok(p && Number.isFinite(p.tMs), `trace ${i} should pick (got ${p?.tMs})`);
    const samp = (p.tMs * 1000) / si;
    assert.ok(Math.abs(samp - peakSamp(i)) <= 6, `trace ${i} pick ${samp.toFixed(1)} vs true ${peakSamp(i)}`);
  }
  // Seeds keep their provenance + time; auto picks are flagged 'auto'.
  assert.equal(byAbs.get(0)!.source, 'seed');
  assert.equal(byAbs.get(5)!.source, 'auto');
});
test('assisted first breaks: the guide window stops far-trace scatter (a late noise burst is ignored)', () => {
  const si = 1000, nS = 600, N = 24;
  const rng = (() => { let a = 99 >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  const wavelet = (out: Float32Array, c: number, amp: number) => {
    for (let i = 0; i < out.length; i++) { const k = i - c; out[i] += amp * Math.cos((2 * Math.PI * k) / 18) * Math.exp(-(k * k) / (2 * 9 * 9)); }
  };
  const peakSamp = (i: number) => 86 + i * 7;
  const traces: Float32Array[] = [], absIdx: number[] = [], offsets: number[] = [];
  for (let i = 0; i < N; i++) {
    const s = new Float32Array(nS);
    wavelet(s, peakSamp(i), 1 / (1 + i * 0.05));
    for (let k = 0; k < nS; k++) s[k] += (rng() - 0.5) * 0.01;
    traces.push(s); absIdx.push(i); offsets.push(100 + i * 50);
  }
  // A STRONG late noise burst on a far trace, well after its true onset and far
  // OUTSIDE the ±25 ms guide window — the naive per-trace picker scatters onto it.
  const noisy = 20;
  const trueSamp = peakSamp(noisy); // ≈ 226
  for (let k = 440; k < 470; k++) traces[noisy][k] += (k % 2 ? 7 : -7);
  const seeds = [0, 12, 23].map((i) => ({ absIdx: i, tMs: peakSamp(i) })); // not the noisy trace
  const r = assistFirstBreaks({ traces, absIdx, siUs: si, seeds, offsets, opts: { windowMs: 25, polarity: 'peak' } });
  const p = r.picks.find((q) => q.absIdx === noisy)!;
  const samp = (p.tMs * 1000) / si;
  assert.ok(Math.abs(samp - trueSamp) <= 8, `far pick ${samp.toFixed(1)} should track onset ${trueSamp}`);
  assert.ok(samp < 400, `far pick ${samp.toFixed(1)} must NOT jump to the late noise (~450)`);
});
test('assisted first breaks: <2 seeds emits only the seed; empty / garbage never throws', () => {
  const si = 2000;
  assert.doesNotThrow(() => assistFirstBreaks({ traces: [], absIdx: [], siUs: si, seeds: [] }));
  const empty = assistFirstBreaks({ traces: [], absIdx: [], siUs: si, seeds: [] });
  assert.equal(empty.picks.length, 0);
  const garbage = [new Float32Array([NaN, Infinity, -Infinity, 0]), null, new Float32Array(0)] as (Float32Array | null)[];
  assert.doesNotThrow(() => assistFirstBreaks({ traces: garbage, absIdx: [0, 1, 2], siUs: si, seeds: [{ absIdx: 0, tMs: 10 }] }));
  // One seed only → just that seed comes back, no auto picks.
  const one = assistFirstBreaks({ traces: [new Float32Array(100), new Float32Array(100)], absIdx: [0, 1], siUs: si, seeds: [{ absIdx: 0, tMs: 20 }] });
  assert.equal(one.picks.length, 1);
  assert.equal(one.picks[0].source, 'seed');
});
test('trace-health: clean moveout gather → no flags; injected dead/reversed/hot/spike caught; AVO far reversal NOT flagged', () => {
  const si = 2000, N = 40, nS = 500;
  const mulberry32 = (seed: number) => { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const gabor = (out: Float32Array, centre: number, amp: number, sign: number, period = 18, sigma = 12) => {
    for (let i = 0; i < out.length; i++) { const k = i - centre; out[i] += sign * amp * Math.cos((2 * Math.PI * k) / period) * Math.exp(-(k * k) / (2 * sigma * sigma)); }
  };
  const avoStart = 26; // far traces flip the DEEP event (a real AVO reversal), not the first break
  const buildClean = (): Float32Array[] => {
    const rng = mulberry32(7);
    const out: Float32Array[] = [];
    for (let i = 0; i < N; i++) {
      const s = new Float32Array(nS);
      const offAmp = 1 / (1 + i * 0.04);                 // smooth offset-amplitude decay
      const fbC = 90 + i * 2.2;                          // moveout
      gabor(s, fbC, 1.0 * offAmp, +1);                   // first break (always positive polarity)
      gabor(s, fbC + 150, 0.6 * offAmp, i >= avoStart ? -1 : +1); // deep event flips on far traces (AVO), OUTSIDE the FB gate
      for (let k = 0; k < nS; k++) s[k] += (rng() - 0.5) * 0.02 * offAmp; // a little noise ⇒ neighbour MAD > 0
      out.push(s);
    }
    return out;
  };

  // A purely clean gather flags nothing — incl. the AVO far-offset traces.
  const clean = buildClean();
  const cleanRes = scanTraceHealth(clean, si);
  assert.equal(cleanRes.coverage.scanned, N);
  assert.equal(cleanRes.findings.length, 0, `clean flagged ${cleanRes.findings.map((f) => f.absIndex)}`);
  assert.ok(cleanRes.coverage.polarityRan, 'polarity should run on the contiguous clean gather');

  // Inject one of each fault among the clean traces.
  const bad = buildClean();
  bad[10] = new Float32Array(nS);                                   // DEAD — all zero
  for (let k = 0; k < nS; k++) bad[20][k] = -bad[20][k];            // REVERSED — whole trace flipped (FB polarity flips)
  for (let k = 0; k < nS; k++) bad[31][k] = bad[31][k] * 8;         // HOT — amplitude outlier vs neighbours
  bad[35][240] = 60;                                                // SPIKE — one isolated huge sample
  const res = scanTraceHealth(bad, si);
  const flagged = new Set(res.findings.map((f) => f.absIndex));
  const by = new Map(res.findings.map((f) => [f.absIndex, f]));
  const has = (abs: number, id: string) => !!by.get(abs)?.detectors.some((d) => d.id === id);
  assert.ok(flagged.has(10) && has(10, 'dead'), 'trace 10 should be DEAD');
  assert.ok(flagged.has(20) && has(20, 'reversed'), `trace 20 should be REVERSED (corr ${by.get(20)?.detectors.find((d) => d.id === 'reversed')?.metric})`);
  assert.ok(flagged.has(31) && has(31, 'amp'), 'trace 31 should be HOT (amp)');
  assert.ok(flagged.has(35) && has(35, 'clipped'), 'trace 35 should be CLIPPED/spiky');
  // The AVO far traces (deep-event reversal, normal first break) must NOT be flagged
  // as reversed — only the explicitly-injected far faults (31 hot, 35 spike) flag at all.
  for (let i = avoStart; i < N; i++) {
    if (i === 31 || i === 35) continue;
    assert.ok(!flagged.has(i), `AVO far trace ${i} must NOT be flagged (det ${by.get(i)?.detectors.map((d) => d.id)})`);
  }
  // No clean trace anywhere flags reversed.
  for (const f of res.findings) if (f.absIndex !== 20) assert.ok(!f.detectors.some((d) => d.id === 'reversed'), `trace ${f.absIndex} wrongly reversed`);
});
test('trace-health: tunability — a borderline trace flips flagged↔clear with sensitivity; empty/garbage never throws', () => {
  const mkEv = (over: Record<string, number | boolean> = {}) => ({
    n: 500, std: 0.3, rms: 0.3, peak: 1, rmsGated: 0.3, zcr: 0.1, flatRatio: 0.3, deadRel: 1, deadBaseline: 0.3,
    rmsZ: 0, ampBaseline: 0.3, localN: 8, specScore: 0, domFreqHz: 30, hfFrac: 0.1, oneBinDom: 0.05,
    clipRunFrac: 0, spikeScore: 1.5, polarityCoef: 0.9, polarityConf: 0.8, polarityRan: true, ...over,
  });
  // A trace at z=+5σ AND 3.3× the local median (so the amplitude-ratio guard is met):
  // cleared at LOW amp sensitivity (hotZ=9), flagged at HIGH (hotZ=4).
  const ev = mkEv({ rmsZ: 5, rms: 1.0 });
  const low = classifyTrace(ev, 0, thresholdsForSensitivity({ amp: 'low' }));
  const high = classifyTrace(ev, 0, thresholdsForSensitivity({ amp: 'high' }));
  assert.equal(low.finding, null, 'z=5 should NOT flag at low amp sensitivity (hotZ 9)');
  assert.ok(high.finding && high.finding.detectors.some((d) => d.id === 'amp'), 'z=5 should flag hot at high amp sensitivity (hotZ 4)');
  // A clean evidence flags nothing at the default thresholds.
  assert.equal(classifyTrace(mkEv(), 0, defaultThresholds()).finding, null);
  // Flat-line dead fires by std/peak regardless of neighbours.
  assert.ok(classifyTrace(mkEv({ flatRatio: 0.001 }), 0, defaultThresholds()).finding?.detectors.some((d) => d.id === 'dead'));
  // Empty / garbage input never throws.
  assert.doesNotThrow(() => scanTraceHealth([], 2000));
  assert.equal(scanTraceHealth([], 2000).coverage.scanned, 0);
  const garbage = new Float32Array([NaN, Infinity, -Infinity, 0, NaN]);
  assert.doesNotThrow(() => scanTraceHealth([null, undefined, new Float32Array(0), garbage], 2000));
});
test('trace-health: evidence round-trips through the flat transport buffer (incl. NaN polarity)', () => {
  const ev = { n: 480, std: 1.5, rms: 1.6, peak: 4.2, rmsGated: 1.1, zcr: 0.12, flatRatio: 0.36, deadRel: 0.9, deadBaseline: 1.2, rmsZ: 2.3, ampBaseline: 1.4, localN: 7, specScore: 1.1, domFreqHz: 28, hfFrac: 0.2, oneBinDom: 0.08, clipRunFrac: 0.01, spikeScore: 4, polarityCoef: NaN, polarityConf: 0, polarityRan: false };
  const flat = new Float32Array(EVIDENCE_STRIDE * 2);
  writeEvidence(flat, 1, ev);
  const back = readEvidence(flat, 1);
  assert.equal(back.n, 480);
  assert.equal(back.localN, 7);
  assert.equal(back.polarityRan, false);
  assert.ok(Number.isNaN(back.polarityCoef), 'NaN polarity survives the Float32 transport');
  assert.ok(Math.abs(back.rmsZ - 2.3) < 1e-4 && Math.abs(back.peak - 4.2) < 1e-4);
});
test('color maps hit known anchors', () => {
  assert.deepEqual(colorSeismic(0), [255, 255, 255]);
  assert.deepEqual(colorSeismic(1), [255, 0, 0]);
  assert.deepEqual(colorSeismic(-1), [0, 0, 255]);
  assert.deepEqual(getColor(0, 'gray'), [128, 128, 128]);
  assert.deepEqual(getColor(5, 'amber'), [255, 140, 0]);
});
test('maxAbs / percentile / decimate behave', () => {
  const s = Float32Array.from([-3, 1, 2, -1]);
  assert.equal(maxAbs(s), 3);
  assert.ok(normFactorPercentile(s, 0.95) > 0);
  const big = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) big[i] = Math.sin(i / 10);
  assert.ok(decimateMinMax(big, 100).length <= 100);
});

// ── SPS (N5) ──────────────────────────────────────────────────────────────────
console.log('\n[sps]');
test('SPS parser reads S/R records, headers, and ITM projection', () => {
  const put = (line: string, start: number, txt: string) => {
    const padded = line.padEnd(Math.max(line.length, start + txt.length), ' ');
    return padded.slice(0, start) + txt + padded.slice(start + txt.length);
  };
  let h = 'H18'.padEnd(80, ' ');
  h = put(h, 32, 'ITM');
  let s = put('S'.padEnd(80, ' '), 1, '101');
  s = put(s, 11, '200'); s = put(s, 23, '1');
  s = put(s, 46, '660000.0'); s = put(s, 55, '3550000.0'); s = put(s, 65, '120.0');
  let r = put('R'.padEnd(80, ' '), 1, '500');
  r = put(r, 11, '10'); r = put(r, 23, '1');
  r = put(r, 46, '661000.0'); r = put(r, 55, '3551000.0'); r = put(r, 65, '95.0');
  const sps = parseSPSText([h, s, r].join('\n'));
  assert.equal(sps.sources.length, 1, `sources ${sps.sources.length}`);
  assert.equal(sps.receivers.length, 1, `receivers ${sps.receivers.length}`);
  assert.equal(sps.layout, 'SPS2.1');
  assert.ok(Math.abs(sps.sources[0].easting - 660000) < 1, `E ${sps.sources[0].easting}`);
  assert.ok(Math.abs(sps.receivers[0].northing - 3551000) < 1, `N ${sps.receivers[0].northing}`);
  assert.equal(sps.projection?.subtype, 'TM');
  const lat0 = sps.projection?.latOrigin ?? 0;
  assert.ok(lat0 > 31 && lat0 < 32, `latOrigin ${lat0}`);
  assert.equal(detectSPSType('survey.s01'), 'S');
  assert.equal(detectSPSType('survey.r'), 'R');
});
test('SPS QC flags a duplicate source', () => {
  const put = (line: string, start: number, txt: string) => {
    const padded = line.padEnd(Math.max(line.length, start + txt.length), ' ');
    return padded.slice(0, start) + txt + padded.slice(start + txt.length);
  };
  const mk = () => {
    let s = put('S'.padEnd(80, ' '), 1, '101');
    s = put(s, 11, '200'); s = put(s, 23, '1');
    s = put(s, 46, '660000.0'); s = put(s, 55, '3550000.0'); s = put(s, 65, '120.0');
    return s;
  };
  const qc = runSPSQC(parseSPSText([mk(), mk()].join('\n')), {});
  assert.ok(qc.some((r) => r.cat === 'Duplicate' && r.sev === 'error'), 'duplicate not flagged');
});
test('SPS reprojection ITM→WGS84 lands near Israel', () => {
  const put = (line: string, start: number, txt: string) => {
    const padded = line.padEnd(Math.max(line.length, start + txt.length), ' ');
    return padded.slice(0, start) + txt + padded.slice(start + txt.length);
  };
  const src: any = {
    subtype: 'TM', a: 6378137, invF: 298.257222101, centralMeridian: 35.20451694444, latOrigin: 31.73439361111,
    scaleFactor: 1.0000067, falseEasting: 219529.584, falseNorthing: 626907.39,
    helmert: { dx: 23.772, dy: 17.49, dz: 17.859, rx: -0.313, ry: -1.853, rz: 1.673, ds: 0 },
  };
  let s = put('S'.padEnd(80, ' '), 1, '101');
  s = put(s, 46, '179622.00');
  s = put(s, 55, '665896.00');
  const wgs = EPSG_DB.find((c) => c.code === 'EPSG:4326')!;
  const txt = reprojectSPS([s], wgs, 'S', src);
  const lon = parseFloat(txt.substring(46, 55));
  const lat = parseFloat(txt.substring(55, 65));
  assert.ok(lon > 33 && lon < 37, `lon ${lon}`);
  assert.ok(lat > 29 && lat < 34, `lat ${lat}`);
});

// ── EPSG database + searchable picker (built-in / offline) ─────────────────────
console.log('\n[epsg]');
test('EPSG_DB carries the full programmatically-generated UTM grid (≥120) + no dup codes', () => {
  const utm = EPSG_DB.filter((c) => c.subtype === 'UTM');
  assert.ok(utm.length >= 120, `expected ≥120 UTM entries, got ${utm.length}`);
  // Canonical WGS84/UTM codes for both hemispheres of zone 36.
  const n36 = EPSG_DB.find((c) => c.code === 'EPSG:32636');
  const s36 = EPSG_DB.find((c) => c.code === 'EPSG:32736');
  assert.ok(n36 && n36.name === 'WGS 84 / UTM zone 36N', `32636 ${n36?.name}`);
  assert.ok(s36 && s36.name === 'WGS 84 / UTM zone 36S', `32736 ${s36?.name}`);
  // Generated params match the canonical UTM definition (zone 36 → CM 33°E).
  assert.ok(Math.abs((n36!.lon0 ?? 0) - 33) < 1e-9, `36N central meridian ${n36!.lon0}`);
  assert.equal(n36!.FE, 500000); assert.equal(n36!.FN, 0); assert.equal(n36!.k0, 0.9996);
  assert.equal(s36!.FN, 10000000, 'southern zone false northing');
  // National / regional grids preserved.
  assert.ok(EPSG_DB.some((c) => c.code === 'EPSG:2039'), 'ITM (EPSG:2039) must stay');
  assert.ok(EPSG_DB.some((c) => c.code === 'EPSG:4326'), 'WGS84 geographic must stay');
  // No duplicate EPSG codes anywhere in the DB.
  const codes = EPSG_DB.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length, 'duplicate EPSG codes present');
  console.log(`      golden: EPSG_DB has ${EPSG_DB.length} entries (${utm.length} UTM)`);
});

test('searchEPSG matches by code AND name, case-insensitive + ranked', () => {
  // Code search.
  assert.ok(searchEPSG('2039').some((c) => c.code === 'EPSG:2039'), "'2039' → ITM");
  assert.ok(searchEPSG('32636').some((c) => c.code === 'EPSG:32636'), "'32636' → UTM 36N");
  assert.equal(searchEPSG('32636')[0].code, 'EPSG:32636', 'exact code ranks first');
  assert.ok(searchEPSG('EPSG:32636').some((c) => c.code === 'EPSG:32636'), "'EPSG:32636' prefix form");
  // Name search (the picker's main path) — case-insensitive, token-based so the
  // word "zone" in the stored name doesn't break "UTM 36N".
  assert.ok(searchEPSG('UTM 36N').some((c) => c.code === 'EPSG:32636'), "'UTM 36N' → 32636");
  assert.ok(searchEPSG('utm 36n').some((c) => c.code === 'EPSG:32636'), "'utm 36n' (lower) → 32636");
  assert.ok(searchEPSG('zone 36').some((c) => c.code === 'EPSG:32636'), "'zone 36' → 32636");
  assert.ok(searchEPSG('ITM').some((c) => c.code === 'EPSG:2039'), "'ITM' → 2039");
  assert.ok(searchEPSG('israel').some((c) => c.code === 'EPSG:2039'), "'israel' → 2039");
  // Empty query returns a bounded default list (not the whole DB).
  assert.ok(searchEPSG('').length > 0 && searchEPSG('').length <= 30, 'empty query bounded');
});

test('crsFromSpec + the transform project a generated UTM zone to a sane E/N (round-trips)', () => {
  // Resolve a UTM-36N spec against the built-in DB.
  const crs = crsFromSpec({ projType: 'UTM', zone: 36, hemi: 'N', datum: 'WGS 84' });
  assert.equal(crs.subtype, 'UTM'); assert.equal(crs.zone, 36); assert.equal(crs.hemi, 'N');
  assert.ok(Math.abs((crs.lon0 ?? 0) - 33) < 1e-9, `central meridian ${crs.lon0}`);
  assert.equal(crs.FE, 500000);
  // Forward-project a known Tel-Aviv-area lat/lon in zone 36N.
  const lat = 32.0853, lon = 34.7818;
  const en = lonLatToProj(lat, lon, crs);
  assert.ok(Number.isFinite(en.E) && Number.isFinite(en.N), 'finite E/N');
  assert.ok(en.E > 100000 && en.E < 900000, `E out of UTM band: ${en.E}`);
  assert.ok(en.N > 3000000 && en.N < 4000000, `N out of range: ${en.N}`);
  // Matches the dedicated WGS84/UTM helper (same math, no datum shift).
  const ref = latLonToUTM(lat, lon, 36, 'N');
  assert.ok(Math.abs(en.E - ref.E) < 1e-6 && Math.abs(en.N - ref.N) < 1e-6, `lonLatToProj vs latLonToUTM drift ${en.E - ref.E},${en.N - ref.N}`);
  // Inverse round-trips back to the original lat/lon.
  const ll = projToLatLon(en.E, en.N, { subtype: 'UTM', zone: 36, hemi: 'N' }, 0);
  assert.ok(Math.abs(ll.lat - lat) < 1e-6 && Math.abs(ll.lon - lon) < 1e-6, `round-trip ${ll.lat},${ll.lon}`);
  console.log(`      golden: UTM 36N (32636) E=${en.E.toFixed(2)} N=${en.N.toFixed(2)}`);
});

// ── SPS writer + renumber + create (pure core foundation) ──────────────────────
console.log('\n[sps write/renumber/create]');

// A minimal ITM-ish projection for the generated/serialised surveys.
const ITM_PROJ: any = {
  type: 'ITM', subtype: 'TM', zone: null, hemi: null, datum: 'WGS 84', ellipsoid: 'WGS 84',
  a: 6378137, invF: 298.257222101, units: 'meters', unitFactor: 1,
  centralMeridian: 35.20451694444, latOrigin: 31.73439361111, falseEasting: 219529.584,
  falseNorthing: 626907.39, scaleFactor: 1.0000067, helmert: null, source: 'test', desc: 'EPSG:2039',
};
const mkSR = (rtype: 'S' | 'R', line: string, point: number, e: number, n: number, z: number): any =>
  ({ rtype, lineName: line, point, idx: '1', easting: e, northing: n, elevation: z, raw: '', lineNum: 0 });
// Place text at a fixed 0-based start within an 80-col record (as elsewhere in this suite).
const putCol = (line: string, start: number, txt: string): string => {
  const padded = line.padEnd(Math.max(line.length, start + txt.length), ' ');
  return padded.slice(0, start) + txt + padded.slice(start + txt.length);
};
// Combine separately-parsed S/R/X files into one SPSData for QC/round-trip checks.
const combine = (sTxt: string, rTxt: string, xTxt: string): any => ({
  sources: parseSPSText(sTxt).sources, receivers: parseSPSText(rTxt).receivers, xrefs: parseSPSText(xTxt).xrefs,
  headers: [], errors: [], skipped: 0, layout: 'SPS2.1',
});

test('buildSPS → parseSPSText reproduces S/R/X line/point/idx/E/N/elev + channel ranges', () => {
  const data: any = {
    sources: [mkSR('S', '101', 200, 660000, 3550000, 120), mkSR('S', '101', 202, 660025, 3550000, 121)],
    receivers: [mkSR('R', '500', 10, 661000, 3551000, 95), mkSR('R', '500', 12, 661025, 3551000, 96)],
    xrefs: [{
      tape: 'T1', ffid: 1001, srcLine: '101', srcPt: 200, srcIdx: '1', fromCh: 1, toCh: 2, chIncr: 1,
      rcvLine: '500', rcvPtFrom: 10, rcvPtTo: 12, rcvIdx: '1', rcvLineFrom: '500', rcvLineTo: '500', layout: 'SPS2.1',
    }],
    headers: [], errors: [], skipped: 0, layout: 'SPS2.1', projection: ITM_PROJ,
  };
  const files = buildSPS(data, { baseName: 'unit', emitHeaders: true, dateWritten: '2026-06-28 14:43:31' });
  assert.deepEqual(files.map((f) => f.name), ['unit.s', 'unit.r', 'unit.x'], 'file names + order');
  // H00 (SPS format version) must lead every file so apps can identify the format.
  assert.ok(files.every((f) => f.text.startsWith('H00 SPS format version num.')), 'H00 leads every file');
  assert.ok(files.every((f) => /^H00 .*SPS 2\.1;/m.test(f.text)), 'H00 declares SPS 2.1');
  assert.ok(/^H01 Description of survey area  ,unit;/m.test(files[0].text), 'H01 carries the survey name');
  assert.ok(/^H26 Date file written +2026-06-28 14:43:31;/m.test(files[0].text), 'H26 carries the date written');
  assert.ok(/^H12/m.test(files[0].text), 'emitHeaders includes the projection H block');

  const ds = parseSPSText(files[0].text), dr = parseSPSText(files[1].text), dx = parseSPSText(files[2].text);
  assert.equal(ds.sources.length, 2, `sources ${ds.sources.length}`);
  assert.equal(dr.receivers.length, 2, `receivers ${dr.receivers.length}`);
  assert.equal(dx.xrefs.length, 1, `xrefs ${dx.xrefs.length}`);
  // Source fields round-trip exactly (integer coords).
  const s0 = ds.sources[0];
  assert.equal(s0.lineName, '101'); assert.equal(s0.point, 200); assert.equal(s0.idx, '1');
  assert.ok(Math.abs(s0.easting - 660000) < 1e-6 && Math.abs(s0.northing - 3550000) < 1e-6, `E/N ${s0.easting},${s0.northing}`);
  assert.ok(Math.abs(s0.elevation - 120) < 1e-6, `elev ${s0.elevation}`);
  assert.equal(ds.sources[1].point, 202, 'second source point');
  // Receiver round-trip.
  assert.equal(dr.receivers[1].point, 12); assert.ok(Math.abs(dr.receivers[1].northing - 3551000) < 1e-6);
  // X relation ranges round-trip.
  const x0 = dx.xrefs[0];
  assert.equal(String(x0.srcLine), '101'); assert.equal(Number(x0.srcPt), 200);
  assert.equal(Number(x0.fromCh), 1); assert.equal(Number(x0.toCh), 2);
  assert.equal(String(x0.rcvLine), '500'); assert.equal(Number(x0.rcvPtFrom), 10); assert.equal(Number(x0.rcvPtTo), 12);
});

test('applyRenumberToData affine-renumbers points + lines and keeps every X relation resolvable', () => {
  const data: any = {
    sources: [mkSR('S', '101', 1, 660000, 3550000, 0), mkSR('S', '101', 2, 660025, 3550000, 0), mkSR('S', '101', 3, 660050, 3550000, 0)],
    receivers: [mkSR('R', '101', 1, 660000, 3550010, 0), mkSR('R', '101', 2, 660025, 3550010, 0), mkSR('R', '101', 3, 660050, 3550010, 0)],
    xrefs: [{
      tape: '', ffid: 1, srcLine: '101', srcPt: 2, srcIdx: '1', fromCh: 1, toCh: 3, chIncr: 1,
      rcvLine: '101', rcvPtFrom: 1, rcvPtTo: 3, rcvIdx: '1', rcvLineFrom: '101', rcvLineTo: '101', layout: 'SPS2.1',
    }],
    headers: [], errors: [], skipped: 0, layout: 'SPS2.1',
  };
  const maps = buildRenumberMaps(data, {
    source: { lineMap: { '101': '900' }, pointOffset: 1000 },
    receiver: { lineMap: { '101': '500' }, pointOffset: 5000 },
  });
  const nd = applyRenumberToData(data, maps);
  assert.equal(nd.sources[0].lineName, '900'); assert.equal(nd.sources[0].point, 1001);
  assert.equal(nd.receivers[0].lineName, '500'); assert.equal(nd.receivers[0].point, 5001);
  const nx = nd.xrefs[0];
  assert.equal(String(nx.srcLine), '900'); assert.equal(Number(nx.srcPt), 1002);
  assert.equal(String(nx.rcvLine), '500'); assert.equal(Number(nx.rcvPtFrom), 5001); assert.equal(Number(nx.rcvPtTo), 5003);

  // Round-trip through the writer/parser, then prove every X relation resolves + QC is error-free.
  const files = buildSPS(nd);
  const merged = combine(files[0].text, files[1].text, files[2].text);
  assert.equal(merged.sources.length, 3); assert.equal(merged.receivers.length, 3); assert.equal(merged.xrefs.length, 1);
  assert.equal(merged.sources[0].point, 1001, 'point renumber survived the round-trip');
  const srcKeys = new Set(merged.sources.map((s: any) => `${s.lineName}|${s.point}`));
  const rcvKeys = new Set(merged.receivers.map((r: any) => `${r.lineName}|${r.point}`));
  for (const x of merged.xrefs) {
    assert.ok(srcKeys.has(`${x.srcLine}|${Number(x.srcPt)}`), `X source missing: ${x.srcLine}|${x.srcPt}`);
    assert.ok(rcvKeys.has(`${x.rcvLine}|${Number(x.rcvPtFrom)}`), `X rcv-from missing: ${x.rcvLine}|${x.rcvPtFrom}`);
    assert.ok(rcvKeys.has(`${x.rcvLine}|${Number(x.rcvPtTo)}`), `X rcv-to missing: ${x.rcvLine}|${x.rcvPtTo}`);
  }
  assert.ok(!runSPSQC(merged, {}).some((r) => r.sev === 'error'), 'renumbered survey has no QC errors');
});

test('renumberSPSText splices only line/point columns — vendor tail + coords survive byte-for-byte', () => {
  let s = putCol('S'.padEnd(80, ' '), 1, '101');
  s = putCol(s, 11, '200'); s = putCol(s, 23, '1');
  s = putCol(s, 46, '660000.0'); s = putCol(s, 55, '3550000.0'); s = putCol(s, 65, '120.0');
  const raw = s + 'VENDORTAG'; // an extra non-modeled column past col 80
  const maps = buildRenumberMaps({ sources: [], receivers: [], xrefs: [], headers: [], errors: [], skipped: 0, layout: null } as any,
    { source: { lineMap: { '101': '999' }, pointOffset: 50 } });
  const outLine = renumberSPSText([raw], 'S', maps).split('\n')[0];
  assert.equal(outLine.substring(1, 11).trim(), '999', 'line renumbered');
  assert.equal(parseFloat(outLine.substring(11, 21)), 250, 'point = 200 + 50');
  assert.equal(outLine.substring(21), raw.substring(21), 'idx + coords + elev + vendor tail preserved byte-for-byte');
  assert.ok(outLine.endsWith('VENDORTAG'), 'trailing vendor column intact');
});

test('buildRenumberMaps rejects a non-monotonic (negative-scale) point remap', () => {
  assert.throws(() => buildRenumberMaps({ sources: [], receivers: [], xrefs: [], headers: [], errors: [], skipped: 0, layout: null } as any,
    { source: { pointScale: -1 } }), /monotonic/, 'negative pointScale must throw');
});

test('generateSPS 2D walks a straight line by arc length; round-trip + QC clean', () => {
  const d = generateSPS({ ...CREATE_DEFAULTS, mode: '2D', lines: [{ vertices: [{ e: 660000, n: 3550000 }, { e: 660100, n: 3550000 }] }] }, ITM_PROJ);
  // L=100, interval 25 → floor(100/25)+1 = 5 stations each.
  assert.equal(d.receivers.length, 5, `receivers ${d.receivers.length}`);
  assert.equal(d.sources.length, 5, `sources ${d.sources.length}`);
  assert.equal(d.receivers[0].point, 1000); assert.equal(d.receivers[4].point, 1008);
  assert.equal(d.receivers[0].lineName, '1000'); assert.equal(d.sources[0].lineName, '1000');
  assert.ok(Math.abs(d.receivers[2].easting - 660050) < 1e-9, `mid E ${d.receivers[2].easting}`);
  // full relation → one X per shot covering all 5 receivers.
  assert.equal(d.xrefs.length, 5, `xrefs ${d.xrefs.length}`);
  assert.equal(Number(d.xrefs[0].fromCh), 1); assert.equal(Number(d.xrefs[0].toCh), 5);
  assert.equal(Number(d.xrefs[0].rcvPtFrom), 1000); assert.equal(Number(d.xrefs[0].rcvPtTo), 1008);

  const files = buildSPS(d);
  const merged = combine(files[0].text, files[1].text, files[2].text);
  assert.equal(merged.sources.length, 5); assert.equal(merged.receivers.length, 5); assert.equal(merged.xrefs.length, 5);
  assert.ok(!runSPSQC(merged, {}).some((r) => r.sev === 'error'), 'generated 2D survey has no QC errors');
});

test('generateSPS 2D handles a crooked 3-vertex line (interpolated along the bend)', () => {
  // seg1 = 3-4-5 triangle → 50 m; seg2 = 100 m straight up → L = 150 m.
  const lines = [{ vertices: [{ e: 660000, n: 3550000 }, { e: 660030, n: 3550040 }, { e: 660030, n: 3550140 }] }];
  const d = generateSPS({ ...CREATE_DEFAULTS, mode: '2D', lines, rcvInterval: 50, srcInterval: 50 }, ITM_PROJ);
  assert.equal(d.receivers.length, 4, `receivers ${d.receivers.length}`); // 0,50,100,150
  assert.equal(d.sources.length, 4, `sources ${d.sources.length}`);
  // Station at arc-length 50 lands exactly on the bend vertex.
  assert.ok(Math.abs(d.receivers[1].easting - 660030) < 1e-6 && Math.abs(d.receivers[1].northing - 3550040) < 1e-6, `bend ${d.receivers[1].easting},${d.receivers[1].northing}`);
  // Station at arc-length 100 = 50 m up the second segment.
  assert.ok(Math.abs(d.receivers[2].easting - 660030) < 1e-6 && Math.abs(d.receivers[2].northing - 3550090) < 1e-6, `seg2 ${d.receivers[2].easting},${d.receivers[2].northing}`);
  assert.ok(Math.abs(d.receivers[3].northing - 3550140) < 1e-6, 'last station at the line end');
  const files = buildSPS(d);
  const merged = combine(files[0].text, files[1].text, files[2].text);
  assert.equal(merged.receivers.length, 4);
  assert.ok(!runSPSQC(merged, {}).some((r) => r.sev === 'error'), 'crooked-line survey has no QC errors');
});

test('generateSPS 2D split relation windows channels around the shot', () => {
  const d = generateSPS({
    ...CREATE_DEFAULTS, mode: '2D', lines: [{ vertices: [{ e: 660000, n: 3550000 }, { e: 661000, n: 3550000 }] }],
    rcvInterval: 100, srcInterval: 500, relation: { type: 'split', channels: 4 },
  }, ITM_PROJ);
  assert.equal(d.receivers.length, 11, `receivers ${d.receivers.length}`); // 0..1000 step 100
  assert.equal(d.sources.length, 3, `sources ${d.sources.length}`); // 0,500,1000
  assert.equal(d.xrefs.length, 3, `xrefs ${d.xrefs.length}`);
  for (const x of d.xrefs) assert.ok(Number(x.toCh) - Number(x.fromCh) + 1 <= 4, `split window ≤ 4 ch (got ${x.fromCh}..${x.toCh})`);
  const files = buildSPS(d);
  const merged = combine(files[0].text, files[1].text, files[2].text);
  assert.ok(!runSPSQC(merged, {}).some((r) => r.sev === 'error'), 'split survey has no QC errors');
});

// Three parallel E–W receiver lines, realistic ITM-scale coords (the SPS coord
// parser needs |E|/|N| > 1 to read fixed columns, so don't sit a station at 0,0):
// N = 3550000/3550300/3550600, each E 660000→661000.
const RCV_LINES_3D = [
  { vertices: [{ e: 660000, n: 3550000 }, { e: 661000, n: 3550000 }] },
  { vertices: [{ e: 660000, n: 3550300 }, { e: 661000, n: 3550300 }] },
  { vertices: [{ e: 660000, n: 3550600 }, { e: 661000, n: 3550600 }] },
];

test('generateSPS 3D builds perpendicular source lines (full template); round-trip + QC clean', () => {
  const d = generateSPS({
    ...CREATE_DEFAULTS, mode: '3D', lines: RCV_LINES_3D,
    rcvInterval: 50, srcInterval: 100, srcLineSpacing: 250, relation: { type: 'full' },
  }, ITM_PROJ);
  // Receivers: 3 lines × (1000/50+1 = 21) = 63.
  assert.equal(d.receivers.length, 63, `receivers ${d.receivers.length}`);
  assert.equal(d.receivers[0].lineName, '1000'); assert.equal(d.receivers[62].lineName, '1004');
  // Source lines ⟂ to the E–W bearing: floor(1000/250)+1 = 5 lines, each floor(600/100)+1 = 7 sources → 35.
  assert.equal(d.sources.length, 35, `sources ${d.sources.length}`);
  const byLine: Record<string, any[]> = {};
  for (const s of d.sources) (byLine[s.lineName] ||= []).push(s);
  const srcLineNames = Object.keys(byLine);
  assert.equal(srcLineNames.length, 5, `source lines ${srcLineNames.length}`);
  for (const nm of srcLineNames) {
    const ss = byLine[nm].slice().sort((a, b) => a.northing - b.northing);
    // A source line runs N–S (⟂ to the E–W receiver bearing): E const, N spans.
    assert.ok(Math.abs(ss[0].easting - ss[ss.length - 1].easting) < 1e-6, `source line ${nm} should be ⟂ (E const)`);
    assert.ok(ss[ss.length - 1].northing - ss[0].northing > 1, `source line ${nm} should span N`);
  }
  // Adjacent source lines are spaced srcLineSpacing (250) apart along E.
  const lineE = srcLineNames.map((nm) => byLine[nm][0].easting).sort((a, b) => a - b);
  assert.ok(Math.abs((lineE[1] - lineE[0]) - 250) < 1e-6, `SLI ${lineE[1] - lineE[0]}`);
  // Full template: 1 X row per receiver line per shot → 35 × 3 = 105; channels accumulate to 63.
  assert.equal(d.xrefs.length, 105, `xrefs ${d.xrefs.length}`);
  const shot1 = d.xrefs.filter((x) => Number(x.ffid) === 1);
  assert.equal(shot1.length, 3, 'full template: 3 rows for shot 1');
  assert.equal(Number(shot1[0].fromCh), 1); assert.equal(Number(shot1[2].toCh), 63);
  const files = buildSPS(d);
  const merged = combine(files[0].text, files[1].text, files[2].text);
  assert.equal(merged.sources.length, 35); assert.equal(merged.receivers.length, 63); assert.equal(merged.xrefs.length, 105);
  assert.ok(!runSPSQC(merged, {}).some((r) => r.sev === 'error'), 'generated 3D full survey has no QC errors');
});

test('generateSPS 3D moving-patch (split) limits each shot to patchLines × channels; round-trip + QC clean', () => {
  const d = generateSPS({
    ...CREATE_DEFAULTS, mode: '3D', lines: RCV_LINES_3D,
    rcvInterval: 50, srcInterval: 100, srcLineSpacing: 250, relation: { type: 'split', channels: 10, patchLines: 2 },
  }, ITM_PROJ);
  assert.equal(d.receivers.length, 63); assert.equal(d.sources.length, 35);
  const byFfid: Record<number, any[]> = {};
  for (const x of d.xrefs) (byFfid[Number(x.ffid)] ||= []).push(x);
  for (const rows of Object.values(byFfid)) {
    assert.ok(rows.length <= 2, `patch ≤ 2 receiver lines (got ${rows.length})`);
    for (const x of rows) assert.ok(Number(x.toCh) - Number(x.fromCh) + 1 <= 10, `≤ 10 channels (got ${x.fromCh}..${x.toCh})`);
  }
  assert.ok(d.xrefs.length > 0 && d.xrefs.length <= 35 * 2, `xrefs ${d.xrefs.length}`);
  const files = buildSPS(d);
  const merged = combine(files[0].text, files[1].text, files[2].text);
  assert.ok(!runSPSQC(merged, {}).some((r) => r.sev === 'error'), 'generated 3D split survey has no QC errors');
});

test('generateSPS 3D honours an explicit azimuthDeg + rejects bad 3D inputs', () => {
  // Two N–S receiver lines; azimuthDeg 0 (North) → source lines run E–W (⟂).
  const lines = [{ vertices: [{ e: 660500, n: 3550000 }, { e: 660500, n: 3551000 }] }, { vertices: [{ e: 660800, n: 3550000 }, { e: 660800, n: 3551000 }] }];
  const d = generateSPS({
    ...CREATE_DEFAULTS, mode: '3D', lines, azimuthDeg: 0,
    rcvInterval: 100, srcInterval: 100, srcLineSpacing: 250, relation: { type: 'full' },
  }, ITM_PROJ);
  const byLine: Record<string, any[]> = {};
  for (const s of d.sources) (byLine[s.lineName] ||= []).push(s);
  const first = Object.values(byLine)[0].slice().sort((a, b) => a.easting - b.easting);
  // E–W source line: N const, E spans.
  assert.ok(Math.abs(first[0].northing - first[first.length - 1].northing) < 1e-6, 'source line should be E–W (N const)');
  assert.ok(first[first.length - 1].easting - first[0].easting > 1, 'source line should span E');
  const files = buildSPS(d);
  const merged = combine(files[0].text, files[1].text, files[2].text);
  assert.ok(!runSPSQC(merged, {}).some((r) => r.sev === 'error'), 'azimuth 3D survey has no QC errors');
  // 3D guards: non-positive srcLineSpacing / channels must throw.
  assert.throws(() => generateSPS({ ...CREATE_DEFAULTS, mode: '3D', lines: RCV_LINES_3D, srcLineSpacing: 0 }, ITM_PROJ),
    /srcLineSpacing/, '3D rejects srcLineSpacing ≤ 0');
  assert.throws(() => generateSPS({ ...CREATE_DEFAULTS, mode: '3D', lines: RCV_LINES_3D, relation: { type: 'split', channels: 0, patchLines: 2 } }, ITM_PROJ),
    /channels/, '3D split rejects channels ≤ 0');
});

// ── IOGP P1/11 reader + writer (modern, comma-delimited, relational) ───────────
console.log('\n[p111]');
test('P1/11 parses CRS header + S/R point + relation records into SPSData', () => {
  const fixture = [
    'H,1,1,IOGP P1/11 v1.1,SeisConv',
    'H,PROJECT,Test Survey',
    'H,CRS,EPSG:2039,New Israeli Grid,TM,,',
    'H,ELLIPSOID,6378137,298.257222101,GRS 1980',
    'H,PROJPARAMS,35.20451694444,31.73439361111,1.0000067,219529.584,626907.39',
    'H,HELMERT,23.772,17.49,17.859,-0.313,-1.853,1.673,0',
    'H,UNITS,METRE,1.0',
    'P,S,101,200,1,179622.00,665896.00,120.0',
    'P,R,500,10,1,180622.00,666896.00,95.0',
    'P,R,500,11,1,180652.00,666926.00,96.0',
    'E,101,200,1001,500,10,11,1,2',
  ].join('\n');
  const d = parseP111(fixture);
  assert.equal(d.errors.length, 0, `errors: ${d.errors.join('; ')}`);
  assert.equal(d.skipped, 0, `skipped ${d.skipped}`);
  assert.equal(d.sources.length, 1, `sources ${d.sources.length}`);
  assert.equal(d.receivers.length, 2, `receivers ${d.receivers.length}`);
  assert.equal(d.xrefs.length, 1, `xrefs ${d.xrefs.length}`);
  assert.equal(d.sources[0].lineName, '101');
  assert.equal(d.sources[0].point, 200);
  assert.equal(d.sources[0].idx, '1');
  assert.ok(Math.abs(d.sources[0].easting - 179622) < 1e-6, `E ${d.sources[0].easting}`);
  assert.ok(Math.abs(d.sources[0].northing - 665896) < 1e-6, `N ${d.sources[0].northing}`);
  assert.ok(Math.abs(d.sources[0].elevation - 120) < 1e-6, `Z ${d.sources[0].elevation}`);
  assert.equal(d.receivers[1].point, 11);
  // CRS recovered into the SPSProjection model (reusing the SPS KNOWN-CRS handling).
  assert.equal(d.projection?.subtype, 'TM', `subtype ${d.projection?.subtype}`);
  const lat0 = d.projection?.latOrigin ?? 0;
  assert.ok(lat0 > 31 && lat0 < 32, `latOrigin ${lat0}`);
  // Relation fields.
  assert.equal(String(d.xrefs[0].srcLine), '101');
  assert.equal(Number(d.xrefs[0].rcvPtTo), 11);
  // Dispatch + detection agree on the format.
  assert.equal(detectPositioningFormat('survey.p111', fixture), 'p111');
  const viaDispatch = parsePositioning('p111', fixture);
  assert.equal(viaDispatch.kind, 'points');
});

test('P1/11 round-trips parse → build → parse stably on the points', () => {
  const fixture = [
    'H,CRS,EPSG:2039,New Israeli Grid,TM,,',
    'H,ELLIPSOID,6378137,298.257222101,GRS 1980',
    'H,PROJPARAMS,35.20451694444,31.73439361111,1.0000067,219529.584,626907.39',
    'H,HELMERT,23.772,17.49,17.859,-0.313,-1.853,1.673,0',
    'H,UNITS,METRE,1.0',
    'P,S,101,200,1,179622.00,665896.00,120.0',
    'P,R,500,10,1,180622.00,666896.00,95.0',
    'P,R,500,11,1,180652.00,666926.00,96.0',
  ].join('\n');
  const a = parseP111(fixture);
  const files = buildP111(a);
  assert.equal(files.length, 1, `expected 1 file, got ${files.length}`);
  const b = parseP111(files[0].text);
  assert.equal(b.sources.length, a.sources.length, 'source count drifted');
  assert.equal(b.receivers.length, a.receivers.length, 'receiver count drifted');
  const cmp = (x: typeof a.sources, y: typeof b.sources) => {
    for (let i = 0; i < x.length; i++) {
      assert.equal(y[i].lineName, x[i].lineName, `lineName[${i}]`);
      assert.equal(y[i].point, x[i].point, `point[${i}]`);
      assert.equal(y[i].idx, x[i].idx, `idx[${i}]`);
      assert.ok(Math.abs(y[i].easting - x[i].easting) < 1e-3, `E[${i}] ${y[i].easting} vs ${x[i].easting}`);
      assert.ok(Math.abs(y[i].northing - x[i].northing) < 1e-3, `N[${i}] ${y[i].northing} vs ${x[i].northing}`);
      assert.ok(Math.abs(y[i].elevation - x[i].elevation) < 1e-3, `Z[${i}]`);
    }
  };
  cmp(a.sources, b.sources);
  cmp(a.receivers, b.receivers);
  // The writer fills geodetic lat/long columns (proj is resolvable) — re-parse
  // ignores the extra columns but the E/N stay byte-stable, proving the round-trip.
  assert.ok(/,P,/.test('\n,' + files[0].text) || files[0].text.includes('P,S,'), 'P records present');
});

test('P1/11 never throws on malformed input — collects errors/skipped', () => {
  const junk = [
    'P,S,101,200,1,NOTANUMBER,665896.00,120.0', // bad E/N → skipped
    'P,Q,1,1,1,1,1,1', // unknown point type → skipped
    'Z,garbage,record', // unknown tag → skipped
    'P,R,500,10,1,180622.00,666896.00,95.0', // valid
  ].join('\n');
  let d: ReturnType<typeof parseP111> | undefined;
  assert.doesNotThrow(() => { d = parseP111(junk); }, 'parseP111 threw');
  assert.ok(d!.skipped >= 3, `expected ≥3 skipped, got ${d!.skipped}`);
  assert.equal(d!.receivers.length, 1, 'the one valid record survived');
});

// ── SEG-P1 reader (deprecated format, read-only) ───────────────────────────────
console.log('\n[segp1]');
test('SEG-P1 parses fixed-column points (E/N decimetres→m), packed lat/long, and UTM header', () => {
  // Place text at a fixed 0-based start within an 80-col record.
  const put = (line: string, start: number, txt: string) => {
    const padded = line.padEnd(Math.max(line.length, start + txt.length), ' ');
    return padded.slice(0, start) + txt + padded.slice(start + txt.length);
  };
  // SEG-P1 columns (0-based): line 1-16, point 17-24, reshoot 25, lat 26-34,
  // long 35-44, easting 45-52 (dm), northing 53-60 (dm), elevation 61-65 (dm).
  const mk = (line: string, pt: string, lat: string, lon: string, e: string, n: string, z: string) => {
    let s = ' '.padEnd(80, ' ');     // blank record-id → shotpoint (source)
    s = put(s, 1, line);
    s = put(s, 17, pt);
    s = put(s, 26, lat);
    s = put(s, 35, lon);
    s = put(s, 45, e);
    s = put(s, 53, n);
    s = put(s, 61, z);
    return s.slice(0, 80);
  };
  // UTM zone 36N header + two points. Easting 6600000 dm = 660000.0 m, etc.
  const h1 = 'H SURVEY TEST LINE — SEG-P1 EXPORT';
  const h2 = 'H GRID: UTM ZONE 36 NORTH  DATUM WGS-84';
  // lat "ddmmssssh" = 9 chars (SSss = seconds in hundredths); lon "dddmmssssh" = 10.
  // point 1: lat 32°05'07.20"N, lon 034°46'54.48"E
  const p1 = mk('1001', '101', '32050720N', '034465448E', '06600000', '35500000', '01200');
  const p2 = mk('1001', '102', '32060000N', '034470000E', '06600100', '35500100', '00950');
  const segp1 = parseSegP1([h1, h2, p1, p2].join('\n'));

  assert.equal(segp1.skipped, 0, `skipped ${segp1.skipped}: ${segp1.errors.join('; ')}`);
  assert.equal(segp1.sources.length, 2, `sources ${segp1.sources.length}`);
  assert.equal(segp1.receivers.length, 0, `receivers ${segp1.receivers.length}`);
  assert.equal(segp1.layout, 'SEG-P1');

  const s0 = segp1.sources[0];
  assert.equal(s0.lineName, '1001', `lineName ${s0.lineName}`);
  assert.equal(s0.point, 101, `point ${s0.point}`);
  // 06600000 dm / 10 = 660000.0 m
  assert.ok(Math.abs(s0.easting - 660000) < 1e-6, `E ${s0.easting}`);
  assert.ok(Math.abs(s0.northing - 3550000) < 1e-6, `N ${s0.northing}`);
  // 01200 dm / 10 = 120.0 m
  assert.ok(Math.abs(s0.elevation - 120) < 1e-6, `Z ${s0.elevation}`);
  assert.ok(Math.abs(segp1.sources[1].easting - 660010) < 1e-6, `E1 ${segp1.sources[1].easting}`);

  // Header → projection: UTM zone 36N.
  assert.equal(segp1.projection?.subtype, 'UTM', `subtype ${segp1.projection?.subtype}`);
  assert.equal(segp1.projection?.zone, 36, `zone ${segp1.projection?.zone}`);
  assert.equal(segp1.projection?.hemi, 'N', `hemi ${segp1.projection?.hemi}`);
  console.log(`      golden: SEG-P1 src0 E=${s0.easting} N=${s0.northing} Z=${s0.elevation} zone=${segp1.projection?.zone}`);
});

test('SEG-P1 never throws on malformed/garbage lines (collects skipped, keeps going)', () => {
  const good = ' ' + 'L1'.padEnd(16) + '1'.padStart(8) + ' ' + ' '.repeat(9) + ' '.repeat(10) + '00012340' + '00056780' + '00100';
  const garbage = 'qwertyuiopasdfghjkl zxcvbnm not a record at all';
  let segp1: any;
  assert.doesNotThrow(() => { segp1 = parseSegP1([good, garbage, '', '   '].join('\n')); }, 'parseSegP1 threw');
  assert.ok(Array.isArray(segp1.errors), 'returns SPSData with errors[]');
  // The good line has a usable easting/northing; the garbage line has no point and
  // no grid/geo → skipped.
  assert.ok(segp1.sources.length + segp1.receivers.length >= 1, 'parsed the valid record');
  assert.ok(segp1.skipped >= 1, `garbage not skipped (skipped=${segp1.skipped})`);
});

test('SEG-P1 honours the MAX header cap without throwing', () => {
  // An all-'H' file far exceeding the 20-record block must not blow up.
  const many = Array.from({ length: 5000 }, (_, i) => `H header line ${i}`).join('\n');
  let segp1: any;
  assert.doesNotThrow(() => { segp1 = parseSegP1(many); }, 'parseSegP1 threw on huge header block');
  assert.ok(segp1.headers.length <= 4096, `headers not capped: ${segp1.headers.length}`);
  assert.equal(segp1.sources.length + segp1.receivers.length, 0, 'no points from a header-only file');
});

test('SEG-P1 geographic-only record (blank grid E/N) is PROJECTED to E/N, not lost at (0,0)', () => {
  const put = (line: string, start: number, txt: string) => {
    const padded = line.padEnd(Math.max(line.length, start + txt.length), ' ');
    return padded.slice(0, start) + txt + padded.slice(start + txt.length);
  };
  // A record carrying ONLY lat/long (grid E/N columns left blank).
  let rec = ' '.padEnd(80, ' ');
  rec = put(rec, 1, '2001');           // line name
  rec = put(rec, 17, '7');             // point
  rec = put(rec, 26, '32050720N');     // lat 32°05'07.20"N
  rec = put(rec, 35, '034465448E');    // lon 034°46'54.48"E
  // cols 45-65 (E/N/Z) intentionally left blank.
  const h1 = 'H GRID: UTM ZONE 36 NORTH  DATUM WGS-84';
  const d = parseSegP1([h1, rec.slice(0, 80)].join('\n'));
  assert.equal(d.skipped, 0, `skipped ${d.skipped}: ${d.errors.join('; ')}`);
  assert.equal(d.sources.length, 1, `sources ${d.sources.length}`);
  const s = d.sources[0];
  // Geographic coords survive on the point.
  assert.ok(s.lat != null && Math.abs(s.lat - (32 + 5 / 60 + 7.2 / 3600)) < 1e-6, `lat ${s.lat}`);
  assert.ok(s.lon != null && Math.abs(s.lon - (34 + 46 / 60 + 54.48 / 3600)) < 1e-6, `lon ${s.lon}`);
  // Projected to E/N in UTM 36N — NOT (0,0). Cross-check with the coords engine.
  const en = latLonToUTM(s.lat!, s.lon!, 36, 'N');
  assert.ok(Math.abs(s.easting - en.E) < 1e-3 && Math.abs(s.northing - en.N) < 1e-3, `E/N ${s.easting},${s.northing} vs ${en.E},${en.N}`);
  assert.ok(s.easting !== 0 && s.northing !== 0, 'not dropped at (0,0)');
});

test('SEG-P1 grid E/N in F-format float metres are NOT divided by 10', () => {
  const put = (line: string, start: number, txt: string) => {
    const padded = line.padEnd(Math.max(line.length, start + txt.length), ' ');
    return padded.slice(0, start) + txt + padded.slice(start + txt.length);
  };
  // Float-metres E/N (decimal point present): '660000.0' must stay 660000, not 66000.
  let rec = ' '.padEnd(80, ' ');
  rec = put(rec, 1, '3001');
  rec = put(rec, 17, '5');
  rec = put(rec, 45, '660000.0');
  rec = put(rec, 53, '3550000.');
  const d = parseSegP1(rec.slice(0, 80));
  assert.equal(d.sources.length, 1, `sources ${d.sources.length}`);
  assert.ok(Math.abs(d.sources[0].easting - 660000) < 1e-6, `float E ${d.sources[0].easting}`);
  assert.ok(Math.abs(d.sources[0].northing - 3550000) < 1e-6, `float N ${d.sources[0].northing}`);
});

test('semblance returns a valid [0,1] matrix with a coherent peak', () => {
  const traces: any[] = [];
  for (let k = 0; k < 12; k++) {
    const s = new Float32Array(200);
    s[100] = 1; // flat spike across the gather
    traces.push({ hdr: {}, samples: s, nSamples: 200 });
  }
  const r = computeSemblance(traces, 2000, 4000, 6000, 500);
  assert.equal(r.vels.length, 5);
  assert.equal(r.semb.length, 5 * 200);
  let max = 0;
  for (const v of r.semb) {
    assert.ok(Number.isFinite(v), 'no NaN in semblance');
    if (v > max) max = v;
  }
  assert.ok(max > 0.5 && max <= 1.0001, `peak semblance ${max}`);
});

console.log('\n[spectrum]');
test('nextPow2 rounds up to a power of two', () => {
  assert.equal(nextPow2(1), 1);
  assert.equal(nextPow2(2), 2);
  assert.equal(nextPow2(3), 4);
  assert.equal(nextPow2(1000), 1024);
});

test('fft∘ifft round-trips a random signal (< 1e-9)', () => {
  const N = 64;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const orig = new Float64Array(N);
  for (let i = 0; i < N; i++) { re[i] = Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1); orig[i] = re[i]; }
  fft(re, im, false);
  fft(re, im, true);
  let maxErr = 0;
  for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(re[i] - orig[i]), Math.abs(im[i]));
  assert.ok(maxErr < 1e-9, `round-trip error ${maxErr}`);
});

test('amplitudeSpectrum peaks at the input frequency with correct amplitude', () => {
  const N = 512;
  const fs = 500; // Hz → siUs = 2000
  const f0 = 62.5; // Hz — lands exactly on bin 64 (fs/N = 0.9766 Hz)
  const amp0 = 1; // unit-amplitude cosine
  const s = new Float32Array(N);
  for (let i = 0; i < N; i++) s[i] = amp0 * Math.cos((2 * Math.PI * f0 * i) / fs);
  const sp = amplitudeSpectrum(s, 2000);
  assert.equal(sp.freqs.length, N / 2);
  assert.ok(Math.abs(sp.nyquist - 250) < 1e-6, `nyquist ${sp.nyquist}`);
  let max = 0, peakK = 0;
  for (let k = 0; k < sp.amp.length; k++) {
    assert.ok(Number.isFinite(sp.amp[k]), 'no NaN in spectrum');
    if (sp.amp[k] > max) { max = sp.amp[k]; peakK = k; }
  }
  const binHz = fs / N;
  assert.ok(Math.abs(sp.freqs[peakK] - f0) < binHz, `peak at ${sp.freqs[peakK]} Hz, expected ${f0}`);
  assert.ok(Math.abs(max - amp0) < 0.05, `peak amplitude ${max}, expected ~${amp0}`);
  console.log(`      peak ${sp.freqs[peakK].toFixed(1)} Hz (amp ${max.toFixed(3)})`);
});

// ── Robustness: variable-length traces + truncated/garbage buffers ────────────
// Regression for the batch-convert crash "Offset is outside the bounds of the
// DataView": the writers sized the output buffer from the FIRST trace's sample
// count but wrote each trace's own count, overrunning whenever a later trace was
// longer than the first. Parsers must also never throw on a truncated buffer.
console.log('\n[robustness]');

/** Build an in-memory ParsedFile with the given per-trace sample counts (ramps). */
function mkPF(sampleCounts: number[]): any {
  const traces = sampleCounts.map((n, t) => {
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = (t + 1) * 1000 + i; // distinct, exact-in-float32 values
    return { hdr: {}, samples: s, nSamples: n, dataFmt: 5 };
  });
  return { format: 'SEG-Y', revision: 0, bh: { sampleInt: 2000, samplesTrace: sampleCounts[0] }, traceCount: traces.length, errors: [], traces };
}

test('writeSEGY does NOT overrun when a later trace is longer than the first', () => {
  // short first trace (aux/timebreak) followed by full-length data traces — the
  // exact shape that threw "Offset is outside the bounds of the DataView" before
  // the fix (buffer sized from trc[0]=10, write loop ran out to 2001).
  const counts = [10, 2001, 2001, 2001];
  const pf = mkPF(counts);
  let out: Uint8Array = new Uint8Array();
  assert.doesNotThrow(() => { out = writeSEGY(pf, 1); }, 'writeSEGY threw on variable-length traces');
  // Buffer must be sized for the LONGEST trace (2001), in fixed-stride slots.
  const maxN = Math.max(...counts);
  const tsz = 240 + maxN * 4;
  assert.equal(out.length, 3600 + counts.length * tsz, 'buffer sized for the longest trace');
  // Each trace's samples must actually be in its slot (read slot 0 directly,
  // since the short first trace makes header-driven re-parse ambiguous).
  for (let t = 0; t < counts.length; t++) {
    const base = 3600 + t * tsz + 240;
    for (let i = 0; i < counts[t]; i++) {
      assert.equal(rIEEE(out, base + i * 4), pf.traces[t].samples![i], `trace ${t} sample ${i}`);
    }
  }
});

test('writeSEGY stays bit-identical for uniform traces (longest == first)', () => {
  const pf = mkPF([100, 100, 100]);
  const out = writeSEGY(pf, 1);
  const re = parseSEGY(out);
  assert.equal(re.traceCount, 3);
  for (let t = 0; t < 3; t++) {
    assert.ok(samplesEqual(pf.traces[t].samples, re.traces[t].samples, 100), `trace ${t} identical`);
  }
});

test('parseSEGY sampleTraceCap bounds which traces get SAMPLES (header kept for all)', () => {
  // 6 uniform traces. The cap decides how many traces decode their samples into
  // memory (the worker raises it for a size-bounded in-memory file so the viewer
  // doesn't go blank past the default 2000-trace preview cap); a header is still
  // kept for EVERY trace either way.
  const out = writeSEGY(mkPF([8, 8, 8, 8, 8, 8]), 1);
  const low = parseSEGY(out, 2); // cap 2 → only the first 2 traces carry samples
  assert.equal(low.traceCount, 6, 'all 6 traces walked (headers kept)');
  assert.ok(low.traces[0].samples && low.traces[1].samples, 'traces under the cap have samples');
  assert.equal(low.traces[2].samples, null, 'trace at the cap has no samples');
  assert.equal(low.traces[5].samples, null, 'deep trace beyond the cap has no samples');
  const full = parseSEGY(out, 1000); // raised cap → every trace carries samples
  assert.equal(full.traceCount, 6, 'all 6 traces walked');
  for (let t = 0; t < 6; t++) assert.ok(full.traces[t].samples, `trace ${t} decoded with a raised cap`);
  // Default (no cap arg) is unchanged: small files (< 2000 traces) decode fully.
  assert.ok(parseSEGY(out).traces[5].samples, 'default cap decodes a small file fully');
});

test('writeSU does NOT overrun when a later trace is longer than the first', () => {
  const counts = [5, 300, 300];
  const pf = mkPF(counts);
  let su: Uint8Array = new Uint8Array();
  assert.doesNotThrow(() => { su = writeSU(pf); }, 'writeSU threw on variable-length traces');
  const maxN = Math.max(...counts);
  const tsz = 240 + maxN * 4;
  assert.equal(su.length, counts.length * tsz, 'SU buffer sized for the longest trace');
  // Verify each trace's samples landed in its fixed-stride slot.
  for (let t = 0; t < counts.length; t++) {
    const base = t * tsz + 240;
    for (let i = 0; i < counts[t]; i++) {
      assert.equal(rIEEE(su, base + i * 4), pf.traces[t].samples![i], `SU trace ${t} sample ${i}`);
    }
  }
});

test('parseSEGY does NOT throw on a buffer truncated mid-trace (degrades gracefully)', () => {
  // Make a valid 3-trace SEG-Y, then cut it 50 bytes into the last trace's data.
  const full = writeSEGY(mkPF([100, 100, 100]), 1);
  const cut = full.slice(0, full.length - 50);
  let pf: any;
  assert.doesNotThrow(() => { pf = parseSEGY(cut); }, 'parseSEGY threw on truncated buffer');
  assert.ok(Array.isArray(pf.errors), 'returns a ParsedFile with errors[]');
  assert.ok(pf.traceCount >= 2, `kept the intact traces (got ${pf.traceCount})`);
});

test('parseSU does NOT throw on a buffer truncated mid-samples', () => {
  const full = writeSU(mkPF([200, 200]));
  const cut = full.slice(0, full.length - 123); // chop into the 2nd trace's samples
  let pf: any;
  assert.doesNotThrow(() => { pf = parseSU(cut); }, 'parseSU threw on truncated buffer');
  assert.ok(Array.isArray(pf.errors) && Array.isArray(pf.traces), 'returns a ParsedFile');
});

test('parseAny does NOT throw on garbage / mis-detection-prone bytes', () => {
  // (a) random short buffer; (b) a 3600+ byte buffer whose byte0 is not a 'C'
  // (would-be SEG-D BCD bait) — must still return a ParsedFile, never throw.
  const garbage = new Uint8Array(64);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) & 0xff;
  assert.doesNotThrow(() => {
    const pf = parseAny(garbage, 'junk.bin');
    assert.ok(Array.isArray(pf.errors), 'garbage → ParsedFile');
  }, 'parseAny threw on garbage');

  const big = new Uint8Array(4000); // all-zero header, ns fields = 0 → no valid traces
  assert.doesNotThrow(() => {
    const pf = parseAny(big, 'zero.sgy');
    assert.ok(Array.isArray(pf.traces) && Array.isArray(pf.errors), 'zero-buffer → ParsedFile');
  }, 'parseAny threw on zero buffer');
});

// ── Writers (new outputs: SEG-Y Rev 2, SEG-2, SEG-D, Tape Image, CSV) ─────────
// Each writer is exercised offline against a synthetic ParsedFile (mkPF), so the
// suite stays deterministic whether or not the D: sample data is present.
console.log('\n[writers]');

test('writeSEGY Rev 2 → parseSEGY re-parses with revision 2 (sample-exact)', () => {
  const pf = mkPF([100, 100, 100]);
  const out = writeSEGY(pf, 2);
  const re = parseSEGY(out);
  assert.equal(re.errors.length, 0, `errors: ${re.errors.join('; ')}`);
  assert.equal(re.revision, 2, 'Rev 2 marker honoured');
  assert.equal(re.traceCount, 3, 'trace count preserved');
  assert.ok(samplesEqual(pf.traces[0].samples, re.traces[0].samples, 100), 'trace-0 samples identical');
});

// ── CSV / ASCII export (write-only) ────────────────────────────────────────────
console.log('\n[csv]');
test('writeCSV emits preamble, header row, and one row per sample (right column count)', () => {
  const pf: any = {
    format: 'SEG-Y', revision: 0,
    bh: { sampleInt: 2000, samplesTrace: 3 },
    traceCount: 2, errors: [],
    traces: [
      { hdr: {}, samples: Float32Array.from([1.5, 2.5, 3.5]), nSamples: 3 },
      { hdr: {}, samples: Float32Array.from([10, 20]), nSamples: 2 }, // shorter trace
    ],
  };
  const txt = new TextDecoder().decode(writeCSV(pf));
  const lines = txt.trim().split('\n');
  // preamble is '#'-commented
  assert.ok(lines[0].startsWith('# SeisConv CSV export'), `preamble: ${lines[0]}`);
  // header row: 'sample,time_ms,t1,t2' → 2 fixed + 2 trace columns
  const hIdx = lines.findIndex((l) => l.startsWith('sample,'));
  assert.ok(hIdx >= 0, 'header row present');
  assert.equal(lines[hIdx], 'sample,time_ms,t1,t2', `header: ${lines[hIdx]}`);
  assert.equal(lines[hIdx].split(',').length, 4, 'header has 4 columns');
  // first data row: sample 0, time 0 ms, both trace amplitudes
  assert.equal(lines[hIdx + 1], '0,0,1.5,10', `row0: ${lines[hIdx + 1]}`);
  assert.equal(lines[hIdx + 1].split(',').length, 4, 'data row has 4 columns');
  // last row: shorter trace t2 produces a trailing blank cell; time = 2*2000/1000 = 4 ms
  assert.equal(lines[hIdx + 3], '2,4,3.5,', `last row: ${lines[hIdx + 3]}`);
});

// ── SEG-2 writer round-trip ───────────────────────────────────────────────
console.log('\n[SEG-2 writer]');
test('writeSEG2 → parseSEG2 round-trips traceCount and trace-0 samples', () => {
  const ramp = (t: number, nn: number) => {
    const s = new Float32Array(nn);
    for (let i = 0; i < nn; i++) s[i] = (t + 1) * 1000 + i + 0.5;
    return s;
  };
  const counts = [8, 256, 256]; // short first trace + full-length data traces
  const traces = counts.map((nn, t) => ({ hdr: { channelNum: t + 1 }, samples: ramp(t, nn), nSamples: nn, dataFmt: 4 }));
  const pf: any = { format: 'SEG-2', revision: 1, bh: { sampleInt: 2000, samplesTrace: counts[0] }, traceCount: traces.length, errors: [], traces };
  const out = writeSEG2(pf);
  const re = parseSEG2(out);
  assert.equal(re.errors.length, 0, `errors: ${re.errors.join('; ')}`);
  assert.equal(re.traceCount, pf.traceCount, 'trace count preserved');
  const n = pf.traces[0].nSamples;
  let maxErr = 0;
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(re.traces[0].samples![i] - pf.traces[0].samples![i]));
  assert.ok(maxErr < 1e-3, `trace-0 samples within float tolerance (maxErr ${maxErr})`);
});

// ── SEG-D writer (round-trip) ──────────────────────────────────────────────
console.log('\n[SEG-D writer]');
test('writeSEGD Rev 1 → detect() = SEG-D and re-parses to >0 traces (sample-exact)', () => {
  const pf = mkPF([100, 100, 100]);
  const out = writeSEGD(pf, false);
  assert.equal(detect(out), 'SEG-D', 'detect identifies SEG-D');
  const re = parseSEGD(out);
  assert.equal(re.errors.length, 0, `errors: ${re.errors.join('; ')}`);
  assert.equal(re.traceCount, 3, 'trace count preserved');
  assert.ok(samplesEqual(pf.traces[0].samples, re.traces[0].samples, 100), 'trace-0 samples identical');
});
test('writeSEGD Rev 3 → detect() = SEG-D, revision 3, re-parses to >0 traces', () => {
  const pf = mkPF([100, 100, 100]);
  const out = writeSEGD(pf, true);
  assert.equal(detect(out), 'SEG-D', 'detect identifies SEG-D');
  const re = parseSEGD(out);
  assert.equal(re.errors.length, 0, `errors: ${re.errors.join('; ')}`);
  assert.equal(re.revision, 3, 'Rev 3 marker honoured');
  assert.ok(re.traceCount > 0, 'expected > 0 traces');
  assert.ok(samplesEqual(pf.traces[2].samples, re.traces[2].samples, 100), 'trace-2 samples identical');
});

test('writeSEGD round-trips si=500 µs, file number and receiver line/point (both revs)', () => {
  for (const rev3 of [false, true]) {
    const pf = mkPF([64, 64]);
    pf.bh.sampleInt = 500;
    pf.gh1 = { fileNum: 42 };
    pf.traces.forEach((tr: any, i: number) => { tr.hdr = { rcvLine: 399, rcvPoint: 101 + i, rcvIdx: 1 }; });
    const re = parseSEGD(writeSEGD(pf, rev3));
    const tag = rev3 ? 'rev3' : 'rev1';
    assert.equal(re.errors.length, 0, `${tag} errors: ${re.errors.join('; ')}`);
    assert.equal(re.revision, rev3 ? 3 : 1, `${tag} revision`);
    assert.equal(re.bh.sampleInt, 500, `${tag} sample interval round-trips exactly`);
    assert.equal(re.gh1!.fileNum, 42, `${tag} file number`);
    assert.equal(re.traces[0].hdr.rcvLine, 399, `${tag} receiver line`);
    assert.equal(re.traces[1].hdr.rcvPoint, 102, `${tag} receiver point`);
    assert.ok(samplesEqual(pf.traces[0].samples, re.traces[0].samples, 64), `${tag} samples identical`);
  }
});

// ── SEG-D real-layout fixture (mirrors the verified iX1 NT structure) ────────
/** Synthetic SEG-D in the REAL iX1 NT layout at reduced size: spec GH1 offsets,
 *  GH2 (revision / extended record length / 0xFF-indirected external count),
 *  GH3 (rev 2.1), 32/96-byte channel-set descriptor, external header blocks and
 *  per-trace demux headers with 2 (rev 2.1) / 1 (rev 3) trace-header extensions. */
function mkIX1SEGD(rev3: boolean): Uint8Array {
  const ns = 5, ntr = 2;
  const the = rev3 ? 1 : 2;
  const ghBlocks = rev3 ? 2 : 3;
  const csd = rev3 ? 96 : 32;
  const extl = rev3 ? 1 : 2; // external header blocks (count via GH2 indirection)
  const dataStart = ghBlocks * 32 + csd + extl * 32;
  const b = new Uint8Array(dataStart + ntr * (20 + the * 32 + ns * 4));
  const dvv = new DataView(b.buffer);
  // GH1 (spec offsets)
  b[0] = 0x00; b[1] = 0x07; // file number 0007 (BCD)
  b[2] = 0x80; b[3] = 0x58; // format 8058 = 32-bit IEEE demux
  b[10] = 0x26; // year 26
  b[11] = ((rev3 ? 0xf : ghBlocks - 1) << 4) | 1; // additional GH blocks | julian-day hundreds
  b[12] = 0x81; // julian day 181
  b[13] = 0x12; b[14] = 0x34; b[15] = 0x56;
  b[22] = 0x08; // base scan interval: 8/16 ms = 500 µs
  b[25] = 0x8f; b[26] = 0xff; // record type 8 | record length 0xFFF → extended
  b[27] = 0x01; b[28] = 0x01; // 1 scan type × 1 channel set
  b[31] = 0xff; // external header count → GH2
  // GH2
  const g = 32;
  const recUs = (ns - 1) * 500; // 2000 µs
  b[g + 10] = rev3 ? 3 : 2; b[g + 11] = rev3 ? 0 : 1; // revision 3.0 / 2.1
  if (rev3) {
    b[g + 18] = (recUs >> 8) & 0xff; b[g + 19] = recUs & 0xff; // ext record length (µs, 48-bit BE)
    b[g + 23] = 1; // additional GH blocks (rev-3 true count)
    b[g + 29] = extl; // external header blocks (GH2[28-29])
  } else {
    b[g + 8] = extl; // external header blocks (GH2[7-8])
    b[g + 16] = Math.round(recUs / 1000); // ext record length (ms, GH2[14-16])
    b[g + 18] = 2; // GH block number
    b[64 + 18] = 3; // GH3 block number
  }
  // Channel-set descriptor
  const c = ghBlocks * 32;
  if (rev3) {
    b[c] = 1; b[c + 2] = 1; b[c + 3] = 0x10; // scan type / set 1 / seismic
    dvv.setUint32(c + 8, recUs, false); // end time (µs)
    dvv.setUint32(c + 12, ns, false); // number of samples
    b[c + 22] = ntr; // number of channels (24-bit)
    b[c + 24] = 0x01; b[c + 25] = 0xf4; // sampling interval 500 µs (24-bit at [23-25])
    b[c + 27] = the;
  } else {
    b[c] = 0x01; b[c + 1] = 0x01; // scan type / set 1 (BCD)
    b[c + 5] = Math.round(recUs / 2000); // end time in 2-ms units
    b[c + 9] = 0x02; // 0002 channels (BCD)
    b[c + 10] = 0x10; // seismic
    b[c + 28] = the;
  }
  // Demux trace records
  let off = dataStart;
  for (let t = 0; t < ntr; t++) {
    b[off + 1] = 0x07; // file number 0007
    b[off + 2] = 0x01; b[off + 3] = 0x01; // scan type / channel set
    b[off + 5] = t + 1; // trace number (BCD)
    b[off + 9] = the;
    const e = off + 20;
    if (rev3) {
      for (let i = 0; i < 6; i++) b[e + i] = 0xff; // legacy line/point undefined
      b[e + 6] = 1;
      b[e + 11] = 0x01; b[e + 12] = 0x8f; // extended receiver line 399 ([10-12])
      b[e + 17] = 0xfd; // extended receiver point 253 ([15-17])
      dvv.setUint32(e + 24, ns, false); // ns (32-bit, rev-3 home)
    } else {
      b[e + 1] = 0x01; b[e + 2] = 0x8f; // receiver line 399 ([0-2])
      b[e + 5] = 0xfd; // receiver point 253 ([3-5])
      b[e + 6] = 1;
      b[e + 9] = ns; // ns (24-bit at [7-9])
    }
    const dOff = e + the * 32;
    for (let i = 0; i < ns; i++) dvv.setFloat32(dOff + i * 4, (t + 1) * 10 + i * 0.5, false);
    off = dOff + ns * 4;
  }
  return b;
}

test('parseSEGD decodes the real iX1 rev 2.1 layout (GH2/GH3, external blocks, 2×THE)', () => {
  const fx = mkIX1SEGD(false);
  assert.equal(detect(fx), 'SEG-D', 'fixture detects as SEG-D');
  const re = parseSEGD(fx);
  assert.equal(re.errors.length, 0, `errors: ${re.errors.join('; ')}`);
  assert.equal(re.revision, 2, 'revision 2 from GH2');
  assert.equal(re.gh1!.revMinor, 1, 'minor revision 1');
  assert.equal(re.traceCount, 2, 'both channels segmented (not one mega-trace)');
  assert.equal(re.bh.sampleInt, 500, 'base scan interval 0x08 → 500 µs');
  assert.equal(re.traces[0].nSamples, 5, 'ns from THE1');
  assert.equal(re.traces[0].hdr.fieldRec, 7, 'FFID from the file number');
  assert.equal(re.traces[0].hdr.rcvLine, 399, 'receiver line from THE1');
  assert.equal(re.traces[0].hdr.rcvPoint, 253, 'receiver point from THE1');
  assert.equal(re.traces[1].hdr.trcNum, 2, 'trace number (BCD)');
  assert.equal(re.traces[1].samples![4], 22, 'samples at the true offset (multi-THE stride)');
  assert.equal(re.gh1!.year, 2026, 'year at spec byte 10');
  assert.equal(re.gh1!.julDay, 181, 'julian day nibbles');
});

test('parseSEGD decodes the real iX1 rev 3.0 layout (96-byte CSD, GH2 counts, 32-bit ns)', () => {
  const re = parseSEGD(mkIX1SEGD(true));
  assert.equal(re.errors.length, 0, `errors: ${re.errors.join('; ')}`);
  assert.equal(re.revision, 3, 'revision 3.0 from GH2');
  assert.equal(re.traceCount, 2, 'both channels segmented');
  assert.equal(re.bh.sampleInt, 500, 'sampling interval from the rev-3 descriptor');
  assert.equal(re.traces[0].nSamples, 5, 'ns from THE1[24-27]');
  assert.equal(re.traces[0].hdr.rcvLine, 399, 'receiver line from the extended THE1 field');
  assert.equal(re.traces[0].hdr.rcvPoint, 253, 'receiver point from the extended THE1 field');
  assert.equal(re.traces[1].samples![0], 20, 'trace-2 samples at the true offset');
});

test('parseSEGD legacy path still opens pre-spec SeisConv-written .segd files', () => {
  // Byte-for-byte the OLD writer's layout: year at b[9], BSI CODE in b[21] hi
  // nibble, numChanSets|addl marker 0x11 at b[22], binary trace numbers.
  const ns = 8, ntr = 2;
  const legacy = new Uint8Array(32 + 32 + ntr * (20 + ns * 4));
  legacy[0] = 0; legacy[1] = 1; legacy[2] = 0x80; legacy[3] = 0x58;
  legacy[9] = 0x25;
  const bps = ns * 4;
  legacy[19] = ((Math.floor(bps / 1000) % 10) << 4) | (Math.floor(bps / 100) % 10);
  legacy[20] = ((Math.floor(bps / 10) % 10) << 4) | (bps % 10);
  legacy[21] = 0x40; // BSI CODE 4 = 500 µs (old code-table semantics)
  legacy[22] = 0x11; // the legacy signature byte
  const dvv = new DataView(legacy.buffer);
  for (let t = 0; t < ntr; t++) {
    const off = 64 + t * (20 + ns * 4);
    dvv.setUint32(off + 4, t + 1, false);
    for (let i = 0; i < ns; i++) dvv.setFloat32(off + 20 + i * 4, t * 100 + i + 0.25, false);
  }
  const re = parseSEGD(legacy);
  assert.equal(re.traceCount, 2, 'legacy layout walked');
  assert.equal(re.bh.sampleInt, 500, 'legacy BSI code table honoured');
  assert.equal(re.traces[0].nSamples, 8, 'legacy bytes-per-scan → ns');
  assert.equal(re.traces[1].samples![3], 103.25, 'legacy samples decode');
});

test('iX1 SEG-D tape image is recognized and fails fast with an honest error', () => {
  const tape = new Uint8Array(4096);
  tape.fill(0x20, 0, 128);
  const vol = 'SD2.1RECORDB1           0       218 1-JUL-2026SCSI#0000015';
  for (let i = 0; i < vol.length; i++) tape[4 + i] = vol.charCodeAt(i);
  tape.set(mkIX1SEGD(false), 128); // raw SEG-D records follow the volume header
  assert.ok(isIX1SegdTape(tape), 'volume-header signature recognized');
  assert.equal(detect(tape, 'Stand Alone Mode_1.TpImage'), 'TPIMAGE', 'detected regardless of walker');
  const pf = parseAny(tape, 'Stand Alone Mode_1.TpImage');
  assert.equal(pf.traceCount, 0, 'no garbage traces extracted');
  assert.ok(pf.errors.some((e) => /iX1.*not yet supported/i.test(e)), `honest error: ${pf.errors.join('; ')}`);
  // Never misfires on a real framed tape or a bare SEG-Y.
  assert.ok(!isIX1SegdTape(writeTapeImage(mkPF([16]))), 'VOL1 tape not flagged');
  assert.ok(!isIX1SegdTape(writeSEGY(mkPF([16]), 2)), 'bare SEG-Y not flagged');
});

// ── SEG standards compliance regressions ───────────────────────────────────
// Guards the per-format conformance fixes so a future change that reverts them
// (back to a non-standard byte) is caught here, not by a downstream reader.
console.log('\n[compliance]');

test('writeSEGD stamps the conformant IEEE-float data sample format code 8058', () => {
  const out = writeSEGD(mkPF([64, 64]), false);
  // GH1 bytes 2-3 (BCD): code 8058 = 0x80 0x58. The old non-standard 0032 must
  // never be emitted again.
  assert.equal(out[2], 0x80, `GH1 byte2 expected 0x80 (got 0x${out[2].toString(16)})`);
  assert.equal(out[3], 0x58, `GH1 byte3 expected 0x58 (got 0x${out[3].toString(16)})`);
});

test('parseSEGD still accepts the legacy 0032 format code (backward compat)', () => {
  const out = writeSEGD(mkPF([64, 64]), false);
  out[2] = 0x00;
  out[3] = 0x32; // downgrade to the legacy SeisConv code
  const re = parseSEGD(out);
  assert.equal(re.errors.length, 0, `errors: ${re.errors.join('; ')}`);
  assert.equal(re.traceCount, 2, 'legacy 0032 still parses to its traces');
});

test('writeSEG2 places the string-terminator size at FDB byte 8 (spec BccBcc @8)', () => {
  const pf = mkPF([32, 32]);
  pf.format = 'SEG-2';
  const out = writeSEG2(pf);
  // Pullan 1990 / ObsPy require byte 8 = 1 or 2; byte 11 = line-terminator size.
  assert.equal(out[8], 1, `FDB byte8 (string-term size) expected 1 (got ${out[8]})`);
  assert.equal(out[9], 0x00, 'FDB byte9 (string-term char) expected 0x00');
  assert.equal(out[11], 1, `FDB byte11 (line-term size) expected 1 (got ${out[11]})`);
  assert.equal(out[12], 0x0a, 'FDB byte12 (line-term char) expected 0x0A');
});

test('writeSEG2 emits SAMPLE_INTERVAL in SECONDS and round-trips the µs value', () => {
  const pf = mkPF([32, 32]);
  pf.format = 'SEG-2';
  pf.bh.sampleInt = 2000; // µs
  const out = writeSEG2(pf);
  const txt = new TextDecoder().decode(out);
  // 2000 µs → 0.002 s, NOT "2.000000" (ms). A 1000× error in any conformant reader.
  assert.ok(/SAMPLE_INTERVAL\s+0\.002/.test(txt), 'SAMPLE_INTERVAL must be in seconds (0.002…)');
  const re = parseSEG2(out);
  assert.equal(re.bh.sampleInt, 2000, `sampleInt must round-trip to 2000 µs (got ${re.bh.sampleInt})`);
});

test('SEG-Y revision word decodes the major byte (rev 2.1 = 0x0201 → rev 2)', () => {
  const out = writeSEGY(mkPF([16, 16]), 2);
  // Stamp a minor revision (0x0201) directly in the binary header (byte 3501-3502)
  // and confirm the parser reports major=2, not rev 0.
  out[3200 + 300] = 0x02;
  out[3200 + 301] = 0x01;
  const re = parseSEGY(out);
  assert.equal(re.revision, 2, 'major revision 2 honoured regardless of nonzero minor');
  assert.equal(re.bh.revMinor, 1, 'minor revision retained');
});

test('writeSU preserves trace geometry (fldr/sp/cdp/offset) and defaults trid=1', () => {
  const traces = [0, 1].map((t) => {
    const s = new Float32Array(16);
    return { hdr: { fieldRec: 7, srcPt: 101, ensemble: 555, trcEns: 3, offset: -250, traceId: 0 }, samples: s, nSamples: 16 };
  });
  const pf: any = { format: 'SEG-Y', revision: 1, bh: { sampleInt: 2000, samplesTrace: 16 }, traceCount: 2, errors: [], traces };
  const re = parseSU(writeSU(pf));
  const h = re.traces[0].hdr;
  assert.equal(h.ffid, 7, 'fldr preserved');
  assert.equal(h.sp, 101, 'shot/source point preserved');
  assert.equal(h.cdp, 555, 'cdp preserved');
  assert.equal(h.cdpTrace, 3, 'cdp trace preserved');
  assert.equal(h.offset, -250, 'offset preserved');
  assert.equal(h.traceId, 1, 'trid defaults to 1 (seismic) when input is 0');
});

test('writeSEGY / writeSU refuse ns > 65535 with a clear error (no silent truncation)', () => {
  // ns fields are 16-bit; the old clamp silently truncated (SEG-Y) or mis-walked
  // on re-import (SU: full payload + clamped ns). Both must now throw.
  const long = mkPF([70000]);
  assert.throws(() => writeSEGY(long, 2), /70000 samples.*65535.*resample or split/i, 'writeSEGY guards ns');
  assert.throws(() => writeSU(long), /70000 samples.*65535.*resample or split/i, 'writeSU guards ns');
  // At the boundary (65535) both writers must still work.
  const edge = mkPF([65535]);
  assert.doesNotThrow(() => writeSU(edge), 'ns = 65535 is representable in SU');
  const re = parseSEGY(writeSEGY(edge, 2));
  assert.equal(re.traces[0].nSamples, 65535, 'ns = 65535 round-trips in SEG-Y');
});

test('writeSEGY preserves srcPt/ensemble/offset/coordScalar/elevScalar (geometry intact)', () => {
  const pf = mkPF([16, 16]);
  pf.traces.forEach((tr: any) => {
    tr.hdr = { srcPt: 101, ensemble: 555, offset: -1250, coordScalar: -100, elevScalar: -10, srcX: 3500000, srcY: 380000000, rcvX: 3500100, rcvY: 380001000 };
  });
  const h = parseSEGY(writeSEGY(pf, 1)).traces[0].hdr;
  assert.equal(h.srcPt, 101, 'source point preserved');
  assert.equal(h.ensemble, 555, 'ensemble preserved (not rewritten to t+1)');
  assert.equal(h.offset, -1250, 'offset preserved');
  assert.equal(h.coordScalar, -100, 'coordScalar preserved — raw coords stay interpretable');
  assert.equal(h.elevScalar, -10, 'elevScalar preserved');
  assert.equal(h.srcX, 3500000, 'raw srcX preserved alongside its scalar');
});

test('writeSEGY textual header is EBCDIC for rev 0/1, ASCII for rev 2 (reader decodes all)', () => {
  const pf = mkPF([16, 16]);
  for (const rev of [0, 1, 2]) {
    const out = writeSEGY(pf, rev);
    // 'C' is 0xC3 in EBCDIC (CP037), 0x43 in ASCII.
    assert.equal(out[0], rev <= 1 ? 0xc3 : 0x43, `rev ${rev} first byte encoding`);
    const re = parseSEGY(out);
    assert.ok(re.textHeader!.includes(`SEG-Y Rev ${rev}`), `rev ${rev} textual header decodes`);
    assert.equal(re.traceCount, 2, `rev ${rev} traces intact`);
  }
});

test('detectEx flags the ≥3600-byte no-signature fallback as assumed (real files are not)', () => {
  const blob = new Uint8Array(4000).fill(0x11); // no magic, no BCD SEG-D code, big enough for SEG-Y headers
  const guess = detectEx(blob, 'mystery.bin');
  assert.equal(guess.format, 'SEG-Y', 'fallback still attempts SEG-Y');
  assert.equal(guess.assumed, true, 'fallback is flagged as an assumption');
  const real = detectEx(writeSEGY(mkPF([16]), 2), 'x.sgy');
  assert.equal(real.format, 'SEG-Y', 'signature match detects SEG-Y');
  assert.equal(real.assumed, false, 'signature match is not an assumption');
  // The registry surfaces the assumption to the UI via the parse errors.
  const pf = parseWithRegistry(blob, 'mystery.bin');
  assert.ok(pf.errors.some((e: string) => /unrecognized content/i.test(e)), `assumption surfaced: ${pf.errors.join('; ')}`);
});

test('SPS 2.1 coordinate-less record (code KL) keeps the station, no phantom (legacy fallthrough)', () => {
  // 0-based cols: [0]=R, [1..10]=line, [11..20]=point, [23]=index, [24..25]=code,
  // [46..54]=easting, [55..64]=northing, [65..70]=elevation (SPS 2.1 fixed layout).
  const mkR = (line: string, pt: string, code: string, e: string, n: string, z: string) =>
    'R' + line.padStart(10) + pt.padStart(10) + '  1' + code.padEnd(2) + ' '.repeat(20) + e.padStart(9) + n.padStart(10) + z.padStart(6);
  const txt = [
    'H00 SPS format version num.     SPS 2.1,01.01.2006;',
    mkR('512.00', '101.00', 'G1', '745123.4', '3652123.4', '212.5'),
    mkR('512.00', '102.00', 'KL', '', '', ''), // dead/killed station — NO coordinates
    mkR('512.00', '103.00', 'G1', '745133.4', '3652133.4', '213.5'),
  ].join('\n');
  const d = parseSPSText(txt);
  assert.equal(d.receivers.length, 3, 'coordinate-less station is KEPT (counts stay true)');
  assert.ok(d.receivers.every((r) => r.lineName === '512.00'), `no phantom line name: ${[...new Set(d.receivers.map((r) => r.lineName))]}`);
  const kl = d.receivers[1];
  assert.equal(kl.point, 102, 'KL station identity preserved');
  assert.ok(!isFinite(kl.easting) && !isFinite(kl.northing), 'KL station carries non-finite coords (plots skip it)');
  assert.ok(d.errors.some((e) => /coordinate-less station \(code KL\)/.test(e)), `diagnostic emitted: ${d.errors.join('; ')}`);
  assert.equal(d.layout, 'SPS2.1', 'layout detection unaffected');
});

test('runSPSQC aggregates repeated identical warnings into one entry with a ×count', () => {
  const pt = (rtype: 'S' | 'R', lineName: string, point: number, e: number, n: number): SPSPoint =>
    ({ rtype, lineName, point, idx: '1', easting: e, northing: n, elevation: 0, raw: '', lineNum: point });
  const sps: SPSData = {
    sources: [pt('S', '9', 5, 100, 100)],
    receivers: [1, 2, 3].map((p) => pt('R', '1', p, p * 10, 0)),
    // 3 relations, each below the station list's low end → 3 IDENTICAL range warnings.
    xrefs: [1, 2, 3].map(() => ({ srcLine: '9', srcPt: 5, ffid: 1, rcvLineFrom: '1', rcvPtFrom: 0, rcvPtTo: 2 })),
    headers: [], errors: [], skipped: 0, layout: 'SPS2.1',
  };
  const res = runSPSQC(sps);
  const xr = res.filter((r) => r.cat === 'X-Ref');
  assert.equal(xr.length, 1, `identical warnings collapsed to one (got ${xr.length})`);
  assert.ok(/\(×3\)$/.test(xr[0].msg), `count suffix present: ${xr[0].msg}`);
});

// ── TPIMAGE (tape image) ──────────────────────────────────────────────────────
console.log('\n[tpimage]');
test('writeTapeImage wraps a SEG-Y that parseTpimage + detect() recover', () => {
  const pf = mkPF([100, 100, 100]); // reuses the run.ts mkPF helper
  const tp = writeTapeImage(pf); // defaults: label 'ansi', volSerial 'SEI001', innerFmt 'segy1'
  assert.equal(detect(tp, 'tape.tpimage'), 'TPIMAGE', 'image detects as TPIMAGE');
  const files = parseTpimage(tp);
  assert.ok(files.length >= 1, `expected >=1 embedded file, got ${files.length}`);
  assert.equal(detect(files[0].bytes, files[0].name), 'SEG-Y', 'embedded file is SEG-Y');
  // round-trip the embedded SEG-Y back to traces
  const re = parseSEGY(files[0].bytes);
  assert.equal(re.traceCount, 3, 'embedded SEG-Y trace count preserved');
  // 'none' label mode still yields a detectable SEG-Y block
  const raw = parseTpimage(writeTapeImage(pf, { label: 'none' }));
  assert.ok(raw.length >= 1 && detect(raw[0].bytes, raw[0].name) === 'SEG-Y', 'unlabeled image still extracts SEG-Y');
});

test('writeTapeImageMulti combines N files into ONE tape image (parseTpimage recovers each in order)', () => {
  const a = mkPF([10, 10]);     // 2 traces
  const b = mkPF([20, 20, 20]); // 3 traces
  const c = mkPF([30]);         // 1 trace
  (a as { _name?: string })._name = 'shotA.dat';
  (b as { _name?: string })._name = 'shotB.dat';
  (c as { _name?: string })._name = 'shotC.dat';
  const tp = writeTapeImageMulti([a, b, c]);
  assert.equal(detect(tp, 'combined.tpimage'), 'TPIMAGE', 'combined image detects as TPIMAGE');
  const files = parseTpimage(tp);
  assert.equal(files.length, 3, `expected 3 embedded files in ONE tape, got ${files.length}`);
  // Each embedded record round-trips to its own trace count, IN ORDER.
  assert.equal(parseSEGY(files[0].bytes).traceCount, 2, 'embedded file 1 trace count');
  assert.equal(parseSEGY(files[1].bytes).traceCount, 3, 'embedded file 2 trace count');
  assert.equal(parseSEGY(files[2].bytes).traceCount, 1, 'embedded file 3 trace count');
  // Per-file HDR1 file id carries the source name (so records are distinguishable).
  assert.ok(files[0].name.startsWith('shotA'), `file 1 name carried: ${files[0].name}`);
  assert.ok(files[1].name.startsWith('shotB'), `file 2 name carried: ${files[1].name}`);
  assert.ok(files[2].name.startsWith('shotC'), `file 3 name carried: ${files[2].name}`);
  // writeTapeImage(pf) is exactly writeTapeImageMulti([pf]) — single-file path intact.
  assert.equal(parseTpimage(writeTapeImage(a)).length, 1, 'single-file tape has exactly 1 record');
  // READ side: opening the combined tape surfaces EVERY record's traces (2+3+1=6),
  // not just the first record — so a combined tape views in full.
  const whole = parseAny(tp, 'combined.tpimage');
  assert.equal(whole.format, 'TPIMAGE→SEG-Y', 'combined tape parses as TPIMAGE→SEG-Y');
  assert.equal(whole.traceCount, 6, `combined tape exposes all records' traces (got ${whole.traceCount})`);
  // A single-record tape still reports just that record's traces (3), unchanged.
  assert.equal(parseAny(writeTapeImage(b), 'one.tpimage').traceCount, 3, 'single-record tape unchanged');
});

// ── Security: memory-DoS hardening in the binary parsers ──────────────────────
// Regression for two parser allocation findings:
//  (HIGH) seg2.ts allocated new Float32Array(nSamples) from an attacker-controlled
//         header field that was DECOUPLED from the on-disk data-block size — a
//         crafted ~100KB SEG-2 (nSamples=999999, tiny data block) could allocate
//         ~7.6 GB and OOM the worker. nSamples must be bounded by available bytes.
//  (LOW)  segd.ts 20-bit branch used sptStored WITHOUT the Math.min clamp the
//         32-bit / 24-bit branches have, so an inflated bytes-per-scan field could
//         over-allocate. It must clamp ns = min(ns, floor(rem*2/5)).
// The valid Geode sample must still parse to its true, unchanged sample counts.
console.log('\n[security]');

// LE writers for crafting a hostile SEG-2 buffer.
function w16le(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
}
function w32le(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
  b[o + 2] = (v >> 16) & 0xff;
  b[o + 3] = (v >> 24) & 0xff;
}

/**
 * Craft a structurally-valid SEG-2 with ONE trace whose TDB declares a huge
 * nSamples (999999) but whose on-disk data block is tiny (8 bytes = 2 IEEE
 * float32 samples). A pre-fix parser would allocate ~4 MB for this single trace
 * (and ~7.6 GB for the x2000 multi-trace variant in the wild); the fix must clamp
 * nSamples to the data-block budget (= 2 here).
 */
function craftHostileSEG2(): Uint8Array {
  const tdbSize = 32; // fixed TDB header only, no free-form
  const dataBlockSize = 8; // 2 IEEE float32 samples actually on disk
  const trcOff = 64; // past the 32-byte FDB + a 32-slot pad; well clear of ptr array
  const buf = new Uint8Array(trcOff + tdbSize + dataBlockSize);
  // FDB
  buf[0] = 0x3a;
  buf[1] = 0x55; // LE magic
  w16le(buf, 2, 1); // revision 1
  w16le(buf, 6, 1); // nTraces = 1
  buf[10] = 0; // string-terminator length = 0 → ST defaults to 0x00
  buf[11] = 1; // line-terminator length = 1
  buf[12] = 0x0a; // line terminator '\n'
  // Trace pointer array at fixed byte 32: trace 0 → trcOff.
  w32le(buf, 32, trcOff);
  // Trace descriptor block.
  w16le(buf, trcOff, 0x4422); // TDB ID
  w16le(buf, trcOff + 2, tdbSize); // TDB size
  w32le(buf, trcOff + 4, dataBlockSize); // data block size (TINY)
  w32le(buf, trcOff + 8, 999999); // nSamples (HUGE / attacker-controlled)
  w16le(buf, trcOff + 12, 4); // data format 4 = IEEE float32 (4 bytes/sample)
  // 8 bytes of sample data follow at trcOff+tdbSize.
  return buf;
}

test('SEG-2 with a huge declared nSamples + tiny data block parses without OOM (samples bounded by bytes)', () => {
  const hostile = craftHostileSEG2();
  let pf: any;
  assert.doesNotThrow(() => { pf = parseSEG2(hostile); }, 'parseSEG2 threw on the crafted file');
  assert.ok(pf.traceCount >= 1, `expected the trace to be parsed, got ${pf.traceCount}`);
  const t0 = pf.traces[0];
  // The allocation MUST be bounded by the 8-byte data block / 4 = 2 samples,
  // NOT the declared 999999. Assert it is small (not ~1M).
  assert.ok(t0.nSamples <= 2, `nSamples not clamped to data block: ${t0.nSamples}`);
  assert.ok(t0.samples != null && t0.samples.length === t0.nSamples, 'samples length matches clamped nSamples');
  assert.ok(t0.nSamples < 1000, `sanity: clamped count must be far below 1M, got ${t0.nSamples}`);
});

/**
 * Craft a MULTI-TRACE budget-bypass SEG-2 (~100KB): up to 2000 trace pointers
 * ALL aimed at the SAME tiny data region, each TDB declaring nSamples=999999
 * with dataBlockSize=0 (so the per-trace clamp falls back to "remaining file
 * bytes"). Pre-budget-fix, every trace independently clamped to ~filesize/4 and
 * allocated a full ~filesize/4 Float32Array → total = O(traces × filesize)
 * (measured: a 2MB file → ~3.9 GB). The FILE-WIDE budget must bound the TOTAL
 * sample allocation across ALL traces to O(filesize).
 */
function craftBudgetBypassSEG2(): Uint8Array {
  const N = 2000; // trace pointers
  const ptrBase = 32; // fixed trace-pointer array offset
  const ptrArrayEnd = ptrBase + N * 4;
  // Shared trace descriptor block, placed just past the pointer array. Every
  // pointer aims here, so all traces overlap on the same data region.
  const trcOff = ptrArrayEnd + 16;
  const tdbSize = 32; // fixed TDB header only
  const dataStart = trcOff + tdbSize;
  // Pad the file out to ~100KB so "remaining bytes" per trace is large.
  const fileLen = Math.max(100 * 1024, dataStart + 64);
  const buf = new Uint8Array(fileLen);
  // FDB
  buf[0] = 0x3a;
  buf[1] = 0x55; // LE magic
  w16le(buf, 2, 1); // revision 1
  w16le(buf, 6, N); // nTraces = 2000
  buf[10] = 0; // string-terminator length = 0 → ST defaults to 0x00
  buf[11] = 1; // line-terminator length = 1
  buf[12] = 0x0a; // line terminator '\n'
  // Trace pointer array: ALL N pointers → the SAME trcOff (overlapping).
  for (let t = 0; t < N; t++) w32le(buf, ptrBase + t * 4, trcOff);
  // The single shared trace descriptor block.
  w16le(buf, trcOff, 0x4422); // TDB ID
  w16le(buf, trcOff + 2, tdbSize); // TDB size
  w32le(buf, trcOff + 4, 0); // dataBlockSize = 0 → clamp falls back to remaining bytes
  w32le(buf, trcOff + 8, 999999); // nSamples (HUGE / attacker-controlled)
  w16le(buf, trcOff + 12, 4); // data format 4 = IEEE float32 (4 bytes/sample)
  return buf;
}

test('SEG-2 with 2000 overlapping trace pointers (dataBlockSize=0) bounds TOTAL allocation by filesize, not traces×filesize', () => {
  const hostile = craftBudgetBypassSEG2();
  const start = Date.now();
  let pf: any;
  assert.doesNotThrow(() => { pf = parseSEG2(hostile); }, 'parseSEG2 threw on the multi-trace budget-bypass file');
  const elapsed = Date.now() - start;
  // The whole point: TOTAL sample bytes across ALL traces must be O(filesize),
  // not O(traces × filesize). Sum the allocated bytes and assert a small multiple
  // of the file size. (Pre-fix this was ~2000 × filesize/4 = 500× filesize.)
  let totalSampleBytes = 0;
  let allocatedTraces = 0;
  for (const tr of pf.traces) {
    const n = tr.samples ? tr.samples.length : 0;
    totalSampleBytes += n * 4; // IEEE float32 = 4 B/sample
    if (tr.samples) allocatedTraces++;
    // Every individual trace must also still be per-trace clamped.
    assert.ok(!tr.samples || tr.samples.length === tr.nSamples, 'samples length matches nSamples');
  }
  assert.ok(
    totalSampleBytes <= 4 * hostile.length,
    `TOTAL sample allocation must be ≤ 4× filesize: ${totalSampleBytes} bytes vs file ${hostile.length} (×${(totalSampleBytes / hostile.length).toFixed(1)})`,
  );
  // And it must not hang: parsing 2000 overlapping pointers should be sub-second.
  assert.ok(elapsed < 3000, `parse took too long (${elapsed} ms) — possible O(traces×filesize) blow-up`);
  console.log(
    `      golden: budget-bypass — traces=${pf.traceCount} allocated=${allocatedTraces} ` +
      `totalSampleBytes=${totalSampleBytes} (file ${hostile.length}, ${(totalSampleBytes / hostile.length).toFixed(2)}× filesize, ${elapsed} ms)`,
  );
});

/**
 * Craft a SEG-D whose GH1 declares a 20-bit packed format with an inflated
 * bytes-per-scan field (→ sptStored ~400000) on a tiny file. The 20-bit decode
 * branch must clamp ns to floor(rem*2/5), not honour the forged sptStored.
 */
function craftHostileSEGD20bit(): Uint8Array {
  const buf = new Uint8Array(120);
  // GH1: file number (BCD) bytes 0-1, format code (BCD) bytes 2-3.
  // fmtCode must NOT be 32/8032/68/8068 so the parser takes the 20-bit branch.
  buf[2] = 0x00;
  buf[3] = 0x36; // fmtCode = 0036 (20-bit), bcd2 → 0*100 + 36
  buf[9] = 0x24; // year BCD (cosmetic)
  // addlBlocks = (b[10]>>4)&0xf = 0; Julian-day low bits = 0.
  buf[10] = 0x00;
  buf[11] = 0x00;
  // bytes-per-scan (BCD) in 18-20 → inflate to 999999 → sptStored = round(/2.5) = 400000.
  buf[18] = 0x99;
  buf[19] = 0x99;
  buf[20] = 0x99;
  // numChanSets = (b[22]>>4)&0xf, extHdrLen = (b[23]>>4)&0xf, extlHdrLen = b[23]&0xf.
  buf[21] = 0x20; // base-scan-interval code 2 (cosmetic, → 2000us)
  buf[22] = 0x00; // numChanSets = 0 → loop runs (numChanSets||1)=1 channel-set block
  buf[23] = 0x00; // no extended headers
  // The channel-set descriptor block (32 bytes) starts at off=32; leave it zero
  // (seisCC stays 0 → defaults to 1). The trace record header begins thereafter.
  return buf;
}

test('SEG-D 20-bit packed with a forged bytes-per-scan is bounded by remaining bytes (not ~400k)', () => {
  const hostile = craftHostileSEGD20bit();
  let pf: any;
  assert.doesNotThrow(() => { pf = parseSEGD(hostile); }, 'parseSEGD threw on the crafted 20-bit file');
  assert.ok(pf.traceCount >= 1, `expected a trace, got ${pf.traceCount}`);
  const t0 = pf.traces[0];
  // floor(rem*2/5) on this ~120-byte file is a few dozen samples at most — assert
  // it is nowhere near the forged sptStored (~400000).
  assert.ok(t0.nSamples < 1000, `20-bit ns not clamped to remaining bytes: ${t0.nSamples}`);
  if (t0.samples) assert.equal(t0.samples.length, t0.nSamples, 'samples length matches clamped ns');
});

// The fix must NOT alter valid parsing: the real Geode sample still decodes to
// its true, unchanged per-trace sample counts (data block == nSamples*bps, so the
// new clamp is a no-op).
if (existsSync(GEODE)) {
  test('valid Geode .dat still parses to its true, unchanged sample counts (clamp is a no-op)', () => {
    const pf = parseSEG2(readBytes(GEODE));
    assert.equal(pf.errors.length, 0, `errors: ${pf.errors.join('; ')}`);
    assert.ok(pf.traceCount > 0, 'expected > 0 traces');
    for (const tr of pf.traces) {
      if (tr.samples) {
        assert.equal(tr.samples.length, tr.nSamples, 'decoded length matches header nSamples');
        // A real Geode trace carries hundreds–thousands of samples; the clamp must
        // NOT have truncated it to the data-block-undershoot seen in the attack.
        assert.ok(tr.nSamples > 2, `valid trace truncated by the clamp: nSamples=${tr.nSamples}`);
      }
    }
    console.log(`      golden: Geode traceCount=${pf.traceCount} samplesPerTrace=${pf.traces[0].nSamples}`);
  });
} else {
  skip('valid Geode clamp-is-a-no-op check', `${GEODE} not found`);
}

// ── Coordinate CSV (generic point CSV) ────────────────────────────────────────
console.log('\n[coordcsv]');

test('parseCoordCsv reads a CRS-tagged, header-mapped CSV (synonyms, S/R, extra cols)', () => {
  const csv = [
    '# CRS: ITM',
    'Line,Station,Type,Easting,Northing,Elev,Notes',
    '101,200,S,660000.0,3550000.0,120.0,shot A',
    '101,201,S,660025.0,3550000.0,121.5,"shot, B"', // quoted field with a comma
    '',                                              // blank line in the middle
    '500,10,R,661000.0,3551000.0,95.0,geophone',
  ].join('\n');
  const d = parseCoordCsv(csv);
  assert.equal(d.errors.filter((e) => /cannot parse/.test(e)).length, 0, `parse errors: ${d.errors.join('; ')}`);
  assert.equal(d.sources.length, 2, `sources ${d.sources.length}`);
  assert.equal(d.receivers.length, 1, `receivers ${d.receivers.length}`);
  assert.equal(d.sources[0].lineName, '101');
  assert.equal(d.sources[0].point, 200);
  assert.ok(Math.abs(d.sources[0].easting - 660000) < 1e-6, `E ${d.sources[0].easting}`);
  assert.ok(Math.abs(d.sources[1].easting - 660025) < 1e-6, 'quoted-comma row parsed');
  assert.ok(Math.abs(d.receivers[0].northing - 3551000) < 1e-6, `N ${d.receivers[0].northing}`);
  assert.equal(d.receivers[0].rtype, 'R');
  // CRS tag → ITM (EPSG:2039) projection resolved.
  assert.equal(d.projection?.subtype, 'TM', `subtype ${d.projection?.subtype}`);
  assert.ok((d.projection?.latOrigin ?? 0) > 31 && (d.projection?.latOrigin ?? 0) < 32, `latOrigin ${d.projection?.latOrigin}`);
  // detector routes a .csv to the coordcsv format.
  assert.equal(detectPositioningFormat('survey.csv', csv), 'coordcsv');
});

test('parseCoordCsv resolves a `# EPSG:2039` tag and an x/y/z synonym header', () => {
  const csv = ['# EPSG:2039', 'line,sp,x,y,z', 'A1,5,200000,650000,10'].join('\n');
  const d = parseCoordCsv(csv);
  assert.equal(d.receivers.length, 1, 'defaults to receiver when no type column');
  assert.equal(d.receivers[0].lineName, 'A1');
  assert.ok(Math.abs(d.receivers[0].easting - 200000) < 1e-6);
  assert.equal(d.projection?.desc, 'EPSG:2039', `desc ${d.projection?.desc}`);
});

test('parseCoordCsv leaves projection undefined when there is no CRS tag', () => {
  const d = parseCoordCsv('line,point,type,easting,northing,elevation\nL,1,S,100,200,5');
  assert.equal(d.projection, undefined, 'no tag → no projection');
  assert.equal(d.sources.length, 1);
});

test('parseCoordCsv never throws on malformed rows — bad coords go to skipped', () => {
  const csv = 'line,point,easting,northing\nL,1,notanumber,oops\nL,2,300,400';
  let d: any;
  assert.doesNotThrow(() => { d = parseCoordCsv(csv); }, 'parseCoordCsv threw');
  assert.equal(d.skipped, 1, `skipped ${d.skipped}`);
  assert.equal(d.receivers.length, 1, 'the valid row still parses');
});

test('parseCoordCsv ignores a prototype-pollution column header (no proto leak)', () => {
  // A header naming __proto__ must NOT pollute Object.prototype, and the row's
  // coordinate columns must still parse normally.
  const csv = '__proto__,easting,northing\npolluted,500,600';
  const d = parseCoordCsv(csv);
  assert.equal(({} as any).polluted, undefined, 'Object.prototype was polluted!');
  assert.equal(d.receivers.length, 1, 'coords still parsed past the hostile column');
  assert.ok(Math.abs(d.receivers[0].easting - 500) < 1e-6);
});

test('coordcsv parse → build → parse round-trips points and CRS tag', () => {
  const csv = ['# CRS: ITM', 'line,point,type,easting,northing,elevation', '101,200,S,660000,3550000,120', '500,10,R,661000,3551000,95'].join('\n');
  const d1 = parseCoordCsv(csv);
  const files = buildCoordCsv(d1);
  assert.equal(files.length, 1, 'one file emitted');
  assert.ok(/^# CRS:/.test(files[0].text), `tag line present: ${files[0].text.split('\n')[0]}`);
  const d2 = parseCoordCsv(files[0].text);
  assert.equal(d2.sources.length, d1.sources.length, 'sources stable');
  assert.equal(d2.receivers.length, d1.receivers.length, 'receivers stable');
  assert.equal(d2.sources[0].point, 200);
  assert.ok(Math.abs(d2.sources[0].easting - 660000) < 1e-6, 'easting stable');
  assert.ok(Math.abs(d2.receivers[0].northing - 3551000) < 1e-6, 'northing stable');
  assert.equal(d2.projection?.subtype, 'TM', 'CRS round-trips');
});

test('coordcsv UTM projection survives parse → build → parse (no silent CRS loss)', () => {
  // A survey carrying a UTM projection with NO EPSG code in desc (the normal
  // SPS-derived case): the emitted CRS tag must be readable back.
  const csv = ['# CRS: EPSG:32636', 'line,point,type,easting,northing,elevation', '101,200,S,500000,4000000,10'].join('\n');
  const d1 = parseCoordCsv(csv);
  assert.equal(d1.projection?.subtype, 'UTM', `subtype ${d1.projection?.subtype}`);
  assert.equal(d1.projection?.zone, 36, `zone ${d1.projection?.zone}`);
  // Drop the EPSG code from desc to simulate an SPS-derived UTM projection that
  // only knows subtype+zone+hemi, then build and re-parse.
  const proj = { ...d1.projection! }; delete (proj as { desc?: string }).desc;
  const files = buildCoordCsv({ ...d1, projection: proj });
  const tagLine = files[0].text.split('\n')[0];
  assert.ok(/^# CRS:/.test(tagLine), `tag present: ${tagLine}`);
  const d2 = parseCoordCsv(files[0].text);
  assert.ok(d2.projection != null, `UTM projection LOST on round-trip (tag was "${tagLine}")`);
  assert.equal(d2.projection?.subtype, 'UTM', `subtype after round-trip ${d2.projection?.subtype}`);
  assert.equal(d2.projection?.zone, 36, `zone after round-trip ${d2.projection?.zone}`);
});

test('coordcsv round-trips the SPSPoint.idx flag character', () => {
  const csv = ['line,point,type,idx,easting,northing,elevation', '101,200,S,A,660000,3550000,120'].join('\n');
  const d1 = parseCoordCsv(csv);
  assert.equal(d1.sources[0].idx, 'A', `idx parsed ${d1.sources[0].idx}`);
  const files = buildCoordCsv(d1);
  const d2 = parseCoordCsv(files[0].text);
  assert.equal(d2.sources[0].idx, 'A', `idx LOST on round-trip: "${d2.sources[0].idx}"`);
});

// ── IOGP P6/11 bin-grid (read-only) ────────────────────────────────────────────
// A bin-grid file DEFINES a seismic acquisition grid (origin, bin size, rotation,
// inline/crossline numbering, corners) rather than per-point positions, so it maps
// onto a BinGrid (kind:'bingrid'), not SPSData. The fixture below is a small,
// spec-shaped P6/11 header block using the canonical EPSG "P6" parameter labels;
// the assertions pin origin / rotation / bin sizes and the four computed corners.
console.log('\n[p611]');
test('parseP611 reads origin, bin sizes, rotation, numbering and computes corners', () => {
  // J-axis bears 340° clockwise from grid north → I-axis (I=J-90) bears 250°.
  // Grid: 4 bins on I (width 25 m), 2 bins on J (width 25 m), origin at E/N below.
  const p611 = [
    'H6,0,0,0, IOGP P6/11 Seismic Bin Grid Data Exchange Format v1.1',
    'C  synthetic fixture for the unit test',
    'H1, Survey area name, DEMO 3D SURVEY',
    'H18, Projection type, UTM',
    'H19, Projection zone, 36 North',
    'H6,1,1, Bin grid origin I, 1000',
    'H6,1,2, Bin grid origin J, 2000',
    'H6,1,3, Bin grid origin Easting, 500000.0',
    'H6,1,4, Bin grid origin Northing, 4000000.0',
    'H6,1,5, Scale factor of bin grid, 1.0',
    'H6,1,6, Bin width on I-axis, 25.0',
    'H6,1,7, Bin width on J-axis, 25.0',
    'H6,1,8, Map grid bearing of bin grid J-axis, 340.0',
    'H6,1,9, Bin node increment on I-axis, 1',
    'H6,1,10, Bin node increment on J-axis, 1',
    'H6,2,1, Number of inlines, 4',
    'H6,2,2, Number of crosslines, 2',
  ].join('\n');

  const g = parseP611(p611);
  assert.equal(g.name, 'DEMO 3D SURVEY', `name ${g.name}`);
  assert.ok(Math.abs(g.originE - 500000) < 1e-6, `originE ${g.originE}`);
  assert.ok(Math.abs(g.originN - 4000000) < 1e-6, `originN ${g.originN}`);
  assert.ok(Math.abs(g.binI - 25) < 1e-9, `binI ${g.binI}`);
  assert.ok(Math.abs(g.binJ - 25) < 1e-9, `binJ ${g.binJ}`);
  assert.equal(g.firstInline, 1000, `firstInline ${g.firstInline}`);
  assert.equal(g.firstCrossline, 2000, `firstCrossline ${g.firstCrossline}`);
  assert.equal(g.incInline, 1, `incInline ${g.incInline}`);
  assert.equal(g.incCrossline, 1, `incCrossline ${g.incCrossline}`);
  assert.equal(g.nInline, 4, `nInline ${g.nInline}`);
  assert.equal(g.nCrossline, 2, `nCrossline ${g.nCrossline}`);
  // inlineAzimuth = I-axis bearing = J-axis bearing (340) − 90 = 250°.
  assert.ok(Math.abs(g.inlineAzimuth - 250) < 1e-6, `inlineAzimuth ${g.inlineAzimuth}`);
  // Map CRS lifted from the H18/H19 projection records.
  assert.equal(g.crs?.subtype, 'UTM', `crs subtype ${g.crs?.subtype}`);
  assert.equal(g.crs?.zone, 36, `crs zone ${g.crs?.zone}`);

  // nInline/nCrossline are NODE counts, so the grid spans (n−1) bin INTERVALS:
  // Wi=(4−1)·25=75, Wj=(2−1)·25=25. Four corners = origin + a·Î + b·Ĵ,
  // a∈{0,75}, b∈{0,25}. Î bears 250°; Ĵ bears the file's J-bearing 340° directly
  // (NOT assumed inline+90 — though here 340=250+90 anyway).
  assert.ok(g.corners && g.corners.length === 4, `corners ${g.corners?.length}`);
  assert.ok(Math.abs(g.crosslineAzimuth - 340) < 1e-6, `crosslineAzimuth ${g.crosslineAzimuth}`);
  const c = g.corners!;
  const D2R = Math.PI / 180;
  const iE = Math.sin(250 * D2R), iN = Math.cos(250 * D2R);
  const jE = Math.sin(340 * D2R), jN = Math.cos(340 * D2R);
  const Wi = 75, Wj = 25;
  const expect = [
    { e: 500000, n: 4000000 },
    { e: 500000 + Wi * iE, n: 4000000 + Wi * iN },
    { e: 500000 + Wi * iE + Wj * jE, n: 4000000 + Wi * iN + Wj * jN },
    { e: 500000 + Wj * jE, n: 4000000 + Wj * jN },
  ];
  for (let k = 0; k < 4; k++) {
    assert.ok(Math.abs(c[k].e - expect[k].e) < 1e-4, `corner ${k} E ${c[k].e} vs ${expect[k].e}`);
    assert.ok(Math.abs(c[k].n - expect[k].n) < 1e-4, `corner ${k} N ${c[k].n} vs ${expect[k].n}`);
  }
  console.log(`      golden: P6/11 origin (${g.originE},${g.originN}) az=${g.inlineAzimuth}° corners=${c.length}`);
});

test('detectPositioningFormat + parsePositioning route P6/11 to a bingrid', () => {
  // .p611 extension → 'p611'; content banner → 'p611'; dispatch yields kind:'bingrid'.
  assert.equal(detectPositioningFormat('grid.p611', ''), 'p611', 'extension routes to p611');
  const banner = 'H6,0,0,0, IOGP P6/11 Seismic Bin Grid\nH6,1,3, origin Easting, 1000.0';
  assert.equal(detectPositioningFormat('grid.txt', banner), 'p611', 'P6/11 banner sniffed');
  const res = parsePositioning('p611', banner);
  assert.equal(res.kind, 'bingrid', `kind ${res.kind}`);
  if (res.kind === 'bingrid') assert.ok(Math.abs(res.grid.originE - 1000) < 1e-6, `originE ${res.grid.originE}`);
});

test('parseP611 never throws on garbage / hostile input and stays bounded', () => {
  // Empty, non-string, and a pathological huge single line must all degrade to a
  // (possibly empty) BinGrid — never throw, never allocate from an unbounded count.
  assert.doesNotThrow(() => parseP611(''), 'empty input threw');
  assert.doesNotThrow(() => parseP611('not a grid\n\n,,,\nH6,xxx'), 'garbage input threw');
  // 200k-char single line: must be clipped, not carried verbatim, and not hang.
  const huge = 'H6,1,3, origin Easting, ' + '9'.repeat(200000);
  let g: any;
  assert.doesNotThrow(() => { g = parseP611(huge); }, 'huge line threw');
  assert.ok(g.raw.every((l: string) => l.length <= 4096), 'raw lines clipped to the per-line cap');
  // A prototype-pollution attempt via a forged header code must not touch Object.proto.
  assert.doesNotThrow(() => parseP611('H__proto__, x, 1\nHconstructor, y, 2'), '__proto__ header threw');
  assert.equal(({} as any).polluted, undefined, 'no prototype pollution');
});

// ── Geometry Integrity (SEG-Y headers vs SPS design) ──────────────────────────
console.log('\n[Geometry Integrity]');
{
  // Synthetic survey + synthetic SEG-Y header geometry. The trace headers store
  // coords as integers scaled by 100, so coordScalar = -100 (raw / 100 → metres).
  const mkS = (point: number, e: number, n: number, line = '1'): SPSPoint =>
    ({ rtype: 'S', lineName: line, point, idx: '', easting: e, northing: n, elevation: 0, raw: '', lineNum: point });
  const mkR = (point: number, e: number, n: number, line = '1'): SPSPoint =>
    ({ rtype: 'R', lineName: line, point, idx: '', easting: e, northing: n, elevation: 0, raw: '', lineNum: point });
  const mkSPS = (sources: SPSPoint[], receivers: SPSPoint[]): SPSData =>
    ({ sources, receivers, xrefs: [], headers: [], errors: [], skipped: 0, layout: 'SPS2.1' });

  const SC = -100;
  const sources = [1, 2, 3, 4, 5].map((p) => mkS(p, 1000 + p * 25, 2000));
  const rcv5 = [1, 2, 3, 4, 5].map((p) => mkR(p, 1000 + p * 12.5, 2050));
  const surveyClean = mkSPS(sources, rcv5);

  // Clean traces: one shot per source (ffid = point), 5 channels each hitting
  // receivers 1..5. Every coord lands exactly on its SPS station.
  const clean: TraceGeom[] = [];
  for (const s of sources) {
    for (let ch = 1; ch <= 5; ch++) {
      const rc = rcv5[ch - 1];
      clean.push({
        ffid: s.point, channel: ch, srcPt: s.point, ensemble: 0,
        srcX: s.easting * 100, srcY: s.northing * 100,
        rcvX: rc.easting * 100, rcvY: rc.northing * 100, coordScalar: SC,
      });
    }
  }

  test('applyScalar honours the SEG-Y coordinate-scalar rule', () => {
    assert.equal(applyScalar(102500, -100), 1025, 'negative scalar divides');
    assert.equal(applyScalar(5, 10), 50, 'positive scalar multiplies');
    assert.equal(applyScalar(7, 0), 7, 'zero scalar is identity (treated as 1)');
    assert.ok(Number.isNaN(applyScalar(NaN, -100)), 'non-finite raw stays NaN');
  });

  test('clean match → 0 errors, full coverage, every station matched', () => {
    const r = checkGeometry(clean, surveyClean);
    assert.equal(r.findings.filter((f) => f.sev === 'error').length, 0, 'no errors');
    assert.equal(r.srcCoveragePct, 100, 'full source coverage');
    assert.equal(r.rcvCoveragePct, 100, 'full receiver coverage');
    assert.equal(r.matchedSrcPts, 5, 'all 5 source points matched');
    assert.equal(r.matchedRcv, 5, 'all 5 receiver stations matched');
    assert.deepEqual(r.scalarValues, [-100], 'single scalar reported');
    assert.ok(!r.findings.some((f) => f.cat === 'MissingStation'), 'no spurious missing-station warn');
  });

  test('injected source offset (+10 m) → SourcePos error', () => {
    const off = clean.map((t) => (t.srcPt === 3 ? { ...t, srcX: t.srcX + 1000 } : t)); // +10 m at scale 100
    const r = checkGeometry(off, surveyClean);
    assert.ok(r.findings.some((f) => f.cat === 'SourcePos' && f.sev === 'error'), 'offset flagged');
    assert.equal(r.matchedSrcPts, 4, 'one source no longer matches');
  });

  test('swapped source X/Y → SourceSwap error', () => {
    const sw = clean.map((t) => ({ ...t, srcX: t.srcY, srcY: t.srcX }));
    const r = checkGeometry(sw, surveyClean);
    assert.ok(r.findings.some((f) => f.cat === 'SourceSwap' && f.sev === 'error'), 'swap flagged');
    assert.equal(r.matchedSrcPts, 0, 'no source matches in normal orientation');
    assert.ok(!r.findings.some((f) => f.cat === 'ReceiverPos'), 'receivers untouched → no receiver error');
  });

  test('source point absent from SPS but POSITION matches → SourceNumbering info, no error', () => {
    // Field SEG-Y often leaves byte-17 source-point 0/sequential (the true link is
    // in the X-file). Positions still land on SPS sources → matched by position.
    const posOnly = clean.map((t) => ({ ...t, srcPt: 0 }));
    const r = checkGeometry(posOnly, surveyClean);
    assert.equal(r.matchedSrcPts, 5, 'all 5 sources matched by position');
    assert.equal(r.findings.filter((f) => f.sev === 'error').length, 0, 'no errors — geometry is correct');
    assert.ok(r.findings.some((f) => f.cat === 'SourceNumbering' && f.sev === 'info'), 'numbering info emitted');
  });

  test('mixed coordinate scalars → Scalar warn, still matches', () => {
    const mixed = clean.map((t, i) =>
      i % 2 === 0 ? t : { ...t, coordScalar: -10, srcX: t.srcX / 10, srcY: t.srcY / 10, rcvX: t.rcvX / 10, rcvY: t.rcvY / 10 });
    const r = checkGeometry(mixed, surveyClean);
    assert.ok(r.findings.some((f) => f.cat === 'Scalar' && f.sev === 'warn'), 'mixed scalar warned');
    assert.equal(r.scalarValues.length, 2, 'two distinct scalars seen');
    assert.equal(r.findings.filter((f) => f.sev === 'error').length, 0, 'decoded coords still match');
  });

  test('missing stations → MissingStation warn', () => {
    const rcv10 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((p) => mkR(p, 1000 + p * 12.5, 2050));
    const r = checkGeometry(clean, mkSPS(sources, rcv10));
    const miss = r.findings.find((f) => f.cat === 'MissingStation' && f.sev === 'warn');
    assert.ok(miss, 'missing-station warn emitted');
    assert.equal(miss!.count, 5, '5 receivers (6..10) matched by zero traces');
  });

  test('zero-geometry traces → Coverage info, no false errors', () => {
    const zero = clean.map((t) => ({ ...t, srcX: 0, srcY: 0, rcvX: 0, rcvY: 0 }));
    const r = checkGeometry(zero, surveyClean);
    assert.equal(r.srcCoveragePct, 0, 'zero source coverage');
    assert.equal(r.rcvCoveragePct, 0, 'zero receiver coverage');
    assert.equal(r.findings.filter((f) => f.sev === 'error').length, 0, 'no false errors');
    assert.ok(r.findings.some((f) => f.cat === 'Coverage' && f.sev === 'info'), 'coverage info emitted');
  });

  test('never throws on empty / null / garbage input', () => {
    assert.doesNotThrow(() => checkGeometry([], mkSPS([], [])), 'empty threw');
    assert.doesNotThrow(() => checkGeometry(null as any, null as any), 'null threw');
    const garbageT: TraceGeom[] = [
      { ffid: NaN, channel: NaN, srcPt: NaN, ensemble: NaN, srcX: NaN, srcY: Infinity, rcvX: NaN, rcvY: NaN, coordScalar: NaN },
    ];
    const garbageSPS = mkSPS([mkS(NaN, NaN, NaN)], [mkR(NaN, Infinity, NaN)]);
    assert.doesNotThrow(() => checkGeometry(garbageT, garbageSPS), 'garbage threw');
  });

  // ── Post-stack safety net (dataType + StackState warning) ──
  // The source/receiver match is only meaningful for PRE-STACK data; CMP/
  // horizontally-stacked (post-stack) traces collapse to CDP midpoints (source ≈
  // receiver), which would false-flag. These tests pin the two OR'd detectors.
  test('pre-stack coords (source ≠ receiver) → dataType prestack, no StackState finding', () => {
    const r = checkGeometry(clean, surveyClean);
    assert.equal(r.dataType, 'prestack', 'good pre-stack data labelled prestack');
    assert.ok(!r.findings.some((f) => f.cat === 'StackState'), 'no post-stack warning on pre-stack data');
  });

  test('coordinate-collapse (source ≡ receiver per trace) → dataType poststack + StackState warn first', () => {
    // Post-stack/CDP: every trace carries the CDP midpoint in BOTH source and
    // receiver coordinate fields, so source coincides with receiver everywhere.
    const collapsed: TraceGeom[] = sources.map((s) => ({
      ffid: s.point, channel: 1, srcPt: s.point, ensemble: 0,
      srcX: s.easting * 100, srcY: s.northing * 100,
      rcvX: s.easting * 100, rcvY: s.northing * 100, coordScalar: SC,
    }));
    const r = checkGeometry(collapsed, surveyClean);
    assert.equal(r.dataType, 'poststack', 'collapse heuristic → poststack');
    const sf = r.findings.find((f) => f.cat === 'StackState' && f.sev === 'warn');
    assert.ok(sf, 'StackState warn emitted');
    assert.equal(r.findings[0].cat, 'StackState', 'StackState warning is prepended first');
  });

  test('binary-header trace-sorting code 4 → poststack even when coords look pre-stack', () => {
    // The good pre-stack `clean` coords would normally read prestack; a sorting
    // code of 4 (horizontally stacked) forces the post-stack label regardless.
    const r = checkGeometry(clean, surveyClean, { traceSorting: 4 });
    assert.equal(r.dataType, 'poststack', 'trace-sorting 4 forces poststack');
    assert.ok(r.findings.some((f) => f.cat === 'StackState' && f.sev === 'warn'), 'StackState warn from sorting code');
  });

  test('trace-sorting code 1 (as recorded) + pre-stack coords → prestack, no false warning', () => {
    const r = checkGeometry(clean, surveyClean, { traceSorting: 1 });
    assert.equal(r.dataType, 'prestack', 'as-recorded sorting stays pre-stack');
    assert.ok(!r.findings.some((f) => f.cat === 'StackState'), 'no false post-stack warning');
    assert.equal(r.findings.filter((f) => f.sev === 'error').length, 0, 'existing pre-stack checks unaffected');
  });
}

// ── Load geometry into SEG-Y (geomload — the WRITE counterpart of geomcheck) ───
console.log('\n[Geometry load]');
{
  // Helpers mirror the geomcheck block: plain SPSPoint/SPSData factories.
  const gS = (point: number, e: number, n: number, z: number): SPSPoint =>
    ({ rtype: 'S', lineName: '1', point, idx: '', easting: e, northing: n, elevation: z, raw: '', lineNum: point });
  const gR = (point: number, e: number, n: number, z: number): SPSPoint =>
    ({ rtype: 'R', lineName: '1', point, idx: '', easting: e, northing: n, elevation: z, raw: '', lineNum: point });
  const gSPS = (sources: SPSPoint[], receivers: SPSPoint[]): SPSData =>
    ({ sources, receivers, xrefs: [], headers: [], errors: [], skipped: 0, layout: 'SPS2.1' });

  // 3 sources × 3 receivers (all-integer coords/elev so writeSEGY's raw int header
  // write is lossless). The synthetic SEG-Y carries the SPS positions in its source/
  // receiver coordinate fields (scalar 0 = raw metres) so loadGeometry pairs each
  // trace BY POSITION (writeSEGY does not emit byte-17 source-point, so number-match
  // can't apply here) and re-stamps them with the chosen scalar + elevation/offset/CDP.
  const gSrc = [1, 2, 3].map((p) => gS(p, 1000 + p * 25, 2000, 100 + p)); // 1025/1050/1075, z 101..103
  const gRcv = [1, 2, 3].map((p) => gR(p, 1000 + p * 10, 2050, 50 + p)); // 1010/1020/1030, z 51..53
  const sps = gSPS(gSrc, gRcv);

  const mkTraces = (): Trace[] => {
    const traces: Trace[] = [];
    for (const s of gSrc) {
      for (const rc of gRcv) {
        const hdr: Record<string, number> = {
          fieldRec: s.point, trcField: rc.point, srcPt: s.point,
          srcX: s.easting, srcY: s.northing, rcvX: rc.easting, rcvY: rc.northing, coordScalar: 0,
        };
        traces.push({ hdr, samples: Float32Array.from([1, -2, 3, -4]), nSamples: 4, dataFmt: 5 });
      }
    }
    return traces;
  };
  const mkSegy = (): Uint8Array => {
    const pf: ParsedFile = { format: 'SEG-Y', revision: 1, textHeader: '', bh: { sampleInt: 2000 }, traces: mkTraces(), traceCount: 9, errors: [] };
    return writeSEGY(pf, 1);
  };
  // Read a CDP coordinate (bytes 181-184 / 185-188, big-endian) that decodeSegyTrace
  // doesn't surface — straight off the patched bytes for the round-trip assert.
  const cdpRaw = (b: Uint8Array, traceIdx: number, which: 'x' | 'y'): number => {
    const off = 3600 + traceIdx * (240 + 4 * 4) + (which === 'x' ? 180 : 184);
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(off, false);
  };

  test('encodeScalar is the exact inverse of applyScalar (round-trips the SEG-Y scalar rule)', () => {
    assert.equal(encodeScalar(1025, -100), 102500, 'negative scalar stores value × |scalar|');
    assert.equal(applyScalar(encodeScalar(1017.5, -100), -100), 1017.5, '−100 preserves 2 dp');
    assert.equal(encodeScalar(50, 10), 5, 'positive scalar stores value / scalar');
    assert.equal(encodeScalar(NaN, -100), 0, 'non-finite real encodes to 0');
  });

  test('loadGeometry stamps SPS source/receiver X/Y with the scalar (re-parse round-trips)', () => {
    const res = loadGeometry(mkSegy(), sps, { coordScalar: -100, tolM: 2 });
    assert.equal(res.traceCount, 9, 'all 9 traces walked');
    assert.equal(res.matched, 9, 'every trace matched a source AND receiver');
    assert.equal(res.unmatched, 0, 'no unmatched traces');
    assert.equal(res.srcStations, 3, '3 distinct SPS sources stamped');
    assert.equal(res.rcvStations, 3, '3 distinct SPS receivers stamped');
    assert.equal(res.coordScalar, -100, 'scalar reported');

    const pf2 = parseSEGY(res.bytes);
    assert.equal(pf2.traceCount, 9, 're-parse sees 9 traces');
    const h0 = pf2.traces[0].hdr; // shot 1, receiver 1
    assert.equal(h0.coordScalar, -100, 'coordinate scalar written to byte 71-72');
    assert.equal(applyScalar(h0.srcX as number, h0.coordScalar as number), 1025, 'source X decodes to SPS easting');
    assert.equal(applyScalar(h0.srcY as number, h0.coordScalar as number), 2000, 'source Y decodes to SPS northing');
    assert.equal(applyScalar(h0.rcvX as number, h0.coordScalar as number), 1010, 'group X decodes to SPS receiver easting');
    assert.equal(applyScalar(h0.rcvY as number, h0.coordScalar as number), 2050, 'group Y decodes to SPS receiver northing');
  });

  test('loadGeometry stamps elevation, offset and CDP midpoint', () => {
    const res = loadGeometry(mkSegy(), sps, { coordScalar: -100, tolM: 2 });
    const pf2 = parseSEGY(res.bytes);
    const h0 = pf2.traces[0].hdr; // shot 1 (z 101), receiver 1 (z 51)
    assert.equal(h0.elevScalar, -100, 'elevation scalar written');
    assert.equal(applyScalar(h0.surfElev as number, h0.elevScalar as number), 101, 'source surface elevation');
    assert.equal(applyScalar(h0.rcvElev as number, h0.elevScalar as number), 51, 'receiver group elevation');
    // offset = round(hypot(1025-1010, 2000-2050)) = round(hypot(15,50)) = 52
    assert.equal(h0.offset, 52, 'source→receiver offset (unscaled integer metres)');
    // CDP midpoint = ((1025+1010)/2, (2000+2050)/2) = (1017.5, 2025), scaled ×100.
    assert.equal(applyScalar(cdpRaw(res.bytes, 0, 'x'), -100), 1017.5, 'CDP X is the source/receiver midpoint');
    assert.equal(applyScalar(cdpRaw(res.bytes, 0, 'y'), -100), 2025, 'CDP Y is the source/receiver midpoint');
  });

  test('field-group toggles + summary: CDP off leaves CDP bytes untouched (0)', () => {
    const res = loadGeometry(mkSegy(), sps, { coordScalar: -100, writeCdp: false });
    assert.equal(cdpRaw(res.bytes, 0, 'x'), 0, 'CDP X not written when writeCdp:false');
    assert.ok(!res.fieldsWritten.includes('CDP X/Y'), 'CDP not listed in fieldsWritten');
    assert.ok(res.fieldsWritten.includes('source X/Y') && res.fieldsWritten.includes('group (receiver) X/Y'), 'coords still written');
  });

  test('unmatched traces are left unchanged (no SPS station within tol)', () => {
    // Move every SPS station 100 m away → nothing within the 2 m tol.
    const farSps = gSPS(gSrc.map((s) => gS(s.point, s.easting + 100, s.northing + 100, s.elevation)),
      gRcv.map((r) => gR(r.point, r.easting + 100, r.northing + 100, r.elevation)));
    const res = loadGeometry(mkSegy(), farSps, { coordScalar: -100, tolM: 2 });
    assert.equal(res.matched, 0, 'no trace matched');
    assert.equal(res.unmatched, 9, 'all 9 unmatched');
    // The original header coords (scalar 0) survive untouched.
    const pf2 = parseSEGY(res.bytes);
    assert.equal(pf2.traces[0].hdr.coordScalar, 0, 'scalar not rewritten on an untouched trace');
    assert.equal(pf2.traces[0].hdr.srcX, 1025, 'original source X preserved');
  });

  test('never throws on a short / empty / no-SPS buffer', () => {
    assert.doesNotThrow(() => loadGeometry(new Uint8Array(10), sps), 'short buffer threw');
    assert.doesNotThrow(() => loadGeometry(mkSegy(), gSPS([], [])), 'empty SPS threw');
    const r = loadGeometry(new Uint8Array(10), sps);
    assert.ok(r.errors.length > 0, 'short buffer reported an error, did not throw');
  });
}

// ── As-laid vs Pre-plot delta (SPS skid report) ───────────────────────────────
console.log('\n[SPS delta]');
{
  // Synthetic as-laid + reference (pre-plot) surveys. Helpers mirror the geomcheck
  // block: plain SPSPoint/SPSData factories with no file dependency.
  const dS = (point: number, e: number, n: number, line = '395'): SPSPoint =>
    ({ rtype: 'S', lineName: line, point, idx: '', easting: e, northing: n, elevation: 0, raw: '', lineNum: point });
  const dR = (point: number, e: number, n: number, line = '500'): SPSPoint =>
    ({ rtype: 'R', lineName: line, point, idx: '', easting: e, northing: n, elevation: 0, raw: '', lineNum: point });
  const dSPS = (sources: SPSPoint[], receivers: SPSPoint[]): SPSData =>
    ({ sources, receivers, xrefs: [], headers: [], errors: [], skipped: 0, layout: 'SPS2.1' });

  // Pre-plot: 5 sources + 5 receivers on a tidy grid.
  const planS = [1, 2, 3, 4, 5].map((p) => dS(p, 660000 + p * 25, 3550000));
  const planR = [1, 2, 3, 4, 5].map((p) => dR(p, 661000 + p * 25, 3551000));
  const preplot = dSPS(planS, planR);

  test('identical as-laid == reference → 0 skid, 0 over-tol, every station matched', () => {
    const r = compareSPS(dSPS(planS.map((s) => ({ ...s })), planR.map((s) => ({ ...s }))), preplot);
    assert.equal(r.matchKey, 'line+point', 'matched on line+point');
    assert.equal(r.sources.matched, 5); assert.equal(r.receivers.matched, 5);
    assert.equal(r.sources.maxDist, 0, 'no source skid'); assert.equal(r.receivers.maxDist, 0, 'no receiver skid');
    assert.equal(r.sources.overTol, 0); assert.equal(r.receivers.overTol, 0);
    assert.equal(r.sources.addedInAsLaid, 0); assert.equal(r.sources.missingFromAsLaid, 0);
    assert.equal(r.sources.offenders.length, 0, 'no offenders');
    assert.ok(r.note == null, `unexpected note: ${r.note}`);
  });

  test('known per-station offset → correct dE/dN/dist + over-tol flagged at tolM=1', () => {
    // Skid source pt 3 by +3 E / +4 N (dist 5), pt 5 by +0.5 E (dist 0.5, under tol).
    const asLaidS = planS.map((s) =>
      s.point === 3 ? { ...s, easting: s.easting + 3, northing: s.northing + 4 }
      : s.point === 5 ? { ...s, easting: s.easting + 0.5 } : { ...s });
    const r = compareSPS(dSPS(asLaidS, planR.map((s) => ({ ...s }))), preplot, { tolM: 1 });
    assert.equal(r.sources.matched, 5);
    assert.equal(r.sources.overTol, 1, 'only the 5 m skid is over a 1 m tol');
    assert.equal(r.sources.maxDist, 5, 'max skid = 5 m');
    const off = r.sources.offenders[0];
    assert.ok(off && off.point === 3, 'worst offender is pt 3');
    assert.equal(off.dE, 3); assert.equal(off.dN, 4); assert.equal(off.dist, 5); assert.equal(off.overTol, true);
    // p95 over [0,0,5,0.5,0] sorted = [0,0,0,0.5,5] → idx ceil(0.95*5)-1 = 4 → 5.
    assert.equal(r.sources.p95Dist, 5, `p95 ${r.sources.p95Dist}`);
    assert.equal(r.receivers.overTol, 0, 'receivers untouched');
  });

  test('duplicate as-laid station (re-occupation) counted + listed once, worst offset kept', () => {
    // Two as-laid records for source pt 1 (same line+point): +0.5 m (under tol) and +6 m (over tol).
    const dupS = [
      { ...planS[0], easting: planS[0].easting + 0.5 },
      { ...planS[0], easting: planS[0].easting + 6 },
      ...planS.slice(1).map((s) => ({ ...s })),
    ];
    const r = compareSPS(dSPS(dupS, planR.map((s) => ({ ...s }))), preplot, { tolM: 1 });
    assert.equal(r.sources.matched, 5, 'duplicate collapsed → 5 unique matched (not 6)');
    assert.equal(r.sources.overTol, 1, 'pt 1 over tol, counted once');
    const pt1 = r.sources.offenders.filter((o) => o.point === 1);
    assert.equal(pt1.length, 1, 'pt 1 appears once in offenders');
    assert.equal(pt1[0].dist, 6, 'worst (6 m) offset kept over the 0.5 m one');
  });

  test('station added in as-laid / missing from as-laid are counted, not matched', () => {
    // As-laid drops plan source pt 5 (missing from as-laid) and adds a new pt 9.
    const asLaidS = [...planS.filter((s) => s.point !== 5).map((s) => ({ ...s })), dS(9, 660999, 3550000)];
    const r = compareSPS(dSPS(asLaidS, planR.map((s) => ({ ...s }))), preplot);
    assert.equal(r.sources.matched, 4, '4 of 5 plan sources matched');
    assert.equal(r.sources.addedInAsLaid, 1, 'pt 9 is new in as-laid');
    assert.equal(r.sources.missingFromAsLaid, 1, 'plan pt 5 absent from as-laid');
  });

  test('numbering-mismatch fallback: line+point fails → matches by point alone', () => {
    // Same station numbers, DIFFERENT line names (as-laid line "395" vs plan "L395").
    const asLaidS = planS.map((s) => ({ ...s, lineName: 'L395', easting: s.easting + 0.2 }));
    const asLaidR = planR.map((s) => ({ ...s, lineName: 'L500', easting: s.easting + 0.2 }));
    const r = compareSPS(dSPS(asLaidS, asLaidR), preplot);
    assert.equal(r.matchKey, 'point', 'fell back to point-only matching');
    assert.equal(r.sources.matched, 5, 'all sources matched on point alone');
    assert.equal(r.receivers.matched, 5, 'all receivers matched on point alone');
    assert.ok(r.note && /point number alone/.test(r.note), `expected fallback note, got: ${r.note}`);
    assert.ok(Math.abs(r.sources.maxDist - 0.2) < 1e-6, `skid ${r.sources.maxDist}`);
  });

  test('unrelated surveys (no shared numbering) → note, no forced matches', () => {
    const otherS = [11, 12, 13].map((p) => dS(p + 1000, 700000 + p, 3600000, '900'));
    const r = compareSPS(dSPS(otherS, []), preplot);
    assert.equal(r.sources.matched, 0, 'nothing legitimately matches');
    assert.ok(r.note && /do not appear to share/.test(r.note), `expected mismatch note, got: ${r.note}`);
  });

  test('never throws on empty / null / garbage input', () => {
    assert.doesNotThrow(() => compareSPS(dSPS([], []), dSPS([], [])), 'empty threw');
    assert.doesNotThrow(() => compareSPS(null as any, null as any), 'null threw');
    const empty = compareSPS(dSPS([], []), preplot);
    assert.ok(empty.note && /Nothing to compare/.test(empty.note), 'empty as-laid noted');
    assert.equal(empty.sources.matched, 0);
    const garbageA = dSPS([dS(1, NaN, NaN)], [dR(1, Infinity, NaN)]);
    const garbageB = dSPS([dS(1, NaN, NaN)], [dR(1, NaN, Infinity)]);
    assert.doesNotThrow(() => {
      const r = compareSPS(garbageA, garbageB);
      assert.ok(Number.isFinite(r.sources.maxDist) && Number.isFinite(r.sources.meanDist) && Number.isFinite(r.sources.p95Dist), 'no NaN in stats');
    }, 'garbage threw');
  });
}

// ── Sweep generator (sweepgen + hilbert — Sweeps tab core) ──────────────────
console.log('\n[sweepgen]');
{
  const linSpec = { ...DEFAULT_SWEEP_SPEC }; // 8–96 Hz · 12 s · 300/300 ms cosine · 0.5 ms

  test('linear sweep: endpoint frequencies exact, sample count = T/dt + 1', () => {
    const r = generateSweep(linSpec);
    assert.equal(r.meta.nSamples, 24001, '12 s at 0.5 ms → 24001 samples (endpoint inclusive)');
    assert.equal(r.freqOfT[0], 8, 'starts exactly at f0');
    assert.equal(r.freqOfT[r.meta.nSamples - 1], 96, 'ends exactly at f1');
    assert.equal(r.samples.length, r.freqOfT.length);
    assert.equal(r.samples.length, r.envelope.length);
  });

  test('downsweep (f0 > f1) endpoints exact', () => {
    const r = generateSweep({ ...linSpec, f0: 96, f1: 8 });
    assert.equal(r.freqOfT[0], 96);
    assert.equal(r.freqOfT[r.meta.nSamples - 1], 8);
  });

  test('taper edges → 0; envelope plateau = amplitude between the tapers', () => {
    for (const taperType of ['cosine', 'blackman'] as const) {
      const r = generateSweep({ ...linSpec, taperType });
      const n = r.meta.nSamples;
      assert.ok(Math.abs(r.envelope[0]) < 1e-9, `${taperType}: envelope 0 at start`);
      assert.ok(Math.abs(r.envelope[n - 1]) < 1e-9, `${taperType}: envelope 0 at end`);
      assert.ok(Math.abs(r.samples[0]) < 1e-9 && Math.abs(r.samples[n - 1]) < 1e-9, `${taperType}: samples 0 at edges`);
      assert.ok(Math.abs(r.envelope[n >> 1] - 1) < 1e-9, `${taperType}: full amplitude mid-sweep`);
    }
  });

  test('linear sweep spectrum is ~flat inside the band (20–80 Hz)', () => {
    // NOTE: deliberately NOT amplitudeSpectrum() — its whole-trace Hann window
    // maps onto the chirp's time→frequency sweep and would shape the in-band
    // level like the window. A raw (unwindowed) FFT shows the true flat band;
    // the sweep's own 300 ms tapers already control the edge leakage.
    const r = generateSweep(linSpec);
    const N = nextPow2(r.samples.length);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    re.set(r.samples);
    fft(re, im, false);
    const binHz = 2000 / N; // fs = 1/0.5 ms
    const band: number[] = [];
    for (let k = 1; k < N >> 1; k++) {
      const f = k * binHz;
      if (f >= 20 && f <= 80) band.push(Math.hypot(re[k], im[k]));
    }
    assert.ok(band.length > 100, 'enough in-band bins');
    const sorted = [...band].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    assert.ok(median > 0, 'non-zero in-band level');
    const lo = sorted[0] / median;
    const hi = sorted[sorted.length - 1] / median;
    assert.ok(lo > 0.6 && hi < 1.5, `in-band ripple within bounds (min ${lo.toFixed(2)}×, max ${hi.toFixed(2)}× median)`);
  });

  test('Klauder wavelet: peak 1 at lag 0, symmetric, side lobes well below peak', () => {
    const r = generateSweep(linSpec);
    const k = klauderAnalysis(r.samples, 500, 250);
    const c = (k.wavelet.length - 1) >> 1;
    assert.ok(Math.abs(k.wavelet[c] - 1) < 1e-6, 'normalized peak at lag 0');
    assert.equal(k.lagsMs[c], 0, 'lag axis centred');
    for (const j of [5, 50, 200, 400]) {
      if (c + j >= k.wavelet.length) break;
      assert.ok(Math.abs(k.wavelet[c + j] - k.wavelet[c - j]) < 1e-3, `symmetric at ±lag ${j}`);
    }
    assert.ok(k.peakSidelobeDb > 6, `peak/side-lobe ${k.peakSidelobeDb.toFixed(1)} dB > 6 dB`);
    assert.ok(k.mainLobeMs > 0 && k.mainLobeMs < 50, `main lobe ${k.mainLobeMs.toFixed(1)} ms sane`);
  });

  // Dwell-time-per-band checks straight off freqOfT — the defining property of the
  // dB/Hz and dB/octave shapings (time spent per Hz sets the energy density there).
  const dwell = (freqOfT: Float32Array, a: number, b: number): number => {
    let c = 0;
    for (let i = 0; i < freqOfT.length; i++) if (freqOfT[i] >= a && freqOfT[i] < b) c++;
    return c;
  };

  test('dB/Hz sweep: dwell ratio between bands matches 10^(k·Δf/10)', () => {
    const k = 0.2;
    const r = generateSweep({ ...linSpec, type: 'dbhz', f0: 10, f1: 100, lengthMs: 20000, slope: k });
    const ratio = dwell(r.freqOfT, 58, 62) / dwell(r.freqOfT, 28, 32);
    const expect = Math.pow(10, (k * 30) / 10); // band centres 30 → 60 Hz
    assert.ok(Math.abs(ratio / expect - 1) < 0.08, `dwell ratio ${ratio.toFixed(3)} ≈ ${expect.toFixed(3)}`);
  });

  test('dB/octave sweep: dwell ratio between bands matches f^p integral (p = k·log2(10)/10)', () => {
    const k = 3;
    const r = generateSweep({ ...linSpec, type: 'dboct', f0: 10, f1: 100, lengthMs: 20000, slope: k });
    const ratio = dwell(r.freqOfT, 58, 62) / dwell(r.freqOfT, 28, 32);
    const q = (k * Math.log2(10)) / 10 + 1;
    const expect = (Math.pow(62, q) - Math.pow(58, q)) / (Math.pow(32, q) - Math.pow(28, q));
    assert.ok(Math.abs(ratio / expect - 1) < 0.08, `dwell ratio ${ratio.toFixed(3)} ≈ ${expect.toFixed(3)}`);
  });

  test('T-power sweep: f(T/2) = f0 + (f1−f0)·(1/2)^(n+1)', () => {
    const r = generateSweep({ ...linSpec, type: 'tpower', f0: 8, f1: 96, slope: 1 });
    const mid = r.freqOfT[(r.meta.nSamples - 1) >> 1];
    const expect = 8 + (96 - 8) * 0.25; // (t/T)² at t=T/2
    assert.ok(Math.abs(mid - expect) < 0.05, `f(T/2) ${mid.toFixed(3)} ≈ ${expect}`);
  });

  test('segmented sweep is phase-continuous at the join (no waveform step)', () => {
    const r = generateSweep({
      ...linSpec,
      segments: [
        { type: 'linear', f0: 8, f1: 40, lengthMs: 6000 },
        { type: 'dboct', f0: 40, f1: 96, lengthMs: 6000, slope: 3 },
      ],
    });
    const n = r.meta.nSamples;
    assert.equal(n, 24001, 'two 6 s segments at 0.5 ms');
    // Frequency continuous at the join (sample 12000 = t 6 s).
    assert.ok(Math.abs(r.freqOfT[12000] - 40) < 0.05, `f at join ${r.freqOfT[12000].toFixed(3)} ≈ 40`);
    // No amplitude step anywhere in the un-tapered interior: |Δx| between adjacent
    // samples of A·cos(φ) is bounded by ~2π·fmax·dt (a phase break would jump ~2).
    const dt = 0.0005;
    const bound = 2 * Math.PI * 96 * dt * 1.15;
    let maxStep = 0;
    for (let i = 1000; i < n - 1000; i++) {
      const d = Math.abs(r.samples[i] - r.samples[i - 1]);
      if (d > maxStep) maxStep = d;
    }
    assert.ok(maxStep < bound, `max waveform step ${maxStep.toFixed(4)} < ${bound.toFixed(4)}`);
  });

  test('initial phase 180° flips polarity (Pelton positive-up pilot rule)', () => {
    const a = generateSweep(linSpec);
    const b = generateSweep({ ...linSpec, initialPhaseDeg: 180 });
    for (const i of [6000, 12000, 18000]) {
      assert.ok(Math.abs(a.samples[i] + b.samples[i]) < 1e-4, `sample ${i} inverted`);
    }
  });

  test('validateSweepSpec rejects bad rate / Nyquist / >16 segments / zero amplitude', () => {
    assert.ok(validateSweepSpec({ ...linSpec, sampleIntervalUs: 300 }).some((e) => /sample interval/.test(e)), 'non-standard rate rejected');
    assert.ok(validateSweepSpec({ ...linSpec, f1: 400, sampleIntervalUs: 2000 }).some((e) => /Nyquist/.test(e)), 'above-Nyquist f1 rejected');
    const many = Array.from({ length: 17 }, () => ({ type: 'linear' as const, f0: 10, f1: 20, lengthMs: 100 }));
    assert.ok(validateSweepSpec({ ...linSpec, segments: many }).some((e) => /segments/.test(e)), '17 segments rejected');
    assert.ok(validateSweepSpec({ ...linSpec, amplitude: 0 }).some((e) => /amplitude/.test(e)), 'zero amplitude rejected');
    assert.equal(validateSweepSpec(linSpec).length, 0, 'the default spec is valid');
  });

  test('instantaneousPhase recovers a pure tone’s frequency and envelope', () => {
    const n = 1000; // 1 s at 1 ms
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.cos(2 * Math.PI * 20 * (i / 1000));
    const ip = instantaneousPhase(x);
    const slope = (ip.phaseRad[700] - ip.phaseRad[300]) / 0.4; // rad/s over the interior
    assert.ok(Math.abs(slope / (2 * Math.PI * 20) - 1) < 0.01, `phase slope ${(slope / (2 * Math.PI)).toFixed(2)} Hz ≈ 20 Hz`);
    assert.ok(Math.abs(ip.envelope[n >> 1] - 1) < 0.02, 'unit envelope mid-signal');
  });

  test('thdEstimate: clean sweep ≈ 0, quadratically distorted copy reads ~10%', () => {
    const r = generateSweep({ ...linSpec, f0: 10, f1: 80, lengthMs: 8000 });
    const clean = thdEstimate(r.samples, r.freqOfT, 500);
    assert.ok(clean.timesMs.length > 10, 'clean series has points');
    assert.ok(clean.avgPct < 5, `clean THD ${clean.avgPct.toFixed(2)}% < 5%`);
    const dist = new Float32Array(r.samples.length);
    for (let i = 0; i < dist.length; i++) dist[i] = r.samples[i] + 0.2 * r.samples[i] * r.samples[i];
    const thd = thdEstimate(dist, r.freqOfT, 500);
    assert.ok(thd.avgPct > clean.avgPct + 4, `distorted ${thd.avgPct.toFixed(2)}% ≫ clean ${clean.avgPct.toFixed(2)}%`);
    assert.ok(thd.avgPct > 6 && thd.avgPct < 25, `distorted THD ${thd.avgPct.toFixed(2)}% in the ~10% ballpark`);
  });
}

// ── SCIO .SV sweep-definition table ──────────────────────────────────────────
console.log('\n[.SV]');
{
  const spec = { ...DEFAULT_SWEEP_SPEC }; // 8–96 Hz · 12 s · 0.5 ms pilot; .SV is 2048 sps regardless

  test('structure: CRLF lines, 3 × 7-char columns, 2048 sps count, envelope full scale', () => {
    const sv = buildSVText(spec);
    assert.ok(sv.endsWith('\r\n'), 'CRLF terminated');
    const lines = sv.split('\r\n').filter((l) => l !== '');
    assert.equal(lines.length, 12 * SV_RATE_HZ + 1, '12 s at 2048 sps + endpoint');
    for (const l of [lines[0], lines[1000], lines[lines.length - 1]]) {
      assert.equal(l.length, 21, 'exactly 21 characters per line');
    }
    assert.equal(parseInt(lines[0].slice(0, 7), 10), 1, 'sample numbers are 1-based');
    const p = parseSVText(sv);
    assert.equal(p.sampleNum.length, lines.length, 'every line parses');
    let maxEnv = 0;
    for (let i = 0; i < p.envFrac.length; i++) if (p.envFrac[i] > maxEnv) maxEnv = p.envFrac[i];
    assert.equal(maxEnv, 1, 'amplitude 1 → envelope reaches 32767 (10 V full scale)');
  });

  test('phase column round-trips to < 0.006° (int16 = deg × 65536/360)', () => {
    const r = generateSweepAtRate(spec, SV_RATE_HZ);
    const p = parseSVText(buildSVText(spec));
    assert.equal(p.phaseDeg.length, r.meta.nSamples);
    let maxPhErr = 0;
    let maxEnvErr = 0;
    for (let i = 0; i < p.phaseDeg.length; i++) {
      const d = Math.abs(wrapDeg180(r.phaseDeg[i] - p.phaseDeg[i]));
      if (d > maxPhErr) maxPhErr = d;
      const e = Math.abs(p.envFrac[i] - r.envelope[i]);
      if (e > maxEnvErr) maxEnvErr = e;
    }
    assert.ok(maxPhErr < 0.006, `max phase error ${maxPhErr.toFixed(5)}° < 0.006°`);
    assert.ok(maxEnvErr < 1e-4, `max envelope error ${maxEnvErr.toExponential(2)} < 1e-4`);
  });

  test('non-trivial initial phase survives the table (φ0 = −90°)', () => {
    const s2 = { ...spec, initialPhaseDeg: -90 };
    const p = parseSVText(buildSVText(s2));
    assert.ok(Math.abs(p.phaseDeg[0] - -90) < 0.006, `first phase ${p.phaseDeg[0].toFixed(4)}° ≈ −90°`);
  });
}

// ── Trigger Watch parsers (core/trigger/parse) ────────────────────────────────
// The Observer Log "Trigger Watch" wire parsers: the trigger box's serial
// `[SHOT] #id Lline:SPsp ts=…` lines (tolerant), generic TRIG lines, and the
// UDP text/JSON contract — plus the defensive caps a hostile packet must hit.
console.log('\ntrigger parsers (Trigger Watch)');
{
  test('full [SHOT] line parses id / line / SP / ts', () => {
    const m = parseTriggerLine('[SHOT] #12 L0395:SP1042 ts=2026-07-04T06:33:41.123Z');
    assert.ok(m, 'parsed');
    assert.equal(m!.kind, 'shot');
    assert.equal(m!.id, 12);
    assert.equal(m!.line, '0395');
    assert.equal(m!.sp, 1042);
    assert.equal(m!.ts, '2026-07-04T06:33:41.123Z');
  });

  test('[SHOT] is tolerant: case, spacing, negative/decimal SP, no ts', () => {
    const m = parseTriggerLine('[shot]#7  l12.5A : sp -204.5');
    assert.ok(m, 'parsed');
    assert.equal(m!.kind, 'shot');
    assert.equal(m!.id, 7);
    assert.equal(m!.line, '12.5A');
    assert.equal(m!.sp, -204.5);
    assert.equal(m!.ts, null);
  });

  test('[SHOT] with id only still parses (line/SP/ts null)', () => {
    const m = parseTriggerLine('[SHOT] #5');
    assert.ok(m, 'parsed');
    assert.deepEqual([m!.id, m!.line, m!.sp, m!.ts], [5, null, null, null]);
  });

  test('generic TRIG lines are accepted (bare TRIG and TRIGGER <n>)', () => {
    const bare = parseTriggerLine('TRIG');
    assert.ok(bare, 'bare TRIG parsed');
    assert.equal(bare!.kind, 'trig');
    assert.equal(bare!.id, null);
    const withN = parseTriggerLine('TRIGGER 5');
    assert.ok(withN, 'TRIGGER 5 parsed');
    assert.equal(withN!.id, 5);
  });

  test('non-trigger chatter returns null (boot text, NMEA, empty, non-string)', () => {
    assert.equal(parseTriggerLine('GPS fix ok 12 sats'), null);
    assert.equal(parseTriggerLine('$GPGGA,123519,4807.038,N'), null);
    assert.equal(parseTriggerLine(''), null);
    assert.equal(parseTriggerLine(42 as unknown as string), null);
    assert.equal(parseTriggerLine(null), null);
  });

  test('length cap: a line over TRIGGER_TEXT_MAX chars is rejected', () => {
    const long = '[SHOT] #1 ' + 'x'.repeat(TRIGGER_TEXT_MAX);
    assert.equal(parseTriggerLine(long), null);
    assert.ok(parseTriggerLine('[SHOT] #1'), 'short line still parses');
  });

  test('control characters are stripped before parsing (serial glitch)', () => {
    const m = parseTriggerLine('\x02[SHOT]\x07 #9 L1:SP2\x00');
    assert.ok(m, 'parsed despite control bytes');
    assert.equal(m!.id, 9);
    assert.equal(m!.sp, 2);
    assert.ok(!/[\x00-\x08]/.test(m!.raw), 'raw is control-clean');
  });

  test('oversized shot id (>9 digits) is not parsed as id', () => {
    const m = parseTriggerLine('[SHOT] #12345678901');
    assert.ok(m, 'still a shot line');
    assert.equal(m!.id, null);
  });

  test('UDP JSON {"trig":id,"ts":iso} parses', () => {
    const m = parseUdpTrigger('{"trig":42,"ts":"2026-07-04T06:00:00Z"}');
    assert.ok(m, 'parsed');
    assert.equal(m!.kind, 'shot');
    assert.equal(m!.id, 42);
    assert.equal(m!.ts, '2026-07-04T06:00:00Z');
  });

  test('UDP JSON sp/line fields parse; epoch ts (s and ms) → ISO', () => {
    const m = parseUdpTrigger('{"id":3,"sp":1042,"line":"0395","ts":1751610000}');
    assert.ok(m, 'parsed');
    assert.equal(m!.sp, 1042);
    assert.equal(m!.line, '0395');
    assert.equal(m!.ts, new Date(1751610000 * 1000).toISOString());
    const ms = parseUdpTrigger('{"trig":1,"ts":1751610000123}');
    assert.equal(ms!.ts, new Date(1751610000123).toISOString());
  });

  test('UDP garbage is dropped: bad JSON, arrays, objects with no trigger fields', () => {
    assert.equal(parseUdpTrigger('{not json'), null);
    assert.equal(parseUdpTrigger('[1,2,3]'), null);
    assert.equal(parseUdpTrigger('{"foo":1,"bar":"x"}'), null);
    assert.equal(parseUdpTrigger('{"trig":"not-a-number"}'), null);
    assert.equal(parseUdpTrigger('{"trig":-5}'), null);
    assert.equal(parseUdpTrigger('x'.repeat(TRIGGER_TEXT_MAX + 1)), null);
  });

  test('UDP plain-text lines go through the serial grammar', () => {
    const m = parseUdpTrigger('[SHOT] #77 L0395:SP1042');
    assert.ok(m, 'parsed');
    assert.equal(m!.id, 77);
    assert.equal(m!.sp, 1042);
  });

  test('UDP JSON with __proto__ key is inert (no prototype pollution)', () => {
    const m = parseUdpTrigger('{"__proto__":{"polluted":true},"trig":1}');
    assert.ok(m, 'still parses the honest fields');
    assert.equal(m!.id, 1);
    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype untouched');
  });

  test('serial CRLF line endings are tolerated (PowerShell ReadLine leaves \\r)', () => {
    const m = parseTriggerLine('[SHOT] #3 L0395:SP2006 ts=2026-07-04T07:00:00.000Z\r');
    assert.ok(m, 'parsed');
    assert.equal(m!.id, 3);
    assert.equal(m!.sp, 2006);
    assert.equal(m!.ts, '2026-07-04T07:00:00.000Z');
  });

  test('serial reader chatter (open marker, prompts) is not a trigger', () => {
    assert.equal(parseTriggerLine('SEISCONV_SERIAL_OPEN'), null);
    assert.equal(parseTriggerLine('Windows PowerShell'), null);
  });

  // ── SCS survey-log source (core/trigger/parse: parseScsLogLine / scsLogKey) ──
  test('SCS log: a SAVED shot line parses (shot/stack/loc/time/date/kb/status)', () => {
    const p = parseScsLogLine(' File      17 (Stack  1, Shot Loc: 0 Meters) 11:05:48.21 06/26/2024  127 KBytes SAVED ');
    assert.ok(p, 'parsed');
    assert.equal(p!.shot, 17);
    assert.equal(p!.stack, 1);
    assert.equal(p!.shotLoc, 0);
    assert.equal(p!.time, '11:05:48.21');
    assert.equal(p!.date, '06/26/2024');
    assert.equal(p!.kb, 127);
    assert.equal(p!.status, 'SAVED');
  });

  test('SCS log: an UNSAVED shot line parses (no kb/status — still a real trigger)', () => {
    const p = parseScsLogLine(' File      18 (Stack  2, Shot Loc: 0 Meters) 11:49:28.46 06/26/2024 ');
    assert.ok(p, 'parsed');
    assert.equal(p!.shot, 18);
    assert.equal(p!.stack, 2);
    assert.equal(p!.shotLoc, 0);
    assert.equal(p!.kb, undefined);
    assert.equal(p!.status, undefined);
  });

  test('SCS log: a READ line parses but is flagged status===READ (caller must skip)', () => {
    const p = parseScsLogLine(' File      17 (Stack  1, Shot Loc: 0 Meters) 11:05:48.21 06/26/2024  127 KBytes READ ');
    assert.ok(p, 'parsed');
    assert.equal(p!.status, 'READ'); // caller drops it — a re-read, NOT a new shot
  });

  test('SCS log: a REAL bare READ line (no KBytes) is still flagged status===READ', () => {
    // On real SCS 11.1.69 re-reads are logged WITHOUT the "<n> KBytes" size.
    const p = parseScsLogLine(' File      13 (Stack  1, Shot Loc: 0 Meters) 10:20:11.00 06/26/2024 READ');
    assert.ok(p, 'parsed');
    assert.equal(p!.kb, undefined);
    assert.equal(p!.status, 'READ'); // MUST skip — else every re-read becomes a phantom shot
  });

  test('SCS log: a SAVED line without KBytes still flags status===SAVED (still a shot)', () => {
    const p = parseScsLogLine(' File 18 (Stack 1, Shot Loc: 0 Meters) 12:00:00.00 07/05/2026 SAVED');
    assert.ok(p, 'parsed');
    assert.equal(p!.shot, 18);
    assert.equal(p!.status, 'SAVED');
  });

  test('SCS log: negative / fractional Shot Loc parses', () => {
    const p = parseScsLogLine(' File 3 (Stack 1, Shot Loc: -12.5 Meters) 09:00:00.00 06/26/2024');
    assert.ok(p, 'parsed');
    assert.equal(p!.shotLoc, -12.5);
  });

  test('SCS log: malformed / non-shot lines return null', () => {
    assert.equal(parseScsLogLine('Survey started 06/26/2024'), null);
    assert.equal(parseScsLogLine('File 17 opened'), null);
    assert.equal(parseScsLogLine('READ'), null);
    assert.equal(parseScsLogLine(''), null);
    assert.equal(parseScsLogLine(null), null);
    assert.equal(parseScsLogLine(42 as unknown as string), null);
  });

  test('SCS log: dedupe key — two stacks differ by time, an identical line collapses', () => {
    const a = parseScsLogLine(' File 18 (Stack 1, Shot Loc: 0 Meters) 11:49:28.46 06/26/2024');
    const b = parseScsLogLine(' File 18 (Stack 2, Shot Loc: 0 Meters) 11:49:30.11 06/26/2024');
    const a2 = parseScsLogLine(' File 18 (Stack 1, Shot Loc: 0 Meters) 11:49:28.46 06/26/2024');
    assert.ok(a && b && a2, 'all three parsed');
    assert.notEqual(scsLogKey(a!), scsLogKey(b!), 'stacked same-# lines → distinct keys (rising time)');
    assert.equal(scsLogKey(a!), scsLogKey(a2!), 'identical replayed line → same key (deduped)');
  });

  // ── SCS TempCom passive source (core/trigger/parse: isScsTrigTouch / scsTrigCollapse) ──
  test('TempCom: Tmp* touches count, STAT.* heartbeat + others are ignored', () => {
    assert.equal(isScsTrigTouch('TmpH0.00N'), true);
    assert.equal(isScsTrigTouch('TmpN0.00N'), true);
    assert.equal(isScsTrigTouch('tmpx'), true);                 // case-insensitive
    assert.equal(isScsTrigTouch('SC\\TempCom\\TmpH0.00N'), true); // sub-path → basename
    assert.equal(isScsTrigTouch('STAT.001'), false);           // periodic heartbeat
    assert.equal(isScsTrigTouch('stat.log'), false);
    assert.equal(isScsTrigTouch('Survey.dat'), false);
    assert.equal(isScsTrigTouch(''), false);
    assert.equal(isScsTrigTouch(null), false);
    assert.equal(isScsTrigTouch(42 as unknown as string), false);
    assert.equal(isScsTrigTouch('x'.repeat(300)), false);      // oversized
  });

  test('TempCom: one physical trigger (6-file burst) collapses to exactly ONE event', () => {
    // 6 Tmp* touches within ~300 ms — one shot.
    assert.equal(scsTrigCollapse([0, 40, 90, 150, 220, 300]), 1);
    // A second trigger well after the window → a second event (not merged).
    assert.equal(scsTrigCollapse([0, 40, 90, 300, 2000, 2050, 2200]), 2);
    // Three shots each a burst, spaced > window apart → exactly three.
    assert.equal(scsTrigCollapse([0, 100, 200, 1500, 1600, 3000, 3100]), 3);
    assert.equal(scsTrigCollapse([]), 0);
    // Non-finite entries are skipped, not counted.
    assert.equal(scsTrigCollapse([0, NaN as unknown as number, 100]), 1);
    assert.ok(SCS_TRIG_WINDOW_MS >= 1000, 'window comfortably covers a few-hundred-ms burst');
  });
}

console.log('\nobslog auto-numbering (Trigger Watch shot controller)');
{
  test('nextSP default advance is +1 (step 1, interval 1, dir +1)', () => {
    assert.equal(nextSP(1001, { step: 1, dir: 1, interval: 1 }), 1002);
    assert.equal(nextSP(1002, { step: 1, dir: 1, interval: 1 }), 1003);
  });

  test('nextSP honours a larger step', () => {
    assert.equal(nextSP(100, { step: 2, dir: 1, interval: 1 }), 102);
    assert.equal(nextSP(100, { step: 5, dir: 1, interval: 1 }), 105);
  });

  test('nextSP honours negative (down-line) direction', () => {
    assert.equal(nextSP(1001, { step: 1, dir: -1, interval: 1 }), 1000);
    assert.equal(nextSP(1001, { step: 2, dir: -1, interval: 1 }), 999);
  });

  test('nextSP multiplies step by interval (delta = dir × step × interval)', () => {
    assert.equal(nextSP(1000, { step: 1, dir: 1, interval: 2 }), 1002);
    assert.equal(nextSP(1000, { step: 2, dir: 1, interval: 3 }), 1006);
    assert.equal(nextSP(1000, { step: 1, dir: -1, interval: 4 }), 996);
  });

  test('nextSP keeps fractional SPs clean (no float drift)', () => {
    assert.equal(nextSP(101.5, { step: 1, dir: 1, interval: 0.1 }), 101.6);
    assert.equal(nextSP(100.2, { step: 1, dir: 1, interval: 0.1 }), 100.3);
  });

  test('nextSP on a blank / non-numeric previous SP returns null (caller seeds start)', () => {
    assert.equal(nextSP(null, { step: 1, dir: 1, interval: 1 }), null);
    assert.equal(nextSP(undefined, { step: 1, dir: 1, interval: 1 }), null);
    assert.equal(nextSP(NaN as unknown as number, { step: 1, dir: 1, interval: 1 }), null);
  });

  test('nextSP tolerates missing/garbled config fields (defaults step=1, interval=1, dir=+1)', () => {
    assert.equal(nextSP(10, {} as never), 11);
    assert.equal(nextSP(10, { step: NaN, dir: 1, interval: NaN } as never), 11);
  });

  test('nextFile advances +1 and seeds start when blank', () => {
    assert.equal(nextFile(18, 1), 19);
    assert.equal(nextFile(null, 18), 18);
    assert.equal(nextFile(undefined, 5), 5);
    assert.equal(nextFile(NaN as unknown as number, 42), 42);
  });

  test('renumberBelow recomputes SP for anchor + all rows below with a CHANGED interval', () => {
    const rows = [
      { sp: 1001, file: 18 }, // untouched (above anchor)
      { sp: 1002, file: 19 }, // anchor (index 1)
      { sp: 1003, file: 20 },
      { sp: 1004, file: 21 },
    ];
    // Observer edited the anchor to SP 1010 and now wants interval 2 downward.
    const out = renumberBelow(rows, 1, { startSP: 1010, interval: 2 });
    assert.deepEqual(out.map((r) => r.sp), [1001, 1010, 1012, 1014]);
    // Files untouched (no startFile given).
    assert.deepEqual(out.map((r) => r.file), [18, 19, 20, 21]);
    // Input array is NOT mutated (purity).
    assert.deepEqual(rows.map((r) => r.sp), [1001, 1002, 1003, 1004]);
  });

  test('renumberBelow advances File# from a start when provided', () => {
    const rows = [
      { sp: 1001, file: 18 },
      { sp: 1002, file: 99 },
      { sp: 1003, file: 99 },
      { sp: 1004, file: 99 },
    ];
    const out = renumberBelow(rows, 1, { startSP: 1002, interval: 1, startFile: 20 });
    assert.deepEqual(out.map((r) => r.sp), [1001, 1002, 1003, 1004]);
    assert.deepEqual(out.map((r) => r.file), [18, 20, 21, 22]);
  });

  test('renumberBelow supports a negative interval (down-line renumber)', () => {
    const rows = [{ sp: 500, file: 1 }, { sp: 400, file: 2 }, { sp: 300, file: 3 }];
    const out = renumberBelow(rows, 0, { startSP: 500, interval: -10 });
    assert.deepEqual(out.map((r) => r.sp), [500, 490, 480]);
  });

  test('renumberBelow with an out-of-range fromIndex returns an unchanged copy', () => {
    const rows = [{ sp: 1, file: 1 }, { sp: 2, file: 2 }];
    assert.deepEqual(renumberBelow(rows, 5, { startSP: 100, interval: 1 }).map((r) => r.sp), [1, 2]);
    assert.deepEqual(renumberBelow(rows, -1, { startSP: 100, interval: 1 }).map((r) => r.sp), [1, 2]);
    assert.deepEqual(renumberBelow([], 0, { startSP: 100, interval: 1 }), []);
  });
}

console.log('\nobslog trigger-system registry (Geode / generic)');
{
  test('TRIGGER_SYSTEMS registry exposes Geometrics Geode (SCS) as system #1', () => {
    const geode = TRIGGER_SYSTEMS.find((s) => s.id === 'geode');
    assert.ok(geode, 'geode system present');
    assert.equal(geode!.label, 'Geometrics Geode (SCS)');
    assert.ok(/Geode/.test(geode!.description) && /SCS/.test(geode!.description));
  });

  test('Geode defaults bundle the TempCom trigger + SC_Files reconcile + File# sync', () => {
    const geode = resolveTrigSystem('geode');
    assert.equal(geode.defaults.sources?.scstrig, true);   // TempCom trigger on
    assert.equal(geode.defaults.sources?.folder, false);   // generic sources off
    assert.equal(geode.defaults.sources?.udp, false);
    assert.equal(geode.defaults.sources?.serial, false);
    assert.equal(geode.defaults.sources?.scslog, false);
    assert.match(geode.defaults.scstrigDir ?? '', /TempCom$/);
    assert.match(geode.defaults.scFilesDir ?? '', /SC_Files$/);
    assert.equal(geode.defaults.autonum?.enabled, true);
    assert.equal(geode.defaults.autonum?.fileMode, 'reconcile'); // seed + auto-correct
  });

  test('generic system forces no sources (advanced / self-wired)', () => {
    const generic = resolveTrigSystem('generic');
    assert.equal(generic.label, 'Advanced / generic sources');
    assert.equal(generic.defaults.sources, undefined);
  });

  test('resolveTrigSystem falls back to the default entry for an unknown id', () => {
    assert.equal(resolveTrigSystem('nope').id, DEFAULT_TRIG_SYSTEM);
    assert.equal(resolveTrigSystem(undefined).id, DEFAULT_TRIG_SYSTEM);
    assert.equal(resolveTrigSystem(null).id, DEFAULT_TRIG_SYSTEM);
    assert.equal(DEFAULT_TRIG_SYSTEM, 'generic'); // preserves the historical folder-watch default
  });

  test('isTrigSystemId recognises only known ids', () => {
    assert.equal(isTrigSystemId('geode'), true);
    assert.equal(isTrigSystemId('generic'), true);
    assert.equal(isTrigSystemId('scs'), false);
    assert.equal(isTrigSystemId(42), false);
    assert.equal(isTrigSystemId(undefined), false);
  });

  test('migrateTrigSystemId: a pre-existing scstrig config becomes the Geode system', () => {
    // Old config predating the selector (no `system`) that had TempCom enabled.
    assert.equal(migrateTrigSystemId(undefined, true), 'geode');
    // Old config with no scstrig → keep the historical (folder-watch) default.
    assert.equal(migrateTrigSystemId(undefined, false), 'generic');
    // A valid stored id is kept verbatim regardless of scstrig.
    assert.equal(migrateTrigSystemId('generic', true), 'generic');
    assert.equal(migrateTrigSystemId('geode', false), 'geode');
    // Garbage id → fall back on the scstrig heuristic.
    assert.equal(migrateTrigSystemId('bogus', true), 'geode');
    assert.equal(migrateTrigSystemId(99, false), 'generic');
  });

  test('Geode File# mode selection maps to the underlying autonum File# mode', () => {
    assert.equal(geodeFileMode('seed'), 'reconcile');
    assert.equal(geodeFileMode('file'), 'real');
    assert.equal(geodeFileMode('anything-else'), 'reconcile'); // safe default
    assert.equal(geodeFileMode(undefined), 'reconcile');
    // Reverse mapping (autonum mode → Geode choice id).
    assert.equal(geodeFileSyncId('reconcile'), 'seed');
    assert.equal(geodeFileSyncId('real'), 'file');
    assert.equal(geodeFileSyncId('counter'), 'seed'); // non-real → seed
    assert.equal(geodeFileSyncId(null), 'seed');
  });

  test('GEODE_FILE_SYNC_MODES lists exactly seed(reconcile) + file(real)', () => {
    assert.equal(GEODE_FILE_SYNC_MODES.length, 2);
    const byId = Object.fromEntries(GEODE_FILE_SYNC_MODES.map((m) => [m.id, m.fileMode]));
    assert.equal(byId.seed, 'reconcile');
    assert.equal(byId.file, 'real');
    assert.equal(GEODE_FILE_SYNC_MODES[0].label, 'Seed + auto-correct');
    assert.equal(GEODE_FILE_SYNC_MODES[1].label, 'Read from file');
  });
}

// ── obslog Excel (.xlsx) export — package validity (task #205 regression) ──────
// Guards the Observer-Log XLSX export against the "opens empty" bug: buildXlsx
// must return non-empty bytes that re-open as a valid OOXML package whose
// workbook names an "Observer Log" sheet and whose worksheet carries our cells.
async function xlsxExportRegression(): Promise<void> {
  console.log('\nobslog Excel (.xlsx) export (task #205 regression)');

  const KNOWN_NOTE = 'FB-Shot-042';
  const tables: SheetTable[] = [
    { name: 'Project', header: ['Field', 'Value'], rows: [['Job', 'Demo Survey 2026']] },
    {
      name: 'Observer Log',
      header: ['SP', 'File', 'Time', 'Note'],
      rows: [
        [1001, 18, '08:14:03', KNOWN_NOTE],
        [1002, 19, '08:15:41', 'ok'],
      ],
    },
  ];

  await atest('buildXlsx returns non-empty bytes', async () => {
    const bytes = await buildXlsx(tables, new JSZip());
    assert.ok(bytes instanceof Uint8Array, 'bytes is a Uint8Array');
    assert.ok(bytes.length > 0, `expected non-empty bytes, got ${bytes.length}`);
  });

  await atest('xlsx re-opens as a valid package naming the Observer Log sheet', async () => {
    const bytes = await buildXlsx(tables, new JSZip());
    const zip = await JSZip.loadAsync(bytes);
    const wb = zip.file('xl/workbook.xml');
    assert.ok(wb, 'package contains xl/workbook.xml');
    const wbXml = await wb!.async('string');
    assert.ok(/name="Observer Log"/.test(wbXml), 'workbook names an "Observer Log" sheet');
    assert.ok(zip.file('[Content_Types].xml'), 'package contains [Content_Types].xml');
  });

  await atest('a worksheet carries a known cell value from the rows', async () => {
    const bytes = await buildXlsx(tables, new JSZip());
    const zip = await JSZip.loadAsync(bytes);
    const sheetNames = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    assert.ok(sheetNames.length >= 2, `expected >= 2 worksheet parts, got ${sheetNames.length}`);
    let found = false;
    for (const n of sheetNames) {
      const xml = await zip.file(n)!.async('string');
      if (xml.includes(KNOWN_NOTE)) found = true;
    }
    assert.ok(found, `a worksheet XML should contain the cell value "${KNOWN_NOTE}"`);
  });
}

// ── WiFiSync pure port (core/field) ─────────────────────────────────────────────
// Wire-protocol codecs, mtime diff (roles + deletion/tombstone rules), safeJoin
// rejections, and the token-bucket rate limiter — all framework-free.
function fieldTests(): void {
  console.log('\n[WiFiSync core/field]');

  const rec = (relPath: string, mtime: number, size = 0, deleted = false): FileRecord => ({ relPath, mtime, size, deleted });
  const man = (...records: FileRecord[]): Manifest => {
    const m: Manifest = new Map();
    for (const r of records) m.set(r.relPath, r);
    return m;
  };
  const sorted = (a: string[]): string[] => [...a].sort();

  // ── discovery beacon ──
  test('beacon encode→decode round-trips (26 bytes, role master)', () => {
    const id = new Uint8Array(16);
    for (let i = 0; i < 16; i++) id[i] = (i * 17 + 3) & 0xff;
    const pkt = encodeBeacon(TCP_FILE_PORT, id, 'master');
    assert.equal(pkt.length, 26);
    for (let i = 0; i < 7; i++) assert.equal(pkt[i], MAGIC[i], 'MAGIC prefix');
    const b = decodeBeacon(pkt);
    assert.ok(b, 'decoded');
    assert.equal(b!.tcpPort, TCP_FILE_PORT);
    assert.equal(b!.role, 'master');
    assert.ok(Buffer.from(id).equals(b!.instanceId), 'instanceId round-trips');
  });
  test('beacon: legacy 25-byte packet decodes as role "both"', () => {
    const id = Buffer.alloc(16, 7);
    const legacy = Buffer.concat([Buffer.from(MAGIC), Buffer.from([0xba, 0xc0]), id]); // 7+2+16 = 25
    const b = decodeBeacon(legacy);
    assert.ok(b);
    assert.equal(b!.role, 'both');
    assert.equal(b!.tcpPort, 0xbac0);
  });
  test('beacon: wrong magic / bad length → null', () => {
    const bad = Buffer.alloc(26, 0);
    assert.equal(decodeBeacon(bad), null, 'wrong magic');
    assert.equal(decodeBeacon(Buffer.alloc(10)), null, 'bad length');
  });
  test('role byte mapping both=0 master=1 slave=2', () => {
    assert.equal(roleToByte('both'), 0);
    assert.equal(roleToByte('master'), 1);
    assert.equal(roleToByte('slave'), 2);
    assert.equal(byteToRole(0), 'both');
    assert.equal(byteToRole(1), 'master');
    assert.equal(byteToRole(2), 'slave');
    assert.equal(byteToRole(99), 'both', 'unknown → both');
  });
  test('sameSubnet /24 compare (fail-open on parse error)', () => {
    assert.equal(sameSubnet('192.168.137.5', '192.168.137.200'), true);
    assert.equal(sameSubnet('192.168.137.5', '192.168.1.5'), false);
    assert.equal(sameSubnet('garbage', 'x'), true);
  });

  // ── transfer frames ──
  test('file-request frame round-trips (cmd 0x02 + u16be len)', () => {
    const f = encodeFileRequest('sub/dir/shot 42.segy');
    assert.equal(f[0], 0x02);
    assert.equal(f.readUInt16BE(1), Buffer.from('sub/dir/shot 42.segy', 'utf-8').length);
    assert.equal(decodeFileRequest(f).relPath, 'sub/dir/shot 42.segy');
  });
  test('file-response header: status→mtime(f64be)→size(u64be), big files', () => {
    const mtime = 1751000000.5;
    const size = 5_000_000_000; // > 2^32, exercises u64
    const h = encodeFileResponseHeader(mtime, size);
    assert.equal(h.length, 17);
    assert.equal(h[0], 0x00, 'status ok');
    assert.equal(h.readDoubleBE(1), mtime, 'mtime bytes big-endian f64');
    assert.equal(Number(h.readBigUInt64BE(9)), size, 'size bytes big-endian u64');
    const d = decodeFileResponseHeader(h);
    assert.deepEqual(d, { status: 0, mtime, size });
  });
  test('manifest frame: u32be length prefix + JSON round-trips', () => {
    const m = man(rec('a.txt', 100.25, 10), rec('b/c.dat', 200.5, 20, true));
    const frame = encodeManifestResponse(m);
    assert.equal(frame.readUInt32BE(0), frame.length - 4, 'length prefix');
    const back = decodeManifestResponse(frame);
    assert.equal(back.size, 2);
    assert.deepEqual(back.get('a.txt'), rec('a.txt', 100.25, 10));
    assert.deepEqual(back.get('b/c.dat'), rec('b/c.dat', 200.5, 20, true));
  });
  test('manifestToJson/fromJson round-trips (key becomes rel_path)', () => {
    const m = man(rec('x', 1.5, 3), rec('y', 2.5, 0, true));
    const back = manifestFromJson(manifestToJson(m));
    assert.deepEqual(back.get('x'), rec('x', 1.5, 3));
    assert.deepEqual(back.get('y')!.relPath, 'y');
    assert.equal(back.get('y')!.deleted, true);
  });

  // ── compute_diff: "both" (two-way) ──
  test('diff both: new remote file → pull', () => {
    const p = computeDiff(man(), man(rec('a', 100, 5)), 'both');
    assert.deepEqual(p.toPull, ['a']);
    assert.deepEqual(p.toDeleteLocally, []);
  });
  test('diff both: remote newer (> tol) → pull; within tol → nothing', () => {
    const local = man(rec('a', 100, 5));
    assert.deepEqual(computeDiff(local, man(rec('a', 100 + MTIME_TOLERANCE + 1, 6)), 'both').toPull, ['a']);
    assert.deepEqual(computeDiff(local, man(rec('a', 100 + 1, 6)), 'both').toPull, [], 'within tolerance');
    assert.deepEqual(computeDiff(local, man(rec('a', 50, 6)), 'both').toPull, [], 'remote older');
  });
  test('diff both: remote tombstone newer → delete locally', () => {
    const p = computeDiff(man(rec('a', 100, 5)), man(rec('a', 200, 0, true)), 'both');
    assert.deepEqual(p.toDeleteLocally, ['a']);
    assert.deepEqual(p.toPull, []);
  });
  test('diff both: local tombstone, remote live newer → resurrect (pull)', () => {
    const p = computeDiff(man(rec('a', 100, 0, true)), man(rec('a', 150, 5)), 'both');
    assert.deepEqual(p.toPull, ['a']);
  });
  test('diff both: local-only file → keep (no pull, no delete)', () => {
    const p = computeDiff(man(rec('a', 100, 5)), man(), 'both');
    assert.deepEqual(p.toPull, []);
    assert.deepEqual(p.toDeleteLocally, []);
  });

  // ── compute_diff: "slave" (mirror) ──
  test('diff slave: pull new/changed, delete local extras & tombstoned', () => {
    const local = man(rec('keep', 100, 5), rec('extra', 100, 5), rec('old', 100, 5));
    const remote = man(rec('keep', 100, 5), rec('new', 100, 5), rec('old', 100 + MTIME_TOLERANCE + 1, 6), rec('dead', 200, 0, true));
    const p = computeDiff(local, remote, 'slave');
    assert.deepEqual(sorted(p.toPull), ['new', 'old'], 'pull new + changed-beyond-tol');
    assert.deepEqual(sorted(p.toDeleteLocally), ['extra'], 'delete local extra (dead is remote-tombstoned, not local)');
  });

  // ── empty-manifest anti-wipe guard ──
  test('guard: all-deleted remote clears local deletions; live remote keeps them', () => {
    const plan = { toPull: ['x'], toDeleteLocally: ['a', 'b'] };
    const deadRemote = man(rec('a', 200, 0, true), rec('b', 200, 0, true));
    assert.deepEqual(applyEmptyManifestGuard(plan, deadRemote).toDeleteLocally, [], 'no live → cleared');
    const liveRemote = man(rec('a', 200, 0, true), rec('c', 100, 5));
    assert.deepEqual(applyEmptyManifestGuard(plan, liveRemote).toDeleteLocally, ['a', 'b'], 'has live → kept');
    assert.equal(hasLiveRecord(deadRemote), false);
    assert.equal(hasLiveRecord(liveRemote), true);
  });

  // ── safeJoin containment ──
  test('safeJoin: normal nested path stays under root', () => {
    const root = process.platform === 'win32' ? 'C:\\sync\\root' : '/sync/root';
    const p = safeJoin(root, 'sub/dir/file.txt');
    assert.ok(p.endsWith('file.txt'));
    assert.ok(validateRelPath(root, 'sub/dir/file.txt'));
  });
  test('safeJoin: rejects .. escape, absolute, and drive/UNC', () => {
    const root = process.platform === 'win32' ? 'C:\\sync\\root' : '/sync/root';
    assert.throws(() => safeJoin(root, '../../etc/passwd'), PathEscapeError);
    assert.throws(() => safeJoin(root, 'a/../../../b'), PathEscapeError);
    const abs = process.platform === 'win32' ? 'C:\\Windows\\system32' : '/etc/passwd';
    assert.throws(() => safeJoin(root, abs), PathEscapeError);
    assert.equal(validateRelPath(root, '../escape'), false);
  });

  // ── build manifest (pure) + merge ──
  test('buildManifestFromEntries: stability skip + .wfsync_tmp skip', () => {
    const now = 1000;
    const m = buildManifestFromEntries(
      [
        { relPath: 'kept', mtime: 990, size: 5 }, // 10 s old → kept
        { relPath: 'growing', mtime: 999, size: 5 }, // 1 s old (< 2 s) → skipped
        { relPath: 'x.wfsync_tmp', mtime: 900, size: 5 }, // temp → skipped
      ],
      now,
    );
    assert.deepEqual([...m.keys()], ['kept']);
    assert.equal(m.get('kept')!.deleted, false);
  });
  test('mergeManifest overlays tombstones over live records', () => {
    const merged = mergeManifest(man(rec('a', 100, 5), rec('b', 100, 5)), man(rec('a', 200, 0, true)));
    assert.equal(merged.get('a')!.deleted, true, 'tombstone wins');
    assert.equal(merged.get('b')!.deleted, false);
    assert.equal(hasLiveRecord(merged), true, 'b still live');
  });

  // ── tombstone transforms ──
  test('addTombstoneEntry: inserts + prunes entries older than 30 days', () => {
    const now = 1000;
    const cutoffOld = now - 2_592_000 - 10; // older than 30 days
    const out = addTombstoneEntry({ old: { mtime: cutoffOld } }, 'x', 500, now);
    assert.equal(out.x.mtime, 500, 'new entry added');
    assert.equal(out.old, undefined, 'stale entry pruned');
  });
  test('removeTombstoneEntry: drops key; no-op when absent', () => {
    const r1 = removeTombstoneEntry({ a: { mtime: 1 }, b: { mtime: 2 } }, 'a');
    assert.equal(r1.changed, true);
    assert.equal(r1.data.a, undefined);
    assert.equal(r1.data.b.mtime, 2);
    const r2 = removeTombstoneEntry({ b: { mtime: 2 } }, 'zzz');
    assert.equal(r2.changed, false);
  });
  test('tombstonesToRecords → deleted records with size 0', () => {
    const m = tombstonesToRecords({ x: { mtime: 5 } });
    assert.deepEqual(m.get('x'), rec('x', 5, 0, true));
  });

  // ── roles negotiation ──
  test('complementRole: master↔slave, both→null', () => {
    assert.equal(complementRole('master'), 'slave');
    assert.equal(complementRole('slave'), 'master');
    assert.equal(complementRole('both'), null);
  });

  // ── rate limiter (token bucket) with injected clock ──
  test('RateLimiter unlimited (maxKbps<=0) is a no-op', () => {
    const rl = new RateLimiter(0);
    assert.equal(rl.enabled, false);
    assert.equal(rl.consume(999999), 0);
  });
  test('RateLimiter: repays debt exactly, credits only after the slept window', () => {
    let t = 0;
    const clock = (): number => t;
    const rl = new RateLimiter(1, clock); // 1 KB/s = 1024 B/s
    assert.equal(rl.consume(1024), 0, 'first 1 KB fits the initial allowance');
    assert.equal(rl.consume(1024), 1.0, 'next 1 KB with no elapsed time → sleep 1.0 s');
    t = 2.0; // 1 s past the pre-advanced clock (last was set to 1.0)
    assert.equal(rl.consume(0), 0, 'after the slept second, ~1 KB credited (capped), no further sleep');
    assert.equal(rl.consume(512), 0, '512 B fits the credited allowance');
  });
}
fieldTests();

// ── Summary ───────────────────────────────────────────────────────────────────
// The xlsx regression is async, so print the tally only once it has resolved.
xlsxExportRegression().then(() => {
  console.log('\n----------------------');
  console.log(`passed: ${passed}   failed: ${failed}   skipped: ${skipped}\n`);
  process.exitCode = failed > 0 ? 1 : 0;
});
