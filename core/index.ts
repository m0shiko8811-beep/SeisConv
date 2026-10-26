// seisconv-core - public API barrel
//
// Pure, framework-free seismic conversion + processing library. Safe to import
// from Electron (Node main/worker), a browser, or plain Node. No DOM / Electron /
// React dependencies.

import type { Bytes, ParsedFile } from './types';
import { MAX_SAMPLE_TRACES, MAX_TRACES } from './types';
import { parseWithRegistry } from './formats/registry';
import { detect, isIX1SegdTape } from './detect';
import { parseTpimage } from './formats/tapeimage';
import { parseSEGY, parseSegyMeta } from './formats/segy';

export * from './types';
export * from './binary';
export * from './base64';
export { detect, detectEx, isIX1SegdTape, type DetectResult } from './detect';
export { parseSEGY, writeSEGY, WRITER_TAG, parseSegyMeta, decodeSegyTrace } from './formats/segy';
export type { SegyMeta } from './formats/segy';
export { parseSEGD, writeSEGD } from './formats/segd';
export { parseSEG2, writeSEG2 } from './formats/seg2';
export { parseSU, writeSU } from './formats/su';
export * from './formats/ascii';
export * from './coords';
export * from './formats/registry';
export * from './formats/tapeimage';
export * from './dsp/interpolate';
export * from './dsp/neargather';
export * from './dsp/agc';
export * from './dsp/fft';
export * from './dsp/correlate';
export * from './dsp/hilbert';
export * from './dsp/sweepgen';
export * from './dsp/robuststats';
export * from './dsp/firstbreak';
export * from './dsp/fbassist';
export * from './dsp/tracehealth';
export * from './dsp/semblance';
export * from './dsp/avgspectrum';
export * from './dsp/spectrogram';
export * from './dsp/fk';
export * from './version';
export * from './render/colormaps';
export * from './render/model';
export * from './sps/parse';
export * from './sps/geomcheck';
export * from './sps/geomload';
export * from './sps/spsdelta';
export * from './sps/bingrid';
export * from './sps/formats';
export * from './sps/qc';
export * from './sps/plancheck';
export * from './sps/reproject';
export * from './sps/write';
export * from './sps/renumber';
export * from './sps/create';
export * from './gis/shapefile';
export * from './gis/wkt';
export * from './gis/spsshape';
export * from './gis/geotiff';
export * from './gis/rasterize';
export * from './gis/spsraster';
export * from './export/xlsx';
export * from './export/ods';
export * from './trigger/parse';
export * from './obslog/autonum';
export * from './obslog/trigsystems';
export * from './field';

/**
 * Detect and parse any supported seismic file. Dispatches through the format
 * registry, so supported formats grow by registering a module (see
 * `formats/registry.ts`) - no change here.
 */
// Defensive cap on the total traces surfaced from an in-memory tape image with many
// embedded records (a combined tape can hold dozens of shots). In-memory tapes are
// already bounded by the worker's STREAM_THRESHOLD; this is belt-and-suspenders.
const MAX_TPIMAGE_TRACES = 4_000_000;

// `sampleTraceCap` bounds how many traces (per embedded record, for a tape image)
// decode their samples; absent, every parser keeps its MAX_SAMPLE_TRACES default.
export function parseAny(b: Bytes, name?: string, sampleTraceCap?: number): ParsedFile {
  // iX1 "Stand Alone Mode" SEG-D tape: honest FAST fail. Its 128-byte ASCII
  // volume header is not ANSI/VOL1 block framing, so walking it as a tape used
  // to extract GB-scale garbage "SEG-Y" blocks (~44 s + GBs of RAM) before
  // surfacing a misleading SEG-Y error. Reading its SEG-D records needs a
  // streamed record walk (deferred - see plan item 1.6 stretch).
  if (isIX1SegdTape(b)) {
    return {
      format: 'TPIMAGE', revision: 0, bh: {}, traces: [], traceCount: 0,
      errors: ['iX1 "Stand Alone Mode" SEG-D tape image (SD volume header) - not yet supported; open the per-shot .segd files instead.'],
    };
  }
  if (detect(b, name) === 'TPIMAGE') {
    const extracted = parseTpimage(b);
    if (!extracted.length) {
      return { format: 'TPIMAGE', revision: 0, bh: {}, traces: [], traceCount: 0, errors: ['No seismic files found in tape image'] };
    }
    const first = parseAny(extracted[0].bytes, extracted[0].name, sampleTraceCap);
    if (extracted.length === 1) return { ...first, format: 'TPIMAGE→' + first.format };
    // Multi-record tape: concatenate EVERY embedded record's traces into one file so
    // the viewer/converter sees the whole tape, not just its first record - matching
    // the streamed large-tape path (which indexes every record) and what a user
    // expects after combining a folder into one tape. The binary header / sample
    // interval comes from the first record (per-trace nSamples is carried per trace).
    const traces = [...first.traces];
    const errors = [...(first.errors ?? [])];
    let truncated = false;
    for (let i = 1; i < extracted.length && !truncated; i++) {
      const pf = parseAny(extracted[i].bytes, extracted[i].name, sampleTraceCap);
      if (pf.errors?.length) errors.push(...pf.errors);
      for (const t of pf.traces) {
        if (traces.length >= MAX_TPIMAGE_TRACES) { truncated = true; break; }
        traces.push(t);
      }
    }
    if (truncated) errors.push(`Tape image truncated at ${MAX_TPIMAGE_TRACES} traces (${extracted.length} records).`);
    return { ...first, format: 'TPIMAGE→' + first.format, traces, traceCount: traces.length, errors };
  }
  return parseWithRegistry(b, name, sampleTraceCap);
}

/** Total decoded-sample budget for a file parsed WHOLE in memory (the worker's
 *  open / convert / combine / extract paths). The parsers cap SAMPLE decoding at
 *  MAX_SAMPLE_TRACES (2000) to bound arbitrary files, but a file on the in-memory
 *  path is already size-bounded, so every trace gets its samples (else the viewer
 *  renders blank past trace 2000 and a convert writes those traces as zeros). The
 *  budget still bounds the rare case of a few very long traces. ~1.6 GB of Float32. */
export const IN_MEMORY_SAMPLE_BUDGET = 400_000_000;

/** Sample-trace cap for a file whose longest trace holds `perTrace` samples:
 *  the budget spread over the traces, never below MAX_SAMPLE_TRACES and never
 *  above MAX_TRACES. */
function inMemoryCap(perTrace: number, budget: number): number {
  const per = Math.max(1, Number.isFinite(perTrace) ? perTrace : 1);
  return Math.max(MAX_SAMPLE_TRACES, Math.min(MAX_TRACES, Math.floor(budget / per)));
}

/**
 * Parse a file that has been read WHOLE into memory, decoding EVERY trace's samples
 * within IN_MEMORY_SAMPLE_BUDGET. A SEG-Y sizes its cap from the binary header
 * before the one parse. The other containers (SEG-D / SEG-2 / SU / tape image) have
 * no cheap header-only reader, so they parse once with the default cap and, only
 * when that left traces sample-less, parse again with the cap sized from the
 * longest trace the first walk found. A file under 2000 traces is parsed once,
 * exactly as before. `budget` is a parameter only so tests can exercise the cap.
 */
export function parseInMemory(bytes: Bytes, name?: string, budget: number = IN_MEMORY_SAMPLE_BUDGET): ParsedFile {
  if (detect(bytes, name) === 'SEG-Y') return parseSEGY(bytes, inMemoryCap(parseSegyMeta(bytes).defaultNs || 1, budget));
  const pf = parseAny(bytes, name);
  if (!countSamplelessTraces(pf)) return pf;
  let perTrace = 1;
  for (const t of pf.traces) if (t.nSamples > perTrace) perTrace = t.nSamples;
  const cap = inMemoryCap(perTrace, budget);
  return cap > MAX_SAMPLE_TRACES ? parseAny(bytes, name, cap) : pf;
}

/** How many traces declare samples (nSamples > 0) but carry none in memory. A
 *  writer emits zeros for such a trace, so a converter must refuse to write when
 *  this is non-zero rather than save a file that silently lost data. */
export function countSamplelessTraces(pf: ParsedFile): number {
  let n = 0;
  for (const t of pf.traces) if (!t.samples && t.nSamples > 0) n++;
  return n;
}
