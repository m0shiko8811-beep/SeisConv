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
  /** SEG-Y impulse signal polarity (binary-header bytes 3257-3258, uint16):
   *  1 = pressure increase / upward geophone case movement gives a NEGATIVE
   *  number on trace, 2 = the same gives a POSITIVE number, 0 = unknown
   *  (unset). SEG-Y rev1 sec 3.4 / rev2.1 sec 5.2 Binary File Header table. */
  impulsePolarity?: number;
  /** SEG-Y vibratory polarity code (binary-header bytes 3259-3260, uint16):
   *  1-8 = seismic signal lag vs pilot signal in 45-degree wedges, 0 = unknown
   *  (unset or out of range). SEG-Y rev1 sec 3.4 / rev2.1 sec 5.2. */
  vibratoryPolarity?: number;
  [key: string]: number | undefined;
}

/**
 * One SEG-D channel-set descriptor, decoded from the 32-byte (rev ≤ 2) or
 * 96-byte (rev 3) descriptor block that follows the general headers. The trace
 * walk needs `ns` / `siUs` / `chanCount` to size and count the trace records;
 * the whole set is retained on {@link ParsedFile} because a general header only
 * reports the TOTALS, so per-set geometry (which sets are seismic, which are
 * aux, how many channels each holds) is unrecoverable from `gh1` alone.
 */
export interface SegdChanSet {
  scanType: number;
  csNum: number;
  /** The channel type code EXACTLY as the file's own revision defines it, which
   *  is not the same field in both: rev <= 2 stores a NIBBLE (seismic = 1) and
   *  rev 3 a whole BYTE (seismic = 0x10). Use {@link segdChanTypeIsSeismic} to
   *  test it rather than comparing to a literal, and see the two citations at the
   *  channel-set descriptor reader in core/formats/segd.ts. Other codes are
   *  aux/time-break/etc - all are stored on disk. */
  chanType: number;
  chanCount: number;
  /** 32-byte trace-header extensions per trace in this set. */
  theCount: number;
  /** Samples per trace derived from the descriptor (fallback when THE1 absent). */
  ns: number;
  /** Sampling interval in microseconds: carried per set by rev 3, inherited from
   *  the general header's base scan interval by rev ≤ 2. */
  siUs: number;
}

/** Is this channel set the SEISMIC one, given the revision the file declares?
 *
 *  The code for "Seis" moved with the field's width: rev <= 2 packs the channel
 *  type into the high nibble of channel-set-descriptor byte 11 and spells seismic
 *  as nibble 1, while rev 3 widened it to the whole of byte 4 and spells seismic
 *  as 0x10 (SEG-D Rev 2.1, 8.5 Channel Set Descriptor, byte 11 row, printed page
 *  43; SEG-D Rev 3.0, 8.16 Channel Set Descriptor, byte 4 row, printed page 111).
 *  Comparing a stored code against a bare 1 therefore answers the question for
 *  one revision and silently mis-answers it for the other, so every caller - the
 *  parser choosing which set supplies the sample interval, and the two UI tables
 *  that name a set - goes through this one predicate. Lives here, beside the type
 *  it interprets, because core/ and renderer/ both need it. */
export function segdChanTypeIsSeismic(chanType: number, revMajor: number): boolean {
  return chanType === (revMajor >= 3 ? 0x10 : 1);
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
  /** SEG-D channel-set descriptors in file order, one entry per set; its length
   *  is the count `gh1.numChanSets` reports. Present only for SEG-D read by the
   *  spec decoder: the frozen legacy decoder skips the descriptor blocks by size
   *  without decoding them, so it has none to report. */
  chanSets?: SegdChanSet[];
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
