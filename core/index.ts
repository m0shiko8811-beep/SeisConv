// seisconv-core - public API barrel
//
// Pure, framework-free seismic conversion + processing library. Safe to import
// from Electron (Node main/worker), a browser, or plain Node. No DOM / Electron /
// React dependencies.

import type { Bytes, ParsedFile } from './types';
import { parseWithRegistry } from './formats/registry';
import { detect, isIX1SegdTape } from './detect';
import { parseTpimage } from './formats/tapeimage';

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
export * from './render/colormaps';
export * from './render/model';
export * from './sps/parse';
export * from './sps/geomcheck';
export * from './sps/geomload';
export * from './sps/spsdelta';
export * from './sps/bingrid';
export * from './sps/formats';
export * from './sps/qc';
export * from './sps/reproject';
export * from './sps/write';
export * from './sps/renumber';
export * from './sps/create';
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

export function parseAny(b: Bytes, name?: string): ParsedFile {
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
    const first = parseAny(extracted[0].bytes, extracted[0].name);
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
      const pf = parseAny(extracted[i].bytes, extracted[i].name);
      if (pf.errors?.length) errors.push(...pf.errors);
      for (const t of pf.traces) {
        if (traces.length >= MAX_TPIMAGE_TRACES) { truncated = true; break; }
        traces.push(t);
      }
    }
    if (truncated) errors.push(`Tape image truncated at ${MAX_TPIMAGE_TRACES} traces (${extracted.length} records).`);
    return { ...first, format: 'TPIMAGE→' + first.format, traces, traceCount: traces.length, errors };
  }
  return parseWithRegistry(b, name);
}
