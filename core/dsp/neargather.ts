// Near-trace (common-offset) gather across RECORDS.
//
// Every other viewer in the app shows ONE record, so shot-to-shot behaviour - a
// source slowly degrading down the line, a coupling problem that worsens - is
// invisible. This module takes ONE chosen channel out of each shot record and
// assembles those traces side by side into a single panel, which is the field
// instrument's own "Gather Window" (Geometrics Geode/StrataVisor manual 1.2.1.7):
// a near-trace gather "can rival a brute stack in quality and is a useful tool
// for monitoring data quality during the survey".
//
// Pure TypeScript: no DOM, no Electron, no fs. The caller (the worker) parses the
// files and hands the records in; this module only selects + assembles, so the
// selection and alignment rules are unit-testable without any file on disk.

import { resampleLinear } from './interpolate';
import { normFactorPercentile } from '../render/model';

/** One trace as this module needs it: a header bag plus (maybe) its samples. */
export interface GatherTrace {
  hdr?: Record<string, number | string> | null;
  samples?: Float32Array | null;
  nSamples?: number;
}

/** One shot record. `error` marks a record the caller could not parse at all;
 *  it is reported as skipped rather than thrown away silently. */
export interface GatherRecord {
  name: string;
  /** Sample interval in MICROSECONDS. <= 0 means unknown, and the record is skipped. */
  sampleInt: number;
  /** Field File ID when the format carries one; used only for labelling. */
  ffid?: number | null;
  traces?: GatherTrace[];
  error?: string;
}

/** How the one trace per record is chosen. `index` is the escape hatch (plain
 *  array position); it is NEVER used as a silent fallback for the other two. */
export type GatherSelector =
  | { mode: 'channel'; channel: number }
  /** Nearest by SIGNED offset, so a split spread's -300 m is not matched by +300 m. */
  | { mode: 'offset'; offset: number }
  | { mode: 'index'; index: number };

/** Why a record contributed no column. Surfaced per record so the UI can tell the
 *  user WHICH records are missing and why, instead of showing a shorter panel. */
export type GatherSkipReason =
  | 'parseError'
  | 'noTraces'
  | 'noSampleInt'
  | 'noChannelHeader'
  | 'channelNotFound'
  | 'noOffsetHeader'
  | 'noSamples'
  /** Never parsed at all: the record sat beyond the record cap. */
  | 'beyondCap';

/** Per-record report. One entry per record the caller offered, in input order. */
export interface GatherRecordInfo {
  name: string;
  ffid: number | null;
  /** Column position in `data`, or -1 when the record contributed nothing. */
  column: number;
  /** Array index of the trace taken from this record, or -1. */
  traceIndex: number;
  /** The channel-number header value actually used, or null when absent. */
  channel: number | null;
  /** The offset header value actually used, or null when absent. */
  offset: number | null;
  /** This record's own sample interval (µs), 0 when unknown. */
  sampleInt: number;
  nSamples: number;
  /** True when this record's sample interval differed from the reference and the
   *  trace was resampled ONTO the reference time grid (aligned by time, not by
   *  sample number). */
  resampled: boolean;
  /** More than one trace carried the requested channel number (e.g. a SEG-D
   *  auxiliary channel set repeating numbers). The FIRST match was used. */
  ambiguous: boolean;
  ok: boolean;
  reason?: GatherSkipReason;
  detail?: string;
}

export interface NearGatherResult {
  /** Number of columns actually assembled (= records that contributed). */
  numTraces: number;
  /** Samples per column; every column is padded to this length. */
  colLen: number;
  /** Global 95th-percentile amplitude across the gather (>0). */
  norm: number;
  /** Per-column 95th percentile; 0 for a dead column (never divide by it). */
  norms: Float32Array;
  /** Reference sample interval (µs) - the time grid every column sits on. */
  sampleInt: number;
  /** Row-major numTraces x colLen matrix; row c = column c's samples. */
  data: Float32Array;
  /** One entry per OFFERED record, in input order (including skipped ones). */
  records: GatherRecordInfo[];
  /** True when the caller offered more records than the cap allowed. */
  truncated: boolean;
  /** How many records were dropped by the cap. */
  droppedByCap: number;
  /** True when at least one contributing record had a different sample interval
   *  from the reference. Those columns were resampled onto the reference grid,
   *  but the UI must SAY SO: a mixed-interval gather is a survey problem. */
  mixedSampleInt: boolean;
  /** Distinct sample intervals (µs) seen among contributing records, sorted. */
  sampleInts: number[];
  /** Human-readable skips, one line per record that contributed nothing. */
  skipped: string[];
}

export interface NearGatherOptions {
  /** Hard cap on records gathered. Default MAX_GATHER_RECORDS. */
  maxRecords?: number;
  /** Hard cap on samples per column (columns longer than this are decimated in
   *  a time-preserving way, exactly like the section view). Default MAX_GATHER_SAMPLES. */
  maxSamples?: number;
  /** Optional per-trace transform (the worker uses it for AGC). Kept as a hook so
   *  this module stays free of gain policy. */
  transform?: (samples: Float32Array, sampleIntUs: number) => Float32Array;
}

/** Record cap. A folder can hold thousands of shot files; 1000 columns is already
 *  wider than any screen, and each is read + parsed, so this bounds the wall time
 *  as much as the memory. */
export const MAX_GATHER_RECORDS = 1000;
/** Per-column sample cap. 1000 x 4000 floats = 16 MB, the worst case this can
 *  allocate, which is the real memory bound (the request never allocates from a
 *  count the file supplies). */
export const MAX_GATHER_SAMPLES = 4000;

/** Trace-header keys that carry a CHANNEL NUMBER, best first.
 *  trcField: SEG-Y/SU bytes 13-16 (trace number within the field record) and the
 *  key SEG-D's demux walk sets; trcNum: SEG-D tape traces; channelNum: SEG-2. */
const CHANNEL_KEYS = ['trcField', 'trcNum', 'channelNum', 'traceNum'] as const;
/** Source-receiver distance. SEG-Y/SU only; SEG-D and SEG-2 have no such field. */
const OFFSET_KEYS = ['offset'] as const;

function numFromHdr(hdr: Record<string, number | string> | null | undefined, keys: readonly string[]): number | null {
  if (!hdr) return null;
  for (const k of keys) {
    // Reject inherited/prototype keys: hdr is built from file bytes.
    if (!Object.prototype.hasOwnProperty.call(hdr, k)) continue;
    const raw = hdr[k];
    const v = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/** The channel number a trace declares, or null when no key is present. */
export function traceChannelNumber(tr: GatherTrace | null | undefined): number | null {
  return numFromHdr(tr?.hdr, CHANNEL_KEYS);
}

/** The source-receiver offset a trace declares, or null when no key is present. */
export function traceOffset(tr: GatherTrace | null | undefined): number | null {
  return numFromHdr(tr?.hdr, OFFSET_KEYS);
}

export interface TracePick {
  traceIndex: number;
  channel: number | null;
  offset: number | null;
  ambiguous: boolean;
}

/**
 * Pick ONE trace out of a record. Returns the pick, or a skip reason.
 *
 * A header that is present but ZERO on EVERY trace counts as ABSENT, not as a
 * value: an unpopulated SEG-Y header block is zero-filled, and matching "channel
 * 0" or "offset nearest to 0" there would return trace 1 of every record while
 * pretending it was a real channel match - exactly the misleading answer this
 * feature must not give.
 */
export function selectTrace(rec: GatherRecord, sel: GatherSelector): TracePick | GatherSkipReason {
  const traces = rec.traces;
  if (!traces || traces.length === 0) return 'noTraces';

  if (sel.mode === 'index') {
    const i = Math.max(0, Math.min(traces.length - 1, Math.trunc(sel.index)));
    return { traceIndex: i, channel: traceChannelNumber(traces[i]), offset: traceOffset(traces[i]), ambiguous: false };
  }

  if (sel.mode === 'channel') {
    let anyKey = false;
    let anyNonZero = false;
    let first = -1;
    let hits = 0;
    const want = Math.trunc(sel.channel);
    for (let i = 0; i < traces.length; i++) {
      const ch = traceChannelNumber(traces[i]);
      if (ch === null) continue;
      anyKey = true;
      if (ch !== 0) anyNonZero = true;
      if (ch === want) { hits++; if (first < 0) first = i; }
    }
    if (!anyKey || !anyNonZero) return 'noChannelHeader';
    if (first < 0) return 'channelNotFound';
    return { traceIndex: first, channel: want, offset: traceOffset(traces[first]), ambiguous: hits > 1 };
  }

  // Nearest by SIGNED offset: on a split spread -300 m and +300 m are different
  // physical channels, so |offset| matching would pick the wrong side.
  let anyKey = false;
  let anyNonZero = false;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < traces.length; i++) {
    const off = traceOffset(traces[i]);
    if (off === null) continue;
    anyKey = true;
    if (off !== 0) anyNonZero = true;
    const d = Math.abs(off - sel.offset);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (!anyKey || !anyNonZero || best < 0) return 'noOffsetHeader';
  return { traceIndex: best, channel: traceChannelNumber(traces[best]), offset: traceOffset(traces[best]), ambiguous: false };
}

/** One-line English for a skip, so the UI can list what is missing verbatim. */
export function skipText(name: string, reason: GatherSkipReason, detail?: string): string {
  const why =
    reason === 'parseError' ? `could not be parsed${detail ? ': ' + detail : ''}`
      : reason === 'noTraces' ? 'has no traces'
        : reason === 'beyondCap' ? 'was not read (beyond the record cap)'
      : reason === 'noSampleInt' ? 'has no usable sample interval'
          : reason === 'noChannelHeader' ? 'carries no channel-number header (all zero or absent)'
            : reason === 'channelNotFound' ? 'does not contain the requested channel'
              : reason === 'noOffsetHeader' ? 'carries no offset header (all zero or absent)'
                : 'has no samples on the selected trace';
  return `${name} ${why}`;
}

/**
 * Assemble the gather.
 *
 * Alignment is BY TIME, not by sample number: the reference grid is the FIRST
 * contributing record's sample interval, and any record recorded at a different
 * interval is resampled onto that grid (and flagged). Aligning by sample index
 * instead was a real defect in this app, so it is not repeated here.
 *
 * Never throws on bad input: a record that cannot contribute becomes a skip entry.
 */
export function assembleNearGather(
  records: readonly GatherRecord[],
  sel: GatherSelector,
  opts: NearGatherOptions = {},
): NearGatherResult {
  const maxRecords = Math.max(1, Math.min(MAX_GATHER_RECORDS, Math.trunc(opts.maxRecords ?? MAX_GATHER_RECORDS) || MAX_GATHER_RECORDS));
  const maxSamples = Math.max(1, Math.min(MAX_GATHER_SAMPLES, Math.trunc(opts.maxSamples ?? MAX_GATHER_SAMPLES) || MAX_GATHER_SAMPLES));
  const offered = records.length;
  const used = Math.min(offered, maxRecords);

  const infos: GatherRecordInfo[] = [];
  const skipped: string[] = [];
  const columns: Float32Array[] = [];
  const colNorms: number[] = [];
  const siSet = new Set<number>();
  let refSi = 0;
  let mixed = false;

  const fail = (rec: GatherRecord, reason: GatherSkipReason, detail?: string): void => {
    infos.push({
      name: rec.name, ffid: rec.ffid ?? null, column: -1, traceIndex: -1, channel: null, offset: null,
      sampleInt: rec.sampleInt > 0 ? rec.sampleInt : 0, nSamples: 0, resampled: false, ambiguous: false,
      ok: false, reason, detail,
    });
    skipped.push(skipText(rec.name, reason, detail));
  };

  for (let r = 0; r < used; r++) {
    const rec = records[r];
    if (rec.error) { fail(rec, 'parseError', rec.error); continue; }
    const si = Number.isFinite(rec.sampleInt) && rec.sampleInt > 0 ? rec.sampleInt : 0;
    if (si <= 0) { fail(rec, 'noSampleInt'); continue; }

    const pick = selectTrace(rec, sel);
    if (typeof pick === 'string') { fail(rec, pick); continue; }

    const tr = rec.traces![pick.traceIndex];
    let samp = tr?.samples;
    if (!samp || samp.length === 0) { fail(rec, 'noSamples'); continue; }

    if (opts.transform) {
      const t = opts.transform(samp, si);
      if (t && t.length) samp = t;
    }

    // Time alignment. The first contributing record sets the grid; a record on a
    // different interval is stretched/squeezed so sample k means the same instant
    // in every column.
    let resampled = false;
    if (refSi === 0) refSi = si;
    if (si !== refSi) {
      const targetLen = Math.max(1, Math.round((samp.length * si) / refSi));
      samp = resampleLinear(samp, targetLen);
      resampled = true;
      mixed = true;
    }
    siSet.add(si);

    if (samp.length > maxSamples) samp = resampleLinear(samp, maxSamples);

    const nf = normFactorPercentile(samp, 0.95);
    colNorms.push(nf);
    const column = columns.length;
    columns.push(samp);
    infos.push({
      name: rec.name, ffid: rec.ffid ?? null, column, traceIndex: pick.traceIndex,
      channel: pick.channel, offset: pick.offset, sampleInt: si, nSamples: samp.length,
      resampled, ambiguous: pick.ambiguous, ok: true,
    });
  }

  // Records beyond the cap are reported, not silently dropped.
  for (let r = used; r < offered; r++) {
    const rec = records[r];
    infos.push({
      name: rec.name, ffid: rec.ffid ?? null, column: -1, traceIndex: -1, channel: null, offset: null,
      sampleInt: 0, nSamples: 0, resampled: false, ambiguous: false, ok: false,
      reason: 'beyondCap',
    });
  }

  const numTraces = columns.length;
  let colLen = 0;
  for (let c = 0; c < numTraces; c++) if (columns[c].length > colLen) colLen = columns[c].length;
  const data = new Float32Array(numTraces * colLen);
  for (let c = 0; c < numTraces; c++) {
    const col = columns[c];
    const base = c * colLen;
    const n = Math.min(colLen, col.length);
    for (let k = 0; k < n; k++) data[base + k] = col[k];
  }
  const norms = new Float32Array(numTraces);
  let norm = 0;
  for (let c = 0; c < numTraces; c++) {
    const v = colNorms[c];
    // A non-finite / dead column must flat-line, never divide (0 * Infinity = NaN
    // on a canvas is banned).
    norms[c] = Number.isFinite(v) && v > 0 ? v : 0;
    if (norms[c] > norm) norm = norms[c];
  }
  if (norm <= 0) norm = 1;

  return {
    numTraces, colLen, norm, norms,
    sampleInt: refSi || 0,
    data, records: infos,
    truncated: offered > used,
    droppedByCap: offered - used,
    mixedSampleInt: mixed,
    sampleInts: [...siSet].sort((a, b) => a - b),
    skipped,
  };
}
