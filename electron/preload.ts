// SeisConv - preload bridge.
//
// The ONLY channel between the sandboxed renderer and Node/Electron. Exposes a
// tiny, typed `window.seisconvAPI`; everything privileged (fs, dialogs, the
// worker) stays in the main process behind these IPC calls.

import { contextBridge, ipcRenderer, webFrame } from 'electron';

/** Clamp a zoom factor to the app's allowed UI-zoom range (50 %-250 %). */
function clampZoom(factor: number): number {
  if (!Number.isFinite(factor)) return 1;
  return Math.min(2.5, Math.max(0.5, factor));
}

export interface ParseSummary {
  path: string;
  name: string;
  format: string;
  revision: number;
  traceCount: number;
  samplesTrace: number | null;
  sampleInt: number | null;
  byteOrder: string;
  errors: string[];
  /** 0-based position of this file among its seismic siblings (open file's folder). */
  index: number;
  /** Number of seismic siblings in the open file's folder. */
  count: number;
  /** Whether a previous sibling exists (index > 0). */
  hasPrev: boolean;
  /** Whether a next sibling exists (index < count - 1). */
  hasNext: boolean;
}

export interface TraceData {
  index: number;
  nSamples: number;
  sampleInt: number;
  hdr: Record<string, number | string>;
  samples: Float32Array;
}

/** One trace pulled from an arbitrary file by the Trace Workbench (extractTrace).
 *  Same shape as TraceData plus the source file name + total trace count, so the
 *  workbench can label the entry and clamp the trace-index input. */
export interface ExtractedTrace {
  name: string;
  index: number;
  traceCount: number;
  nSamples: number;
  sampleInt: number;
  hdr: Record<string, number | string>;
  samples: Float32Array;
}

export interface SectionOpts {
  maxTraces?: number;
  maxSamples?: number;
  // Optional visible sub-window in full-data indices (end exclusive). When set,
  // only this trace/sample range is decimated, so zoom re-fetches real detail.
  traceStart?: number;
  traceEnd?: number;
  sampStart?: number;
  sampEnd?: number;
  agc?: boolean;
  agcType?: 'rms' | 'median' | 'mean';
  agcWindowMs?: number;
}

export interface SectionData {
  numTraces: number;
  colLen: number;
  norm: number;
  sampleInt: number;
  traceStep: number;
  data: Float32Array; // numTraces × colLen, row-major (row = trace)
  // Window actually returned (full-data indices, end exclusive) + full extents,
  // so the renderer can label the time/trace axes and clamp pan/zoom.
  traceStart: number;
  traceEnd: number;
  sampStart: number;
  sampEnd: number;
  fullTraces: number;
  fullSamples: number;
}

export interface ConvertResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

export interface InputFolder {
  dir: string;
  files: { name: string; path: string }[];
}

export interface BatchOpts {
  files: { name: string; path: string }[];
  format: string;
  outDir: string;
  /** Output-name template ({name}/{custom}/{fmt}/{date}/{time}/{seq3}/{n});
   *  defaults to `{name}` on the main side. */
  nameTemplate?: string;
  /** Date stamp (YYYYMMDD) substituted for the {date} token. */
  dateStr?: string;
  /** Custom-text component substituted for the {custom} token (run-wide). */
  custom?: string;
  /** Time stamp (HHMM) substituted for the {time} token (run-wide). */
  time?: string;
}

export interface BatchResult {
  ok: boolean;
  total: number;
  done: number;
  failed: number;
  canceled: boolean;
  results: { name: string; ok: boolean; error?: string }[];
}

export interface ConvertProgress {
  index: number;
  total: number;
  file: string;
  state: 'start' | 'done' | 'error' | 'cancelled' | 'finished';
  error?: string;
}

/** A worker-side long-op progress tick (file open/index, SPS load, …). `total>0`
 *  ⇒ determinate (done/total); else indeterminate. `op` tags the operation. */
export interface WorkerProgress {
  type: 'progress';
  op: string;
  done: number;
  total: number;
  label: string;
  /** Basemap tile downloads only: bytes pulled over the wire so far. */
  bytes?: number;
  /** ESTIMATED total bytes (average tile size so far x tile count). A tile server
   *  publishes no manifest, so this is an estimate and the UI marks it as one. */
  bytesTotalEst?: number;
  /** Rolling download rate in bytes per second. */
  bytesPerSec?: number;
  tilesFailed?: number;
  /** True once every tile is fetched and the remaining work is local resampling. */
  downloadDone?: boolean;
}

export interface SPSSummary {
  sources: number;
  receivers: number;
  xrefs: number;
  layout: string | null;
  projection: { type: string | null; subtype: string | null; desc?: string; latOrigin?: number | null; zone?: number | null } | null;
  errors: string[];
  /** Distinct positioning format label(s) detected this Load (e.g. ['SPS','P1/11']). */
  formats?: string[];
  /** Brief P6/11 bin-grid summary when a grid was loaded this Load (else null). */
  binGrid?: { nInline: number; nCrossline: number; originE: number; originN: number; binI: number; binJ: number; inlineAzimuth: number } | null;
}

/** A P6/11 acquisition bin grid in projected (E/N) space, as returned by `binGrid()`.
 *  Mirrors core/sps/bingrid.ts BinGrid (the QC overlay reads origin/azimuth/corners). */
export interface BinGridInfo {
  name?: string;
  crs?: SPSSummary['projection'] | null;
  originE: number;
  originN: number;
  binI: number;
  binJ: number;
  nInline: number;
  nCrossline: number;
  inlineAzimuth: number;
  firstInline: number;
  firstCrossline: number;
  incInline: number;
  incCrossline: number;
  corners?: { e: number; n: number }[];
  raw: string[];
}

export interface SpsLines {
  x: Float32Array;
  y: Float32Array;
  line: Int32Array;
  pt: Float32Array;
  names: string[];
}

export interface SpsGeometry {
  geo: boolean;
  src: SpsLines;
  rcv: SpsLines;
  bbox: { minX: number; maxX: number; minY: number; maxY: number };
}

/** Shot → live-receiver connection segments ("spider"). Parallel typed arrays:
 *  segment i runs (sx[i],sy[i]) → (rx[i],ry[i]); shot[i] is its per-shot group id
 *  (index into shotKeys, each 'srcLine|srcPt'). Coords are projected E/N, or
 *  WGS84 lon/lat when geo=true. `decimated` flags a capped/sampled survey. */
export interface SpsXrefLines {
  geo: boolean;
  sx: Float32Array;
  sy: Float32Array;
  rx: Float32Array;
  ry: Float32Array;
  shot: Int32Array;
  shotKeys: string[];
  decimated: boolean;
  log: string;
}

/** FOLD / coverage bin map: CMP-midpoint counts per bin. `fold` is a row-major
 *  Int32 grid of nx×ny cells; cell (ix,iy) lives at fold[iy*nx+ix] and covers the
 *  projected E/N rectangle [originX+ix*binX, originX+(ix+1)*binX] ×
 *  [originY+iy*binY, originY+(iy+1)*binY]. `decimated` flags a sampled survey. */
export interface SpsFold {
  nx: number;
  ny: number;
  binX: number;
  binY: number;
  originX: number;
  originY: number;
  fold: Int32Array;
  maxFold: number;
  totalMid: number;
  decimated: boolean;
  log: string;
}

/** Lightweight coords for one offending point in a QC finding (no full SPSPoint). */
export interface QCPoint {
  rtype: 'S' | 'R';
  lineName: string;
  point: number;
  easting: number;
  northing: number;
}

export interface QCRow {
  sev: string;
  cat: string;
  msg: string;
  /** Offending points for this finding (empty for findings without locations). */
  pts: QCPoint[];
}

/** Full field set for one source/receiver point (source vs receiver extras differ). */
export interface SPSPointDetail {
  rtype: 'S' | 'R';
  lineName: string;
  point: number;
  idx: string;
  easting: number;
  northing: number;
  elevation: number;
  raw: string;
  upholeMs?: number;
  srcType?: string;
  date?: string;
  time?: string;
  ffid?: number;
  staticMs?: number;
}

/** One finding from the SEG-Y↔SPS Geometry Integrity check: a severity, a short
 *  category, a human-readable message, an affected-item count, and up to a few
 *  sample offenders (FFID / channel / point + the disagreement distance). */
export interface GeomFinding {
  sev: 'error' | 'warn' | 'info';
  cat: string;
  msg: string;
  count: number;
  sample?: Array<{ ffid?: number; channel?: number; point?: number; dx?: number; dy?: number; dist?: number }>;
}

/** Result of {@link SeisconvAPI.spsGeomCheck}: the trace count, source/receiver
 *  coordinate-coverage %, the distinct SEG-Y coordinate scalars seen, how many
 *  distinct SPS stations were matched, and the list of findings. Mirrors core's
 *  GeomCheckResult (kept structural here - preload stays core-import-free). */
export interface GeomCheckResult {
  traceCount: number;
  srcCoveragePct: number;
  rcvCoveragePct: number;
  scalarValues: number[];
  matchedSrcPts: number;
  matchedRcv: number;
  findings: GeomFinding[];
}

/** Summary of {@link SeisconvAPI.spsGeomLoad}: how many traces were stamped with
 *  SPS geometry. `matched` = traces with BOTH source and receiver resolved;
 *  src/rcvMatched are per-side trace counts; src/rcvStations are the distinct SPS
 *  stations stamped; `coordScalar` is the scalar actually written; `fieldsWritten`
 *  names the field groups stamped at least once. Mirrors core's GeomLoadResult
 *  (minus the bytes; kept structural - preload stays core-import-free). */
export interface GeomLoadSummary {
  traceCount: number;
  matched: number;
  srcMatched: number;
  rcvMatched: number;
  unmatched: number;
  srcStations: number;
  rcvStations: number;
  coordScalar: number;
  fieldsWritten: string[];
  errors: string[];
}

/** Result of {@link SeisconvAPI.spsGeomLoad}: the match summary (present whenever
 *  `ok`, even when the Save dialog was dismissed), the saved path when Save
 *  completed, or `canceled`. `ok:false` carries the not-ready / failure reason. */
export interface GeomLoadResult {
  ok: boolean;
  summary?: GeomLoadSummary;
  savedPath?: string;
  canceled?: boolean;
  error?: string;
}

/** One matched station's plan-to-actual offset in an as-laid-vs-pre-plot diff.
 *  dE/dN = asLaid - reference (metres); dist = hypot(dE, dN); overTol = dist > tolM.
 *  Mirrors core's StationDelta (kept structural - preload stays core-import-free). */
export interface StationDelta {
  rtype: 'S' | 'R';
  lineName: string;
  point: number;
  dE: number;
  dN: number;
  dist: number;
  overTol: boolean;
}

/** Per-category (sources OR receivers) summary of the as-laid-vs-reference diff:
 *  matched / over-tolerance counts, the max / mean / p95 skid distance, the added
 *  (as-laid-only) and missing (reference-only) station counts, and the worst
 *  offenders (capped at 200 in core, worst first). Mirrors core's DeltaCategory. */
export interface DeltaCategory {
  matched: number;
  overTol: number;
  maxDist: number;
  meanDist: number;
  p95Dist: number;
  addedInAsLaid: number;
  missingFromAsLaid: number;
  offenders: StationDelta[];
}

/** Result of {@link SeisconvAPI.spsDelta}: the as-laid-vs-pre-plot "skid report".
 *  `tolM` is the over-tolerance flag distance; `matchKey` records whether stations
 *  were matched on (line, point) or by point alone (numbering-mismatch fallback);
 *  `note` is set for a degenerate / non-matching comparison. Mirrors core's
 *  SPSDeltaResult (kept structural here - preload stays core-import-free). */
export interface SPSDeltaResult {
  tolM: number;
  sources: DeltaCategory;
  receivers: DeltaCategory;
  matchKey: 'line+point' | 'point';
  note?: string;
}

export interface SemblanceData {
  semb: Float32Array;
  vels: number[];
  nT: number;
  dt: number;
  siUs: number;
  offNote: string;
}

/** Trace-health QC scan of the open file (File Viewer). The heavy work (per-trace
 *  RMS, LOCAL neighbour median+MAD baselines, spectra, the polarity correlation) runs
 *  ONCE; the result is a flat per-SCANNED-trace EVIDENCE buffer the renderer
 *  re-classifies live as the sensitivity changes (no re-parse). `evidence` is a
 *  row-major Float32 struct-of-arrays of `traceIndex.length` rows × `evStride`
 *  columns (column order = core's EVIDENCE_FIELDS); `traceIndex[i]` is the ABSOLUTE
 *  file trace index of row i; `ffid`/`channel`/`offset` are that trace's header
 *  fields (amplitude/offset carry no physical unit - raw sample/header values). The
 *  coverage report is honest: a huge survey is sampled as contiguous blocks, never
 *  silently skipped. */
export interface TraceHealthData {
  evidence: Float32Array;
  evStride: number;
  traceIndex: Int32Array;
  ffid: Int32Array;
  channel: Int32Array;
  offset: Float32Array;
  sampleInt: number;
  coverage: { scanned: number; total: number; stride: number; blocks: number; polarityRan: boolean; polarityScanned: number };
}

/** Assisted first-break picks (File Viewer mode). One entry per REAL adjacent trace
 *  in [traceStart, traceEnd), keyed by ABSOLUTE index. `pTime` is the onset (ms) or
 *  NaN (dead / no pick); `pSource` is 0 seed · 1 auto · 2 edited; `pConf` is the
 *  phase-lock confidence (|xcorr|); `pDev` the ms off the moveout trend. `gAbs`/`guide`
 *  are the moveout guide curve over the scanned range, for the overlay's dashed guide
 *  + shaded ±`windowMs` search band. Amplitude/offset carry no physical unit. */
export interface FirstBreaksData {
  sampleInt: number;
  windowMs: number;
  hasOffsets: boolean;
  traceStart: number;
  traceEnd: number;
  pAbs: Int32Array;
  pTime: Float32Array;
  pSource: Int8Array;
  pConf: Float32Array;
  pDev: Float32Array;
  pFfid: Int32Array;
  pChan: Int32Array;
  pOff: Float32Array;
  gAbs: Int32Array;
  guide: Float32Array;
}

/** Average amplitude spectrum across the open file (or a trace sub-window): the
 *  mean of per-trace single-sided spectra. `freqs`/`amp` are parallel length-N/2
 *  arrays; `nTraces` is how many traces contributed; `decimated` flags a sampled
 *  (strided) trace set. */
export interface AvgSpectrumData {
  freqs: Float32Array;
  amp: Float32Array;
  nyquist: number;
  nTraces: number;
  decimated: boolean;
  log: string;
}

/** STFT spectrogram of one trace: `mag` is a row-major nFrames×nBins Float32 grid
 *  (row = time frame, col = freq bin); `freqs` (Hz, length nBins) + `times` (s,
 *  length nFrames) are the axes; `maxMag` is the peak for normalized display. */
export interface SpectrogramData {
  mag: Float32Array;
  nFrames: number;
  nBins: number;
  freqs: Float32Array;
  times: Float32Array;
  maxMag: number;
  siUs: number;
}

/** f-k (frequency-wavenumber) spectrum of the section: `mag` is a row-major
 *  nF×nKx Float32 grid (row = frequency, col = wavenumber); `fAxis` (Hz, positive
 *  half) + `kAxis` (cycles/distance-unit, fftshifted so kx=0 is centred) are the
 *  axes; `maxMag` is the peak; `decimated` flags a sampled section. */
export interface FkData {
  mag: Float32Array;
  nKx: number;
  nF: number;
  kAxis: Float32Array;
  fAxis: Float32Array;
  maxMag: number;
  decimated: boolean;
  log: string;
}

/** One SPS H-record row for the Header Viewer/Editor: the 4-char code, the
 *  editable DATA value, the original raw line, and a human-readable description. */
export interface SPSHeaderRow {
  code: string;
  val: string;
  raw: string;
  desc: string;
}

/** Parsed projection / datum block surfaced alongside the H-record list. */
export interface SPSHeaderProjection {
  type: string | null;
  subtype: string | null;
  zone: number | null;
  hemi: string | null;
  datum: string | null;
  ellipsoid: string | null;
  units: string;
  centralMeridian: number | null;
  latOrigin: number | null;
  falseEasting: number | null;
  falseNorthing: number | null;
  scaleFactor: number | null;
  desc?: string;
}

/** Result of {@link SeisconvAPI.spsHeaderList}: the shared H block, the parsed
 *  projection, the loaded file list, and whether the files' H blocks differ. */
export interface SPSHeaderListResult {
  ok: boolean;
  headers: SPSHeaderRow[];
  projection: SPSHeaderProjection | null;
  files: { name: string; type: string }[];
  filesDiffer: boolean;
}

/** Loose CRS rewrite spec sent by the Header Editor (header-only regeneration of
 *  the projection H-records). All fields optional. */
export interface SPSCrsEdit {
  datum?: string;
  projType?: string;
  zone?: number;
  hemi?: 'N' | 'S';
  units?: string;
  centralMeridian?: number;
  latOrigin?: number;
  falseEasting?: number;
  falseNorthing?: number;
  scaleFactor?: number;
}

/** The edit/add/remove (+ optional CRS) batch the Header Editor applies. `scope`
 *  is 'shared' (all loaded SPS files) or a single loaded file's name. */
export interface SPSApplyHeadersReq {
  scope: 'shared' | string;
  // `oldVal` (optional) targets a specific record by code+value so two records
  // sharing a code aren't edited/removed together. A bare `string` remove is the
  // code-only form (kept for back-compat).
  edits: { code: string; val: string; oldVal?: string }[];
  adds: { code: string; desc?: string; val: string }[];
  removes: (string | { code: string; oldVal?: string })[];
  crs?: SPSCrsEdit;
}

/** Result of {@link SeisconvAPI.spsApplyHeaders}: ok + the refreshed header list. */
export interface SPSApplyHeadersResult {
  ok: boolean;
  headers: SPSHeaderRow[];
  error?: string;
}

/** One acquisition line for the SPS GENERATOR: an ordered polyline of WGS84
 *  lat/lon map picks (≥2 vertices; crooked lines OK). The worker forward-projects
 *  these to the chosen CRS's E/N before laying out stations. */
export interface SPSCreatePick {
  vertices: { lat: number; lon: number }[];
}

/** One already-positioned station of a PREPLOT line. `lat`/`lon` are always
 *  present (they are what the map draws); `e`/`n` are the file's ORIGINAL projected
 *  coordinates and are used verbatim when they are already in the target CRS, so an
 *  imported pre-plot reaches the SPS writer as the exact numbers it arrived with. */
export interface SPSCreatePreplotStation {
  lat: number;
  lon: number;
  /** Station number to write. Honoured exactly - never renumbered. */
  point: number;
  elev?: number;
  e?: number;
  n?: number;
}

/** One PREPLOT line: stations placed verbatim, not walked at an interval. `role`
 *  says what they become - receivers, sources, or a co-located pair per station. */
export interface SPSCreatePreplotLine {
  lineName: string;
  role: 'R' | 'S' | 'SR';
  stations: SPSCreatePreplotStation[];
}

/** Request for {@link SeisconvAPI.spsCreate}: the target CRS (loose spec, same as
 *  the Header Editor's {@link SPSCrsEdit}), an output file stem, the per-line map
 *  picks, and the acquisition scalars. Every scalar is optional - omitted ones use
 *  core's CREATE_DEFAULTS. `mode:'2D'` walks each pick; `mode:'3D'` treats the
 *  picks as receiver lines and generates perpendicular source lines. */
export interface SPSCreateReq {
  crs: SPSCrsEdit;
  baseName?: string;
  /** Lines to be WALKED at `rcvInterval`/`srcInterval` (the click-to-pick case).
   *  May be empty when the request carries `preplots` instead. */
  picks: SPSCreatePick[];
  /** Lines whose stations are used VERBATIM (the import case). At least one of
   *  `picks` / `preplots` must be non-empty. A request with only `picks` is
   *  byte-identical to what this API accepted before preplots existed. */
  preplots?: SPSCreatePreplotLine[];
  mode?: '2D' | '3D';
  rcvInterval?: number;
  srcInterval?: number;
  rcvLineStart?: number;
  rcvLineInc?: number;
  rcvPointStart?: number;
  rcvPointInc?: number;
  srcLineStart?: number;
  srcLineInc?: number;
  srcPointStart?: number;
  srcPointInc?: number;
  /** 3D only: spacing between adjacent generated source lines (SLI), measured
   *  along the in-line / receiver-line bearing. */
  srcLineSpacing?: number;
  /** 3D only: receiver-line bearing in degrees clockwise from North. Omitted →
   *  derived from the picks (net direction of the longest line). */
  azimuthDeg?: number;
  /** Cross-reference model. 2D: `full` = every receiver per shot; `split` = a
   *  window of `channels` receivers around the shot. 3D: `full` = full template
   *  (every shot records every receiver); `split` = moving patch of `patchLines`
   *  receiver lines × `channels` stations around each shot. */
  relation?: { type: 'full' | 'split'; channels?: number; patchLines?: number };
  srcType?: string;
  rcvType?: string;
}

/** Per-category (source or receiver) renumber instructions. Provide a line
 *  renumber (sequential `lineStart`/`lineInc`, OR an explicit `lineMap`) and/or a
 *  point renumber (sequential per line via `pointStart`/`pointInc`, OR affine
 *  `new = old·pointScale + pointOffset`). Point transforms must stay monotonic
 *  (pointInc/pointScale > 0) or the worker rejects the request. */
export interface SPSLineRenumber {
  lineStart?: number;
  lineInc?: number;
  lineMap?: Record<string, string>;
  pointStart?: number;
  pointInc?: number;
  pointOffset?: number;
  pointScale?: number;
}

/** Request for {@link SeisconvAPI.spsRenumber}: a renumber spec for sources and/or
 *  receivers (at least one required), plus an optional output file stem. */
export interface SPSRenumberReq {
  spec: { source?: SPSLineRenumber; receiver?: SPSLineRenumber };
  baseName?: string;
}

/** Result of {@link SeisconvAPI.spsCreate} / {@link SeisconvAPI.spsRenumber}. The
 *  worker installs (create) or refreshes (renumber) the loaded survey regardless
 *  of the save outcome, so `summary` (same shape as openSPS) is present whenever
 *  `ok`. `savedPath` is set only when the user completed the Save dialog;
 *  `canceled` is true when they dismissed it (the survey is still loaded). */
export interface SPSWriteResult {
  ok: boolean;
  summary?: SPSSummary;
  savedPath?: string;
  canceled?: boolean;
  error?: string;
}

/** Observer Log payload restored from a saved .json (shape matches what the
 *  renderer writes via exportText). Fields are loosely typed - the renderer
 *  reconciles them against its own LogColumn / LogRow types on load. */
export interface LogJson {
  meta: Record<string, string>;
  columns: { key: string; label: string; group: string; type: string; unit?: string; options?: string[] }[];
  rows: Record<string, string | number>[];
}

/** Result of an SNTP "Sync clock" query. `offsetMs` (= serverTimeMs - local
 *  Date.now()) and `serverTimeMs` are present only when ok; otherwise `error`
 *  carries the reason (timeout / DNS failure / offline). */
export interface NtpSyncResult {
  ok: boolean;
  offsetMs?: number;
  serverTimeMs?: number;
  error?: string;
}

/** One SPS source record exposed to the Observer Log for column-linking. The
 *  three optional SPSPoint fields (upholeMs/staticMs/srcType) are null when the
 *  survey didn't carry them. */
export interface SpsSourceRecord {
  lineName: string;
  point: number;
  idx: string;
  easting: number;
  northing: number;
  elevation: number;
  upholeMs: number | null;
  staticMs: number | null;
  srcType: string | null;
}

// -- Observer Log "Trigger Watch" wire types (renderer ⇄ main) --
/** Per-source trigger configuration; main validates every field again. */
export interface TriggerWatchCfg {
  folder?: { enabled: boolean; dir: string };
  udp?: { enabled: boolean; port: number; bindAll: boolean };
  serial?: { enabled: boolean; port: string; baud: number };
  /** Geometrics SCS survey-log tail - a row per shot at TRIGGER time. */
  scslog?: { enabled: boolean; path: string };
  /** Passive fs.watch on SCS's TempCom scratch folder - a row per trigger touch. */
  scstrig?: { enabled: boolean; dir: string };
  /** Read-only watch of the recorder's save folder (e.g. C:\SC_Files) used ONLY to
   *  ENRICH a row's File#/FFID from the landed .dat (Auto-number reconcile/real
   *  modes). This NEVER triggers a row - triggering fires on the trigger source. */
  scfiles?: { enabled: boolean; dir: string };
}
/** Per-source start outcome ({ on, error? }); `ok` = every REQUESTED source started. */
export interface TriggerWatchResult {
  ok: boolean;
  folder: { on: boolean; error?: string };
  udp: { on: boolean; error?: string };
  serial: { on: boolean; error?: string };
  scslog: { on: boolean; error?: string };
  scstrig: { on: boolean; error?: string };
  /** Enrichment watch (File# reconcile/real) - not a trigger source. */
  scfiles: { on: boolean; error?: string };
}
/** Catch-up scan result: shot files in the active watched folder, oldest first. */
export interface TriggerScanResult {
  ok: boolean;
  error?: string;
  files: { name: string; path: string; mtimeMs: number; size: number }[];
}
/** Quick shot-file metadata (enrichment): FFID / traces / ns / sample interval. */
export interface TriggerQuickMetaResult {
  ok: boolean;
  error?: string;
  meta?: { format: string; traces: number; ns: number | null; siUs: number | null; ffid: number | null };
}
/** One push on 'seisconv:triggerEvent' - a trigger or a source-status change. */
export type TriggerEventMsg =
  | { type: 'status'; source: 'folder' | 'udp' | 'serial' | 'scslog' | 'scstrig'; state: 'started' | 'stopped' | 'error'; detail?: string }
  | { type: 'trigger'; source: 'folder'; name: string; path: string; mtimeMs: number; size: number; ts: string }
  | { type: 'trigger'; source: 'udp' | 'serial'; kind: 'shot' | 'trig'; id: number | null; line: string | null; sp: number | null; ts: string; raw: string }
  | { type: 'trigger'; source: 'scslog'; shot: number; time: string; date: string }
  | { type: 'trigger'; source: 'scstrig'; ts: string }
  /** ENRICHMENT (not a trigger): a recorded .dat landed in the SC_Files folder -
   *  carries the file's REAL File#/FFID so the renderer can fill/correct a row. */
  | { type: 'scfile'; name: string; path: string; ffid: number | null; ts: string };

// -- WiFiSync ("Field" tab) wire types (renderer ⇄ main) --
export type FieldRole = 'both' | 'master' | 'slave';
/** Persisted WiFiSync settings (mirrors electron/field WifiSyncSettings). */
export interface FieldSettings {
  folder: string;
  adapter: string;
  manual_ip: string;
  hs_ssid: string;
  hs_pass: string;
  role: FieldRole;
  sync_mode: 'on_change' | 'interval';
  sync_interval: string;
  throttle_enabled: boolean;
  throttle_kbps: string;
}
/** Config to (re)start the engine. bindIp/broadcastAddr come from the picked adapter. */
export interface FieldStartCfg {
  folder: string;
  role: FieldRole;
  watchMode: 'on_change' | 'interval';
  syncInterval: number;
  maxKbps: number;
  bindIp: string;
  broadcastAddr: string;
  manualIp: string;
}
export interface FieldPeerInfo { ip: string; port: number; role: FieldRole }
export interface FieldStatus {
  running: boolean;
  mode: FieldRole;
  serverOn: boolean;
  discoveryOn: boolean;
  manual: boolean;
  folder: string;
  peers: FieldPeerInfo[];
}
export interface FieldNetworkAdapter { label: string; ip: string; broadcast: string }
export interface FieldHistoryEntry {
  timestamp: number;
  filename: string;
  action: 'pulled' | 'deleted';
  peer_ip: string;
  size_bytes: number;
}
export interface FieldHotspotStatus { running: boolean; ssid: string; clients: number }
/** A WiFi adapter offered in the hotspot dropdown (Get-NetAdapter). */
export interface FieldWifiAdapter { label: string; name: string; status: string }
/** One push on 'seisconv:fieldEvent'. */
export type FieldEventMsg =
  | { type: 'log'; msg: string; ts: string }
  | { type: 'peer'; action: 'found' | 'lost'; ip: string; port?: number; role?: FieldRole }
  | { type: 'sync'; ok: boolean; detail: string }
  | { type: 'file'; kind: 'pulled' | 'deleted'; relPath: string; peerIp: string; size: number }
  | { type: 'status'; running: boolean; mode: FieldRole; serverOn: boolean; discoveryOn: boolean; manual: boolean; folder: string; peers: FieldPeerInfo[] }
  | { type: 'negotiated'; role: FieldRole; peerRole: FieldRole }
  | { type: 'renegotiable' };

const api = {
  /** Host OS, for OS-aware key hints (set to process.platform at preload load). */
  platform: process.platform as string,
  /** Open a file picker, parse the chosen file off-thread; returns a summary (or null if cancelled). */
  openAndParse: (): Promise<ParseSummary | null> => ipcRenderer.invoke('seisconv:openAndParse'),
  /** Step ±delta through the seismic files in the open file's folder; parses the
   *  target and returns the same summary shape, or null if the move is a no-op
   *  (already at an edge, or no file open). */
  openSiblingFile: (delta: number): Promise<ParseSummary | null> => ipcRenderer.invoke('seisconv:openSiblingFile', delta),
  /** Get one trace's samples + header from the currently-open file. */
  getTrace: (index: number): Promise<TraceData> => ipcRenderer.invoke('seisconv:getTrace', index),
  /** Trace Workbench: open a single-file picker; returns the chosen path (no parse) or null. */
  pickTraceFile: (): Promise<string | null> => ipcRenderer.invoke('seisconv:pickTraceFile'),
  /** Trace Workbench: parse `path` locally and pull ONE trace (samples + header + source meta). */
  extractTrace: (path: string, index: number): Promise<ExtractedTrace> => ipcRenderer.invoke('seisconv:extractTrace', path, index),
  /** Get a decimated section matrix (for variable-density / wiggle display). */
  getSection: (opts?: SectionOpts): Promise<SectionData> => ipcRenderer.invoke('seisconv:getSection', opts ?? {}),
  /** Pick an input folder; returns its seismic files (sorted by name) or null. */
  pickInputFolder: (): Promise<InputFolder | null> => ipcRenderer.invoke('seisconv:pickInputFolder'),
  /** Pick an output folder; returns the chosen path or null. */
  pickOutputFolder: (): Promise<string | null> => ipcRenderer.invoke('seisconv:pickOutputFolder'),
  /** Convert the currently-open file to `format` and save via a native dialog;
   *  `outBaseName` (no extension) becomes the save dialog's default file name. */
  convertSingle: (format: string, outBaseName?: string): Promise<ConvertResult> =>
    ipcRenderer.invoke('seisconv:convertSingle', format, outBaseName),
  /** Trace Workbench EXPORT: write the collected traces out as a seismic file in
   *  `format` and save via a native dialog. `sampleInt` (µs) is stamped on the
   *  synthetic file (the collection's first trace); `baseName` (no extension)
   *  seeds the dialog's default name. */
  convertTraces: (args: { traces: { samples: Float32Array; nSamples: number; sampleInt?: number }[]; sampleInt?: number; format: string; baseName?: string }): Promise<ConvertResult> =>
    ipcRenderer.invoke('seisconv:convertTraces', args),
  /** Convert a list of files to `format`, writing each into outDir; emits progress per file. */
  batchConvert: (opts: BatchOpts): Promise<BatchResult> => ipcRenderer.invoke('seisconv:batchConvert', opts),
  /** Subscribe to batch-convert progress; returns an unsubscribe fn. */
  onConvertProgress: (cb: (p: ConvertProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: ConvertProgress) => cb(p);
    ipcRenderer.on('seisconv:convertProgress', listener);
    return () => ipcRenderer.removeListener('seisconv:convertProgress', listener);
  },
  /** Subscribe to worker-side long-op progress (file open/index build, SPS load);
   *  routes to the renderer's global progress bar. Returns an unsubscribe fn. */
  // Payload may also carry basemap-download detail (bytes / bytesTotalEst /
  // bytesPerSec / tilesFailed / downloadDone); WorkerProgress declares them optional.
  onWorkerProgress: (cb: (p: WorkerProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: WorkerProgress) => cb(p);
    ipcRenderer.on('seisconv:workerProgress', listener);
    return () => ipcRenderer.removeListener('seisconv:workerProgress', listener);
  },
  /** Signal the running batch to stop. */
  cancelConvert: (): void => ipcRenderer.send('seisconv:cancelConvert'),
  /** Open the last conversion OUTPUT in the OS file explorer: 'single' reveals +
   *  selects the saved file, 'batch' opens the batch/combine destination folder.
   *  No-op (ok:false) when no output path is known yet. */
  openOutputFolder: (which: 'single' | 'batch'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('seisconv:openOutputFolder', which),
  /** Clear the open file + cached state in the worker. */
  resetState: (): Promise<void> => ipcRenderer.invoke('seisconv:resetState'),
  /** Open one or more SPS files (S/R/X), parse + merge them, return a summary. */
  openSPS: (): Promise<SPSSummary | null> => ipcRenderer.invoke('seisconv:openSPS'),
  /** Clear ONLY the loaded SPS survey in the worker (keeps any open seismic file). */
  spsClear: (): Promise<void> => ipcRenderer.invoke('seisconv:spsClear'),
  /** Get the loaded P6/11 bin grid (or null when none is loaded). */
  binGrid: (): Promise<BinGridInfo | null> => ipcRenderer.invoke('seisconv:binGrid'),
  /** Get line-grouped survey geometry (projected E/N, or WGS84 lon/lat when geo=true). */
  spsGeometry: (geo: boolean): Promise<SpsGeometry> => ipcRenderer.invoke('seisconv:spsGeometry', geo),
  /** Get shot→receiver "spider" segments (projected E/N, or WGS84 lon/lat when geo=true). */
  spsXrefLines: (geo: boolean): Promise<SpsXrefLines> => ipcRenderer.invoke('seisconv:spsXrefLines', geo),
  /** Get the CMP-midpoint FOLD / coverage bin map (projected E/N) for the given bin size. */
  spsFold: (opts: { binX: number; binY: number }): Promise<SpsFold> => ipcRenderer.invoke('seisconv:spsFold', opts),
  /** Run survey QC on the loaded SPS data. */
  spsQC: (qc?: { srcInt?: number; rcvInt?: number; tol?: number; maxOff?: number; maxSrc?: number; maxRcv?: number }): Promise<QCRow[]> =>
    ipcRenderer.invoke('seisconv:spsQC', qc ?? {}),
  /** Fetch the full field set of one source/receiver point; null if not found / no SPS. */
  spsPointDetail: (args: { rtype: 'S' | 'R'; lineName: string; point: number; idx?: string }): Promise<SPSPointDetail | null> =>
    ipcRenderer.invoke('seisconv:spsPointDetail', args),
  /** Geometry Integrity Suite: cross-check the OPEN seismic file's trace-header
   *  geometry (source/receiver coordinates) against the loaded SPS survey design.
   *  Requires BOTH a seismic file and an SPS loaded - returns { ok:false, error }
   *  otherwise. `tolM` is the station-match tolerance in metres (default 2). */
  spsGeomCheck: (opts?: { tolM?: number }): Promise<{ ok: boolean; result?: GeomCheckResult; error?: string }> =>
    ipcRenderer.invoke('seisconv:spsGeomCheck', opts ?? {}),
  /** Load geometry into SEG-Y (the WRITE counterpart of spsGeomCheck): stamp the
   *  loaded SPS survey's source/receiver coordinates (+ elevation, offset, CDP,
   *  scalars) into the OPEN SEG-Y's trace headers and save the geometry-loaded
   *  SEG-Y via a native dialog. Requires BOTH a SEG-Y file and an SPS loaded
   *  (→ { ok:false, error } otherwise). `tolM` is the station-match tolerance (m,
   *  default 2); `coordScalar` (one of 1/-10/-100/-1000/-10000, default -100) sets
   *  the stored precision; the write* flags pick the field groups (all default on).
   *  The summary is present even when the Save dialog is dismissed (`canceled`). */
  spsGeomLoad: (opts?: { tolM?: number; coordScalar?: number; writeCoords?: boolean; writeElev?: boolean; writeOffset?: boolean; writeCdp?: boolean }): Promise<GeomLoadResult> =>
    ipcRenderer.invoke('seisconv:spsGeomLoad', opts ?? {}),
  /** As-laid vs Pre-plot delta ("skid report"): open a picker for a REFERENCE
   *  (pre-plot / planned) SPS triplet and diff the LOADED survey (as-laid) against
   *  it station by station via the pure compareSPS - WITHOUT merging the reference
   *  into the loaded survey. Requires a survey already loaded (→ { ok:false, error }
   *  otherwise). `tolM` sets the over-tolerance flag distance (metres, default 1).
   *  Dialog cancel → { ok:false, canceled:true }; `refName` labels the chosen reference. */
  spsDelta: (opts?: { tolM?: number }): Promise<{ ok: boolean; result?: SPSDeltaResult; error?: string; canceled?: boolean; refName?: string }> =>
    ipcRenderer.invoke('seisconv:spsDelta', opts ?? {}),
  /** Reproject the loaded SPS survey to an EPSG target and save a ZIP. */
  spsReproject: (code: string): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:spsReproject', code),
  /** SPS GENERATOR: build a fresh survey from map picks (WGS84 lat/lon per line) +
   *  a target CRS, install it as the loaded survey in the worker, and save the
   *  generated S/R/X files as a .zip. Returns the load summary (present even when
   *  the save is cancelled) plus the saved path / canceled flag. */
  spsCreate: (req: SPSCreateReq): Promise<SPSWriteResult> => ipcRenderer.invoke('seisconv:spsCreate', req),
  /** SPS RENUMBER: re-map the loaded survey's source/receiver line + point ids
   *  (X-refs kept consistent), refresh the loaded survey, and save the renumbered
   *  S/R/X files as a .zip. Returns the refreshed summary (present even when the
   *  save is cancelled) plus the saved path / canceled flag. */
  spsRenumber: (req: SPSRenumberReq): Promise<SPSWriteResult> => ipcRenderer.invoke('seisconv:spsRenumber', req),
  /** SPS Header Viewer: get the shared H block (code/val/raw/desc), the parsed
   *  projection, the loaded-file list, and whether the files' H blocks differ. */
  spsHeaderList: (): Promise<SPSHeaderListResult> => ipcRenderer.invoke('seisconv:spsHeaderList'),
  /** SPS Header Editor: apply an edit/add/remove batch (+ optional CRS rewrite)
   *  to the loaded survey's H block(s); re-parses in the worker and returns the
   *  refreshed header list. Does not save to disk (see spsSaveCorrected). */
  spsApplyHeaders: (req: SPSApplyHeadersReq): Promise<SPSApplyHeadersResult> => ipcRenderer.invoke('seisconv:spsApplyHeaders', req),
  /** SPS Header Editor: save the current (edited) SPS files to disk as a .zip. */
  spsSaveCorrected: (): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:spsSaveCorrected'),
  /** Export the loaded SPS survey as KML / GeoJSON / a CSV trio / a QC-report CSV.
   *  Multi-file output (csv) is saved as a ZIP; single-file output via a Save dialog. */
  spsExport: (args: { kind: 'kml' | 'geojson' | 'csv' | 'qcreport' | 'p111' | 'coordcsv' | 'segp1' | 'sps'; qcParams?: { srcInt?: number; rcvInt?: number; tol?: number; maxOff?: number; maxSrc?: number; maxRcv?: number } }): Promise<ConvertResult> =>
    ipcRenderer.invoke('seisconv:spsExport', args),
  /** Export the loaded SPS survey as an ESRI Shapefile set (source + receiver
   *  point layers, each .shp/.shx/.dbf/.prj/.cpg), saved as one ZIP. `code` is an
   *  EPSG code to reproject to; omit it to write the survey's native coordinates.
   *  `notes` carries anything the export had to warn about (missing CRS, skipped
   *  X records) so the UI can show it rather than failing silently. */
  spsShapefile: (args: { code?: string; baseName?: string }): Promise<ConvertResult & { notes?: string[] }> =>
    ipcRenderer.invoke('seisconv:spsShapefile', args),
  /** Export the loaded SPS survey as GeoTIFF rasters (fold / elevation / layout)
   *  over a dragged map area at a chosen ground resolution, saved as one ZIP. */
  spsRaster: (args: {
    bounds?: { south: number; west: number; north: number; east: number } | null;
    whole?: boolean;
    marginM?: number;
    pixelSize: number;
    layers: ('fold' | 'elevation' | 'layout')[];
    code?: string;
    demRadius?: number;
    baseName?: string;
  }): Promise<ConvertResult & { notes?: string[]; grid?: Record<string, unknown> }> =>
    ipcRenderer.invoke('seisconv:spsRaster', args),
  /** Search the full offline EPSG registry (~7 000 CRSs) held in the main
   *  process. Rows carry `supported` plus a `reason` when the app cannot compute
   *  that CRS, so the picker can show it greyed rather than hide it. */
  epsgSearch: (args: { query?: string; limit?: number; supportedOnly?: boolean }): Promise<{
    total: number;
    rows: { code: string; name: string; method: string; units: string; deprecated: boolean; supported: boolean; reason?: string }[];
  }> => ipcRenderer.invoke('seisconv:epsgSearch', args),
  /** Compute an NMO semblance panel for the open file. */
  semblance: (opts: { velMin: number; velMax: number; velStep: number }): Promise<SemblanceData> => ipcRenderer.invoke('seisconv:semblance', opts),
  /** Spectrum Analysis: mean amplitude spectrum over the open file (or the
   *  [traceStart,traceEnd) trace window). Trace count is decimated when huge. */
  avgSpectrum: (opts?: { traceStart?: number; traceEnd?: number }): Promise<AvgSpectrumData> => ipcRenderer.invoke('seisconv:avgSpectrum', opts ?? {}),
  /** Spectrum Analysis: STFT spectrogram of trace `index` (winLen samples, hop =
   *  winLen/2 by default). Returns a row-major nFrames×nBins magnitude grid. */
  spectrogram: (opts: { index: number; winLen?: number; hop?: number }): Promise<SpectrogramData> => ipcRenderer.invoke('seisconv:spectrogram', opts),
  /** Spectrum Analysis: 2-D f-k spectrum of the section (`dx` = trace spacing,
   *  default 1). Returns a row-major nF×nKx magnitude grid, kx fftshifted. */
  fk: (opts?: { dx?: number }): Promise<FkData> => ipcRenderer.invoke('seisconv:fk', opts ?? {}),
  /** Trace-health QC: scan every trace of the open file for bad-data problems and
   *  return cached per-trace EVIDENCE + an honest coverage report. The renderer
   *  classifies/re-classifies from the evidence; `sensitivity`/`thresholds` carry the
   *  per-detector cutoffs through, and the structural knobs (window/neighbours/polarity
   *  caps) tune the scan. `maxTraces` caps/blocks huge surveys. */
  traceHealth: (opts?: {
    maxTraces?: number;
    sensitivity?: Record<string, 'low' | 'med' | 'high'>;
    thresholds?: Record<string, number>;
    localWindow?: number;
    neighbors?: number;
    polarity?: boolean;
    polarityMax?: number;
    specMax?: number;
  }): Promise<TraceHealthData> => ipcRenderer.invoke('seisconv:traceHealth', opts ?? {}),
  /** File Viewer: assisted (seeded) first-break picking. Sends the user's seed picks
   *  (≥2, keyed by absolute trace index) + picker tuning; the worker runs the
   *  moveout-guided engine on REAL adjacent traces and returns one pick per trace
   *  keyed by absolute index, plus the guide curve for the overlay. */
  firstBreaks: (opts: {
    seeds: { absIdx: number; tMs: number }[];
    traceStart?: number;
    traceEnd?: number;
    fbWindowMs?: number;
    fbPolarity?: 'peak' | 'trough' | 'zero';
    fbStaMs?: number;
    fbLtaMs?: number;
    fbThreshold?: number;
  }): Promise<FirstBreaksData> => ipcRenderer.invoke('seisconv:firstBreaks', opts),
  /** Save arbitrary text (e.g. velocity picks CSV) via a native dialog. */
  exportText: (name: string, text: string): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:exportText', { name, text }),
  /** Save arbitrary binary bytes (e.g. a renderer-built .xlsx / .ods) via a native dialog. */
  exportBinary: (name: string, bytes: Uint8Array): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:exportBinary', { name, bytes }),
  /** SURVEY-PLAN import: open a .csv/.txt/.tsv/.geojson/.json picker and return the
   *  file's RAW text plus its base name (or null if cancelled). Deliberately
   *  unparsed - the SPS Creation import wizard shows the user the real columns and
   *  lets them map those columns before anything is interpreted. Bounded at 64 MB. */
  openPlanText: (): Promise<{ name: string; text: string } | null> => ipcRenderer.invoke('seisconv:openPlanText'),
  /** Observer Log RELOAD: open a .json picker, parse it, return {meta,columns,rows} (or null). */
  openLogJson: (): Promise<LogJson | null> => ipcRenderer.invoke('seisconv:openLogJson'),
  /** Observer Log TEMPLATE import: open a .json picker, parse it, return the RAW
   *  parsed object (the renderer validates the template shape) or null if cancelled. */
  openTemplateJson: (): Promise<unknown> => ipcRenderer.invoke('seisconv:openTemplateJson'),
  /** Observer Log "Sync clock": query an SNTP server over UDP; resolves the offset
   *  (serverTimeMs - local Date.now()) or { ok:false, error }. Defaults to 'pool.ntp.org'. */
  ntpSync: (server: string): Promise<NtpSyncResult> => ipcRenderer.invoke('seisconv:ntpSync', server),
  /** Observer Log SPS-linking: flat list of the loaded survey's source records
   *  ([] when no SPS is loaded) for columns linked to an SPS source field. */
  spsSourceList: (): Promise<{ sources: SpsSourceRecord[] }> => ipcRenderer.invoke('seisconv:spsSourceList'),
  /** Current application-wide UI zoom factor (1 = 100 %); reads webFrame state. */
  getZoom: (): number => webFrame.getZoomFactor(),
  /** Set the application-wide UI zoom factor (clamped to 0.5-2.5) via webFrame. */
  setZoom: (factor: number): void => webFrame.setZoomFactor(clampZoom(factor)),
  /** Minimize the window (custom header control). */
  winMinimize: (): void => ipcRenderer.send('seisconv:win-minimize'),
  /** Toggle maximize / restore (custom header control). */
  winMaximizeToggle: (): void => ipcRenderer.send('seisconv:win-maximize-toggle'),
  /** Close the window (custom header control). */
  winClose: (): void => ipcRenderer.send('seisconv:win-close'),
  /** Subscribe to maximize-state changes so the UI can swap the maximize/restore icon; returns an unsubscribe fn. */
  onWinMaximized: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on('seisconv:win-maximized', listener);
    return () => ipcRenderer.removeListener('seisconv:win-maximized', listener);
  },
  /** Send user feedback: the main process builds a mailto: to the feedback inbox
   *  (the address lives only in main) and opens the OS default mail client. */
  sendFeedback: (args: { subject: string; body: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('seisconv:sendFeedback', args),

  // -- Observer Log "Trigger Watch" (live row on shot trigger) --
  /** Configure + (re)start the trigger sources; `null` stops everything. Main
   *  validates every field (dir exists, port range, LAN opt-in boolean). */
  triggerWatch: (cfg: TriggerWatchCfg | null): Promise<TriggerWatchResult> =>
    ipcRenderer.invoke('seisconv:triggerWatch', cfg),
  /** Folder picker for the watched acquisition folder (null when cancelled). */
  triggerPickFolder: (): Promise<string | null> => ipcRenderer.invoke('seisconv:triggerPickFolder'),
  /** File picker for the Geometrics SCS survey log (null when cancelled). */
  triggerPickLogFile: (): Promise<string | null> => ipcRenderer.invoke('seisconv:triggerPickLogFile'),
  /** Catch-up scan: shot files currently in the ACTIVE watched folder, oldest first. */
  triggerScanFolder: (): Promise<TriggerScanResult> => ipcRenderer.invoke('seisconv:triggerScanFolder'),
  /** Quick FFID/traces/ns metadata for one file inside the watched folder (the
   *  enrichment parse; never clobbers the viewer's open file). */
  triggerQuickMeta: (path: string): Promise<TriggerQuickMetaResult> =>
    ipcRenderer.invoke('seisconv:triggerQuickMeta', path),
  /** Subscribe to trigger events + source status pushes; returns an unsubscribe fn. */
  onTriggerEvent: (cb: (ev: TriggerEventMsg) => void): (() => void) => {
    const listener = (_e: unknown, ev: TriggerEventMsg) => cb(ev);
    ipcRenderer.on('seisconv:triggerEvent', listener);
    return () => ipcRenderer.removeListener('seisconv:triggerEvent', listener);
  },

  // -- WiFiSync ("Field" tab): native folder sync + discovery + hotspot --
  /** Current engine status (running / mode / server / peers). */
  fieldStatus: (): Promise<FieldStatus> => ipcRenderer.invoke('seisconv:field:status'),
  /** Load persisted WiFiSync settings (defaults when none saved). */
  fieldSettingsGet: (): Promise<FieldSettings> => ipcRenderer.invoke('seisconv:field:settingsGet'),
  /** Persist WiFiSync settings (merged over existing). */
  fieldSettingsSet: (s: Partial<FieldSettings>): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('seisconv:field:settingsSet', s),
  /** Pick the shared sync folder (null when cancelled). */
  fieldPickFolder: (): Promise<string | null> => ipcRenderer.invoke('seisconv:field:pickFolder'),
  /** List local network adapters (label/ip/broadcast) for the sync bind dropdown. */
  fieldListAdapters: (): Promise<{ ok: boolean; error?: string; adapters: FieldNetworkAdapter[] }> =>
    ipcRenderer.invoke('seisconv:field:listAdapters'),
  /** Start the engine + file server (+ discovery, or a manual peer). */
  fieldStart: (cfg: FieldStartCfg): Promise<{ ok: boolean; error?: string; serverOn: boolean; discoveryOn: boolean }> =>
    ipcRenderer.invoke('seisconv:field:start', cfg),
  /** Stop the engine, file server and discovery; clear peers. */
  fieldStop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('seisconv:field:stop'),
  /** Change the sync role live (also re-arms discovery's beacon). */
  fieldSetRole: (role: FieldRole): Promise<{ ok: boolean; role: FieldRole }> =>
    ipcRenderer.invoke('seisconv:field:setRole', role),
  /** Run one sync pass over the known peers now. */
  fieldSyncNow: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('seisconv:field:syncNow'),
  /** Manually add a peer by IP (TCP-tested first). */
  fieldConnectPeer: (ip: string, port?: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('seisconv:field:connectPeer', { ip, port }),
  /** Get the hotspot host IP (192.168.137.x, or the .1 fallback). */
  fieldHostIp: (): Promise<string> => ipcRenderer.invoke('seisconv:field:hostIp'),
  /** Read the Mobile Hotspot status (running / ssid / clients). READ-ONLY. */
  fieldHotspotStatus: (): Promise<FieldHotspotStatus> => ipcRenderer.invoke('seisconv:field:hotspotStatus'),
  /** Start the Windows Mobile Hotspot (WinRT). MUTATION - explicit user action only. */
  fieldHotspotStart: (ssid: string, pass: string, adapter?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('seisconv:field:hotspotStart', { ssid, pass, adapter }),
  /** Stop the Windows Mobile Hotspot (WinRT). MUTATION - explicit user action only. */
  fieldHotspotStop: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('seisconv:field:hotspotStop'),
  /** Open the Windows Settings › Mobile hotspot page. */
  fieldOpenHotspotSettings: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('seisconv:field:openHotspotSettings'),
  /** Load the transfer history (newest-first). */
  fieldHistoryGet: (): Promise<FieldHistoryEntry[]> => ipcRenderer.invoke('seisconv:field:historyGet'),
  /** Clear the transfer history. */
  fieldHistoryClear: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('seisconv:field:historyClear'),
  /** List WiFi adapters for the hotspot dropdown (label/name/status). READ-ONLY. */
  fieldHotspotAdapters: (): Promise<{ ok: boolean; error?: string; adapters: FieldWifiAdapter[] }> =>
    ipcRenderer.invoke('seisconv:field:hotspotAdapters'),
  /** Subnet TCP scan (X.X.X.1..254 : 47824) for other WiFiSync peers. READ-ONLY. */
  fieldScan: (selfIp: string): Promise<{ ok: boolean; error?: string; hosts: string[] }> =>
    ipcRenderer.invoke('seisconv:field:scan', { selfIp }),
  /** Open the three WiFiSync firewall rules (private profile). MUTATION - UAC. */
  fieldOpenFirewall: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('seisconv:field:openFirewall'),
  /** Reset the WiFi adapter + ICS service. MUTATION - UAC, explicit user action only. */
  fieldResetAdapter: (adapter: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('seisconv:field:resetAdapter', { adapter }),
  /** Remove the Hyper-V WiFi external switch that locks the adapter. MUTATION - UAC. */
  fieldFixHyperV: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('seisconv:field:fixHyperV'),
  /** Subscribe to WiFiSync events (log / peer / sync / file / status); returns an unsubscribe fn. */
  onFieldEvent: (cb: (ev: FieldEventMsg) => void): (() => void) => {
    const listener = (_e: unknown, ev: FieldEventMsg) => cb(ev);
    ipcRenderer.on('seisconv:fieldEvent', listener);
    return () => ipcRenderer.removeListener('seisconv:fieldEvent', listener);
  },
};

export type SeisconvAPI = typeof api;

contextBridge.exposeInMainWorld('seisconvAPI', api);
