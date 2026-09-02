// seisconv-core - shared types
//
// Pure, framework-free type definitions for the seismic formats. No React, no
// DOM, no Expo - this module must stay runnable in plain Node so it can be unit
// tested and reused unchanged on native + web.
//
// Ported from the SeisConv reference (seisconv_v5.11_22.html). Field names and
// semantics are kept identical to the reference parsers so behaviour matches.

/** Raw bytes of a seismic file (or any binary blob). */
export type Bytes = Uint8Array;

/** Detected container format. 'UNKNOWN' = the blob matched no known signature
 *  (surfaced as a clean "unsupported file" error rather than mis-parsed). */
export type SeismicFormat = 'SEG-Y' | 'SEG-D' | 'SEG-2' | 'SU' | 'TPIMAGE' | 'UNKNOWN';

/**
 * Per-trace header. SEG-Y / SU headers are all numeric; SEG-2 free-form headers
 * are string key/value pairs (with a few normalised numeric keys). So the value
 * type is a union and consumers narrow as needed.
 */
export type TraceHeader = Record<string, number | string>;

/** A single seismic trace. `samples` is null when the trace is past the
 * in-memory preview cap (large files keep headers but drop sample arrays). */
export interface Trace {
  hdr: TraceHeader;
  samples: Float32Array | null;
  nSamples: number;
  /** Numeric data-format code as understood by the originating parser. */
  dataFmt?: number;
}

/**
 * Binary/file header summary. `sampleInt` is always in microseconds (µs) to
 * match SEG-Y convention, regardless of source format.
 */
export interface BinaryHeader {
  sampleInt?: number;
  samplesTrace?: number;
  dataFmt?: number;
  revision?: number;
  numTraces?: number;
  /** SEG-Y trace-sorting code (binary-header bytes 3229-3230, signed int16):
   *  1 = as recorded, 2 = CDP ensemble, 4 = horizontally/CMP stacked, 5 = common
   *  source, 8 = CMP, 9 = common conversion point, 0/absent = unknown. Used by the
   *  geometry-integrity check to recognise post-stack data (source/receiver
   *  geometry collapsed to CDP midpoints) instead of false-flagging it. */
  traceSorting?: number;
  [key: string]: number | undefined;
}

/** Result of parsing any supported seismic file. */
export interface ParsedFile {
  format: string;
  revision: number;
  textHeader?: string;
  bh: BinaryHeader;
  traces: Trace[];
  traceCount: number;
  errors: string[];
  /** SEG-D general header 1 fields (only present for SEG-D). */
  gh1?: Record<string, number>;
  /** SEG-2 file descriptor block fields (only present for SEG-2). */
  fileHeader?: Record<string, number>;
}

/** Maximum number of traces whose sample arrays are kept in memory during a
 * parse. Headers are still read for every trace; this only caps sample decode
 * for very large files (mirrors the reference behaviour). */
export const MAX_SAMPLE_TRACES = 2000;

/** Hard ceiling on trace count to avoid runaway loops on malformed input. */
export const MAX_TRACES = 500000;

/**
 * Hard ceiling on the per-trace sample count a parser will honour from an
 * attacker-controllable header field, BEFORE it is also bounded by the bytes
 * actually present on disk. Caps a single trace's Float32Array at ~4 MB so a
 * crafted header (huge declared nSamples, tiny data block) cannot drive a
 * multi-gigabyte allocation and OOM-crash the parse worker. Parsers must ALSO
 * clamp to the real on-disk byte budget - this constant is the upper guard, not
 * the only guard. Shared by segy.ts / seg2.ts / segd.ts so the limit lives in
 * one place. */
export const MAX_SAMPLES_PER_TRACE = 1000000;
