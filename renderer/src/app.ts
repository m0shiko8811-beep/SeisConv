// SeisConv renderer - entry. Bundled by esbuild (platform=browser) to
// renderer/dist/app.js. Talks only to window.seisconvAPI (preload bridge);
// never touches Node/fs directly. Pure render helpers come from core.

import { normFactorPercentile } from '../../core/render/model';
import { getColor, colorViridis } from '../../core/render/colormaps';
import { searchEPSG, extraProjFields, type CRS } from '../../core/sps/reproject';
import { resolveCrsTagCRS } from '../../core/sps/formats/coordcsv';
import { projToLatLon, latLonToUTM, latLonToITM, geodeticToTM, type Projection } from '../../core/coords';
import { checkPlan, type PlanCheckResult } from '../../core/sps/plancheck';
import {
  sniffPlanCsv, parsePlanCsv, parsePlanGeoJson, guessCoordKind, groupPlanRows,
  buildPlanCsv, buildPlanGeoJson, buildPlanKml,
  PLAN_FIELDS, PLAN_FIELD_LABELS,
  type Delim, type PlanField, type CsvSniff, type PlanRow, type PlanExportLine,
} from '../../core/sps/formats/planio';
import { amplitudeSpectrum, fft, nextPow2 } from '../../core/dsp/fft';
import { crossCorrelate, difference } from '../../core/dsp/correlate';
import { resampleLinear } from '../../core/dsp/interpolate';
import { MANUAL } from './manual';
import {
  classifyTrace, thresholdsForSensitivity, readEvidence, DETECTOR_IDS,
  type DetectorId, type DetectorResult, type TraceFinding, type HealthThresholds, type Sensitivity,
} from '../../core/dsp/tracehealth';
import {
  generateSweep, generateSweepAtRate, validateSweepSpec, defaultSlope, klauderAnalysis, thdEstimate,
  buildSVText, DEFAULT_SWEEP_SPEC, MAX_SWEEP_SEGMENTS, SV_RATE_HZ,
  type SweepSpec, type SweepSegment, type SweepType, type SweepResult, type KlauderAnalysis,
} from '../../core/dsp/sweepgen';
import { instantaneousPhase, wrapDeg180 } from '../../core/dsp/hilbert';
import { nextSP, nextFile, renumberBelow, type SPStepCfg, type RenumRow } from '../../core/obslog/autonum';
import {
  TRIGGER_SYSTEMS, DEFAULT_TRIG_SYSTEM, resolveTrigSystem, migrateTrigSystemId,
  type TrigSystemId,
} from '../../core/obslog/trigsystems';
import { writeSEGY } from '../../core/formats/segy';
import { writeSU } from '../../core/formats/su';
import { writeCSV } from '../../core/formats/ascii';
import type { ParsedFile } from '../../core/types';
import { buildXlsx, type SheetTable } from '../../core/export/xlsx';
import { buildOds } from '../../core/export/ods';
import JSZip from 'jszip';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// Adds map rotation (setBearing/getBearing) by augmenting the global L. Imported
// for side effects only; see leaflet-rotate-init.ts for the ordering rationale.
import './leaflet-rotate-init';

type Summary = {
  path: string;
  name: string;
  format: string;
  revision: number;
  traceCount: number;
  samplesTrace: number | null;
  sampleInt: number | null;
  byteOrder: string;
  errors: string[];
  // Sibling-file navigation (open file's folder): 0-based index, total count,
  // and edge flags. Present on every open/openSiblingFile result.
  index: number;
  count: number;
  hasPrev: boolean;
  hasNext: boolean;
  // True when the worker opened this file via the bounded-memory streaming/indexed
  // SEG-Y path (multi-GB files / tape-image archives). The File Viewer then pages
  // through the traces in fixed blocks instead of fitting the whole record at once.
  streamed?: boolean;
};
type TraceData = { index: number; nSamples: number; sampleInt: number; hdr: Record<string, number | string>; samples: Float32Array };
// One trace pulled from an arbitrary file by the Trace Workbench (extractTrace):
// TraceData plus the source file name + total trace count, for labelling/clamping.
type ExtractedTrace = { name: string; index: number; traceCount: number; nSamples: number; sampleInt: number; hdr: Record<string, number | string>; samples: Float32Array };
type SectionOpts = { maxTraces?: number; maxSamples?: number; traceStart?: number; traceEnd?: number; sampStart?: number; sampEnd?: number; agc?: boolean; agcType?: 'rms' | 'median' | 'mean'; agcWindowMs?: number };
type SectionData = { numTraces: number; colLen: number; norm: number; sampleInt: number; traceStep: number; data: Float32Array; traceStart: number; traceEnd: number; sampStart: number; sampEnd: number; fullTraces: number; fullSamples: number };
// Trace-health QC scan of the open file (File Viewer). `evidence` is a row-major
// Float32 struct-of-arrays (traceIndex.length rows × evStride cols) the renderer
// re-classifies live; arrays are keyed by ABSOLUTE trace index. Mirrors preload's TraceHealthData.
type TraceHealthData = { evidence: Float32Array; evStride: number; traceIndex: Int32Array; ffid: Int32Array; channel: Int32Array; offset: Float32Array; sampleInt: number; coverage: { scanned: number; total: number; stride: number; blocks: number; polarityRan: boolean; polarityScanned: number } };
// Assisted first-break picks (File Viewer mode). One entry per REAL adjacent trace,
// keyed by ABSOLUTE index. pSource: 0 seed · 1 auto · 2 edited. Mirrors preload's FirstBreaksData.
type FirstBreaksData = { sampleInt: number; windowMs: number; hasOffsets: boolean; traceStart: number; traceEnd: number; pAbs: Int32Array; pTime: Float32Array; pSource: Int8Array; pConf: Float32Array; pDev: Float32Array; pFfid: Int32Array; pChan: Int32Array; pOff: Float32Array; gAbs: Int32Array; guide: Float32Array };
type SpsSummary = { sources: number; receivers: number; xrefs: number; layout: string | null; projection: { type: string | null; subtype: string | null; desc?: string } | null; errors: string[];
  // Distinct positioning format label(s) detected this Load (e.g. ['SPS','P1/11']) - shown in the stats bar.
  formats?: string[];
  // Brief P6/11 bin-grid summary when a grid was loaded this Load (else null/absent).
  binGrid?: { nInline: number; nCrossline: number; originE: number; originN: number; binI: number; binJ: number; inlineAzimuth: number } | null;
};

// A P6/11 acquisition bin grid in projected (E/N) space, as returned by api.binGrid().
// Mirrors core/sps/bingrid.ts BinGrid + electron/preload.ts BinGridInfo (the QC overlay
// reads origin / azimuth / bin size / node counts / optional corners).
type BinGridInfo = {
  name?: string;
  crs?: { type: string | null; subtype: string | null; desc?: string } | null;
  originE: number; originN: number;
  binI: number; binJ: number;
  nInline: number; nCrossline: number;
  inlineAzimuth: number;
  crosslineAzimuth: number;
  firstInline: number; firstCrossline: number;
  incInline: number; incCrossline: number;
  corners?: { e: number; n: number }[];
  raw: string[];
};
type SpsLines = { x: Float32Array; y: Float32Array; line: Int32Array; pt: Float32Array; names: string[] };
type SpsGeometry = { geo: boolean; src: SpsLines; rcv: SpsLines; bbox: { minX: number; maxX: number; minY: number; maxY: number } };
// Renumber spec for one category (source or receiver) in spsRenumber. Line:
// resequence sorted lines from lineStart by lineInc. Point: EITHER sequential
// (pointStart + i·pointInc per line) OR affine (new = old·pointScale + pointOffset).
type SpsLineRenumber = { lineStart?: number; lineInc?: number; pointStart?: number; pointInc?: number; pointOffset?: number; pointScale?: number };
type SpsXrefLines = { geo: boolean; sx: Float32Array; sy: Float32Array; rx: Float32Array; ry: Float32Array; shot: Int32Array; shotKeys: string[]; decimated: boolean; log: string };
type SpsFold = { nx: number; ny: number; binX: number; binY: number; originX: number; originY: number; fold: Int32Array; maxFold: number; totalMid: number; decimated: boolean; log: string };
type QCParamsUI = { srcInt?: number; rcvInt?: number; tol?: number; maxOff?: number };
type QCPoint = { rtype: 'S' | 'R'; lineName: string; point: number; easting: number; northing: number };
type QCRow = { sev: string; cat: string; msg: string; pts?: QCPoint[] };
// Geometry Integrity Suite - SEG-Y↔SPS cross-check finding + result (mirrors
// core/sps/geomcheck + the preload contract). A finding's `sample` rows carry
// SEG-Y header identifiers (ffid/channel) and/or an SPS station point number +
// offsets; only rows whose `point` resolves in the loaded geometry are clickable.
type GeomSample = { ffid?: number; channel?: number; point?: number; dx?: number; dy?: number; dist?: number };
type GeomFinding = { sev: 'error' | 'warn' | 'info'; cat: string; msg: string; count: number; sample?: GeomSample[] };
type GeomCheckResult = { traceCount: number; srcCoveragePct: number; rcvCoveragePct: number; scalarValues: number[]; matchedSrcPts: number; matchedRcv: number; findings: GeomFinding[] };
// Load geometry into SEG-Y - the WRITE counterpart of the check: how many traces
// were stamped with SPS geometry, the distinct stations + scalar written, and
// which field groups landed. Mirrors core/preload's GeomLoadSummary.
type GeomLoadSummary = { traceCount: number; matched: number; srcMatched: number; rcvMatched: number; unmatched: number; srcStations: number; rcvStations: number; coordScalar: number; fieldsWritten: string[]; errors: string[] };
// As-laid vs pre-plot delta - diff the LOADED (as-laid) survey against a
// separately picked REFERENCE (pre-plot) SPS triplet and report per-station
// skid. Mirrors core/preload's SPSDeltaResult; `note` flags a degenerate /
// numbering-mismatch comparison; `matchKey` records how stations were paired.
type StationDelta = { rtype: 'S' | 'R'; lineName: string; point: number; dE: number; dN: number; dist: number; overTol: boolean };
type DeltaCategory = { matched: number; overTol: number; maxDist: number; meanDist: number; p95Dist: number; addedInAsLaid: number; missingFromAsLaid: number; offenders: StationDelta[] };
type SPSDeltaResult = { tolM: number; sources: DeltaCategory; receivers: DeltaCategory; matchKey: 'line+point' | 'point'; note?: string };
type SPSPointDetail = {
  rtype: 'S' | 'R'; lineName: string; point: number; idx: string;
  easting: number; northing: number; elevation: number; raw: string;
  upholeMs?: number; srcType?: string; date?: string; time?: string; ffid?: number; staticMs?: number;
};
type SemblanceData = { semb: Float32Array; vels: number[]; nT: number; dt: number; siUs: number; offNote: string };
type VelPick = { v: number; tMs: number };

// -- Spectrum-analysis contract types (mirror the worker payloads) --
// Average amplitude spectrum over the record (or a trace window).
type AvgSpectrumData = { freqs: Float32Array; amp: Float32Array; nyquist: number; nTraces: number; decimated: boolean; log: string };
// STFT spectrogram of one trace: `mag` is a row-major nFrames×nBins grid.
type SpectrogramData = { mag: Float32Array; nFrames: number; nBins: number; freqs: Float32Array; times: Float32Array; maxMag: number; siUs: number };
// f-k spectrum of the section: `mag` is a row-major nF×nKx grid (kx fftshifted).
type FkData = { mag: Float32Array; nKx: number; nF: number; kAxis: Float32Array; fAxis: Float32Array; maxMag: number; decimated: boolean; log: string };

// -- Converter contract (folder-batch) types --
type ConvResult = { ok: boolean; path?: string; canceled?: boolean; error?: string };
type FolderFile = { name: string; path: string };
type PickFolderResult = { dir: string; files: FolderFile[] } | null;
// Observer Log payload restored from a saved .json (shape matches what the
// renderer writes). LogColumn / LogMeta / LogRow are defined with the rest of
// the Observer-Log state further down; type aliases are hoisted so this is fine.
type LogJson = { meta: LogMeta; columns: LogColumn[]; rows: LogRow[] };
// One source point from the loaded SPS survey, flattened for Observer-Log lookup.
// `idx` is the SPS point index field (string), other fields mirror the survey.
type SpsSourceRecord = {
  lineName: string; point: number; idx: string;
  easting: number; northing: number; elevation: number;
  upholeMs: number | null; staticMs: number | null; srcType: string | null;
};

// -- Observer Log "Trigger Watch" wire types (renderer ⇄ main) --
type TrigWatchIpcCfg = {
  folder?: { enabled: boolean; dir: string };
  udp?: { enabled: boolean; port: number; bindAll: boolean };
  serial?: { enabled: boolean; port: string; baud: number };
  scslog?: { enabled: boolean; path: string };
  scstrig?: { enabled: boolean; dir: string };
  scfiles?: { enabled: boolean; dir: string };
};
type TrigSourceStart = { on: boolean; error?: string };
type TrigWatchStartResult = { ok: boolean; folder: TrigSourceStart; udp: TrigSourceStart; serial: TrigSourceStart; scslog: TrigSourceStart; scstrig: TrigSourceStart; scfiles: TrigSourceStart };
type TrigScanFile = { name: string; path: string; mtimeMs: number; size: number };
type TrigQuickMeta = { format: string; traces: number; ns: number | null; siUs: number | null; ffid: number | null };
type TrigEventMsg =
  | { type: 'status'; source: 'folder' | 'udp' | 'serial' | 'scslog' | 'scstrig'; state: 'started' | 'stopped' | 'error'; detail?: string }
  | { type: 'trigger'; source: 'folder'; name: string; path: string; mtimeMs: number; size: number; ts: string }
  | { type: 'trigger'; source: 'udp' | 'serial'; kind: 'shot' | 'trig'; id: number | null; line: string | null; sp: number | null; ts: string; raw: string }
  | { type: 'trigger'; source: 'scslog'; shot: number; time: string; date: string }
  | { type: 'trigger'; source: 'scstrig'; ts: string }
  | { type: 'scfile'; name: string; path: string; ffid: number | null; ts: string };
// Which SPS source field an sps-role column pulls (see SpsSourceRecord).
type LogSrcField = 'lineName' | 'point' | 'easting' | 'northing' | 'elevation' | 'upholeMs' | 'staticMs' | 'srcType';
// A column's behavioural ROLE in the grid (drives the per-cell input it renders).
type LogColRole = 'plain' | 'counter' | 'time' | 'date' | 'pick' | 'sps';
type BatchSummary = {
  ok: boolean;
  total: number;
  done: number;
  failed: number;
  canceled: boolean;
  results: { name: string; ok: boolean; error?: string }[];
};
type ConvProgress = {
  index: number;
  total: number;
  file: string;
  state: 'start' | 'done' | 'error' | 'cancelled' | 'finished';
  error?: string;
};

// A worker-side long-op progress tick (file open/index build, SPS load). total>0
// ⇒ determinate; else indeterminate. Routed to the global progress bar.
type WorkerProgress = {
  type: 'progress'; op: string; done: number; total: number; label: string;
  /** Bytes pulled over the wire so far (basemap tile downloads). */
  bytes?: number;
  /** ESTIMATED total, from the average tile size so far - tile servers publish no
   *  manifest, so this is never presented as an exact figure. */
  bytesTotalEst?: number;
  bytesPerSec?: number;
  tilesFailed?: number;
  /** True once every tile has been fetched and the remaining work is local. */
  downloadDone?: boolean;
};

// The renderer is the sole owner of the `window.seisconvAPI` type. The preload
// backend implements the SAME contract (channel names + signatures) in parallel;
// declaring the shape here keeps the renderer compiling even if the backend
// types are not yet present, and documents exactly what the UI relies on.
declare global {
  interface Window {
    seisconvAPI: {
      // OS for key hints ('win32' | 'darwin' | 'linux' | …), set at preload load.
      platform: string;
      openAndParse(): Promise<Summary | null>;
      // Step ±delta through the seismic files in the open file's folder; null on a no-op.
      openSiblingFile(delta: number): Promise<Summary | null>;
      getTrace(i: number): Promise<TraceData>;
      // Trace Workbench: single-file picker (no parse) → chosen path or null.
      pickTraceFile(): Promise<string | null>;
      // Trace Workbench: parse `path` locally and pull ONE trace + source meta.
      extractTrace(path: string, index: number): Promise<ExtractedTrace>;
      getSection(o?: SectionOpts): Promise<SectionData>;
      // Single-file conversion of the currently-open file (save dialog).
      // `outBaseName` (no extension) becomes the dialog's default file name.
      convertSingle(format: string, outBaseName?: string): Promise<ConvResult>;
      // Trace Workbench EXPORT: write the collected traces out as a seismic file
      // in `format` (save dialog). `sampleInt` (µs) stamps the synthetic file;
      // `baseName` (no extension) seeds the dialog's default name.
      convertTraces(args: { traces: { samples: Float32Array; nSamples: number; sampleInt?: number }[]; sampleInt?: number; format: string; baseName?: string }): Promise<ConvResult>;
      // Folder picker → enumerated seismic files; null if cancelled / none.
      pickInputFolder(): Promise<PickFolderResult>;
      // Destination-folder picker; null if cancelled.
      pickOutputFolder(): Promise<string | null>;
      // Batch-convert a set of files into outDir, emitting per-file progress.
      // Names each output via `nameTemplate` ({name}/{custom}/{fmt}/{date}/{time}/
      // {seq3}/{n}) with `dateStr`, `custom` + `time` supplied once for the run.
      batchConvert(opts: { files: FolderFile[]; format: string; outDir: string; nameTemplate?: string; dateStr?: string; custom?: string; time?: string }): Promise<BatchSummary>;
      // Subscribe to per-file conversion progress; returns an unsubscribe fn.
      onConvertProgress(cb: (p: ConvProgress) => void): () => void;
      // Subscribe to worker-side long-op progress (file open/index, SPS load).
      onWorkerProgress(cb: (p: WorkerProgress) => void): () => void;
      // Signal a running batch to stop.
      cancelConvert(): void;
      // Open the last conversion OUTPUT in the OS file explorer: 'single' reveals +
      // selects the saved file, 'batch' opens the batch/combine destination folder.
      openOutputFolder(which: 'single' | 'batch'): Promise<{ ok: boolean; error?: string }>;
      // Clear the open file + cached state in the worker.
      resetState(): Promise<void>;
      openSPS(): Promise<SpsSummary | null>;
      // Clear ONLY the loaded SPS survey in the worker (keeps any open seismic file).
      spsClear(): Promise<void>;
      // The loaded P6/11 acquisition bin grid (or null when no bin-grid file is loaded).
      binGrid(): Promise<BinGridInfo | null>;
      spsGeometry(geo: boolean): Promise<SpsGeometry>;
      spsXrefLines(geo: boolean): Promise<SpsXrefLines>;
      spsFold(opts: { binX: number; binY: number }): Promise<SpsFold>;
      spsQC(qc?: QCParamsUI): Promise<QCRow[]>;
      // Geometry Integrity Suite - cross-check the open SEG-Y's trace-header
      // geometry against the loaded SPS survey. Resolves, never rejects: ok:false
      // + error on the not-ready cases ('load a SEG-Y / seismic file first' /
      // 'load an SPS first'). tolM = station-match tolerance in metres (default 2).
      spsGeomCheck(opts?: { tolM?: number }): Promise<{ ok: boolean; result?: GeomCheckResult; error?: string }>;
      // Load geometry into SEG-Y - stamp the loaded SPS survey's coordinates into
      // the open SEG-Y's trace headers and save a geometry-loaded SEG-Y. Resolves,
      // never rejects: ok:false + error on the not-ready cases ('load a SEG-Y file
      // first' / 'load an SPS first'); `summary` present even when the Save dialog
      // is dismissed (canceled:true); `savedPath` set only when Save completed.
      spsGeomLoad(opts?: { tolM?: number; coordScalar?: number; writeCoords?: boolean; writeElev?: boolean; writeOffset?: boolean; writeCdp?: boolean }): Promise<{ ok: boolean; summary?: GeomLoadSummary; savedPath?: string; canceled?: boolean; error?: string }>;
      // As-laid vs pre-plot delta - diff the LOADED survey against a separately
      // picked REFERENCE SPS triplet. Calling this makes MAIN open a native
      // multi-select dialog for the reference .s/.r/.x. Resolves, never rejects:
      // ok:false + error on the not-ready case ('load the survey (SPS) first'),
      // canceled:true if the dialog is dismissed. tolM = over-tolerance flag
      // distance (metres, default 1); `refName` labels the chosen reference.
      spsDelta(opts?: { tolM?: number }): Promise<{ ok: boolean; result?: SPSDeltaResult; error?: string; canceled?: boolean; refName?: string }>;
      spsPointDetail(args: { rtype: 'S' | 'R'; lineName: string; point: number; idx?: string }): Promise<SPSPointDetail | null>;
      spsReproject(code: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      // SPS Header Viewer/Editor - list the shared H block (each row code · value ·
      // raw · human description) + the parsed projection + the loaded files.
      // filesDiffer flags that the loaded files' H blocks are not identical.
      spsHeaderList(): Promise<{
        ok: boolean;
        headers: { code: string; val: string; raw: string; desc: string }[];
        projection: {
          type: string | null; subtype: string | null; zone: number | null; hemi: string | null;
          datum: string | null; ellipsoid: string | null; units: string;
          centralMeridian: number | null; latOrigin: number | null;
          falseEasting: number | null; falseNorthing: number | null; scaleFactor: number | null;
          desc?: string;
        } | null;
        files: { name: string; type: string }[];
        filesDiffer: boolean;
      }>;
      // Apply header edits/adds/removes (+ an optional CRS regeneration) to a scope
      // ('shared' = every loaded SPS file, else the named file). Header-only - never
      // touches S/R coordinate lines. Returns the refreshed header list.
      spsApplyHeaders(req: {
        scope: 'shared' | string;
        edits: { code: string; val: string; oldVal?: string }[];
        adds: { code: string; desc?: string; val: string }[];
        removes: (string | { code: string; oldVal?: string })[];
        crs?: {
          datum?: string; projType?: string; zone?: number; hemi?: 'N' | 'S'; units?: string;
          centralMeridian?: number; latOrigin?: number; falseEasting?: number;
          falseNorthing?: number; scaleFactor?: number;
        };
      }): Promise<{ ok: boolean; headers: { code: string; val: string; raw: string; desc: string }[]; error?: string }>;
      // Save the current (edited) SPS files to disk as a .zip (reuses the reproject ZIP save flow).
      spsSaveCorrected(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      // Re-create / Renumber: rewrite the loaded survey's source/receiver line +
      // point numbers (at least one category required), then save via the same Save
      // dialog. On ok the worker already holds the renumbered survey; `summary`
      // mirrors openSPS. `savedPath` is set only when the Save dialog completed;
      // `canceled` true means the survey is renumbered-but-not-exported.
      spsRenumber(req: { spec: { source?: SpsLineRenumber; receiver?: SpsLineRenumber }; baseName?: string }): Promise<{ ok: boolean; summary?: SpsSummary; savedPath?: string; canceled?: boolean; error?: string }>;
      // SPS GENERATOR (Feature B): build a fresh survey from one polyline per
      // acquisition line (WGS84 lat/lon picks, forward-projected into `crs`), then
      // save via the Save dialog. On ok the worker already holds the generated
      // survey; `summary` mirrors openSPS, `savedPath` is set only when the Save
      // dialog completed, `canceled` is true when it was dismissed (still loaded).
      spsCreate(req: {
        crs: {
          datum?: string; projType?: string; zone?: number; hemi?: 'N' | 'S'; units?: string;
          centralMeridian?: number; latOrigin?: number; falseEasting?: number;
          falseNorthing?: number; scaleFactor?: number;
        };
        baseName?: string;
        // Lines to be WALKED at the acquisition interval (the click-to-pick case).
        picks: { vertices: { lat: number; lon: number }[] }[];
        // Lines whose stations are used VERBATIM (the import case): each station
        // keeps its number, and its original projected e/n when it has one. At
        // least one of picks / preplots must be non-empty.
        preplots?: {
          lineName: string;
          role: 'R' | 'S' | 'SR';
          stations: { lat: number; lon: number; point: number; elev?: number; e?: number; n?: number }[];
        }[];
        mode?: '2D' | '3D';
        rcvInterval?: number; srcInterval?: number;
        rcvLineStart?: number; rcvLineInc?: number; rcvPointStart?: number; rcvPointInc?: number;
        srcLineStart?: number; srcLineInc?: number; srcPointStart?: number; srcPointInc?: number;
        // 3D only: source-line spacing (SLI) + optional receiver-line bearing override.
        srcLineSpacing?: number; azimuthDeg?: number;
        relation?: { type: 'full' | 'split'; channels?: number; patchLines?: number };
        srcType?: string; rcvType?: string;
      }): Promise<{ ok: boolean; summary?: SpsSummary; savedPath?: string; canceled?: boolean; error?: string }>;
      spsExport(args: { kind: 'kml' | 'geojson' | 'csv' | 'qcreport' | 'p111' | 'coordcsv' | 'segp1' | 'sps' | 'segp1'; qcParams?: QCParamsUI }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      /** ESRI Shapefile export (source + receiver point layers, one ZIP). `code`
       *  is an EPSG code to reproject to; omit for the survey's native CRS. */
      spsShapefile(args: { code?: string; baseName?: string }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string; notes?: string[] }>;
      /** Search the full offline EPSG registry held in the main process. */
      /** Export the survey as GeoTIFF rasters over a dragged map area. */
      spsRaster(args: {
        bounds?: { south: number; west: number; north: number; east: number } | null;
        whole?: boolean;
        marginM?: number;
        pixelSize: number;
        layers: ('fold' | 'elevation' | 'layout')[];
        basemap?: string;
        code?: string;
        demRadius?: number;
        baseName?: string;
      }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string; notes?: string[] }>;
      epsgSearch(args: { query?: string; limit?: number; supportedOnly?: boolean }): Promise<{
        total: number;
        rows: { code: string; name: string; method: string; units: string; deprecated: boolean; supported: boolean; reason?: string }[];
      }>;
      semblance(opts: { velMin: number; velMax: number; velStep: number }): Promise<SemblanceData>;
      // -- Spectrum-analysis tab --
      // Mean amplitude spectrum of the open file (or a [traceStart,traceEnd) window).
      avgSpectrum(opts?: { traceStart?: number; traceEnd?: number }): Promise<AvgSpectrumData>;
      // STFT spectrogram of trace `index` (winLen samples; hop defaults to winLen/2).
      spectrogram(opts: { index: number; winLen?: number; hop?: number }): Promise<SpectrogramData>;
      // 2-D f-k spectrum of the whole section (dx = trace spacing, default 1).
      fk(opts?: { dx?: number }): Promise<FkData>;
      // File-Viewer trace-health QC: scan the open file's traces and return cached
      // per-trace EVIDENCE (a flat struct-of-arrays) + an honest coverage report; the
      // renderer classifies/re-classifies from the evidence as sensitivity changes.
      traceHealth(opts?: {
        maxTraces?: number;
        sensitivity?: Record<string, 'low' | 'med' | 'high'>;
        thresholds?: Record<string, number>;
        localWindow?: number; neighbors?: number; polarity?: boolean; polarityMax?: number; specMax?: number;
      }): Promise<TraceHealthData>;
      // File-Viewer first-breaks mode: assisted (seeded) picking. Sends the user's
      // seed picks (≥2) + picker tuning; returns one pick per real trace + the guide.
      firstBreaks(opts: {
        seeds: { absIdx: number; tMs: number }[];
        traceStart?: number; traceEnd?: number;
        fbWindowMs?: number; fbPolarity?: 'peak' | 'trough' | 'zero';
        fbStaMs?: number; fbLtaMs?: number; fbThreshold?: number;
      }): Promise<FirstBreaksData>;
      exportText(name: string, text: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      // Save arbitrary binary bytes (renderer-built .xlsx / .ods) via a save dialog.
      exportBinary(name: string, bytes: Uint8Array): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      // SURVEY-PLAN import: open a .csv/.txt/.tsv/.geojson/.json picker → the file's
      // RAW text + base name, or null if cancelled. Unparsed on purpose: the SPS
      // Creation wizard maps the real columns before anything is interpreted.
      openPlanText(): Promise<{ name: string; text: string } | null>;
      // Observer Log RELOAD: open a .json picker → {meta,columns,rows}, or null if cancelled.
      openLogJson(): Promise<LogJson | null>;
      // Observer Log TEMPLATE import: open a .json picker → the RAW parsed object
      // (renderer validates the template shape), or null if cancelled.
      openTemplateJson(): Promise<unknown>;
      // Observer Log TIME SOURCE: query an SNTP server (UDP/123) → clock offset.
      // offsetMs = serverTimeMs - Date.now(); applied to the 'Now' time stamps.
      ntpSync(server: string): Promise<{ ok: boolean; offsetMs?: number; serverTimeMs?: number; error?: string }>;
      // Observer Log SPS LINK: flat list of the loaded SPS survey's source points,
      // for sps-role columns to look up by line/point. [] when no SPS is loaded.
      spsSourceList(): Promise<{ sources: SpsSourceRecord[] }>;
      // App-wide UI zoom (whole interface), backed by Electron's webFrame.
      getZoom(): number;
      setZoom(factor: number): void;
      // Custom window controls - the frameless window draws its own min/max/close.
      winMinimize(): void;
      winMaximizeToggle(): void;
      winClose(): void;
      onWinMaximized(cb: (maximized: boolean) => void): () => void;
      // Send Feedback: composes a mailto: in the main process (the feedback inbox
      // lives there) and opens the OS default mail client via shell.openExternal.
      sendFeedback(args: { subject: string; body: string }): Promise<{ ok: boolean; error?: string }>;
      // -- Observer Log "Trigger Watch" (live row on shot trigger) --
      triggerWatch(cfg: TrigWatchIpcCfg | null): Promise<TrigWatchStartResult>;
      triggerPickFolder(): Promise<string | null>;
      triggerPickLogFile(): Promise<string | null>;
      triggerScanFolder(): Promise<{ ok: boolean; error?: string; files: TrigScanFile[] }>;
      triggerQuickMeta(path: string): Promise<{ ok: boolean; error?: string; meta?: TrigQuickMeta }>;
      onTriggerEvent(cb: (ev: TrigEventMsg) => void): () => void;
      // -- WiFiSync ("Field" tab): native folder sync + discovery + hotspot --
      fieldStatus(): Promise<FieldStatus>;
      fieldSettingsGet(): Promise<FieldSettings>;
      fieldSettingsSet(s: Partial<FieldSettings>): Promise<{ ok: boolean; error?: string }>;
      fieldPickFolder(): Promise<string | null>;
      fieldListAdapters(): Promise<{ ok: boolean; error?: string; adapters: FieldNetAdapter[] }>;
      fieldStart(cfg: FieldStartCfg): Promise<{ ok: boolean; error?: string; serverOn: boolean; discoveryOn: boolean }>;
      fieldStop(): Promise<{ ok: boolean }>;
      fieldSetRole(role: FieldRole): Promise<{ ok: boolean; role: FieldRole }>;
      fieldSyncNow(): Promise<{ ok: boolean; detail: string }>;
      fieldTrustPeer(ip: string, trusted: boolean): Promise<{ ok: boolean; error?: string }>;
      fieldSetAllowRemoteDelete(on: boolean): Promise<{ ok: boolean }>;
      fieldConnectPeer(ip: string, port?: number): Promise<{ ok: boolean; error?: string }>;
      fieldHostIp(): Promise<string>;
      fieldHotspotStatus(): Promise<FieldHotspotStatus>;
      fieldHotspotStart(ssid: string, pass: string, adapter?: string): Promise<{ ok: boolean; error?: string }>;
      fieldHotspotStop(): Promise<{ ok: boolean; error?: string }>;
      fieldOpenHotspotSettings(): Promise<{ ok: boolean; error?: string }>;
      fieldHistoryGet(): Promise<FieldHistoryEntry[]>;
      fieldHistoryClear(): Promise<{ ok: boolean }>;
      fieldHotspotAdapters(): Promise<{ ok: boolean; error?: string; adapters: FieldWifiAdapter[] }>;
      fieldScan(selfIp: string): Promise<{ ok: boolean; error?: string; hosts: string[] }>;
      fieldOpenFirewall(): Promise<{ ok: boolean; error?: string }>;
      fieldResetAdapter(adapter: string): Promise<{ ok: boolean; error?: string }>;
      fieldFixHyperV(): Promise<{ ok: boolean; error?: string }>;
      onFieldEvent(cb: (ev: FieldEventMsg) => void): () => void;
    };
  }
}
// -- WiFiSync ("Field" tab) renderer-side types --
type FieldRole = 'both' | 'master' | 'slave';
interface FieldSettings {
  folder: string; adapter: string; manual_ip: string;
  hs_ssid: string; hs_pass: string; role: FieldRole;
  sync_mode: 'on_change' | 'interval'; sync_interval: string;
  throttle_enabled: boolean; throttle_kbps: string;
  trusted_peers?: string[]; allow_remote_delete?: boolean;
}
interface FieldStartCfg {
  folder: string; role: FieldRole; watchMode: 'on_change' | 'interval';
  syncInterval: number; maxKbps: number; bindIp: string; broadcastAddr: string; manualIp: string;
}
interface FieldPeerInfo { ip: string; port: number; role: FieldRole; trusted?: boolean }
interface FieldStatus {
  running: boolean; mode: FieldRole; serverOn: boolean; discoveryOn: boolean;
  manual: boolean; folder: string; peers: FieldPeerInfo[];
  pending?: FieldPeerInfo[]; allowRemoteDelete?: boolean;
}
interface FieldNetAdapter { label: string; ip: string; broadcast: string }
interface FieldHistoryEntry { timestamp: number; filename: string; action: 'pulled' | 'deleted'; peer_ip: string; size_bytes: number }
interface FieldHotspotStatus { running: boolean; ssid: string; clients: number }
interface FieldWifiAdapter { label: string; name: string; status: string }
type FieldEventMsg =
  | { type: 'log'; msg: string; ts: string }
  | { type: 'peer'; action: 'found' | 'lost' | 'pending'; ip: string; port?: number; role?: FieldRole; trusted?: boolean }
  | { type: 'sync'; ok: boolean; detail: string }
  | { type: 'file'; kind: 'pulled' | 'deleted'; relPath: string; peerIp: string; size: number }
  | { type: 'status'; running: boolean; mode: FieldRole; serverOn: boolean; discoveryOn: boolean; manual: boolean; folder: string; peers: FieldPeerInfo[]; pending?: FieldPeerInfo[]; allowRemoteDelete?: boolean }
  | { type: 'negotiated'; role: FieldRole; peerRole: FieldRole }
  | { type: 'renegotiable' };
const api = window.seisconvAPI;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
/** Optional lookup - returns null instead of throwing when an id is absent. */
const $opt = (id: string) => document.getElementById(id);

// -- Theme (GUI C: light default + working dark toggle, persisted) --
type Theme = 'light' | 'dark';
function applyTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
  $opt('themeLight')?.classList.toggle('on', t === 'light');
  $opt('themeDark')?.classList.toggle('on', t === 'dark');
  try { localStorage.setItem('seisconv.theme', t); } catch { /* ignore */ }
  // Plot canvases keep their dark scientific background in both themes, so
  // re-draw whatever is visible to refresh chrome-derived colors if needed.
  if (lastTrace && $opt('panel-trace')?.style.display !== 'none') renderTrace();
  if (lastSection && $opt('panel-section')?.style.display !== 'none') redrawSection();
}
function initTheme() {
  let t: Theme = 'light';
  try { const s = localStorage.getItem('seisconv.theme'); if (s === 'dark' || s === 'light') t = s; } catch { /* ignore */ }
  applyTheme(t);
  $opt('themeLight')?.addEventListener('click', () => applyTheme('light'));
  $opt('themeDark')?.addEventListener('click', () => applyTheme('dark'));
}

// -- App-wide UI zoom (whole interface, like a browser's Ctrl +/- / Ctrl 0) --
// Backed by Electron's webFrame (exposed through the preload bridge). The factor
// is clamped to 0.5-2.5 in ~0.1 steps, persisted in localStorage, applied on
// init, and mirrored into the status-bar "UI size" group ([-] slider [+] 100%).
// The slider and the buttons are ONE mechanism: both route through applyZoom.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;
const ZOOM_KEY = 'seisconv.zoom';
let zoomFactor = 1;

/** Clamp to range and round to a clean 0.1 step (avoids float drift like 1.0000001). */
function clampZoom(f: number): number {
  if (!Number.isFinite(f)) return 1;
  const stepped = Math.round(f / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(stepped * 100) / 100));
}

/** Apply a zoom factor everywhere: webFrame, persisted store, and the status-bar control. */
function applyZoom(f: number) {
  zoomFactor = clampZoom(f);
  try { api?.setZoom?.(zoomFactor); } catch { /* ignore */ }
  try { localStorage.setItem(ZOOM_KEY, String(zoomFactor)); } catch { /* ignore */ }
  const pct = $opt('zoomPct');
  if (pct) pct.textContent = `${Math.round(zoomFactor * 100)}%`;
  // The status-bar slider is the same control in bar form - keep it in step whether
  // the change came from the slider, the +/- buttons, or a Ctrl shortcut.
  const range = $opt('zoomRange') as HTMLInputElement | null;
  if (range) range.value = String(Math.round(zoomFactor * 100));
}
/** Nudge the zoom by N steps (sign = direction). */
function zoomBy(steps: number) { applyZoom(zoomFactor + steps * ZOOM_STEP); }
function zoomReset() { applyZoom(1); }

function initZoom() {
  let f = 1;
  try { const s = localStorage.getItem(ZOOM_KEY); if (s != null) f = parseFloat(s); } catch { /* ignore */ }
  applyZoom(f); // clamps, pushes to webFrame, paints the control
  $opt('zoomIn')?.addEventListener('click', () => zoomBy(1));
  $opt('zoomOut')?.addEventListener('click', () => zoomBy(-1));
  $opt('zoomPct')?.addEventListener('click', () => zoomReset());
  $opt('zoomRange')?.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    applyZoom(v / 100);
  });
}

// -- Help / Manual modal (context-sensitive) --
// The topic content itself lives in ./manual.ts, which is ALSO the source MANUAL.md
// is generated from (npm run gen:manual). Only the rendering lives here.
/** Render the in-modal nav + the selected topic's content. */
function renderManual(key: string) {
  const nav = $opt('manualNav');
  const content = $opt('manualContent');
  if (!nav || !content) return;
  if (!MANUAL[key]) key = 'general';

  // Order of topics in the nav: General first, then tabs in app order.
  const order = ['general', ...TABS];

  // Nav buttons (active topic highlighted).
  nav.innerHTML = '';
  for (const k of order) {
    const t = MANUAL[k];
    if (!t) continue;
    const b = document.createElement('button');
    b.className = 'hn-item' + (k === key ? ' on' : '');
    b.type = 'button';
    b.textContent = t.title;
    b.addEventListener('click', () => renderManual(k));
    nav.appendChild(b);
  }

  // Topic content. Order: what → Controls → extra sections → How to use it →
  // Tips → Good to know. The optional blocks render only when present, so legacy
  // topics (controls + steps only) are unchanged.
  const t = MANUAL[key];
  const sectionsHtml = (t.sections ?? [])
    .map((sec) => {
      const tag = sec.ordered ? 'ol' : 'ul';
      return `<h4>${sec.h}</h4><${tag}>${sec.items.map((it) => `<li class="hc-ctl">${it}</li>`).join('')}</${tag}>`;
    })
    .join('');
  const tipsHtml = t.tips && t.tips.length
    ? `<h4>Tips</h4><ul class="hc-tips">${t.tips.map((s) => `<li>${s}</li>`).join('')}</ul>`
    : '';
  const notesHtml = t.notes && t.notes.length
    ? `<h4>Good to know</h4><ul class="hc-notes">${t.notes.map((s) => `<li>${s}</li>`).join('')}</ul>`
    : '';
  content.innerHTML =
    `<h3>${t.title}</h3>` +
    `<p class="hc-what">${t.what}</p>` +
    `<h4>Controls</h4><ul>${t.controls.map((c) => `<li class="hc-ctl">${c}</li>`).join('')}</ul>` +
    sectionsHtml +
    `<h4>How to use it</h4><ol>${t.steps.map((s) => `<li>${s}</li>`).join('')}</ol>` +
    tipsHtml +
    notesHtml;
  content.scrollTop = 0;
  // Re-apply OS-aware key glyphs to any .kbd[data-key] we just injected.
  applyKeyHints();
}

function openManual() {
  // Always open to the currently active tab's help.
  renderManual(activeTab);
  $opt('manualBack')?.classList.add('open');
  // renderManual's scrollTop reset is a no-op while the modal is still hidden (an
  // unrendered element has no scrollbox), so the pane came back at wherever it was
  // left last time - mid-topic, with the heading scrolled off. Reset it again now
  // that it is visible, so every open starts at the top of the topic.
  const mc = $opt('manualContent');
  if (mc) mc.scrollTop = 0;
}
function closeManual() { $opt('manualBack')?.classList.remove('open'); }
function manualOpen(): boolean { return !!$opt('manualBack')?.classList.contains('open'); }

// -- Send Feedback -----------------------------------------------------------
// App version: SINGLE SOURCE OF TRUTH is package.json ("version"). The renderer
// build (npm run build:renderer) injects it with esbuild --define:__APP_VERSION__,
// so it can never drift; the literal below is only the fallback for a bundle built
// without that define. The feedback inbox address lives ONLY in electron/main.ts
// (FEEDBACK_EMAIL) - the renderer just composes the subject + body and hands them
// to the main process to open via mailto:.
declare const __APP_VERSION__: string;
const APP_VERSION = (typeof __APP_VERSION__ === 'string' && __APP_VERSION__) ? __APP_VERSION__ : '0.7.10';
function feedbackOpen(): boolean { return !!$opt('feedbackBack')?.classList.contains('open'); }
function openFeedback() {
  setStatus('feedbackStatus', '');
  $opt('feedbackBack')?.classList.add('open');
  ($opt('feedbackMsg') as HTMLTextAreaElement | null)?.focus();
}
function closeFeedback() { $opt('feedbackBack')?.classList.remove('open'); }
/** Compose the feedback subject + body (the user's message + a short footer with
 *  the app version and OS/platform). Returns null when the message is empty. */
function composeFeedback(): { subject: string; body: string } | null {
  const cat = ($opt('feedbackCategory') as HTMLSelectElement | null)?.value || 'Other';
  const msg = (($opt('feedbackMsg') as HTMLTextAreaElement | null)?.value || '').trim();
  if (!msg) return null;
  return {
    subject: `SeisConv feedback - ${cat}`,
    body: `${msg}\n\n-\nSeisConv ${APP_VERSION} · ${api.platform}`,
  };
}
/** Send: open the OS default mail app (via main → shell.openExternal) with the
 *  message pre-filled, toast, then close + clear. */
async function sendFeedback() {
  const c = composeFeedback();
  if (!c) { setStatus('feedbackStatus', 'Enter a message first.', 'err'); return; }
  try {
    const r = await api.sendFeedback(c);
    if (r.ok) infoToast('Opened your mail app - pick one to send.');
    else infoToast('Could not open a mail app - use Copy to clipboard.');
  } catch {
    infoToast('Could not open a mail app - use Copy to clipboard.');
  }
  closeFeedback();
  const ta = $opt('feedbackMsg') as HTMLTextAreaElement | null;
  if (ta) ta.value = '';
}
/** Fallback when no mail client is configured: copy the composed message. */
async function copyFeedback() {
  const c = composeFeedback();
  if (!c) { setStatus('feedbackStatus', 'Enter a message first.', 'err'); return; }
  try {
    await navigator.clipboard?.writeText(`${c.subject}\n\n${c.body}`);
    infoToast('Feedback copied to clipboard.');
  } catch {
    setStatus('feedbackStatus', 'Copy failed - select the text manually.', 'err');
  }
}

/** Replace every hard-coded key glyph with an OS-aware label (Ctrl on win32, Cmd on darwin). */
function applyKeyHints() {
  // bottom tip line on the Converter
  const tip = $opt('convTip');
  if (tip) {
    tip.innerHTML =
      `Tip - <span class="kbd">${KEY_OPEN}</span> open · ` +
      `<span class="kbd">${KEY_BATCH}</span> batch · ` +
      `<span class="kbd">${TAB_KEY_RANGE}</span> switch tabs · ` +
      `<span class="kbd">${KEY_OBSLOG}</span> observer log · ` +
      `<span class="kbd">?</span> help.`;
  }
  // rail + header tooltips
  $opt('railHelp')?.setAttribute('title', `Help / Manual - keys: ${KEY_OPEN} open · ${KEY_BATCH} batch · ${TAB_KEY_RANGE} tabs · ${KEY_OBSLOG} observer log · ? help`);
  // in-manual key chips that carry a data-key marker
  document.querySelectorAll<HTMLElement>('.kbd[data-key]').forEach((el) => {
    const k = el.getAttribute('data-key');
    if (k === 'open') el.textContent = KEY_OPEN;
    else if (k === 'batch') el.textContent = KEY_BATCH;
    else if (k === 'tabs') el.textContent = TAB_KEY_RANGE;
    else if (k === 'obslog') el.textContent = KEY_OBSLOG;
    else if (k === 'help') el.textContent = '?';
  });
}

// Tab chrome metadata (title + breadcrumb + description in the tab header).
const TAB_META: Record<string, { title: string; desc: string }> = {
  conv: { title: 'Converter', desc: 'Read SEG-Y · SEG-D · SEG-2 / .dat · SU off the UI thread, then export to any supported format.' },
  trace: { title: 'Trace Inspector', desc: 'Step through individual traces; inspect the waveform or amplitude spectrum.' },
  section: { title: 'File Viewer', desc: 'Render the full record as a variable-density / wiggle section with gain and AGC.' },
  sps: { title: 'SPS', desc: 'Plot source/receiver geometry on a survey grid or real basemap; QC and reproject. Reads SPS, SEG-P1, IOGP P1/11, P6/11, coord-CSV.' },
  spscreate: { title: 'SPS Creation', desc: 'Design a survey plan - draw acquisition lines on a basemap or import a preplot from CSV / GeoJSON - edit and check it, then generate a fresh SPS survey (sources · receivers · cross-references) from it.' },
  geomqc: { title: 'Geometry QC', desc: 'Cross-check the open seismic file\'s trace-header geometry against the loaded SPS, and diff an as-laid survey against a pre-plot reference. Clickable findings ring the station on the SPS map.' },
  vel: { title: 'Velocity', desc: 'Compute an NMO semblance panel and pick a stacking-velocity function.' },
  spectrum: { title: 'Spectrum', desc: 'Amplitude spectrum · spectrogram · F-K analysis' },
  workbench: { title: 'Trace Workbench', desc: 'Collect individual traces from any file and compare them side-by-side or overlaid, zoomed in lock-step.' },
  obslog: { title: 'Observer Log', desc: 'Per-shot field log; wizard-configured, exportable to Excel.' },
  sweeps: { title: 'Sweeps', desc: 'Design vibroseis pilot sweeps (linear · dB/Hz · dB/Octave · T-Power · segmented), export the pilot / SCIO .SV / sweep sheet, and QC a measured sweep against the design.' },
  field: { title: 'WiFiSync', desc: 'Peer-to-peer folder sync over WiFi - no router, no cloud. Pick a shared folder, discover a peer (or host a hotspot), and keep both machines mirror-identical in the field.' },
};

let summary: Summary | null = null;
let traceIndex = 0;
let lastTrace: TraceData | null = null;
let traceMode: 'wave' | 'spectrum' = 'wave';
// Trace Inspector time-axis zoom: the visible sample window [s0,s1) (end
// exclusive) within the FULL trace, which is already in lastTrace.samples - so
// zoom/pan is renderer-only (no worker fetch). `fullS` caches the trace length
// for clamping; init=false ⇒ "fit whole trace" (reset on every new trace).
const traceView = { s0: 0, s1: 0, fullS: 0, init: false };
// Manual amplitude (X-axis) override for the Trace Inspector waveform. null ⇒
// auto-normalize per the visible window (the default); when set, the wiggle maps
// [ampMin,ampMax] (raw sample units) across the plot width instead. Guarded so a
// blank/invalid box reverts to auto - never feeds NaN to the canvas.
let traceAmpRange: { min: number; max: number } | null = null;
// Whether the trace's X (time) axis is currently pinned by a manual box pair. Used
// so editing ONLY the Amp (Y) boxes leaves an existing wheel/button zoom intact -
// we refit the time axis only on the manual→auto X transition, never on an Amp edit.
let traceManualX = false;
// Manual X (time) / Y (amplitude) range control group for the Trace Inspector.
let traceAxisRange: AxisRangeHandle | null = null;
let outFormat = 'segy1';
let lastSection: SectionData | null = null;
// Section data-zoom view-state: the visible window in FULL-data indices
// (trace t0..t1, sample s0..s1, end exclusive). The worker re-decimates this
// window at full detail on every change, so zoom reveals real samples. `full*`
// caches the record extent for clamping; init=false ⇒ "fit whole record".
const secView = { t0: 0, t1: 0, s0: 0, s1: 0, fullT: 0, fullS: 0, init: false };
let secFetchPending = false; // coalesce rapid wheel/drag re-fetches
const SEC_PAGE_DEFAULT = 2000; // traces per block when the size box is blank/invalid

/** Current block size (traces/page) from the toolbar box, clamped to a sane range
 *  and to the file's trace count. Falls back to SEC_PAGE_DEFAULT. */
function secPageSize(): number {
  const fullT = secView.fullT || summary?.traceCount || 0;
  const raw = parseInt(($opt('secPageSize') as HTMLInputElement | null)?.value || '', 10);
  const n = Number.isFinite(raw) && raw >= 2 ? raw : SEC_PAGE_DEFAULT;
  return Math.max(2, fullT > 0 ? Math.min(n, fullT) : n);
}
// Manual X/Y range control group for the File Viewer (built once in init).
let secAxisRange: AxisRangeHandle | null = null;
// File Viewer "click-to-add" mode: when on, a (non-drag) click on the section
// canvas sends the trace under the cursor to the Trace Workbench (#secToWb toggle).
let secToWb = false;

// -- Hover read-out + box-zoom (Feature A + B) --
// Section box-zoom ("magnifier"): when armed, a drag draws a rubber-band and, on
// release, opens that trace/time region enlarged in the zoom viewer. Separate,
// explicit mode toggled by #secBoxZoom - pan/wheel zoom are untouched otherwise.
let secBoxMode = false;
let secBoxDrag: { x0: number; y0: number; x1: number; y1: number } | null = null;
// Section hover read-out async-suffix state: the base text (trace · time · amp)
// is shown immediately; the per-trace header suffix (FFID / CDP / SEG-D node) is
// fetched lazily (one in-flight, debounced) and cached by trace index.
let secHoverLastIdx = -1;
let secHoverBaseText = '';
let secHoverHdrTimer = 0;
let secHoverHdrBusy = false;
const secHoverHdrCache = new Map<number, string>();
// Trace Inspector box-zoom ("magnifier") mode + in-flight drag.
let traceBoxMode = false;
let traceBoxDrag: { x0: number; y0: number; x1: number; y1: number } | null = null;

// Zoom viewer (in-app draggable/resizable modal) - holds either a section subset
// or a single-trace region, drawn by re-using drawSection / drawTraceCore.
type ZoomTraceRegion = { t: TraceData; s0: number; s1: number; amp: { min: number; max: number } | null };
let zoomKind: 'section' | 'trace' | null = null;
let zoomSection: SectionData | null = null;
let zoomTrace: ZoomTraceRegion | null = null;
let zoomResizeObs: ResizeObserver | null = null;
// In-popup magnify state (Feature #185): `base` is the originally box-selected
// region (absolute trace/sample indices); a single zoom factor `z` (≥1, 1 = the
// selected framing) drives BOTH axes so the readout is one number, and (cx,cy) is
// the window centre as a fraction of the base span. A section re-fetches its
// sub-window at full detail (re-sampled from the traces → crisp); a single trace
// re-windows its already-loaded samples. cx is unused for a single-trace region.
const ZOOM_MAG_MIN_TR = 2, ZOOM_MAG_MIN_SAMP = 4, ZOOM_MAG_MAX = 64;
const zoomMag = { base: { t0: 0, t1: 0, s0: 0, s1: 0 }, z: 1, cx: 0.5, cy: 0.5 };
let zoomMagFetchPending = false;
let spsSummary: SpsSummary | null = null;
let spsGeom: SpsGeometry | null = null;
// X-ref spider (shot→receiver segments). Cached like spsGeom; cleared when the
// geometry space (grid E/N vs map lon/lat) changes so endpoints stay valid.
let spsSpider: SpsXrefLines | null = null;
// FOLD / coverage bin map (projected E/N). Cached and re-fetched on bin-size
// change or a new SPS load; `spsFoldBin` records the bin the cache was built for.
let spsFold: SpsFold | null = null;
let spsFoldBin = 0;
// 'srcLine|srcPt' of the shot whose fan is currently emphasized (null = none).
let highlightedShot: string | null = null;
let spsView: 'grid' | 'map' = 'grid';
const gridView = { sc: 1, ox: 0, oy: 0, init: false }; // canvas pan/zoom: x_px = ox + e*sc, y_px = oy - n*sc
let leafletMap: L.Map | null = null;
let leafletLayers: { src: L.LayerGroup; rcv: L.LayerGroup } | null = null;
// P6/11 acquisition bin grid (projected E/N), fetched lazily the first time the
// "Bin grid" toggle is turned on. null = no grid loaded / not yet fetched. It is a
// QC overlay drawn on TOP of the S/R points on both the offline grid and Leaflet.
let spsBinGrid: BinGridInfo | null = null;
// Whether we've already attempted the (single) bin-grid fetch for the current load,
// so a survey with no P6/11 grid doesn't re-query the worker on every redraw.
let spsBinGridFetched = false;
// The bin-grid frame as a live Leaflet layer (rotated outline + origin marker +
// optional inline/crossline guide lines). Torn down like leafletLayers.
let binGridLayer: L.LayerGroup | null = null;
// Highlight ring for a clicked / jumped-to point. Grid coords are in the CURRENT
// geometry space (projected E/N when geo=false, lon/lat when geo=true) so the
// ring tracks pan/zoom; null clears it. The Leaflet ring is a live map layer.
let gridHighlight: { x: number; y: number } | null = null;
let mapHighlight: L.CircleMarker | null = null;
let velResult: SemblanceData | null = null;
let velPicks: VelPick[] = [];
// Velocity manual X (velocity, m/s) / Y (time, ms) zoom window. null on an axis ⇒
// that axis auto-derives from the semblance payload (vels array / nT·dt). When set,
// drawVelocity + onVelClick map only that visible sub-range so picks stay accurate.
// Guarded (finite, lo<hi) before it is ever written - never feeds NaN to the canvas.
const velView: { v0: number | null; v1: number | null; t0: number | null; t1: number | null } =
  { v0: null, v1: null, t0: null, t1: null };
let velAxisRange: AxisRangeHandle | null = null;

// -- Spectrum-analysis tab state --
// Which of the three displays is showing, plus the most-recent payload for each
// (cached so a tab switch / resize repaints without re-fetching). `specTraceIdx`
// is the spectrogram's current trace; `specDb` toggles the Average view's axis.
type SpecDisplay = 'avg' | 'spectrogram' | 'fk';
let specDisplay: SpecDisplay = 'avg';
let specAvg: AvgSpectrumData | null = null;
let specGram: SpectrogramData | null = null;
let specFk: FkData | null = null;
let specTraceIdx = 0;
let specDb = false;
let specBusy = false;
// Set when the user switches the spectrum display (or trace) while a compute is
// in flight: the active refresher early-returns on specBusy, so the in-flight
// compute's `finally` re-dispatches refreshSpectrum() to paint the new selection
// instead of leaving the canvas on the previous image.
let specRerunPending = false;
// -- Spectrum manual range + zoom state --
// Each of the three spectrum views derives its axes straight from the payload
// arrays, so a manual window / wheel-zoom needs its OWN range state threaded into
// the draw fns. Each axis bound is null ⇒ auto (derive from the payload extent);
// a finite value ⇒ that edge is pinned. The boxes write these directly; the wheel
// zoom seeds null edges from the current auto extent, then narrows/widens within
// the data. All four guards (finite, lo<hi) are applied before any write, so the
// draw fns only ever see auto-or-ordered ranges (never NaN).
//   Avg:  X = frequency (Hz),    Y = amplitude (linear units OR dB, per specDb)
//   Gram: X = frequency (Hz),    Y = time (s)
//   F-K:  X = wavenumber (kx),   Y = frequency (Hz)
type SpecRange = { x0: number | null; x1: number | null; y0: number | null; y1: number | null };
const specAvgView: SpecRange = { x0: null, x1: null, y0: null, y1: null };
const specGramView: SpecRange = { x0: null, x1: null, y0: null, y1: null };
const specFkView: SpecRange = { x0: null, x1: null, y0: null, y1: null };
let specAvgAxis: AxisRangeHandle | null = null;
let specGramAxis: AxisRangeHandle | null = null;
let specFkAxis: AxisRangeHandle | null = null;

// -- Trace Workbench state --
// A collection of traces pulled from arbitrary files (or the open file), drawn
// side-by-side or overlaid and zoomed/panned together. Each entry owns its full
// sample buffer + a distinct colour; `wbView` is the shared time window (sample
// indices, end exclusive) spanning the longest trace, mirroring the inspector's
// traceView so all traces zoom/pan in lock-step and stay aligned.
type WbTrace = {
  id: number;
  sourceName: string;
  traceIndex: number;
  samples: Float32Array;
  sampleInt: number;
  nSamples: number;
  color: string;
};
let wbTraces: WbTrace[] = [];
let wbNextId = 1;
let wbMode: 'side' | 'overlay' = 'side';
/** Display-only polarity flip for the workbench wiggles. The collected samples
 *  are never modified - inverting is a way to compare a reversed-polarity trace
 *  against a normal one, not an edit, so anything exported stays as recorded. */
let wbInvert = false;
const wbView = { s0: 0, s1: 0, fullS: 0, init: false };
// Workbench manual X (time, ms - shared with the wbView sample window) / Y
// (amplitude, normalized fraction of the per-trace/shared swing) range boxes.
// X writes the shared wbView (like the inspector); Y pins the wiggle's amplitude
// mapping to ±wbAmp instead of the auto ±1 full-swing. null ⇒ auto. Guarded so a
// blank/invalid box reverts that axis to auto (never feeds NaN to the canvas).
let wbAmp: { min: number; max: number } | null = null;
// Whether the workbench's X (time) axis is pinned by a manual box pair. Lets an
// Amp-only edit leave the shared wbView zoom intact (refit only on manual→auto X).
let wbManualX = false;
let wbAxisRange: AxisRangeHandle | null = null;
// Distinct, theme-friendly colours cycled across collected traces.
const WB_COLORS = ['#34dbd0', '#ffb454', '#7aa2ff', '#ff6e9c', '#9be564', '#c792ea', '#f78c6c', '#56d4ff'];
// -- Workbench PREVIEW state --
// The picked file (path + total trace count) plus the currently-previewed trace,
// so the user can step through traces and SEE the signal before committing one to
// the collection. `wbPreview` is null until a file is picked / extract succeeds.
let wbPickedPath: string | null = null;
let wbPickedCount = 0;
let wbPreview: ExtractedTrace | null = null;
let wbPreviewBusy = false;

// -- Observer Log state --
// A wizard-configured, per-shot field log. `logColumns` is the live column set
// (built from the chosen groups + source type + any custom columns); `logRows`
// is one record per row keyed by column key; `logMeta` is the project header.
// All three persist to localStorage so they survive tab switches / reloads.
type LogColType = 'text' | 'number' | 'date' | 'time' | 'select';
type LogSrcType = 'explosive' | 'vibroseis' | 'nodal';
type LogColumn = {
  key: string; label: string; group: string; type: LogColType; unit?: string; options?: string[];
  // -- Observer Log v2: interactive grid by column ROLE --
  role?: LogColRole;       // how the cell behaves (counter/time/date/pick/sps/plain)
  step?: number;           // counter increment used when auto-fill is on (default 1)
  autoInc?: boolean;       // counter OPT-IN auto-increment on add-row (default OFF)
  srcField?: LogSrcField;  // for role 'sps' - which SpsSourceRecord field to pull
};
type LogMeta = Record<string, string>;
type LogRow = Record<string, string | number>;

let logMeta: LogMeta = {};
let logColumns: LogColumn[] = [];
let logRows: LogRow[] = [];
// Wizard scratch state (the in-progress configuration; committed on "Build log").
let logSrcType: LogSrcType = 'explosive';
let logCustomCols: LogColumn[] = [];           // user-defined extra columns
let logEnabledGroups: Set<string> | null = null; // which default groups are checked (null = wizard not yet primed)
const LOG_KEY = 'seisconv.obslog';

// -- Observer Log v2: time-source config --
// The 'Now' time-stamp buttons read the PC clock, optionally corrected by an NTP
// offset (offsetMs = serverTimeMs - Date.now()) when the user is in NTP mode and
// has synced. The choice + server persist alongside the log state.
type LogTimeSource = 'pc' | 'ntp';
let logTimeSource: LogTimeSource = 'pc';
let logNtpServer = 'pool.ntp.org';
let logNtpOffsetMs = 0;            // serverTimeMs - Date.now() from the last sync
let logNtpSynced = false;          // whether a successful sync has happened this session

// -- Converter (single / folder-batch) state --
type ConvMode = 'single' | 'batch';
let convMode: ConvMode = 'single';
let batchFiles: FolderFile[] = [];
let batchDir = '';
let batchOutDir = '';
let batchRunning = false;
let convProgressOff: (() => void) | null = null;
let workerProgOff: (() => void) | null = null;
// 'win32' → Windows; default to a Mac glyph hint only when actually on darwin.
const PLATFORM = (typeof api?.platform === 'string' ? api.platform : 'win32');
const IS_MAC = PLATFORM === 'darwin';
const MOD = IS_MAC ? 'Cmd' : 'Ctrl';      // primary modifier label
const KEY_OPEN = `${MOD}+O`;
const KEY_BATCH = `${MOD}+B`;

// TABS is the single source of truth for BOTH the digit shortcuts and the Help
// nav order, so it MUST match the visual order of the left icon rail in
// index.html. It used to append 'geomqc' last, which made the bare digit keys
// disagree with the rail the user is looking at ('6' opened Velocity while the
// sixth icon was Geometry QC). onKeyDown maps the bare digit keys 1..N (no
// modifier) to TABS[idx]; only nine digits exist, so the tabs past the ninth
// (Observer Log, Sweeps, WiFiSync) get no digit. switchTab iterates by name, so
// nothing else depends on this order.
const TABS = ['conv', 'trace', 'section', 'sps', 'spscreate', 'geomqc', 'vel', 'spectrum', 'workbench', 'obslog', 'sweeps', 'field'] as const;
type Tab = (typeof TABS)[number];
/** How many tabs a bare digit key can reach (only 1..9 exist as digits). */
const TAB_DIGITS = Math.min(9, TABS.length);
/** The key range shown in every hint/tooltip/Help chip - derived, never hand-typed. */
const TAB_KEY_RANGE = `1-${TAB_DIGITS}`;
// Aligning the digits with the rail pushed Observer Log past the ninth position,
// and an observer sits in that tab for a whole production day - losing its
// one-keystroke path was not acceptable. It gets a bare letter of its own instead.
// Bare 'o' was free: the only other bare keys are Esc, '?', '[', ']' and 1-9, and
// Ctrl+O (KEY_OPEN) is a DIFFERENT chord, so the two never collide. Like the digits
// this is ignored while the user is typing in a field - see the guard in onKeyDown.
// Sweeps and WiFiSync deliberately stay click-only (see the Help): they are
// set-up / QC tools visited occasionally, not a tab anyone lives in.
const KEY_OBSLOG_TAB: Tab = 'obslog';
/** The bare letter that jumps to the Observer Log, in the case the hints show. */
const KEY_OBSLOG = 'O';

// Which tab is showing - drives the universal header "Clear" button (see
// clearActiveTab / updateHeaderClear). Kept in sync by switchTab.
let activeTab: Tab = 'conv';

function switchTab(tab: Tab) {
  // Leaving the SPS Creation tab mid-drag would strand its map with dragging
  // disabled. planDragFinish is idempotent, so this is safe on every switch.
  planDragFinish();
  activeTab = tab;
  for (const t of TABS) {
    $(`tab-${t}`).classList.toggle('on', t === tab);
    $(`panel-${t}`).style.display = t === tab ? '' : 'none';
  }
  const meta = TAB_META[tab];
  if (meta) {
    const ti = $opt('tabTitle'); if (ti) ti.textContent = meta.title;
    const de = $opt('tabDesc'); if (de) de.textContent = meta.desc;
    const cr = $opt('crumbTab'); if (cr) cr.textContent = meta.title;
  }
  // Open + Clear now live in each data tab's own top bar (the header no longer
  // carries a global pair). Keep the per-tab Clear dispatch state in sync.
  updateHeaderClear();
  if (tab === 'trace' && summary) void refreshTrace();
  if (tab === 'section' && summary) void refreshSection();
  if (tab === 'sps' && spsSummary) void refreshSps();
  if (tab === 'spscreate') {
    ensureCreateMap();
    createMap?.invalidateSize();
    planRepaintAll();
    // A plan restored from the last session is announced HERE, on first sight of
    // the tab, not at app start.
    if (planDraftPending) { planFit(); planAnnounceDraft(); }
  }
  if (tab === 'geomqc') updateGeomqcReadout();
  if (tab === 'vel' && velResult) drawVelocity();
  if (tab === 'spectrum') void refreshSpectrum();
  if (tab === 'workbench') { drawWorkbench(); wbUpdateAnalysis(); }
  if (tab === 'obslog') renderLog();
  if (tab === 'sweeps') refreshSweeps();
  if (tab === 'field') void refreshField();
}

function fmtRate(si: number | null) {
  return si != null ? `${(si / 1000).toFixed(3)} ms (${si} µs)` : '-';
}

function setStatus(id: string, msg: string, kind = '') {
  const el = $(id);
  el.textContent = msg || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/** Group-thousands integer with a thin space separator (tabular-nums friendly). */
function grp(n: number | null): string {
  if (n == null || !isFinite(n)) return '-';
  return Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
}
function setText(id: string, txt: string) { const el = $opt(id); if (el) el.textContent = txt; }

// -- Global operation progress --------------------------------------------------
// One reusable floating indicator for ANY operation that can exceed ~3s (the
// permanent ">3s shows progress" rule). DETERMINATE bar when a total is known
// (byte/N-of-M, fed by updateProgress / worker progress ticks) else an
// INDETERMINATE animated sweep; the current step is always labelled. The
// converter's own inline bar (batchProg/setBatchProgress) is the reference and is
// left intact - this is the generalized API every other long path shares.
let gProgArmed = false;            // showProgress called, not yet hidden
let gProgOn = false;               // actually revealed on screen
let gProgRevealTimer: number | null = null;
let gProgCancelFn: (() => void) | null = null;

function gProgReveal() {
  gProgRevealTimer = null;
  if (gProgArmed && !gProgOn) { gProgOn = true; $opt('gProg')?.classList.add('show'); }
}

/** Show the global progress indicator with a labelled step. Indeterminate until a
 *  total arrives. `onCancel` (where feasible) reveals a Cancel button wired to it.
 *  `delayMs` defers the reveal so sub-second ops never flash (default 350 ms); pass
 *  0 to reveal immediately (use before a BLOCKING synchronous build + nextPaint()). */
function showProgress(label: string, onCancel?: () => void, delayMs = 350) {
  gProgArmed = true;
  gProgCancelFn = onCancel ?? null;
  setText('gProgTitle', label);
  setText('gProgCount', '');
  setText('gProgSub', '');
  const fill = $opt('gProgFill') as HTMLElement | null;
  if (fill) { fill.classList.add('indet'); fill.style.width = ''; }
  const cancel = $opt('gProgCancel') as HTMLButtonElement | null;
  if (cancel) cancel.classList.toggle('hidden', !onCancel);
  if (gProgRevealTimer != null) { clearTimeout(gProgRevealTimer); gProgRevealTimer = null; }
  if (delayMs <= 0) gProgReveal();
  else gProgRevealTimer = window.setTimeout(gProgReveal, delayMs);
}

/** Update the global progress. `total>0` (+ finite done) ⇒ determinate fill +
 *  percent; otherwise stays indeterminate. Guards divide-by-zero / non-finite so no
 *  NaN width ever reaches the DOM. A flowing tick also reveals the bar immediately. */
function updateProgress(done: number, total: number, label?: string) {
  if (!gProgArmed) return;
  if (!gProgOn) gProgReveal(); // progress is flowing → this is a genuine long op
  if (label != null) setText('gProgTitle', label);
  const fill = $opt('gProgFill') as HTMLElement | null;
  if (total > 0 && Number.isFinite(done) && Number.isFinite(total)) {
    let pct = (done / total) * 100;
    if (!Number.isFinite(pct)) pct = 0;
    pct = Math.max(0, Math.min(100, pct));
    if (fill) { fill.classList.remove('indet'); fill.style.width = pct + '%'; }
    setText('gProgCount', Math.round(pct) + '%');
  } else {
    if (fill) { fill.classList.add('indet'); fill.style.width = ''; }
    setText('gProgCount', '');
  }
}

/** Bytes → a short human string. Binary units, matching how a browser reports a
 *  download; 0 renders as "0 B" rather than blank. Non-finite → ''. */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** The second line under the progress bar (byte counts, speed, per-item detail). */
function setProgressSub(text: string) {
  if (!gProgArmed) return;
  setText('gProgSub', text || '');
}

/**
 * Render a download read-out under the progress bar:
 *   `142 / 400 tiles · 6.82 MB of ~19.2 MB · 2.41 MB/s`
 *
 * The total is an ESTIMATE (average tile size so far x tile count) and is marked
 * with `~` for exactly that reason - a tile server sends no manifest, so claiming a
 * precise total would be inventing one. Once the download finishes the `~` and the
 * speed drop away, because by then the figure is measured.
 */
function progressSubFor(p: WorkerProgress): string {
  if (p.bytes == null) return '';
  const bits: string[] = [];
  if (Number.isFinite(p.total) && p.total > 0) {
    bits.push(`${grp(Math.min(p.done, p.total))} / ${grp(p.total)} tiles`);
  }
  const got = fmtBytes(p.bytes);
  const est = p.bytesTotalEst && p.bytesTotalEst > 0 ? fmtBytes(p.bytesTotalEst) : '';
  if (got && est) bits.push(p.downloadDone ? `${got}` : `${got} of ~${est}`);
  else if (got) bits.push(got);
  if (!p.downloadDone && p.bytesPerSec && p.bytesPerSec > 0) bits.push(`${fmtBytes(p.bytesPerSec)}/s`);
  if (p.tilesFailed && p.tilesFailed > 0) bits.push(`${grp(p.tilesFailed)} failed`);
  return bits.join('   ·   ');
}

/** Hide the global progress indicator + clear any Cancel/reveal-timer state. */
function hideProgress() {
  gProgArmed = false;
  gProgOn = false;
  gProgCancelFn = null;
  if (gProgRevealTimer != null) { clearTimeout(gProgRevealTimer); gProgRevealTimer = null; }
  $opt('gProg')?.classList.remove('show');
  const cancel = $opt('gProgCancel') as HTMLButtonElement | null;
  if (cancel) cancel.classList.add('hidden');
}

/** Yield twice to the compositor so a just-shown spinner actually paints BEFORE a
 *  blocking synchronous build runs on the renderer thread. */
function nextPaint(): Promise<void> {
  return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
}

/** Format a raw seismic sample value for a hover read-out. SEG-Y/SEG-D samples
 *  carry NO physical unit, so callers label this "Amplitude (sample value)".
 *  Guards non-finite to an em-dash so a NaN never reaches the read-out. */
function fmtAmpVal(v: number): string {
  if (!Number.isFinite(v)) return '-';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(2);
  return v.toPrecision(4);
}

function renderInfo() {
  if (!summary) {
    $('fileInfo').style.display = 'none';
    clearSummaryPanel();
    updateStatusStrip();
    updateHeaderClear();
    updateGlobalLoaded();    // shared seismic file gone → refresh the global readout
    return;
  }
  $('fileInfo').style.display = '';
  $('fiName').textContent = summary.name;
  $('fiBody').textContent =
    `${summary.format}${summary.revision ? ' Rev ' + summary.revision : ''} · ` +
    `${summary.traceCount} traces · ${summary.samplesTrace ?? '-'} samples · ${fmtRate(summary.sampleInt)}` +
    (summary.errors.length ? ` · ⚠ ${summary.errors.length}` : '');
  // enable controls that need a file
  ($('convertBtn') as HTMLButtonElement).disabled = !(summary.traceCount > 0);
  renderSummaryPanel();
  renderHeaderQc();
  updateStatusStrip();
  updateHeaderClear();
  updateGeomqcReadout();   // shared seismic file changed → keep the Geometry QC readout fresh
  updateGlobalLoaded();    // …and the global header "Loaded" readout
}

/** Right-rail File-summary card, populated from the openAndParse summary. */
function renderSummaryPanel() {
  if (!summary) { clearSummaryPanel(); return; }
  const s = summary;
  const fmtShort = s.format.replace(/^SEG-?Y$/i, 'SEG-Y');
  setText('fsFormat', fmtShort + (s.revision ? ' R' + s.revision : ''));
  setText('fsTraces', grp(s.traceCount));
  setText('fsSamples', grp(s.samplesTrace));
  setText('fsInterval', s.sampleInt != null ? `${(s.sampleInt / 1000).toFixed(3)} ms` : '-');
  const recMs = s.samplesTrace != null && s.sampleInt != null ? (s.samplesTrace * s.sampleInt) / 1e6 : null;
  setText('fsRecord', recMs != null ? `${recMs.toFixed(3)} s` : '-');
  setText('fsData', s.format || '-');
  setText('fsRevision', s.revision ? `Rev ${s.revision}` : '-');
  setText('fsByteOrder', s.byteOrder || '-');
  setText('fsCrs', spsCrsLabel());
}
function clearSummaryPanel() {
  for (const id of ['fsFormat', 'fsTraces', 'fsSamples', 'fsInterval', 'fsRecord', 'fsData', 'fsRevision', 'fsByteOrder', 'fsCrs']) setText(id, '-');
  setText('fsCrs', spsCrsLabel());
}

/** Header-QC indicator: badge in the tab header + pill + flag list, driven by summary.errors. */
function renderHeaderQc() {
  const badge = $opt('hdrQcBadge');
  const pill = $opt('hdrQcPill');
  const list = $opt('hdrQcList');
  if (!summary) {
    if (badge) { badge.className = 'pill neutral'; badge.innerHTML = '<span class="dot" style="background:var(--ink-4)"></span>No file'; }
    if (pill) { pill.className = 'pill neutral'; pill.textContent = '-'; }
    if (list) list.innerHTML = '<div class="fl"><span class="pill neutral" style="justify-self:start">-</span><span class="msg">Open a file to run header QC.</span><span class="cat"></span></div>';
    return;
  }
  const errs = summary.errors;
  const n = errs.length;
  if (badge) {
    if (n === 0) { badge.className = 'pill green'; badge.innerHTML = '<span class="dot" style="background:var(--green)"></span>Headers OK'; }
    else { badge.className = 'pill amber'; badge.innerHTML = `<span class="dot" style="background:var(--amber)"></span>${n} flag${n > 1 ? 's' : ''}`; }
  }
  if (pill) {
    if (n === 0) { pill.className = 'pill green'; pill.textContent = 'OK'; }
    else { pill.className = 'pill amber'; pill.textContent = `${n} warning${n > 1 ? 's' : ''}`; }
  }
  if (list) {
    list.innerHTML = '';
    if (n === 0) {
      const fl = document.createElement('div');
      fl.className = 'fl';
      fl.innerHTML = '<span class="pill green" style="justify-self:start">OK</span><span class="msg">No header issues detected.</span><span class="cat"></span>';
      list.appendChild(fl);
    } else {
      for (const e of errs) {
        const fl = document.createElement('div');
        fl.className = 'fl';
        const sev = document.createElement('span');
        sev.className = 'pill amber';
        sev.style.justifySelf = 'start';
        sev.textContent = 'WARN';
        const msg = document.createElement('span');
        msg.className = 'msg';
        msg.textContent = e;
        const cat = document.createElement('span');
        cat.className = 'cat';
        list.appendChild(fl);
        fl.appendChild(sev);
        fl.appendChild(msg);
        fl.appendChild(cat);
      }
    }
  }
}

/** Best-known CRS string from a loaded SPS survey, else a dash. */
function spsCrsLabel(): string {
  const p = spsSummary?.projection;
  if (!p) return '-';
  return p.desc || p.type || p.subtype || '-';
}

/** Bottom status strip: file · dt · traces · fmt · CRS + activity state. */
function updateStatusStrip() {
  if (!summary) {
    setText('sbFile', '-'); setText('sbDt', '-'); setText('sbTraces', '-'); setText('sbFmt', '-');
    setText('sbCrs', spsCrsLabel());
    setState('idle', 'Idle');
    return;
  }
  setText('sbFile', summary.name);
  setText('sbDt', summary.sampleInt != null ? `${(summary.sampleInt / 1000).toFixed(3)} ms` : '-');
  setText('sbTraces', grp(summary.traceCount));
  setText('sbFmt', `${summary.format}${summary.revision ? ' Rev ' + summary.revision : ''}`);
  setText('sbCrs', spsCrsLabel());
}

type StripState = 'idle' | 'busy' | 'ok' | 'err';
function setState(kind: StripState, label: string) {
  const el = $opt('sbState');
  if (!el) return;
  const col = kind === 'busy' ? 'var(--teal)' : kind === 'ok' ? 'var(--green)' : kind === 'err' ? 'var(--red)' : 'var(--ink-4)';
  const txtCol = kind === 'busy' ? 'var(--teal-deep)' : kind === 'ok' ? 'var(--green)' : kind === 'err' ? 'var(--red)' : 'var(--ink-2)';
  el.innerHTML = `<span class="dot" style="background:${col}"></span><b style="color:${txtCol}">${label}</b>`;
}

/**
 * Adopt a freshly-parsed file (from the open dialog OR a Prev/Next sibling step)
 * as the loaded file: store its summary, reset the trace cursor, repaint the
 * info/summary/QC panels + single-file wizard, refresh the file-nav label, and
 * re-render whichever QC view is visible. Shared by onOpen and the sibling-nav so
 * both paths behave identically.
 */
function applyOpenedFile(s: Summary) {
  summary = s;
  traceIndex = 0;
  // Drop the previous file's cached trace. Without this, stepping files with ]/[
  // on a non-trace tab leaves lastTrace holding the OLD file's samples/index,
  // and 'Add open trace' / Inspector 'Add to Workbench' would pair the NEW
  // summary.name with the OLD samples (a silent label/data desync). When the
  // trace panel is visible, refreshTrace() below repopulates it for the new file.
  lastTrace = null;
  // Also drop the section cache + data-zoom window (symmetric with clearConverter):
  // without this, stepping files with ]/[ from a non-section tab leaves lastSection
  // holding the OLD file's matrix and secView pinned to the OLD file's zoom window,
  // so the next section redraw could paint stale data before refreshSection re-fits.
  lastSection = null;
  secView.init = false;
  // Drop any trace-health overlay/findings tied to the previous file.
  secHealthReset();
  fbReset(); // drop first-break picks/guide tied to the previous file (keep the mode)
  // Invalidate the Spectrum + Velocity caches: they're module-level and keyed to
  // the previously-open file, so stepping files with ]/[ on those tabs would keep
  // showing the OLD file's spectra/semblance. Drop the payloads, reset the
  // spectrogram trace cursor, clear the velocity result + picks, then re-render
  // whichever of those panels is visible so it reflects the NEW file.
  specAvg = null; specGram = null; specFk = null;
  specTraceIdx = 0;
  velResult = null;
  velPicks = [];
  // Reset the Velocity + Spectrum manual-range view-state AND clear their boxes
  // here, regardless of whether those panels are currently visible. The payloads
  // above are keyed to the previous file, so without this the axis boxes keep
  // showing the OLD file's typed values (and velView/spec*View keep its window)
  // until the user re-computes/refreshes. Mirrors how lastSection/secView reset.
  velView.v0 = velView.v1 = velView.t0 = velView.t1 = null;
  velAxisRange?.clear();
  for (const view of [specAvgView, specGramView, specFkView]) { view.x0 = view.x1 = view.y0 = view.y1 = null; }
  specAvgAxis?.clear(); specGramAxis?.clear(); specFkAxis?.clear();
  renderInfo();
  showSingleLoaded();      // banner + light up the single-file wizard
  updateNamePreview();
  updateFileNav();         // Prev/Next enable + 'X / N' label
  setStatus('convStatus', '');
  setState('ok', s.errors.length ? `Loaded · ${s.errors.length} flag${s.errors.length > 1 ? 's' : ''}` : 'Loaded');
  if ($('panel-trace').style.display !== 'none') void refreshTrace();
  if ($('panel-section').style.display !== 'none') void refreshSection();
  if ($opt('panel-spectrum')?.style.display !== 'none') void refreshSpectrum();
  if ($opt('panel-vel')?.style.display !== 'none') { renderVelPicks(); drawVelocity(); $('velLabel').textContent = 'Open a file, then compute a velocity scan.'; }
}

async function onOpen() {
  setStatus('convStatus', 'Opening…');
  setState('busy', 'Opening…');
  showProgress('Opening file…'); // determinate once a large file starts indexing (worker ticks)
  try {
    const s = await api.openAndParse();
    if (!s) {
      // Cancelled (dialog dismissed) or a no-op open: clear the transient
      // "Opening…" busy state instead of leaving it stuck. Fall back to the
      // previously-loaded file's idle state if one is still open, else Idle.
      setStatus('convStatus', '');
      setState(summary ? 'ok' : 'idle', summary ? 'Loaded' : 'Idle');
      updateStatusStrip();
      return;
    }
    applyOpenedFile(s);
  } catch (e) {
    setStatus('convStatus', 'Could not read file: ' + errMsg(e), 'err');
    setState('err', 'Open failed');
  } finally {
    hideProgress();
  }
}

/** Refresh the File Viewer's Prev/Next buttons + 'file X / N' label from `summary`. */
function updateFileNav() {
  const prev = $opt('filePrevBtn') as HTMLButtonElement | null;
  const next = $opt('fileNextBtn') as HTMLButtonElement | null;
  const lbl = $opt('fileNavLabel');
  // A streamed/tape-image file is one giant archive - folder "previous/next file"
  // is meaningless inside it, so hide file-nav entirely and let the trace-paging
  // control (updateSecPaging) drive movement through the record instead.
  const streamed = !!summary?.streamed;
  if (prev) prev.style.display = streamed ? 'none' : '';
  if (next) next.style.display = streamed ? 'none' : '';
  if (lbl) lbl.style.display = streamed ? 'none' : '';
  updateSecPaging();
  if (streamed) return;
  if (!summary || summary.count <= 0) {
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    if (lbl) lbl.textContent = summary ? '' : '-';
    return;
  }
  if (prev) prev.disabled = !summary.hasPrev;
  if (next) next.disabled = !summary.hasNext;
  if (lbl) lbl.textContent = `file ${summary.index + 1} / ${summary.count}`;
}

/** Show/refresh the trace-paging control (Prev/Next block + 'traces A-B / total')
 *  from the current section window. Shown for streamed files, or any file with
 *  more traces than one block. Called on open, on every section repaint, and when
 *  the block size changes. */
function updateSecPaging() {
  const nav = $opt('secPageNav');
  const sizeWrap = $opt('secPageSizeWrap');
  const prev = $opt('secPagePrev') as HTMLButtonElement | null;
  const next = $opt('secPageNext') as HTMLButtonElement | null;
  const lbl = $opt('secPageLabel');
  const fullT = secView.fullT || summary?.traceCount || 0;
  // Only streamed/tape-image files page in blocks - they open to a block (never the
  // whole record), so t1<fullT and the Next/Prev enable logic below is unambiguous.
  // Normal files keep whole-file fit + folder Prev/Next + wheel-zoom as before.
  const show = !!summary && summary.traceCount > 0 && summary.streamed === true;
  if (nav) nav.style.display = show ? '' : 'none';
  if (sizeWrap) sizeWrap.style.display = show ? '' : 'none';
  if (!show) return;
  const t0 = secView.t0, t1 = secView.t1;
  // Before the first block has been fetched (secFit hasn't run yet on a fresh
  // open), the window is empty (t1 <= t0). Show a loading placeholder rather than
  // a misleading "traces 1-0", and keep both buttons disabled until it paints.
  const ready = t1 > t0;
  if (lbl) lbl.textContent = ready ? `traces ${grp(t0 + 1)}-${grp(t1)} / ${grp(fullT)}` : `traces … / ${grp(fullT)}`;
  if (prev) prev.disabled = !ready || t0 <= 0;
  if (next) next.disabled = !ready || t1 >= fullT;
}

/** Step the section view by one block of traces (the trace-paging buttons). From a
 *  whole-file ("fitted") view, the first Next jumps to block 0 / Prev to the last
 *  block; otherwise it advances by exactly one block width, clamped to the record. */
async function secPageStep(delta: number) {
  if (!summary || summary.traceCount === 0) return;
  const fullT = secView.fullT || summary.traceCount;
  const page = secPageSize();
  const lastStart = Math.max(0, fullT - page);
  const fitted = (secView.t1 - secView.t0) >= fullT - 1; // viewing (nearly) the whole record
  let start = fitted ? (delta > 0 ? 0 : lastStart) : secView.t0 + delta * page;
  start = Math.max(0, Math.min(lastStart, start));
  secView.t0 = start;
  secView.t1 = Math.min(fullT, start + page);
  await fetchSectionWindow(); // echoes the real window back into secView + repaints
  updateSecPaging();
}

/** Re-apply the block size to the current view after the block-size box changes. */
async function secPageApplySize() {
  if (!summary || summary.traceCount === 0) { updateSecPaging(); return; }
  const fullT = secView.fullT || summary.traceCount;
  const page = secPageSize();
  const start = Math.max(0, Math.min(Math.max(0, fullT - page), secView.t0));
  secView.t0 = start;
  secView.t1 = Math.min(fullT, start + page);
  await fetchSectionWindow();
  updateSecPaging();
}

/** Step ±delta to a sibling file in the open file's folder; no-op when none loaded. */
async function navFile(delta: number) {
  if (!summary) return;                 // guard: nothing loaded
  if (delta < 0 && !summary.hasPrev) return;
  if (delta > 0 && !summary.hasNext) return;
  setState('busy', delta < 0 ? 'Opening previous…' : 'Opening next…');
  showProgress(delta < 0 ? 'Opening previous file…' : 'Opening next file…');
  try {
    const s = await api.openSiblingFile(delta);
    if (!s) { updateFileNav(); updateStatusStrip(); return; } // edge / no move
    applyOpenedFile(s);                 // updates summary, re-renders, resets trace
  } catch (e) {
    setStatus('convStatus', 'Could not read file: ' + errMsg(e), 'err');
    setState('err', 'Open failed');
  } finally {
    hideProgress();
  }
}

// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
//  CONVERTER - two modes: single file & folder (batch)
// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

const FMT_LABEL: Record<string, string> = {
  segy1: 'SEG-Y Rev 1', segy0: 'SEG-Y Rev 0', segy2: 'SEG-Y Rev 2',
  su: 'Seismic Unix', seg2: 'SEG-2 / .dat', segd1: 'SEG-D Rev 1',
  segd3: 'SEG-D Rev 3', tpimage: 'Tape Image', csv: 'CSV / ASCII',
};
function fmtLabel(f: string): string { return FMT_LABEL[f] || f.toUpperCase(); }

// Output extension per writer id (mirrors core/formats/registry.ts writers; used
// for the output-name preview - the backend is the source of truth on write).
const FMT_EXT: Record<string, string> = {
  segy1: 'sgy', segy0: 'sgy', segy2: 'sgy',
  su: 'su', seg2: 'dat', segd1: 'segd',
  segd3: 'segd', tpimage: 'tpimage', csv: 'csv',
};
function fmtExt(f: string): string { return FMT_EXT[f] || 'bin'; }

// -- Output-name templating --------------------------------------------------
// A small token engine shared by single + batch. Tokens: {name} input base,
// {custom} custom text, {fmt} writer id, {date} YYYYMMDD stamp, {time} HHMM,
// {seq3} 3-digit index + {seq}/{n} 1-based index (batch only). The Converter's
// output-name checklist assembles a {token} template (assembleNameTemplate) and
// feeds it through THIS engine, so the checklist, the advanced free-text field,
// single + batch, and the main-process namer all agree. Keep the token set in
// sync with electron/main.ts applyNameTemplate.

/** Strip the final extension from a file name → its base. */
function fileBase(name: string): string { return name.replace(/\.[^.]+$/, ''); }

/** Strip characters illegal in file names so a templated base is always safe.
 *  Also drops C0/C1 control characters and bidi overrides and caps the length:
 *  on Windows a control character in a base name makes the write fail outright
 *  (ERR_INVALID_ARG_VALUE / ENOENT) and a long base blows past MAX_PATH, while a
 *  bidi override display-spoofs the extension. MUST stay identical to the main
 *  process's sanitizeBaseName (electron/main.ts). */
function sanitizeName(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '')
    .trim() || 'output';
}

/** Read the date input as a YYYYMMDD stamp; falls back to today if empty/invalid. */
function dateStamp(): string {
  const raw = ($opt('outNameDate') as HTMLInputElement | null)?.value || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.replace(/-/g, '');
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** The sanitized custom-text component (the {custom} token). Path-illegal chars
 *  stripped; empty when the field is blank. */
function customStamp(): string {
  const raw = ($opt('outNameCustom') as HTMLInputElement | null)?.value || '';
  return raw.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

/** Current wall-clock time as an HHMM stamp (the {time} token). */
function timeStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Current template string (default if the field is empty). */
function nameTemplate(): string {
  const raw = ($opt('outNameTpl') as HTMLInputElement | null)?.value || '';
  return raw.trim() || '{name}';
}

/** Apply the template for one file → a safe base name (no extension). An EMPTY
 *  component (e.g. {seq3} in single mode, or {custom} with a blank field) is
 *  dropped together with one neighbouring separator so a ticked-but-blank part
 *  never leaves a doubled or dangling _ / - in the name. */
function applyNameTemplate(
  tpl: string,
  vars: { name: string; fmt: string; date: string; custom?: string; time?: string; n?: number },
): string {
  const val: Record<'name' | 'custom' | 'fmt' | 'date' | 'time' | 'seq3' | 'seq' | 'n', string> = {
    name: vars.name ?? '',
    custom: vars.custom ?? '',
    fmt: vars.fmt ?? '',
    date: vars.date ?? '',
    time: vars.time ?? '',
    seq3: vars.n != null ? String(vars.n).padStart(3, '0') : '',
    seq: vars.n != null ? String(vars.n) : '',
    n: vars.n != null ? String(vars.n) : '',
  };
  let out = tpl;
  // Strip empty tokens (with a neighbouring separator) before substituting the
  // rest; the token list is a fixed literal set, so the dynamic RegExp is safe.
  for (const key of ['name', 'custom', 'fmt', 'date', 'time', 'seq3', 'seq', 'n'] as const) {
    if (val[key]) continue;
    out = out.replace(new RegExp('[_-]?\\{' + key + '\\}', 'g'), '');
  }
  out = out
    .replace(/\{name\}/g, val.name)
    .replace(/\{custom\}/g, val.custom)
    .replace(/\{fmt\}/g, val.fmt)
    .replace(/\{date\}/g, val.date)
    .replace(/\{time\}/g, val.time)
    .replace(/\{seq3\}/g, val.seq3)
    .replace(/\{seq\}/g, val.seq)
    .replace(/\{n\}/g, val.n);
  // Trim any separator left dangling at an edge (e.g. a leading token was empty).
  out = out.replace(/^[_-]+/, '').replace(/[_-]+$/, '');
  return sanitizeName(out);
}

/** Build the {token} template from the output-name CHECKLIST + separator and
 *  write it into the (advanced) #outNameTpl field, then refresh the preview. The
 *  checklist is the primary control; the free-text field stays in sync so power
 *  users can still tweak. Tokens are emitted in a fixed order; {seq3} is harmless
 *  in single mode (applyNameTemplate strips it when there is no index). */
function assembleNameTemplate() {
  const sep = ($opt('outNameSep') as HTMLSelectElement | null)?.value ?? '_';
  const checked = (id: string) => !!($opt(id) as HTMLInputElement | null)?.checked;
  const parts: string[] = [];
  if (checked('npName')) parts.push('{name}');
  if (checked('npCustom')) parts.push('{custom}');
  if (checked('npFmt')) parts.push('{fmt}');
  if (checked('npDate')) parts.push('{date}');
  if (checked('npTime')) parts.push('{time}');
  if (checked('npSeq')) parts.push('{seq3}');
  // Guard: nothing ticked → fall back to {name} so the output is never empty.
  const tpl = parts.length ? parts.join(sep) : '{name}';
  const inp = $opt('outNameTpl') as HTMLInputElement | null;
  if (inp) inp.value = tpl;
  updateNamePreview();
}

/** Best-effort reverse-sync: reflect a hand-edited #outNameTpl back onto the
 *  checklist toggles + separator so the two controls don't drift. Setting
 *  `.checked`/`.value` programmatically fires no events, so there is no loop.
 *  Free-form templates simply leave the toggles as the user last set them. */
function syncChecklistFromTemplate() {
  const tpl = ($opt('outNameTpl') as HTMLInputElement | null)?.value || '';
  const setCb = (id: string, on: boolean) => { const cb = $opt(id) as HTMLInputElement | null; if (cb) cb.checked = on; };
  setCb('npName', tpl.includes('{name}'));
  setCb('npCustom', tpl.includes('{custom}'));
  setCb('npFmt', tpl.includes('{fmt}'));
  setCb('npDate', tpl.includes('{date}'));
  setCb('npTime', tpl.includes('{time}'));
  setCb('npSeq', tpl.includes('{seq3}') || tpl.includes('{seq}') || tpl.includes('{n}'));
  // Infer the separator from the gap between the first two tokens, if any.
  const m = tpl.match(/\}([^{}]*)\{/);
  const selSep = $opt('outNameSep') as HTMLSelectElement | null;
  if (m && selSep && (m[1] === '_' || m[1] === '-' || m[1] === '')) selSep.value = m[1];
  updateNamePreview();
}

/** Refresh the live filename preview for the active mode. */
function updateNamePreview() {
  const ext = fmtExt(outFormat);
  setText('outNameExt', '.' + ext);
  const tpl = nameTemplate();
  const date = dateStamp();
  const custom = customStamp();
  const time = timeStamp();
  const prev = $opt('outNamePreview');
  if (!prev) return;
  if (convMode === 'batch') {
    if (outFormat === 'tpimage') {
      // Tape Image combines the whole folder into ONE archive, named after the
      // source folder (mirrors the backend's {name}=folder for the combined file).
      const folder = batchDir ? (batchDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'tape_image') : 'tape_image';
      const out = applyNameTemplate(tpl, { name: folder, fmt: outFormat, date, custom, time, n: 1 });
      prev.textContent = batchFiles.length
        ? `Preview - ${out}.${ext}  (all ${batchFiles.length} file${batchFiles.length === 1 ? '' : 's'} combined into one tape image)`
        : `Preview - ${out}.${ext}`;
    } else {
      const sample = batchFiles[0]?.name;
      const base = sample ? fileBase(sample) : 'example';
      const out = applyNameTemplate(tpl, { name: base, fmt: outFormat, date, custom, time, n: 1 });
      prev.textContent = batchFiles.length
        ? `Preview (file 1 of ${batchFiles.length}) - ${out}.${ext}`
        : `Preview - ${out}.${ext}`;
    }
  } else {
    const base = summary ? fileBase(summary.name) : 'example';
    const out = applyNameTemplate(tpl, { name: base, fmt: outFormat, date, custom, time });
    prev.textContent = `Preview - ${out}.${ext}`;
  }
  prev.className = 'status';
  updateNameExamples();
}

/** Insert {fmt} into a template at a natural spot (after {custom}/{name}, else
 *  the front), using the current separator - for the single-mode "with Format"
 *  example so the user sees the effect of the Format component. */
function insertFmtToken(tpl: string): string {
  const sep = ($opt('outNameSep') as HTMLSelectElement | null)?.value ?? '_';
  if (tpl.includes('{custom}')) return tpl.replace('{custom}', '{custom}' + sep + '{fmt}');
  if (tpl.includes('{name}')) return tpl.replace('{name}', '{name}' + sep + '{fmt}');
  return tpl ? '{fmt}' + sep + tpl : '{fmt}';
}

/** Render the compact LIVE "Examples" help ABOVE the checklist. Reuses the SAME
 *  applyNameTemplate engine as the preview, so the shown names match exactly what
 *  gets written. Single mode: the current combo on the loaded base (or a 1006
 *  placeholder) + a Format-on/off variant. Batch mode: the first ~3 files in
 *  sequence (real folder names if loaded, else 1006/1012/1018) so {seq3}
 *  001/002/003 is plain. Built with textContent only - no untrusted HTML. */
function updateNameExamples() {
  const host = $opt('outNameExamples');
  if (!host) return;
  const ext = fmtExt(outFormat);
  const tpl = nameTemplate();
  const date = dateStamp();
  const custom = customStamp();
  const time = timeStamp();
  const rows: { name: string; note?: string }[] = [];
  let heading = 'Examples';
  if (convMode === 'batch') {
    if (outFormat === 'tpimage') {
      const folder = batchDir ? (batchDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'tape_image') : 'tape_image';
      const out = applyNameTemplate(tpl, { name: folder, fmt: outFormat, date, custom, time, n: 1 });
      rows.push({ name: `${out}.${ext}`, note: 'all files → one tape image' });
    } else {
      heading = 'Examples - first files in this batch';
      const bases = batchFiles.length
        ? batchFiles.slice(0, 3).map((f) => fileBase(f.name))
        : ['1006', '1012', '1018'];
      bases.forEach((base, i) => {
        const out = applyNameTemplate(tpl, { name: base, fmt: outFormat, date, custom, time, n: i + 1 });
        rows.push({ name: `${out}.${ext}` });
      });
    }
  } else {
    const base = summary ? fileBase(summary.name) : '1006';
    const cur = applyNameTemplate(tpl, { name: base, fmt: outFormat, date, custom, time });
    rows.push({ name: `${cur}.${ext}` });
    // A contrast example showing the effect of the Format component.
    const hasFmt = tpl.includes('{fmt}');
    const altTpl = hasFmt ? tpl.replace(/[_-]?\{fmt\}/g, '') : insertFmtToken(tpl);
    const alt = applyNameTemplate(altTpl, { name: base, fmt: outFormat, date, custom, time });
    if (alt && alt !== cur) rows.push({ name: `${alt}.${ext}`, note: hasFmt ? 'without Format' : 'with Format' });
  }
  host.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'name-eg-h';
  h.textContent = heading;
  host.appendChild(h);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'name-eg-row';
    const code = document.createElement('span');
    code.className = 'name-eg-name';
    code.textContent = r.name;
    row.appendChild(code);
    if (r.note) {
      const note = document.createElement('span');
      note.className = 'name-eg-note';
      note.textContent = `- ${r.note}`;
      row.appendChild(note);
    }
    host.appendChild(row);
  }
}

/**
 * Move the shared output-name card into the slot for the active mode. Both modes
 * read the same #outNameTpl/#outNameDate/#outNamePreview ids, so the template
 * engine keeps working regardless of where the card currently lives in the DOM -
 * single mode hosts it inside wizard step 3, batch mode above the folder wizard.
 */
function relocateOutNameCard(m: ConvMode) {
  const card = $opt('outNameCard');
  const slot = $opt(m === 'single' ? 'outNameSlotSingle' : 'outNameSlotBatch');
  if (card && slot && card.parentElement !== slot) slot.appendChild(card);
}

/** Switch the Converter between single-file and folder-batch modes. */
function setConvMode(m: ConvMode) {
  if (batchRunning) return; // don't tear the UI out from under a running batch
  convMode = m;
  $opt('modeSingle')?.classList.toggle('sel', m === 'single');
  $opt('modeBatch')?.classList.toggle('sel', m === 'batch');
  $opt('modeSingle')?.setAttribute('aria-pressed', String(m === 'single'));
  $opt('modeBatch')?.setAttribute('aria-pressed', String(m === 'batch'));
  $opt('convSingle')?.classList.toggle('hidden', m !== 'single');
  $opt('convBatch')?.classList.toggle('hidden', m !== 'batch');
  // Host the shared output-name card in the active mode's slot.
  relocateOutNameCard(m);
  // Tape Image is a batch-only writer; if it was picked in batch, fall back to a
  // valid single-mode format when switching to single so the chip stays in sync.
  if (m === 'single' && outFormat === 'tpimage') selectFormat('segy1');
  if (m === 'single') refreshSingleWizard();
  // Sequence # is a folder-batch-only name component: lock the toggle in single
  // mode. We do NOT re-assemble the template here - applyNameTemplate strips a
  // stale {seq3} in single mode, so any advanced hand-edit survives the switch.
  const seqCb = $opt('npSeq') as HTMLInputElement | null;
  if (seqCb) seqCb.disabled = m !== 'batch';
  $opt('npSeqLbl')?.classList.toggle('np-off', m !== 'batch');
  updateNamePreview();
}

/** Mirror the chosen output format onto both chip groups + the shared state. */
function selectFormat(fmt: string) {
  outFormat = fmt;
  for (const groupId of ['fmtChips', 'fmtChipsBatch']) {
    const g = $opt(groupId);
    if (!g) continue;
    for (const b of g.querySelectorAll('button')) b.classList.toggle('sel', b.getAttribute('data-fmt') === fmt);
  }
  if (convMode === 'single') refreshSingleWizard();
  updateNamePreview();
}

/**
 * Light up the single-file wizard steps + gate later steps, mirroring the batch
 * wizard (refreshWizard). Step 1 = a file is open; step 2 = output format chosen
 * (a default is always selected); step 3 = name + Convert & Save. No file → the
 * format chips and the Convert button are disabled, just like batch gates its run.
 */
function refreshSingleWizard() {
  const haveFile = !!summary && summary.traceCount > 0;
  // step 1 - pick file
  $opt('wizStepFile')?.classList.toggle('done', haveFile);
  $opt('wizStepFile')?.classList.toggle('active', !haveFile);
  // step 2 - output format (a format is always pre-selected, so it's done once a file is open)
  $opt('wizStepSingleFormat')?.classList.toggle('done', haveFile);
  $opt('wizStepSingleFormat')?.classList.toggle('active', false);
  // step 3 - name & save (the actionable step once a file is open)
  $opt('wizStepSingleSave')?.classList.toggle('active', haveFile);
  $opt('wizStepSingleSave')?.classList.toggle('done', false);
  // gate: no file → can't pick a format or convert
  const chips = $opt('fmtChips');
  if (chips) for (const b of chips.querySelectorAll('button')) (b as HTMLButtonElement).disabled = !haveFile || batchRunning;
  const conv = $opt('convertBtn') as HTMLButtonElement | null;
  if (conv) conv.disabled = !haveFile || batchRunning;
}

/** Fill the single-file loaded banner (name + format + trace/sample summary) and advance the wizard. */
function showSingleLoaded() {
  const found = $opt('singleFound');
  if (!summary) { found?.classList.toggle('hidden', true); refreshSingleWizard(); return; }
  found?.classList.toggle('hidden', false);
  setText('singleFoundName', summary.name);
  const rev = summary.revision ? ` Rev ${summary.revision}` : '';
  setText('singleFoundMeta',
    `${summary.format}${rev} · ${grp(summary.traceCount)} traces · ${summary.samplesTrace ?? '-'} samples · ${fmtRate(summary.sampleInt)}`);
  setText('wizFileSub', `${summary.format}${rev} - ${grp(summary.traceCount)} traces, ${summary.samplesTrace ?? '-'} samples.`);
  refreshSingleWizard();
}

// -- Single-file convert --
async function onConvert() {
  if (!summary) return;
  showSingleProgress(true);
  setStatus('convStatus', `Converting → ${fmtLabel(outFormat)}…`);
  setState('busy', 'Converting…');
  ($('convertBtn') as HTMLButtonElement).disabled = true;
  try {
    const outBase = applyNameTemplate(nameTemplate(), { name: fileBase(summary.name), fmt: outFormat, date: dateStamp(), custom: customStamp(), time: timeStamp() });
    const r = await api.convertSingle(outFormat, outBase);
    if (r.ok) { setStatus('convStatus', '✓ Saved ' + r.path, 'ok'); setState('ok', 'Saved'); showSingleOpenFolder(); audit('convert', `${fmtLabel(outFormat)} → ${r.path}`, 'conv'); }
    else if (r.canceled) { setStatus('convStatus', ''); updateStatusStrip(); }
    else { setStatus('convStatus', 'Conversion failed: ' + (r.error || 'unknown'), 'err'); setState('err', 'Convert failed'); }
  } catch (e) {
    setStatus('convStatus', 'Conversion failed: ' + errMsg(e), 'err');
    setState('err', 'Convert failed');
  } finally {
    showSingleProgress(false);
    ($('convertBtn') as HTMLButtonElement).disabled = !(summary && summary.traceCount > 0);
  }
}

function showSingleProgress(on: boolean) {
  $opt('singleProg')?.classList.toggle('hidden', !on);
  const t = $opt('singleProgTitle');
  if (t) t.textContent = `Converting → ${fmtLabel(outFormat)}…`;
}

// -- Folder batch: wizard --
async function pickBatchFolder() {
  if (batchRunning) return;
  setStatus('batchStatus', 'Choosing folder…');
  try {
    const res = await api.pickInputFolder();
    if (!res) { setStatus('batchStatus', ''); return; }
    batchFiles = res.files;
    batchDir = res.dir;
    const found = $opt('batchFound');
    found?.classList.toggle('hidden', false);
    setText('batchCount', String(res.files.length));
    setText('batchDir', res.dir);
    setText('wizFolderSub', `${res.files.length} seismic file${res.files.length === 1 ? '' : 's'} in this folder.`);
    updateNamePreview();
    $('batchFileList').innerHTML = '';
    setStatus('batchStatus', res.files.length ? '' : 'No seismic files in that folder.', res.files.length ? '' : 'err');
    refreshWizard();
  } catch (e) {
    setStatus('batchStatus', 'Folder scan failed: ' + errMsg(e), 'err');
  }
}

async function pickBatchOut() {
  if (batchRunning) return;
  try {
    const dir = await api.pickOutputFolder();
    if (!dir) return;
    batchOutDir = dir;
    setText('wizDestSub', dir);
    refreshWizard();
  } catch (e) {
    setStatus('batchStatus', 'Destination pick failed: ' + errMsg(e), 'err');
  }
}

/** Light up wizard steps + enable the run button once folder + dest are set. */
function refreshWizard() {
  const haveFiles = batchFiles.length > 0;
  const haveOut = batchOutDir.length > 0;
  $opt('wizStepFolder')?.classList.toggle('done', haveFiles);
  $opt('wizStepFolder')?.classList.toggle('active', !haveFiles);
  $opt('wizStepFormat')?.classList.toggle('active', haveFiles && !haveOut);
  $opt('wizStepFormat')?.classList.toggle('done', haveFiles && haveOut);
  $opt('wizStepDest')?.classList.toggle('done', haveOut);
  $opt('wizStepDest')?.classList.toggle('active', haveFiles && !haveOut);
  const btn = $opt('runBatchBtn') as HTMLButtonElement | null;
  if (btn) btn.disabled = !(haveFiles && haveOut) || batchRunning;
  setText('runBatchLabel', haveFiles ? `Convert ${batchFiles.length} file${batchFiles.length === 1 ? '' : 's'}` : 'Convert files');
}

async function runBatch() {
  if (batchRunning || !batchFiles.length || !batchOutDir) return;
  batchRunning = true;
  setBatchControlsRunning(true);
  // Seed the per-file list so users see the full queue up front.
  buildBatchQueue();
  $opt('batchProg')?.classList.toggle('hidden', false);
  hideBatchOpenFolder(); // a fresh run hides the previous run's "Open folder" button
  // The combine now streams one record per input file, so it advances the SAME
  // N-of-M determinate progress bar as a per-file batch (genuine per-file progress).
  const steps = batchFiles.length;
  setBatchProgress(0, steps, '', fmtLabel(outFormat));
  setStatus('batchStatus', '');
  setState('busy', outFormat === 'tpimage' ? `Combining 0 / ${batchFiles.length}` : `Converting 0 / ${batchFiles.length}`);
  try {
    const r = await api.batchConvert({ files: batchFiles, format: outFormat, outDir: batchOutDir, nameTemplate: nameTemplate(), dateStr: dateStamp(), custom: customStamp(), time: timeStamp() });
    finishBatch(r);
  } catch (e) {
    setStatus('batchStatus', 'Batch failed: ' + errMsg(e), 'err');
    setState('err', 'Batch failed');
    batchRunning = false;
    setBatchControlsRunning(false);
    refreshWizard();
  }
}

function cancelBatch() {
  if (!batchRunning) return;
  api.cancelConvert();
  setStatus('batchStatus', 'Cancelling…');
}

/** Open the last conversion OUTPUT in the OS file explorer ('single' reveals the
 *  saved file, 'batch' opens the destination folder). Backed by main's remembered
 *  output path; surfaces a status note if nothing is known yet / the open fails. */
async function openOutputFolder(which: 'single' | 'batch') {
  try {
    const r = await api.openOutputFolder(which);
    if (!r.ok) setStatus(which === 'batch' ? 'batchStatus' : 'convStatus', r.error ? 'Could not open the folder: ' + r.error : 'No output folder to open yet.', 'err');
  } catch (e) {
    setStatus(which === 'batch' ? 'batchStatus' : 'convStatus', 'Could not open the folder: ' + errMsg(e), 'err');
  }
}

/** Handle a progress tick from the backend (start/done/error/cancelled/finished). */
function onBatchProgress(p: ConvProgress) {
  if (p.state === 'finished') return; // summary handled by the resolved promise
  const total = p.total || batchFiles.length;
  if (p.state === 'cancelled') {
    setBatchProgress(p.index, total, p.file, fmtLabel(outFormat), 'cancelled');
    markFileRow(p.index, 'cancelled', p.file);
    setState('busy', 'Cancelling…');
    return;
  }
  if (p.state === 'start') {
    setBatchProgress(p.index - 1, total, p.file, fmtLabel(outFormat));
    markFileRow(p.index, 'run', p.file);
    setState('busy', `Converting ${p.index} / ${total}`);
  } else if (p.state === 'done') {
    setBatchProgress(p.index, total, p.file, fmtLabel(outFormat));
    markFileRow(p.index, 'done', p.file);
  } else if (p.state === 'error') {
    setBatchProgress(p.index, total, p.file, fmtLabel(outFormat));
    markFileRow(p.index, 'error', p.file, p.error);
  }
}

function setBatchProgress(done: number, total: number, file: string, fmt: string, note?: string) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
  const fill = $opt('batchProgFill');
  if (fill) (fill as HTMLElement).style.width = pct + '%';
  setText('batchProgCount', `${done} / ${total}`);
  setText('batchProgTitle', note === 'cancelled' ? 'Cancelled' : `Converting ${Math.min(done + 1, total)} / ${total} · ${fmt}`);
  setText('batchProgSub', file ? `${file}` : '');
}

/** Pre-populate the result list with every queued file. Tape Image is a combine
 *  target (all files → one archive), but the combine now streams one record per
 *  input file, so it lists every file (each row updates live as it's framed) with
 *  a leading note that they all flow into one tape - genuine per-file progress. */
function buildBatchQueue() {
  const el = $('batchFileList');
  el.innerHTML = '';
  if (outFormat === 'tpimage') {
    const note = document.createElement('div');
    note.className = 'file-row queued';
    note.innerHTML = `<span class="fr-st">TAPE</span><span class="fr-nm"></span><span class="fr-x">combine</span>`;
    (note.querySelector('.fr-nm') as HTMLElement).textContent = `All ${batchFiles.length} file${batchFiles.length === 1 ? '' : 's'} → one tape image`;
    el.appendChild(note);
  }
  batchFiles.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'file-row queued';
    row.id = `bfr-${i + 1}`; // 1-based to match backend progress index
    row.innerHTML =
      `<span class="fr-st">QUEUED</span>` +
      `<span class="fr-nm"></span>` +
      `<span class="fr-x">${fmtLabel(outFormat)}</span>`;
    (row.querySelector('.fr-nm') as HTMLElement).textContent = f.name;
    el.appendChild(row);
  });
}

const ROW_STATE_LABEL: Record<string, string> = { run: 'CONVERTING', done: 'DONE', error: 'ERROR', cancelled: 'CANCELLED', queued: 'QUEUED' };
function markFileRow(index: number, state: 'run' | 'done' | 'error' | 'cancelled', file: string, error?: string) {
  const row = $opt(`bfr-${index}`);
  if (!row) return;
  row.className = 'file-row ' + state;
  const st = row.querySelector('.fr-st') as HTMLElement | null;
  if (st) st.textContent = ROW_STATE_LABEL[state] || state.toUpperCase();
  const nm = row.querySelector('.fr-nm') as HTMLElement | null;
  if (nm) nm.textContent = error ? `${file} - ${error}` : file;
  row.scrollIntoView({ block: 'nearest' });
}

/** Show/hide the "Open output folder" buttons on the finished convert wizards.
 *  Enabled once an output path is known (a successful single save / batch run). */
function showSingleOpenFolder() { $opt('openSingleFolderBtn')?.classList.toggle('hidden', false); }
function hideSingleOpenFolder() { $opt('openSingleFolderBtn')?.classList.toggle('hidden', true); }
function showBatchOpenFolder() { $opt('openBatchFolderBtn')?.classList.toggle('hidden', false); }
function hideBatchOpenFolder() { $opt('openBatchFolderBtn')?.classList.toggle('hidden', true); }

function finishBatch(r: BatchSummary) {
  batchRunning = false;
  setBatchControlsRunning(false);
  refreshWizard();
  // Reveal "Open output folder" once anything was written this run.
  if (r.done > 0) showBatchOpenFolder(); else hideBatchOpenFolder();
  if (r.done > 0) audit('convert', `batch ${fmtLabel(outFormat)} - ${r.done} converted, ${r.failed} failed → ${batchOutDir}`, 'conv');
  const processed = r.done + r.failed;
  const fill = $opt('batchProgFill');
  const pct = r.canceled ? (r.total > 0 ? (processed / r.total) * 100 : 0) : 100;
  if (fill) (fill as HTMLElement).style.width = pct + '%';
  setText('batchProgCount', `${processed} / ${r.total}`);
  if (r.canceled) {
    setText('batchProgTitle', 'Cancelled');
    setText('batchProgSub', `${r.done} converted · ${r.failed} failed · cancelled`);
    setStatus('batchStatus', `Cancelled - ${r.done} of ${r.total} converted.`, '');
    setState('idle', 'Cancelled');
    // Any file that never started shows as cancelled rather than stuck on QUEUED.
    for (let i = processed + 1; i <= batchFiles.length; i++) {
      const f = batchFiles[i - 1];
      if (f) markFileRow(i, 'cancelled', f.name);
    }
  } else if (r.failed > 0) {
    setText('batchProgTitle', 'Finished with errors');
    setText('batchProgSub', `${r.done} converted · ${r.failed} failed`);
    setStatus('batchStatus', `Done - ${r.done} converted, ${r.failed} failed → ${batchOutDir}`, r.done ? '' : 'err');
    setState(r.done ? 'ok' : 'err', `${r.done}/${r.total} done`);
  } else if (outFormat === 'tpimage') {
    setText('batchProgTitle', 'Finished');
    setText('batchProgSub', `Combined ${r.done} file${r.done === 1 ? '' : 's'} into one tape image → ${batchOutDir}`);
    setStatus('batchStatus', `✓ Combined ${r.done} file${r.done === 1 ? '' : 's'} into one tape image → ${batchOutDir}`, 'ok');
    setState('ok', 'Combined');
  } else {
    setText('batchProgTitle', 'Finished');
    setText('batchProgSub', `${r.done} converted → ${batchOutDir}`);
    setStatus('batchStatus', `✓ Converted ${r.done} file${r.done === 1 ? '' : 's'} → ${batchOutDir}`, 'ok');
    setState('ok', `${r.done}/${r.total} done`);
  }
  // Reconcile rows against the authoritative summary (covers any missed ticks).
  r.results.forEach((res, i) => {
    if (res.ok) markFileRow(i + 1, 'done', res.name);
    else markFileRow(i + 1, 'error', res.name, res.error);
  });
}

function setBatchControlsRunning(running: boolean) {
  $opt('cancelBatchBtn')?.classList.toggle('hidden', !running);
  for (const id of ['pickFolderBtn', 'pickOutBtn', 'runBatchBtn', 'clearBatchBtn', 'modeSingle', 'modeBatch']) {
    const b = $opt(id) as HTMLButtonElement | null;
    if (b) b.disabled = running;
  }
  // format chips disabled while running
  for (const groupId of ['fmtChipsBatch', 'fmtChips']) {
    const g = $opt(groupId);
    if (g) for (const b of g.querySelectorAll('button')) (b as HTMLButtonElement).disabled = running;
  }
}

// -- Clear (reset worker + renderer) --
async function clearConverter() {
  if (batchRunning) return;
  try { await api.resetState(); } catch { /* best-effort */ }
  // renderer state
  summary = null;
  lastTrace = null;
  lastSection = null;
  secView.init = false; // forget the data-zoom window so the next file opens fitted
  secHealthReset();     // drop the trace-health overlay + findings
  fbReset();            // drop first-break picks + guide
  if (fbMode) setFbMode(false); // exit first-breaks mode on a full Clear
  disarmSecToWb();      // reset the '+ Workbench' click-to-add toggle (button + cursor)
  exitBoxModes();       // disarm both magnifier modes (button + cursor + rubber-band)
  closeZoom();          // close any open box-zoom viewer (its data is now gone)
  secHoverHdrCache.clear(); secHoverLastIdx = -1; // drop cached per-trace header suffixes
  clearSecHover(); clearTraceHover();             // reset the hover captions
  traceIndex = 0;
  // batch state
  batchFiles = [];
  batchDir = '';
  batchOutDir = '';
  // single-file panels back to empty
  renderInfo();                 // hides fileInfo + clears summary/QC/strip
  setStatus('convStatus', '');
  showSingleProgress(false);
  hideSingleOpenFolder();        // drop the "Open output folder" buttons (no output now)
  hideBatchOpenFolder();
  ($('convertBtn') as HTMLButtonElement).disabled = true;
  // single-file wizard back to step 1
  $opt('singleFound')?.classList.toggle('hidden', true);
  setText('wizFileSub', 'SEG-Y · SEG-D · SEG-2 / .dat (Geode) · SU - parsed off the UI thread, so big files stay responsive.');
  refreshSingleWizard();
  // batch UI back to empty
  $opt('batchFound')?.classList.toggle('hidden', true);
  $opt('batchProg')?.classList.toggle('hidden', true);
  $('batchFileList').innerHTML = '';
  setStatus('batchStatus', '');
  setText('batchProgSub', '');
  setText('wizFolderSub', 'Pick a folder; SeisConv lists every .segy/.sgy/.segd/.seg/.seg2/.dat/.bat/.su file in it.');
  setText('wizDestSub', 'Where the converted files are written.');
  const fill = $opt('batchProgFill');
  if (fill) (fill as HTMLElement).style.width = '0%';
  refreshWizard();
  updateNamePreview();
  setState('idle', 'Cleared');
  // labels back on the empty Trace / Section views
  setText('traceLabel', 'Open a file to inspect traces');
  setText('secLabel', 'Open a file to view the section');
  updateFileNav();       // disable Prev/Next + clear the 'file X / N' label
  renderTraceHeader();   // clear the trace-header table (lastTrace is now null)
}

// -- Universal "Clear" (header button) --
// One Clear button in the header, sitting next to "Open file…", clears the
// ACTIVE tab's data. The Converter / Trace Inspector / File Viewer all hang off
// the single open seismic file, so clearing any of them resets that file +
// every derived view via clearConverter(). The SPS, Velocity and Workbench tabs
// own independent state and clear only themselves.
const CLEAR_TIP: Record<Tab, string> = {
  conv: 'Clear file',
  trace: 'Clear file',
  section: 'Clear file',
  sps: 'Clear SPS',
  spscreate: 'Clear picks',
  geomqc: 'Clear file + SPS',
  vel: 'Clear picks',
  spectrum: 'Clear spectrum',
  workbench: 'Clear workbench',
  obslog: 'Clear log',
  sweeps: 'Clear sweep',
  field: 'Clear log',
};

/** Whether the active tab currently holds anything worth clearing - drives the
 *  header Clear button's disabled state so it reads as "nothing to clear". */
function activeTabHasData(tab: Tab): boolean {
  switch (tab) {
    case 'conv':
    case 'trace':
    case 'section':
      return !!summary;
    case 'sps':
      return !!spsSummary;
    case 'spscreate':
      return createLines.some((l) => l.points.length > 0);
    case 'geomqc':
      // Geometry QC reads the shared open seismic file + loaded SPS survey;
      // either present means there's something its Clear can drop.
      return !!summary || !!spsSummary;
    case 'vel':
      return !!velResult || velPicks.length > 0;
    case 'spectrum':
      return !!summary;
    case 'workbench':
      return wbTraces.length > 0;
    case 'obslog':
      return logRows.length > 0;
    case 'sweeps':
      return swResult !== null || swMeasured !== null;
    case 'field':
      return fieldLogLines.length > 0;
    default:
      return false;
  }
}

/** Clear the data of whichever tab is currently active. The data-dropping tabs
 *  (Velocity / Workbench / Observer Log) snapshot their in-memory state to a
 *  backup first so the user can roll back, and every clear is audited. */
function clearActiveTab() {
  switch (activeTab) {
    case 'conv':
    case 'trace':
    case 'section':
      void clearConverter();   // shared open file → reset file + all derived views
      audit('clear', 'cleared open file + derived views', 'conv');
      break;
    case 'sps':
      void clearSPS();
      audit('clear', 'cleared SPS survey', 'sps');
      break;
    case 'spscreate':
      audit('clear', `cleared the survey plan (${planTotalPoints()} points)`, 'spscreate');
      createClear();
      break;
    case 'geomqc':
      // The tab's inputs are the SHARED seismic file + SPS survey, so Clear drops
      // both (mirrors the Converter/SPS clears) and empties the result panels.
      void clearConverter();   // shared open file → reset file + all derived views
      void clearSPS();         // shared survey → reset survey + map/grid
      clearGeomqcResults();
      audit('clear', 'cleared geometry-QC inputs (file + SPS)', 'geomqc');
      break;
    case 'vel':
      if (velPicks.length) snapshotBackup('vel', velPicks, `${velPicks.length} velocity picks (before Clear)`);
      audit('clear', `cleared velocity (${velPicks.length} pick${velPicks.length === 1 ? '' : 's'})`, 'vel');
      clearVelocity();
      break;
    case 'spectrum':
      clearSpectrum();
      audit('clear', 'cleared spectrum view', 'spectrum');
      break;
    case 'workbench':
      if (wbTraces.length) snapshotBackup('workbench', wbTraces, `${wbTraces.length} traces (before Clear)`);
      audit('clear', `cleared workbench (${wbTraces.length} trace${wbTraces.length === 1 ? '' : 's'})`, 'workbench');
      wbClear();
      break;
    case 'obslog':
      void clearLogRows();   // own confirm + snapshot + audit
      break;
    case 'sweeps':
      audit('clear', 'cleared built sweep + measured trace', 'sweeps');
      swClear();
      break;
    case 'field': {
      fieldLogLines.length = 0;
      const box = $opt('fldLog'); if (box) box.textContent = '';
      audit('clear', 'cleared WiFiSync activity log', 'field');
      break;
    }
  }
  updateHeaderClear();
}

/** Sync the header Clear button's tooltip + disabled state to the active tab. */
function updateHeaderClear() {
  const btn = $opt('headerClearBtn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.title = CLEAR_TIP[activeTab] ?? 'Clear';
  btn.disabled = !activeTabHasData(activeTab);
}

// -- Trace Inspector --
async function refreshTrace() {
  if (!summary || summary.traceCount === 0) return;
  traceIndex = Math.max(0, Math.min(summary.traceCount - 1, traceIndex));
  try {
    lastTrace = await api.getTrace(traceIndex);
    traceFit(lastTrace); // reset the time-axis zoom window to the whole trace
    traceAmpRange = null; // a new trace starts on auto amplitude…
    traceAxisRange?.clear(); // …and clears any stale manual X/Y boxes
    ($('traceSlider') as HTMLInputElement).max = String(summary.traceCount - 1);
    ($('traceSlider') as HTMLInputElement).value = String(traceIndex);
    renderTrace();
  } catch (e) {
    $('traceLabel').textContent = 'Trace read failed: ' + errMsg(e);
  }
}

// -- Trace-header table -------------------------------------------------------
// Live, grouped key/value view of the per-trace SEG-Y header the worker already
// returns on `lastTrace.hdr`. Field keys below MUST match the names populated by
// the SEG-Y parser (core/formats/segy.ts) - anything absent is simply skipped.

type HdrFmt = 'int' | 'raw' | 'scaled' | 'gain' | 'mute' | 'traceId';
type HdrField = { key: string; label: string; fmt?: HdrFmt };
type HdrGroup = { title: string; fields: HdrField[] };

// SEG-Y data-use & trace-id enumerations, decoded to readable text.
const TRACE_ID_LABEL: Record<number, string> = {
  1: 'seismic', 2: 'dead', 3: 'dummy', 4: 'time-break', 5: 'uphole', 6: 'sweep',
  7: 'timing', 8: 'water-break', 9: 'near-gun', 11: 'pressure', 12: 'vert-vel',
};

const HDR_GROUPS: HdrGroup[] = [
  {
    title: 'Identification',
    fields: [
      { key: 'fieldRec', label: 'Field record (FFID)' },
      { key: 'trcField', label: 'Channel / trace no.' },
      { key: 'srcPt', label: 'Shotpoint' },
      { key: 'ensemble', label: 'Ensemble / CDP' },
      { key: 'trcEns', label: 'Trace in ensemble' },
      { key: 'seqLine', label: 'Seq. no. in line' },
      { key: 'seqFile', label: 'Seq. no. in file' },
      { key: 'traceId', label: 'Trace ID', fmt: 'traceId' },
      { key: 'dataUse', label: 'Data use' },
    ],
  },
  {
    title: 'Geometry',
    fields: [
      { key: 'offset', label: 'Source-receiver offset' },
      { key: 'srcX', label: 'Source X', fmt: 'scaled' },
      { key: 'srcY', label: 'Source Y', fmt: 'scaled' },
      { key: 'rcvX', label: 'Group X', fmt: 'scaled' },
      { key: 'rcvY', label: 'Group Y', fmt: 'scaled' },
      { key: 'srcDepth', label: 'Source depth' },
      { key: 'rcvElev', label: 'Receiver elevation' },
      { key: 'surfElev', label: 'Surface elevation @ src' },
      { key: 'elevScalar', label: 'Elevation scalar', fmt: 'raw' },
      { key: 'coordScalar', label: 'Coordinate scalar', fmt: 'raw' },
      { key: 'coordUnit', label: 'Coordinate units', fmt: 'raw' },
    ],
  },
  {
    title: 'Timing',
    fields: [
      { key: 'nSamples', label: 'Samples in trace' },
      { key: 'sampInt', label: 'Sample interval (µs)' },
      { key: 'muteStart', label: 'Mute start', fmt: 'mute' },
      { key: 'muteEnd', label: 'Mute end', fmt: 'mute' },
      { key: 'year', label: 'Recording year', fmt: 'raw' },
      { key: 'day', label: 'Day of year', fmt: 'raw' },
      { key: '__time', label: 'Recording time' },
    ],
  },
  {
    title: 'Gain & filter',
    fields: [
      { key: 'gainType', label: 'Gain type', fmt: 'gain' },
      { key: 'gainConst', label: 'Gain constant (dB)' },
      { key: 'lowCut', label: 'Low-cut (Hz)' },
      { key: 'highCut', label: 'High-cut (Hz)' },
      { key: 'traceWeight', label: 'Trace weighting' },
    ],
  },
];

const GAIN_TYPE_LABEL: Record<number, string> = { 1: 'fixed', 2: 'binary', 3: 'floating' };

function hdrNum(h: Record<string, number | string>, k: string): number | null {
  const v = h[k];
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
}

/** Two zero-padded digits. */
function pad2(n: number): string { return String(n).padStart(2, '0'); }

/** Format one header field → display string, or null to omit (blank/zero where it carries no meaning). */
function fmtHdrField(h: Record<string, number | string>, f: HdrField): string | null {
  // Composite recording time HH:MM:SS, built from hour/minute/second.
  if (f.key === '__time') {
    const hh = hdrNum(h, 'hour'), mm = hdrNum(h, 'minute'), ss = hdrNum(h, 'second');
    if (hh == null && mm == null && ss == null) return null;
    if (!hh && !mm && !ss) return null;
    return `${pad2(hh ?? 0)}:${pad2(mm ?? 0)}:${pad2(ss ?? 0)}`;
  }
  const v = hdrNum(h, f.key);
  if (v == null) return null;
  switch (f.fmt) {
    case 'raw': // show even zeros (scalars/units/dates are meaningful at 0)
      return grp(v);
    case 'traceId':
      return TRACE_ID_LABEL[v] ? `${v} · ${TRACE_ID_LABEL[v]}` : grp(v);
    case 'gain':
      return GAIN_TYPE_LABEL[v] ? `${v} · ${GAIN_TYPE_LABEL[v]}` : (v === 0 ? null : grp(v));
    case 'mute':
      return v === 0 ? null : `${grp(v)} ms`;
    case 'scaled': // coordinate - apply the SEG-Y coordinate scalar, but only if set
      if (v === 0) return null;
      return grp(applyCoordScalar(v, hdrNum(h, 'coordScalar')));
    default: // 'int' - omit unset (0) numeric fields to keep the table tidy
      return v === 0 ? null : grp(v);
  }
}

/** Apply the SEG-Y coordinate scalar convention: +n multiplies, -n divides. */
function applyCoordScalar(v: number, scalar: number | null): number {
  if (scalar == null || scalar === 0) return v;
  return scalar > 0 ? v * scalar : v / -scalar;
}

/** Render the active trace's SEG-Y header into the grouped table. */
function renderTraceHeader() {
  const grid = $opt('traceHdrGrid');
  const tag = $opt('traceHdrTrace');
  if (!grid) return;
  if (!summary || !lastTrace) {
    grid.innerHTML = '<div class="hdr-empty">Open a file and pick a trace to view its header.</div>';
    if (tag) tag.textContent = '-';
    return;
  }
  const h = lastTrace.hdr || {};
  if (tag) tag.textContent = `Trace ${lastTrace.index + 1} / ${summary.traceCount}`;
  grid.innerHTML = '';
  let anyField = false;
  for (const group of HDR_GROUPS) {
    const rows: { label: string; value: string }[] = [];
    for (const f of group.fields) {
      const val = fmtHdrField(h, f);
      if (val == null) continue;
      rows.push({ label: f.label, value: val });
    }
    if (!rows.length) continue;
    anyField = true;
    const sec = document.createElement('div');
    sec.className = 'hdr-grp';
    const h3 = document.createElement('h3');
    h3.textContent = group.title;
    sec.appendChild(h3);
    for (const r of rows) {
      const kv = document.createElement('div');
      kv.className = 'kv';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = r.label;
      const v = document.createElement('span');
      v.className = 'v mono';
      v.textContent = r.value;
      kv.appendChild(k);
      kv.appendChild(v);
      sec.appendChild(kv);
    }
    grid.appendChild(sec);
  }
  if (!anyField) grid.innerHTML = '<div class="hdr-empty">This trace carries no populated header fields.</div>';
}

/** Draw the active trace in the current mode (waveform or amplitude spectrum). */
function renderTrace() {
  if (!summary || !lastTrace) return;
  const cv = $('traceCanvas') as HTMLCanvasElement;
  const t = lastTrace;
  if (traceMode === 'spectrum') {
    // Single-trace amplitude spectrum, drawn by the SHARED renderer (same fn the
    // Spectrum tab's Average view uses).
    const sp = (t.nSamples && t.samples.length)
      ? amplitudeSpectrum(t.samples, t.sampleInt)
      : { freqs: new Float32Array(0), amp: new Float32Array(0), nyquist: t.sampleInt > 0 ? 1e6 / t.sampleInt / 2 : 0 };
    drawSpectrum(cv, sp);
    const ny = t.sampleInt > 0 ? 1e6 / t.sampleInt / 2 : 0;
    $('traceLabel').textContent = `Trace ${t.index + 1} / ${summary.traceCount}  ·  spectrum 0-${ny.toFixed(0)} Hz`;
  } else {
    drawTrace(cv, t);
    syncTraceAxisPlaceholders(); // reflect the live time/amplitude window in the boxes
    $('traceLabel').textContent = `Trace ${t.index + 1} / ${summary.traceCount}  ·  ${t.nSamples} samples`;
  }
  // Header table tracks the active trace regardless of plot mode.
  renderTraceHeader();
}

function setTraceMode(m: 'wave' | 'spectrum') {
  if (traceMode === m) return;
  traceMode = m;
  $('traceWave').classList.toggle('on', m === 'wave');
  $('traceSpec').classList.toggle('on', m === 'spectrum');
  // Box-zoom + the time/amplitude hover read-out are waveform-only; leaving wave
  // mode disarms the magnifier and resets the caption.
  if (m === 'spectrum' && traceBoxMode) setTraceBoxMode(false);
  clearTraceHover();
  renderTrace();
}

function drawTrace(cv: HTMLCanvasElement, t: TraceData) {
  // The Inspector paints its live zoom window + manual amplitude override; the
  // shared core does the actual drawing so the zoom viewer can reuse it with an
  // explicit window / amplitude range without disturbing the Inspector's state.
  if (!traceView.init || traceView.fullS !== t.nSamples) traceFit(t);
  drawTraceCore(cv, t, traceView.s0, traceView.s1, traceAmpRange);
}

/** The shared 6-line time grid for the single-trace canvases (ms down the left
 *  edge). Identical in the Inspector, the box-zoom viewer, the workbench and the
 *  comparison plot; extracted verbatim so the four stay in step. */
function drawMsTimeGrid(ctx: CanvasRenderingContext2D, ML: number, MT: number, pw: number, ph: number, s0: number, denom: number, msPerSample: number) {
  for (let k = 0; k <= 5; k++) {
    const y = MT + (ph * k) / 5;
    const sampleAt = s0 + (denom * k) / 5;
    ctx.fillText((sampleAt * msPerSample).toFixed(0) + ' ms', 6, y + 3);
    ctx.strokeStyle = '#173049';
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + pw, y); ctx.stroke();
  }
}

/** Paint one trace into `cv` over the sample window [s0,s1) with an optional raw
 *  amplitude window (null ⇒ auto-normalize per the visible window). Every input
 *  is re-guarded here (finite, clamped, min<max) so no NaN reaches the canvas -
 *  the single trace renderer shared by the Inspector and the box-zoom viewer. */
function drawTraceCore(
  cv: HTMLCanvasElement, t: TraceData,
  s0in: number, s1in: number, ampRange: { min: number; max: number } | null,
) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800;
  const H = cv.clientHeight || 460;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);
  const n = t.nSamples;
  if (!n || !t.samples.length) return;

  // Visible sample window [s0,s1) within the full trace (re-clamped to the data).
  const s0 = Math.max(0, Math.min(n - 1, Math.floor(Number.isFinite(s0in) ? s0in : 0)));
  const s1 = Math.max(s0 + 1, Math.min(n, Math.ceil(Number.isFinite(s1in) ? s1in : n)));
  const span = s1 - s0;
  if (span < 1) return;

  const ML = TRC_ML, MR = TRC_MR, MT = TRC_MT, MB = TRC_MB;
  const pw = W - ML - MR, ph = H - MT - MB;
  const cx = ML + pw / 2;
  // Renormalize over the VISIBLE window so zoom shows local detail at full swing.
  const nf = normFactorPercentile(t.samples.subarray(s0, s1), 0.95) || 1;

  // X (amplitude) axis: auto-normalized about the centre axis, OR a manual raw
  // [ampMin,ampMax] window stretched across the plot width. The manual range is
  // pre-guarded (finite, min<max) by the control helper, so xOfAmp never returns
  // NaN; we still clamp to the plot rect so an out-of-range sample can't draw off
  // the canvas. `amp0x` is the x-pixel of amplitude 0 (the wiggle's baseline).
  const useAmp = ampRange !== null;
  const aMin = ampRange ? ampRange.min : 0;
  const aSpan = ampRange ? (ampRange.max - ampRange.min) : 1;
  const xOfAmp = (raw: number) => {
    if (useAmp) {
      const f = Math.max(0, Math.min(1, (raw - aMin) / aSpan));
      return ML + f * pw;
    }
    const v = Math.max(-1, Math.min(1, raw / nf));
    return cx + v * (pw / 2 - 2);
  };
  const amp0x = Math.max(ML, Math.min(ML + pw, xOfAmp(0)));

  ctx.strokeStyle = '#214564';
  ctx.lineWidth = 1;
  ctx.strokeRect(ML, MT, pw, ph);
  ctx.beginPath();
  ctx.moveTo(amp0x, MT);
  ctx.lineTo(amp0x, MT + ph);
  ctx.strokeStyle = '#264a68';
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = '#34dbd0';
  ctx.lineWidth = 1;
  const denom = span > 1 ? span - 1 : 1; // map sample i∈[s0,s1) → y over the plot height
  for (let i = s0; i < s1; i++) {
    const x = xOfAmp(t.samples[i]);
    const y = MT + ((i - s0) / denom) * ph;
    if (i === s0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // time axis (ms down) - labels reflect the visible window [s0,s1)
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  const msPerSample = t.sampleInt / 1000;
  drawMsTimeGrid(ctx, ML, MT, pw, ph, s0, denom, msPerSample);

  // amplitude (X) axis ticks - make the horizontal swing readable. Three ticks:
  // left edge / centre / right edge, showing the ACTUAL sample amplitude at that
  // x. In auto mode the plotted swing is the normalized window ±nf (left=-nf,
  // right=+nf, centre≈0); in manual mode the plot width spans [aMin,aMax]. SEG-Y/
  // SEG-D samples are dimensionless, so the caption says 'Amplitude' - no unit.
  // All values are guarded finite before formatting so no NaN reaches the canvas.
  const ampLeft = useAmp ? aMin : -nf;
  const ampRight = useAmp ? aMin + aSpan : nf;
  const ampMid = (ampLeft + ampRight) / 2;
  const fmtAmp = (v: number) => {
    if (!Number.isFinite(v)) return '-';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-3) return v.toExponential(1);
    return v.toPrecision(3);
  };
  const ampTicks: Array<{ x: number; v: number; align: CanvasTextAlign }> = [
    { x: ML + 2, v: ampLeft, align: 'left' },
    { x: ML + pw / 2, v: ampMid, align: 'center' },
    { x: ML + pw - 2, v: ampRight, align: 'right' },
  ];
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  ctx.textAlign = 'left';
  for (const tk of ampTicks) {
    ctx.textAlign = tk.align;
    ctx.fillText(fmtAmp(tk.v), tk.x, MT + 11);
  }
  // Honest axis caption (dimensionless sample value - NOT a physical unit).
  ctx.fillStyle = '#5f7793';
  ctx.textAlign = 'center';
  ctx.fillText('Amplitude (sample value)', ML + pw / 2, MT + ph - 4);
  ctx.textAlign = 'left';
}

/** A frequency-domain spectrum: parallel freqs/amp arrays + the Nyquist edge.
 *  Matches core's `Spectrum` (and the worker's avgSpectrum payload) so ONE
 *  renderer (drawSpectrum) serves both the Trace Inspector and the Spectrum tab. */
type SpectrumLike = { freqs: Float32Array; amp: Float32Array; nyquist: number };

/**
 * Amplitude-vs-frequency plot of a {@link SpectrumLike}. Shared by the Trace
 * Inspector (single-trace spectrum) and the Spectrum tab's Average view, so the
 * two render identically. `opts.dB` switches the amplitude axis to decibels
 * (20·log10(amp/peak)); `opts.label` is an optional caption drawn top-right.
 * Marks the peak frequency and the -6 dB (half-amplitude) bandwidth.
 */
function drawSpectrum(
  cv: HTMLCanvasElement,
  sp: SpectrumLike,
  opts: {
    dB?: boolean;
    label?: string;
    // Optional manual axis window (Spectrum tab's Average view). Each edge null ⇒
    // auto (X = 0..nyquist; Y = data peak / FLOOR_DB..0 in dB). Y values are in the
    // CURRENTLY displayed unit (linear amplitude, or dB) so the boxes match the axis.
    fMin?: number | null; fMax?: number | null;
    aMin?: number | null; aMax?: number | null;
  } = {},
) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800, H = cv.clientHeight || 460;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0f2540'); bg.addColorStop(1, '#0b1a2c');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  if (!sp.amp.length) {
    ctx.fillStyle = '#5e7186'; ctx.font = '13px Consolas, monospace'; ctx.textAlign = 'center';
    ctx.fillText('No spectrum to show', W / 2, H / 2); ctx.textAlign = 'left';
    return;
  }

  const dB = !!opts.dB;
  const ML = 56, MR = 16, MT = 18, MB = 28;
  const pw = W - ML - MR, ph = H - MT - MB;
  const fmax = sp.nyquist || 1;
  // Linear peak amplitude (skip DC at k=0) → reference for both peak + dB scale.
  let amax = 0, pk = 1;
  for (let k = 1; k < sp.amp.length; k++) if (sp.amp[k] > amax) { amax = sp.amp[k]; pk = k; }
  if (amax <= 0) amax = 1;
  // Plot value: linear amplitude, or dB relative to the peak (floored at FLOOR_DB).
  const FLOOR_DB = -60;
  const toPlot = (a: number) => (dB ? Math.max(FLOOR_DB, 20 * Math.log10((a > 0 ? a : 1e-12) / amax)) : a);
  // X (frequency) window: auto 0..nyquist, or the manual edges when supplied.
  // Guarded so an invalid/degenerate pair silently falls back to the auto extent.
  let fLo = (typeof opts.fMin === 'number' && Number.isFinite(opts.fMin)) ? opts.fMin : 0;
  let fHi = (typeof opts.fMax === 'number' && Number.isFinite(opts.fMax)) ? opts.fMax : fmax;
  if (!(fHi > fLo)) { fLo = 0; fHi = fmax; }
  const fSpan = fHi - fLo || 1;
  // Y (amplitude) window: auto FLOOR_DB..0 (dB) or 0..peak (linear), or manual
  // edges (already in the displayed unit). Same finite + lo<hi guard.
  let vmin = dB ? FLOOR_DB : 0;
  let vmax = dB ? 0 : amax;
  const haveA = typeof opts.aMin === 'number' && Number.isFinite(opts.aMin) &&
    typeof opts.aMax === 'number' && Number.isFinite(opts.aMax) && (opts.aMax as number) > (opts.aMin as number);
  if (haveA) { vmin = opts.aMin as number; vmax = opts.aMax as number; }
  const Xf = (f: number) => ML + ((f - fLo) / fSpan) * pw;
  const Yf = (a: number) => { const y = MT + ph - ((toPlot(a) - vmin) / (vmax - vmin)) * ph; return y < MT ? MT : y > MT + ph ? MT + ph : y; };

  // frequency gridlines + labels (over the visible [fLo,fHi] window)
  ctx.font = '10px Consolas, monospace'; ctx.lineWidth = 1;
  const fStep = niceStep(fSpan, 8);
  const fStart = Math.ceil(fLo / fStep) * fStep;
  for (let f = fStart; f <= fHi + 1e-6; f += fStep) {
    const x = Xf(f); if (x < ML - 0.5 || x > ML + pw + 0.5) continue;
    ctx.strokeStyle = 'rgba(33,69,100,0.45)';
    ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + ph); ctx.stroke();
    ctx.fillStyle = '#5e7186'; ctx.fillText(f.toFixed(0), x + 2, H - 8);
  }
  // amplitude gridlines + labels (dB or linear), over the visible [vmin,vmax]
  for (let g = 0; g <= 4; g++) {
    const y = MT + (ph * g) / 4;
    ctx.strokeStyle = 'rgba(33,69,100,0.45)';
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + pw, y); ctx.stroke();
    const v = vmax - ((vmax - vmin) * g) / 4;
    ctx.fillStyle = '#5e7186'; ctx.fillText(dB ? v.toFixed(0) : v.toPrecision(2), 4, y + 3);
  }

  // Clip the curve + markers to the plot rect so a windowed X/Y never paints
  // outside the axes (the gridlines/labels above are already bounded).
  ctx.save();
  ctx.beginPath(); ctx.rect(ML, MT, pw, ph); ctx.clip();

  // filled spectrum curve
  ctx.beginPath();
  ctx.moveTo(Xf(0), MT + ph);
  for (let k = 0; k < sp.amp.length; k++) ctx.lineTo(Xf(sp.freqs[k]), Yf(sp.amp[k]));
  ctx.lineTo(Xf(sp.freqs[sp.freqs.length - 1]), MT + ph);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, MT, 0, MT + ph);
  fill.addColorStop(0, 'rgba(52,219,208,0.42)'); fill.addColorStop(1, 'rgba(52,219,208,0.04)');
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = '#34dbd0'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let k = 0; k < sp.amp.length; k++) {
    const x = Xf(sp.freqs[k]), y = Yf(sp.amp[k]);
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // -6 dB (half-amplitude) bandwidth: the freqs where amp first/last crosses
  // amax/2, bracketing the peak. Shaded band + dashed edges.
  const halfA = amax * 0.5;
  let lo = pk, hi = pk;
  while (lo > 0 && sp.amp[lo] >= halfA) lo--;
  while (hi < sp.amp.length - 1 && sp.amp[hi] >= halfA) hi++;
  const bandLo = sp.freqs[lo], bandHi = sp.freqs[hi];
  if (bandHi > bandLo) {
    ctx.fillStyle = 'rgba(255,180,84,0.10)';
    ctx.fillRect(Xf(bandLo), MT, Xf(bandHi) - Xf(bandLo), ph);
    ctx.strokeStyle = 'rgba(255,180,84,0.7)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    for (const f of [bandLo, bandHi]) { ctx.beginPath(); ctx.moveTo(Xf(f), MT); ctx.lineTo(Xf(f), MT + ph); ctx.stroke(); }
    ctx.setLineDash([]);
  }

  // peak marker
  const pkx = Xf(sp.freqs[pk]), pky = Yf(sp.amp[pk]);
  ctx.fillStyle = '#1fc8c0'; ctx.beginPath(); ctx.arc(pkx, pky, 3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#c8d2e0'; ctx.font = '11px "Segoe UI", sans-serif';
  ctx.fillText(`peak ${sp.freqs[pk].toFixed(1)} Hz`, Math.min(pkx + 6, W - 92), Math.max(pky - 6, MT + 12));
  if (bandHi > bandLo) {
    ctx.fillStyle = '#ffb454';
    ctx.fillText(`-6 dB band ${bandLo.toFixed(1)}-${bandHi.toFixed(1)} Hz`, ML + 4, MT + ph - 6);
  }

  // axis title + caption
  ctx.fillStyle = '#7e93ac'; ctx.font = '10px Consolas, monospace';
  ctx.fillText('Frequency (Hz) →', ML, MT - 6);
  ctx.fillText(dB ? 'dB ↑' : 'amp ↑', 4, MT - 6);
  if (opts.label) {
    ctx.fillStyle = '#9fb0c4'; ctx.font = '11px "Segoe UI", sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(opts.label, W - MR, MT - 6); ctx.textAlign = 'left';
  }
}

// -- Manual axis-range controls (reusable across viewers) --
// A compact toolbar group of four numeric inputs (X-min / X-max / Y-min / Y-max)
// plus an "Auto" button that clears them and reverts to the viewer's auto-fit.
// The controls COMPLEMENT the existing wheel/drag zoom: typing an exact window
// and zooming both write the same view-state, so they stay consistent. Each axis
// is independent - leaving an axis blank (or typing an invalid pair) keeps THAT
// axis on auto while the other can still be overridden.
//
// The helper is purely about the UI: it parses + guards the inputs and hands the
// caller a clean {xMin,xMax,yMin,yMax} (each number-or-null) on every change, then
// the caller maps those displayed units into its own view-state and redraws. It
// owns no view-state itself, so it works for both the index-windowed viewers
// (Section/Trace) and any future payload-derived viewer.

/** One parsed axis override: a finite [min,max) with min<max, or null for auto. */
type AxisRange = { min: number; max: number } | null;
/** The four-axis override set handed to a viewer on every change. */
type AxisRangeValue = { xMin: number | null; xMax: number | null; yMin: number | null; yMax: number | null };

interface AxisRangeOptions {
  /** Axis captions shown before each pair, e.g. 'Trace #', 'Time (ms)', 'Amp'. */
  xLabel: string;
  yLabel: string;
  /** Called whenever a value is committed (Enter / blur) or "Auto" is pressed. */
  onChange: (v: AxisRangeValue) => void;
  /** Per-input `step` attribute (default 'any'); use '1' for integer axes. */
  xStep?: string;
  yStep?: string;
}

/** A live handle returned by axisRangeControls(): read the current overrides or
 *  push the live effective extent into the boxes so the user always sees (and the
 *  native steppers increment from) the current range. */
interface AxisRangeHandle {
  /** Current parsed overrides (each axis null when untouched / invalid). Only an
   *  axis the user actually edited counts as an override; an axis still showing
   *  the synced auto extent reads back as null = auto. */
  value(): AxisRangeValue;
  /** Reflect the live effective extent (auto-fit or current zoom window) into the
   *  boxes. Updates the real `.value` of every edge the user has NOT edited (so the
   *  number is visible and the spinner steps from it); user-edited edges are left
   *  intact. Despite the legacy name it no longer touches `placeholder`. */
  setPlaceholders(xMin: number, xMax: number, yMin: number, yMax: number): void;
  /** Clear all four boxes + edited flags and revert to auto (does NOT fire onChange). */
  clear(): void;
}

/** Build the reusable X/Y manual-range control group inside `host` and return a
 *  handle. All numeric guarding lives here so callers only ever see finite,
 *  ordered ranges (or null = auto).
 *
 *  Each input always SHOWS the current effective range (kept in sync via
 *  setPlaceholders after every fit / zoom / file change) so the native up/down
 *  steppers increment from the live value rather than from 0. An edge is treated
 *  as a manual override only once the user actually edits it ("dirty"); an edge
 *  still showing the synced extent reads back as auto. When the user edits only
 *  one edge of a pair, the partner edge is seeded from the value currently shown
 *  in its box, so a single-field edit still applies instead of being discarded. */
function axisRangeControls(host: HTMLElement, opts: AxisRangeOptions): AxisRangeHandle {
  host.classList.add('axrange');
  // Per-input "the user typed/stepped this" flag. Synced extent values do NOT set
  // it (so they stay auto); real user input does.
  const dirty = new WeakSet<HTMLInputElement>();
  // Last extent pushed in via setPlaceholders, kept per-edge. readPair seeds an
  // UN-edited partner edge from this stored extent rather than from the box's live
  // `.value`: after a wheel-zoom the box shows the transient zoom window, and a lone
  // native-stepper edit on the OTHER edge would otherwise capture that zoom as a
  // manual override. Seeding the partner from the synced extent (the same number the
  // box was last set to, not whatever a stepper nudged it to) keeps a single-edge
  // edit applying without pinning a stale value the user never touched.
  const ext = new WeakMap<HTMLInputElement, number>();
  const mk = (ph: string, step: string) => {
    const el = document.createElement('input');
    el.type = 'number';
    el.className = 'axin';
    el.placeholder = ph;
    el.step = step;
    el.setAttribute('aria-label', ph);
    return el;
  };
  const xStep = opts.xStep ?? 'any', yStep = opts.yStep ?? 'any';
  const xLab = document.createElement('span'); xLab.className = 'axlbl'; xLab.textContent = opts.xLabel;
  const xLo = mk('min', xStep), xHi = mk('max', xStep);
  const yLab = document.createElement('span'); yLab.className = 'axlbl'; yLab.textContent = opts.yLabel;
  const yLo = mk('min', yStep), yHi = mk('max', yStep);
  // The Y axis carries amplitudes, which run far longer than a time in ms
  // (-1234.5678, 1.23e-7). They get a wider box so the value is not clipped.
  yLo.classList.add('axin-y');
  yHi.classList.add('axin-y');
  const sep1 = document.createElement('span'); sep1.className = 'axsep'; sep1.textContent = '-';
  const sep2 = document.createElement('span'); sep2.className = 'axsep'; sep2.textContent = '-';
  const auto = document.createElement('button');
  auto.type = 'button'; auto.className = 'axauto'; auto.textContent = 'Auto';
  auto.title = 'Clear the manual ranges and revert to auto-fit';
  host.append(xLab, xLo, sep1, xHi, yLab, yLo, sep2, yHi, auto);

  /** A finite number parsed from a box, or null when blank / garbage. */
  const num = (el: HTMLInputElement): number | null => {
    const s = el.value.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  // Parse one axis pair, honouring the override + seeding rules:
  //  - Neither edge edited ⇒ null (axis stays auto, even though both boxes show
  //    the synced extent).
  //  - At least one edge edited ⇒ build a pair, seeding any un-edited edge from
  //    the value currently shown in its box (the live extent), so a lone edit
  //    still applies. The result is guarded (finite, min<max) and otherwise null.
  // Value of an edge for range-building: the user's typed value when dirty, else
  // the stored synced extent (NOT the box's current `.value`, which a stepper may
  // have nudged off the synced extent - see `ext`). Falls back to the box value
  // when no extent was ever synced.
  const edgeVal = (el: HTMLInputElement): number | null => {
    if (dirty.has(el)) return num(el);
    const e = ext.get(el);
    return e !== undefined && Number.isFinite(e) ? e : num(el);
  };
  const readPair = (lo: HTMLInputElement, hi: HTMLInputElement): AxisRange => {
    if (!dirty.has(lo) && !dirty.has(hi)) return null;
    const a = edgeVal(lo), b = edgeVal(hi);
    if (a === null || b === null) return null; // a seeded edge can never be NaN here
    if (a >= b) return null;                   // inverted / zero-width ⇒ stay auto
    return { min: a, max: b };
  };

  const read = (): AxisRangeValue => {
    const x = readPair(xLo, xHi), y = readPair(yLo, yHi);
    return {
      xMin: x ? x.min : null, xMax: x ? x.max : null,
      yMin: y ? y.min : null, yMax: y ? y.max : null,
    };
  };
  // An edited pair whose two edges don't form a valid range (one edge blank, or
  // min>=max) is flagged on both boxes so the user sees their value was not yet
  // applied. Pure visual; readPair already kept it off the canvas.
  const flagIncomplete = () => {
    const mark = (lo: HTMLInputElement, hi: HTMLInputElement) => {
      const edited = dirty.has(lo) || dirty.has(hi);
      const valid = readPair(lo, hi) !== null;
      const bad = edited && !valid;
      lo.classList.toggle('axin-incomplete', bad);
      hi.classList.toggle('axin-incomplete', bad);
    };
    mark(xLo, xHi); mark(yLo, yHi);
  };
  const fire = () => { flagIncomplete(); opts.onChange(read()); };
  // Live: mark the touched edge dirty (or, if the user emptied it, drop the flag
  // so it cleanly reverts to the synced auto extent), then redraw on every input
  // (typing / stepper), not just on commit, so editing feels immediate.
  const onUserEdit = (el: HTMLInputElement) => {
    if (el.value.trim() === '') dirty.delete(el); else dirty.add(el);
    fire();
  };
  for (const el of [xLo, xHi, yLo, yHi]) {
    el.addEventListener('input', () => onUserEdit(el));
    el.addEventListener('change', () => onUserEdit(el));
    el.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); onUserEdit(el); } });
  }
  const clearBoxes = () => {
    for (const el of [xLo, xHi, yLo, yHi]) { dirty.delete(el); el.value = ''; el.classList.remove('axin-incomplete'); }
  };
  auto.addEventListener('click', () => { clearBoxes(); fire(); });

  return {
    value: read,
    setPlaceholders(xMin, xMax, yMin, yMax) {
      // Show the live extent in every edge the user hasn't edited, as the real
      // `.value` so it is visible and the native stepper increments from it.
      // Edited (dirty) edges keep whatever the user typed.
      const put = (el: HTMLInputElement, v: number) => {
        if (!Number.isFinite(v)) return;
        // Round to a tidy step: integer axes to whole numbers, else 2 decimals.
        const r = el.step === '1' ? Math.round(v) : Math.round(v * 100) / 100;
        // Record the synced extent for EVERY edge (even dirty ones) so readPair can
        // seed an un-edited partner from it rather than from a stepper-nudged box.
        ext.set(el, r);
        if (dirty.has(el)) return; // keep the user's typed value visible
        const s = String(r);
        if (el.value !== s) el.value = s;
      };
      put(xLo, xMin); put(xHi, xMax); put(yLo, yMin); put(yHi, yMax);
    },
    clear: clearBoxes,
  };
}

// -- File Viewer (section) --
// Plot-rectangle margins (shared by drawSection + the data-zoom interactions so
// a cursor pixel maps to the exact same data window the renderer paints).
const SEC_ML = 58, SEC_MR = 12, SEC_MT = 10, SEC_MB = 24;
// Trace Inspector plot-rectangle margins - shared by drawTraceCore, the hover
// read-out and the box-zoom region math so a cursor pixel maps to the exact same
// sample/amplitude the renderer paints.
const TRC_ML = 60, TRC_MR = 14, TRC_MT = 14, TRC_MB = 26;

/** Reset the data-zoom window (called on open / AGC change / fit). For a normal
 *  file this fits the whole record; for a streamed/tape-image file it snaps to the
 *  FIRST block of traces (full detail, fast) - the trace-paging buttons then step
 *  block by block, since fitting a multi-GB file's whole record would decimate it
 *  to mush and the "next file" idea makes no sense inside one giant archive. */
function secFit() {
  if (!summary) return;
  secView.fullT = summary.traceCount;
  secView.fullS = summary.samplesTrace ?? lastSection?.fullSamples ?? 0;
  secView.s0 = 0;
  secView.s1 = secView.fullS;
  if (summary.streamed) {
    const page = secPageSize();
    secView.t0 = 0;
    secView.t1 = Math.min(secView.fullT, page);
  } else {
    secView.t0 = 0;
    secView.t1 = secView.fullT;
  }
  secView.init = true;
}

/** Keep the visible window inside the record (never pan/zoom off the data). */
function secClamp() {
  const fT = secView.fullT, fS = secView.fullS;
  // Minimum window: a few traces / samples so we can't zoom into nothing.
  const minT = Math.min(fT, 2), minS = Math.min(fS, 4);
  let { t0, t1, s0, s1 } = secView;
  if (t1 - t0 < minT) t1 = t0 + minT;
  if (s1 - s0 < minS) s1 = s0 + minS;
  if (t1 - t0 > fT) { t0 = 0; t1 = fT; }
  if (s1 - s0 > fS) { s0 = 0; s1 = fS; }
  if (t0 < 0) { t1 -= t0; t0 = 0; }
  if (t1 > fT) { t0 -= t1 - fT; t1 = fT; }
  if (s0 < 0) { s1 -= s0; s0 = 0; }
  if (s1 > fS) { s0 -= s1 - fS; s1 = fS; }
  secView.t0 = Math.max(0, Math.round(t0));
  secView.t1 = Math.min(fT, Math.round(t1));
  secView.s0 = Math.max(0, Math.round(s0));
  secView.s1 = Math.min(fS, Math.round(s1));
}

/** Re-request the current visible window at full detail and repaint. Coalesces
 *  bursts of wheel/drag events so the worker is never flooded. */
async function fetchSectionWindow() {
  if (!summary || summary.traceCount === 0) return;
  if (secFetchPending) return; // a fetch is in flight; it will repaint with the latest secView on completion
  secFetchPending = true;
  const agc = ($('secAgc') as HTMLInputElement).checked;
  try {
    let again = true;
    let snap = '';
    while (again) {
      secClamp();
      snap = `${secView.t0},${secView.t1},${secView.s0},${secView.s1}`;
      const sec = await api.getSection({
        maxTraces: 2000, maxSamples: 2000,
        traceStart: secView.t0, traceEnd: secView.t1, sampStart: secView.s0, sampEnd: secView.s1,
        agc, agcType: 'rms', agcWindowMs: 250,
      });
      lastSection = sec;
      // Worker echoes the window it actually used (clamped to real trace lengths);
      // mirror it so axis labels + interactions stay perfectly in sync.
      secView.t0 = sec.traceStart; secView.t1 = sec.traceEnd;
      secView.s0 = sec.sampStart; secView.s1 = sec.sampEnd;
      secView.fullT = sec.fullTraces; secView.fullS = sec.fullSamples;
      drawSection($('secCanvas') as HTMLCanvasElement, sec);
      syncSecAxisPlaceholders(); // reflect the actual window in the manual-range boxes
      updateSecPaging();         // keep the trace-paging label/buttons in sync with the painted window
      const zoomed = sec.traceStart > 0 || sec.traceEnd < sec.fullTraces || sec.sampStart > 0 || sec.sampEnd < sec.fullSamples;
      $('secLabel').textContent =
        `${sec.numTraces} traces (step ${sec.traceStep}) · ${sec.colLen} samples` +
        (zoomed ? ` · tr ${sec.traceStart}-${sec.traceEnd} · smp ${sec.sampStart}-${sec.sampEnd}` : '');
      // If the user kept interacting while we awaited, secView changed - fetch again.
      again = `${secView.t0},${secView.t1},${secView.s0},${secView.s1}` !== snap;
    }
  } catch (e) {
    $('secLabel').textContent = 'Render failed: ' + errMsg(e);
  } finally {
    secFetchPending = false;
  }
}

async function refreshSection() {
  secHealthUpdateButtons(); // enable/disable Health-scan controls for the current file
  fbUpdateButtons();        // enable/disable First-breaks controls for the current file
  if (!summary || summary.traceCount === 0) return;
  $('secLabel').textContent = 'Rendering…';
  secHoverHdrCache.clear(); secHoverLastIdx = -1; // new file / re-fit ⇒ drop stale FFID suffixes
  secFit(); // open / AGC toggle / re-open ⇒ start fitted to the whole record
  secAxisRange?.clear(); // new file / re-fit ⇒ clear any stale manual X/Y boxes
  await fetchSectionWindow();
}

function redrawSection() {
  if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection);
}

function drawSection(cv: HTMLCanvasElement, sec: SectionData) {
  const mode = ($('secMode') as HTMLSelectElement).value;
  const cmap = ($('secColor') as HTMLSelectElement).value;
  const gain = parseFloat(($('secGain') as HTMLInputElement).value) || 1;
  const rect = paintSection(cv, sec, mode, cmap, gain);
  // Re-overlay any trace-health flags so they survive zoom/pan/redraws.
  if (rect && secHealth && secHealth.byAbs.size) secDrawHealthOverlay(cv, sec, rect);
  // First-breaks overlay (guide + ±window band + pick line) - only in that mode.
  if (rect && fbMode) secDrawFbOverlay(cv, sec, rect);
}

/** Paint a decimated section matrix (VD / wiggle / VA / VD+wiggle) + the time and
 *  trace-index axes onto `cv` with the given display controls. Returns the plot
 *  rectangle (so callers can map data→pixels), or null when there is nothing to
 *  draw. Used by the File Viewer (drawSection). */
function paintSection(cv: HTMLCanvasElement, sec: SectionData, mode: string, cmap: string, gain: number): { ML: number; MT: number; pw: number; ph: number } | null {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 900;
  const H = cv.clientHeight || 500;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);

  const { numTraces, colLen, norm, data } = sec;
  if (!numTraces || !colLen) return null;
  const ML = SEC_ML, MR = SEC_MR, MT = SEC_MT, MB = SEC_MB;
  const pw = W - ML - MR;
  const ph = H - MT - MB;
  const g = gain / (norm || 1);

  if (mode === 'vd' || mode === 'vdwig') {
    const off = document.createElement('canvas');
    off.width = numTraces;
    off.height = colLen;
    const octx = off.getContext('2d')!;
    const img = octx.createImageData(numTraces, colLen);
    for (let t = 0; t < numTraces; t++) {
      const base = t * colLen;
      for (let s = 0; s < colLen; s++) {
        const v = Math.max(-1, Math.min(1, data[base + s] * g));
        const [r, gg, b] = getColor(v, cmap);
        const idx = (s * numTraces + t) * 4;
        img.data[idx] = r;
        img.data[idx + 1] = gg;
        img.data[idx + 2] = b;
        img.data[idx + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, ML, MT, pw, ph);
  }

  if (mode === 'wiggle' || mode === 'va' || mode === 'vdwig') {
    const tw = pw / numTraces;
    const wsc = Math.max(tw * 0.48, 1);
    // Guard the vertical scale denominator: with colLen === 1 (a genuine 1-sample
    // record or a fully-decimated trace) s/(colLen-1) would be 0/0 = NaN → lineTo
    // (x, NaN) and the wiggle/VA overlay silently fails to draw.
    const sDen = Math.max(1, colLen - 1);
    for (let t = 0; t < numTraces; t++) {
      const base = t * colLen;
      const x0 = ML + (t + 0.5) * tw;
      if (mode === 'va') {
        ctx.beginPath();
        ctx.moveTo(x0, MT);
        for (let s = 0; s < colLen; s++) {
          const v = Math.max(0, Math.min(1, data[base + s] * g));
          ctx.lineTo(x0 + v * wsc, MT + (s / sDen) * ph);
        }
        ctx.lineTo(x0, MT + ph);
        ctx.closePath();
        ctx.fillStyle = '#1fc8c0';
        ctx.fill();
      } else {
        ctx.beginPath();
        for (let s = 0; s < colLen; s++) {
          const v = Math.max(-1, Math.min(1, data[base + s] * g));
          const x = x0 + v * wsc;
          const y = MT + (s / sDen) * ph;
          if (s === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = mode === 'vdwig' ? 'rgba(13,31,51,0.8)' : '#34dbd0';
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
    }
  }

  // Axes reflect the VISIBLE data-zoom window (worker echoes it on `sec`):
  //   time  ← sample window [sampStart, sampEnd) × sampleInt
  //   trace ← trace  window [traceStart, traceEnd)
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  const siUs = summary?.sampleInt ?? sec.sampleInt; // µs/sample
  const t0ms = (sec.sampStart * siUs) / 1000;
  const t1ms = (sec.sampEnd * siUs) / 1000;
  ctx.textAlign = 'left';
  for (let k = 0; k <= 5; k++) {
    const y = MT + (ph * k) / 5;
    const ms = t0ms + ((t1ms - t0ms) * k) / 5;
    ctx.fillText(ms.toFixed(0) + ' ms', 6, y + 3);
  }
  // Trace-index axis along the bottom edge of the plot.
  ctx.textAlign = 'center';
  const tr0 = sec.traceStart, tr1 = sec.traceEnd;
  for (let k = 0; k <= 5; k++) {
    const x = ML + (pw * k) / 5;
    const tr = Math.round(tr0 + ((tr1 - tr0) * k) / 5);
    ctx.fillText('#' + tr, Math.max(ML + 10, Math.min(W - MR - 10, x)), H - 4);
  }
  ctx.textAlign = 'left';
  return { ML, MT, pw, ph };
}

// -- Trace-health QC (File Viewer) ----------------------------------------------
// Scans every trace of the open file for bad-data problems and overlays colour-coded
// flags on the SAME section the viewer already shows. The heavy evidence (per-trace
// RMS, LOCAL neighbour median+MAD baselines, spectra, the polarity correlation) is
// computed ONCE in the worker; the renderer CLASSIFIES that cached evidence and
// re-classifies it live as the sensitivity changes - no re-parse. A findings TABLE
// locates the offending trace, an honest coverage banner never implies 100%, and the
// report exports as CSV. Every value reaching the canvas is finite-guarded + clipped.

// Per-detector colours - shared by the canvas overlay AND the legend/table dots
// (kept in sync with the .health-dot CSS in index.html).
const HEALTH_COLORS: Record<DetectorId, string> = { dead: '#9aa7b4', noisy: '#e2a83a', amp: '#5b8def', clipped: '#ff5252', reversed: '#c264ff' };
const HEALTH_LABELS: Record<DetectorId, string> = { dead: 'dead', noisy: 'noisy', amp: 'hot/weak', clipped: 'clipped/spiky', reversed: 'reversed' };

type HealthMeta = { ffid: number; channel: number; offset: number; row: number };
type HealthScan = {
  data: TraceHealthData;
  meta: Map<number, HealthMeta>;     // absIndex → header info + evidence row
  byAbs: Map<number, TraceFinding>;  // absIndex → finding (current thresholds)
  findings: TraceFinding[];          // flagged traces (current thresholds)
  thr: HealthThresholds;
  scanCount: number;                 // flagged count at scan-time default sensitivity
};
let secHealth: HealthScan | null = null;
let secHealthSel = -1;        // last-located flagged trace (abs index) for the highlight
let secHealthPending = false; // a scan is in flight
let secHealthSort: { key: string; asc: boolean } = { key: 'severity', asc: false };
let secHealthFilter = '';     // free-text filter over the findings table (trace#/problem/FFID)

function hClamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }

/** Read the five per-detector sensitivity selects → a level map (default Med). */
function secHealthSensSelections(): Partial<Record<DetectorId, Sensitivity>> {
  const ids: [DetectorId, string][] = [['dead', 'sensDead'], ['noisy', 'sensNoisy'], ['amp', 'sensAmp'], ['clipped', 'sensClipped'], ['reversed', 'sensReversed']];
  const out: Partial<Record<DetectorId, Sensitivity>> = {};
  for (const [id, elId] of ids) {
    const v = ($opt(elId) as HTMLSelectElement | null)?.value;
    if (v === 'low' || v === 'med' || v === 'high') out[id] = v;
  }
  return out;
}

/** Read the Advanced numeric inputs → only the non-blank, finite overrides. */
function secHealthAdvOverrides(): Partial<HealthThresholds> {
  const map: [keyof HealthThresholds, string][] = [
    ['flatEps', 'advFlatEps'], ['deadFrac', 'advDeadFrac'], ['hotZ', 'advHotZ'], ['weakZ', 'advWeakZ'],
    ['noiseZ', 'advNoiseZ'], ['specK', 'advSpecK'], ['zcrAbs', 'advZcrAbs'], ['clipRunFrac', 'advClipRun'],
    ['spikeK', 'advSpikeK'], ['reverseCorr', 'advReverseCorr'], ['reverseConf', 'advReverseConf'],
  ];
  const out: Partial<HealthThresholds> = {};
  for (const [k, elId] of map) {
    const raw = ($opt(elId) as HTMLInputElement | null)?.value?.trim();
    if (raw) { const v = parseFloat(raw); if (Number.isFinite(v)) out[k] = v; }
  }
  return out;
}

/** The thresholds for the current sensitivity selects + Advanced overrides. */
function secCurrentThresholds(): HealthThresholds {
  return thresholdsForSensitivity(secHealthSensSelections(), secHealthAdvOverrides());
}

/** Enable/disable the Health-scan controls from the current file + scan state. */
function secHealthUpdateButtons() {
  const hasFile = !!summary && summary.traceCount > 0;
  const streamed = !!summary?.streamed;
  const has = !!secHealth && secHealth.data.traceIndex.length > 0;
  const scan = $opt('secHealthBtn') as HTMLButtonElement | null;
  const sens = $opt('secHealthSensBtn') as HTMLButtonElement | null;
  const clr = $opt('secHealthClearBtn') as HTMLButtonElement | null;
  const exp = $opt('secHealthExportBtn') as HTMLButtonElement | null;
  if (scan) { scan.disabled = !hasFile || streamed || secHealthPending; scan.textContent = secHealthPending ? 'Scanning…' : 'Health scan'; }
  if (sens) sens.disabled = !has;
  if (clr) clr.disabled = !has;
  if (exp) exp.disabled = !has;
}

/** Drop the trace-health overlay + findings (new/closed file, or Clear flags). */
function secHealthReset() {
  secHealth = null;
  secHealthSel = -1;
  secHealthFilter = '';
  const filterInp = $opt('secHealthFilter') as HTMLInputElement | null;
  if (filterInp) filterInp.value = '';
  const filterWrap = $opt('secHealthFilterWrap');
  if (filterWrap) (filterWrap as HTMLElement).style.display = 'none';
  const list = $opt('secHealthFindings');
  if (list) { list.innerHTML = ''; (list as HTMLElement).style.display = 'none'; }
  const cov = $opt('secHealthCoverage');
  if (cov) { cov.textContent = ''; (cov as HTMLElement).style.display = 'none'; }
  const sens = $opt('secHealthSens');
  if (sens) (sens as HTMLElement).style.display = 'none';
  const sensBtn = $opt('secHealthSensBtn');
  if (sensBtn) sensBtn.setAttribute('aria-expanded', 'false');
  setText('secHealthLiveCount', '-');
  setText('secHealthSummary', 'Run a health scan to flag bad traces.');
  secHealthUpdateButtons();
}

/** Show/hide the per-detector sensitivity panel. */
function secToggleSensPanel() {
  const panel = $opt('secHealthSens') as HTMLElement | null;
  const btn = $opt('secHealthSensBtn');
  if (!panel) return;
  const show = panel.style.display === 'none' || panel.style.display === '';
  // panel starts as display:none; treat empty/none as hidden.
  const hidden = panel.style.display !== 'block';
  panel.style.display = hidden ? 'block' : 'none';
  if (btn) btn.setAttribute('aria-expanded', hidden ? 'true' : 'false');
  void show;
}

/** Run the whole-file scan, cache the evidence, and classify it (gated for no-file +
 *  streamed/huge files). The sensitivity is applied renderer-side, so changing a
 *  detector's level afterward re-classifies WITHOUT re-scanning. */
async function secRunHealth() {
  if (!summary || summary.traceCount === 0) { setText('secHealthSummary', 'Open a file first.'); return; }
  if (summary.streamed) { setText('secHealthSummary', 'Health scan is not available for very large streamed files yet.'); return; }
  if (secHealthPending) return;
  secHealthPending = true;
  secHealthUpdateButtons();
  setText('secHealthSummary', 'Scanning traces…');
  showProgress('Scanning trace health…');
  try {
    const d = await api.traceHealth({});
    const meta = new Map<number, HealthMeta>();
    for (let i = 0; i < d.traceIndex.length; i++) {
      meta.set(d.traceIndex[i], { ffid: d.ffid[i], channel: d.channel[i], offset: d.offset[i], row: i });
    }
    secHealth = { data: d, meta, byAbs: new Map(), findings: [], thr: secCurrentThresholds(), scanCount: 0 };
    secHealthSel = -1;
    secReclassifyHealth();
    secHealth.scanCount = secHealth.findings.length; // baseline (current sensitivity) for the live-count delta
    secRenderLiveCount();
  } catch (e) {
    setText('secHealthSummary', 'Health scan failed: ' + errMsg(e));
  } finally {
    hideProgress();
    secHealthPending = false;
    secHealthUpdateButtons();
  }
}

/** Re-classify the cached evidence at the current sensitivity (no worker re-parse),
 *  then refresh the overlay + summary + coverage + findings table + live count. */
function secReclassifyHealth() {
  if (!secHealth) return;
  const thr = secCurrentThresholds();
  secHealth.thr = thr;
  const d = secHealth.data;
  const byAbs = new Map<number, TraceFinding>();
  const findings: TraceFinding[] = [];
  for (let i = 0; i < d.traceIndex.length; i++) {
    const ev = readEvidence(d.evidence, i);
    const abs = d.traceIndex[i];
    const { finding } = classifyTrace(ev, abs, thr);
    if (finding) { byAbs.set(abs, finding); findings.push(finding); }
  }
  secHealth.byAbs = byAbs;
  secHealth.findings = findings;
  if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection);
  secRenderHealthSummary();
  secRenderCoverage();
  secRenderHealthFindings();
  secRenderLiveCount();
  secHealthUpdateButtons();
}

/** One-line summary in the toolbar: "N flagged / M scanned · 3 dead · …". */
function secRenderHealthSummary() {
  if (!secHealth) { setText('secHealthSummary', 'Run a health scan to flag bad traces.'); return; }
  const f = secHealth.findings;
  const scanned = secHealth.data.coverage.scanned;
  if (f.length === 0) { setText('secHealthSummary', `Scanned ${scanned} traces · no problems found ✓`); return; }
  const counts: Record<DetectorId, number> = { dead: 0, noisy: 0, amp: 0, clipped: 0, reversed: 0 };
  for (const fi of f) for (const det of fi.detectors) counts[det.id]++;
  const parts: string[] = [];
  for (const id of DETECTOR_IDS) if (counts[id] > 0) parts.push(`${counts[id]} ${HEALTH_LABELS[id]}`);
  setText('secHealthSummary', `${f.length} flagged / ${scanned} scanned · ${parts.join(' · ')}`);
}

/** Honest coverage banner - scanned fraction, sampling, polarity reach (never 100%). */
function secRenderCoverage() {
  const el = $opt('secHealthCoverage') as HTMLElement | null;
  if (!el || !secHealth) return;
  const c = secHealth.data.coverage;
  el.style.display = '';
  const frac = c.total > 0 ? `${c.scanned} of ${c.total}` : `${c.scanned}`;
  const sampling = c.stride > 1 ? `1-in-${c.stride}, ${c.blocks} contiguous block${c.blocks === 1 ? '' : 's'}` : 'every trace';
  const pol = c.polarityRan ? `polarity evaluated on ${c.polarityScanned} trace${c.polarityScanned === 1 ? '' : 's'}` : 'polarity not evaluated (no adjacent-neighbour pilot)';
  el.textContent = `Coverage: scanned ${frac} traces (${sampling}) · ${pol}.`;
}

/** Live flagged-count for the sensitivity panel (current vs scan-default). */
function secRenderLiveCount() {
  const el = $opt('secHealthLiveCount');
  if (!el || !secHealth) return;
  const cur = secHealth.findings.length;
  const base = secHealth.scanCount;
  el.textContent = cur === base
    ? `${cur} trace${cur === 1 ? '' : 's'} flagged at current sensitivity`
    : `${cur} flagged now · ${base} at the default sensitivity`;
}

/** The worst (dominant) detector result for a finding. */
function healthWorst(f: TraceFinding): DetectorResult | undefined {
  return f.detectors.find((d) => d.id === f.worst) ?? f.detectors[0];
}

/** Build the sortable findings table (each row pans/highlights its trace). */
function secRenderHealthFindings() {
  const el = $opt('secHealthFindings') as HTMLElement | null;
  if (!el) return;
  el.innerHTML = '';
  const wrap = $opt('secHealthFilterWrap') as HTMLElement | null;
  if (!secHealth || secHealth.findings.length === 0) {
    el.style.display = 'none';
    if (wrap) wrap.style.display = 'none';
    return;
  }
  el.style.display = '';
  if (wrap) wrap.style.display = '';
  const meta = secHealth.meta;
  const { key, asc } = secHealthSort;
  const dir = asc ? 1 : -1;
  const sortVal = (f: TraceFinding): number => {
    switch (key) {
      case 'trace': return f.absIndex;
      case 'ffid': return meta.get(f.absIndex)?.ffid ?? 0;
      case 'offset': return meta.get(f.absIndex)?.offset ?? 0;
      case 'problem': return DETECTOR_IDS.indexOf(f.worst);
      case 'confidence': return f.confidence;
      default: return f.severity;
    }
  };
  // Free-text filter (trace #, problem labels, FFID:ch, offset) - complements the
  // column sort. Case-insensitive substring over a per-row searchable string.
  const q = secHealthFilter.trim().toLowerCase();
  const matches = (f: TraceFinding): boolean => {
    if (!q) return true;
    const m = meta.get(f.absIndex);
    const hay = [
      `#${f.absIndex}`,
      f.detectors.map((d) => HEALTH_LABELS[d.id]).join(' '),
      m && (m.ffid !== 0 || m.channel !== 0) ? `${m.ffid}:${m.channel}` : '',
      m && Number.isFinite(m.offset) ? String(Math.round(m.offset)) : '',
    ].join(' ').toLowerCase();
    return hay.includes(q);
  };
  const rows = secHealth.findings.filter(matches).sort((a, b) => (sortVal(a) - sortVal(b)) * dir || (a.absIndex - b.absIndex));

  const table = document.createElement('table');
  table.className = 'health-tbl';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  const cols: { key: string; label: string; sortable: boolean }[] = [
    { key: 'trace', label: 'Trace', sortable: true },
    { key: 'ffid', label: 'FFID:ch', sortable: true },
    { key: 'offset', label: 'Offset', sortable: true },
    { key: 'problem', label: 'Problem', sortable: true },
    { key: 'reason', label: 'Metric vs local baseline', sortable: false },
    { key: 'confidence', label: 'Conf', sortable: true },
    { key: 'status', label: 'Status', sortable: false },
  ];
  for (const col of cols) {
    const th = document.createElement('th');
    th.textContent = col.label;
    if (col.sortable) {
      if (secHealthSort.key === col.key) { th.classList.add('sortedby'); if (asc) th.classList.add('asc'); }
      th.addEventListener('click', () => {
        if (secHealthSort.key === col.key) secHealthSort.asc = !secHealthSort.asc;
        else secHealthSort = { key: col.key, asc: col.key === 'trace' || col.key === 'ffid' || col.key === 'offset' };
        secRenderHealthFindings();
      });
    }
    htr.appendChild(th);
  }
  thead.appendChild(htr); table.appendChild(thead);

  const tbody = document.createElement('tbody');
  // Cap the DOM so a pathological file can't build a huge table.
  for (const f of rows.slice(0, 3000)) {
    const m = meta.get(f.absIndex);
    const worst = healthWorst(f);
    const tr = document.createElement('tr');
    tr.dataset.abs = String(f.absIndex);

    const tdTr = document.createElement('td'); tdTr.className = 'h-tr'; tdTr.textContent = `#${f.absIndex}`; tr.appendChild(tdTr);
    const tdFf = document.createElement('td');
    tdFf.textContent = m && (m.ffid !== 0 || m.channel !== 0) ? `${m.ffid}:${m.channel}` : '-';
    tr.appendChild(tdFf);
    const tdOff = document.createElement('td');
    tdOff.textContent = m && Number.isFinite(m.offset) && m.offset !== 0 ? String(Math.round(m.offset)) : '-';
    tr.appendChild(tdOff);
    const tdProb = document.createElement('td'); tdProb.className = 'h-prob';
    const dot = document.createElement('span'); dot.className = 'health-prob-dot'; dot.style.background = HEALTH_COLORS[f.worst];
    tdProb.appendChild(dot);
    tdProb.appendChild(document.createTextNode(f.detectors.map((d) => HEALTH_LABELS[d.id]).join(', ')));
    tr.appendChild(tdProb);
    const tdReason = document.createElement('td'); tdReason.className = 'h-reason';
    tdReason.textContent = worst ? worst.reason : '';
    if (worst) tdReason.title = worst.reason;
    tr.appendChild(tdReason);
    const tdConf = document.createElement('td'); tdConf.textContent = f.confidence.toFixed(2); tr.appendChild(tdConf);
    const tdStat = document.createElement('td');
    const strong = f.confidence >= 0.5 && f.severity >= 0.3;
    const pill = document.createElement('span'); pill.className = `health-pill ${strong ? 'strong' : 'marginal'}`; pill.textContent = strong ? 'strong' : 'marginal';
    tdStat.appendChild(pill); tr.appendChild(tdStat);

    tr.addEventListener('click', () => secHealthLocate(f.absIndex));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  el.appendChild(table);
  if (q && rows.length === 0) {
    const note = document.createElement('div');
    note.className = 'health-find-empty';
    note.textContent = `No findings match “${secHealthFilter.trim()}”.`;
    el.appendChild(note);
  }
  secHighlightFindingRow();
}

/** Mark the selected findings row (after a locate). */
function secHighlightFindingRow() {
  const el = $opt('secHealthFindings');
  if (!el) return;
  for (const r of Array.from(el.querySelectorAll('tbody tr'))) {
    (r as HTMLElement).classList.toggle('sel', Number((r as HTMLElement).dataset.abs) === secHealthSel);
  }
}

/** Pan the section so a flagged trace is in view + highlight it. */
function secHealthLocate(abs: number) {
  if (!summary || summary.traceCount === 0) return;
  secHealthSel = abs;
  if (!secView.init) secFit();
  if (abs < secView.t0 || abs >= secView.t1) {
    const w = Math.max(2, secView.t1 - secView.t0);
    let t0 = Math.round(abs - w / 2);
    if (t0 < 0) t0 = 0;
    secView.t0 = t0;
    secView.t1 = t0 + w;
    void fetchSectionWindow(); // clamps, re-fetches + redraws (overlay included)
  } else if (lastSection) {
    drawSection($('secCanvas') as HTMLCanvasElement, lastSection);
  }
  secHighlightFindingRow();
}

/** Overlay the trace-health flags on the painted section: a per-flagged-column tint
 *  line in the worst-detector colour (SOLID = strong / confident, DASHED = marginal)
 *  clipped to the plot rect, plus a stacked tick per fired detector at the top. Every
 *  coordinate is finite-guarded. */
function secDrawHealthOverlay(cv: HTMLCanvasElement, sec: SectionData, rect: { ML: number; MT: number; pw: number; ph: number }) {
  if (!secHealth || secHealth.byAbs.size === 0) return;
  const { ML, MT, pw, ph } = rect;
  const ctx = cv.getContext('2d'); if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const numTraces = sec.numTraces;
  if (!(numTraces > 0) || !(pw > 0) || !(ph > 0) || !(sec.traceStep > 0)) return;
  const tw = pw / numTraces;
  const half = Math.max(2.5, Math.min(tw * 0.55, 6));
  ctx.save();
  for (let c = 0; c < numTraces; c++) {
    const abs = sec.traceStart + c * sec.traceStep;
    const f = secHealth.byAbs.get(abs);
    if (!f) continue;
    const x = ML + (c + 0.5) * tw;
    if (!Number.isFinite(x)) continue;
    const strong = f.confidence >= 0.5;
    // Faint full-height tint line in the dominant colour (clipped to the plot rect).
    ctx.save();
    ctx.beginPath(); ctx.rect(ML, MT, pw, ph); ctx.clip();
    ctx.strokeStyle = HEALTH_COLORS[f.worst];
    ctx.globalAlpha = 0.18 + 0.30 * hClamp01(f.severity);
    ctx.lineWidth = strong ? 1.2 : 1;
    ctx.setLineDash(strong ? [] : [4, 3]);
    ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + ph); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    // Bold colour-coded marker(s) at the top - one downward triangle per fired
    // detector, side by side, so every problem is visible at a glance.
    ctx.globalAlpha = 1;
    const kinds = f.detectors.map((d) => d.id);
    const total = Math.max(1, kinds.length);
    const span = Math.min(tw, 2 * half * total + (total - 1));
    let mx = x - span / 2 + (span / total) / 2;
    for (const k of kinds) {
      const cx = Math.max(ML + half, Math.min(ML + pw - half, mx));
      if (!Number.isFinite(cx)) { mx += span / total; continue; }
      ctx.fillStyle = HEALTH_COLORS[k];
      ctx.strokeStyle = 'rgba(13,31,51,0.85)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(cx - half, MT - 1);
      ctx.lineTo(cx + half, MT - 1);
      ctx.lineTo(cx, MT + 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      mx += span / total;
    }
  }
  // Selected (located) trace - a bright guide so a clicked finding stands out.
  if (secHealthSel >= 0) {
    const c = Math.round((secHealthSel - sec.traceStart) / sec.traceStep);
    if (c >= 0 && c < numTraces) {
      const x = ML + (c + 0.5) * tw;
      if (Number.isFinite(x)) {
        ctx.save();
        ctx.beginPath(); ctx.rect(ML, MT, pw, ph); ctx.clip();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + ph); ctx.stroke();
        ctx.restore();
      }
    }
  }
  ctx.restore();
}

/** CSV cell with quoting for commas/quotes/newlines. */
function healthCsvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Export every flagged trace as CSV - one row PER FIRED DETECTOR with its score,
 *  confidence, metric, local baseline, reason + the trace's real std. */
async function secHealthExport() {
  if (!summary || !secHealth || secHealth.findings.length === 0) { setText('secHealthSummary', 'Run a health scan first.'); return; }
  // The CSV is built row-per-detector on the renderer thread; show the spinner +
  // paint BEFORE the build for a large flag set so it never looks frozen.
  const heavy = secHealth.findings.length > 1500;
  if (heavy) { showProgress('Exporting flagged traces…', undefined, 0); await nextPaint(); }
  const d = secHealth.data;
  const meta = secHealth.meta;
  const out: string[] = ['traceIndex,ffid,channel,offset,detector,score,confidence,metric,baseline,std,severity,worst,reason'];
  const ordered = secHealth.findings.slice().sort((a, b) => a.absIndex - b.absIndex);
  const num = (v: number, dp = 4) => (Number.isFinite(v) ? v.toFixed(dp) : '');
  for (const f of ordered) {
    const m = meta.get(f.absIndex);
    const ev = m ? readEvidence(d.evidence, m.row) : null;
    const std = ev ? num(ev.std) : '';
    for (const det of f.detectors) {
      out.push([
        f.absIndex, m?.ffid ?? '', m?.channel ?? '', m && Number.isFinite(m.offset) ? num(m.offset, 2) : '',
        det.id, num(det.score, 3), num(det.confidence, 3), num(det.metric), num(det.baseline), std,
        num(f.severity, 3), f.worst, det.reason,
      ].map(healthCsvCell).join(','));
    }
  }
  const base = (summary.name || 'file').replace(/\.[^.]+$/, '');
  try {
    const res = await api.exportText(`${base}_tracehealth.csv`, out.join('\n') + '\n');
    if (res.ok) setText('secHealthSummary', `Exported ${secHealth.findings.length} flagged trace${secHealth.findings.length === 1 ? '' : 's'} → ${res.path ?? 'CSV'}`);
    else if (!res.canceled) setText('secHealthSummary', 'Export failed: ' + (res.error ?? 'unknown'));
  } catch (e) {
    setText('secHealthSummary', 'Export failed: ' + errMsg(e));
  } finally {
    if (heavy) hideProgress();
  }
}

// -- First-breaks mode (File Viewer) ---------------------------------------------
// An assisted / SEEDED first-break picker that runs as a MODE on the SAME section
// canvas (no second viewer). The operator drops ≥2 seed picks; the engine (core
// `assistFirstBreaks`, run in the worker on REAL adjacent traces) predicts a moveout
// guide through the seeds and picks every other trace inside a narrow ±window around
// it - so picks TRACK the gather instead of scattering. Auto-pick is a FIRST GUESS
// the operator edits. The overlay (dashed guide + shaded ±band + pick line + dots)
// is finite-guarded + clipped on every redraw; CSV export only (no header write).

// Pick colours - overlay + legend dots (kept in sync with .health-dot[data-fb] CSS).
const FB_COLORS = { seed: '#ffd23f', auto: '#39d98a', edited: '#5b8def', flagged: '#ff5252' };
type FbSource = 'seed' | 'auto' | 'edited';
interface FbPick { tMs: number; source: FbSource; confidence: number; deviation: number; accepted: boolean; ffid: number; channel: number; offset: number; }

let fbMode = false;
const fbPicks = new Map<number, FbPick>();        // absIdx → pick (seeds + auto + edited)
let fbWorkerGuide = new Map<number, number>();    // absIdx → guide ms (last fill; cleared on a seed edit)
let fbWindowMs = 25;                              // ± search half-window (overlay band)
let fbHasOffsets = false;
let fbPending = false;
let fbSel = -1;                                   // selected pick (abs) for the highlight
let fbDragAbs = -1;                               // pick being dragged (abs) or -1

function fbClamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }
function fbPolarityVal(): 'peak' | 'trough' | 'zero' {
  const v = ($opt('secFbPolarity') as HTMLSelectElement | null)?.value;
  return v === 'trough' || v === 'zero' ? v : 'peak';
}
function fbWindowVal(): number {
  const v = parseFloat(($opt('secFbWindow') as HTMLInputElement | null)?.value ?? '');
  return Number.isFinite(v) && v >= 2 && v <= 500 ? v : 25;
}
function fbSeedCount(): number { let n = 0; for (const p of fbPicks.values()) if (p.source === 'seed') n++; return n; }
/** A pick is "flagged" when an UN-accepted auto pick has low phase-lock confidence
 *  or sits well off the moveout trend - the dim/red dots the user should review. */
function fbIsFlagged(p: FbPick): boolean {
  if (p.source !== 'auto' || p.accepted || !Number.isFinite(p.tMs)) return false;
  return p.confidence < 0.35 || Math.abs(p.deviation) > Math.max(4, fbWindowMs * 0.6);
}

/** Toggle the First-breaks mode: show/hide the sub-bar + hint, arm the overlay +
 *  click/drag, and stay mutually exclusive with the magnifier / +Workbench modes. */
function setFbMode(on: boolean) {
  fbMode = on;
  const btn = $opt('secFbToggle');
  btn?.classList.toggle('on', on);
  btn?.setAttribute('aria-pressed', on ? 'true' : 'false');
  const bar = $opt('secFbBar'); if (bar) bar.style.display = on ? '' : 'none';
  const hint = $opt('secFbHint'); if (hint) hint.style.display = on ? '' : 'none';
  const cv = $opt('secCanvas') as HTMLCanvasElement | null;
  if (cv) cv.style.cursor = on ? 'crosshair' : '';
  if (on) { if (secBoxMode) setSecBoxMode(false); if (secToWb) disarmSecToWb(); }
  else { fbDragAbs = -1; }
  fbWindowMs = fbWindowVal();
  fbUpdateButtons();
  fbRenderReadout(-1);
  if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection);
}

/** Drop all picks + the guide overlay (file open / Clear). Leaves the mode toggle. */
function fbReset() {
  fbPicks.clear();
  fbWorkerGuide = new Map();
  fbSel = -1;
  fbDragAbs = -1;
  fbUpdateButtons();
  fbRenderReadout(-1);
}

/** Enable/disable the sub-bar controls for the current file + pick state. */
function fbUpdateButtons() {
  const hasFile = !!summary && summary.traceCount > 0;
  const streamed = !!summary?.streamed;
  const anyPick = fbPicks.size > 0;
  const flaggedAny = [...fbPicks.values()].some(fbIsFlagged);
  const toggle = $opt('secFbToggle') as HTMLButtonElement | null;
  if (toggle) toggle.disabled = !hasFile || streamed;
  const fill = $opt('secFbFillBtn') as HTMLButtonElement | null;
  if (fill) { fill.disabled = !hasFile || streamed || fbPending || fbSeedCount() < 2; fill.textContent = fbPending ? 'Filling…' : 'Assisted fill'; }
  const accept = $opt('secFbAcceptBtn') as HTMLButtonElement | null;
  if (accept) accept.disabled = !anyPick || fbPending;
  const reject = $opt('secFbRejectBtn') as HTMLButtonElement | null;
  if (reject) reject.disabled = !flaggedAny || fbPending;
  const clr = $opt('secFbClearBtn') as HTMLButtonElement | null;
  if (clr) clr.disabled = !anyPick || fbPending;
  const exp = $opt('secFbExportBtn') as HTMLButtonElement | null;
  if (exp) exp.disabled = !anyPick || fbPending;
}

/** Sorted seed list (by absolute index) for the live guide preview. */
function fbSeedsSorted(): { a: number; t: number }[] {
  const arr: { a: number; t: number }[] = [];
  for (const [a, p] of fbPicks) if (p.source === 'seed' && Number.isFinite(p.tMs)) arr.push({ a, t: p.tMs });
  arr.sort((x, y) => x.a - y.a);
  return arr;
}
/** Live guide preview by TRACE INDEX (piecewise-linear through the seeds, ends
 *  extrapolated) - the offset-ordered guide is only known after a worker fill. */
function fbGuidePreviewAt(abs: number, seeds: { a: number; t: number }[]): number {
  if (seeds.length === 0) return NaN;
  if (seeds.length === 1) return seeds[0].t;
  const slope = (a: { a: number; t: number }, b: { a: number; t: number }) => { const dk = b.a - a.a; const m = dk !== 0 ? (b.t - a.t) / dk : 0; return Number.isFinite(m) ? m : 0; };
  const first = seeds[0], last = seeds[seeds.length - 1];
  if (abs <= first.a) return first.t + slope(seeds[0], seeds[1]) * (abs - first.a);
  if (abs >= last.a) return last.t + slope(seeds[seeds.length - 2], seeds[seeds.length - 1]) * (abs - last.a);
  for (let j = 0; j < seeds.length - 1; j++) if (abs >= seeds[j].a && abs <= seeds[j + 1].a) return seeds[j].t + slope(seeds[j], seeds[j + 1]) * (abs - seeds[j].a);
  return last.t;
}
/** Guide time (ms) at an absolute trace: the worker's offset-ordered curve when a
 *  fill exists, else the live index-based preview. */
function fbGuideAt(abs: number, seeds: { a: number; t: number }[]): number {
  const w = fbWorkerGuide.get(abs);
  if (w !== undefined && Number.isFinite(w)) return w;
  return fbGuidePreviewAt(abs, seeds);
}

/** Run the assisted picker over the whole open record (≥2 seeds), preserving the
 *  user's seeds + edited picks and replacing the auto picks. Shows the global bar. */
async function secRunFirstBreaks() {
  if (!summary || summary.traceCount === 0) { fbRenderReadout(-1, 'Open a file first.'); return; }
  if (summary.streamed) { fbRenderReadout(-1, 'First breaks is not available for very large streamed files yet.'); return; }
  if (fbPending) return;
  if (fbSeedCount() < 2) { fbRenderReadout(-1, 'Drop at least two seed picks, then Assisted fill.'); return; }
  fbPending = true;
  fbUpdateButtons();
  showProgress('Picking first breaks…');
  // Seeds + the picks to preserve across the fill (seeds always; user-edited picks).
  const seeds = [...fbPicks.entries()].filter(([, p]) => p.source === 'seed' && Number.isFinite(p.tMs)).map(([a, p]) => ({ absIdx: a, tMs: p.tMs }));
  const preserved = new Map<number, FbPick>();
  for (const [a, p] of fbPicks) if (p.source === 'seed' || p.source === 'edited') preserved.set(a, p);
  try {
    const d = await api.firstBreaks({
      seeds,
      traceStart: 0, traceEnd: summary.traceCount,
      fbWindowMs: fbWindowVal(), fbPolarity: fbPolarityVal(),
    });
    fbWindowMs = Number.isFinite(d.windowMs) && d.windowMs > 0 ? d.windowMs : fbWindowVal();
    fbHasOffsets = !!d.hasOffsets;
    const next = new Map<number, FbPick>();
    const n = d.pAbs.length;
    for (let i = 0; i < n; i++) {
      const abs = d.pAbs[i];
      const ffid = d.pFfid[i] | 0, channel = d.pChan[i] | 0;
      const offset = Number.isFinite(d.pOff[i]) ? d.pOff[i] : NaN;
      const keep = preserved.get(abs);
      if (keep) { next.set(abs, { ...keep, ffid: ffid || keep.ffid, channel: channel || keep.channel, offset: Number.isFinite(offset) ? offset : keep.offset }); continue; }
      const t = d.pTime[i];
      if (Number.isFinite(t)) next.set(abs, { tMs: t, source: 'auto', confidence: fbClamp01(d.pConf[i]), deviation: Number.isFinite(d.pDev[i]) ? d.pDev[i] : 0, accepted: false, ffid, channel, offset });
    }
    // Re-add any preserved pick the scan window didn't cover (shouldn't happen on a
    // whole-record fill, but never silently drop a user pick).
    for (const [a, p] of preserved) if (!next.has(a)) next.set(a, p);
    fbPicks.clear();
    for (const [a, p] of next) fbPicks.set(a, p);
    // The authoritative (offset-ordered) guide curve from the worker.
    fbWorkerGuide = new Map();
    for (let i = 0; i < d.gAbs.length; i++) { const g = d.guide[i]; if (Number.isFinite(g)) fbWorkerGuide.set(d.gAbs[i], g); }
    const auto = [...fbPicks.values()].filter((p) => p.source === 'auto').length;
    const flagged = [...fbPicks.values()].filter(fbIsFlagged).length;
    fbRenderReadout(-1, `Filled ${auto} auto pick${auto === 1 ? '' : 's'}${flagged ? ` · ${flagged} flagged (review)` : ''} · ${fbHasOffsets ? 'offset-guided' : 'index-guided'}.`);
  } catch (e) {
    fbRenderReadout(-1, 'Assisted fill failed: ' + errMsg(e));
  } finally {
    hideProgress();
    fbPending = false;
    fbUpdateButtons();
    if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection);
  }
}

/** Accept every pick (clears the flagged state so they read as confirmed). */
function fbAcceptAll() {
  for (const p of fbPicks.values()) if (Number.isFinite(p.tMs)) p.accepted = true;
  fbUpdateButtons();
  fbRenderReadout(-1, 'All picks accepted.');
  if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection);
}
/** Drop the flagged (low-confidence / off-trend) auto picks; keep seeds + good picks. */
function fbRejectFlagged() {
  let n = 0;
  for (const [a, p] of [...fbPicks]) if (fbIsFlagged(p)) { fbPicks.delete(a); n++; }
  if (fbSel >= 0 && !fbPicks.has(fbSel)) fbSel = -1;
  fbUpdateButtons();
  fbRenderReadout(-1, `Rejected ${n} flagged pick${n === 1 ? '' : 's'}.`);
  if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection);
}
/** Remove all picks + the guide. */
function fbClearPicks() {
  fbReset();
  fbRenderReadout(-1);
  if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection);
}

/** Export every pick as CSV (absIdx, FFID, channel, offset, tMs, source, confidence). */
async function fbExportCsv() {
  if (!summary || fbPicks.size === 0) { fbRenderReadout(-1, 'Drop seeds + fill first.'); return; }
  const out: string[] = ['absIdx,ffid,channel,offset,tMs,source,confidence'];
  const num = (v: number, dp = 4) => (Number.isFinite(v) ? v.toFixed(dp) : '');
  const rows = [...fbPicks.entries()].filter(([, p]) => Number.isFinite(p.tMs)).sort((a, b) => a[0] - b[0]);
  for (const [abs, p] of rows) {
    out.push([abs, p.ffid || '', p.channel || '', Number.isFinite(p.offset) ? num(p.offset, 2) : '', num(p.tMs, 3), fbIsFlagged(p) ? 'auto-flagged' : p.source, num(p.confidence, 3)].join(','));
  }
  const base = (summary.name || 'file').replace(/\.[^.]+$/, '');
  try {
    const res = await api.exportText(`${base}_firstbreaks.csv`, out.join('\n') + '\n');
    if (res.ok) fbRenderReadout(-1, `Exported ${rows.length} pick${rows.length === 1 ? '' : 's'} → ${res.path ?? 'CSV'}`);
    else if (!res.canceled) fbRenderReadout(-1, 'Export failed: ' + (res.error ?? 'unknown'));
  } catch (e) {
    fbRenderReadout(-1, 'Export failed: ' + errMsg(e));
  }
}

/** The pick's dot colour - flagged picks read red, else by source. */
function fbPickColor(p: FbPick): string {
  if (fbIsFlagged(p)) return FB_COLORS.flagged;
  return FB_COLORS[p.source];
}

// Pixel mapping for the overlay/hit-test (mirror paintSection's axes exactly).
function fbXForAbs(abs: number, sec: SectionData, ML: number, pw: number): number {
  const span = sec.traceEnd - sec.traceStart;
  if (!(span > 0) || !(pw > 0)) return NaN;
  return ML + ((abs - sec.traceStart) / span) * pw;
}
function fbYForMs(tMs: number, sec: SectionData, siUs: number, MT: number, ph: number): number {
  const t0 = (sec.sampStart * siUs) / 1000, t1 = (sec.sampEnd * siUs) / 1000;
  const span = t1 - t0;
  if (!(span > 0) || !(ph > 0) || !Number.isFinite(tMs)) return NaN;
  return MT + ((tMs - t0) / span) * ph;
}

/** Overlay the moveout guide (dashed) + shaded ±search-window band + the pick line
 *  (colour-coded dots ∝ confidence, gaps at dead/no-pick) onto the painted section.
 *  Every coordinate is finite-guarded and clipped to the plot rect. */
function secDrawFbOverlay(cv: HTMLCanvasElement, sec: SectionData, rect: { ML: number; MT: number; pw: number; ph: number }) {
  const { ML, MT, pw, ph } = rect;
  if (!(pw > 0) || !(ph > 0) || !(sec.traceEnd > sec.traceStart)) return;
  const ctx = cv.getContext('2d'); if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const siUs = summary?.sampleInt ?? sec.sampleInt ?? 0;
  if (!(siUs > 0)) return;
  const seeds = fbSeedsSorted();
  const haveGuide = seeds.length >= 1 || fbWorkerGuide.size > 0;

  ctx.save();
  ctx.beginPath(); ctx.rect(ML, MT, pw, ph); ctx.clip();

  // 1. Moveout guide + shaded ±window band over the visible columns.
  if (haveGuide && sec.traceStep > 0) {
    const xs: number[] = [], yMid: number[] = [], yTop: number[] = [], yBot: number[] = [];
    for (let c = 0; c < sec.numTraces; c++) {
      const abs = sec.traceStart + c * sec.traceStep;
      const g = fbGuideAt(abs, seeds);
      if (!Number.isFinite(g)) continue;
      const x = fbXForAbs(abs, sec, ML, pw);
      const ym = fbYForMs(g, sec, siUs, MT, ph);
      const yt = fbYForMs(g - fbWindowMs, sec, siUs, MT, ph);
      const yb = fbYForMs(g + fbWindowMs, sec, siUs, MT, ph);
      if (!Number.isFinite(x) || !Number.isFinite(ym)) continue;
      xs.push(x); yMid.push(ym); yTop.push(Number.isFinite(yt) ? yt : ym); yBot.push(Number.isFinite(yb) ? yb : ym);
    }
    if (xs.length >= 2) {
      // Shaded band.
      ctx.beginPath();
      ctx.moveTo(xs[0], yTop[0]);
      for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], yTop[i]);
      for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(xs[i], yBot[i]);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,210,63,0.10)';
      ctx.fill();
      // Dashed guide.
      ctx.beginPath();
      ctx.moveTo(xs[0], yMid[0]);
      for (let i = 1; i < xs.length; i++) ctx.lineTo(xs[i], yMid[i]);
      ctx.strokeStyle = 'rgba(255,210,63,0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 2. Pick line - connect finite picks in the visible window (break at gaps).
  const vis = [...fbPicks.entries()]
    .filter(([a, p]) => a >= sec.traceStart && a <= sec.traceEnd && Number.isFinite(p.tMs))
    .sort((x, y) => x[0] - y[0]);
  if (vis.length >= 2) {
    ctx.beginPath();
    let started = false;
    for (const [a, p] of vis) {
      const x = fbXForAbs(a, sec, ML, pw);
      const y = fbYForMs(p.tMs, sec, siUs, MT, ph);
      if (!Number.isFinite(x) || !Number.isFinite(y)) { started = false; continue; }
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(230,238,247,0.55)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }

  // 3. Dots - colour by source/flag, radius + opacity ∝ confidence.
  for (const [a, p] of vis) {
    const x = fbXForAbs(a, sec, ML, pw);
    const y = fbYForMs(p.tMs, sec, siUs, MT, ph);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const conf = fbClamp01(p.source === 'seed' ? 1 : p.confidence);
    const r = p.source === 'seed' ? 3.6 : 2 + 2.4 * conf;
    ctx.globalAlpha = p.source === 'seed' ? 1 : 0.45 + 0.55 * conf;
    ctx.fillStyle = fbPickColor(p);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (p.source === 'seed') { ctx.globalAlpha = 1; ctx.strokeStyle = 'rgba(13,31,51,0.9)'; ctx.lineWidth = 1; ctx.stroke(); }
  }
  ctx.globalAlpha = 1;

  // 4. Selected pick - a bright ring.
  if (fbSel >= 0) {
    const p = fbPicks.get(fbSel);
    if (p && Number.isFinite(p.tMs)) {
      const x = fbXForAbs(fbSel, sec, ML, pw);
      const y = fbYForMs(p.tMs, sec, siUs, MT, ph);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/** Hit-test the cursor against existing picks; returns the nearest pick's abs index
 *  within ~9 px, or -1. Uses lastSection's axes (same mapping as the overlay). */
function fbHitPick(cv: HTMLCanvasElement, e: MouseEvent): number {
  if (!lastSection || fbPicks.size === 0) return -1;
  const sec = lastSection;
  const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
  const pw = W - SEC_ML - SEC_MR, ph = H - SEC_MT - SEC_MB;
  const siUs = summary?.sampleInt ?? sec.sampleInt ?? 0;
  if (!(siUs > 0)) return -1;
  const r = cv.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  let best = -1, bestD = 9 * 9;
  for (const [a, p] of fbPicks) {
    if (!Number.isFinite(p.tMs) || a < sec.traceStart || a > sec.traceEnd) continue;
    const x = fbXForAbs(a, sec, SEC_ML, pw);
    const y = fbYForMs(p.tMs, sec, siUs, SEC_MT, ph);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d = (x - px) * (x - px) + (y - py) * (y - py);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

/** The absolute trace index + onset time (ms) under the cursor (mirrors the hover). */
function fbCursorTraceTime(cv: HTMLCanvasElement, e: MouseEvent): { abs: number; tMs: number } | null {
  if (!summary || summary.traceCount === 0 || !secView.init) return null;
  const { fx, fy } = secPlotFrac(cv, e);
  const abs = Math.max(0, Math.min(summary.traceCount - 1, Math.round(secView.t0 + fx * (secView.t1 - secView.t0))));
  const siUs = summary.sampleInt ?? lastSection?.sampleInt ?? 0;
  const tMs = ((secView.s0 + fy * (secView.s1 - secView.s0)) * siUs) / 1000;
  if (!Number.isFinite(tMs)) return null;
  return { abs, tMs };
}

/** Place (or move) a seed at the clicked trace + onset; the guide re-fills live. */
function fbPlaceSeed(cv: HTMLCanvasElement, e: MouseEvent) {
  const at = fbCursorTraceTime(cv, e);
  if (!at) return;
  const prev = fbPicks.get(at.abs);
  fbPicks.set(at.abs, { tMs: at.tMs, source: 'seed', confidence: 1, deviation: 0, accepted: true, ffid: prev?.ffid ?? 0, channel: prev?.channel ?? 0, offset: prev?.offset ?? NaN });
  fbWorkerGuide = new Map(); // a seed moved ⇒ fall back to the live preview guide
  fbSel = at.abs;
  fbUpdateButtons();
  fbRenderReadout(at.abs);
  if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection);
}

/** Live drag of an existing pick to a new onset time; a dragged auto pick becomes
 *  'edited', a dragged seed stays a seed (guide re-fills live). */
function fbDragPick(cv: HTMLCanvasElement, e: MouseEvent) {
  if (fbDragAbs < 0 || !summary || !secView.init) return;
  const p = fbPicks.get(fbDragAbs); if (!p) return;
  const r = cv.getBoundingClientRect();
  const H = cv.clientHeight || 500;
  const ph = H - SEC_MT - SEC_MB;
  const fy = Math.max(0, Math.min(1, (e.clientY - r.top - SEC_MT) / ph));
  const siUs = summary.sampleInt ?? lastSection?.sampleInt ?? 0;
  const tMs = ((secView.s0 + fy * (secView.s1 - secView.s0)) * siUs) / 1000;
  if (!Number.isFinite(tMs)) return;
  p.tMs = tMs;
  if (p.source === 'seed') { fbWorkerGuide = new Map(); }
  else { p.source = 'edited'; p.accepted = true; }
  fbSel = fbDragAbs;
  fbRenderReadout(fbDragAbs);
  if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection);
}

/** Right-click deletes the nearest pick. */
function fbDeletePickAt(cv: HTMLCanvasElement, e: MouseEvent) {
  const hit = fbHitPick(cv, e);
  if (hit < 0) return;
  const wasSeed = fbPicks.get(hit)?.source === 'seed';
  fbPicks.delete(hit);
  if (wasSeed) fbWorkerGuide = new Map();
  if (fbSel === hit) fbSel = -1;
  fbUpdateButtons();
  fbRenderReadout(-1, 'Pick deleted.');
  if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection);
}

/** The sub-bar read-out: the pick under `abs` (trace · FFID · ch · offset · ms ·
 *  source · confidence), or a status message. */
function fbRenderReadout(abs: number, msg?: string) {
  const el = $opt('secFbReadout');
  if (!el) return;
  if (msg) { el.textContent = msg; return; }
  if (abs >= 0 && fbPicks.has(abs)) {
    const p = fbPicks.get(abs)!;
    const parts = [`trace ${grp(abs + 1)}`];
    if (p.ffid) parts.push(`FFID ${p.ffid}`);
    if (p.channel) parts.push(`ch ${p.channel}`);
    if (Number.isFinite(p.offset)) parts.push(`offset ${p.offset.toFixed(0)}`);
    if (Number.isFinite(p.tMs)) parts.push(`pick ${p.tMs.toFixed(1)} ms`);
    parts.push(fbIsFlagged(p) ? 'flagged' : p.source);
    if (p.source !== 'seed') parts.push(`conf ${fbClamp01(p.confidence).toFixed(2)}`);
    el.textContent = parts.join(' · ');
    return;
  }
  const seeds = fbSeedCount();
  el.textContent = seeds === 0 ? 'Drop 2+ seed picks, then Assisted fill.'
    : seeds === 1 ? 'One seed - drop at least one more, then Assisted fill.'
      : `${seeds} seeds · ${fbPicks.size} picks - Assisted fill, or click to add seeds.`;
}

// -- Section data-zoom / pan (mirrors the SPS survey-grid interaction) --
// Distinct from the app-wide UI zoom: this zooms into the seismic DATA by
// re-fetching the visible [t0,t1)×[s0,s1) window at full detail.

/** Map a cursor pixel inside the section canvas to a fractional position in the
 *  plot rectangle (0..1 along trace-x and sample-y), clamped to the data area. */
function secPlotFrac(cv: HTMLCanvasElement, e: MouseEvent): { fx: number; fy: number } {
  const r = cv.getBoundingClientRect();
  const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
  const pw = W - SEC_ML - SEC_MR, ph = H - SEC_MT - SEC_MB;
  const px = e.clientX - r.left - SEC_ML, py = e.clientY - r.top - SEC_MT;
  return { fx: Math.max(0, Math.min(1, px / pw)), fy: Math.max(0, Math.min(1, py / ph)) };
}

/** Zoom the visible window toward the cursor by `factor` (<1 zooms in). */
function secZoomAt(fx: number, fy: number, factor: number) {
  if (!secView.init) secFit();
  // Data index under the cursor (anchor point that stays put).
  const at = secView.t0 + fx * (secView.t1 - secView.t0);
  const as = secView.s0 + fy * (secView.s1 - secView.s0);
  const wt = (secView.t1 - secView.t0) * factor;
  const ws = (secView.s1 - secView.s0) * factor;
  secView.t0 = at - fx * wt; secView.t1 = at + (1 - fx) * wt;
  secView.s0 = as - fy * ws; secView.s1 = as + (1 - fy) * ws;
}

/** Zoom both axes toward the canvas centre (toolbar +/- buttons). */
function secZoomButton(factor: number) {
  if (!summary || summary.traceCount === 0) return;
  secZoomAt(0.5, 0.5, factor);
  void fetchSectionWindow();
}

/** Map a (non-drag) click on the section canvas to an absolute trace index in the
 *  open file and send that trace to the Trace Workbench. Reuses the shared add
 *  path (wbAddTrace) so the new trace lands in the same wbTraces the Workbench
 *  tab renders/analyses/exports. Does NOT switch tabs. */
async function secAddTraceFromClick(cv: HTMLCanvasElement, e: MouseEvent) {
  if (!summary || summary.traceCount === 0) return;
  const { fx } = secPlotFrac(cv, e);
  // Fractional x across the visible window → absolute trace index in the file.
  const idx = Math.round(secView.t0 + fx * (secView.t1 - secView.t0));
  const index = Math.max(0, Math.min(summary.traceCount - 1, idx));
  try {
    $('secLabel').textContent = `Adding trace ${index + 1} to Workbench…`;
    const tr = await api.getTrace(index); // the open file is the active 'current' file
    wbAddTrace(`${summary.name} #${index + 1}`, index, tr.samples.slice(), tr.sampleInt, tr.nSamples);
    $('secLabel').textContent = `Added trace ${index + 1} to Workbench`;
  } catch (err) {
    $('secLabel').textContent = 'Add to Workbench failed: ' + errMsg(err);
  }
}

/** Attach wheel-zoom / drag-pan / double-click-fit / click-to-add to the section canvas (once). */
/** Apply the File Viewer's manual X (trace index) / Y (time, ms) overrides onto
 *  secView, then re-fetch the window. Any axis left auto keeps its current bounds
 *  (so X-only or Y-only overrides are honoured). Each axis is guarded by the
 *  control helper (finite, min<max), and we additionally derive sample indices
 *  from the ms boxes via the file's sample interval - never feeding NaN to the
 *  view-state or the canvas. */
function applySecAxisRange() {
  if (!summary || summary.traceCount === 0 || !secAxisRange) return;
  if (!secView.init) secFit();
  const v = secAxisRange.value();
  // X axis = trace index (direct).
  if (v.xMin !== null && v.xMax !== null) {
    secView.t0 = v.xMin;
    secView.t1 = v.xMax;
  }
  // Y axis = time in ms → sample index: sample = ms * 1000 / sampleInt_µs.
  const siUs = summary.sampleInt || lastSection?.sampleInt || 0;
  if (v.yMin !== null && v.yMax !== null && siUs > 0) {
    const s0 = (v.yMin * 1000) / siUs;
    const s1 = (v.yMax * 1000) / siUs;
    if (Number.isFinite(s0) && Number.isFinite(s1) && s1 > s0) {
      secView.s0 = s0;
      secView.s1 = s1;
    }
  }
  void fetchSectionWindow(); // secClamp() inside re-orders/limits to the record
}

/** Show the current visible window as placeholders in the manual-range boxes so
 *  the user always sees the live extent (blank boxes still mean "auto"). */
function syncSecAxisPlaceholders() {
  if (!secAxisRange || !lastSection) return;
  const siUs = summary?.sampleInt ?? lastSection.sampleInt ?? 0;
  const y0 = (lastSection.sampStart * siUs) / 1000;
  const y1 = (lastSection.sampEnd * siUs) / 1000;
  secAxisRange.setPlaceholders(lastSection.traceStart, lastSection.traceEnd, y0, y1);
}

function sectionInteractions() {
  const cv = $('secCanvas') as HTMLCanvasElement;
  let dragging = false, lx = 0, ly = 0;
  // Click-vs-drag guard (mirrors the SPS grid canvas): a click that moved the
  // cursor more than a few pixels is treated as a pan, not an add.
  let downX = 0, downY = 0, moved = 0;
  cv.addEventListener('wheel', (e) => {
    if ($('panel-section').style.display === 'none' || !summary || summary.traceCount === 0) return;
    e.preventDefault();
    const { fx, fy } = secPlotFrac(cv, e);
    secZoomAt(fx, fy, e.deltaY < 0 ? 1 / 1.15 : 1.15);
    void fetchSectionWindow();
  }, { passive: false });
  cv.addEventListener('mousedown', (e) => {
    if ($('panel-section').style.display === 'none' || !summary) return;
    if (secBoxMode) { startSecBoxDrag(cv, e); return; } // magnifier owns the drag
    // First-breaks mode: pressing on an existing pick starts a live drag (no pan);
    // pressing elsewhere falls through to pan, and a click without movement seeds.
    if (fbMode && e.button === 0) {
      const hit = fbHitPick(cv, e);
      if (hit >= 0) { fbDragAbs = hit; cv.style.cursor = 'ns-resize'; return; }
    }
    dragging = true; lx = e.clientX; ly = e.clientY;
    downX = e.clientX; downY = e.clientY; moved = 0;
    cv.style.cursor = 'grabbing';
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    if (fbDragAbs >= 0) { fbDragAbs = -1; fbUpdateButtons(); }
    if (!secBoxMode) cv.style.cursor = fbMode ? 'crosshair' : '';
  });
  // First-breaks live pick-drag (a global listener so the drag survives leaving cv).
  window.addEventListener('mousemove', (e) => { if (fbMode && fbDragAbs >= 0) fbDragPick(cv, e); });
  cv.addEventListener('mousemove', (e) => {
    if (!dragging || !secView.init) return;
    moved += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly);
    const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
    const pw = W - SEC_ML - SEC_MR, ph = H - SEC_MT - SEC_MB;
    // Pixel drag → index drag (drag right ⇒ window moves left, like grabbing the image).
    const dt = ((e.clientX - lx) / pw) * (secView.t1 - secView.t0);
    const ds = ((e.clientY - ly) / ph) * (secView.s1 - secView.s0);
    secView.t0 -= dt; secView.t1 -= dt;
    secView.s0 -= ds; secView.s1 -= ds;
    lx = e.clientX; ly = e.clientY;
    void fetchSectionWindow();
  });
  // A click (press + release without a real drag) adds the trace under the cursor
  // when the "+ Workbench" toggle is active; otherwise it behaves as today (no-op).
  cv.addEventListener('click', (e) => {
    if ($('panel-section').style.display === 'none' || !summary || summary.traceCount === 0) return;
    if (moved > 4 || Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) return; // a pan, not a click
    // First-breaks mode: click an existing pick to SELECT it (read-out), else drop a seed.
    if (fbMode) {
      const hit = fbHitPick(cv, e);
      if (hit >= 0) { fbSel = hit; fbRenderReadout(hit); if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection); }
      else fbPlaceSeed(cv, e);
      return;
    }
    if (!secToWb) return;
    void secAddTraceFromClick(cv, e);
  });
  // First-breaks mode: right-click deletes the nearest pick.
  cv.addEventListener('contextmenu', (e) => {
    if ($('panel-section').style.display === 'none' || !fbMode || !summary) return;
    e.preventDefault();
    fbDeletePickAt(cv, e);
  });
  cv.addEventListener('dblclick', () => {
    if ($('panel-section').style.display === 'none' || !summary) return;
    secAxisRange?.clear(); secFit(); void fetchSectionWindow();
  });
  // Toolbar buttons (added in index.html alongside the section controls).
  $opt('secZoomIn')?.addEventListener('click', () => secZoomButton(1 / 1.4));
  $opt('secZoomOut')?.addEventListener('click', () => secZoomButton(1.4));
  $opt('secZoomFit')?.addEventListener('click', () => { secAxisRange?.clear(); secFit(); void fetchSectionWindow(); });
  // Manual X (trace index) / Y (time, ms) range boxes - complement wheel/drag zoom.
  const axHost = $opt('secAxisRange');
  if (axHost) {
    secAxisRange = axisRangeControls(axHost, {
      xLabel: 'Trace #', yLabel: 'Time ms',
      xStep: '1', yStep: 'any',
      onChange: () => applySecAxisRange(),
    });
  }
  // "+ Workbench" toggle: arm/disarm click-to-add on the section canvas.
  const wbToggle = $opt('secToWb') as HTMLButtonElement | null;
  wbToggle?.addEventListener('click', () => {
    secToWb = !secToWb;
    wbToggle.classList.toggle('on', secToWb);
    wbToggle.textContent = secToWb ? 'Send to Workbench' : '+ Workbench';
    cv.style.cursor = secToWb ? 'copy' : '';
    $('secLabel').textContent = secToWb ? 'Click a trace to add it to the Workbench' : '';
    if (secToWb && secBoxMode) setSecBoxMode(false); // the two click modes are exclusive
  });
  // Live hover read-out (trace · time · amplitude + FFID/CDP/node) - Feature A.
  cv.addEventListener('mousemove', (e) => updateSecHover(cv, e));
  cv.addEventListener('mouseleave', () => clearSecHover());
  // Magnifier / box-zoom mode (drag a box → open that region in the zoom viewer).
  $opt('secBoxZoom')?.addEventListener('click', () => setSecBoxMode(!secBoxMode));
  window.addEventListener('mousemove', (e) => { if (secBoxMode && secBoxDrag) updateSecBoxDrag(cv, e); });
  window.addEventListener('mouseup', () => { if (secBoxMode && secBoxDrag) finishSecBoxDrag(cv); });
}

/** Disarm the section click-to-add toggle, resetting button label + cursor.
 *  Called on Clear / file open so the '+ Workbench' UI never stays falsely armed
 *  (clicks were a guarded no-op, but the 'copy' cursor + label were misleading). */
function disarmSecToWb() {
  secToWb = false;
  const wbToggle = $opt('secToWb') as HTMLButtonElement | null;
  if (wbToggle) {
    wbToggle.classList.remove('on');
    wbToggle.textContent = '+ Workbench';
  }
  const cv = $opt('secCanvas') as HTMLCanvasElement | null;
  if (cv) cv.style.cursor = '';
}

// -- Hover read-out (Feature A) ----------------------------------------------
// Live cursor read-out over the section + trace canvases (mirrors the SPS map's
// #spsCreateCoords caption). Every number is guarded finite before display.

/** Section hover: trace # · time (ms) · amplitude (sample value), plus an async
 *  per-trace header suffix (FFID / CDP, and the SEG-D node serial when present). */
function updateSecHover(cv: HTMLCanvasElement, e: MouseEvent) {
  const el = $opt('secHover');
  if (!el || !summary || !lastSection) return;
  if ($('panel-section').style.display === 'none') return;
  const { fx, fy } = secPlotFrac(cv, e);
  const t0 = secView.t0, t1 = secView.t1, s0 = secView.s0, s1 = secView.s1;
  const idx = Math.max(0, Math.min(summary.traceCount - 1, Math.round(t0 + fx * (t1 - t0))));
  const siUs = summary.sampleInt ?? lastSection.sampleInt ?? 0;
  const ms = ((s0 + fy * (s1 - s0)) * siUs) / 1000;
  let base = `trace ${grp(idx + 1)}`;
  if (Number.isFinite(ms)) base += `   ·   time ${ms.toFixed(1)} ms`;
  // Amplitude under the cursor from the decimated section matrix (row = trace).
  const { numTraces, colLen, data } = lastSection;
  if (numTraces > 0 && colLen > 0 && data.length >= numTraces * colLen) {
    const dc = Math.max(0, Math.min(numTraces - 1, Math.floor(fx * numTraces)));
    const dr = Math.max(0, Math.min(colLen - 1, Math.floor(fy * colLen)));
    const a = data[dc * colLen + dr];
    if (Number.isFinite(a)) base += `   ·   Amplitude (sample value) ${fmtAmpVal(a)}`;
  }
  secHoverBaseText = base;
  secHoverLastIdx = idx;
  const suffix = secHoverHdrCache.get(idx);
  el.textContent = base + (suffix ?? '');
  if (suffix === undefined) scheduleSecHoverHdr(idx);
  // First-breaks sub-bar read-out: show the pick under the cursor (trace · FFID · ch
  // · offset · ms · source · confidence) when one exists; status otherwise.
  if (fbMode && fbDragAbs < 0 && fbPicks.has(idx)) fbRenderReadout(idx);
}

function clearSecHover() {
  if (secHoverHdrTimer) { window.clearTimeout(secHoverHdrTimer); secHoverHdrTimer = 0; }
  secHoverLastIdx = -1;
  secHoverBaseText = '';
  setText('secHover', secBoxMode
    ? 'Box-zoom armed - drag a rectangle over the section (Esc to exit).'
    : 'Hover the section to read trace · time · amplitude · station.');
}

/** Debounced fetch of one trace's header so the section read-out can append the
 *  FFID / CDP (and SEG-D node serial), without flooding the worker on every move.*/
function scheduleSecHoverHdr(idx: number) {
  if (secHoverHdrCache.has(idx)) return;
  if (secHoverHdrTimer) window.clearTimeout(secHoverHdrTimer);
  secHoverHdrTimer = window.setTimeout(() => { secHoverHdrTimer = 0; void fetchSecHoverHdr(idx); }, 160);
}

async function fetchSecHoverHdr(idx: number) {
  if (!summary || secHoverHdrBusy || secHoverHdrCache.has(idx)) return;
  secHoverHdrBusy = true;
  try {
    const tr = await api.getTrace(idx);
    const suffix = secHoverHdrSuffix(tr.hdr);
    if (secHoverHdrCache.size > 600) secHoverHdrCache.clear(); // bound the cache
    secHoverHdrCache.set(idx, suffix);
    if (secHoverLastIdx === idx) {
      const elNow = $opt('secHover');
      if (elNow) elNow.textContent = secHoverBaseText + suffix;
    }
  } catch { /* header is best-effort; keep the base read-out */ }
  finally { secHoverHdrBusy = false; }
}

/** Build the " · FFID n · CDP m [· node s]" suffix from a trace header. SEG-D node
 *  serial is shown ONLY for SEG-D and ONLY when a serial key is present. */
function secHoverHdrSuffix(hdr: Record<string, number | string>): string {
  const parts: string[] = [];
  const ffid = hdrNum(hdr, 'fieldRec');
  if (ffid != null && ffid !== 0) parts.push(`FFID ${grp(ffid)}`);
  else { const sp = hdrNum(hdr, 'srcPt'); if (sp != null && sp !== 0) parts.push(`SP ${grp(sp)}`); }
  const ens = hdrNum(hdr, 'ensemble');
  if (ens != null && ens !== 0) parts.push(`CDP ${grp(ens)}`);
  if (summary?.format === 'SEG-D') {
    const node = segdNodeSerial(hdr);
    if (node != null) parts.push(`node ${grp(node)}`);
  }
  const suffix = parts.length ? '   ·   ' + parts.join(' · ') : '';
  return suffix + secHoverStationSuffix(hdr);
}

/** Nearest loaded SPS station (by projected E/N position) to (x,y): its index and
 *  squared distance. Linear scan - called once per newly-hovered trace (debounced +
 *  cached), so O(stations) is fine even for large surveys. */
function nearestSpsStation(g: SpsLines, x: number, y: number): { i: number; d2: number } {
  let bi = -1, bd = Infinity;
  for (let i = 0; i < g.x.length; i++) {
    const gx = g.x[i], gy = g.y[i];
    if (!isFinite(gx) || !isFinite(gy)) continue;
    const d2 = (gx - x) ** 2 + (gy - y) ** 2;
    if (d2 < bd) { bd = d2; bi = i; }
  }
  return { i: bi, d2: bd };
}

/** Station read-out for a hovered trace's header. Priority:
 *   (a) receiver/source resolved to a loaded SPS station by matching the header's
 *       projected coordinates to the nearest SPS point (needs SPS loaded in the
 *       projected survey-grid space and coordinates in the trace header);
 *   (b) else the source POINT number carried directly in the trace header (srcPt);
 *   (c) else "station: -" (honest - no station data available).
 *  Shows the RECEIVER station at minimum, plus the SOURCE when resolvable. */
function secHoverStationSuffix(hdr: Record<string, number | string>): string {
  const bits: string[] = [];
  // (a) nearest-SPS-match, only when SPS is loaded in projected E/N space (grid).
  //     A geographic (lon/lat) geometry can't be matched against projected header
  //     coordinates, so we fall through to (b)/(c) rather than mis-report.
  if (spsGeom && !spsGeom.geo) {
    const scalar = hdrNum(hdr, 'coordScalar') ?? 0;
    const rx = applyCoordScalar(hdrNum(hdr, 'rcvX') ?? 0, scalar);
    const ry = applyCoordScalar(hdrNum(hdr, 'rcvY') ?? 0, scalar);
    const sx = applyCoordScalar(hdrNum(hdr, 'srcX') ?? 0, scalar);
    const sy = applyCoordScalar(hdrNum(hdr, 'srcY') ?? 0, scalar);
    const tol2 = spsMatchTol2();
    if (isFinite(rx) && isFinite(ry) && (rx !== 0 || ry !== 0)) {
      const m = nearestSpsStation(spsGeom.rcv, rx, ry);
      if (m.i >= 0 && m.d2 <= tol2) {
        const g = spsGeom.rcv;
        bits.push(`R line ${String(g.names[g.line[m.i]]).trim()} pt ${grp(g.pt[m.i])}`);
      }
    }
    if (isFinite(sx) && isFinite(sy) && (sx !== 0 || sy !== 0)) {
      const m = nearestSpsStation(spsGeom.src, sx, sy);
      if (m.i >= 0 && m.d2 <= tol2) {
        const g = spsGeom.src;
        bits.push(`S line ${String(g.names[g.line[m.i]]).trim()} pt ${grp(g.pt[m.i])}`);
      }
    }
  }
  // (b) fall back to the header's own source-point number when nothing matched.
  if (!bits.length) {
    const sp = hdrNum(hdr, 'srcPt');
    if (sp != null && sp !== 0) bits.push(`S pt ${grp(sp)}`);
  }
  // (c) honest "no station" when neither a match nor a header point exists.
  return '   ·   station: ' + (bits.length ? bits.join(' · ') : '-');
}

/** Squared match tolerance (in projected units²) for pairing a trace's header
 *  coordinate to an SPS station: 1% of the survey's bbox diagonal, floored at 2 m,
 *  capped at 50 m. A geometry-loaded SEG-Y matches at ~0 distance; a wrong-CRS /
 *  ungeometried file lands far outside this and correctly reports no station. */
function spsMatchTol2(): number {
  let tol = 2;
  if (spsGeom) {
    const { minX, maxX, minY, maxY } = spsGeom.bbox;
    const diag = Math.hypot(maxX - minX, maxY - minY);
    if (isFinite(diag) && diag > 0) tol = Math.min(50, Math.max(2, diag * 0.01));
  }
  return tol * tol;
}

/** A SEG-D node / unit / receiver serial from the per-trace header, if present.
 *  The bundled SEG-D parser currently emits only { trcNum }, so this returns null
 *  today - surfacing a real serial needs a worker/core follow-up. The candidate
 *  keys are listed so a future header field shows up automatically. */
function segdNodeSerial(hdr: Record<string, number | string>): number | null {
  for (const k of ['recvSerial', 'unitSerial', 'nodeSerial', 'rxSerial', 'serialNumber', 'serial']) {
    const v = hdrNum(hdr, k);
    if (v != null && v !== 0) return v;
  }
  return null;
}

/** Trace Inspector hover: time (ms) + amplitude (sample value) under the cursor
 *  (waveform mode only - the spectrum view has its own peak/band markers). */
function updateTraceHover(cv: HTMLCanvasElement, e: MouseEvent) {
  const el = $opt('traceHover');
  if (!el || !lastTrace || traceMode !== 'wave') return;
  if ($('panel-trace').style.display === 'none') return;
  const t = lastTrace;
  const fy = tracePlotFrac(cv, e);
  const s0 = traceView.init ? traceView.s0 : 0;
  const s1 = traceView.init ? traceView.s1 : t.nSamples;
  const sample = s0 + fy * (s1 - s0);
  const ms = (sample * t.sampleInt) / 1000;
  let txt = Number.isFinite(ms) ? `time ${ms.toFixed(2)} ms` : '';
  const si = Math.max(0, Math.min(t.nSamples - 1, Math.round(sample)));
  const a = t.samples[si];
  if (Number.isFinite(a)) txt += `${txt ? '   ·   ' : ''}Amplitude (sample value) ${fmtAmpVal(a)}`;
  el.textContent = txt || 'Hover the trace to read time · amplitude.';
}

function clearTraceHover() {
  setText('traceHover', traceBoxMode
    ? 'Box-zoom armed - drag a rectangle over the trace (Esc to exit).'
    : 'Hover the trace to read time · amplitude.');
}

// -- Box-zoom magnifier (Feature B) ------------------------------------------
// Drag a rectangle over a viewer to open that region enlarged in the in-app zoom
// viewer. The rubber-band is a pure overlay div, so the canvas never re-renders
// mid-drag. Box-select is an explicit, button-toggled mode separate from pan/zoom.

function setSecBoxMode(on: boolean) {
  secBoxMode = on;
  $opt('secBoxZoom')?.classList.toggle('on', on);
  const cv = $opt('secCanvas') as HTMLCanvasElement | null;
  if (cv) cv.style.cursor = on ? 'crosshair' : '';
  if (!on) { secBoxDrag = null; hideRubber('secRubber'); }
  // Arming box-zoom disarms the conflicting "+ Workbench" click-to-add.
  if (on && secToWb) disarmSecToWb();
  clearSecHover();
}

function setTraceBoxMode(on: boolean) {
  traceBoxMode = on;
  $opt('traceBoxZoom')?.classList.toggle('on', on);
  const cv = $opt('traceCanvas') as HTMLCanvasElement | null;
  if (cv) cv.style.cursor = on ? 'crosshair' : '';
  if (!on) { traceBoxDrag = null; hideRubber('traceRubber'); }
  clearTraceHover();
}

/** Turn off both magnifier modes (Esc / Clear / mode change). */
function exitBoxModes() {
  if (secBoxMode) setSecBoxMode(false);
  if (traceBoxMode) setTraceBoxMode(false);
}

/** Position the rubber-band overlay `id` over a pixel rectangle. */
function drawRubber(id: string, box: { x0: number; y0: number; x1: number; y1: number }) {
  const el = $opt(id);
  if (!el) return;
  el.style.left = Math.min(box.x0, box.x1) + 'px';
  el.style.top = Math.min(box.y0, box.y1) + 'px';
  el.style.width = Math.abs(box.x1 - box.x0) + 'px';
  el.style.height = Math.abs(box.y1 - box.y0) + 'px';
  el.style.display = 'block';
}
function hideRubber(id: string) { const el = $opt(id); if (el) el.style.display = 'none'; }

/** Cursor pixel relative to a canvas (clamped to its box), for box-drag corners. */
function canvasPx(cv: HTMLCanvasElement, e: MouseEvent): { x: number; y: number } {
  const r = cv.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(cv.clientWidth || r.width, e.clientX - r.left)),
    y: Math.max(0, Math.min(cv.clientHeight || r.height, e.clientY - r.top)),
  };
}

function startSecBoxDrag(cv: HTMLCanvasElement, e: MouseEvent) {
  e.preventDefault();
  const p = canvasPx(cv, e);
  secBoxDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  drawRubber('secRubber', secBoxDrag);
}
function updateSecBoxDrag(cv: HTMLCanvasElement, e: MouseEvent) {
  if (!secBoxDrag) return;
  const p = canvasPx(cv, e);
  secBoxDrag.x1 = p.x; secBoxDrag.y1 = p.y;
  drawRubber('secRubber', secBoxDrag);
}
function finishSecBoxDrag(cv: HTMLCanvasElement) {
  const box = secBoxDrag; secBoxDrag = null;
  hideRubber('secRubber');
  if (!box || !summary || !lastSection) return;
  if (Math.abs(box.x1 - box.x0) < 6 || Math.abs(box.y1 - box.y0) < 6) return; // ignore a click
  const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
  const pw = W - SEC_ML - SEC_MR, ph = H - SEC_MT - SEC_MB;
  if (pw <= 0 || ph <= 0) return;
  const fracX = (px: number) => Math.max(0, Math.min(1, (px - SEC_ML) / pw));
  const fracY = (py: number) => Math.max(0, Math.min(1, (py - SEC_MT) / ph));
  const fx0 = Math.min(fracX(box.x0), fracX(box.x1)), fx1 = Math.max(fracX(box.x0), fracX(box.x1));
  const fy0 = Math.min(fracY(box.y0), fracY(box.y1)), fy1 = Math.max(fracY(box.y0), fracY(box.y1));
  const t0 = secView.t0, t1 = secView.t1, s0 = secView.s0, s1 = secView.s1;
  let nt0 = Math.round(t0 + fx0 * (t1 - t0)), nt1 = Math.round(t0 + fx1 * (t1 - t0));
  let ns0 = Math.round(s0 + fy0 * (s1 - s0)), ns1 = Math.round(s0 + fy1 * (s1 - s0));
  if (![nt0, nt1, ns0, ns1].every(Number.isFinite)) return;
  const fT = secView.fullT || summary.traceCount;
  const fS = secView.fullS || lastSection.fullSamples;
  nt0 = Math.max(0, Math.min(fT, nt0)); nt1 = Math.max(nt0 + 2, Math.min(fT, nt1));
  ns0 = Math.max(0, Math.min(fS, ns0)); ns1 = Math.max(ns0 + 4, Math.min(fS, ns1));
  if (!(nt1 > nt0) || !(ns1 > ns0)) return;
  void openSectionZoom(nt0, nt1, ns0, ns1);
}

function startTraceBoxDrag(cv: HTMLCanvasElement, e: MouseEvent) {
  e.preventDefault();
  const p = canvasPx(cv, e);
  traceBoxDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  drawRubber('traceRubber', traceBoxDrag);
}
function updateTraceBoxDrag(cv: HTMLCanvasElement, e: MouseEvent) {
  if (!traceBoxDrag) return;
  const p = canvasPx(cv, e);
  traceBoxDrag.x1 = p.x; traceBoxDrag.y1 = p.y;
  drawRubber('traceRubber', traceBoxDrag);
}
function finishTraceBoxDrag(cv: HTMLCanvasElement) {
  const box = traceBoxDrag; traceBoxDrag = null;
  hideRubber('traceRubber');
  if (!box || !lastTrace || traceMode !== 'wave') return;
  if (Math.abs(box.y1 - box.y0) < 6) return; // need a vertical (time) extent
  const t = lastTrace;
  const W = cv.clientWidth || 800, H = cv.clientHeight || 460;
  const pw = W - TRC_ML - TRC_MR, ph = H - TRC_MT - TRC_MB;
  if (pw <= 0 || ph <= 0) return;
  const cx = TRC_ML + pw / 2;
  const s0v = traceView.init ? traceView.s0 : 0;
  const s1v = traceView.init ? traceView.s1 : t.nSamples;
  const fracY = (py: number) => Math.max(0, Math.min(1, (py - TRC_MT) / ph));
  const fy0 = Math.min(fracY(box.y0), fracY(box.y1)), fy1 = Math.max(fracY(box.y0), fracY(box.y1));
  let ns0 = Math.round(s0v + fy0 * (s1v - s0v)), ns1 = Math.round(s0v + fy1 * (s1v - s0v));
  ns0 = Math.max(0, Math.min(t.nSamples - 1, ns0)); ns1 = Math.max(ns0 + 4, Math.min(t.nSamples, ns1));
  if (!Number.isFinite(ns0) || !Number.isFinite(ns1) || !(ns1 > ns0)) return;
  // Amplitude window from the box x-extent: invert drawTraceCore's xOfAmp.
  const nf = normFactorPercentile(t.samples.subarray(s0v, Math.max(s0v + 1, s1v)), 0.95) || 1;
  const useAmp = traceAmpRange !== null;
  const aMin = traceAmpRange ? traceAmpRange.min : 0;
  const aSpan = traceAmpRange ? (traceAmpRange.max - traceAmpRange.min) : 1;
  const ampOfX = (px: number) => {
    if (useAmp) return aMin + Math.max(0, Math.min(1, (px - TRC_ML) / pw)) * aSpan;
    const half = pw / 2 - 2;
    return half > 0 ? ((px - cx) / half) * nf : 0;
  };
  let amp: { min: number; max: number } | null = null;
  if (Math.abs(box.x1 - box.x0) >= 6) {
    const a0 = ampOfX(box.x0), a1 = ampOfX(box.x1);
    const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) amp = { min: lo, max: hi };
  }
  openTraceZoom(t, ns0, ns1, amp);
}

// -- Zoom viewer (in-app draggable / resizable modal) ------------------------
async function openSectionZoom(t0: number, t1: number, s0: number, s1: number) {
  if (!summary) return;
  const agc = ($('secAgc') as HTMLInputElement).checked;
  setText('secLabel', 'Opening zoom…');
  try {
    const sec = await api.getSection({
      maxTraces: 2000, maxSamples: 2000,
      traceStart: t0, traceEnd: t1, sampStart: s0, sampEnd: s1,
      agc, agcType: 'rms', agcWindowMs: 250,
    });
    zoomKind = 'section'; zoomSection = sec; zoomTrace = null;
    // Seed the in-popup magnifier at 1× over the selected region (echoed window,
    // so re-fetches stay inside real data).
    zoomMag.base = { t0: sec.traceStart, t1: sec.traceEnd, s0: sec.sampStart, s1: sec.sampEnd };
    zoomMag.z = 1; zoomMag.cx = 0.5; zoomMag.cy = 0.5;
    const siUs = summary.sampleInt ?? sec.sampleInt;
    const a = (sec.sampStart * siUs) / 1000, b = (sec.sampEnd * siUs) / 1000;
    openZoomModal(`Zoom · traces ${sec.traceStart}-${sec.traceEnd} · ${a.toFixed(0)}-${b.toFixed(0)} ms`);
    setText('secLabel', '');
  } catch (e) {
    setText('secLabel', 'Zoom failed: ' + errMsg(e));
  }
}

function openTraceZoom(t: TraceData, s0: number, s1: number, amp: { min: number; max: number } | null) {
  zoomKind = 'trace'; zoomTrace = { t, s0, s1, amp }; zoomSection = null;
  // Seed the in-popup magnifier at 1× over the selected time window (the trace's
  // samples are already in memory, so zoom/pan just re-window them).
  zoomMag.base = { t0: 0, t1: 0, s0, s1 }; zoomMag.z = 1; zoomMag.cx = 0.5; zoomMag.cy = 0.5;
  const a = (s0 * t.sampleInt) / 1000, b = (s1 * t.sampleInt) / 1000;
  openZoomModal(`Zoom · trace ${grp(t.index + 1)} · ${a.toFixed(1)}-${b.toFixed(1)} ms`);
}

function openZoomModal(title: string) {
  const back = $opt('zoomBack'); const modal = $opt('zoomModal');
  if (!back || !modal) return;
  setText('zoomTitle', title);
  back.classList.add('open');
  // Centre the fixed-position modal in the viewport (its CSS size is known now).
  const mw = modal.offsetWidth || 900, mh = modal.offsetHeight || 620;
  modal.style.left = Math.max(8, Math.round((window.innerWidth - mw) / 2)) + 'px';
  modal.style.top = Math.max(8, Math.round((window.innerHeight - mh) / 2)) + 'px';
  ensureZoomResizeObserver();
  updateZoomMagReadout();
  requestAnimationFrame(() => drawZoom());
}

function closeZoom() {
  $opt('zoomBack')?.classList.remove('open');
  zoomKind = null; zoomSection = null; zoomTrace = null;
}
function zoomViewerOpen(): boolean { return !!$opt('zoomBack')?.classList.contains('open'); }

/** Redraw the zoom canvas (re-uses the section / trace renderers on the subset). */
function drawZoom() {
  const cv = $opt('zoomCanvas') as HTMLCanvasElement | null;
  if (!cv) return;
  if (zoomKind === 'section' && zoomSection) drawSection(cv, zoomSection);
  else if (zoomKind === 'trace' && zoomTrace) drawTraceCore(cv, zoomTrace.t, zoomTrace.s0, zoomTrace.s1, zoomTrace.amp);
}

function ensureZoomResizeObserver() {
  if (zoomResizeObs || typeof ResizeObserver === 'undefined') return;
  const modal = $opt('zoomModal');
  if (!modal) return;
  zoomResizeObs = new ResizeObserver(() => { if (zoomViewerOpen()) drawZoom(); });
  zoomResizeObs.observe(modal);
}

/** Wire the zoom viewer's close / backdrop / header-drag once (called from init). */
function initZoomViewer() {
  $opt('zoomClose')?.addEventListener('click', closeZoom);
  $opt('zoomBack')?.addEventListener('click', (e) => { if (e.target === $opt('zoomBack')) closeZoom(); });
  const head = $opt('zoomDrag'); const modal = $opt('zoomModal');
  if (!head || !modal) return;
  let dragging = false, dx = 0, dy = 0;
  head.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return; // not the close button
    dragging = true;
    const r = modal.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const nx = Math.max(0, Math.min(window.innerWidth - 40, e.clientX - dx));
    const ny = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy));
    modal.style.left = nx + 'px'; modal.style.top = ny + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  // In-popup magnify controls (Feature #185): wheel-zoom toward the cursor,
  // +/-/Reset buttons, and drag-to-pan over the zoom canvas itself.
  const cv = $opt('zoomCanvas') as HTMLCanvasElement | null;
  if (cv) {
    cv.addEventListener('wheel', (e) => {
      if (!zoomViewerOpen() || !zoomKind) return;
      e.preventDefault();
      const { fx, fy } = zoomPlotFrac(cv, e);
      zoomMagZoomAt(fx, fy, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    let panning = false, plx = 0, ply = 0;
    cv.style.cursor = 'grab';
    cv.addEventListener('mousedown', (e) => {
      if (!zoomViewerOpen() || !zoomKind) return;
      panning = true; plx = e.clientX; ply = e.clientY;
      cv.style.cursor = 'grabbing'; e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!panning || !zoomViewerOpen()) return;
      const w = zoomMagWindow();
      const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
      const ML = zoomKind === 'trace' ? TRC_ML : SEC_ML;
      const MR = zoomKind === 'trace' ? TRC_MR : SEC_MR;
      const MT = zoomKind === 'trace' ? TRC_MT : SEC_MT;
      const MB = zoomKind === 'trace' ? TRC_MB : SEC_MB;
      const pw = W - ML - MR, ph = H - MT - MB;
      const b = zoomMag.base;
      const spanT0 = b.t1 - b.t0, spanS0 = b.s1 - b.s0;
      // Drag right ⇒ window moves left (grab the image), like the section viewer.
      if (pw > 0 && spanT0 > 0) zoomMag.cx -= ((e.clientX - plx) / pw) * (w.t1 - w.t0) / spanT0;
      if (ph > 0 && spanS0 > 0) zoomMag.cy -= ((e.clientY - ply) / ph) * (w.s1 - w.s0) / spanS0;
      plx = e.clientX; ply = e.clientY;
      zoomMagCommit();
    });
    window.addEventListener('mouseup', () => { if (panning) { panning = false; cv.style.cursor = 'grab'; } });
  }
  $opt('zoomMagIn')?.addEventListener('click', () => zoomMagBtn(1.4));
  $opt('zoomMagOut')?.addEventListener('click', () => zoomMagBtn(1 / 1.4));
  $opt('zoomMagReset')?.addEventListener('click', zoomMagReset);
}

// -- Zoom viewer in-popup magnify (Feature #185) -----------------------------
// Wheel / +-- / Reset / drag-pan INSIDE the box-zoom popup. A single zoom factor
// (zoomMag.z) drives both axes and the window stays inside the originally-selected
// box, so we never magnify off the chosen region. A section re-fetches its
// sub-window at full detail (re-sampled from the underlying traces → stays crisp);
// a single trace re-windows its already-loaded samples. Every value reaching the
// canvas is guarded finite + min<max by zoomMagWindow / the shared renderers.

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);

/** Largest magnification the current base region allows (keeps ≥ a few traces /
 *  samples visible so we can never zoom into nothing). Always ≥ 1. */
function zoomMagZMax(): number {
  const b = zoomMag.base;
  const spanS0 = b.s1 - b.s0;
  if (zoomKind === 'trace') return Math.max(1, Math.min(ZOOM_MAG_MAX, spanS0 / ZOOM_MAG_MIN_SAMP));
  const spanT0 = b.t1 - b.t0;
  return Math.max(1, Math.min(ZOOM_MAG_MAX, spanT0 / ZOOM_MAG_MIN_TR, spanS0 / ZOOM_MAG_MIN_SAMP));
}

/** Derive the current visible sub-window (absolute indices) from base + z + centre,
 *  clamped inside the base region with its span preserved. Integer + guarded so no
 *  NaN can reach a canvas; a single-trace region (spanT0 === 0) keeps the trace
 *  axis pinned to the base. */
function zoomMagWindow(): { t0: number; t1: number; s0: number; s1: number } {
  const b = zoomMag.base;
  const z = Number.isFinite(zoomMag.z) && zoomMag.z >= 1 ? zoomMag.z : 1;
  const spanT0 = b.t1 - b.t0, spanS0 = b.s1 - b.s0;
  let t0 = b.t0, t1 = b.t1;
  if (spanT0 > 0) {
    const span = spanT0 / z;
    const c = b.t0 + clamp01(zoomMag.cx) * spanT0;
    t0 = c - span / 2; t1 = c + span / 2;
    if (t0 < b.t0) { t1 += b.t0 - t0; t0 = b.t0; }
    if (t1 > b.t1) { t0 -= t1 - b.t1; t1 = b.t1; }
    if (t0 < b.t0) t0 = b.t0;
  }
  let s0 = b.s0, s1 = b.s1;
  if (spanS0 > 0) {
    const span = spanS0 / z;
    const c = b.s0 + clamp01(zoomMag.cy) * spanS0;
    s0 = c - span / 2; s1 = c + span / 2;
    if (s0 < b.s0) { s1 += b.s0 - s0; s0 = b.s0; }
    if (s1 > b.s1) { s0 -= s1 - b.s1; s1 = b.s1; }
    if (s0 < b.s0) s0 = b.s0;
  }
  return { t0: Math.round(t0), t1: Math.round(t1), s0: Math.round(s0), s1: Math.round(s1) };
}

/** Clamp the (continuous) window centre so the z-scaled sub-window stays inside the
 *  base region. Done in CONTINUOUS space - not re-derived from the rounded display
 *  window - so sub-trace pan steps accumulate instead of quantising away (a coarse
 *  trace axis would otherwise round each step back to the same integer centre). */
function zoomMagClampCentre() {
  const z = Number.isFinite(zoomMag.z) && zoomMag.z >= 1 ? zoomMag.z : 1;
  const half = 1 / (2 * z); // half the window span as a fraction of the base span
  const lo = half, hi = 1 - half;
  if (lo <= hi) {
    zoomMag.cx = Math.min(hi, Math.max(lo, Number.isFinite(zoomMag.cx) ? zoomMag.cx : 0.5));
    zoomMag.cy = Math.min(hi, Math.max(lo, Number.isFinite(zoomMag.cy) ? zoomMag.cy : 0.5));
  } else {
    zoomMag.cx = 0.5; zoomMag.cy = 0.5; // window == base (z ≈ 1)
  }
}

/** Zoom toward a plot fraction (fx,fy of the CURRENT window) by `factorIn`
 *  (>1 zooms in). The data point under the cursor stays put. */
function zoomMagZoomAt(fx: number, fy: number, factorIn: number) {
  if (!zoomViewerOpen() || !zoomKind) return;
  const cur = zoomMagWindow();
  const dpT = cur.t0 + fx * (cur.t1 - cur.t0);
  const dpS = cur.s0 + fy * (cur.s1 - cur.s0);
  const b = zoomMag.base;
  const spanT0 = b.t1 - b.t0, spanS0 = b.s1 - b.s0;
  const f = Number.isFinite(factorIn) && factorIn > 0 ? factorIn : 1;
  zoomMag.z = Math.max(1, Math.min(zoomMagZMax(), zoomMag.z * f));
  const spanT = spanT0 / zoomMag.z, spanS = spanS0 / zoomMag.z;
  if (spanT0 > 0) zoomMag.cx = clamp01((dpT + (0.5 - fx) * spanT - b.t0) / spanT0);
  if (spanS0 > 0) zoomMag.cy = clamp01((dpS + (0.5 - fy) * spanS - b.s0) / spanS0);
  zoomMagCommit();
}

/** Zoom toward the canvas centre (the +/- buttons). */
function zoomMagBtn(factorIn: number) { if (zoomViewerOpen()) zoomMagZoomAt(0.5, 0.5, factorIn); }

/** Reset to the original box framing (1× / fit). */
function zoomMagReset() { zoomMag.z = 1; zoomMag.cx = 0.5; zoomMag.cy = 0.5; zoomMagCommit(); }

/** Apply the current magnify state: re-window the trace in place, or re-fetch the
 *  section sub-window from the worker, then refresh the title + readout. */
function zoomMagCommit() {
  zoomMagClampCentre();
  const w = zoomMagWindow();
  updateZoomMagReadout();
  if (zoomKind === 'trace' && zoomTrace) {
    zoomTrace.s0 = w.s0; zoomTrace.s1 = w.s1; // amplitude window stays the box's
    if (zoomViewerOpen()) drawZoom();
    const si = zoomTrace.t.sampleInt;
    setText('zoomTitle', `Zoom · trace ${grp(zoomTrace.t.index + 1)} · ${((w.s0 * si) / 1000).toFixed(1)}-${((w.s1 * si) / 1000).toFixed(1)} ms`);
  } else if (zoomKind === 'section') {
    void zoomMagFetchSection();
  }
}

/** Re-request the popup's current sub-window at full detail and repaint. Coalesces
 *  bursts of wheel/pan events (same pattern as fetchSectionWindow). */
async function zoomMagFetchSection() {
  if (zoomKind !== 'section' || !summary) return;
  if (zoomMagFetchPending) return; // a fetch is in flight; it repaints with the latest state
  zoomMagFetchPending = true;
  const agc = ($('secAgc') as HTMLInputElement).checked;
  try {
    let again = true, snap = '';
    while (again) {
      const w = zoomMagWindow();
      snap = `${w.t0},${w.t1},${w.s0},${w.s1}`;
      const sec = await api.getSection({
        maxTraces: 2000, maxSamples: 2000,
        traceStart: w.t0, traceEnd: w.t1, sampStart: w.s0, sampEnd: w.s1,
        agc, agcType: 'rms', agcWindowMs: 250,
      });
      if (zoomKind !== 'section') return; // popup closed / switched mid-flight
      zoomSection = sec;
      if (zoomViewerOpen()) drawZoom();
      const siUs = summary.sampleInt ?? sec.sampleInt;
      const a = (sec.sampStart * siUs) / 1000, b = (sec.sampEnd * siUs) / 1000;
      setText('zoomTitle', `Zoom · traces ${sec.traceStart}-${sec.traceEnd} · ${a.toFixed(0)}-${b.toFixed(0)} ms`);
      const w2 = zoomMagWindow();
      again = `${w2.t0},${w2.t1},${w2.s0},${w2.s1}` !== snap;
    }
  } catch (e) {
    setText('secLabel', 'Zoom failed: ' + errMsg(e));
  } finally {
    zoomMagFetchPending = false;
  }
}

/** Cursor pixel over the zoom canvas → plot fraction (0..1) along each axis,
 *  using the active renderer's margins (section vs single trace). */
function zoomPlotFrac(cv: HTMLCanvasElement, e: MouseEvent): { fx: number; fy: number } {
  const r = cv.getBoundingClientRect();
  const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
  const ML = zoomKind === 'trace' ? TRC_ML : SEC_ML;
  const MR = zoomKind === 'trace' ? TRC_MR : SEC_MR;
  const MT = zoomKind === 'trace' ? TRC_MT : SEC_MT;
  const MB = zoomKind === 'trace' ? TRC_MB : SEC_MB;
  const pw = W - ML - MR, ph = H - MT - MB;
  const px = e.clientX - r.left - ML, py = e.clientY - r.top - MT;
  return {
    fx: pw > 0 ? Math.max(0, Math.min(1, px / pw)) : 0.5,
    fy: ph > 0 ? Math.max(0, Math.min(1, py / ph)) : 0.5,
  };
}

/** Refresh the "2.0×" readout and enable/disable the +/- buttons at the limits. */
function updateZoomMagReadout() {
  const z = Number.isFinite(zoomMag.z) && zoomMag.z >= 1 ? zoomMag.z : 1;
  setText('zoomLevel', z.toFixed(1) + '×');
  const inB = $opt('zoomMagIn') as HTMLButtonElement | null;
  const outB = $opt('zoomMagOut') as HTMLButtonElement | null;
  if (inB) inB.disabled = z >= zoomMagZMax() - 1e-6;
  if (outB) outB.disabled = z <= 1 + 1e-6;
}

// -- Trace Inspector time-axis zoom / pan (renderer-only) --
// The full trace is already in lastTrace.samples, so zoom/pan just re-windows
// [s0,s1) and repaints - no worker round-trip. Mirrors the section interactions.

/** Reset the visible window to the whole trace ("fit"). */
function traceFit(t: TraceData) {
  traceView.fullS = t.nSamples;
  traceView.s0 = 0;
  traceView.s1 = t.nSamples;
  traceView.init = true;
}

/** Keep the visible window inside the trace (never pan/zoom off the data). */
function traceClamp() {
  const fS = traceView.fullS;
  const minS = Math.min(fS, 4); // can't zoom into fewer than a few samples
  let { s0, s1 } = traceView;
  if (s1 - s0 < minS) s1 = s0 + minS;
  if (s1 - s0 > fS) { s0 = 0; s1 = fS; }
  if (s0 < 0) { s1 -= s0; s0 = 0; }
  if (s1 > fS) { s0 -= s1 - fS; s1 = fS; }
  traceView.s0 = Math.max(0, Math.round(s0));
  traceView.s1 = Math.min(fS, Math.round(s1));
}

/** Map a cursor pixel inside the trace canvas to a fractional position (0..1)
 *  down the plot rectangle (the time axis), clamped to the data area. */
function tracePlotFrac(cv: HTMLCanvasElement, e: MouseEvent): number {
  const r = cv.getBoundingClientRect();
  const H = cv.clientHeight || 460;
  const MT = 14, MB = 26, ph = H - MT - MB;
  const py = e.clientY - r.top - MT;
  return ph > 0 ? Math.max(0, Math.min(1, py / ph)) : 0;
}

/** Zoom the visible sample window toward a fractional anchor `fy` by `factor`
 *  (<1 zooms in). The sample under the cursor stays put. */
function traceZoomAt(fy: number, factor: number) {
  if (!lastTrace) return;
  if (!traceView.init || traceView.fullS !== lastTrace.nSamples) traceFit(lastTrace);
  const as = traceView.s0 + fy * (traceView.s1 - traceView.s0); // anchor sample
  const ws = (traceView.s1 - traceView.s0) * factor;
  traceView.s0 = as - fy * ws;
  traceView.s1 = as + (1 - fy) * ws;
  traceClamp();
}

/** Zoom toward the canvas centre (toolbar +/- buttons), then repaint. */
function traceZoomButton(factor: number) {
  if (!lastTrace || traceMode !== 'wave') return;
  traceZoomAt(0.5, factor);
  renderTrace();
}

/** Apply the Trace Inspector's manual X (time, ms) / Y (amplitude) overrides.
 *  X writes the sample window the existing zoom uses (ms→sample via sampleInt);
 *  Y sets the raw-amplitude window the wiggle stretches across. Each axis left
 *  blank stays auto. Every value is pre-guarded (finite, min<max) by the control
 *  helper, and we re-validate the derived sample window before writing it. */
function applyTraceAxisRange() {
  if (!lastTrace || !traceAxisRange) return;
  const t = lastTrace;
  if (!traceView.init || traceView.fullS !== t.nSamples) traceFit(t);
  const v = traceAxisRange.value();
  // X axis = time in ms → sample index: sample = ms * 1000 / sampleInt_µs.
  if (v.xMin !== null && v.xMax !== null && t.sampleInt > 0) {
    const s0 = (v.xMin * 1000) / t.sampleInt;
    const s1 = (v.xMax * 1000) / t.sampleInt;
    if (Number.isFinite(s0) && Number.isFinite(s1) && s1 > s0) {
      traceView.s0 = s0;
      traceView.s1 = s1;
      traceClamp();
    }
    traceManualX = true;
  } else if (traceManualX) {
    // X transitioned from a manual pin back to auto ⇒ fit the whole time axis.
    // (A blank X pair while no manual pin was active means the user only touched
    //  the Amp boxes - leave any existing wheel/button zoom untouched.)
    traceFit(t);
    traceManualX = false;
  }
  // Y axis = amplitude (raw sample units); null ⇒ auto-normalized.
  traceAmpRange = (v.yMin !== null && v.yMax !== null) ? { min: v.yMin, max: v.yMax } : null;
  renderTrace();
}

/** Reflect the current visible time window + the auto amplitude swing as
 *  placeholders in the trace's manual-range boxes (blank still means auto). */
function syncTraceAxisPlaceholders() {
  if (!traceAxisRange || !lastTrace) return;
  const t = lastTrace;
  const msPerSample = t.sampleInt / 1000;
  const s0 = traceView.init ? traceView.s0 : 0;
  const s1 = traceView.init ? traceView.s1 : t.nSamples;
  // Auto amplitude swing is the ±95th-percentile normalization factor.
  const nf = normFactorPercentile(t.samples.subarray(s0, Math.max(s0 + 1, s1)), 0.95) || 1;
  traceAxisRange.setPlaceholders(s0 * msPerSample, s1 * msPerSample, -nf, nf);
}

/** Attach wheel-zoom / drag-pan / double-click-fit to the trace canvas (once).
 *  Guarded on the trace panel being visible and a waveform being shown. */
function traceInteractions() {
  const cv = $('traceCanvas') as HTMLCanvasElement;
  const active = () =>
    $('panel-trace').style.display !== 'none' && !!lastTrace && traceMode === 'wave';
  let dragging = false, ly = 0;
  cv.addEventListener('wheel', (e) => {
    if (!active()) return;
    e.preventDefault();
    const fy = tracePlotFrac(cv, e);
    traceZoomAt(fy, e.deltaY < 0 ? 1 / 1.15 : 1.15); // wheel up ⇒ zoom in
    renderTrace();
  }, { passive: false });
  cv.addEventListener('mousedown', (e) => {
    if (!active()) return;
    if (traceBoxMode) { startTraceBoxDrag(cv, e); return; } // magnifier owns the drag
    dragging = true; ly = e.clientY; cv.style.cursor = 'grabbing';
  });
  window.addEventListener('mouseup', () => { dragging = false; if (!traceBoxMode) cv.style.cursor = ''; });
  cv.addEventListener('mousemove', (e) => {
    if (!dragging || !traceView.init || !active()) return;
    const H = cv.clientHeight || 460;
    const MT = 14, MB = 26, ph = H - MT - MB;
    if (ph <= 0) return;
    // Pixel drag → sample drag (drag down ⇒ window moves up, like grabbing the trace).
    const ds = ((e.clientY - ly) / ph) * (traceView.s1 - traceView.s0);
    traceView.s0 -= ds; traceView.s1 -= ds;
    traceClamp();
    ly = e.clientY;
    renderTrace();
  });
  cv.addEventListener('dblclick', () => {
    if (!active()) return;
    traceAxisRange?.clear(); traceAmpRange = null; traceFit(lastTrace!); renderTrace();
  });
  // Toolbar buttons (added in index.html alongside the Waveform/Spectrum toggle).
  $opt('traceZoomIn')?.addEventListener('click', () => traceZoomButton(1 / 1.4));
  $opt('traceZoomOut')?.addEventListener('click', () => traceZoomButton(1.4));
  $opt('traceZoomFit')?.addEventListener('click', () => {
    if (lastTrace) { traceAxisRange?.clear(); traceAmpRange = null; traceFit(lastTrace); renderTrace(); }
  });
  // Manual X (time, ms) / Y (amplitude) range boxes - complement wheel/drag zoom.
  const axHost = $opt('traceAxisRange');
  if (axHost) {
    traceAxisRange = axisRangeControls(axHost, {
      xLabel: 'Time ms', yLabel: 'Amp',
      onChange: () => applyTraceAxisRange(),
    });
  }
  // Live hover read-out (time · amplitude, waveform mode only) - Feature A.
  cv.addEventListener('mousemove', (e) => updateTraceHover(cv, e));
  cv.addEventListener('mouseleave', () => clearTraceHover());
  // Magnifier / box-zoom mode (drag a box → open that region in the zoom viewer).
  $opt('traceBoxZoom')?.addEventListener('click', () => setTraceBoxMode(!traceBoxMode));
  window.addEventListener('mousemove', (e) => { if (traceBoxMode && traceBoxDrag) updateTraceBoxDrag(cv, e); });
  window.addEventListener('mouseup', () => { if (traceBoxMode && traceBoxDrag) finishTraceBoxDrag(cv); });
}

// -- Trace Workbench --
// Collect individual traces from arbitrary files (or the currently-open file)
// and compare them side-by-side or overlaid, all zoomed/panned together on one
// shared time axis. Wiggle drawing reuses drawTrace's centre-axis mapping; the
// shared wbView mirrors the inspector's traceView so the interactions match.

/** Longest trace in the collection (samples), or 0 when empty - the time extent. */
function wbMaxSamples(): number {
  let m = 0;
  for (const t of wbTraces) if (t.nSamples > m) m = t.nSamples;
  return m;
}

/** Reset the shared time window to the full extent ("fit"). */
function wbFit() {
  const full = wbMaxSamples();
  wbView.fullS = full;
  wbView.s0 = 0;
  wbView.s1 = full;
  wbView.init = true;
}

/** Keep the shared window inside the data (never pan/zoom off the longest trace). */
function wbClamp() {
  const fS = wbView.fullS;
  const minS = Math.min(fS, 4);
  let { s0, s1 } = wbView;
  if (s1 - s0 < minS) s1 = s0 + minS;
  if (s1 - s0 > fS) { s0 = 0; s1 = fS; }
  if (s0 < 0) { s1 -= s0; s0 = 0; }
  if (s1 > fS) { s0 -= s1 - fS; s1 = fS; }
  wbView.s0 = Math.max(0, Math.round(s0));
  wbView.s1 = Math.min(fS, Math.round(s1));
}

/** Cursor pixel → fractional position (0..1) down the plot's time axis. */
function wbPlotFrac(cv: HTMLCanvasElement, e: MouseEvent): number {
  const r = cv.getBoundingClientRect();
  const H = cv.clientHeight || 460;
  const MT = 14, MB = 26, ph = H - MT - MB;
  const py = e.clientY - r.top - MT;
  return ph > 0 ? Math.max(0, Math.min(1, py / ph)) : 0;
}

/** Zoom the shared window toward fractional anchor `fy` by `factor` (<1 zooms in). */
function wbZoomAt(fy: number, factor: number) {
  if (!wbTraces.length) return;
  if (!wbView.init || wbView.fullS !== wbMaxSamples()) wbFit();
  const as = wbView.s0 + fy * (wbView.s1 - wbView.s0);
  const ws = (wbView.s1 - wbView.s0) * factor;
  wbView.s0 = as - fy * ws;
  wbView.s1 = as + (1 - fy) * ws;
  wbClamp();
}

/** Zoom toward the canvas centre (toolbar +/- buttons), then repaint. */
function wbZoomButton(factor: number) {
  if (!wbTraces.length) return;
  wbZoomAt(0.5, factor);
  drawWorkbench();
}

/** Pick a file (no parse), then add the chosen trace # to the collection. */
/** Pick a file, remember it, and PREVIEW its current-index trace (does NOT add).
 *  The user then steps traces (Prev/Next/#) and commits one via 'Add this trace'. */
async function wbPickFile() {
  try {
    const path = await api.pickTraceFile();
    if (!path) return; // cancelled - keep any existing preview intact
    wbPickedPath = path;
    wbPickedCount = 0; // learned from the first extract (ExtractedTrace.traceCount)
    const idxIn = $opt('wbIndex') as HTMLInputElement | null;
    const index = Math.max(0, parseInt(idxIn?.value || '0', 10) || 0);
    await wbLoadPreview(index);
  } catch (e) {
    setStatus('wbStatus', 'Pick failed: ' + errMsg(e), 'err');
  }
}

/** Extract + draw the preview for trace `index` of the picked file. Clamps the
 *  index to [0, traceCount-1] once the count is known; guards extract failures. */
async function wbLoadPreview(index: number) {
  if (!wbPickedPath || wbPreviewBusy) return;
  // Clamp against the known count (first load doesn't know it yet → clamp >=0).
  const hi = wbPickedCount > 0 ? wbPickedCount - 1 : Number.MAX_SAFE_INTEGER;
  const idx = Math.max(0, Math.min(hi, Number.isFinite(index) ? index : 0));
  wbPreviewBusy = true;
  setStatus('wbStatus', 'Reading trace…');
  try {
    const tr = await api.extractTrace(wbPickedPath, idx);
    wbPreview = tr;
    wbPickedCount = Math.max(1, tr.traceCount || 1);
    wbSetIndexInput(tr.index);
    wbRenderPreview();
    setStatus('wbStatus', `Previewing ${tr.name} · trace ${tr.index + 1} of ${wbPickedCount}`, 'ok');
  } catch (e) {
    wbPreview = null;
    wbRenderPreview();
    setStatus('wbStatus', 'Read failed: ' + errMsg(e), 'err');
  } finally {
    wbPreviewBusy = false;
  }
}

/** Reflect a (clamped) trace index back into the #wbIndex input + max attr. */
function wbSetIndexInput(index: number) {
  const idxIn = $opt('wbIndex') as HTMLInputElement | null;
  if (!idxIn) return;
  idxIn.value = String(index);
  if (wbPickedCount > 0) idxIn.max = String(wbPickedCount - 1);
}

/** Step the previewed trace by ±1 (or load the value typed in #wbIndex). */
function wbStepPreview(delta: number) {
  if (!wbPickedPath) { setStatus('wbStatus', 'Pick a file first.', 'err'); return; }
  const cur = wbPreview ? wbPreview.index : 0;
  void wbLoadPreview(cur + delta);
}

/** Add the currently-previewed trace to the collection. */
function wbAddPreview() {
  if (!wbPreview) { setStatus('wbStatus', 'Pick a file and preview a trace first.', 'err'); return; }
  const tr = wbPreview;
  wbAddTrace(tr.name, tr.index, tr.samples.slice(), tr.sampleInt, tr.nSamples);
  setStatus('wbStatus', `Added ${tr.name} · trace ${tr.index + 1} (of ${wbPickedCount})`, 'ok');
}

/** Draw the preview canvas + sync the preview card visibility / Add-button. */
function wbRenderPreview() {
  const card = $opt('wbPreviewCard');
  const addBtn = $opt('wbAddPreviewBtn') as HTMLButtonElement | null;
  const lbl = $opt('wbPreviewLabel');
  const cv = $opt('wbPreviewCanvas') as HTMLCanvasElement | null;
  const have = !!wbPreview;
  if (card) card.style.display = wbPickedPath ? '' : 'none';
  if (addBtn) addBtn.disabled = !have;
  if (lbl) {
    lbl.textContent = have
      ? `${wbPreview!.name} · trace ${wbPreview!.index + 1} of ${wbPickedCount} · ${wbPreview!.nSamples} samples`
      : (wbPickedPath ? 'Could not read this trace - try another index.' : 'Pick a file, step traces, then “Add this trace”.');
  }
  if (cv) {
    if (wbPreview) {
      const t: TraceData = {
        index: wbPreview.index, nSamples: wbPreview.nSamples, sampleInt: wbPreview.sampleInt,
        hdr: wbPreview.hdr, samples: wbPreview.samples,
      };
      drawPreviewTrace(cv, t, '#34dbd0');
    } else {
      // Clear to the canvas background so a failed read shows an empty plot.
      const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth || 800, H = cv.clientHeight || 240;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      const ctx = cv.getContext('2d'); if (ctx) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#0d1f33'; ctx.fillRect(0, 0, W, H); }
    }
  }
}

/** Self-contained single-trace wiggle for the preview canvas. Mirrors drawTrace's
 *  layout (95th-pct auto-normalized amplitude + ms time axis) but owns its own
 *  window (full trace) so it never disturbs the Inspector's shared traceView.
 *  Every numeric is guarded so NaN can't reach the canvas. */
function drawPreviewTrace(cv: HTMLCanvasElement, t: TraceData, color: string) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800, H = cv.clientHeight || 240;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d'); if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);
  const n = t.nSamples;
  if (!n || !t.samples.length) return;
  const ML = 60, MR = 14, MT = 14, MB = 26;
  const pw = W - ML - MR, ph = H - MT - MB;
  if (pw < 4 || ph < 4) return;
  const cx = ML + pw / 2;
  const nf = normFactorPercentile(t.samples.subarray(0, n), 0.95) || 1;
  const safeNf = Number.isFinite(nf) && nf > 0 ? nf : 1;
  const xOfAmp = (raw: number) => {
    const r = Number.isFinite(raw) ? raw : 0;
    const v = Math.max(-1, Math.min(1, r / safeNf));
    return cx + v * (pw / 2 - 2);
  };
  ctx.strokeStyle = '#214564'; ctx.lineWidth = 1;
  ctx.strokeRect(ML, MT, pw, ph);
  ctx.beginPath(); ctx.moveTo(cx, MT); ctx.lineTo(cx, MT + ph);
  ctx.strokeStyle = '#264a68'; ctx.stroke();
  ctx.beginPath();
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  const denom = n > 1 ? n - 1 : 1;
  for (let i = 0; i < n; i++) {
    const x = xOfAmp(t.samples[i]);
    const y = MT + (i / denom) * ph;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // time axis (ms down)
  ctx.fillStyle = '#7e93ac'; ctx.font = '10px Consolas, monospace';
  const msPerSample = (Number.isFinite(t.sampleInt) ? t.sampleInt : 0) / 1000;
  drawMsTimeGrid(ctx, ML, MT, pw, ph, 0, denom, msPerSample);
  // amplitude caption (dimensionless sample value)
  ctx.fillStyle = '#5f7793'; ctx.textAlign = 'center';
  ctx.fillText('Amplitude (sample value)', ML + pw / 2, MT + ph - 4);
  ctx.textAlign = 'left';
}

/** Add the currently-open file's current trace (Trace Inspector selection). */
function wbAddOpenTrace() {
  if (!summary || !lastTrace) {
    setStatus('wbStatus', 'Open a file and pick a trace first.', 'err');
    return;
  }
  wbAddTrace(summary.name, lastTrace.index, lastTrace.samples.slice(), lastTrace.sampleInt, lastTrace.nSamples);
  setStatus('wbStatus', `Added open file · trace ${lastTrace.index + 1}`, 'ok');
}

/** Push one trace into the collection (distinct colour), refit + redraw. */
function wbAddTrace(sourceName: string, traceIndex: number, samples: Float32Array, sampleInt: number, nSamples: number) {
  const color = WB_COLORS[(wbNextId - 1) % WB_COLORS.length];
  wbTraces.push({ id: wbNextId++, sourceName, traceIndex, samples, sampleInt, nSamples, color });
  wbFit(); // new extent ⇒ refit the shared window so the addition is visible
  renderWorkbenchList();
  drawWorkbench();
  wbUpdateAnalysis();
  wbUpdateExport();
}

/** Remove one trace by id; refit + redraw (clears the view when empty).
 *  Provenance: confirm + audit + undo (re-inserts at the original position). */
async function wbRemove(id: number) {
  const pos = wbTraces.findIndex((t) => t.id === id);
  if (pos < 0) return;
  const saved = wbTraces[pos];
  const what = `${saved.sourceName} · trace ${saved.traceIndex + 1}`;
  if (!(await confirmDelete(`Remove ${what} from the workbench?`))) return;
  // Re-find by id in case the list changed while the dialog was open.
  const at = wbTraces.findIndex((t) => t.id === id);
  if (at < 0) return;
  wbTraces.splice(at, 1);
  wbFit();
  renderWorkbenchList();
  drawWorkbench();
  wbUpdateAnalysis();
  wbUpdateExport();
  audit('delete', `trace ${what}`, 'workbench');
  let undone = false;
  undoToast(`Removed ${what}`, () => {
    if (undone) return;
    undone = true;
    const ins = Math.min(at, wbTraces.length);
    wbTraces.splice(ins, 0, saved);
    wbFit();
    renderWorkbenchList();
    drawWorkbench();
    wbUpdateAnalysis();
    wbUpdateExport();
    audit('undo-delete', `trace ${what}`, 'workbench');
  });
}

/** Drop the whole collection. */
function wbClear() {
  wbTraces = [];
  wbView.init = false;
  wbAmp = null;
  wbAxisRange?.clear();
  wbSelA = -1;
  wbSelB = -1;
  renderWorkbenchList();
  drawWorkbench();
  wbUpdateAnalysis();
  wbUpdateExport();
  setStatus('wbExportStatus', '');
  setStatus('wbStatus', '');
}

/** Switch the display mode (side-by-side vs overlay) + repaint. */
function wbSetMode(m: 'side' | 'overlay') {
  if (wbMode === m) return;
  wbMode = m;
  $opt('wbModeSide')?.classList.toggle('on', m === 'side');
  $opt('wbModeOverlay')?.classList.toggle('on', m === 'overlay');
  drawWorkbench();
}

/** Render the collected-trace list (source · trace # · colour swatch + remove). */
function renderWorkbenchList() {
  updateHeaderClear();   // workbench contents changed → refresh header Clear state
  const list = $opt('wbList');
  if (!list) return;
  if (!wbTraces.length) {
    list.innerHTML = '<div class="hdr-empty">No traces collected yet.</div>';
    return;
  }
  list.innerHTML = '';
  for (const t of wbTraces) {
    const row = document.createElement('div');
    row.className = 'wb-item';
    const sw = document.createElement('span');
    sw.className = 'wb-swatch';
    sw.style.background = t.color;
    const lbl = document.createElement('span');
    lbl.className = 'wb-item-lbl';
    lbl.textContent = `${t.sourceName} · trace ${t.traceIndex + 1}`;
    const rm = document.createElement('button');
    rm.className = 'wb-rm';
    rm.title = 'Remove';
    rm.textContent = '✕';
    rm.addEventListener('click', () => wbRemove(t.id));
    row.append(sw, lbl, rm);
    list.appendChild(row);
  }
}

/** Draw one trace's wiggle in a vertical band centred at `cx`, half-width `hw`,
 *  over the shared time window [s0,s1) - reuses drawTrace's centre-axis mapping.
 *  `nf` is the normalization factor (per-trace in side mode, shared in overlay). */
function wbDrawWiggle(ctx: CanvasRenderingContext2D, t: WbTrace, cx: number, hw: number, MT: number, ph: number, s0: number, s1: number, nf: number, color: string, amp: { min: number; max: number } | null = null) {
  const span = s1 - s0;
  if (span < 1) return;
  const denom = span > 1 ? span - 1 : 1;
  const lo = Math.max(0, s0), hi = Math.min(t.nSamples, s1);
  // Amplitude → x. Default: auto, centred at cx with ±(hw-2) full-swing. Manual:
  // map the raw [min,max] window across the column band [cx-hw, cx+hw] (left=min),
  // clamped so an out-of-window sample can't draw outside the column. The manual
  // pair is pre-guarded finite + min<max, so aSpan>0 - never a NaN x.
  const useAmp = amp !== null;
  const aMin = amp ? amp.min : 0;
  const aSpan = amp ? (amp.max - amp.min) : 1;
  const xOf = (raw: number) =>
    useAmp ? (cx - hw) + Math.max(0, Math.min(1, (raw - aMin) / aSpan)) * (2 * hw)
           : cx + Math.max(-1, Math.min(1, raw / nf)) * (hw - 2);
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  let started = false;
  for (let i = lo; i < hi; i++) {
    // Polarity flip is applied to the VALUE, so it works identically under the
    // auto mapping and under a manual amplitude window.
    const x = xOf(wbInvert ? -t.samples[i] : t.samples[i]);
    const y = MT + ((i - s0) / denom) * ph;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** Paint the workbench canvas: empty placeholder, side-by-side columns, or a
 *  shared-axis overlay. Time mapping + zoom window are shared across all traces
 *  so they stay aligned; a small legend labels each colour. */
function drawWorkbench() {
  const cv = $opt('wbCanvas') as HTMLCanvasElement | null;
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800;
  const H = cv.clientHeight || 460;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);

  if (!wbTraces.length) {
    ctx.fillStyle = '#5e7186';
    ctx.font = '13px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Pick traces to compare', W / 2, H / 2);
    ctx.textAlign = 'left';
    return;
  }

  if (!wbView.init || wbView.fullS !== wbMaxSamples()) wbFit();
  const s0 = wbView.s0, s1 = wbView.s1;
  if (s1 - s0 < 1) return;

  const ML = 60, MR = 14, MT = 14, MB = 26;
  const pw = W - ML - MR, ph = H - MT - MB;

  ctx.strokeStyle = '#214564';
  ctx.lineWidth = 1;
  ctx.strokeRect(ML, MT, pw, ph);

  // Time axis (ms down) - labelled from the longest trace's sample interval, or
  // the first trace's if they differ. Mapping is the SAME for every trace so the
  // side-by-side columns and the overlay all line up in time.
  const si = wbTraces[0].sampleInt || 0;
  const denom = s1 - s0 > 1 ? s1 - s0 - 1 : 1;
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  const msPerSample = si / 1000;
  drawMsTimeGrid(ctx, ML, MT, pw, ph, s0, denom, msPerSample);

  if (wbMode === 'side') {
    // Split the plot width into N equal columns; each trace's wiggle is centred
    // in its column and normalized over its OWN visible window (independent gain).
    const n = wbTraces.length;
    const colW = pw / n;
    for (let j = 0; j < n; j++) {
      const t = wbTraces[j];
      const cx = ML + colW * (j + 0.5);
      const hw = colW / 2;
      // column divider + faint centre axis
      if (j > 0) {
        ctx.strokeStyle = '#173049';
        ctx.beginPath(); ctx.moveTo(ML + colW * j, MT); ctx.lineTo(ML + colW * j, MT + ph); ctx.stroke();
      }
      ctx.strokeStyle = '#264a68';
      ctx.beginPath(); ctx.moveTo(cx, MT); ctx.lineTo(cx, MT + ph); ctx.stroke();
      const lo = Math.max(0, s0), hi = Math.min(t.nSamples, s1);
      const nf = (hi > lo ? normFactorPercentile(t.samples.subarray(lo, hi), 0.95) : 0) || 1;
      wbDrawWiggle(ctx, t, cx, hw, MT, ph, s0, s1, nf, t.color, wbAmp);
      // per-column label
      ctx.fillStyle = t.color;
      ctx.font = '10px Consolas, monospace';
      ctx.textAlign = 'center';
      const lbl = `${t.sourceName} · ${t.traceIndex + 1}`;
      ctx.fillText(lbl.length > 22 ? lbl.slice(0, 21) + '…' : lbl, cx, MT + ph + 16);
      ctx.textAlign = 'left';
    }
  } else {
    // Overlay: all traces on ONE shared centre axis with a SHARED normalization
    // (max percentile over the visible window across the collection) so relative
    // amplitudes are comparable and aligned in time.
    const cx = ML + pw / 2;
    ctx.strokeStyle = '#264a68';
    ctx.beginPath(); ctx.moveTo(cx, MT); ctx.lineTo(cx, MT + ph); ctx.stroke();
    let nf = 0;
    for (const t of wbTraces) {
      const lo = Math.max(0, s0), hi = Math.min(t.nSamples, s1);
      if (hi <= lo) continue;
      const f = normFactorPercentile(t.samples.subarray(lo, hi), 0.95);
      if (f > nf) nf = f;
    }
    if (nf <= 0) nf = 1;
    for (const t of wbTraces) wbDrawWiggle(ctx, t, cx, pw / 2, MT, ph, s0, s1, nf, t.color, wbAmp);
  }

  // Legend (source · trace #) top-right, one row per colour.
  ctx.font = '10px Consolas, monospace';
  ctx.textAlign = 'left';
  let ly = MT + 4;
  for (const t of wbTraces) {
    ctx.fillStyle = t.color;
    ctx.fillRect(ML + pw - 150, ly, 9, 9);
    ctx.fillStyle = '#aab8c8';
    const lbl = `${t.sourceName} · ${t.traceIndex + 1}`;
    ctx.fillText(lbl.length > 20 ? lbl.slice(0, 19) + '…' : lbl, ML + pw - 137, ly + 8);
    ly += 13;
    if (ly > MT + ph - 12) break; // don't overflow the plot
  }

  // status label
  const lab = $opt('wbLabel');
  if (lab) lab.textContent = `${wbTraces.length} trace${wbTraces.length === 1 ? '' : 's'} · ${wbMode === 'side' ? 'side-by-side' : 'overlay'} · ${s0}-${s1} samples`;
  syncWbAxisPlaceholders();
}

/** Reflect the workbench's visible time window + the manual/auto amplitude swing
 *  as placeholders in its X/Y range boxes (blank still means auto). */
function syncWbAxisPlaceholders() {
  if (!wbAxisRange || !wbTraces.length) return;
  const si = wbTraces[0].sampleInt || 0;
  const msPerSample = si / 1000;
  const s0 = wbView.init ? wbView.s0 : 0;
  const s1 = wbView.init ? wbView.s1 : wbMaxSamples();
  // Auto amplitude swing: max ±95th-percentile over the visible window across traces.
  let nf = 0;
  for (const t of wbTraces) {
    const lo = Math.max(0, s0), hi = Math.min(t.nSamples, s1);
    if (hi <= lo) continue;
    const f = normFactorPercentile(t.samples.subarray(lo, hi), 0.95);
    if (f > nf) nf = f;
  }
  if (!(nf > 0)) nf = 1;
  wbAxisRange.setPlaceholders(s0 * msPerSample, s1 * msPerSample, wbAmp ? wbAmp.min : -nf, wbAmp ? wbAmp.max : nf);
}

/** Apply the workbench manual X (time, ms) / Y (amplitude) boxes. X writes the
 *  shared wbView sample window (like the inspector); Y pins the wiggle amplitude
 *  to ±wbAmp. Each axis: a valid pair pins it; blank/invalid reverts to auto. */
function applyWbAxisRange() {
  if (!wbAxisRange || !wbTraces.length) return;
  if (!wbView.init || wbView.fullS !== wbMaxSamples()) wbFit();
  const si = wbTraces[0].sampleInt || 0;
  const v = wbAxisRange.value();
  // X = time (ms) → sample index: sample = ms * 1000 / sampleInt_µs.
  if (v.xMin !== null && v.xMax !== null && si > 0) {
    const s0 = (v.xMin * 1000) / si;
    const s1 = (v.xMax * 1000) / si;
    if (Number.isFinite(s0) && Number.isFinite(s1) && s1 > s0) {
      wbView.s0 = s0; wbView.s1 = s1; wbClamp();
    }
    wbManualX = true;
  } else if (wbManualX) {
    // X transitioned from a manual pin back to auto ⇒ fit the whole time extent.
    // A blank X pair with no prior manual pin ⇒ Amp-only edit; leave wbView zoom as-is.
    wbFit();
    wbManualX = false;
  }
  // Y = amplitude (raw units); null ⇒ auto per-trace/shared normalization.
  wbAmp = (v.yMin !== null && v.yMax !== null) ? { min: v.yMin, max: v.yMax } : null;
  drawWorkbench();
}

// -- Trace Workbench · ANALYSIS (cross-correlation + difference + stats) --
// Pick any two collected traces (A, B) and compare them numerically:
//  • normalized cross-correlation curve (r vs lag) with the peak marked,
//  • the difference trace A - B (drawn with the shared wiggle renderer),
//  • RMS amplitudes + B/A gain ratio.
// All compute is client-side (the samples already live in wbTraces) via the pure
// crossCorrelate/difference core ops - no worker round-trip.

let wbSelA = -1; // chosen A trace id (-1 ⇒ none)
let wbSelB = -1; // chosen B trace id (-1 ⇒ none)

/** Find a collected trace by id (null when absent). */
function wbTraceById(id: number): WbTrace | null {
  return wbTraces.find((t) => t.id === id) ?? null;
}

/** (Re)populate the A/B <select>s from the collection, preserving valid picks
 *  and defaulting to the first two distinct traces. */
function wbFillAnalysisSelects() {
  const selA = $opt('wbSelA') as HTMLSelectElement | null;
  const selB = $opt('wbSelB') as HTMLSelectElement | null;
  if (!selA || !selB) return;
  // Default picks: keep prior choices if still present, else first / second trace.
  if (!wbTraceById(wbSelA)) wbSelA = wbTraces[0]?.id ?? -1;
  if (!wbTraceById(wbSelB) || (wbTraces.length > 1 && wbSelB === wbSelA)) {
    wbSelB = wbTraces.find((t) => t.id !== wbSelA)?.id ?? wbTraces[0]?.id ?? -1;
  }
  // Build options via DOM + textContent (like renderWorkbenchList) instead of an
  // innerHTML template: t.sourceName is a raw filename and would otherwise let a
  // name containing <, >, &, or " break/garble the markup or inject DOM.
  const fill = (sel: HTMLSelectElement) => {
    sel.textContent = '';
    for (const t of wbTraces) {
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = `${t.sourceName} #${t.traceIndex + 1}`;
      sel.appendChild(o);
    }
  };
  fill(selA);
  fill(selB);
  if (wbSelA >= 0) selA.value = String(wbSelA);
  if (wbSelB >= 0) selB.value = String(wbSelB);
}

/** Plot a normalized cross-correlation curve (r vs lag ms) with the peak marked. */
function wbDrawCorr(cc: { lags: Float32Array; corr: Float32Array; bestLagMs: number; bestCoef: number }) {
  const cv = $opt('wbCorrCanvas') as HTMLCanvasElement | null;
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800;
  const H = cv.clientHeight || 160;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);

  const ML = 44, MR = 12, MT = 10, MB = 22;
  const pw = W - ML - MR, ph = H - MT - MB;
  ctx.strokeStyle = '#214564';
  ctx.lineWidth = 1;
  ctx.strokeRect(ML, MT, pw, ph);

  const n = cc.corr.length;
  if (n < 2) return;
  const lagMin = cc.lags[0], lagMax = cc.lags[n - 1];
  const lagSpan = lagMax - lagMin || 1;
  const xAt = (lagMs: number) => ML + ((lagMs - lagMin) / lagSpan) * pw;
  // r axis is [-1,1]; y grows downward, 0 in the middle.
  const yAt = (r: number) => MT + (1 - (r + 1) / 2) * ph;

  // grid: zero-lag vertical, r=0 horizontal, ±1 frame already drawn.
  ctx.strokeStyle = '#173049';
  ctx.beginPath(); ctx.moveTo(ML, yAt(0)); ctx.lineTo(ML + pw, yAt(0)); ctx.stroke();
  if (lagMin <= 0 && lagMax >= 0) {
    const xz = xAt(0);
    ctx.strokeStyle = '#264a68';
    ctx.beginPath(); ctx.moveTo(xz, MT); ctx.lineTo(xz, MT + ph); ctx.stroke();
  }

  // axis labels (lag ms across, r down)
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  ctx.textAlign = 'center';
  for (let k = 0; k <= 4; k++) {
    const lag = lagMin + (lagSpan * k) / 4;
    ctx.fillText(lag.toFixed(0), ML + (pw * k) / 4, MT + ph + 14);
  }
  ctx.textAlign = 'right';
  ctx.fillText('+1', ML - 6, yAt(1) + 3);
  ctx.fillText(' 0', ML - 6, yAt(0) + 3);
  ctx.fillText('-1', ML - 6, yAt(-1) + 3);
  ctx.textAlign = 'left';

  // correlation curve
  ctx.strokeStyle = '#34dbd0';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xAt(cc.lags[i]);
    const y = yAt(Math.max(-1, Math.min(1, cc.corr[i])));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // peak marker
  const px = xAt(cc.bestLagMs);
  const py = yAt(Math.max(-1, Math.min(1, cc.bestCoef)));
  ctx.fillStyle = '#ffb454';
  ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ffb454';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(px, MT); ctx.lineTo(px, MT + ph); ctx.stroke();
  ctx.setLineDash([]);
}

/** Draw the difference trace A - B in its own canvas (reuses wbDrawWiggle). */
function wbDrawDiff(diff: Float32Array, sampleInt: number) {
  const cv = $opt('wbDiffCanvas') as HTMLCanvasElement | null;
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800;
  const H = cv.clientHeight || 200;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);

  const ML = 60, MR = 14, MT = 14, MB = 26;
  const pw = W - ML - MR, ph = H - MT - MB;
  ctx.strokeStyle = '#214564';
  ctx.lineWidth = 1;
  ctx.strokeRect(ML, MT, pw, ph);

  const n = diff.length;
  if (n < 1) return;
  const s0 = 0, s1 = n;
  const denom = s1 - s0 > 1 ? s1 - s0 - 1 : 1;

  // time axis (ms down) - same labelling style as the main workbench canvas.
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  const msPerSample = (sampleInt || 0) / 1000;
  drawMsTimeGrid(ctx, ML, MT, pw, ph, s0, denom, msPerSample);

  const cx = ML + pw / 2;
  ctx.strokeStyle = '#264a68';
  ctx.beginPath(); ctx.moveTo(cx, MT); ctx.lineTo(cx, MT + ph); ctx.stroke();

  const nf = normFactorPercentile(diff, 0.95) || 1;
  const dtrace: WbTrace = { id: -1, sourceName: 'A-B', traceIndex: 0, samples: diff, sampleInt, nSamples: n, color: '#ff6e9c' };
  wbDrawWiggle(ctx, dtrace, cx, pw / 2, MT, ph, s0, s1, nf, '#ff6e9c');
}

/** Recompute + redraw the whole ANALYSIS section from the current A/B picks.
 *  Hides itself behind a placeholder when fewer than two traces are collected. */
function wbUpdateAnalysis() {
  const pick = $opt('wbAnalysisPick');
  const body = $opt('wbAnalysisBody');
  const empty = $opt('wbAnalysisEmpty');
  const readout = $opt('wbCorrReadout');
  const stats = $opt('wbStats');

  if (wbTraces.length < 2) {
    if (pick) (pick as HTMLElement).style.display = 'none';
    if (body) (body as HTMLElement).style.display = 'none';
    if (empty) (empty as HTMLElement).style.display = '';
    if (readout) readout.textContent = '-';
    if (stats) stats.textContent = '';
    return;
  }

  wbFillAnalysisSelects();
  if (pick) (pick as HTMLElement).style.display = '';
  if (body) (body as HTMLElement).style.display = '';
  if (empty) (empty as HTMLElement).style.display = 'none';

  const a = wbTraceById(wbSelA);
  const b = wbTraceById(wbSelB);
  if (!a || !b) return;

  // Put B on A's time base before correlating/differencing. crossCorrelate's lag
  // axis is built from A's dt (msPerSample = a.sampleInt/1000) and difference()
  // aligns by sample COUNT, so a B captured at a different dt (e.g. 4 ms vs A's
  // 2 ms) would yield a physically wrong lag and difference. Resampling B by the
  // dt ratio makes one B sample equal one A sample in time for both ops.
  let bSamples = b.samples;
  if (a.sampleInt > 0 && b.sampleInt > 0 && b.sampleInt !== a.sampleInt && b.samples.length > 0) {
    const newLen = Math.max(1, Math.round(b.samples.length * (b.sampleInt / a.sampleInt)));
    bSamples = resampleLinear(b.samples, newLen);
  }

  const cc = crossCorrelate(a.samples, bSamples, a.sampleInt);
  const df = difference(a.samples, bSamples);

  wbDrawCorr(cc);
  wbDrawDiff(df.diff, a.sampleInt);

  if (readout) readout.textContent = `best lag = ${cc.bestLagMs.toFixed(2)} ms · r = ${cc.bestCoef.toFixed(3)}`;
  if (stats) {
    stats.textContent =
      `RMS A=${df.rmsA.toPrecision(4)} · RMS B=${df.rmsB.toPrecision(4)} · ` +
      `RMS(A-B)=${df.rmsDiff.toPrecision(4)} · gain B/A=${df.gainRatio.toFixed(3)}`;
  }
}

// -- Trace Workbench · EXPORT --
// Write the collected traces out as ONE seismic file in the chosen writer format.
// Mirrors the Converter's SAVE flow: the worker assembles a synthetic ParsedFile
// from the samples and runs the writer; main shows the native Save dialog. The
// button is disabled while the collection is empty; a note appears when the
// collected traces carry DIFFERENT sample intervals (the output uses the first).

/** Sync the EXPORT controls to the collection: enable/disable the button and
 *  show the mixed-sample-interval note when traces disagree on dt. */
function wbUpdateExport() {
  const btn = $opt('wbExportBtn') as HTMLButtonElement | null;
  if (btn) btn.disabled = wbTraces.length === 0;
  const note = $opt('wbExportSiNote');
  if (note) {
    const first = wbTraces[0]?.sampleInt;
    const mixed = wbTraces.length > 1 && wbTraces.some((t) => t.sampleInt !== first);
    (note as HTMLElement).style.display = mixed ? '' : 'none';
  }
}

/** Export the collected traces as a single seismic file in the chosen format. */
async function wbExport() {
  if (!wbTraces.length) return;
  const fmt = ($opt('wbExportFmt') as HTMLSelectElement | null)?.value || 'segy1';
  const btn = $opt('wbExportBtn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  setStatus('wbExportStatus', 'Writing…');
  try {
    const r = await api.convertTraces({
      traces: wbTraces.map((t) => ({ samples: t.samples, nSamples: t.nSamples, sampleInt: t.sampleInt })),
      sampleInt: wbTraces[0]?.sampleInt,
      format: fmt,
      baseName: 'workbench',
    });
    if (r.ok) setStatus('wbExportStatus', '✓ Saved ' + r.path, 'ok');
    else if (r.canceled) setStatus('wbExportStatus', '');
    else setStatus('wbExportStatus', 'Export failed: ' + (r.error || 'unknown'), 'err');
  } catch (e) {
    setStatus('wbExportStatus', 'Export failed: ' + errMsg(e), 'err');
  } finally {
    wbUpdateExport(); // re-enable per current collection state
  }
}

/** Attach wheel-zoom / drag-pan / dblclick-fit to the workbench canvas (once). */
function workbenchInteractions() {
  const cv = $opt('wbCanvas') as HTMLCanvasElement | null;
  if (!cv) return;
  const active = () => $('panel-workbench').style.display !== 'none' && !!wbTraces.length;
  let dragging = false, ly = 0;
  cv.addEventListener('wheel', (e) => {
    if (!active()) return;
    e.preventDefault();
    const fy = wbPlotFrac(cv, e);
    wbZoomAt(fy, e.deltaY < 0 ? 1 / 1.15 : 1.15);
    drawWorkbench();
  }, { passive: false });
  cv.addEventListener('mousedown', (e) => {
    if (!active()) return;
    dragging = true; ly = e.clientY; cv.style.cursor = 'grabbing';
  });
  window.addEventListener('mouseup', () => { dragging = false; cv.style.cursor = ''; });
  cv.addEventListener('mousemove', (e) => {
    if (!dragging || !wbView.init || !active()) return;
    const H = cv.clientHeight || 460;
    const MT = 14, MB = 26, ph = H - MT - MB;
    if (ph <= 0) return;
    const ds = ((e.clientY - ly) / ph) * (wbView.s1 - wbView.s0);
    wbView.s0 -= ds; wbView.s1 -= ds;
    wbClamp();
    ly = e.clientY;
    drawWorkbench();
  });
  cv.addEventListener('dblclick', () => {
    if (!active()) return;
    wbAxisRange?.clear(); wbAmp = null; wbFit(); drawWorkbench();
  });
  $opt('wbPickBtn')?.addEventListener('click', () => void wbPickFile());
  $opt('wbPrevBtn')?.addEventListener('click', () => wbStepPreview(-1));
  $opt('wbNextBtn')?.addEventListener('click', () => wbStepPreview(1));
  $opt('wbAddPreviewBtn')?.addEventListener('click', wbAddPreview);
  $opt('wbIndex')?.addEventListener('change', () => {
    if (!wbPickedPath) return;
    const idxIn = $opt('wbIndex') as HTMLInputElement | null;
    void wbLoadPreview(parseInt(idxIn?.value || '0', 10) || 0);
  });
  $opt('wbAddOpenBtn')?.addEventListener('click', wbAddOpenTrace);
  $opt('wbClearBtn')?.addEventListener('click', wbClear);
  $opt('wbModeSide')?.addEventListener('click', () => wbSetMode('side'));
  $opt('wbModeOverlay')?.addEventListener('click', () => wbSetMode('overlay'));
  $opt('wbInvertBtn')?.addEventListener('click', () => {
    wbInvert = !wbInvert;
    $opt('wbInvertBtn')?.classList.toggle('on', wbInvert);
    drawWorkbench();
  });
  $opt('wbZoomIn')?.addEventListener('click', () => wbZoomButton(1 / 1.4));
  $opt('wbZoomOut')?.addEventListener('click', () => wbZoomButton(1.4));
  $opt('wbZoomFit')?.addEventListener('click', () => { wbAxisRange?.clear(); wbAmp = null; wbFit(); drawWorkbench(); });
  // Manual X (time, ms) / Y (amplitude) range boxes - complement the shared zoom.
  const axHost = $opt('wbAxisRange');
  if (axHost) {
    wbAxisRange = axisRangeControls(axHost, {
      xLabel: 'Time ms', yLabel: 'Amp',
      onChange: () => applyWbAxisRange(),
    });
  }
  // ANALYSIS A/B pickers → recompute on change.
  $opt('wbSelA')?.addEventListener('change', (e) => {
    wbSelA = parseInt((e.target as HTMLSelectElement).value, 10);
    wbUpdateAnalysis();
  });
  $opt('wbSelB')?.addEventListener('change', (e) => {
    wbSelB = parseInt((e.target as HTMLSelectElement).value, 10);
    wbUpdateAnalysis();
  });
  // EXPORT: write the collected traces out as one seismic file.
  $opt('wbExportBtn')?.addEventListener('click', () => void wbExport());
  renderWorkbenchList();
  wbUpdateAnalysis();
  wbUpdateExport();
}

// -- SPS 2.1 (survey geometry) --
/** Adopt a survey the worker has just generated (the SPS Creation wizard and the
 *  survey-plan SPS export share this verbatim): take the new summary, re-enable
 *  the SPS actions, drop every renderer-side cache and repaint the SPS panels. */
function adoptCreatedSurvey(summary: SpsSummary) {
  spsSummary = summary;
  const pts = (summary.sources ?? 0) + (summary.receivers ?? 0);
  setSpsExportEnabled(pts > 0);
  setSpsRenumberEnabled(pts > 0);
  setRotateCtlEnabled(true);
  spsGeom = null; spsSpider = null; spsFold = null; spsFoldBin = 0;
  spsBinGrid = null; spsBinGridFetched = false;
  highlightedShot = null; gridView.init = false; gridHighlight = null;
  if (leafletMap && binGridLayer) { leafletMap.removeLayer(binGridLayer); binGridLayer = null; }
  invalidateSpsSourceCache();
  clearInspector();
  $('spsLabel').textContent = spsLabel(spsSummary);
  updateSpsStats();
  renderSummaryPanel();
  updateStatusStrip();
}

function spsLabel(s: SpsSummary): string {
  const proj = s.projection?.desc || s.projection?.type || s.projection?.subtype || 'unknown CRS';
  return `${s.sources} sources · ${s.receivers} receivers · ${s.xrefs} X-refs · ${s.layout || '?'} · ${proj}` + (s.errors.length ? ` · ⚠ ${s.errors.length}` : '');
}

/** Paint the dedicated SPS stats element (counts + line totals). Lives apart
 *  from #spsLabel, which hoverGrid overwrites. Line counts come from geometry. */
function updateSpsStats() {
  updateHeaderClear();   // SPS survey loaded/cleared → refresh header Clear state
  updateGeomqcReadout(); // …and the Geometry QC tab's loaded-survey readout
  updateGlobalLoaded();  // …and the global header "Loaded" readout
  const el = $opt('spsStats');
  if (!el) return;
  if (!spsSummary) { el.textContent = ''; return; }
  const srcLines = spsGeom ? spsGeom.src.names.length : 0;
  const rcvLines = spsGeom ? spsGeom.rcv.names.length : 0;
  // Positioning-format badge: which format(s) the last Load ingested (e.g.
  // "SPS", "P1/11", "SPS · P6/11"). Absent on older summaries ⇒ no badge.
  const fmts = spsSummary.formats && spsSummary.formats.length ? ` · fmt: ${spsSummary.formats.join(' · ')}` : '';
  el.textContent =
    `${spsSummary.sources} sources · ${spsSummary.receivers} receivers · ${spsSummary.xrefs} X-refs · ${srcLines} src lines · ${rcvLines} rcv lines${fmts}`;
}

// -- Station inspector (full point detail, fetched from the worker on click) --
/** Hide + empty the inspector card. */
function clearInspector() {
  const card = $opt('spsInspector');
  if (card) card.style.display = 'none';
  const body = $opt('spsInspBody');
  if (body) body.innerHTML = '';
}

/** Append one key/value row to the inspector body (reuses the .kv styling).
 *  `full` rows span both columns (used for the raw SPS line). */
function kvRow(parent: HTMLElement, k: string, v: string, full = false) {
  const row = document.createElement('div');
  row.className = 'kv' + (full ? ' full' : '');
  const ks = document.createElement('span'); ks.className = 'k'; ks.textContent = k;
  const vs = document.createElement('span'); vs.className = 'v mono'; vs.textContent = v;
  row.appendChild(ks); row.appendChild(vs);
  parent.appendChild(row);
}

/** Render a fetched point's full field set into the inspector card. Guards
 *  NaN / empty / undefined so only meaningful fields show. */
function showInspector(d: SPSPointDetail) {
  const card = $opt('spsInspector');
  const body = $opt('spsInspBody');
  const title = $opt('spsInspTitle');
  if (!card || !body) return;
  body.innerHTML = '';
  const isSrc = d.rtype === 'S';
  if (title) title.textContent = `${isSrc ? 'Source' : 'Receiver'} - Line ${d.lineName || '?'} · pt ${d.point}`;
  const numOk = (v: number | undefined): v is number => v != null && isFinite(v);
  const strOk = (v: string | undefined): v is string => v != null && v.trim() !== '';

  kvRow(body, 'Type', isSrc ? 'Source (S)' : 'Receiver (R)');
  kvRow(body, 'Line', d.lineName || '-');
  kvRow(body, 'Point', String(d.point));
  if (strOk(d.idx)) kvRow(body, 'Index', d.idx);
  if (numOk(d.easting)) kvRow(body, 'Easting', d.easting.toFixed(2));
  if (numOk(d.northing)) kvRow(body, 'Northing', d.northing.toFixed(2));
  if (numOk(d.elevation)) kvRow(body, 'Elevation', d.elevation.toFixed(2) + ' m');
  if (isSrc) {
    if (numOk(d.upholeMs) && d.upholeMs !== 0) kvRow(body, 'Uphole', d.upholeMs.toFixed(1) + ' ms');
    if (strOk(d.srcType)) kvRow(body, 'Source type', d.srcType);
    if (strOk(d.date)) kvRow(body, 'Date', d.date);
    if (strOk(d.time)) kvRow(body, 'Time', d.time);
    if (numOk(d.ffid) && d.ffid !== 0) kvRow(body, 'FFID', String(d.ffid));
  } else if (numOk(d.staticMs) && d.staticMs !== 0) {
    kvRow(body, 'Static', d.staticMs.toFixed(1) + ' ms');
  }
  if (strOk(d.raw)) kvRow(body, 'Raw', d.raw.trimEnd(), true);
  card.style.display = 'block';
}

/** Fetch + show one point's detail by S/R line + point. Best-effort: a missing
 *  match (or no SPS) simply leaves the inspector untouched. */
async function inspectPoint(rtype: 'S' | 'R', lineName: string, point: number) {
  try {
    const d = await api.spsPointDetail({ rtype, lineName, point });
    if (d) showInspector(d);
  } catch { /* ignore - inspector stays as-is */ }
}

/** Center the survey grid on a world point (current geometry space) + highlight
 *  it. Pans the cached transform without changing scale. */
function jumpGridTo(x: number, y: number) {
  if (!spsGeom) return;
  const cv = $('spsCanvas') as HTMLCanvasElement;
  if (!gridView.init) gridFit();
  const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
  // Center the ROTATED projection of the point (so it lands mid-canvas at any
  // bearing); the highlight ring stores the true E/N and re-rotates when drawn.
  const r = rotWorld(x, y);
  gridView.ox = W / 2 - r.e * gridView.sc;
  gridView.oy = H / 2 + r.n * gridView.sc;
  gridHighlight = { x, y };
  drawSurveyGrid();
}

/** Pan + highlight the Leaflet map at lat/lon (when the map view is active). */
function jumpMapTo(lat: number, lon: number) {
  if (!leafletMap || !isFinite(lat) || !isFinite(lon)) return;
  const map = leafletMap;
  map.panTo([lat, lon]);
  if (mapHighlight) { map.removeLayer(mapHighlight); mapHighlight = null; }
  mapHighlight = L.circleMarker([lat, lon], { radius: 11, color: '#ffe04a', weight: 3, fill: false }).addTo(map);
}

/** Locate a point's coords in the CURRENT geometry arrays (already transformed
 *  for the active view) by rtype + line + point. Returns null if not present. */
function geomCoordsFor(rtype: 'S' | 'R', lineName: string, point: number): { x: number; y: number } | null {
  if (!spsGeom) return null;
  const g = rtype === 'S' ? spsGeom.src : spsGeom.rcv;
  const want = (lineName || '').trim();
  for (let i = 0; i < g.x.length; i++) {
    if (g.pt[i] === point && (g.names[g.line[i]] || '').trim() === want) return { x: g.x[i], y: g.y[i] };
  }
  return null;
}

/** Focus a QC / clicked point: center the grid + ring it, mirror onto the map if
 *  active, and open the inspector. `qp` carries the geometry-independent key. */
function focusPoint(qp: QCPoint) {
  const c = geomCoordsFor(qp.rtype, qp.lineName, qp.point);
  if (c) {
    if (spsView === 'grid') jumpGridTo(c.x, c.y);
    else gridHighlight = { x: c.x, y: c.y }; // ring shows when the grid is next drawn
    // In map space the geometry arrays already hold lon/lat (x=lon, y=lat).
    if (spsView === 'map') jumpMapTo(c.y, c.x);
  }
  void inspectPoint(qp.rtype, qp.lineName, qp.point);
}

/** Focus a point from the Geometry QC tab. The findings/offenders live on their
 *  own tab, but the survey grid + Leaflet map that focusPoint rings/inspects live
 *  on the SPS tab - so switch there first, then ring. (Rows are only made
 *  clickable when their qp resolves in the loaded geometry, so spsGeom is set.) */
function focusPointOnSps(qp: QCPoint) {
  switchTab('sps');
  focusPoint(qp);
}

/** Geometry QC tab readout: which shared seismic file + SPS survey are loaded
 *  (both inputs the two cross-checks read). Guarded; updated on tab activation,
 *  after the tab's open/clear buttons, and whenever the file/SPS state changes. */
function updateGeomqcReadout() {
  const el = $opt('geomqcLoaded');
  if (!el) return;
  const file = summary ? summary.name : '-';
  const sps = spsSummary ? `${spsSummary.sources} src · ${spsSummary.receivers} rcv` : '-';
  el.textContent = `Loaded: ${file} · SPS: ${sps}`;
}

/** Global header "Loaded" readout: the shared seismic file + SPS survey that every
 *  data tab operates on. Mirrors updateGeomqcReadout (same shared-state model);
 *  shows "-" for whichever input is absent. Kept in sync from renderInfo() (file)
 *  and updateSpsStats() (SPS) - the two points where that shared state changes. */
function updateGlobalLoaded() {
  const el = $opt('globalLoaded');
  if (!el) return;
  const file = summary ? summary.name : '-';
  const sps = spsSummary ? `${spsSummary.sources} src · ${spsSummary.receivers} rcv` : '-';
  el.textContent = `Loaded: ${file} · SPS: ${sps}`;
}

/** Empty both Geometry QC result panels + refresh the loaded readout. */
function clearGeomqcResults() {
  const g = $opt('geomChkResults'); if (g) g.textContent = '';
  const l = $opt('geomLoadResults'); if (l) l.textContent = '';
  const d = $opt('spsDeltaResults'); if (d) d.textContent = '';
  updateGeomqcReadout();
}

async function loadSPS() {
  $('spsLabel').textContent = 'Loading…';
  showProgress('Loading SPS…'); // determinate per-file (worker ticks)
  try {
    const s = await api.openSPS();
    if (!s) {
      $('spsLabel').textContent = spsSummary ? spsLabel(spsSummary) : 'Load S/R/X files to plot the survey';
      return;
    }
    spsSummary = s;
    // Only enable the point exports (KML/GeoJSON/CSV/P1·11/coord-CSV/QC) when the
    // survey actually has points. A P6/11 bin-grid-only load succeeds but leaves
    // the S/R point list empty, and exporting an empty SPSData over those buttons
    // would produce hollow files - gate on points existing, not on load success.
    setSpsExportEnabled((s.sources ?? 0) + (s.receivers ?? 0) > 0);
    // Renumber rewrites point/line numbers, so it only makes sense with points -
    // gate it exactly like the point exports (a bin-grid-only load leaves it off).
    setSpsRenumberEnabled((s.sources ?? 0) + (s.receivers ?? 0) > 0);
    setRotateCtlEnabled(true); // a survey is loaded → rotation works in both views
    spsGeom = null;
    spsSpider = null;
    spsFold = null;
    spsFoldBin = 0;
    // A different survey has a different station spacing, so let the GeoTIFF
    // wizard seed its resolution again instead of carrying the last one over.
    gtResTouched = false;
    // New survey → re-fetch any P6/11 bin grid lazily (drop the prior overlay).
    if (leafletMap && binGridLayer) { leafletMap.removeLayer(binGridLayer); binGridLayer = null; }
    spsBinGrid = null;
    spsBinGridFetched = false;
    highlightedShot = null;
    gridView.init = false;
    gridHighlight = null;
    invalidateSpsSourceCache();   // Observer Log: re-fetch the source list on next use
    clearInspector();
    $('spsLabel').textContent = spsLabel(s);
    updateSpsStats();
    // CRS is now known - refresh the File-summary + status-strip CRS cells.
    renderSummaryPanel();
    updateStatusStrip();
    await refreshSps();
  } catch (e) {
    $('spsLabel').textContent = 'SPS load failed: ' + errMsg(e);
  } finally {
    hideProgress();
  }
}

/** Clear the loaded survey: drop the worker's SPS state (keeping any open
 *  seismic file), null every renderer cache + summary, clear the inspector / QC
 *  results, disable exports, and repaint the empty grid + label. */
async function clearSPS() {
  try { await api.spsClear(); } catch { /* best-effort - clear the UI regardless */ }
  spsSummary = null;
  spsGeom = null;
  spsSpider = null;
  spsFold = null;
  spsFoldBin = 0;
  highlightedShot = null;
  gridView.init = false;
  gridHighlight = null;
  invalidateSpsSourceCache();   // Observer Log: drop the cached source list
  setSpsExportEnabled(false);
  setSpsRenumberEnabled(false);
  setRotateCtlEnabled(false); // no survey loaded → rotation N/A in either view
  clearInspector();
  $('qcResults').textContent = '';
  $('spsLabel').textContent = 'Load S/R/X files to plot the survey';
  updateSpsStats();
  renderSummaryPanel();
  updateStatusStrip();
  // Clear the Leaflet map layers too - without this the map VIEW kept showing the
  // survey after "Clear SPS" (the bug), since only the grid was repainted. Mirror
  // updateMap's teardown: drop the src/rcv layer groups + any highlight ring.
  if (leafletMap && leafletLayers) {
    leafletMap.removeLayer(leafletLayers.src);
    leafletMap.removeLayer(leafletLayers.rcv);
    leafletLayers = null;
  }
  if (leafletMap && mapHighlight) { leafletMap.removeLayer(mapHighlight); mapHighlight = null; }
  // Tear down the bin-grid overlay (both spaces): drop the Leaflet layer + reset
  // the cached grid so the next load re-fetches cleanly.
  if (leafletMap && binGridLayer) { leafletMap.removeLayer(binGridLayer); binGridLayer = null; }
  spsBinGrid = null;
  spsBinGridFetched = false;
  // Repaint the (now empty) grid view.
  if (spsView === 'grid') drawEmptyGrid();
}

/** Paint the survey-grid canvas as an empty placeholder (no geometry loaded). */
function drawEmptyGrid() {
  const cv = $opt('spsCanvas') as HTMLCanvasElement | null;
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0f2540'); bg.addColorStop(1, '#0b1a2c');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#5e7186';
  ctx.font = '13px Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Load S/R/X files to plot the survey', W / 2, H / 2);
  ctx.textAlign = 'start';
}

/** Fetch geometry for the active view (projected E/N for grid, WGS84 lon/lat for map) and render. */
async function refreshSps() {
  if (!spsSummary) return;
  // Geographic (map) view needs a projected CRS in the SPS header; if a freshly
  // loaded survey lacks one while we're on the map, fall back to the grid.
  if (spsView === 'map' && !spsSummary.projection) {
    spsView = 'grid';
    $('viewGrid').classList.add('on');
    $('viewMap').classList.remove('on');
    ($('spsCanvas') as HTMLElement).style.display = 'block';
    $('spsMap').style.display = 'none';
    setRotateCtlEnabled(true); // grid view also honours the shared bearing now
    $('spsLabel').textContent = 'Real map needs a projected CRS in the SPS header - showing Survey grid.';
  }
  const wantGeo = spsView === 'map';
  if (!spsGeom || spsGeom.geo !== wantGeo) {
    try {
      spsGeom = await api.spsGeometry(wantGeo);
      gridView.init = false;
      // Geometry space (E/N vs lon/lat) changed → any stale highlight is invalid.
      gridHighlight = null;
      spsSpider = null; // spider endpoints are in the old geometry space; refetch on demand
      updateSpsStats(); // line counts come from geometry
    } catch (e) {
      $('spsLabel').textContent = 'SPS geometry failed: ' + errMsg(e);
      return;
    }
  }
  // Keep the spider in sync with the active geometry space when it's enabled.
  if (spsView === 'grid' && spsShowXrefs() && (!spsSpider || spsSpider.geo !== wantGeo)) {
    await ensureSpider();
  }
  // Fold map is grid-view + projected-E/N only (it's a planning heatmap). Fetch
  // it lazily the first time it's toggled on, and whenever the bin size changes.
  if (spsView === 'grid' && !spsGeom.geo && spsShowFold()) {
    await ensureFold();
  }
  // P6/11 bin-grid overlay: fetch the grid lazily the first time it's toggled on
  // (a survey with no bin grid leaves spsBinGrid null and the overlay just absent).
  if (spsShowBinGrid()) {
    await ensureBinGrid();
  }
  if (spsView === 'grid') drawSurveyGrid();
  else updateMap();
}

/** Whether the X-ref spider toggle is on (absent checkbox ⇒ off). */
function spsShowXrefs(): boolean {
  return !!($opt('spsShowXrefs') as HTMLInputElement | null)?.checked;
}

/** Fetch + cache the spider for the active geometry space (no-op if current).
 *  Best-effort: a failure just leaves spsSpider null so the grid draws as before. */
async function ensureSpider(): Promise<void> {
  const wantGeo = spsView === 'map';
  if (spsSpider && spsSpider.geo === wantGeo) return;
  try {
    spsSpider = await api.spsXrefLines(wantGeo);
    if (spsSpider.decimated && spsSpider.log) $('spsLabel').textContent = spsSpider.log;
  } catch (e) {
    spsSpider = null;
    $('spsLabel').textContent = 'X-ref spider failed: ' + errMsg(e);
  }
}

/** Whether the Fold/coverage toggle is on (absent checkbox ⇒ off). */
function spsShowFold(): boolean {
  return !!($opt('spsShowFold') as HTMLInputElement | null)?.checked;
}

/** Current bin size (m) from the toolbar input; clamps to ≥ 1, default 25. */
function spsBinSize(): number {
  const v = parseFloat(($opt('spsBinSize') as HTMLInputElement | null)?.value ?? '');
  return isFinite(v) && v >= 1 ? v : 25;
}

// -- P6/11 bin-grid QC overlay --

/** Whether the "Bin grid" toggle is on (absent checkbox ⇒ off). */
function spsShowBinGrid(): boolean {
  return !!($opt('spsShowBinGrid') as HTMLInputElement | null)?.checked;
}

/** Fetch the loaded P6/11 bin grid ONCE per survey load (no-op after the first
 *  attempt, success or not). A survey with no grid simply leaves spsBinGrid null.
 *  Best-effort: a failure leaves it null and the overlay just doesn't draw. */
async function ensureBinGrid(): Promise<void> {
  if (spsBinGridFetched) return;
  spsBinGridFetched = true;
  try {
    const g = await api.binGrid();
    spsBinGrid = g && isFinite(g.originE) && isFinite(g.originN) && g.nInline > 0 && g.nCrossline > 0 ? g : null;
  } catch {
    spsBinGrid = null; // overlay silently absent
  }
}

/** Whether the loaded bin grid is renderable (finite origin/size/azimuth + ≥1 node each axis). */
function binGridUsable(g: BinGridInfo | null): g is BinGridInfo {
  return !!g && isFinite(g.originE) && isFinite(g.originN) && isFinite(g.binI) && isFinite(g.binJ)
    && isFinite(g.inlineAzimuth) && g.nInline > 0 && g.nCrossline > 0;
}

/** The map-grid bearing (radians) of the crossline (J) axis. Uses the parser's
 *  explicit crosslineAzimuth when present (the file's true J-bearing, which is NOT
 *  always inline+90° - EPSG "I=J-90" handedness / sheared grids); falls back to
 *  inline+90° only when no crossline azimuth was supplied. */
function crosslineRad(g: BinGridInfo): number {
  if (isFinite(g.crosslineAzimuth)) return g.crosslineAzimuth * Math.PI / 180;
  return g.inlineAzimuth * Math.PI / 180 + Math.PI / 2;
}

/** The grid's four outer corners in projected E/N, walking the bin frame from the
 *  origin along the inline (I) axis then the crossline (J) axis. Returns
 *  [origin, +inline, +inline+crossline, +crossline]. The J-axis direction comes from
 *  the parser-resolved crosslineAzimuth (orthogonality is NOT assumed). Extents use
 *  (n - 1) bin intervals to match the parser's computeCorners convention. */
function binGridCorners(g: BinGridInfo): { e: number; n: number }[] {
  // Explicit corners win when the file supplied them.
  if (g.corners && g.corners.length >= 4 && g.corners.every((c) => isFinite(c.e) && isFinite(c.n))) {
    return g.corners.slice(0, 4);
  }
  const az = g.inlineAzimuth * Math.PI / 180; // map-grid bearing of the inline (I) axis, clockwise from grid north
  // Unit vector along inline (azimuth measured clockwise from +N): dE=sin, dN=cos.
  const iE = Math.sin(az), iN = Math.cos(az);
  // Crossline = the file's J-axis bearing (not assumed inline+90°).
  const jaz = crosslineRad(g);
  const jE = Math.sin(jaz), jN = Math.cos(jaz);
  const lenI = g.binI * Math.max(0, g.nInline - 1);
  const lenJ = g.binJ * Math.max(0, g.nCrossline - 1);
  const o = { e: g.originE, n: g.originN };
  const a = { e: o.e + iE * lenI, n: o.n + iN * lenI };
  const c = { e: a.e + jE * lenJ, n: a.n + jN * lenJ };
  const d = { e: o.e + jE * lenJ, n: o.n + jN * lenJ };
  return [o, a, c, d];
}

/** Inline / crossline guide-line endpoint pairs in projected E/N (faint QC guides).
 *  A handful of evenly spaced lines spanning the grid in each direction. */
function binGridGuides(g: BinGridInfo): { e: number; n: number }[][] {
  const az = g.inlineAzimuth * Math.PI / 180;
  const iE = Math.sin(az), iN = Math.cos(az);
  const jaz = crosslineRad(g);
  const jE = Math.sin(jaz), jN = Math.cos(jaz);
  const lenI = g.binI * Math.max(0, g.nInline - 1);
  const lenJ = g.binJ * Math.max(0, g.nCrossline - 1);
  const out: { e: number; n: number }[][] = [];
  const N = 6; // interior guide lines per axis (excluding the outline edges)
  // Lines parallel to the inline axis, stepped along crossline.
  for (let k = 1; k < N; k++) {
    const t = (k / N) * lenJ;
    const s = { e: g.originE + jE * t, n: g.originN + jN * t };
    out.push([s, { e: s.e + iE * lenI, n: s.n + iN * lenI }]);
  }
  // Lines parallel to the crossline axis, stepped along inline.
  for (let k = 1; k < N; k++) {
    const t = (k / N) * lenI;
    const s = { e: g.originE + iE * t, n: g.originN + iN * t };
    out.push([s, { e: s.e + jE * lenJ, n: s.n + jN * lenJ }]);
  }
  return out;
}

/** Draw the bin-grid frame onto the offline survey-grid canvas using the SAME
 *  X()/Yf() transforms as the points, so it tracks pan/zoom. Projected-E/N grid
 *  view only (the canvas is in projected space when geo=false). */
function drawBinGridOverlay(ctx: CanvasRenderingContext2D, X: (e: number, n: number) => number, Yf: (e: number, n: number) => number) {
  const g = spsBinGrid;
  if (!binGridUsable(g)) return;
  const corners = binGridCorners(g);
  ctx.save();
  // Faint interior inline/crossline guides under the outline.
  ctx.strokeStyle = 'rgba(168,85,247,0.18)'; ctx.lineWidth = 1;
  for (const [a, b] of binGridGuides(g)) {
    ctx.beginPath(); ctx.moveTo(X(a.e, a.n), Yf(a.e, a.n)); ctx.lineTo(X(b.e, b.n), Yf(b.e, b.n)); ctx.stroke();
  }
  // Outline (closed rotated rectangle).
  ctx.strokeStyle = '#a855f7'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(X(corners[0].e, corners[0].n), Yf(corners[0].e, corners[0].n));
  for (let i = 1; i < corners.length; i++) ctx.lineTo(X(corners[i].e, corners[i].n), Yf(corners[i].e, corners[i].n));
  ctx.closePath(); ctx.stroke();
  // Origin marker + inline-axis tick (shows the rotation direction).
  const ox = X(g.originE, g.originN), oy = Yf(g.originE, g.originN);
  ctx.fillStyle = '#a855f7'; ctx.shadowColor = '#a855f7'; ctx.shadowBlur = 7;
  ctx.beginPath(); ctx.arc(ox, oy, 4, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  // Inline-axis arrow from the origin toward corner[1].
  ctx.strokeStyle = '#c084fc'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(X(corners[1].e, corners[1].n), Yf(corners[1].e, corners[1].n)); ctx.stroke();
  // Label.
  ctx.fillStyle = '#c084fc'; ctx.font = '10px Consolas, monospace';
  const az = ((g.inlineAzimuth % 360) + 360) % 360;
  ctx.fillText(`bin grid ${g.nInline}×${g.nCrossline} · ${az.toFixed(1)}°`, ox + 6, oy - 6);
  ctx.restore();
}

/** Project a bin-grid E/N corner list to WGS84 lat/lon for Leaflet, using the
 *  loaded survey's CRS (same projection the worker used for the geographic view).
 *  Returns null if no usable projection is available. */
function binGridLatLon(pts: { e: number; n: number }[]): [number, number][] | null {
  const proj = (spsSummary?.projection as unknown as Projection) || (spsBinGrid?.crs as unknown as Projection);
  if (!proj) return null;
  const out: [number, number][] = [];
  for (const p of pts) {
    const ll = projToLatLon(p.e, p.n, proj);
    if (!ll || !isFinite(ll.lat) || !isFinite(ll.lon)) return null;
    out.push([ll.lat, ll.lon]);
  }
  return out;
}

/** Build (or rebuild) the Leaflet bin-grid layer: a rotated outline polygon, the
 *  origin marker, the inline-axis line, and faint interior guides. Adds it to the
 *  map. Removes any prior layer first. No-op if there's no usable grid/projection. */
function updateBinGridMap() {
  if (!leafletMap) return;
  if (binGridLayer) { leafletMap.removeLayer(binGridLayer); binGridLayer = null; }
  if (!spsShowBinGrid() || !binGridUsable(spsBinGrid)) return;
  const g = spsBinGrid;
  const outline = binGridLatLon(binGridCorners(g));
  if (!outline) return; // need a projection to place the grid geographically
  const grp = L.layerGroup();
  // Faint guides.
  for (const seg of binGridGuides(g)) {
    const ll = binGridLatLon(seg);
    if (ll) L.polyline(ll, { color: '#a855f7', weight: 1, opacity: 0.25 }).addTo(grp);
  }
  // Outline polygon.
  L.polygon(outline, { color: '#a855f7', weight: 2, fill: false, opacity: 0.95 })
    .bindPopup(`P6/11 bin grid<br>${g.nInline} × ${g.nCrossline} nodes<br>azimuth ${(((g.inlineAzimuth % 360) + 360) % 360).toFixed(2)}°<br>bin ${g.binI} × ${g.binJ}`)
    .addTo(grp);
  // Inline-axis line from origin.
  const axis = binGridLatLon([binGridCorners(g)[0], binGridCorners(g)[1]]);
  if (axis) L.polyline(axis, { color: '#c084fc', weight: 1.5, opacity: 0.9 }).addTo(grp);
  // Origin marker.
  const o = binGridLatLon([{ e: g.originE, n: g.originN }]);
  if (o) L.circleMarker(o[0], { radius: 5, color: '#a855f7', weight: 2, fillColor: '#a855f7', fillOpacity: 0.9 })
    .bindPopup(`Bin-grid origin<br>E ${g.originE.toFixed(2)} · N ${g.originN.toFixed(2)}`).addTo(grp);
  grp.addTo(leafletMap);
  binGridLayer = grp;
}

/** Fetch + cache the fold map for the current bin size (no-op if already current).
 *  Best-effort: a failure (e.g. bin too small) leaves spsFold null and surfaces
 *  the reason in the status label, so the grid still draws without the heatmap. */
async function ensureFold(): Promise<void> {
  const bin = spsBinSize();
  if (spsFold && spsFoldBin === bin) return;
  try {
    spsFold = await api.spsFold({ binX: bin, binY: bin });
    spsFoldBin = bin;
    if (spsFold.log) $('spsLabel').textContent = spsFold.log;
  } catch (e) {
    spsFold = null;
    spsFoldBin = 0;
    $('spsLabel').textContent = 'Fold map failed: ' + errMsg(e);
  }
}

function setView(v: 'grid' | 'map') {
  if (spsView === v) return;
  if (v === 'map' && (!spsSummary || !spsSummary.projection)) {
    $('spsLabel').textContent = 'Real map needs a projected CRS in the SPS header - staying on Survey grid.';
    return;
  }
  spsView = v;
  hideGridHoverTip(); // the grid tooltip must never linger after a view switch
  $('viewGrid').classList.toggle('on', v === 'grid');
  $('viewMap').classList.toggle('on', v === 'map');
  ($('spsCanvas') as HTMLElement).style.display = v === 'grid' ? 'block' : 'none';
  $('spsMap').style.display = v === 'map' ? 'block' : 'none';
  setRotateCtlEnabled(!!spsSummary); // both views honour the shared bearing
  if (spsSummary) void refreshSps();
}

// -- Survey-grid canvas (projected E/N, always offline) --
function gridFit() {
  if (!spsGeom) return;
  const cv = $('spsCanvas') as HTMLCanvasElement;
  const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
  const { minX, maxX, minY, maxY } = spsGeom.bbox;
  if (!isFinite(minX)) { gridView.sc = 1; gridView.ox = W / 2; gridView.oy = H / 2; gridView.init = true; return; }
  // Fit the ROTATED extent, not the axis-aligned bbox: drawSurveyGrid turns the
  // geometry about the bbox centre, so an elongated survey near 45-90° has a
  // rotated footprint wider/taller than (maxX-minX)/(maxY-minY). Rotate the four
  // bbox corners through the same rotWorld() and fit that span, so a rotated
  // survey never overflows the canvas. (At bearing 0 this reduces to the bbox.)
  let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity;
  for (const [cx, cy] of [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]] as const) {
    const r = rotWorld(cx, cy);
    if (r.e < rMinX) rMinX = r.e; if (r.e > rMaxX) rMaxX = r.e;
    if (r.n < rMinY) rMinY = r.n; if (r.n > rMaxY) rMaxY = r.n;
  }
  const dx = Math.max(1e-9, rMaxX - rMinX), dy = Math.max(1e-9, rMaxY - rMinY);
  const sc = Math.min((W - 80) / dx, (H - 56) / dy) * 0.96;
  gridView.sc = sc;
  gridView.ox = W / 2 - (sc * (rMinX + rMaxX)) / 2;
  gridView.oy = H / 2 + (sc * (rMinY + rMaxY)) / 2;
  gridView.init = true;
}

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  if (!isFinite(raw) || raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function drawSurveyGrid() {
  if (!spsGeom) return;
  const cv = $('spsCanvas') as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0f2540'); bg.addColorStop(1, '#0b1a2c');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  if (!gridView.init) gridFit();
  const { sc, ox, oy } = gridView;
  const geo = spsGeom.geo;
  // World→pixel projection. When the survey grid is rotated (shared bearing), the
  // plotted geometry is turned about the bbox centre in world space first, then
  // projected - so points, lines, the spider, the fold heatmap and the bin-grid
  // overlay all rotate coherently through this one projector. Hit-testing
  // (pickGridPoint) forward-projects candidate stations through the same rotWorld()
  // and compares in pixel space, so no inverse is needed. Bearing 0 is the identity
  // fast path.
  const rotated = spsBearing !== 0;
  const X = (e: number) => ox + e * sc;
  const Yf = (n: number) => oy - n * sc;
  const Xr = rotated ? (e: number, n: number) => { const r = rotWorld(e, n); return ox + r.e * sc; } : (e: number, _n: number) => ox + e * sc;
  const Yr = rotated ? (e: number, n: number) => { const r = rotWorld(e, n); return oy - r.n * sc; } : (_e: number, n: number) => oy - n * sc;
  const showS = ($('spsShowS') as HTMLInputElement).checked;
  const showR = ($('spsShowR') as HTMLInputElement).checked;

  // visible world extent → "nice" gridlines + axis labels.
  const e0 = (0 - ox) / sc, e1 = (W - ox) / sc;
  const nTop = (oy - 0) / sc, nBot = (oy - H) / sc;
  const pr = geo ? 4 : 0;
  ctx.lineWidth = 1; ctx.font = '10px Consolas, monospace';
  if (!rotated) {
    // Rectilinear E/N gridlines + tick labels only make sense north-up. While the
    // grid is rotated we drop them (the rotated frame + north arrow carry orientation)
    // and the points stay the priority - see the rotated-frame block below.
    const sx = niceStep(e1 - e0, 8);
    for (let e = Math.ceil(e0 / sx) * sx; e <= e1; e += sx) {
      const x = X(e); if (x < 42 || x > W - 2) continue;
      ctx.strokeStyle = 'rgba(33,69,100,0.45)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - 16); ctx.stroke();
      ctx.fillStyle = '#5e7186'; ctx.fillText(e.toFixed(pr), x + 2, H - 5);
    }
    const sy = niceStep(nTop - nBot, 6);
    for (let n = Math.ceil(nBot / sy) * sy; n <= nTop; n += sy) {
      const y = Yf(n); if (y < 2 || y > H - 16) continue;
      ctx.strokeStyle = 'rgba(33,69,100,0.45)';
      ctx.beginPath(); ctx.moveTo(42, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillStyle = '#5e7186'; ctx.fillText(n.toFixed(pr), 3, y - 2);
    }
  }

  // FOLD / coverage heatmap, drawn UNDER everything else (grid view + projected
  // E/N only - skip on the map view or in geographic space). Each non-empty bin
  // is a viridis-tinted rect at alpha 0.6; viewport-culled to the visible cells.
  // Uses X()/Yf() so it tracks pan/zoom exactly like the points.
  let foldDrawn = false;
  if (spsShowFold() && !geo && spsFold && spsFold.maxFold > 0) {
    const f = spsFold;
    ctx.save();
    ctx.globalAlpha = 0.6;
    // Visible world rectangle → bin index range (cull cells outside it). The cull
    // box is the axis-aligned viewport, which is only valid north-up; while rotated
    // we draw the full grid (no cull) so rotated-edge cells aren't wrongly dropped.
    const ix0 = rotated ? 0 : Math.max(0, Math.floor((e0 - f.originX) / f.binX));
    const ix1 = rotated ? f.nx - 1 : Math.min(f.nx - 1, Math.ceil((e1 - f.originX) / f.binX));
    const iy0 = rotated ? 0 : Math.max(0, Math.floor((nBot - f.originY) / f.binY));
    const iy1 = rotated ? f.ny - 1 : Math.min(f.ny - 1, Math.ceil((nTop - f.originY) / f.binY));
    const inv = 1 / f.maxFold;
    for (let iy = iy0; iy <= iy1; iy++) {
      const rowBase = iy * f.nx;
      const nLo = f.originY + iy * f.binY, nHi = f.originY + (iy + 1) * f.binY;
      // Axis-aligned canvas rect when north-up; a rotated quad (4 corners through
      // the rotating projector) once the grid is turned, so cells track the points.
      const yTop = Yf(nHi), yBot = Yf(nLo), rh = yBot - yTop;
      for (let ix = ix0; ix <= ix1; ix++) {
        const v = f.fold[rowBase + ix];
        if (v <= 0) continue;
        // Map fold/maxFold (0..1) onto viridis, whose input is -1..1.
        const [r, g2, b] = colorViridis(v * inv * 2 - 1);
        ctx.fillStyle = `rgb(${r},${g2},${b})`;
        const eLo = f.originX + ix * f.binX, eHi = f.originX + (ix + 1) * f.binX;
        if (!rotated) {
          ctx.fillRect(X(eLo), yTop, X(eHi) - X(eLo), rh);
        } else {
          ctx.beginPath();
          ctx.moveTo(Xr(eLo, nLo), Yr(eLo, nLo));
          ctx.lineTo(Xr(eHi, nLo), Yr(eHi, nLo));
          ctx.lineTo(Xr(eHi, nHi), Yr(eHi, nHi));
          ctx.lineTo(Xr(eLo, nHi), Yr(eLo, nHi));
          ctx.closePath(); ctx.fill();
        }
      }
    }
    ctx.restore();
    foldDrawn = true;
  }

  // X-ref "spider": shot→receiver segments, drawn UNDER the points. Thin + low
  // opacity for the full set; if a shot is highlighted, dim the rest and over-
  // draw that shot's fan bright. Off-screen segments are cheaply skipped.
  if (spsShowXrefs() && spsSpider && spsSpider.geo === geo) {
    const sp = spsSpider;
    const hiGid = highlightedShot != null ? sp.shotKeys.indexOf(highlightedShot) : -1;
    const inView = (x: number, y: number) => x >= -50 && x <= W + 50 && y >= -50 && y <= H + 50;
    const drawSegs = (only: number, col: string, lw: number) => {
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
      for (let i = 0; i < sp.sx.length; i++) {
        if (only >= 0 ? sp.shot[i] !== only : (hiGid >= 0 && sp.shot[i] === hiGid)) continue;
        const ax = Xr(sp.sx[i], sp.sy[i]), ay = Yr(sp.sx[i], sp.sy[i]);
        const bx = Xr(sp.rx[i], sp.ry[i]), by = Yr(sp.rx[i], sp.ry[i]);
        if (!inView(ax, ay) && !inView(bx, by)) continue;
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      }
      ctx.stroke();
    };
    // Base layer: all segments (dimmer when a shot is singled out).
    drawSegs(-1, hiGid >= 0 ? 'rgba(45,212,191,0.05)' : 'rgba(45,212,191,0.12)', 0.5);
    // Emphasized shot on top.
    if (hiGid >= 0) drawSegs(hiGid, 'rgba(45,212,191,0.85)', 1.2);
  }

  // survey lines (polyline per contiguous same-line run) + glowing points
  const drawSet = (g: SpsLines, lineCol: string, ptCol: string) => {
    ctx.strokeStyle = lineCol; ctx.lineWidth = 1.1;
    let cur = -1; ctx.beginPath();
    for (let i = 0; i < g.x.length; i++) {
      const e = g.x[i], n = g.y[i];
      if (!isFinite(e) || !isFinite(n)) { cur = -1; continue; }
      const x = Xr(e, n), y = Yr(e, n);
      if (g.line[i] !== cur) { ctx.moveTo(x, y); cur = g.line[i]; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = ptCol; ctx.shadowColor = ptCol; ctx.shadowBlur = 6;
    for (let i = 0; i < g.x.length; i++) {
      const e = g.x[i], n = g.y[i];
      if (!isFinite(e) || !isFinite(n)) continue;
      ctx.beginPath(); ctx.arc(Xr(e, n), Yr(e, n), 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
  };
  if (showR) drawSet(spsGeom.rcv, 'rgba(58,160,224,0.45)', '#3aa0e0');
  if (showS) drawSet(spsGeom.src, 'rgba(255,140,0,0.5)', '#ff8c00');

  // P6/11 bin-grid QC overlay (origin · rotation · outline · guides), drawn OVER
  // the S/R points using the same X()/Yf() so it tracks pan/zoom. Projected-E/N
  // grid space only - the grid corners are in projected coordinates.
  if (spsShowBinGrid() && !geo) drawBinGridOverlay(ctx, Xr, Yr);

  // Highlight ring for a clicked / jumped-to point (drawn in the current geometry
  // space, so it tracks pan/zoom). A double ring stands out over either layer.
  if (gridHighlight && isFinite(gridHighlight.x) && isFinite(gridHighlight.y)) {
    const hx = Xr(gridHighlight.x, gridHighlight.y), hy = Yr(gridHighlight.x, gridHighlight.y);
    ctx.strokeStyle = '#ffe04a'; ctx.lineWidth = 2; ctx.shadowColor = '#ffe04a'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(hx, hy, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.stroke();
  }

  // legend
  ctx.font = '11px "Segoe UI", sans-serif';
  let lx = 52; const ly = 20;
  const legend = (col: string, txt: string) => {
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c8d2e0'; ctx.fillText(txt, lx + 9, ly + 4); lx += ctx.measureText(txt).width + 34;
  };
  if (showS) legend('#ff8c00', `${spsSummary?.sources ?? 0} sources`);
  if (showR) legend('#3aa0e0', `${spsSummary?.receivers ?? 0} receivers`);

  // Fold colorbar (vertical viridis gradient, 0..maxFold) in the bottom-left.
  if (foldDrawn && spsFold) drawFoldColorbar(ctx, H, spsFold.maxFold);
  // Fold is on but can't render here (geographic space) - a small hint.
  else if (spsShowFold() && geo) {
    ctx.font = '11px "Segoe UI", sans-serif'; ctx.fillStyle = '#9fb0c4';
    ctx.fillText('Fold/coverage: Survey-grid view only', 52, ly + 20);
  }

  // North arrow - turns with the shared bearing so it always points to map-north
  // on the rotated canvas (clockwise bearing ⇒ arrow swings clockwise). Drawn in a
  // local frame about a fixed top-right anchor; the "N" glyph rides the arrow tip.
  {
    const ax = W - 22, ay = 32; // anchor (arrow base)
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate((spsBearing * Math.PI) / 180); // clockwise on screen
    ctx.strokeStyle = '#9fb0c4'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 9); ctx.lineTo(0, -9);   // shaft (up = north)
    ctx.moveTo(0, -9); ctx.lineTo(-3, -4);  // arrowhead
    ctx.moveTo(0, -9); ctx.lineTo(3, -4);
    ctx.stroke();
    ctx.fillStyle = '#9fb0c4'; ctx.font = 'bold 12px Consolas, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', 0, -16);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  drawScaleBar(ctx, W, H, sc, geo, (nTop + nBot) / 2);
}

function drawScaleBar(ctx: CanvasRenderingContext2D, W: number, H: number, scPxPerUnit: number, geo: boolean, midLat: number) {
  const mPerUnit = geo ? 111320 * Math.cos((midLat * Math.PI) / 180) : 1;
  const pxPerM = scPxPerUnit / mPerUnit;
  if (!isFinite(pxPerM) || pxPerM <= 0) return;
  const meters = niceStep(120 / pxPerM, 1);
  const barPx = meters * pxPerM;
  if (!isFinite(barPx) || barPx < 12 || barPx > W - 60) return;
  const x0 = W - 22 - barPx, y0 = H - 22, cx = x0 + barPx / 2;
  const label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  ctx.font = '10px Consolas, monospace';
  // Subtle semi-transparent pill behind the bar + label so it stays legible over
  // the fold heatmap / points. The survey grid keeps a fixed dark scientific
  // background in both themes (see applyTheme), so a dark translucent fill +
  // light-grey strokes match the palette without any theme branching.
  const pillW = Math.max(barPx, ctx.measureText(label).width) + 14;
  const pillL = cx - pillW / 2, pillR = cx + pillW / 2, pillT = y0 - 19, pillB = y0 + 7, rad = 4;
  ctx.fillStyle = 'rgba(11,26,44,0.6)';
  ctx.beginPath();
  ctx.moveTo(pillL + rad, pillT);
  ctx.lineTo(pillR - rad, pillT); ctx.quadraticCurveTo(pillR, pillT, pillR, pillT + rad);
  ctx.lineTo(pillR, pillB - rad); ctx.quadraticCurveTo(pillR, pillB, pillR - rad, pillB);
  ctx.lineTo(pillL + rad, pillB); ctx.quadraticCurveTo(pillL, pillB, pillL, pillB - rad);
  ctx.lineTo(pillL, pillT + rad); ctx.quadraticCurveTo(pillL, pillT, pillL + rad, pillT);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#c8d2e0'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x0 + barPx, y0);
  ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0 + 4);
  ctx.moveTo(x0 + barPx, y0 - 4); ctx.lineTo(x0 + barPx, y0 + 4);
  ctx.stroke();
  ctx.fillStyle = '#c8d2e0'; ctx.textAlign = 'center';
  ctx.fillText(label, cx, y0 - 6);
  ctx.textAlign = 'left';
}

/** Vertical viridis gradient legend (top = maxFold, bottom = 0) for the fold map,
 *  drawn in the lower-left corner. Colors match the heatmap (fold/maxFold → viridis). */
function drawFoldColorbar(ctx: CanvasRenderingContext2D, H: number, maxFold: number) {
  const bw = 12, bh = 120;
  const x0 = 52, y0 = H - 28 - bh;
  // Top (maxFold) → bottom (0); sample viridis the same way the heatmap does.
  for (let p = 0; p < bh; p++) {
    const t = 1 - p / (bh - 1); // 1 at top, 0 at bottom
    const [r, g, b] = colorViridis(t * 2 - 1);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x0, y0 + p, bw, 1);
  }
  ctx.strokeStyle = 'rgba(200,210,224,0.5)'; ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, bw, bh);
  ctx.fillStyle = '#c8d2e0'; ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'left';
  ctx.fillText(String(maxFold), x0 + bw + 4, y0 + 8);
  ctx.fillText('0', x0 + bw + 4, y0 + bh);
  ctx.fillStyle = '#9fb0c4'; ctx.fillText('fold', x0, y0 - 4);
}

/** Attach wheel-zoom / drag-pan / hover to the grid canvas (once, at init). */
function gridInteractions() {
  const cv = $('spsCanvas') as HTMLCanvasElement;
  let dragging = false, lx = 0, ly = 0;
  // Track drag distance so a pan (press-move-release) doesn't open the inspector;
  // only a near-stationary press counts as a station click.
  let downX = 0, downY = 0, moved = 0;
  cv.addEventListener('wheel', (e) => {
    if (spsView !== 'grid' || !spsGeom) return;
    e.preventDefault();
    if (!gridView.init) gridFit();
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const ex = (px - gridView.ox) / gridView.sc, ny = (gridView.oy - py) / gridView.sc;
    gridView.sc *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
    gridView.ox = px - ex * gridView.sc;
    gridView.oy = py + ny * gridView.sc;
    drawSurveyGrid();
  }, { passive: false });
  cv.addEventListener('mousedown', (e) => { if (spsView !== 'grid') return; dragging = true; lx = e.clientX; ly = e.clientY; downX = e.clientX; downY = e.clientY; moved = 0; });
  window.addEventListener('mouseup', () => { dragging = false; });
  cv.addEventListener('mousemove', (e) => {
    if (spsView !== 'grid' || !spsGeom) return;
    if (dragging) {
      moved += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly);
      gridView.ox += e.clientX - lx; gridView.oy += e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      drawSurveyGrid();
    } else {
      hoverGrid(e);
    }
  });
  // A click (press + release without a real drag) opens the station inspector.
  cv.addEventListener('click', (e) => {
    if (moved > 4 || Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) return;
    clickGrid(e);
  });
  cv.addEventListener('mouseleave', () => hideGridHoverTip());
  cv.addEventListener('dblclick', () => { if (spsView === 'grid' && spsGeom) { gridFit(); drawSurveyGrid(); } });
  // Keep the active SPS view correct after a window resize (the cached grid
  // transform would otherwise go stale; Leaflet needs invalidateSize).
  window.addEventListener('resize', () => {
    // SPS grid/map.
    if (spsView === 'grid' && spsGeom) { gridFit(); drawSurveyGrid(); }
    else if (spsView === 'map' && leafletMap) leafletMap.invalidateSize();
    // The section / trace / workbench / velocity canvases size to client*
    // dimensions only inside their draw fns, which aren't otherwise re-run on
    // resize - so repaint whichever is visible or they stay stretched/blurred.
    if (lastSection && $opt('panel-section')?.style.display !== 'none') redrawSection();
    if (lastTrace && $opt('panel-trace')?.style.display !== 'none') renderTrace();
    if ($opt('panel-workbench')?.style.display !== 'none') { drawWorkbench(); wbUpdateAnalysis(); }
    if (velResult && $opt('panel-vel')?.style.display !== 'none') drawVelocity();
    // Spectrum tab: repaint whichever display is active (cached payloads, no re-fetch).
    if ($opt('panel-spectrum')?.style.display !== 'none') repaintSpectrum();
  });
}

/** Nearest survey point to a canvas pixel (squared-distance over the visible
 *  S/R layers, 144 px² threshold). Returns the group + index, or null. Shared
 *  by hover (label) and click (inspector). */
function pickGridPoint(e: MouseEvent): { g: SpsLines; i: number } | null {
  if (!spsGeom || !gridView.init) return null;
  const cv = $('spsCanvas') as HTMLCanvasElement;
  const r = cv.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const { sc, ox, oy } = gridView;
  let best = 144, bi = -1, bg: SpsLines | null = null;
  // Same rotating projection the draw path uses, so picking is correct at any
  // bearing (rotate world E/N about the pivot, then project to pixels).
  const scan = (g: SpsLines, on: boolean) => {
    if (!on) return;
    for (let i = 0; i < g.x.length; i++) {
      const r = rotWorld(g.x[i], g.y[i]);
      const x = ox + r.e * sc, y = oy - r.n * sc;
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < best) { best = d; bi = i; bg = g; }
    }
  };
  scan(spsGeom.src, ($('spsShowS') as HTMLInputElement).checked);
  scan(spsGeom.rcv, ($('spsShowR') as HTMLInputElement).checked);
  return bg && bi >= 0 ? { g: bg, i: bi } : null;
}

function hoverGrid(e: MouseEvent) {
  if (!spsGeom || !gridView.init) return;
  const hit = pickGridPoint(e);
  if (hit) {
    const { g, i } = hit;
    const pr = spsGeom.geo ? 5 : 1;
    const rtype: 'S' | 'R' = g === spsGeom.src ? 'S' : 'R';
    $('spsLabel').textContent = `${rtype} · Line ${g.names[g.line[i]]} · pt ${g.pt[i]} · ${g.x[i].toFixed(pr)}, ${g.y[i].toFixed(pr)}`;
    // Small cursor-following tooltip: "R  line 1012  point 145".
    showGridHoverTip(e, rtype, g.names[g.line[i]], g.pt[i]);
  } else {
    hideGridHoverTip();
    if (spsSummary) $('spsLabel').textContent = spsLabel(spsSummary);
  }
}

/** Position + fill the cursor-following station read-out over the survey grid. */
function showGridHoverTip(e: MouseEvent, rtype: 'S' | 'R', line: string, point: number) {
  const tip = $opt('spsHoverTip');
  if (!tip) return;
  const lineTxt = String(line).trim() || '-';
  // Build via DOM (not innerHTML) so an SPS line name can never inject markup.
  const badge = document.createElement('span');
  badge.className = `stype s${rtype}`;
  badge.textContent = rtype;
  tip.textContent = '';
  tip.appendChild(badge);
  tip.appendChild(document.createTextNode(`  line ${lineTxt}   point ${grp(point)}`));
  tip.style.display = 'block';
  // Offset a little from the cursor; flip left near the right edge so it stays on-screen.
  const ox = 14, oy = 16;
  const w = tip.offsetWidth || 120;
  let x = e.clientX + ox;
  if (x + w > window.innerWidth - 6) x = e.clientX - ox - w;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${e.clientY + oy}px`;
}

function hideGridHoverTip() {
  const tip = $opt('spsHoverTip');
  if (tip) tip.style.display = 'none';
}

/** Open the inspector for a clicked grid point (rtype inferred from which layer
 *  the pick came from) + ring it. No-op when the click missed every station. */
function clickGrid(e: MouseEvent) {
  if (spsView !== 'grid' || !spsGeom) return;
  const hit = pickGridPoint(e);
  if (!hit) {
    // Empty space → drop any shot emphasis (and ring) and redraw.
    if (highlightedShot != null) { highlightedShot = null; drawSurveyGrid(); }
    return;
  }
  const { g, i } = hit;
  const rtype: 'S' | 'R' = g === spsGeom.src ? 'S' : 'R';
  gridHighlight = { x: g.x[i], y: g.y[i] };
  // Clicking a SOURCE emphasizes its spider fan; clicking a receiver clears it.
  // The key matches the worker's shotKeys ('trimmed(srcLine)|point').
  highlightedShot = rtype === 'S' ? `${(g.names[g.line[i]] || '').trim()}|${g.pt[i]}` : null;
  drawSurveyGrid();
  void inspectPoint(rtype, g.names[g.line[i]], g.pt[i]);
}

// -- Real basemap (Leaflet, geographic) --
function ensureMap() {
  if (leafletMap) return;
  // maxZoom 24 with per-source maxNativeZoom lets the basemap keep zooming PAST the
  // tile providers' native levels (upscaled) for sub-meter survey detail.
  const dark = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 24, maxNativeZoom: 16, attribution: 'Esri Dark Gray Canvas — Esri, HERE, Garmin, © OpenStreetMap contributors' });
  // Light counterpart of the Esri dark canvas; same URL pattern + zoom caps so it
  // upscales past native levels identically. Esri's canvas tiles are keyless (the
  // CARTO ones now demand an API key and serve a watermark), and they stop at
  // native z16 - past that Leaflet upscales rather than request a 'no data' tile.
  const light = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 24, maxNativeZoom: 16, attribution: 'Esri Light Gray Canvas — Esri, HERE, Garmin, © OpenStreetMap contributors' });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 24, maxNativeZoom: 21, attribution: 'Esri World Imagery' });
  const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 24, maxNativeZoom: 19, attribution: '© OpenStreetMap' });
  // rotate:true enables the leaflet-rotate panes/bearing API; we drive bearing
  // from our own toolbar slider, so suppress the plugin's built-in control.
  // Satellite is the DEFAULT: survey work happens around z18-20 (2-30 m station
  // spacing), and it is the only layer with native tiles that deep (21). The grey
  // canvases stop at 16 and would open upscaled and soft at working zoom.
  leafletMap = L.map('spsMap', { layers: [sat], preferCanvas: true, maxZoom: 24, zoomSnap: 0.5, rotate: true, rotateControl: false });
  L.control.layers({ Satellite: sat, Streets: streets, 'Light (regional)': light, 'Dark (regional)': dark }).addTo(leafletMap);
  // Metric distance scale (bottom-left, clear of the layers control + attribution).
  // Added once at creation (ensureMap is guarded), so it never stacks on re-entry.
  L.control.scale({ metric: true, imperial: false, maxWidth: 140, position: 'bottomleft' }).addTo(leafletMap);
  leafletMap.setView([32, 35], 6);
  // Re-apply any bearing already chosen in the toolbar before the map existed.
  applyMapBearing();
}

// Current map bearing in degrees (clockwise). Mirrors the toolbar slider; kept
// in renderer state so it survives map teardown/rebuild and view switches.
let spsBearing = 0;

/** Clamp/normalise a bearing input to [0,360); NaN/empty ⇒ 0 (North). */
function normBearing(v: number): number {
  if (!isFinite(v)) return 0;
  let d = v % 360;
  if (d < 0) d += 360;
  return d;
}

/** Push the current spsBearing into the live map (no-op if the map isn't up). */
function applyMapBearing() {
  if (!leafletMap) return;
  // setBearing exists once leaflet-rotate has augmented L.Map; guard defensively.
  if (typeof leafletMap.setBearing === 'function') leafletMap.setBearing(spsBearing);
}

/** Enable/disable + dim the rotation control. Both the survey-grid canvas and the
 *  real map now honour the bearing, so the control is enabled whenever a survey is
 *  loaded (either view). It's only disabled before any geometry exists. */
function setRotateCtlEnabled(on: boolean) {
  const grp = $opt('spsRotateCtl');
  if (grp) grp.style.opacity = on ? '1' : '0.45';
  for (const id of ['spsRotate', 'spsRotateNum', 'spsRotateReset']) {
    const el = $opt(id) as (HTMLInputElement | HTMLButtonElement) | null;
    if (el) el.disabled = !on;
  }
}

/** Sync the rotation slider + numeric readout to spsBearing (called on changes
 *  and at init). Optional elems so init can't throw if markup is absent. */
function syncBearingUI() {
  const sl = $opt('spsRotate') as HTMLInputElement | null;
  const num = $opt('spsRotateNum') as HTMLInputElement | null;
  const lbl = $opt('spsRotateVal');
  const rounded = Math.round(spsBearing);
  if (sl && document.activeElement !== sl) sl.value = String(rounded);
  if (num && document.activeElement !== num) num.value = String(rounded);
  if (lbl) lbl.textContent = `${rounded}°`;
}

/** Set the shared bearing from a user input, guarding NaN/out-of-range, then sync
 *  the live map + toolbar UI AND repaint the survey-grid canvas (both views share
 *  this one bearing). The single entry point for all rotation changes. */
function setMapBearing(v: number) {
  spsBearing = normBearing(v);
  applyMapBearing();
  syncBearingUI();
  // The offline grid honours the same bearing; refit + repaint it when it's the
  // live view so the rotation-aware auto-fit keeps a rotated survey inside the
  // canvas (gridFit() fits the rotated extent), then switching views stays coherent.
  if (spsView === 'grid' && spsGeom) { gridFit(); drawSurveyGrid(); }
}

// -- Survey-grid rotation (shares spsBearing with the real map) --
// We rotate the plotted geometry about the survey-grid centre in WORLD (E/N) space
// BEFORE the pixel projection, so points, lines, the X-ref spider, the fold
// heatmap and the bin-grid overlay all rotate coherently through the same X()/Yf().
// A clockwise bearing turns map-north clockwise on screen, matching the real map.

/** Survey-grid rotation pivot: the bbox centre in world E/N. NaN-safe (falls back
 *  to the origin so a degenerate bbox can never push NaN into the projection). */
function gridPivot(): { cx: number; cy: number } {
  const b = spsGeom?.bbox;
  if (!b || !isFinite(b.minX) || !isFinite(b.maxX) || !isFinite(b.minY) || !isFinite(b.maxY)) {
    return { cx: 0, cy: 0 };
  }
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2 };
}

/** Rotate a world (e,n) point clockwise (screen sense) about the grid pivot by the
 *  current bearing. Returns the original point when the bearing is 0 (fast path).
 *  In world space, a clockwise on-screen turn (canvas Y-down) is a CCW maths turn. */
function rotWorld(e: number, n: number): { e: number; n: number } {
  if (spsBearing === 0) return { e, n };
  const { cx, cy } = gridPivot();
  const t = (spsBearing * Math.PI) / 180; // clockwise-on-screen bearing
  const c = Math.cos(t), s = Math.sin(t);
  const dx = e - cx, dy = n - cy;
  // Screen-clockwise about a Y-up world axis ⇒ rotate world by -t in maths terms.
  return { e: cx + dx * c + dy * s, n: cy - dx * s + dy * c };
}


function updateMap() {
  if (!spsGeom || !spsGeom.geo) return;
  ensureMap();
  const map = leafletMap!;
  map.invalidateSize();
  if (leafletLayers) { map.removeLayer(leafletLayers.src); map.removeLayer(leafletLayers.rcv); leafletLayers = null; }
  if (mapHighlight) { map.removeLayer(mapHighlight); mapHighlight = null; }
  const showS = ($('spsShowS') as HTMLInputElement).checked;
  const showR = ($('spsShowR') as HTMLInputElement).checked;
  // Lines always draw in full; station markers are decimated so a 50k-point
  // survey can't flood the map renderer (each marker is a canvas circle + popup).
  const MAX_MARKERS = 6000;
  const build = (g: SpsLines, col: string, rtype: 'S' | 'R') => {
    const grp = L.layerGroup();
    const stride = Math.max(1, Math.ceil(g.x.length / MAX_MARKERS));
    let cur = -1; let coords: [number, number][] = [];
    const flush = () => { if (coords.length > 1) L.polyline(coords, { color: col, weight: 1, opacity: 0.5 }).addTo(grp); coords = []; };
    for (let i = 0; i < g.x.length; i++) {
      const lon = g.x[i], lat = g.y[i];
      if (!isFinite(lon) || !isFinite(lat)) { flush(); cur = -1; continue; }
      if (g.line[i] !== cur) { flush(); cur = g.line[i]; }
      coords.push([lat, lon]);
      if (i % stride === 0) {
        const lineName = g.names[g.line[i]], point = g.pt[i];
        L.circleMarker([lat, lon], { radius: 2.5, color: col, weight: 1, fillColor: col, fillOpacity: 0.9 })
          .bindPopup(`Line ${lineName} · pt ${point}<br>${lat.toFixed(5)}, ${lon.toFixed(5)}`)
          // Hover read-out (type · line · point) - mirrors the survey-grid tooltip.
          .bindTooltip(`${rtype} · line ${lineName} · point ${point}`, { direction: 'top', offset: [0, -4], className: 'sps-map-tip' })
          // Clicking a station marker opens the full-detail inspector + rings it.
          .on('click', () => { jumpMapTo(lat, lon); void inspectPoint(rtype, lineName, point); })
          .addTo(grp);
      }
    }
    flush();
    return grp;
  };
  const src = build(spsGeom.src, '#ff8c00', 'S');
  const rcv = build(spsGeom.rcv, '#3aa0e0', 'R');
  if (showR) rcv.addTo(map);
  if (showS) src.addTo(map);
  leafletLayers = { src, rcv };
  // P6/11 bin-grid QC overlay (rotated outline + origin + axis + guides) on top.
  updateBinGridMap();
  const { minX, maxX, minY, maxY } = spsGeom.bbox;
  if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) {
    map.fitBounds([[minY, minX], [maxY, maxX]], { padding: [24, 24], maxZoom: 16 });
  }
}

function numVal(id: string): number {
  const v = parseFloat(($(id) as HTMLInputElement).value);
  return isFinite(v) ? v : 0;
}

async function runQC() {
  if (!spsSummary) {
    $('qcResults').textContent = 'Load SPS files first.';
    return;
  }
  $('qcResults').textContent = 'Running QC…';
  try {
    const rows = await api.spsQC({ srcInt: numVal('qcSrcInt'), rcvInt: numVal('qcRcvInt'), tol: numVal('qcTol') || 1, maxOff: numVal('qcMaxOff') });
    renderQC(rows);
  } catch (e) {
    $('qcResults').textContent = 'QC failed: ' + errMsg(e);
  }
}

function renderQC(rows: QCRow[]) {
  const el = $('qcResults');
  el.innerHTML = '';
  let errs = 0, warns = 0;
  for (const r of rows) {
    if (r.sev === 'error') errs++;
    else if (r.sev === 'warn') warns++;
  }
  const hdr = document.createElement('div');
  hdr.className = 'qc-hdr';
  hdr.textContent = `${errs} errors · ${warns} warnings · ${rows.length} rows`;
  el.appendChild(hdr);
  for (const r of rows.slice(0, 1000)) {
    const row = document.createElement('div');
    row.className = 'qc-row ' + r.sev;
    const sev = document.createElement('span');
    sev.className = 'qc-sev';
    sev.textContent = r.sev.toUpperCase();
    const cat = document.createElement('span');
    cat.className = 'qc-cat';
    cat.textContent = r.cat;
    const msg = document.createElement('span');
    msg.className = 'qc-msg';
    msg.textContent = r.msg;
    row.appendChild(sev);
    row.appendChild(cat);
    row.appendChild(msg);
    // Findings that carry offending coords (7 of 10 types) become clickable -
    // jump the survey grid / map to the FIRST offending point and ring it.
    const first = r.pts && r.pts.length ? r.pts[0] : null;
    if (first) {
      row.classList.add('clickable');
      row.title = 'Click to locate on the survey';
      row.addEventListener('click', () => focusPoint(first));
    }
    el.appendChild(row);
  }
}

// ++++++++++++++++++ Geometry Integrity Suite (SEG-Y ↔ SPS) ++++++++++++++++++
// Cross-check the OPEN seismic file's trace-header geometry against the LOADED
// SPS survey via the worker (window.seisconvAPI.spsGeomCheck). The IPC resolves,
// never rejects: on a not-ready state it returns ok:false with the human error
// ('load a SEG-Y / seismic file first' / 'load an SPS first'), surfaced inline.

// Which station type a finding's `point` refers to, so a sample row can resolve
// to the right geometry array. Source-position busts carry a source point; a
// missing/unmatched receiver carries a receiver point. ReceiverPos samples only
// carry ffid/channel (no point) so they never resolve here - kept honest.
function geomFindingRtype(cat: string): 'S' | 'R' | null {
  if (cat === 'SourcePos' || cat === 'SourceSwap' || cat === 'SourceNumbering') return 'S';
  if (cat === 'MissingStation' || cat === 'ReceiverPos') return 'R';
  return null;
}

// Resolve an SPS station by point number alone (the geometry-check samples carry
// no line name) into a QCPoint, so a click can reuse focusPoint() - the exact
// mechanism the QC rows use to pan + ring the offending station. First match in
// the active geometry wins; returns null when no geometry is loaded or the point
// isn't present (caller then leaves the row as plain, non-clickable text).
function geomPointByNumber(rtype: 'S' | 'R', point: number): QCPoint | null {
  if (!spsGeom || !isFinite(point)) return null;
  const g = rtype === 'S' ? spsGeom.src : spsGeom.rcv;
  for (let i = 0; i < g.pt.length; i++) {
    if (g.pt[i] === point) {
      const lineName = (g.names[g.line[i]] || '').trim();
      return { rtype, lineName, point, easting: g.x[i], northing: g.y[i] };
    }
  }
  return null;
}

async function runGeomCheck() {
  const el = $('geomChkResults');
  const tolRaw = numVal('geomChkTol');
  const tolM = isFinite(tolRaw) && tolRaw > 0 ? tolRaw : 2; // default 2 m (mirrors core)
  el.textContent = 'Running geometry check…';
  showProgress('Checking geometry…');
  try {
    const r = await api.spsGeomCheck({ tolM });
    if (!r.ok || !r.result) {
      renderGeomNotice(r.error || 'Geometry check unavailable');
      return;
    }
    renderGeomCheck(r.result);
  } catch (e) {
    renderGeomNotice('Geometry check failed: ' + errMsg(e));
  } finally {
    hideProgress();
  }
}

// Inline (in-app) not-ready / failure notice - sandboxed renderer, never alert().
function renderGeomNotice(msg: string) {
  const el = $('geomChkResults');
  el.innerHTML = '';
  const notice = document.createElement('div');
  notice.className = 'geom-notice';
  notice.textContent = msg;
  el.appendChild(notice);
}

function renderGeomCheck(result: GeomCheckResult) {
  const el = $('geomChkResults');
  el.innerHTML = '';

  // Summary line - counts shown plainly; matched is DISTINCT stations / survey total.
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);
  const srcTotal = spsSummary ? spsSummary.sources : 0;
  const rcvTotal = spsSummary ? spsSummary.receivers : 0;
  const scalarStr = result.scalarValues.filter((v) => Number.isFinite(v)).join(', ') || '-';
  const summary = document.createElement('div');
  summary.className = 'geom-summary';
  summary.textContent =
    `${fin(result.traceCount)} traces · src coverage ${fin(result.srcCoveragePct)}% · ` +
    `rcv coverage ${fin(result.rcvCoveragePct)}% · scalar [${scalarStr}] · ` +
    `matched ${fin(result.matchedSrcPts)}/${srcTotal} sources, ${fin(result.matchedRcv)}/${rcvTotal} receivers`;
  el.appendChild(summary);

  const findings = Array.isArray(result.findings) ? result.findings : [];
  let errs = 0, warns = 0;
  for (const f of findings) {
    if (f.sev === 'error') errs++;
    else if (f.sev === 'warn') warns++;
  }
  const hdr = document.createElement('div');
  hdr.className = 'qc-hdr';
  hdr.textContent =
    `${errs} error${errs === 1 ? '' : 's'} · ${warns} warning${warns === 1 ? '' : 's'} · ` +
    `${findings.length} finding${findings.length === 1 ? '' : 's'}`;
  el.appendChild(hdr);

  // Zero findings → clear, green "matches" row (reuses the QC .ok severity colour).
  if (findings.length === 0) {
    const row = document.createElement('div');
    row.className = 'qc-row ok';
    const sev = document.createElement('span');
    sev.className = 'qc-sev';
    sev.textContent = '✓';
    const msg = document.createElement('span');
    msg.className = 'qc-msg';
    msg.style.gridColumn = '2 / 4';
    msg.textContent = 'geometry matches the SPS (0 issues)';
    row.appendChild(sev);
    row.appendChild(msg);
    el.appendChild(row);
    return;
  }

  for (const f of findings.slice(0, 1000)) {
    const row = document.createElement('div');
    row.className = 'qc-row ' + (f.sev === 'error' || f.sev === 'warn' ? f.sev : 'info');
    const sev = document.createElement('span');
    sev.className = 'qc-sev';
    sev.textContent = f.sev.toUpperCase();
    const cat = document.createElement('span');
    cat.className = 'qc-cat';
    cat.textContent = f.cat;
    const msg = document.createElement('span');
    msg.className = 'qc-msg';
    msg.textContent = f.msg;
    if (Number.isFinite(f.count) && f.count > 0) {
      const c = document.createElement('span');
      c.className = 'geom-count';
      c.textContent = ` · ${f.count}`;
      msg.appendChild(c);
    }
    row.appendChild(sev);
    row.appendChild(cat);
    row.appendChild(msg);
    el.appendChild(row);

    // "Show offenders" expander - list the sample rows (ffid/channel/point/dist
    // where present). Rows whose point resolves in the loaded geometry become
    // clickable and pan/ring that station (reusing focusPoint); ffid/channel-only
    // rows (no resolvable location) stay plain text.
    const sample = Array.isArray(f.sample) ? f.sample : [];
    if (sample.length) {
      const rtype = geomFindingRtype(f.cat);
      const det = document.createElement('details');
      det.className = 'geom-offenders';
      const sum = document.createElement('summary');
      sum.textContent = `show offenders (${sample.length})`;
      det.appendChild(sum);
      for (const s of sample) {
        const o = document.createElement('div');
        o.className = 'geom-off-row';
        o.textContent = geomSampleText(s);
        const qp = rtype && s.point != null ? geomPointByNumber(rtype, s.point) : null;
        if (qp) {
          o.classList.add('clickable');
          o.title = 'Click to locate on the SPS survey';
          o.addEventListener('click', () => focusPointOnSps(qp));
        }
        det.appendChild(o);
      }
      el.appendChild(det);
    }
  }
}

// Compact, honest one-line label for an offender sample (only the fields it carries).
function geomSampleText(s: GeomSample): string {
  const parts: string[] = [];
  if (s.ffid != null && Number.isFinite(s.ffid)) parts.push(`FFID ${s.ffid}`);
  if (s.channel != null && Number.isFinite(s.channel)) parts.push(`ch ${s.channel}`);
  if (s.point != null && Number.isFinite(s.point)) parts.push(`pt ${s.point}`);
  if (s.dx != null && Number.isFinite(s.dx) && s.dy != null && Number.isFinite(s.dy)) parts.push(`Δ ${s.dx}, ${s.dy} m`);
  if (s.dist != null && Number.isFinite(s.dist)) parts.push(`dist ${s.dist} m`);
  return parts.length ? parts.join(' · ') : 'offender';
}

// ++++++++++++++ Load geometry into SEG-Y (WRITE counterpart of the check) ++++++++++++++
// Stamp the loaded SPS survey's source/receiver coordinates (+ elevation, offset,
// CDP, scalars) into the open SEG-Y's trace headers and save a geometry-loaded
// SEG-Y. The IPC makes MAIN open a native Save dialog. It resolves, never rejects:
// ok:false + error on the not-ready cases ('load a SEG-Y file first' / 'load an
// SPS first'), canceled:true when the Save dialog is dismissed (summary still set).
async function runGeomLoad() {
  const el = $('geomLoadResults');
  const tolRaw = numVal('geomLoadTol');
  const tolM = isFinite(tolRaw) && tolRaw > 0 ? tolRaw : 2; // default 2 m (mirrors core)
  const scalarRaw = parseFloat(($('geomLoadScalar') as HTMLSelectElement).value);
  const coordScalar = isFinite(scalarRaw) ? scalarRaw : -100;
  const checked = (id: string) => !!($opt(id) as HTMLInputElement | null)?.checked;
  const writeCoords = checked('geomLoadCoords');
  const writeElev = checked('geomLoadElev');
  const writeOffset = checked('geomLoadOffset');
  const writeCdp = checked('geomLoadCdp');
  if (!writeCoords && !writeElev && !writeOffset && !writeCdp) {
    renderGeomLoadNotice('Select at least one field group to write.');
    return;
  }
  el.textContent = 'Loading geometry…';
  showProgress('Loading geometry into SEG-Y…');
  try {
    const r = await api.spsGeomLoad({ tolM, coordScalar, writeCoords, writeElev, writeOffset, writeCdp });
    if (!r.ok) {
      renderGeomLoadNotice(r.error || 'Geometry load unavailable');
      return;
    }
    renderGeomLoad(r.summary, r.savedPath, r.canceled);
    if (r.savedPath) audit('export', `geometry loaded → ${r.savedPath}`, 'geomqc');
  } catch (e) {
    renderGeomLoadNotice('Geometry load failed: ' + errMsg(e));
  } finally {
    hideProgress();
  }
}

// Inline (in-app) not-ready / failure notice - sandboxed renderer, never alert().
function renderGeomLoadNotice(msg: string) {
  const el = $('geomLoadResults');
  el.innerHTML = '';
  const notice = document.createElement('div');
  notice.className = 'geom-notice';
  notice.textContent = msg;
  el.appendChild(notice);
}

function renderGeomLoad(summary: GeomLoadSummary | undefined, savedPath?: string, canceled?: boolean) {
  const el = $('geomLoadResults');
  el.innerHTML = '';
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);

  // Save status first (✓ saved, or "matched but not saved" on cancel) - same
  // green/neutral convention the other Geometry QC cards use.
  const status = document.createElement('div');
  status.className = 'qc-hdr';
  if (savedPath) status.textContent = '✓ Saved ' + savedPath;
  else if (canceled) status.textContent = 'Geometry loaded - save dismissed (no file written)';
  else status.textContent = 'Geometry loaded';
  el.appendChild(status);

  if (!summary) return;

  // Metrics line - matched is BOTH source+receiver; src/rcv are per-side; stations
  // are the distinct SPS points stamped. Mirrors the check card's .geom-summary.
  const m = document.createElement('div');
  m.className = 'geom-summary';
  m.textContent =
    `${fin(summary.traceCount)} traces · matched ${fin(summary.matched)} · ` +
    `unmatched ${fin(summary.unmatched)} · src ${fin(summary.srcMatched)} (${fin(summary.srcStations)} stations) · ` +
    `rcv ${fin(summary.rcvMatched)} (${fin(summary.rcvStations)} stations) · scalar ${fin(summary.coordScalar)}`;
  el.appendChild(m);

  const fields = Array.isArray(summary.fieldsWritten) ? summary.fieldsWritten : [];
  const fl = document.createElement('div');
  fl.className = 'geom-summary';
  fl.textContent = fields.length ? `Fields written: ${fields.join(', ')}` : 'Fields written: none (no traces matched the SPS)';
  el.appendChild(fl);

  // A clean green ✓ row when everything matched, else an amber note on the gap -
  // reuses the QC .ok / .warn row styling.
  const row = document.createElement('div');
  if (fin(summary.unmatched) === 0 && fin(summary.matched) > 0) {
    row.className = 'qc-row ok';
    const sev = document.createElement('span'); sev.className = 'qc-sev'; sev.textContent = '✓';
    const msg = document.createElement('span'); msg.className = 'qc-msg'; msg.style.gridColumn = '2 / 4';
    msg.textContent = `all ${fin(summary.matched)} traces stamped with SPS geometry`;
    row.appendChild(sev); row.appendChild(msg);
  } else {
    row.className = 'qc-row warn';
    const sev = document.createElement('span'); sev.className = 'qc-sev'; sev.textContent = 'INFO';
    const msg = document.createElement('span'); msg.className = 'qc-msg'; msg.style.gridColumn = '2 / 4';
    msg.textContent = `${fin(summary.unmatched)} trace(s) had no SPS station within tolerance and were left unchanged`;
    row.appendChild(sev); row.appendChild(msg);
  }
  el.appendChild(row);

  // Surface any core warnings (e.g. an empty SPS / no traces) honestly.
  for (const errTxt of (Array.isArray(summary.errors) ? summary.errors : []).slice(0, 20)) {
    const e = document.createElement('div');
    e.className = 'geom-notice';
    e.textContent = errTxt;
    el.appendChild(e);
  }
}

// ++++++++++++++ As-laid vs pre-plot delta (loaded SPS ↔ reference) ++++++++++++++
// Diff the LOADED (as-laid) survey against a separately picked REFERENCE
// (pre-plot) SPS triplet via window.seisconvAPI.spsDelta. The call makes MAIN
// open a native multi-select dialog for the reference .s/.r/.x. The IPC
// resolves, never rejects: ok:false + error on the not-ready case ('load the
// survey (SPS) first'), canceled:true when the dialog is dismissed.

// Resolve an offender StationDelta (rtype + line + point) into a QCPoint in the
// LOADED geometry so a row click can reuse focusPoint() - the same ring/inspect
// mechanism the QC + geometry-check rows use. Prefer an exact line+point match;
// fall back to point-only (point-keyed runs / numbering-mismatch). Returns null
// when no geometry is loaded or the point isn't present - caller leaves the row
// plain, non-clickable text.
function deltaStationToQP(d: StationDelta): QCPoint | null {
  if (!spsGeom || !Number.isFinite(d.point)) return null;
  const g = d.rtype === 'S' ? spsGeom.src : spsGeom.rcv;
  const want = (d.lineName || '').trim();
  let fallback = -1;
  for (let i = 0; i < g.pt.length; i++) {
    if (g.pt[i] !== d.point) continue;
    const ln = (g.names[g.line[i]] || '').trim();
    if (want && ln === want) return { rtype: d.rtype, lineName: ln, point: d.point, easting: g.x[i], northing: g.y[i] };
    if (fallback < 0) fallback = i;
  }
  if (fallback >= 0) {
    const ln = (g.names[g.line[fallback]] || '').trim();
    return { rtype: d.rtype, lineName: ln, point: d.point, easting: g.x[fallback], northing: g.y[fallback] };
  }
  return null;
}

async function runSpsDelta() {
  const el = $('spsDeltaResults');
  const tolRaw = numVal('deltaTol');
  const tolM = Number.isFinite(tolRaw) && tolRaw > 0 ? tolRaw : 1; // default 1 m (mirrors core)
  el.textContent = 'Pick the reference (pre-plot) SPS triplet…';
  try {
    const r = await api.spsDelta({ tolM });
    if (r.canceled) {
      el.innerHTML = '';
      const n = document.createElement('div');
      n.className = 'geom-summary';
      n.textContent = 'Comparison cancelled.';
      el.appendChild(n);
      return;
    }
    if (!r.ok || !r.result) {
      renderDeltaNotice(r.error || 'Comparison unavailable');
      return;
    }
    renderSpsDelta(r.result, r.refName || 'reference');
  } catch (e) {
    renderDeltaNotice('Comparison failed: ' + errMsg(e));
  }
}

// Inline (in-app) not-ready / failure notice - sandboxed renderer, never alert().
function renderDeltaNotice(msg: string) {
  const el = $('spsDeltaResults');
  el.innerHTML = '';
  const notice = document.createElement('div');
  notice.className = 'geom-notice';
  notice.textContent = msg;
  el.appendChild(notice);
}

// 2-dp metre value, NaN-guarded so no NaN ever reaches the panel.
function fmtDeltaM(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : '-';
}
// Non-negative integer count, NaN-guarded.
function fmtDeltaN(v: number): string {
  return Number.isFinite(v) ? String(Math.max(0, Math.round(v))) : '0';
}

// Render one category (Sources / Receivers) summary block: matched · over-tol ·
// max/mean/p95 skid · added · missing. The over-tol count goes red when >0;
// a clean category shows a green "✓ within tolerance".
function renderDeltaCategory(parent: HTMLElement, title: string, c: DeltaCategory) {
  const block = document.createElement('div');
  block.className = 'delta-cat';
  const head = document.createElement('div');
  head.className = 'delta-cat-head';
  head.textContent = title;
  block.appendChild(head);

  const m = document.createElement('div');
  m.className = 'delta-metrics';
  const overTol = Number.isFinite(c.overTol) ? c.overTol : 0;
  m.appendChild(document.createTextNode(`matched ${fmtDeltaN(c.matched)} · `));
  if (overTol > 0) {
    const ov = document.createElement('span');
    ov.className = 'over';
    ov.textContent = `over-tol ${fmtDeltaN(overTol)}`;
    m.appendChild(ov);
  } else {
    const ok = document.createElement('span');
    ok.className = 'delta-ok';
    ok.textContent = '✓ within tolerance';
    m.appendChild(ok);
  }
  m.appendChild(document.createTextNode(
    ` · max ${fmtDeltaM(c.maxDist)} · mean ${fmtDeltaM(c.meanDist)} · ` +
    `p95 ${fmtDeltaM(c.p95Dist)} m · added ${fmtDeltaN(c.addedInAsLaid)} · ` +
    `missing ${fmtDeltaN(c.missingFromAsLaid)}`));
  block.appendChild(m);
  parent.appendChild(block);
}

function renderSpsDelta(result: SPSDeltaResult, refName: string) {
  const el = $('spsDeltaResults');
  el.innerHTML = '';

  // Header - as-laid vs <ref> · tol N m · match by <line+point|point>.
  const tolM = Number.isFinite(result.tolM) && result.tolM > 0 ? result.tolM : 1;
  const matchKey = result.matchKey === 'point' ? 'point' : 'line+point';
  const hdr = document.createElement('div');
  hdr.className = 'delta-head';
  hdr.textContent = `as-laid vs ${refName} · tol ${fmtDeltaM(tolM)} m · match by ${matchKey}`;
  el.appendChild(hdr);

  // Optional note (degenerate / numbering-mismatch fallback) - amber notice.
  if (result.note && String(result.note).trim()) {
    const note = document.createElement('div');
    note.className = 'geom-notice';
    note.textContent = String(result.note);
    el.appendChild(note);
  }

  const src = result.sources;
  const rcv = result.receivers;
  if (src) renderDeltaCategory(el, 'Sources', src);
  if (rcv) renderDeltaCategory(el, 'Receivers', rcv);

  // Offenders table - union of both categories, worst-first, capped at 200.
  const offenders: StationDelta[] = [];
  if (src && Array.isArray(src.offenders)) for (const o of src.offenders) offenders.push(o);
  if (rcv && Array.isArray(rcv.offenders)) for (const o of rcv.offenders) offenders.push(o);
  offenders.sort((a, b) => {
    const da = Number.isFinite(a.dist) ? a.dist : -1;
    const db = Number.isFinite(b.dist) ? b.dist : -1;
    return db - da;
  });
  const shown = offenders.slice(0, 200);

  if (shown.length) {
    const cap = document.createElement('div');
    cap.className = 'delta-tbl-cap';
    cap.textContent = offenders.length > shown.length
      ? `worst ${shown.length} offenders (of ${offenders.length})`
      : `${shown.length} offender${shown.length === 1 ? '' : 's'}`;
    el.appendChild(cap);

    const tbl = document.createElement('table');
    tbl.className = 'delta-tbl';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const h of ['', 'line', 'point', 'dE (m)', 'dN (m)', 'dist (m)']) {
      const th = document.createElement('th');
      th.textContent = h;
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    tbl.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const d of shown) {
      const tr = document.createElement('tr');
      if (d.overTol) tr.classList.add('over');
      const cells: { text: string; cls?: string }[] = [
        { text: d.rtype === 'S' ? 'S' : 'R' },
        { text: (d.lineName || '').trim() || '-' },
        { text: Number.isFinite(d.point) ? String(d.point) : '-', cls: 'num' },
        { text: fmtDeltaM(d.dE), cls: 'num' },
        { text: fmtDeltaM(d.dN), cls: 'num' },
        { text: fmtDeltaM(d.dist), cls: 'num dist' },
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        if (c.cls) td.className = c.cls;
        td.textContent = c.text;
        tr.appendChild(td);
      }
      // Resolvable rows jump/ring the station in the loaded survey (focusPoint);
      // rows whose point isn't present stay plain, non-clickable text.
      const qp = deltaStationToQP(d);
      if (qp) {
        tr.classList.add('clickable');
        tr.title = 'Click to locate on the SPS survey';
        tr.addEventListener('click', () => focusPointOnSps(qp));
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    el.appendChild(tbl);
  }
}

async function exportReprojected() {
  if (!spsSummary) {
    $('spsExportStatus').textContent = 'Load SPS files first.';
    return;
  }
  const code = crsPickerCode('epsgSearch');
  if (!code) {
    $('spsExportStatus').textContent = 'Search for and pick a target CRS first.';
    return;
  }
  $('spsExportStatus').textContent = 'Reprojecting…';
  try {
    const r = await api.spsReproject(code);
    if (r.ok) { $('spsExportStatus').textContent = '✓ Saved ' + r.path; audit('export', `SPS reprojected (EPSG:${code}) → ${r.path}`, 'sps'); }
    else if (r.canceled) $('spsExportStatus').textContent = '';
    else $('spsExportStatus').textContent = 'Failed: ' + (r.error || 'unknown');
  } catch (e) {
    $('spsExportStatus').textContent = 'Failed: ' + errMsg(e);
  }
}

// Read the current QC inputs (same fields runQC sends) so the QC-report export
// uses exactly what the user has dialed in.
function currentQCParams(): QCParamsUI {
  return { srcInt: numVal('qcSrcInt'), rcvInt: numVal('qcRcvInt'), tol: numVal('qcTol') || 1, maxOff: numVal('qcMaxOff') };
}

// -- EPSG registry picker -----------------------------------------------------
//
// A search box over the FULL offline EPSG registry (~7 000 CRSs), which lives in
// the main process. Results arrive over IPC, debounced. A CRS the coordinate
// engine cannot compute is still SHOWN, dimmed, with the reason - hiding it would
// leave the user hunting for something that is deliberately unavailable.

interface CrsPickerRow {
  code: string;
  name: string;
  method: string;
  units: string;
  deprecated: boolean;
  supported: boolean;
  reason?: string;
}

interface CrsPicker {
  /** Currently selected EPSG code, or '' for none/native. */
  code: string;
}

const crsPickers: Record<string, CrsPicker> = {};

/**
 * Wire one search-box + results-list + summary trio into an EPSG picker.
 * `emptyLabel` is what an empty selection means for this control (the shapefile
 * picker treats it as "native"; the reprojection picker requires a choice).
 */
function initCrsPicker(inputId: string, resultsId: string, pickedId: string, emptyLabel: string): void {
  const input = $opt(inputId) as HTMLInputElement | null;
  const results = $opt(resultsId);
  const picked = $opt(pickedId);
  if (!input || !results || !picked) return;

  const state: CrsPicker = { code: '' };
  crsPickers[inputId] = state;
  let timer: number | null = null;
  let seq = 0;

  const showPicked = () => {
    picked.innerHTML = '';
    if (!state.code) { picked.textContent = emptyLabel; return; }
    const b = document.createElement('b');
    b.textContent = state.code;
    picked.appendChild(b);
    picked.appendChild(document.createTextNode(' ' + (input.dataset.pickedName || '')));
  };

  const hide = () => { results.classList.remove('show'); results.innerHTML = ''; };

  const render = (rows: CrsPickerRow[], total: number, query: string) => {
    results.innerHTML = '';
    if (!rows.length) {
      const d = document.createElement('div');
      d.className = 'crs-search-empty';
      d.textContent = `No EPSG CRS matches "${query}". Try a code (2039), a name (Lambert-93), or a zone (utm 36n).`;
      results.appendChild(d);
      results.classList.add('show');
      return;
    }
    const cap = document.createElement('div');
    cap.className = 'crs-search-count';
    cap.textContent = `${rows.length} of ${total} EPSG CRSs`;
    results.appendChild(cap);

    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'crs-search-row' + (r.supported ? '' : ' unsupported');
      const cc = document.createElement('span');
      cc.className = 'cc';
      cc.textContent = r.code;
      const cn = document.createElement('span');
      cn.className = 'cn';
      cn.textContent = r.name + (r.deprecated ? ' (deprecated)' : '');
      const cm = document.createElement('span');
      cm.className = 'cm';
      cm.textContent = r.method;
      row.appendChild(cc);
      row.appendChild(cn);
      row.appendChild(cm);
      if (!r.supported && r.reason) {
        const why = document.createElement('div');
        why.className = 'cwhy';
        why.textContent = 'Not available: ' + r.reason;
        cn.appendChild(why);
        row.title = 'This CRS cannot be computed by SeisConv - ' + r.reason;
      } else {
        row.addEventListener('click', () => {
          state.code = r.code;
          input.value = `${r.code} - ${r.name}`;
          input.dataset.pickedName = r.name;
          showPicked();
          hide();
        });
      }
      results.appendChild(row);
    }
    results.classList.add('show');
  };

  const run = () => {
    const query = input.value.trim();
    // Clearing the box clears the selection - that is how the shapefile picker
    // gets back to "native" without a separate control.
    if (!query) {
      state.code = '';
      input.dataset.pickedName = '';
      showPicked();
      hide();
      return;
    }
    const mine = ++seq;
    void (async () => {
      try {
        const res = await api.epsgSearch({ query, limit: 40 });
        if (mine !== seq) return; // a newer keystroke already superseded this
        render(res.rows, res.total, query);
      } catch (e) {
        results.innerHTML = '';
        const d = document.createElement('div');
        d.className = 'crs-search-empty';
        d.textContent = 'CRS search failed: ' + errMsg(e);
        results.appendChild(d);
        results.classList.add('show');
      }
    })();
  };

  input.addEventListener('input', () => {
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(run, 160);
  });
  input.addEventListener('focus', () => { if (input.value.trim()) run(); });
  input.addEventListener('keydown', (ev) => { if ((ev as KeyboardEvent).key === 'Escape') hide(); });
  // A click anywhere else closes the list (the sandboxed renderer has no popups).
  document.addEventListener('click', (ev) => {
    if (ev.target !== input && !results.contains(ev.target as Node)) hide();
  });
  showPicked();
}

/** The EPSG code chosen in a picker, or '' when none is selected. */
function crsPickerCode(inputId: string): string {
  return crsPickers[inputId]?.code || '';
}

/**
 * Export the loaded survey as an ESRI Shapefile set (one ZIP: source + receiver
 * point layers). The chosen CRS is passed through as an EPSG code; an empty
 * value means "native", i.e. write the survey's own coordinates untouched.
 *
 * Any note the exporter returns (no CRS in the header, X records skipped, a
 * refused reprojection) is shown next to the button - the export still succeeds,
 * but the user is told what it could not do rather than being left to assume.
 */
async function exportShapefile() {
  if (!spsSummary) {
    $('spsShpStatus').textContent = 'Load SPS files first.';
    return;
  }
  const code = crsPickerCode('shpCrsSearch');
  $('spsShpStatus').textContent = 'Building shapefile…';
  showProgress('Building shapefile…');
  try {
    const r = await api.spsShapefile({ code: code || undefined, baseName: 'survey' });
    if (r.ok) {
      const notes = r.notes && r.notes.length ? ' - ' + r.notes.join(' ') : '';
      $('spsShpStatus').textContent = '✓ Saved ' + r.path + notes;
      audit('export', `SPS shapefile (${code || 'native CRS'}) → ${r.path}`, 'sps');
    } else if (r.canceled) $('spsShpStatus').textContent = '';
    else $('spsShpStatus').textContent = 'Failed: ' + (r.error || 'unknown');
  } catch (e) {
    $('spsShpStatus').textContent = 'Failed: ' + errMsg(e);
  } finally {
    hideProgress();
  }
}

// -- GeoTIFF export wizard ----------------------------------------------------
//
// Three steps: area, resolution, layers + CRS. The area is dragged on the SPS
// tab's OWN Leaflet map rather than in a second map inside the dialog - the user
// needs to see the survey under the box, and one map means one source of truth
// for the basemap, bearing and zoom.

/** The chosen export area, in WGS84 degrees (what the map works in). */
let gtBounds: { south: number; west: number; north: number; east: number } | null = null;
/** The rectangle drawn on the map for the current selection. */
let gtRect: L.Rectangle | null = null;
/** True when the export should cover the whole survey rather than a dragged box. */
let gtWhole = false;

function gtClearRect() {
  if (gtRect && leafletMap) leafletMap.removeLayer(gtRect);
  gtRect = null;
}

/** Draw / redraw the selection rectangle for the current bounds. */
function gtDrawRect() {
  if (!leafletMap || !gtBounds) return;
  gtClearRect();
  gtRect = L.rectangle(
    [[gtBounds.south, gtBounds.west], [gtBounds.north, gtBounds.east]],
    { color: '#14b8a6', weight: 2, dashArray: '6 4', fillOpacity: 0.08 },
  ).addTo(leafletMap);
}

/**
 * Arm the SPS map for one rectangle drag. Panning is disabled for the duration
 * so a drag draws instead of moving the map, and restored on mouseup even if the
 * pointer leaves the map - leaving a map permanently un-draggable would look
 * like the app had hung.
 */
function gtArmDrag() {
  if (!leafletMap) {
    setText('gtStatus', 'Switch the SPS view to Map first, then try again.');
    return;
  }
  const el = $opt('spsMap');
  el?.classList.add('gt-armed');
  leafletMap.dragging.disable();
  setText('spsExpStatus', 'Drag a box over the survey to set the GeoTIFF area.');

  let start: L.LatLng | null = null;
  const onDown = (e: L.LeafletMouseEvent) => {
    start = e.latlng;
    gtWhole = false; // an explicit drag overrides a previous whole-survey choice
    gtClearRect();
  };
  const onMove = (e: L.LeafletMouseEvent) => {
    if (!start) return;
    gtBounds = {
      south: Math.min(start.lat, e.latlng.lat), north: Math.max(start.lat, e.latlng.lat),
      west: Math.min(start.lng, e.latlng.lng), east: Math.max(start.lng, e.latlng.lng),
    };
    gtDrawRect();
  };
  const finish = () => {
    if (!leafletMap) return;
    leafletMap.off('mousedown', onDown);
    leafletMap.off('mousemove', onMove);
    leafletMap.off('mouseup', finish);
    leafletMap.dragging.enable();
    el?.classList.remove('gt-armed');
    start = null;
    setText('spsExpStatus', '');
    openGeotiffWizard();
  };
  leafletMap.on('mousedown', onDown);
  leafletMap.on('mousemove', onMove);
  leafletMap.on('mouseup', finish);
}

/**
 * Whole-survey extent. The renderer deliberately does NOT compute this: the
 * plotted geometry may be in projected E/N or degrees depending on the current
 * view, and the OUTPUT CRS may be a third frame. The worker has the stations and
 * the projection, so it derives the extent there and we simply say "whole".
 */
function gtWholeSurvey() {
  gtWhole = true;
  gtBounds = null;
  gtClearRect();
  gtUpdateReadout();
}

/** Metres across the current bounds, for the live size readout. */
function gtExtentMetres(): { w: number; h: number } | null {
  if (!gtBounds) return null;
  const midLat = (gtBounds.south + gtBounds.north) / 2;
  return {
    w: (gtBounds.east - gtBounds.west) * 111320 * Math.cos((midLat * Math.PI) / 180),
    h: (gtBounds.north - gtBounds.south) * 110540,
  };
}

/**
 * Median nearest-neighbour station spacing of the plotted survey, in the same
 * units the readout works in. NaN when it cannot be measured.
 *
 * Measured WITHIN a record class and then taken as the LARGER of the two: sources
 * and receivers often sit on the same stations, so measuring across both returns
 * the source-to-receiver offset (0.5 m on a production line) rather than the station
 * interval - the same trap that made the elevation search radius an order of
 * magnitude too small in 0.7.5.
 */
function gtStationSpacing(): number {
  const g = spsGeom;
  if (!g) return NaN;
  const midLat = (g.bbox.minY + g.bbox.maxY) / 2;
  const sx = g.geo ? 111320 * Math.cos((midLat * Math.PI) / 180) : 1;
  const sy = g.geo ? 110540 : 1;
  const MAX_SAMPLE = 300;   // the nearest-neighbour scan is O(n^2) on the sample
  const perClass: number[] = [];
  for (const cls of [g.src, g.rcv]) {
    const n = Math.min(cls.x.length, cls.y.length);
    if (n < 2) continue;
    const step = Math.max(1, Math.floor(n / MAX_SAMPLE));
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i += step) { xs.push(cls.x[i] * sx); ys.push(cls.y[i] * sy); }
    if (xs.length < 2) continue;
    const d: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      let best = Infinity;
      for (let j = 0; j < xs.length; j++) {
        if (i === j) continue;
        const dx = xs[i] - xs[j];
        const dy = ys[i] - ys[j];
        const q = dx * dx + dy * dy;
        if (q < best) best = q;
      }
      if (isFinite(best) && best > 0) d.push(Math.sqrt(best));
    }
    if (!d.length) continue;
    d.sort((a, b) => a - b);
    const med = d[Math.floor(d.length / 2)];
    if (isFinite(med) && med > 0) perClass.push(med);
  }
  return perClass.length ? Math.max(...perClass) : NaN;
}

/** Round to a friendly 1 / 2 / 5 x 10^n value, so the recommendation reads like a
 *  number a person would choose rather than 0.6231. */
function niceRes(v: number): number {
  if (!isFinite(v) || v <= 0) return NaN;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const pick = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return pick * mag;
}

/**
 * The finest ground resolution this survey's own geometry supports.
 *
 * A raster finer than the station spacing cannot show more survey - there is no
 * more survey to show. It just multiplies the file size while the layers get
 * emptier: at a quarter of the station interval the layout picture is already
 * mostly background. Four pixels per station interval keeps every station
 * distinguishable and matches the elevation search radius default.
 */
function gtRecommendedRes(): number {
  const s = gtStationSpacing();
  if (!isFinite(s) || s <= 0) return NaN;
  return niceRes(s / 4);
}

/** Live readout: chosen area, resulting pixel dimensions, and estimated size. */
function gtUpdateReadout() {
  const areaEl = $opt('gtAreaOut');
  const sizeEl = $opt('gtSizeOut');
  if (!areaEl || !sizeEl) return;

  if (!gtBounds && !gtWhole) {
    areaEl.textContent = 'No area chosen yet.';
    sizeEl.textContent = 'Choose an area to see the raster size.';
    return;
  }

  let m: { w: number; h: number } | null = null;
  if (gtWhole) {
    // The exact extent is computed by the WORKER in the output CRS (it has both
    // the stations and the projection); this is only an on-screen estimate from
    // the plotted geometry, so it is labelled as one.
    const g = spsGeom;
    const margin = Math.max(0, numVal('gtMargin') || 0);
    if (g) {
      const w = g.bbox.maxX - g.bbox.minX;
      const h = g.bbox.maxY - g.bbox.minY;
      m = g.geo
        ? {
            w: w * 111320 * Math.cos((((g.bbox.minY + g.bbox.maxY) / 2) * Math.PI) / 180) + 2 * margin,
            h: h * 110540 + 2 * margin,
          }
        : { w: w + 2 * margin, h: h + 2 * margin };
    }
    areaEl.textContent = `Whole survey + ${margin} units margin` +
      (m ? `\nabout ${(m.w / 1000).toFixed(2)} x ${(m.h / 1000).toFixed(2)} km (estimate)` : '');
  } else {
    m = gtExtentMetres()!;
    areaEl.textContent =
      `lat ${gtBounds!.south.toFixed(6)} .. ${gtBounds!.north.toFixed(6)}\n` +
      `lon ${gtBounds!.west.toFixed(6)} .. ${gtBounds!.east.toFixed(6)}\n` +
      `about ${(m.w / 1000).toFixed(2)} x ${(m.h / 1000).toFixed(2)} km`;
  }
  if (!m) { sizeEl.textContent = 'Load the survey to size the raster.'; return; }

  const res = numVal('gtRes');
  if (!Number.isFinite(res) || res <= 0) {
    sizeEl.innerHTML = '<span class="warn">Resolution must be a positive number.</span>';
    return;
  }
  const w = Math.max(1, Math.ceil(m.w / res));
  const h = Math.max(1, Math.ceil(m.h / res));
  const layers = gtSelectedLayers();
  const hasBasemap = !!gtBasemap();
  // 4 bytes per pixel for a float band, 3 for each RGB image (layout, basemap).
  const nLayers = layers.length + (hasBasemap ? 1 : 0);
  const bytes = layers.reduce((a, l) => a + w * h * (l === 'layout' ? 3 : 4), 0) + (hasBasemap ? w * h * 3 : 0);
  const mb = bytes / (1024 * 1024);
  let txt = `${w} x ${h} pixels at ${res} units/pixel\n` +
    `${nLayers} layer${nLayers === 1 ? '' : 's'}, about ${mb < 1 ? (bytes / 1024).toFixed(0) + ' KB' : mb.toFixed(1) + ' MB'} uncompressed`;
  const px = w * h;
  if (!nLayers) txt += '\nPick at least one layer.';
  if (px > 120_000_000) txt += `\nToo large: ${(px / 1e6).toFixed(0)} Mpx is over the 120 Mpx cap - use a coarser resolution.`;
  else if (px > 40_000_000) txt += `\nThat is ${(px / 1e6).toFixed(0)} Mpx - it will be slow and large.`;
  // A raster far finer than the station spacing produces a huge, near-empty image:
  // there is no more survey to resolve, so the extra pixels are all background.
  // This is the "zoomed in too far and the GeoTIFF came out grey" case, and it has
  // to be said HERE, before the export, not in a note afterwards.
  const spacing = gtStationSpacing();
  const rec = gtRecommendedRes();
  if (isFinite(spacing) && spacing > 0 && isFinite(rec)) {
    const ratio = spacing / res;
    if (ratio > 8) {
      txt += `\nToo fine for this survey: ${Math.round(ratio)} pixels per ${spacing.toFixed(1)}-unit station interval. ` +
        `The layers will be mostly empty and the file far bigger than the data in it. Recommended: ${rec} units/pixel.`;
    } else if (res > spacing * 2) {
      txt += `\nCoarser than the station interval (${spacing.toFixed(1)} units) - stations will merge into the same pixel. Recommended: ${rec} units/pixel.`;
    }
  }
  sizeEl.innerHTML = '';
  const pre = document.createElement('span');
  pre.textContent = txt.split('\n').slice(0, 2).join('\n');
  sizeEl.appendChild(pre);
  const rest = txt.split('\n').slice(2);
  for (const line of rest) {
    const w2 = document.createElement('div');
    w2.className = 'warn';
    w2.textContent = line;
    sizeEl.appendChild(w2);
  }
}

/** The chosen basemap tile source, or '' for none. */
function gtBasemap(): string {
  return (($opt('gtBasemap') as HTMLSelectElement | null)?.value || '').trim();
}

/**
 * Show the licensing position whenever a basemap is selected. Tiles are licensed
 * for DISPLAY; writing them into a file that is handed on is redistribution, so
 * the user is told plainly rather than finding out from a client.
 */
function gtUpdateBasemapNote() {
  const el = $opt('gtBasemapNote');
  if (!el) return;
  const key = gtBasemap();
  if (!key) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = '';
  el.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'warn';
  d.textContent =
    'Needs internet at export time. Map tiles are licensed for display, and writing them into a file you pass on is redistribution - ' +
    'check that your tile source permits it. The provider attribution is embedded in the GeoTIFF and in an ATTRIBUTION.txt inside the ZIP.';
  el.appendChild(d);
  // The grey canvases have native tiles only to zoom 16 (~2 m/pixel at mid
  // latitudes). Past that the export would bake permanently-soft imagery into a
  // deliverable, so say it BEFORE the export rather than after.
  if (key === 'light' || key === 'dark') {
    const g = document.createElement('div');
    g.className = 'warn';
    g.textContent =
      'The grey canvas basemaps carry detail only to about zoom 16 (roughly 2 m per pixel). A finer resolution than that ' +
      'produces an upscaled, soft image baked into the file - choose Satellite for sub-2 m pixel sizes.';
    el.appendChild(g);
  }
}

function gtSelectedLayers(): ('fold' | 'elevation' | 'layout')[] {
  const out: ('fold' | 'elevation' | 'layout')[] = [];
  if (($opt('gtLayerFold') as HTMLInputElement | null)?.checked) out.push('fold');
  if (($opt('gtLayerElev') as HTMLInputElement | null)?.checked) out.push('elevation');
  if (($opt('gtLayerLayout') as HTMLInputElement | null)?.checked) out.push('layout');
  return out;
}

/** True once the user has typed their own resolution; until then the wizard is free
 *  to seed one from the survey. Reset whenever a different survey is loaded. */
let gtResTouched = false;

function openGeotiffWizard() {
  if (!spsSummary) {
    $('spsExpStatus').textContent = 'Load SPS files first.';
    return;
  }
  // Seed the resolution from THIS survey's station spacing rather than leaving the
  // fixed factory 5. A default with no relationship to the data is how an export
  // ends up either far too fine (a huge, near-empty raster) or too coarse to show
  // the stations at all. The user can still type anything they like.
  if (!gtResTouched) {
    const rec = gtRecommendedRes();
    if (isFinite(rec)) setVal('gtRes', String(rec));
  }
  $opt('geotiffBack')?.classList.add('open');
  gtUpdateReadout();
}

function closeGeotiffWizard() {
  $opt('geotiffBack')?.classList.remove('open');
}

async function runGeotiffExport() {
  if (!gtBounds && !gtWhole) { setText('gtStatus', 'Choose an area first.'); return; }
  const layers = gtSelectedLayers();
  const basemap = gtBasemap();
  if (!layers.length && !basemap) { setText('gtStatus', 'Pick at least one layer.'); return; }
  const res = numVal('gtRes');
  if (!Number.isFinite(res) || res <= 0) { setText('gtStatus', 'Resolution must be a positive number.'); return; }
  const radius = numVal('gtDemRadius');

  // Tile download dominates the wait when a basemap is included, so say so
  // rather than leaving the user watching a generic "building" message.
  setText('gtStatus', basemap ? 'Downloading map tiles and building rasters…' : 'Building rasters…');
  showProgress(basemap ? 'Downloading basemap tiles…' : 'Building GeoTIFF…');
  try {
    const r = await api.spsRaster({
      bounds: gtWhole ? null : gtBounds,
      whole: gtWhole,
      marginM: gtWhole ? Math.max(0, numVal('gtMargin') || 0) : undefined,
      pixelSize: res,
      layers,
      basemap: basemap || undefined,
      code: crsPickerCode('gtCrsSearch') || undefined,
      demRadius: Number.isFinite(radius) && radius > 0 ? radius : undefined,
      baseName: 'survey',
    });
    if (r.ok) {
      const warn = (r.notes || []).filter((n) => /INCOMPLETE|skipped|Cannot/i.test(n));
      // A partially-downloaded basemap must be visible in the DIALOG the user is
      // looking at, not only in the status line behind it.
      setText('gtStatus', '✓ Saved ' + r.path + (warn.length ? '  -  ' + warn.join(' ') : ''));
      const notes = (r.notes || []).join(' ');
      if (notes) setText('spsExpStatus', notes);
      audit('export', `SPS GeoTIFF (${[...layers, basemap ? 'basemap:' + basemap : ''].filter(Boolean).join('+')}) → ${r.path}`, 'sps');
    } else if (r.canceled) setText('gtStatus', '');
    else setText('gtStatus', 'Failed: ' + (r.error || 'unknown'));
  } catch (e) {
    setText('gtStatus', 'Failed: ' + errMsg(e));
  } finally {
    hideProgress();
  }
}

function initGeotiffWizard() {
  $opt('spsExpGeotiffBtn')?.addEventListener('click', () => openGeotiffWizard());
  $opt('geotiffClose')?.addEventListener('click', () => closeGeotiffWizard());
  $opt('gtDragBtn')?.addEventListener('click', () => { closeGeotiffWizard(); gtArmDrag(); });
  $opt('gtWholeBtn')?.addEventListener('click', () => gtWholeSurvey());
  $opt('gtExportBtn')?.addEventListener('click', () => void runGeotiffExport());
  $opt('gtResAuto')?.addEventListener('click', () => {
    const rec = gtRecommendedRes();
    if (!isFinite(rec)) { setText('gtStatus', 'Cannot measure the station spacing - load the survey first.'); return; }
    setVal('gtRes', String(rec));
    gtUpdateReadout();
    setText('gtStatus', `Resolution set to ${rec} units/pixel, from this survey's station spacing.`);
  });
  $opt('gtBasemap')?.addEventListener('change', () => { gtUpdateBasemapNote(); gtUpdateReadout(); });
  for (const id of ['gtRes', 'gtMargin', 'gtLayerFold', 'gtLayerElev', 'gtLayerLayout']) {
    $opt(id)?.addEventListener('input', () => gtUpdateReadout());
    $opt(id)?.addEventListener('change', () => gtUpdateReadout());
  }
  // Typing a resolution pins it; the wizard stops seeding one on open.
  $opt('gtRes')?.addEventListener('input', () => { gtResTouched = true; });
  initCrsPicker('gtCrsSearch', 'gtCrsResults', 'gtCrsPicked', "Native: the survey's own CRS.");
}

// Enable/disable the SPS export buttons (disabled until a survey is loaded).
function setSpsExportEnabled(on: boolean) {
  for (const id of ['spsExpKmlBtn', 'spsExpGeojsonBtn', 'spsExpCsvBtn', 'spsExpQcBtn', 'spsExpShpBtn', 'spsExpGeotiffBtn', 'spsExpFormatBtn']) {
    const btn = $opt(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = !on;
  }
}

// Geographic / tabular SPS export (KML, GeoJSON, CSV trio, QC-report CSV). Saves
// EXACTLY like exportReprojected: the main side runs the same ZIP / single-file
// Save flow and returns {ok, path | canceled | error}; we just surface it.
async function exportSPS(kind: 'kml' | 'geojson' | 'csv' | 'qcreport' | 'p111' | 'coordcsv' | 'segp1' | 'sps', statusId = 'spsExpStatus') {
  if (!spsSummary) {
    $(statusId).textContent = 'Load SPS files first.';
    return;
  }
  $(statusId).textContent = 'Exporting…';
  const kindLabel: Record<string, string> = { kml: 'KML', geojson: 'GeoJSON', csv: 'CSV', qcreport: 'QC report', p111: 'P1/11', coordcsv: 'coordinate CSV', segp1: 'SEG-P1', sps: 'SPS 2.1' };
  showProgress(`Exporting ${kindLabel[kind] || kind}…`);
  try {
    const r = await api.spsExport({ kind, qcParams: kind === 'qcreport' ? currentQCParams() : undefined });
    if (r.ok) { $(statusId).textContent = '✓ Saved ' + r.path; audit('export', `SPS ${kind} → ${r.path}`, 'sps'); }
    else if (r.canceled) $(statusId).textContent = '';
    else $(statusId).textContent = 'Failed: ' + (r.error || 'unknown');
  } catch (e) {
    $(statusId).textContent = 'Failed: ' + errMsg(e);
  } finally {
    hideProgress();
  }
}

// ++++++++++++++++++++++ SPS Header Viewer / Editor ++++++++++++++++++++++
// A modal over the SPS panel: VIEW the H-record block grouped by purpose, edit
// the CRS / projection (label-only OR hand off to Reproject), edit Admin fields,
// edit every raw H-record, and Apply / Export. All header-only - coordinate
// lines are never touched here (reprojection lives in the Reproject control).
type SpsHeaderRow = { code: string; val: string; raw: string; desc: string };
type SpsHeaderProj = {
  type: string | null; subtype: string | null; zone: number | null; hemi: string | null;
  datum: string | null; ellipsoid: string | null; units: string;
  centralMeridian: number | null; latOrigin: number | null;
  falseEasting: number | null; falseNorthing: number | null; scaleFactor: number | null;
  desc?: string;
};
type SpsHeaderState = {
  headers: SpsHeaderRow[];
  projection: SpsHeaderProj | null;
  files: { name: string; type: string }[];
  filesDiffer: boolean;
};

// Live snapshot of the last header list pulled from the worker (drives every
// sub-view); null while the modal is closed / nothing loaded.
let spsHdrState: SpsHeaderState | null = null;
// Working copy of the raw H-records the user edits in the Raw tab. `origCode`/
// `origVal` snapshot the record's loaded identity (null for user-added rows) so
// an edit/remove can target THAT record by code+value, not by code alone - two
// records sharing a code must not be rewritten/dropped together.
let spsHdrRawDraft: { code: string; val: string; desc: string; orig: boolean; origCode: string | null; origVal: string | null }[] = [];

// Grouping of H-record codes into human sections for the VIEW table. Order here
// is the display order; an "Other" bucket catches anything unmatched.
const SPS_HDR_GROUPS: { title: string; match: (code: string) => boolean }[] = [
  { title: 'Project / Admin', match: (c) => /^H0[0-9]$/.test(c) || c === 'H30' || c === 'H31' },
  { title: 'CRS / Datum / Projection', match: (c) => /^H12$|^H14$|^H17$|^H18$|^H19$|^H20[01]?$|^H22\d$|^H231$|^H232$|^H241$/.test(c) },
  { title: 'Instrument', match: (c) => /^H4\d{1,2}$/.test(c) },
  { title: 'Receiver', match: (c) => /^H6\d{1,2}$/.test(c) },
  { title: 'Source', match: (c) => /^H[78]\d{1,2}$/.test(c) },
  { title: 'QC', match: (c) => /^H99\d?$/.test(c) },
];

function openSpsHeaders() {
  if (!spsSummary) { $('spsLabel').textContent = 'Load SPS files first.'; return; }
  $opt('spsHeadersBack')?.classList.add('open');
  $('spsHdrStatus').textContent = 'Loading…';
  void loadSpsHeaders();
}
function closeSpsHeaders() { $opt('spsHeadersBack')?.classList.remove('open'); }
function spsHeadersOpen(): boolean { return !!$opt('spsHeadersBack')?.classList.contains('open'); }

/** Pull the header list from the worker and (re)paint every sub-view. */
async function loadSpsHeaders() {
  try {
    const r = await api.spsHeaderList();
    if (!r || !r.ok) { $('spsHdrStatus').textContent = 'Failed to read headers.'; return; }
    spsHdrState = { headers: r.headers, projection: r.projection, files: r.files, filesDiffer: r.filesDiffer };
    $('spsHdrStatus').textContent = '';
    renderSpsHeaders();
  } catch (e) {
    $('spsHdrStatus').textContent = 'Failed: ' + errMsg(e);
  }
}

/** Paint scope selector, files-differ warning, and all four tabs from spsHdrState. */
function renderSpsHeaders() {
  const st = spsHdrState;
  if (!st) return;
  // files-differ warning
  $('spsHdrDiffWarn').classList.toggle('hidden', !st.filesDiffer);
  // scope selector - 'shared' + one option per loaded file (offer per-file always,
  // but it matters most when filesDiffer).
  const scope = $('spsHdrScope') as HTMLSelectElement;
  const prev = scope.value;
  scope.innerHTML = '';
  const shared = document.createElement('option');
  shared.value = 'shared';
  shared.textContent = `All S / R / X files (shared)${st.files.length ? ` - ${st.files.length} file${st.files.length === 1 ? '' : 's'}` : ''}`;
  scope.appendChild(shared);
  for (const f of st.files) {
    const o = document.createElement('option');
    o.value = f.name;
    o.textContent = `${f.name} (${f.type})`;
    scope.appendChild(o);
  }
  scope.value = st.files.some((f) => f.name === prev) || prev === 'shared' ? prev : 'shared';
  $('spsHdrScopeNote').textContent = st.filesDiffer
    ? 'Headers differ between files - per-file editing recommended.'
    : '';

  renderSpsHdrView();
  renderSpsHdrCrs();
  renderSpsHdrAdmin();
  renderSpsHdrRaw();
  // Always open on the View tab. The active sub-tab persists across close/reopen
  // via DOM classes, and spsHdrStampCrs() can leave CRS active, so without this a
  // reopened modal could land on a stale CRS/Raw/Admin panel and look empty/broken.
  spsHdrTab('view');
}

/** VIEW tab: grouped, EDITABLE table - one row per H-code per section.
 *  For each code we collapse the (possibly several, across the shared S/R/X
 *  files) matching H-records into a single editable value: the DISTINCT,
 *  NON-EMPTY values are gathered, so empties and exact duplicates never show as
 *  stray ",value" / "N/A,N/A" artifacts. One distinct value ⇒ clean value;
 *  several genuinely-different values ⇒ first + a subtle "(differs)" hint. The
 *  field edits flow into the Raw draft (keyed by code) so Apply works here too.
 *  The RAW tab still lists every individual record untouched. */
function renderSpsHdrView() {
  const host = $('spsHdrGroups');
  host.innerHTML = '';
  const rows = spsHdrState?.headers || [];
  if (!rows.length) { host.innerHTML = '<div class="sps-hdr-empty">No H-records in this survey.</div>'; return; }
  // Bucket header indices into their display section, preserving first-seen code
  // order. "used" tracks which got a home so the rest fall into "Other".
  const used = new Set<number>();
  const groups: { title: string; codes: string[]; desc: Record<string, string> }[] =
    SPS_HDR_GROUPS.map((g) => ({ title: g.title, codes: [], desc: {} }));
  const pushCode = (g: { codes: string[]; desc: Record<string, string> }, code: string, desc: string) => {
    if (!g.codes.includes(code)) g.codes.push(code);
    if (desc && !g.desc[code]) g.desc[code] = desc;
  };
  rows.forEach((r, i) => {
    const gi = SPS_HDR_GROUPS.findIndex((g) => g.match(r.code));
    if (gi >= 0) { pushCode(groups[gi], r.code, r.desc || ''); used.add(i); }
  });
  const otherGrp = { title: 'Other', codes: [] as string[], desc: {} as Record<string, string> };
  rows.forEach((r, i) => { if (!used.has(i)) pushCode(otherGrp, r.code, r.desc || ''); });
  const allGroups = otherGrp.codes.length ? [...groups, otherGrp] : groups;

  for (const g of allGroups) {
    if (!g.codes.length) continue;
    const box = document.createElement('div');
    box.className = 'sps-hdr-grp';
    const h = document.createElement('h4');
    h.textContent = g.title;
    box.appendChild(h);
    for (const code of g.codes) {
      // Distinct, non-empty values for this code across every matching record.
      const distinct: string[] = [];
      for (const r of rows) {
        if (r.code !== code) continue;
        const v = (r.val || '').trim();
        if (v && !distinct.includes(v)) distinct.push(v);
      }
      const differs = distinct.length > 1;
      const value = distinct[0] || '';

      const row = document.createElement('div');
      row.className = 'row';
      const c = document.createElement('span'); c.className = 'c'; c.textContent = code;
      const d = document.createElement('span'); d.className = 'd'; d.textContent = g.desc[code] || '';
      const vWrap = document.createElement('span'); vWrap.className = 'v';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ctl sps-hdr-vin';
      input.value = value;
      input.placeholder = '-';
      if (differs) {
        // Several genuinely-different values share this code across the loaded
        // files. Editing here would have to pick ONE value and overwrite every
        // sibling, silently destroying the others - so block the collapsed field
        // and point the user at the Raw tab, which lists each record individually.
        input.readOnly = true;
        input.classList.add('sps-hdr-vin-ro');
        input.title = `Values differ across files: ${distinct.join(' | ')} - edit individual records on the Raw tab`;
      } else {
        // Single distinct value ⇒ a clean edit. Target ONLY the draft record(s)
        // carrying this exact loaded value (code+origVal), never every sibling
        // sharing the code, so a same-code record with a different value is left
        // untouched. The edit flows into the Raw draft so Apply picks it up.
        const origVal = value;
        input.title = g.desc[code] || '';
        input.addEventListener('input', () => { setStructuredHdrVal(code, origVal, input.value); });
      }
      vWrap.appendChild(input);
      if (differs) {
        const hint = document.createElement('span');
        hint.className = 'sps-hdr-differs';
        hint.textContent = '(differs)';
        hint.title = `Values differ across files: ${distinct.join(' | ')}`;
        vWrap.appendChild(hint);
      }
      row.appendChild(c); row.appendChild(d); row.appendChild(vWrap);
      box.appendChild(row);
    }
    host.appendChild(box);
  }
}

/** Write a structured-view edit into the Raw draft so Apply emits it.
 *  Targets only the draft record(s) whose loaded identity matches code+origVal
 *  (NOT every sibling sharing the code), so a same-code record carrying a
 *  different value is never silently rewritten. If no such record exists yet
 *  (a freshly-added code), it updates a same-code record or appends a new one.
 *  Does NOT repaint the whole Raw list (that would destroy any mid-edit Raw
 *  input on every keystroke); it patches the affected Raw input in place if the
 *  Raw tab is currently mounted. */
function setStructuredHdrVal(code: string, origVal: string, val: string) {
  let hit = false;
  for (const rec of spsHdrRawDraft) {
    // Prefer the exact loaded identity (code + original value). A record whose
    // origVal is null (newly added) or whose value already moved to `val` (the
    // user is editing the same field again) is matched on code as a fallback.
    const idMatch = rec.code === code && (rec.origVal === origVal || rec.val === origVal || rec.val === val);
    if (idMatch) { rec.val = val; hit = true; }
  }
  if (!hit) spsHdrRawDraft.push({ code, val, desc: '', orig: false, origCode: null, origVal: null });
  syncRawInputsFromDraft();
}

/** Patch the Raw-tab inputs' values from the current draft WITHOUT rebuilding the
 *  DOM (so a mid-edit Raw input is never destroyed). No-op when the Raw list isn't
 *  painted or its row count no longer matches the draft (then a structural repaint
 *  is required and happens on the next tab switch / explicit paint). */
function syncRawInputsFromDraft() {
  const host = $opt('spsHdrRawList');
  if (!host) return;
  const rows = host.querySelectorAll('.sps-hdr-raw-row');
  if (rows.length !== spsHdrRawDraft.length) return;
  rows.forEach((row, i) => {
    const valEl = row.querySelector('.rawval') as HTMLInputElement | null;
    if (valEl && document.activeElement !== valEl && valEl.value !== spsHdrRawDraft[i].val) {
      valEl.value = spsHdrRawDraft[i].val;
    }
  });
}

/** CRS tab: prefill the form from the parsed projection (or show the stamp-CRS prompt). */
function renderSpsHdrCrs() {
  const p = spsHdrState?.projection || null;
  const hasProj = !!(p && (p.type || p.subtype));
  $('spsHdrNoProj').classList.toggle('hidden', hasProj);
  // The form stays visible either way (the stamp button reveals it for editing),
  // but when there's truly no projection we still let the user fill it in.
  const sub = (p?.subtype || (p?.type ? 'TM' : 'UTM')).toUpperCase();
  (($('crsProjType') as HTMLSelectElement)).value = sub === 'GEO' ? 'GEO' : sub === 'UTM' ? 'UTM' : 'TM';
  setVal('crsDatum', p?.datum || '');
  setVal('crsZone', p?.zone != null ? String(p.zone) : '');
  (($('crsHemi') as HTMLSelectElement)).value = p?.hemi === 'S' ? 'S' : 'N';
  (($('crsUnits') as HTMLSelectElement)).value = (p?.units || 'meters').toLowerCase().includes('f') ? 'feet' : 'meters';
  setVal('crsCM', p?.centralMeridian != null ? String(p.centralMeridian) : '');
  setVal('crsLat0', p?.latOrigin != null ? String(p.latOrigin) : '');
  setVal('crsFE', p?.falseEasting != null ? String(p.falseEasting) : '');
  setVal('crsFN', p?.falseNorthing != null ? String(p.falseNorthing) : '');
  setVal('crsK0', p?.scaleFactor != null ? String(p.scaleFactor) : '');
}

/** ADMIN tab: prefill from the existing H01/H02/H03/H04 values. */
function renderSpsHdrAdmin() {
  const get = (code: string) => (spsHdrState?.headers.find((h) => h.code === code)?.val) || '';
  setVal('admArea', get('H01'));
  setVal('admDate', get('H02'));
  setVal('admClient', get('H03'));
  setVal('admContractor', get('H04'));
}

/** RAW tab: build the editable record list from a fresh draft of every H-record. */
function renderSpsHdrRaw() {
  spsHdrRawDraft = (spsHdrState?.headers || []).map((h) => ({ code: h.code, val: h.val, desc: h.desc, orig: true, origCode: h.code, origVal: h.val }));
  paintSpsHdrRaw();
}
function paintSpsHdrRaw() {
  const host = $('spsHdrRawList');
  host.innerHTML = '';
  spsHdrRawDraft.forEach((rec, i) => {
    const row = document.createElement('div');
    row.className = 'sps-hdr-raw-row';
    const code = document.createElement('input');
    code.type = 'text'; code.className = 'ctl rawcode'; code.value = rec.code; code.maxLength = 4;
    code.title = rec.desc || '';
    code.addEventListener('input', () => { spsHdrRawDraft[i].code = code.value.trim().toUpperCase(); });
    const val = document.createElement('input');
    val.type = 'text'; val.className = 'ctl rawval'; val.value = rec.val;
    val.addEventListener('input', () => { spsHdrRawDraft[i].val = val.value; });
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'sps-hdr-raw-del'; del.title = 'Remove record'; del.setAttribute('aria-label', 'Remove record');
    del.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    del.addEventListener('click', () => { void spsHdrRemoveRaw(i); });
    row.appendChild(code); row.appendChild(val); row.appendChild(del);
    host.appendChild(row);
  });
}
/** Confirmed, audited, undoable delete of an SPS raw header-record draft entry.
 *  The draft only commits to disk on Apply, so this audits the draft edit and
 *  restores at the original position on undo. */
async function spsHdrRemoveRaw(i: number) {
  const saved = spsHdrRawDraft[i];
  if (!saved) return;
  const what = `SPS header record ${saved.code || '(blank)'}`;
  if (!(await confirmDelete(`Remove ${what} from the draft? (applies on Apply)`))) return;
  // Re-find by identity - the draft may have changed while the dialog was open.
  const pos = spsHdrRawDraft.indexOf(saved);
  if (pos < 0) return;
  spsHdrRawDraft.splice(pos, 1);
  paintSpsHdrRaw();
  audit('delete', what + ' (draft)', 'sps');
  let undone = false;
  undoToast(`Removed ${what}`, () => {
    if (undone) return;
    undone = true;
    const at = Math.min(pos, spsHdrRawDraft.length);
    spsHdrRawDraft.splice(at, 0, saved);
    paintSpsHdrRaw();
    audit('undo-delete', what + ' (draft)', 'sps');
  });
}
function spsHdrAddRaw() {
  const code = (($('spsHdrAddCode') as HTMLInputElement).value || '').trim().toUpperCase();
  const val = ($('spsHdrAddVal') as HTMLInputElement).value || '';
  if (!/^H\d{1,3}$/.test(code)) { $('spsHdrStatus').textContent = 'Enter a valid H-record code (e.g. H05).'; return; }
  spsHdrRawDraft.push({ code, val, desc: '', orig: false, origCode: null, origVal: null });
  ($('spsHdrAddCode') as HTMLInputElement).value = '';
  ($('spsHdrAddVal') as HTMLInputElement).value = '';
  $('spsHdrStatus').textContent = '';
  paintSpsHdrRaw();
}

/** Switch between the View / CRS / Admin / Raw sub-tabs. */
function spsHdrTab(which: 'view' | 'crs' | 'admin' | 'raw') {
  const map: Record<string, string> = { view: 'View', crs: 'Crs', admin: 'Admin', raw: 'Raw' };
  for (const key of Object.keys(map)) {
    $opt('spsHdrTab' + map[key])?.classList.toggle('on', key === which);
    $opt('spsHtab' + map[key])?.classList.toggle('hidden', key !== which);
  }
}

/** Stamp-a-CRS: just reveal/focus the CRS form so the user can fill it in. */
function spsHdrStampCrs() {
  $('spsHdrNoProj').classList.add('hidden');
  spsHdrTab('crs');
  ($('crsDatum') as HTMLInputElement).focus();
}

/** Build the spsApplyHeaders request from the Raw draft + Admin fields + (active CRS form). */
function buildApplyRequest(): {
  scope: string;
  edits: { code: string; val: string; oldVal?: string }[];
  adds: { code: string; desc?: string; val: string }[];
  removes: (string | { code: string; oldVal?: string })[];
  crs?: Record<string, unknown>;
} | null {
  const st = spsHdrState;
  if (!st) return null;
  const scope = ($('spsHdrScope') as HTMLSelectElement).value || 'shared';
  // Which codes still exist somewhere in the draft (used to decide a code-only
  // Admin upsert vs. an add, and to keep the section's existing-code semantics).
  const draftCodes = new Set(spsHdrRawDraft.map((r) => r.code).filter(Boolean));

  const edits: { code: string; val: string; oldVal?: string }[] = [];
  const adds: { code: string; desc?: string; val: string }[] = [];
  const removes: (string | { code: string; oldVal?: string })[] = [];

  // Raw draft drives edits/adds. Each row carries its loaded identity (origVal),
  // so an edit is targeted by code+origVal - a record sharing a code with another
  // is no longer rewritten alongside it. A row whose code changed is treated as a
  // remove (of the old identity) + an add (of the new code/value).
  for (const rec of spsHdrRawDraft) {
    if (!rec.code) continue;
    if (rec.origVal != null && rec.origCode != null) {
      if (rec.code !== rec.origCode) {
        removes.push({ code: rec.origCode, oldVal: rec.origVal });
        adds.push({ code: rec.code, val: rec.val, desc: rec.desc || undefined });
      } else if (rec.val !== rec.origVal) {
        edits.push({ code: rec.code, val: rec.val, oldVal: rec.origVal });
      }
    } else {
      adds.push({ code: rec.code, val: rec.val, desc: rec.desc || undefined });
    }
  }
  // Original records the user deleted from the draft → remove by code+value so
  // only that specific record is dropped (not every sibling sharing its code).
  const draftIds = new Set(
    spsHdrRawDraft.filter((r) => r.origVal != null && r.origCode != null).map((r) => r.origCode + '␟' + r.origVal),
  );
  for (const h of st.headers) {
    if (!draftIds.has(h.code + '␟' + h.val)) removes.push({ code: h.code, oldVal: h.val });
  }

  // Admin fields → map to H01/H02/H03/H04. A field overrides whatever the Raw
  // draft produced for that code (Admin is the friendlier surface for them). These
  // are unique-code records, so a plain code-keyed edit/add is correct here.
  const admin: [string, string][] = [
    ['H01', ($('admArea') as HTMLInputElement).value.trim()],
    ['H02', ($('admDate') as HTMLInputElement).value.trim()],
    ['H03', ($('admClient') as HTMLInputElement).value.trim()],
    ['H04', ($('admContractor') as HTMLInputElement).value.trim()],
  ];
  for (const [code, val] of admin) {
    if (val === '') continue; // blank = leave untouched
    if (draftCodes.has(code)) {
      upsertEdit(edits, code, val);
    } else if (!adds.some((a) => a.code === code)) {
      adds.push({ code, val });
    }
    // The Admin field is authoritative for this code - undo any remove of it.
    for (let i = removes.length - 1; i >= 0; i--) {
      const r = removes[i];
      if (typeof r === 'string' ? r === code : r.code === code) removes.splice(i, 1);
    }
  }

  const req: ReturnType<typeof buildApplyRequest> = { scope, edits, adds, removes };

  // CRS: only attach req.crs when the CRS tab is the active editing surface AND
  // the user chose label-only mode. Reproject mode hands off elsewhere.
  return req;
}
/** Replace-or-add a code-keyed edit entry for `code` (Admin can override a Raw
 *  edit). Admin codes are unique, so dropping any `oldVal` discriminator and
 *  matching the per-code edit is correct; it also strips a stale value-keyed
 *  edit for the same code so the Admin value wins. */
function upsertEdit(edits: { code: string; val: string; oldVal?: string }[], code: string, val: string) {
  const e = edits.find((x) => x.code === code);
  if (e) { e.val = val; delete e.oldVal; } else edits.push({ code, val });
}

/** Read the CRS form into the spsApplyHeaders.crs shape. */
function readCrsForm(): Record<string, unknown> {
  const projType = ($('crsProjType') as HTMLSelectElement).value;
  const numOrU = (id: string) => { const v = parseFloat(($(id) as HTMLInputElement).value); return isFinite(v) ? v : undefined; };
  const strOrU = (id: string) => { const v = ($(id) as HTMLInputElement).value.trim(); return v || undefined; };
  return {
    datum: strOrU('crsDatum'),
    projType,
    zone: numOrU('crsZone'),
    hemi: (($('crsHemi') as HTMLSelectElement).value === 'S' ? 'S' : 'N'),
    units: ($('crsUnits') as HTMLSelectElement).value,
    centralMeridian: numOrU('crsCM'),
    latOrigin: numOrU('crsLat0'),
    falseEasting: numOrU('crsFE'),
    falseNorthing: numOrU('crsFN'),
    scaleFactor: numOrU('crsK0'),
  };
}

/** Is the CRS tab the currently-active sub-view? */
function spsHdrCrsTabActive(): boolean {
  return !$opt('spsHtabCrs')?.classList.contains('hidden');
}
/** Did the user pick "reproject the coordinates too"? */
function spsHdrReprojectChosen(): boolean {
  return !!($opt('crsModeReproject') as HTMLInputElement | null)?.checked;
}

/** APPLY: send edits/adds/removes (+ optional CRS) to the worker, then refresh. */
async function applySpsHeaders() {
  if (!spsHdrState) return;
  // CRS reproject hand-off: close the dialog and focus the Reproject control -
  // we do NOT duplicate reprojection here.
  if (spsHdrCrsTabActive() && spsHdrReprojectChosen()) {
    closeSpsHeaders();
    const sel = $opt('epsgSelect') as HTMLSelectElement | null;
    sel?.focus();
    sel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('spsExportStatus').textContent = 'Pick a target CRS and Export reprojected to transform the coordinates.';
    return;
  }
  const req = buildApplyRequest();
  if (!req) return;
  // Attach the CRS form (label-only) when the CRS tab is active.
  if (spsHdrCrsTabActive()) req.crs = readCrsForm();
  // Snapshot the raw-record draft before it commits to the files, so the
  // edited/added/removed records can be restored.
  if (spsHdrRawDraft.length) {
    snapshotBackup('sps-draft', spsHdrRawDraft, `SPS header draft (${spsHdrRawDraft.length} records, before Apply)`);
  }
  $('spsHdrStatus').textContent = 'Applying…';
  try {
    const r = await api.spsApplyHeaders(req as Parameters<typeof api.spsApplyHeaders>[0]);
    if (!r || !r.ok) { $('spsHdrStatus').textContent = 'Failed: ' + (r?.error || 'unknown'); return; }
    $('spsHdrStatus').textContent = '✓ Applied';
    audit('apply', `SPS headers applied (${req.edits.length} edited, ${req.adds.length} added, ${req.removes.length} removed)`, 'sps');
    // Refresh the header view from the returned list…
    if (spsHdrState) spsHdrState.headers = r.headers;
    // …and re-pull the full state (projection / files may have changed).
    await loadSpsHeaders();
    // Re-sync the SPS panel itself: re-read the survey so a freshly-stamped CRS
    // lights up the map + status strip (loadSPS-style refresh, no re-pick dialog).
    await refreshSpsAfterHeaderEdit();
  } catch (e) {
    $('spsHdrStatus').textContent = 'Failed: ' + errMsg(e);
  }
}

/** Re-pull the survey summary + geometry after a header edit so the panel,
 *  status strip, and (if a CRS was added) the map all reflect the new header. */
async function refreshSpsAfterHeaderEdit() {
  // The worker re-parsed currentSPS during spsApplyHeaders, so we just invalidate
  // the renderer caches and re-render from the worker's current state (no re-pick
  // dialog - refreshSps refetches geometry from the already-loaded survey).
  spsGeom = null;
  spsSpider = null;
  spsFold = null;
  spsFoldBin = 0;
  gridView.init = false;
  invalidateSpsSourceCache();
  // Refresh the projection on the cached summary so the map toggle + summary panel
  // pick up a newly-stamped CRS without a full re-open.
  if (spsSummary && spsHdrState?.projection) {
    spsSummary.projection = { type: spsHdrState.projection.type, subtype: spsHdrState.projection.subtype, desc: spsHdrState.projection.desc };
  } else if (spsSummary && !spsHdrState?.projection) {
    spsSummary.projection = null;
  }
  renderSummaryPanel();
  updateStatusStrip();
  if (spsSummary) await refreshSps();
}

/** EXPORT: save the edited files as a .zip via the worker's save flow. */
async function exportSpsCorrected() {
  $('spsHdrStatus').textContent = 'Saving…';
  try {
    const r = await api.spsSaveCorrected();
    if (r.ok) { $('spsHdrStatus').textContent = '✓ Saved ' + r.path; audit('export', 'SPS corrected → ' + r.path, 'sps'); }
    else if (r.canceled) $('spsHdrStatus').textContent = '';
    else $('spsHdrStatus').textContent = 'Failed: ' + (r.error || 'unknown');
  } catch (e) {
    $('spsHdrStatus').textContent = 'Failed: ' + errMsg(e);
  }
}

/** Small DOM helper - set an input's value by id. */
function setVal(id: string, v: string) { const el = $opt(id) as HTMLInputElement | null; if (el) el.value = v; }

/** Wire up the Header modal's buttons/tabs (called once from init). */
function initSpsHeaders() {
  $opt('spsHeadersBtn')?.addEventListener('click', openSpsHeaders);
  $opt('spsHeadersClose')?.addEventListener('click', closeSpsHeaders);
  $opt('spsHeadersBack')?.addEventListener('click', (e) => { if (e.target === $opt('spsHeadersBack')) closeSpsHeaders(); });
  $opt('spsHdrTabView')?.addEventListener('click', () => spsHdrTab('view'));
  $opt('spsHdrTabCrs')?.addEventListener('click', () => spsHdrTab('crs'));
  $opt('spsHdrTabAdmin')?.addEventListener('click', () => spsHdrTab('admin'));
  $opt('spsHdrTabRaw')?.addEventListener('click', () => spsHdrTab('raw'));
  $opt('spsHdrStampCrs')?.addEventListener('click', spsHdrStampCrs);
  $opt('spsHdrAddBtn')?.addEventListener('click', spsHdrAddRaw);
  $opt('spsHdrApplyBtn')?.addEventListener('click', () => void applySpsHeaders());
  $opt('spsHdrExportBtn')?.addEventListener('click', () => void exportSpsCorrected());
  $opt('spsHdrScope')?.addEventListener('change', () => { /* scope changes only affect the next Apply; no repaint needed */ });
}

// -- SPS Re-create / Renumber modal (#spsRenumberBack) --
// Enable/disable the toolbar button - gated identically to the point exports.
function setSpsRenumberEnabled(on: boolean) {
  const btn = $opt('spsRenumberBtn') as HTMLButtonElement | null;
  if (btn) btn.disabled = !on;
}
function spsRenumberOpen(): boolean { return !!$opt('spsRenumberBack')?.classList.contains('open'); }
function closeSpsRenumber() { $opt('spsRenumberBack')?.classList.remove('open'); }

// The element ids for one renumber category, keyed by side ('src' | 'rcv').
function renumIds(side: 'src' | 'rcv') {
  const S = side === 'src' ? 'Src' : 'Rcv';
  return {
    on: `spsRenum${S}On`, grp: `spsRenum${S}Grp`, mode: `spsRenum${S}Mode`,
    seq: `spsRenum${S}Seq`, aff: `spsRenum${S}Aff`, prev: `spsRenum${S}Prev`,
    lineStart: `spsRenum${S}LineStart`, lineInc: `spsRenum${S}LineInc`,
    ptStart: `spsRenum${S}PtStart`, ptInc: `spsRenum${S}PtInc`,
    ptScale: `spsRenum${S}PtScale`, ptOffset: `spsRenum${S}PtOffset`,
  };
}

/** Trim trailing zeros from a finite number for compact preview text (NaN ⇒ '?'). */
function renumFmt(n: number): string { return isFinite(n) ? String(+n.toFixed(4)) : '?'; }

/** Which point-numbering mode a category is in ('seq' default, 'aff' = affine). */
function renumMode(side: 'src' | 'rcv'): 'seq' | 'aff' {
  const aff = $opt(renumIds(side).mode)?.querySelector('[data-mode="aff"]');
  return aff?.classList.contains('on') ? 'aff' : 'seq';
}

/** Switch a category's point-numbering mode: toggle the segment + show/hide the
 *  matching field span, then refresh the preview. */
function setRenumMode(side: 'src' | 'rcv', mode: 'seq' | 'aff') {
  const ids = renumIds(side);
  $opt(ids.mode)?.querySelectorAll('.segbtn').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.mode === mode));
  $opt(ids.seq)?.classList.toggle('hidden', mode !== 'seq');
  $opt(ids.aff)?.classList.toggle('hidden', mode !== 'aff');
  updateRenumberPreview();
}

/** Grey out + disable a category's inputs when its "on" checkbox is cleared. */
function setRenumGroupDisabled(side: 'src' | 'rcv', disabled: boolean) {
  const ids = renumIds(side);
  for (const id of [ids.lineStart, ids.lineInc, ids.ptStart, ids.ptInc, ids.ptScale, ids.ptOffset]) {
    const el = $opt(id) as HTMLInputElement | null;
    if (el) el.disabled = disabled;
  }
  $opt(ids.mode)?.querySelectorAll('button').forEach((b) => { (b as HTMLButtonElement).disabled = disabled; });
}

/** Distinct numeric line numbers in the loaded geometry for a side, sorted asc. */
function renumLineNumbers(side: 'src' | 'rcv'): number[] {
  if (!spsGeom) return [];
  const out: number[] = [];
  for (const nm of spsGeom[side === 'src' ? 'src' : 'rcv'].names) {
    const v = parseFloat(nm);
    if (isFinite(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Min/max point number in the loaded geometry for a side (null if none/finite). */
function renumPointRange(side: 'src' | 'rcv'): { min: number; max: number } | null {
  if (!spsGeom) return null;
  const pts = spsGeom[side === 'src' ? 'src' : 'rcv'].pt;
  if (!pts || pts.length === 0) return null;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i];
    if (isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
  }
  return isFinite(mn) && isFinite(mx) ? { min: mn, max: mx } : null;
}

/** Build the human preview string for one category from the loaded data + the
 *  current field values (every numeric NaN-guarded via numVal). */
function buildRenumPreview(side: 'src' | 'rcv', label: string): string {
  const ids = renumIds(side);
  // Line resequencing: sorted originals → lineStart, +lineInc, …
  const lines = renumLineNumbers(side);
  let lineTxt: string;
  if (lines.length) {
    const ls = numVal(ids.lineStart), li = numVal(ids.lineInc);
    const n = Math.min(3, lines.length);
    const origs = lines.slice(0, n).map(renumFmt);
    const news: string[] = [];
    for (let i = 0; i < n; i++) news.push(renumFmt(ls + i * li));
    const ell = lines.length > n ? ', …' : '';
    lineTxt = `${label} lines ${origs.join(', ')}${ell} → ${news.join(', ')}${ell}`;
  } else {
    lineTxt = `${label} lines: none in loaded data`;
  }
  // Points: affine (old·scale+offset) vs sequential (start, +inc, … per line).
  const rng = renumPointRange(side);
  let ptTxt = '';
  if (rng) {
    if (renumMode(side) === 'aff') {
      const sc = numVal(ids.ptScale), off = numVal(ids.ptOffset);
      ptTxt = `points ${renumFmt(rng.min)}…${renumFmt(rng.max)} → ${renumFmt(rng.min * sc + off)}…${renumFmt(rng.max * sc + off)}`;
    } else {
      const ps = numVal(ids.ptStart), pi = numVal(ids.ptInc);
      ptTxt = `points ${renumFmt(rng.min)}…${renumFmt(rng.max)} → ${renumFmt(ps)}, ${renumFmt(ps + pi)}, ${renumFmt(ps + 2 * pi)}, … (per line)`;
    }
  }
  return lineTxt + (ptTxt ? '   ·   ' + ptTxt : '');
}

/** Recompute both category previews + the on/off greying. Called on every input. */
function updateRenumberPreview() {
  for (const [side, label] of [['src', 'Source'], ['rcv', 'Receiver']] as const) {
    const ids = renumIds(side);
    const on = ($opt(ids.on) as HTMLInputElement | null)?.checked ?? false;
    $opt(ids.grp)?.classList.toggle('off', !on);
    setRenumGroupDisabled(side, !on);
    setText(ids.prev, on ? buildRenumPreview(side, label) : `${label}s unchanged.`);
  }
}

/** Read a category's fields into an SpsLineRenumber spec (NaN-guarded). Only the
 *  active point mode's fields are sent so the worker picks the right transform. */
function buildRenumSpec(side: 'src' | 'rcv'): SpsLineRenumber {
  const ids = renumIds(side);
  const spec: SpsLineRenumber = { lineStart: numVal(ids.lineStart), lineInc: numVal(ids.lineInc) };
  if (renumMode(side) === 'aff') {
    spec.pointScale = numVal(ids.ptScale);
    spec.pointOffset = numVal(ids.ptOffset);
  } else {
    spec.pointStart = numVal(ids.ptStart);
    spec.pointInc = numVal(ids.ptInc);
  }
  return spec;
}

/** Open the modal - guard on a loaded survey, ensure geometry for the live
 *  preview, reset status, then paint the preview before showing. */
async function openSpsRenumber() {
  if (!spsSummary) { $('spsLabel').textContent = 'Load SPS files first.'; return; }
  // The preview reads spsGeom; fetch it once if a freshly-loaded survey hasn't yet.
  if (!spsGeom) { try { await refreshSps(); } catch { /* preview falls back to ranges it has */ } }
  setText('spsRenumStatus', '');
  $opt('spsRenumStatus')?.classList.remove('err');
  updateRenumberPreview();
  $opt('spsRenumberBack')?.classList.add('open');
}

/** Apply: build the spec from the enabled categories, call the worker, then
 *  refresh the SPS plot/stats from the returned summary and toast the result. */
async function applySpsRenumber() {
  if (!spsSummary) { closeSpsRenumber(); return; }
  const spec: { source?: SpsLineRenumber; receiver?: SpsLineRenumber } = {};
  if (($opt(renumIds('src').on) as HTMLInputElement | null)?.checked) spec.source = buildRenumSpec('src');
  if (($opt(renumIds('rcv').on) as HTMLInputElement | null)?.checked) spec.receiver = buildRenumSpec('rcv');
  if (!spec.source && !spec.receiver) {
    setText('spsRenumStatus', 'Enable Sources and/or Receivers to renumber.');
    $opt('spsRenumStatus')?.classList.add('err');
    return;
  }
  const applyBtn = $opt('spsRenumberApply') as HTMLButtonElement | null;
  if (applyBtn) applyBtn.disabled = true;
  setText('spsRenumStatus', 'Renumbering…');
  $opt('spsRenumStatus')?.classList.remove('err');
  try {
    const r = await api.spsRenumber({ spec });
    if (!r.ok) {
      setText('spsRenumStatus', 'Failed: ' + (r.error || 'unknown'));
      $opt('spsRenumStatus')?.classList.add('err');
      return;
    }
    // The worker now holds the renumbered survey - refresh exactly like loadSPS:
    // adopt the new summary, drop the renderer caches, and re-plot from geometry.
    if (r.summary) {
      spsSummary = r.summary;
      spsGeom = null; spsSpider = null; spsFold = null; spsFoldBin = 0;
      gridView.init = false; gridHighlight = null;
      invalidateSpsSourceCache();
      clearInspector();
      $('spsLabel').textContent = spsLabel(spsSummary);
      updateSpsStats();
      renderSummaryPanel();
      updateStatusStrip();
      await refreshSps();
    }
    closeSpsRenumber();
    if (r.savedPath) { infoToast('Saved ' + r.savedPath); audit('export', 'SPS renumber → ' + r.savedPath, 'sps'); }
    else if (r.canceled) infoToast('Renumbered (not exported)');
    else infoToast('Survey renumbered');
  } catch (e) {
    setText('spsRenumStatus', 'Failed: ' + errMsg(e));
    $opt('spsRenumStatus')?.classList.add('err');
  } finally {
    if (applyBtn) applyBtn.disabled = false;
  }
}

/** Wire up the Renumber modal (called once from init). */
function initSpsRenumber() {
  $opt('spsRenumberBtn')?.addEventListener('click', () => void openSpsRenumber());
  $opt('spsRenumberClose')?.addEventListener('click', closeSpsRenumber);
  $opt('spsRenumberCancel')?.addEventListener('click', closeSpsRenumber);
  $opt('spsRenumberBack')?.addEventListener('click', (e) => { if (e.target === $opt('spsRenumberBack')) closeSpsRenumber(); });
  $opt('spsRenumberApply')?.addEventListener('click', () => void applySpsRenumber());
  for (const side of ['src', 'rcv'] as const) {
    const ids = renumIds(side);
    $opt(ids.on)?.addEventListener('change', updateRenumberPreview);
    $opt(ids.mode)?.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setRenumMode(side, (b as HTMLElement).dataset.mode === 'aff' ? 'aff' : 'seq')));
    for (const id of [ids.lineStart, ids.lineInc, ids.ptStart, ids.ptInc, ids.ptScale, ids.ptOffset]) {
      $opt(id)?.addEventListener('input', updateRenumberPreview);
    }
  }
}

// -- SPS Creation (Feature B): draw lines on a basemap → generate a survey --
// This tab owns its OWN Leaflet map (createMap), kept entirely separate from the
// SPS tab's leafletMap so the two never fight over state. The user clicks to drop
// vertices onto the CURRENT acquisition line; "Next line" finalises it and opens a
// fresh one (new colour). On Generate the picked WGS84 vertices are sent to the
// worker's spsCreate generator, which forward-projects them into the chosen CRS,
// lays out sources/receivers, and (on success) becomes the loaded survey.

/** Loose CRS spec chosen for the generated survey (mirrors SPSCrsEdit). */
type CreateCrs = {
  datum?: string; projType?: string; zone?: number; hemi?: 'N' | 'S'; units?: string;
  centralMeridian?: number; latOrigin?: number; falseEasting?: number;
  falseNorthing?: number; scaleFactor?: number;
};
/**
 * One point of the survey plan.
 *
 * WGS84 is the canonical frame (the map is WGS84 and the CRS can still change),
 * but a point IMPORTED from a projected file also keeps its ORIGINAL easting /
 * northing so Generate can hand the writer the exact numbers the file arrived with
 * instead of a lat/long round-trip. Moving the point clears them.
 */
interface PlanPoint {
  /** WGS84 latitude; always finite, |lat| <= 90. */
  lat: number;
  /** WGS84 longitude; always finite, |lon| <= 180. */
  lon: number;
  /** Preplot station number. null = un-numbered (a hand-clicked bend point). */
  station: number | null;
  /** Elevation in metres, or null when unknown (the generator writes 0). */
  elev: number | null;
  /** Original projected coordinates, present only on an imported projected point. */
  srcE?: number;
  srcN?: number;
  /** createCrsKey() of the CRS srcE/srcN are expressed in. */
  srcCrsKey?: string;
}

/**
 * One acquisition line of the plan.
 *
 * `kind:'resample'` - the points are POLYLINE VERTICES and the generator walks them
 *   at rcvInterval / srcInterval. This is what a hand-clicked line is.
 * `kind:'preplot'`  - the points ARE the stations: placed verbatim, numbers
 *   honoured. This is what an imported line is, because it carries numbers.
 */
interface PlanLine {
  /** Stable id, never reused. Selection, undo and the legend all key on it. */
  id: number;
  /** SPS line name. */
  name: string;
  kind: 'resample' | 'preplot';
  /** What the stations become. Ignored for 'resample', which lays both. */
  role: 'R' | 'S' | 'SR';
  points: PlanPoint[];
  color: string;
  visible: boolean;
}

/** A selected point: which line, and which index within it. */
interface PlanSel { lineId: number; idx: number }

// Renderer mirror of core's CREATE_DEFAULTS (the worker re-applies the same
// fallbacks for any omitted scalar; this just pre-fills the wizard).
const CREATE_DEFAULTS_UI = {
  rcvInterval: 25, srcInterval: 25,
  rcvLineStart: 1000, rcvLineInc: 2, rcvPointStart: 1000, rcvPointInc: 2,
  srcLineStart: 1000, srcLineInc: 2, srcPointStart: 1000, srcPointInc: 2,
};
const CREATE_LINE_COLORS = ['#34dbd0', '#ffb454', '#7aa2ff', '#ff6e9c', '#9be564', '#c792ea', '#f78c6c', '#56d4ff'];

let createMap: L.Map | null = null;
let createLines: PlanLine[] = [];
let createCrs: CreateCrs = {};
let createCrsAuto = true;   // true ⇒ CRS still follows the location auto-suggest
let createMode: '2D' | '3D' = '2D';   // 2D walks each line; 3D = picks are receiver lines
let crsSearchTimer: number | null = null;   // debounce for the EPSG picker
// Live "measuring tape" from the current line's last vertex to the cursor - one
// reused layer (never created/removed per mousemove); cleared on mouseout / line
// boundaries. Pairs with the distance read-out so the user gauges line length.
let createRubberband: L.Polyline | null = null;

/** Currently selected point (drawn with a ring, highlighted in the table). */
let planSel: PlanSel | null = null;
/** Monotonic line-id source; ids are never reused, so undo/selection stay valid. */
let planNextLineId = 1;
/** Pointer behaviour over the map. */
let planMode: 'view' | 'drag' | 'add' = 'view';
/** Which line 'add' mode appends to; null = start a new line. */
let planTargetLineId: number | null = null;
/** Which pane of the "Survey plan" card is showing. */
let planPane: 'points' | 'checks' | 'lines' = 'points';
/** Per-layer visibility + opacity, read by drawPlan(). Changing a slider is O(1). */
const planLayers = {
  lines: { on: true, op: 0.9 },
  arrows: { on: true, op: 1 },
  labels: { on: true, op: 1 },
  stations: { on: true, op: 1 },
};

// -- draw budgets ------------------------------------------------------------
// A canvas arc is roughly two orders of magnitude cheaper than a Leaflet
// CircleMarker (a JS object + a hit-test entry + a popup binding), so the dot cap
// is higher than the SPS map's MAX_MARKERS - but it is still a hard cap.
const PLAN_MAX_DOTS = 20000;
const PLAN_MAX_ARROWS = 4000;
const PLAN_MAX_LABELS = 2000;
/** Segment must be at least this long on screen before an arrow is worth drawing. */
const PLAN_ARROW_MIN_PX = 24;
/** ...and this long before a distance label fits inside it. */
const PLAN_LABEL_MIN_PX = 34;
/** Median on-screen station spacing below which numbers stop being legible. */
const PLAN_NUMBER_MIN_PX = 22;
/** Above this many points the table is not rendered at all (see planRenderTable). */
const PLAN_TABLE_MAX = 200_000;
/** Fixed table row height, in CSS pixels. Must match .plan-row in index.html. */
const PLAN_ROW_H = 26;
/** Click tolerance when picking a station on the map, in CSS pixels. */
const PLAN_HIT_PX = 14;

/** Per-point derived metrics for ONE line, index-aligned with line.points.
 *  A non-finite distance is stored as null and NEVER reaches a canvas. */
interface PlanDerived {
  seg: (number | null)[];   // metres from the previous point (index 0 = null)
  cum: (number | null)[];   // metres from the line start
  az: (number | null)[];    // degrees clockwise from N, from the previous point
  lengthM: number;
  medianSegM: number;
}
/** Invalidate-on-mutation cache, keyed by line id. Never stored, never persisted -
 *  recomputing this per frame (as a naive port would) is what fails to scale. */
let planDerive: Map<number, PlanDerived> | null = null;
/** Cached plan-check result; recomputed lazily alongside planDerive. */
let planChecks: PlanCheckResult | null = null;
/** Drop every derived value. Call after ANY mutation and on a CRS change. */
function planInvalidate() { planDerive = null; planChecks = null; }

/** Lazily build the Create tab's own Leaflet map. Tile layers mirror ensureMap();
 *  a mousemove drives the coord read-out and a click drops a line vertex. */
function ensureCreateMap() {
  if (createMap) return;
  const dark = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 24, maxNativeZoom: 16, attribution: 'Esri Dark Gray Canvas — Esri, HERE, Garmin, © OpenStreetMap contributors' });
  const light = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 24, maxNativeZoom: 16, attribution: 'Esri Light Gray Canvas — Esri, HERE, Garmin, © OpenStreetMap contributors' });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 24, maxNativeZoom: 21, attribution: 'Esri World Imagery' });
  const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 24, maxNativeZoom: 19, attribution: '© OpenStreetMap' });
  // No rotation on this tab; suppress the leaflet-rotate plugin's default control.
  // Satellite by default - same reasoning as ensureMap(): it is the only layer
  // sharp at the z18-20 a survey is actually drawn at.
  createMap = L.map('spsCreateMap', { layers: [sat], preferCanvas: true, maxZoom: 24, zoomSnap: 0.5, rotateControl: false });
  L.control.layers({ Satellite: sat, Streets: streets, 'Light (regional)': light, 'Dark (regional)': dark }).addTo(createMap);
  // Metric distance scale (bottom-left). ensureCreateMap is guarded, so added once.
  L.control.scale({ metric: true, imperial: false, maxWidth: 140, position: 'bottomleft' }).addTo(createMap);
  createMap.setView([32, 35], 6);
  createMap.on('mousemove', (e: L.LeafletMouseEvent) => updateCreateCoords(e.latlng.lat, e.latlng.lng));
  createMap.on('click', (e: L.LeafletMouseEvent) => onPlanMapClick(e));
  createMap.on('mousedown', (e: L.LeafletMouseEvent) => planDragStart(e));
  // Cursor left the map → drop the measuring band and reset the read-out.
  createMap.on('mouseout', () => {
    clearCreateRubberband();
    setText('spsCreateCoords', 'Move the cursor over the map to read coordinates.');
  });
  // The overlay canvas has to follow every view change. The zoom ANIMATION cannot
  // be followed (Leaflet transforms its own panes), so the overlay hides for its
  // duration and repaints once at the end - which reads as a clean snap, not a lag.
  createMap.on('move zoom resize moveend zoomend', () => drawPlan());
  createMap.on('zoomstart', () => $opt('spsPlanCanvas')?.classList.add('zooming'));
  createMap.on('zoomend', () => { $opt('spsPlanCanvas')?.classList.remove('zooming'); drawPlan(); });
  applyPlanZoomSpeed();
  applyPlanTileLayer();
}

/** Remove the live measuring band (single reused layer; safe to call repeatedly). */
function clearCreateRubberband() {
  if (createRubberband && createMap) createMap.removeLayer(createRubberband);
  createRubberband = null;
}

/** Every point across every line, flattened. */
function planTotalPoints(): number {
  let n = 0;
  for (const l of createLines) n += l.points.length;
  return n;
}

/** Lines that carry at least one point. */
function planRealLines(): PlanLine[] {
  return createLines.filter((l) => l.points.length > 0);
}

/** Find a line by id. */
function planLineById(id: number): PlanLine | null {
  return createLines.find((l) => l.id === id) ?? null;
}

/**
 * The ONLY sanctioned way to mutate a line.
 *
 * Installs a fresh line object AND a fresh points array, so undo snapshots - which
 * hold the previous arrays by reference - keep pointing at unchanged data. Any
 * mutator that writes `createLines[i].points.push(...)` directly corrupts the undo
 * history silently, with no symptom until an undo produces garbage.
 */
function planEditLine(lineId: number): PlanLine | null {
  const i = createLines.findIndex((l) => l.id === lineId);
  if (i < 0) return null;
  const fresh: PlanLine = { ...createLines[i], points: createLines[i].points.slice() };
  createLines = createLines.slice();
  createLines[i] = fresh;
  planInvalidate();
  return fresh;
}

/** Replace the whole line list (import, sort, clear). Copy-on-write by construction. */
function planSetLines(next: PlanLine[]) {
  createLines = next;
  planInvalidate();
}

/** Azimuth in degrees clockwise from North, a → b. NaN when either end is bad. */
function planBearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
  if (!isFinite(aLat) || !isFinite(aLon) || !isFinite(bLat) || !isFinite(bLon)) return NaN;
  const r = Math.PI / 180;
  const p1 = aLat * r, p2 = bLat * r, dl = (bLon - aLon) * r;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const deg = (Math.atan2(y, x) / r + 360) % 360;
  return isFinite(deg) ? deg : NaN;
}

/** Median of a numeric list; 0 when empty. Does not mutate the input. */
function planMedian(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Derived metrics for one line, from the cache (building it on first use). */
function planDerivedOf(line: PlanLine): PlanDerived {
  if (!planDerive) planDerive = new Map();
  const hit = planDerive.get(line.id);
  if (hit) return hit;
  const n = line.points.length;
  const seg: (number | null)[] = new Array(n).fill(null);
  const cum: (number | null)[] = new Array(n).fill(null);
  const az: (number | null)[] = new Array(n).fill(null);
  const known: number[] = [];
  let run = 0;
  if (n) cum[0] = 0;
  for (let i = 1; i < n; i++) {
    const a = line.points[i - 1], b = line.points[i];
    const d = createDistM(a.lat, a.lon, b.lat, b.lon);
    if (isFinite(d)) { seg[i] = d; known.push(d); run += d; }
    cum[i] = run;
    const bearing = planBearing(a.lat, a.lon, b.lat, b.lon);
    az[i] = isFinite(bearing) ? bearing : null;
  }
  const out: PlanDerived = { seg, cum, az, lengthM: run, medianSegM: planMedian(known) };
  planDerive.set(line.id, out);
  return out;
}

/** Plan-check result, from the cache. Uses the survey-CRS-aware distance function
 *  so the tolerances are measured in the same metres the generator will use. */
function planChecksOf(): PlanCheckResult {
  if (planChecks) return planChecks;
  planChecks = checkPlan(
    planRealLines().map((l) => ({
      id: l.id, name: l.name, kind: l.kind,
      points: l.points.map((p) => ({ lat: p.lat, lon: p.lon, station: p.station, elev: p.elev })),
    })),
    createDistM,
  );
  return planChecks;
}

/** Metres between two WGS84 points. Prefers the survey CRS (Euclidean E/N) when
 *  BOTH points project; else Leaflet's haversine. NaN if neither path is finite. */
function createDistM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const a = createProjectEN(aLat, aLon);
  const b = createProjectEN(bLat, bLon);
  if (a && b) {
    const d = Math.hypot(b.e - a.e, b.n - a.n);
    if (isFinite(d)) return d;
  }
  if (createMap && isFinite(aLat) && isFinite(aLon) && isFinite(bLat) && isFinite(bLon)) {
    const d = createMap.distance(L.latLng(aLat, aLon), L.latLng(bLat, bLon));
    if (isFinite(d)) return d;
  }
  return NaN;
}

// (A line's running length now comes from the derived-metrics cache -
//  planDerivedOf(line).lengthM - which computes it once per mutation rather than
//  once per read.)

/** Human distance: <100 m → 1 dp (e.g. 0.4 m, 42.7 m); <1 km → 0 dp (840 m);
 *  ≥1 km → 2 dp km (1.04 km). Empty string for any non-finite value (never NaN). */
function fmtCreateDist(m: number): string {
  if (!isFinite(m)) return '';
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (m < 100) return `${m.toFixed(1)} m`;
  return `${m.toFixed(0)} m`;
}

/** Forward-project a WGS84 lat/lon to E/N for the live read-out / picks list ONLY
 *  (the worker re-projects authoritatively on Generate). Handles the two
 *  auto-suggested CRSs (ITM, UTM) plus an explicit TM override; returns null for
 *  anything we can't trivially project client-side (e.g. a Geographic CRS). Every
 *  result is finite-guarded before it is handed to a formatter. */
function createProjectEN(lat: number, lon: number): { e: number; n: number } | null {
  if (!isFinite(lat) || !isFinite(lon)) return null;
  const c = createCrs;
  try {
    if ((c.datum || '').toUpperCase().includes('2039')) {
      const en = latLonToITM(lat, lon);
      return isFinite(en.E) && isFinite(en.N) ? { e: en.E, n: en.N } : null;
    }
    if (c.projType === 'UTM' && c.zone != null && isFinite(c.zone)) {
      const en = latLonToUTM(lat, lon, c.zone, c.hemi === 'S' ? 'S' : 'N');
      return isFinite(en.E) && isFinite(en.N) ? { e: en.E, n: en.N } : null;
    }
    if (c.projType === 'TM' && c.centralMeridian != null && isFinite(c.centralMeridian)) {
      const en = geodeticToTM(lat, lon, {
        a: 6378137, f: 1 / 298.257222101,
        lon0: c.centralMeridian, lat0: c.latOrigin ?? 0, k0: c.scaleFactor ?? 1,
        FE: c.falseEasting ?? 0, FN: c.falseNorthing ?? 0,
      });
      return isFinite(en.E) && isFinite(en.N) ? { e: en.E, n: en.N } : null;
    }
  } catch { return null; }
  return null;
}

/** Live cursor read-out: lat/long always, projected E/N when the CRS supports it,
 *  plus - while a line is being picked - the distance from its last vertex to the
 *  cursor and the running line length (so the user gauges distances as they lay
 *  out the line). A dashed rubber-band visualises that "from last" segment. */
function updateCreateCoords(lat: number, lon: number) {
  const el = $opt('spsCreateCoords');
  if (!el) return;
  if (!isFinite(lat) || !isFinite(lon)) { clearCreateRubberband(); el.textContent = 'Move the cursor over the map to read coordinates.'; return; }
  let txt = `Lat ${lat.toFixed(6)}°   Lon ${lon.toFixed(6)}°`;
  const en = createProjectEN(lat, lon);
  if (en) txt += `   ·   E ${en.e.toFixed(2)} m   N ${en.n.toFixed(2)} m`;
  else if (planTotalPoints() === 0) txt += '   ·   (pick a point to set the CRS)';
  // The measuring band only makes sense while a line is actively being extended by
  // clicking; in view/drag mode it would just chase the cursor across the survey.
  const active = planMode === 'add' ? planAddTargetLine(false) : null;
  if (active && active.points.length) {
    const last = active.points[active.points.length - 1];
    const fromLast = fmtCreateDist(createDistM(last.lat, last.lon, lat, lon));
    if (fromLast) txt += `   ·   ↦ from last ${fromLast}`;
    // Cumulative length of the already-placed segments (only once one exists).
    if (active.points.length >= 2) {
      const lineLen = fmtCreateDist(planDerivedOf(active).lengthM);
      if (lineLen) txt += `   ·   line ${lineLen}`;
    }
    // Reuse the single dashed band; recreate it (in the current line colour) only
    // when missing - never per mousemove.
    if (createMap) {
      const pts: L.LatLngExpression[] = [[last.lat, last.lon], [lat, lon]];
      if (createRubberband) createRubberband.setLatLngs(pts);
      else createRubberband = L.polyline(pts, { color: active.color, weight: 1.5, opacity: 0.7, dashArray: '4 4', interactive: false }).addTo(createMap);
    }
  } else {
    clearCreateRubberband();
  }
  el.textContent = txt;
}

/** Auto-suggest a CRS from a location: ITM (EPSG:2039) inside Israel, otherwise
 *  the UTM zone for the longitude (hemisphere from the latitude). */
function createSuggestCrs(lat: number, lon: number): CreateCrs {
  if (lon >= 34 && lon <= 36 && lat >= 29.5 && lat <= 33.5) return { datum: 'EPSG:2039', projType: 'TM' };
  const zone = Math.floor((lon + 180) / 6) + 1;
  return { projType: 'UTM', zone, hemi: lat >= 0 ? 'N' : 'S' };
}
/** Short human label for the toolbar CRS chip. */
function createCrsLabel(c: CreateCrs): string {
  if ((c.datum || '').toUpperCase().includes('2039')) return 'ITM (EPSG:2039)';
  if (c.projType === 'UTM' && c.zone != null) return `UTM ${c.zone}${c.hemi === 'S' ? 'S' : 'N'}`;
  if (c.datum) return c.datum;
  if (c.projType) return c.projType;
  return '-';
}
function updateCreateCrsBtn() { setText('spsCreateCrsBtn', 'CRS: ' + createCrsLabel(createCrs)); }
/** A stable identity for the current CRS. An imported point's original E/N is only
 *  reused when its CRS key still matches this, so changing the CRS silently falls
 *  back to re-projecting rather than writing coordinates from the wrong grid. */
function createCrsKey(c: CreateCrs): string {
  return JSON.stringify([c.datum ?? '', c.projType ?? '', c.zone ?? '', c.hemi ?? '', c.centralMeridian ?? '', c.latOrigin ?? '', c.falseEasting ?? '', c.falseNorthing ?? '', c.scaleFactor ?? '']);
}

/** Append a new, empty line and return it. */
function startNewCreateLine(opts?: { name?: string; kind?: 'resample' | 'preplot'; role?: 'R' | 'S' | 'SR' }): PlanLine {
  const id = planNextLineId++;
  const line: PlanLine = {
    id,
    name: (opts?.name ?? '').trim() || String(id),
    kind: opts?.kind ?? 'resample',
    role: opts?.role ?? 'R',
    points: [],
    color: CREATE_LINE_COLORS[(id - 1) % CREATE_LINE_COLORS.length],
    visible: true,
  };
  createLines = [...createLines, line];
  planInvalidate();
  return line;
}

/** The line an 'add on click' goes onto: the chosen target, else the last line,
 *  creating one when `make` and nothing suitable exists. */
function planAddTargetLine(make: boolean): PlanLine | null {
  if (planTargetLineId != null) {
    const hit = planLineById(planTargetLineId);
    if (hit) return hit;
  }
  const last = createLines[createLines.length - 1];
  if (last) return last;
  return make ? startNewCreateLine() : null;
}

/** Add a point to a line (guards finite + geographic range). */
function addCreateVertex(lat: number, lon: number) {
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  ensureCreateMap();
  const firstEver = planTotalPoints() === 0;
  planPushUndo('add point');
  const target = planAddTargetLine(true)!;
  const line = planEditLine(target.id)!;
  // A hand-clicked point on a resample line is a bend, not a station, so it stays
  // un-numbered. On a preplot line it has to have a number, so it continues the
  // line's own sequence.
  const station = line.kind === 'preplot'
    ? (line.points.reduce((m, p) => Math.max(m, p.station ?? 0), 0) || 0) + 1
    : null;
  line.points.push({ lat: +lat.toFixed(7), lon: +lon.toFixed(7), station, elev: null });
  planSel = { lineId: line.id, idx: line.points.length - 1 };
  // First point ever → suggest a CRS from the location (unless the user overrode it).
  if (firstEver && createCrsAuto) { createCrs = createSuggestCrs(lat, lon); updateCreateCrsBtn(); }
  planRepaintAll();
  updateCreateCoords(lat, lon);
  setText('spsCreateLabel', `Line ${line.name} · ${line.points.length} point${line.points.length === 1 ? '' : 's'}`);
}

/** Finalise the current line (≥2 points) and start a fresh one. */
function createNextLine() {
  const cur = createLines[createLines.length - 1];
  if (!cur || cur.points.length < 2) { setText('spsCreateLabel', 'Finish the current line first (need ≥2 points).'); return; }
  planPushUndo('new line');
  const line = startNewCreateLine();
  planTargetLineId = line.id;
  clearCreateRubberband();   // a finished line shouldn't trail a band into the next
  planRepaintAll();
  setText('spsCreateLabel', `Started line ${line.name} - click to add points`);
}

/** Wipe the plan (and reset the CRS to auto-suggest). */
function createClear() {
  if (planTotalPoints()) {
    snapshotBackup('sps-plan', { lines: createLines, crs: createCrs, mode: createMode }, planBackupLabel());
    planPushUndo('clear plan');
  }
  clearCreateRubberband();
  planSetLines([]);
  planSel = null;
  planTargetLineId = null;
  planDraftPending = 0;   // nothing left to announce
  createCrs = {};
  createCrsAuto = true;
  updateCreateCrsBtn();
  planRepaintAll();
  updateHeaderClear();
  setText('spsCreateLabel', 'Click the map to pick line vertices');
  undoToast('Cleared the survey plan', planUndo);
}

// -- undo ---------------------------------------------------------------------
// Copy-on-write ARRAY snapshots, not JSON.stringify: a stringified 50k-point plan
// is roughly 4 MB, and fifty of them is 200 MB. Snapshotting the array costs only
// the lines that actually changed - which is sound ONLY because every mutation
// goes through planEditLine() / planSetLines().

interface PlanSnapshot { lines: PlanLine[]; sel: PlanSel | null; label: string; pts: number }
const PLAN_UNDO_DEPTH = 50;
/** Points retained across the whole stack, summed. Bounds worst-case memory. */
const PLAN_UNDO_MAX_POINTS = 2_000_000;
let planUndoStack: PlanSnapshot[] = [];

/** Push the CURRENT state, before a mutation. Call once per user-visible action. */
function planPushUndo(label: string) {
  const pts = planTotalPoints();
  planUndoStack.push({ lines: createLines, sel: planSel, label, pts });
  while (planUndoStack.length > PLAN_UNDO_DEPTH) planUndoStack.shift();
  let sum = 0;
  for (const s of planUndoStack) sum += s.pts;
  while (planUndoStack.length > 1 && sum > PLAN_UNDO_MAX_POINTS) sum -= planUndoStack.shift()!.pts;
}

function planUndo() {
  const s = planUndoStack.pop();
  if (!s) { setText('spsCreateLabel', 'Nothing to undo'); return; }
  createLines = s.lines;
  planSel = s.sel;
  planInvalidate();
  clearCreateRubberband();
  planRepaintAll();
  updateHeaderClear();
  setText('spsCreateLabel', `Undid: ${s.label}`);
}

/** Human label for a plan backup snapshot. */
function planBackupLabel(): string {
  const n = planRealLines().length;
  const p = planTotalPoints();
  return `Survey plan (${n} line${n === 1 ? '' : 's'}, ${p} point${p === 1 ? '' : 's'})`;
}

// -- the overlay canvas -------------------------------------------------------
// One canvas we own, stacked over Leaflet. Everything about the plan is painted
// here: Leaflet cannot rotate text at all (so no segment labels, no arrows), and
// per-marker setStyle would make every opacity-slider drag O(N).

/** Screen-space hit grid, rebuilt as a side effect of each draw. Keyed by a 32 px
 *  cell, so a pick is a 3x3 cell scan and panning needs no rebuild. */
let planHitGrid: Map<string, { lineId: number; idx: number; x: number; y: number }[]> = new Map();
let planDrawQueued = false;

/** Queue a repaint of the overlay. rAF-coalesced, so a burst of map events (which
 *  Leaflet fires several of per frame while panning) paints once. */
function drawPlan() {
  if (planDrawQueued) return;
  planDrawQueued = true;
  requestAnimationFrame(() => { planDrawQueued = false; drawPlanNow(); });
}

function drawPlanNow() {
  const cv = $opt('spsPlanCanvas') as HTMLCanvasElement | null;
  if (!cv) return;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!(w > 0) || !(h > 0)) return;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  planHitGrid = new Map();
  const map = createMap;
  if (!map) return;

  // Cull to the viewport (padded so a line does not visibly break at the edge),
  // then stride. Culling FIRST is what makes zooming in restore full detail.
  const bounds = map.getBounds().pad(0.15);
  const lines = planRealLines().filter((l) => l.visible);
  let visibleTotal = 0;
  for (const l of lines) for (const p of l.points) if (bounds.contains([p.lat, p.lon])) visibleTotal++;
  const stride = Math.max(1, Math.ceil(visibleTotal / PLAN_MAX_DOTS));
  let arrowsLeft = PLAN_MAX_ARROWS;
  let labelsLeft = PLAN_MAX_LABELS;

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const line of lines) {
    // Project once per line; every consumer below reads these.
    const scr: ({ x: number; y: number } | null)[] = line.points.map((p) => {
      if (!isFinite(p.lat) || !isFinite(p.lon)) return null;
      const pt = map.latLngToContainerPoint([p.lat, p.lon]);
      return isFinite(pt.x) && isFinite(pt.y) ? { x: pt.x, y: pt.y } : null;
    });
    const der = planDerivedOf(line);

    // -- pass 1: the connection polyline (screen-space simplified) --
    if (planLayers.lines.on && scr.length > 1) {
      ctx.save();
      ctx.globalAlpha = planLayers.lines.op;
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      let lastX = 0, lastY = 0;
      for (let i = 0; i < scr.length; i++) {
        const s = scr[i];
        if (!s) continue;
        if (!started) { ctx.moveTo(s.x, s.y); started = true; lastX = s.x; lastY = s.y; continue; }
        // Drop a vertex that lands within 1.5 px of the last drawn one - invisible,
        // and at survey densities this is most of them.
        if (i < scr.length - 1 && Math.abs(s.x - lastX) + Math.abs(s.y - lastY) < 1.5) continue;
        ctx.lineTo(s.x, s.y);
        lastX = s.x; lastY = s.y;
      }
      if (started) ctx.stroke();
      ctx.restore();
    }

    // -- passes 2 + 3: direction arrows and segment distance labels --
    if ((planLayers.arrows.on || planLayers.labels.on) && scr.length > 1) {
      for (let i = 1; i < scr.length; i++) {
        const a = scr[i - 1], b = scr[i];
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (!isFinite(len) || len <= 0) continue;
        // Both ends off-screen on the same side → nothing to draw here.
        if ((a.x < -50 && b.x < -50) || (a.y < -50 && b.y < -50) || (a.x > w + 50 && b.x > w + 50) || (a.y > h + 50 && b.y > h + 50)) continue;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const ang = Math.atan2(dy, dx);

        if (planLayers.arrows.on && arrowsLeft > 0 && len > PLAN_ARROW_MIN_PX) {
          arrowsLeft--;
          ctx.save();
          ctx.globalAlpha = planLayers.arrows.op;
          ctx.translate(mx, my);
          ctx.rotate(ang);
          ctx.fillStyle = line.color;
          ctx.beginPath();
          ctx.moveTo(-6, -4); ctx.lineTo(4, 0); ctx.lineTo(-6, 4);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }

        if (planLayers.labels.on && labelsLeft > 0 && len > PLAN_LABEL_MIN_PX) {
          const seg = der.seg[i];
          if (seg == null || !isFinite(seg)) continue;
          labelsLeft--;
          // Flip the text so it is never upside down, whichever way the line runs.
          let deg = (ang * 180) / Math.PI;
          if (deg > 90 || deg < -90) deg += 180;
          ctx.save();
          ctx.globalAlpha = planLayers.labels.op;
          ctx.translate(mx, my);
          ctx.rotate((deg * Math.PI) / 180);
          ctx.font = '700 11px ' + PLAN_LABEL_FONT;
          const txt = fmtCreateDist(seg);
          // Halo first, then the fill - readable over imagery and over streets.
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(255,255,255,0.92)';
          ctx.strokeText(txt, 0, -12);
          ctx.fillStyle = line.color;
          ctx.fillText(txt, 0, -12);
          ctx.restore();
        }
      }
    }

    // -- passes 4 + 5: station dots and their numbers --
    if (planLayers.stations.on) {
      // Median on-screen spacing decides whether numbers are legible at all.
      let spacingPx = Infinity;
      if (scr.length > 1) {
        const gaps: number[] = [];
        for (let i = 1; i < scr.length && gaps.length < 64; i++) {
          const a = scr[i - 1], b = scr[i];
          if (a && b) gaps.push(Math.hypot(b.x - a.x, b.y - a.y));
        }
        spacingPx = gaps.length ? planMedian(gaps) : Infinity;
      }
      const numbers = spacingPx > PLAN_NUMBER_MIN_PX;
      const r = numbers ? 11 : 3.5;
      ctx.save();
      ctx.globalAlpha = planLayers.stations.op;
      ctx.font = '600 10px ' + PLAN_LABEL_FONT;
      for (let i = 0; i < scr.length; i++) {
        const s = scr[i];
        if (!s) continue;
        if (s.x < -20 || s.y < -20 || s.x > w + 20 || s.y > h + 20) continue;
        const isEnd = i === 0 || i === scr.length - 1;
        const isSel = !!planSel && planSel.lineId === line.id && planSel.idx === i;
        // Ends and the selection always draw, whatever the stride.
        if (!isEnd && !isSel && stride > 1 && i % stride !== 0) continue;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fillStyle = line.color;
        ctx.fill();
        if (numbers) { ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
        if (numbers) {
          const label = line.points[i].station;
          if (label != null && isFinite(label)) {
            ctx.fillStyle = '#ffffff';
            ctx.fillText(String(label), s.x, s.y);
          }
        }
        // Bin into the hit grid as we go - the pick structure costs one push.
        const key = ((s.x / 32) | 0) + '|' + ((s.y / 32) | 0);
        const bucket = planHitGrid.get(key);
        const rec = { lineId: line.id, idx: i, x: s.x, y: s.y };
        if (bucket) bucket.push(rec); else planHitGrid.set(key, [rec]);
      }
      ctx.restore();
    }
  }

  // -- pass 6: the selection ring, ignoring every cap --
  if (planSel) {
    const line = planLineById(planSel.lineId);
    const p = line?.points[planSel.idx];
    if (line && p && isFinite(p.lat) && isFinite(p.lon)) {
      const pt = map.latLngToContainerPoint([p.lat, p.lon]);
      if (isFinite(pt.x) && isFinite(pt.y)) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 14, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#F2A623';
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}
/** Font stack for canvas text; mirrors --sans without reading the stylesheet. */
const PLAN_LABEL_FONT = "'Inter','Segoe UI Variable','Segoe UI',system-ui,sans-serif";

/** Nearest drawn station within PLAN_HIT_PX of a container point, or null.
 *  Scans the 3x3 neighbourhood of the hit grid built during the last draw. */
function pickPlanPoint(px: number, py: number): PlanSel | null {
  if (!isFinite(px) || !isFinite(py)) return null;
  const cx = (px / 32) | 0, cy = (py / 32) | 0;
  let best: PlanSel | null = null;
  let bestD = PLAN_HIT_PX * PLAN_HIT_PX;
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const bucket = planHitGrid.get(gx + '|' + gy);
      if (!bucket) continue;
      for (const r of bucket) {
        const dx = r.x - px, dy = r.y - py;
        const d = dx * dx + dy * dy;
        if (d <= bestD) { bestD = d; best = { lineId: r.lineId, idx: r.idx }; }
      }
    }
  }
  return best;
}

// -- map interaction ----------------------------------------------------------

/** Click on the map: pick a station (any mode), else add a point in 'add' mode. */
function onPlanMapClick(e: L.LeafletMouseEvent) {
  const hit = pickPlanPoint(e.containerPoint.x, e.containerPoint.y);
  if (hit) { planSelect(hit, { fromMap: true }); showPlanPointPopup(hit); return; }
  if (planMode === 'add') addCreateVertex(e.latlng.lat, e.latlng.lng);
  else if (planSel) { planSel = null; drawPlan(); planRenderTable(); }
}

/** Select a point, redraw the ring, and keep the table in step. */
function planSelect(sel: PlanSel | null, opts?: { fromMap?: boolean }) {
  planSel = sel;
  drawPlan();
  planRenderTable();
  if (sel && opts?.fromMap) planScrollToRow(sel);
}

/** In-app popup for a station: identity, both coordinate frames, and the metrics
 *  the standalone editor showed, plus the projected E/N it could not. Built as DOM
 *  nodes - a line name comes from a file and must never be interpolated into HTML. */
function showPlanPointPopup(sel: PlanSel) {
  const line = planLineById(sel.lineId);
  const p = line?.points[sel.idx];
  if (!line || !p || !createMap) return;
  const der = planDerivedOf(line);
  const box = document.createElement('div');
  const row = (k: string, v: string) => {
    if (!v) return;
    const d = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = k + ' ';
    d.appendChild(b);
    d.appendChild(document.createTextNode(v));
    box.appendChild(d);
  };
  const head = document.createElement('div');
  const strong = document.createElement('b');
  strong.textContent = `Line ${line.name} · ${p.station == null ? `point ${sel.idx + 1}` : `station ${p.station}`}`;
  head.appendChild(strong);
  box.appendChild(head);
  row('Lat/Long', `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`);
  const en = p.srcE != null && p.srcN != null && p.srcCrsKey === createCrsKey(createCrs)
    ? { e: p.srcE, n: p.srcN }
    : createProjectEN(p.lat, p.lon);
  if (en) row('E/N', `${en.e.toFixed(2)}, ${en.n.toFixed(2)}`);
  if (p.elev != null && isFinite(p.elev)) row('Elevation', `${p.elev.toFixed(2)} m`);
  const cum = der.cum[sel.idx];
  if (cum != null && isFinite(cum)) row('From line start', fmtCreateDist(cum));
  const seg = der.seg[sel.idx];
  if (seg != null && isFinite(seg)) row('From previous', fmtCreateDist(seg));
  const az = der.az[sel.idx];
  if (az != null && isFinite(az)) row('Azimuth', `${az.toFixed(1)}°`);
  L.popup({ closeButton: true, autoPan: false }).setLatLng([p.lat, p.lon]).setContent(box).openOn(createMap);
}

// -- point drag ---------------------------------------------------------------
// No draggable markers exist in this app and preferCanvas makes a CircleMarker
// non-draggable anyway, so this is a hand-rolled gesture modelled on the GeoTIFF
// area drag - with one hardening change: that one binds mouseup on the MAP only, so
// releasing outside the map can leave map.dragging disabled forever. Five
// independent release paths and an idempotent finish make that impossible here.

let planDragArmed = false;
let planDragTarget: PlanSel | null = null;
let planDragRaf = 0;

function planDragStart(e: L.LeafletMouseEvent) {
  if (planMode !== 'drag' || !createMap) return;
  const hit = pickPlanPoint(e.containerPoint.x, e.containerPoint.y);
  if (!hit) return;                       // no station under the cursor → normal pan
  planPushUndo('move station');
  planDragArmed = true;
  planDragTarget = hit;
  planSel = hit;
  createMap.dragging.disable();
  createMap.on('mousemove', planDragMove);
  createMap.on('mouseup', planDragFinish);
  window.addEventListener('pointerup', planDragFinish);
  window.addEventListener('blur', planDragFinish);
}

function planDragMove(e: L.LeafletMouseEvent) {
  if (!planDragArmed || !planDragTarget) return;
  const lat = e.latlng.lat, lon = e.latlng.lng;
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  const ln = planEditLine(planDragTarget.lineId);
  const p = ln?.points[planDragTarget.idx];
  if (!ln || !p) return;
  // The point moved, so its imported projected coordinates no longer describe it.
  ln.points[planDragTarget.idx] = { ...p, lat: +lat.toFixed(7), lon: +lon.toFixed(7), srcE: undefined, srcN: undefined, srcCrsKey: undefined };
  if (!planDragRaf) planDragRaf = requestAnimationFrame(() => { planDragRaf = 0; drawPlanNow(); });
}

/** IDEMPOTENT. Always re-enables map dragging. Safe to call at any time, from any
 *  of the five release paths (map mouseup, window pointerup, window blur, Escape,
 *  tab switch), which is exactly why it is safe. */
function planDragFinish() {
  if (!planDragArmed) return;
  planDragArmed = false;
  planDragTarget = null;
  createMap?.off('mousemove', planDragMove);
  createMap?.off('mouseup', planDragFinish);
  window.removeEventListener('pointerup', planDragFinish);
  window.removeEventListener('blur', planDragFinish);
  createMap?.dragging.enable();
  planInvalidate();
  planRepaintAll();
}

// -- modes, layers, view ------------------------------------------------------

function setPlanMode(m: 'view' | 'drag' | 'add') {
  planDragFinish();
  planMode = m;
  clearCreateRubberband();
  $opt('plModeView')?.classList.toggle('on', m === 'view');
  $opt('plModeDrag')?.classList.toggle('on', m === 'drag');
  $opt('plModeAdd')?.classList.toggle('on', m === 'add');
  const mapEl = $opt('spsCreateMap');
  mapEl?.classList.toggle('plan-dragmode', m === 'drag');
  mapEl?.classList.toggle('plan-addmode', m === 'add');
  setText('plModeHint',
    m === 'add' ? 'Click the map to add a point to the target line.'
    : m === 'drag' ? 'Drag a station to move it. Release anywhere; the map always stays draggable afterwards.'
    : 'Drag to pan, wheel to zoom, click a station for its details.');
}

/** Wheel sensitivity. Leaflet reads wheelPxPerZoomLevel off map.options on every
 *  wheel event, so assigning it live works without rebuilding the map. */
function applyPlanZoomSpeed() {
  if (!createMap) return;
  const v = ($opt('plZoomSpeed') as HTMLSelectElement | null)?.value || 'normal';
  const px = v === 'slow' ? 120 : v === 'fast' ? 30 : 60;
  (createMap.options as { wheelPxPerZoomLevel?: number }).wheelPxPerZoomLevel = px;
}

/** Basemap visibility + opacity. Leaflet owns the tiles, so this is native. */
function applyPlanTileLayer() {
  if (!createMap) return;
  const on = ($opt('plTilesOn') as HTMLInputElement | null)?.checked !== false;
  const op = Math.max(0, Math.min(1, Number(($opt('plTilesOp') as HTMLInputElement | null)?.value ?? 100) / 100));
  createMap.eachLayer((layer) => {
    const tl = layer as L.TileLayer;
    if (typeof tl.setOpacity === 'function' && (tl as unknown as { _url?: string })._url) tl.setOpacity(on ? op : 0);
  });
}

/** Read the four plan-layer checkbox + slider pairs into planLayers, then repaint. */
function readPlanLayerControls() {
  const pair = (onId: string, opId: string, into: { on: boolean; op: number }) => {
    into.on = ($opt(onId) as HTMLInputElement | null)?.checked !== false;
    const raw = Number(($opt(opId) as HTMLInputElement | null)?.value ?? 100);
    into.op = Math.max(0, Math.min(1, (isFinite(raw) ? raw : 100) / 100));
  };
  pair('plLinesOn', 'plLinesOp', planLayers.lines);
  pair('plArrowsOn', 'plArrowsOp', planLayers.arrows);
  pair('plLabelsOn', 'plLabelsOp', planLayers.labels);
  pair('plStnsOn', 'plStnsOp', planLayers.stations);
  drawPlan();
}

/** Zoom the map to the whole plan (or one line). Guarded on finite + min<max, so a
 *  malformed point can never hand Leaflet a NaN bounds. */
function planFit(onlyLineId?: number) {
  ensureCreateMap();
  const lines = planRealLines().filter((l) => l.visible && (onlyLineId == null || l.id === onlyLineId));
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const l of lines) {
    for (const p of l.points) {
      if (!isFinite(p.lat) || !isFinite(p.lon)) continue;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
  }
  if (!isFinite(minLat) || !isFinite(minLon) || !isFinite(maxLat) || !isFinite(maxLon)) {
    setText('spsCreateLabel', 'Nothing to fit - the plan is empty.');
    return;
  }
  // A single point has zero extent; pad it so fitBounds gets a real box.
  if (maxLat - minLat < 1e-9) { minLat -= 5e-5; maxLat += 5e-5; }
  if (maxLon - minLon < 1e-9) { minLon -= 5e-5; maxLon += 5e-5; }
  // maxZoom 21 matches the satellite layer's maxNativeZoom, so a small engineering
  // line (stations metres apart) fills the map over REAL imagery rather than being
  // stranded at a zoom where the whole survey is a 100 px smudge.
  createMap?.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [24, 24], maxZoom: 21 });
  drawPlan();
}

// -- the plan panels (points table, checks, legend) ---------------------------

/** Repaint everything that reflects plan state. */
function planRepaintAll() {
  drawPlan();
  planRenderTable();
  planRenderChecks();
  planRenderLegend();
  planRenderCount();
  planSyncTargetLineSelect();
  planSaveDraft();
}

function planRenderCount() {
  const lines = planRealLines();
  const pts = planTotalPoints();
  setText('spsPlanCount', `${lines.length} line${lines.length === 1 ? '' : 's'} · ${pts} point${pts === 1 ? '' : 's'}`);
}

/** Keep the "target line" and "line filter" selects in step with the plan. */
function planSyncTargetLineSelect() {
  const tgt = $opt('plTargetLine') as HTMLSelectElement | null;
  if (tgt) {
    const prev = tgt.value;
    tgt.innerHTML = '';
    const mk = (value: string, label: string) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      tgt.appendChild(o);
    };
    for (const l of createLines) mk(String(l.id), `Line ${l.name}`);
    mk('new', 'New line');
    const want = planTargetLineId == null ? 'new' : String(planTargetLineId);
    tgt.value = [...tgt.options].some((o) => o.value === want) ? want : (prev && [...tgt.options].some((o) => o.value === prev) ? prev : 'new');
  }
  const flt = $opt('spsPlanLineFilter') as HTMLSelectElement | null;
  if (flt) {
    const prev = flt.value;
    flt.innerHTML = '';
    const all = document.createElement('option');
    all.value = ''; all.textContent = 'All lines';
    flt.appendChild(all);
    for (const l of planRealLines()) {
      const o = document.createElement('option');
      o.value = String(l.id);
      o.textContent = `Line ${l.name}`;
      flt.appendChild(o);
    }
    if (prev && [...flt.options].some((o) => o.value === prev)) flt.value = prev;
  }
}

/** Which lines the table shows, honouring the line filter. */
function planTableLines(): PlanLine[] {
  const flt = ($opt('spsPlanLineFilter') as HTMLSelectElement | null)?.value || '';
  const lines = planRealLines();
  if (!flt) return lines;
  const id = Number(flt);
  return lines.filter((l) => l.id === id);
}

/** Flattened (line, index) view of the filtered table, for virtualization. */
function planTableRows(): { line: PlanLine; idx: number }[] {
  const out: { line: PlanLine; idx: number }[] = [];
  for (const l of planTableLines()) for (let i = 0; i < l.points.length; i++) out.push({ line: l, idx: i });
  return out;
}

/**
 * Render the visible window of the point table.
 *
 * Virtualized, not row-capped: a cap would hide data and make "delete row 20 000"
 * impossible. The scroll container is never rebuilt - only its inner window - so
 * scroll position is preserved for free, without the save/restore dance a naive
 * full-rebuild needs.
 */
function planRenderTable() {
  const wrap = $opt('spsPlanTblWrap');
  const spacer = $opt('spsPlanTblSpacer');
  const body = $opt('spsPlanTblBody');
  const empty = $opt('spsPlanTblEmpty');
  if (!wrap || !spacer || !body) return;

  const total = planTotalPoints();
  const rows = planTableRows();
  if (empty) empty.style.display = rows.length ? 'none' : 'block';
  setText('spsPlanTblHint', '');

  // A hostile 2M-row import must never be turned into DOM.
  if (total > PLAN_TABLE_MAX) {
    spacer.style.height = '0px';
    body.innerHTML = '';
    setText('spsPlanTblHint', `Table hidden above ${grp(PLAN_TABLE_MAX)} points - use the line filter, the map and the Checks pane.`);
    return;
  }
  spacer.style.height = rows.length * PLAN_ROW_H + 'px';
  if (!rows.length) { body.innerHTML = ''; return; }

  const first = Math.max(0, Math.floor(wrap.scrollTop / PLAN_ROW_H) - 8);
  const count = Math.min(rows.length - first, Math.ceil(wrap.clientHeight / PLAN_ROW_H) + 16);
  body.style.transform = `translateY(${first * PLAN_ROW_H}px)`;
  body.innerHTML = '';

  const numInput = (cls: string, value: string, field: string, lid: number, idx: number, step?: string) => {
    const i = document.createElement('input');
    i.type = 'number';
    i.value = value;
    i.className = cls;
    if (step) i.step = step;
    i.dataset.f = field;
    i.dataset.lid = String(lid);
    i.dataset.pi = String(idx);
    return i;
  };

  for (let r = first; r < first + count; r++) {
    const { line, idx } = rows[r];
    const p = line.points[idx];
    const row = document.createElement('div');
    row.className = 'plan-row' + (planSel && planSel.lineId === line.id && planSel.idx === idx ? ' sel' : '');
    row.dataset.lid = String(line.id);
    row.dataset.pi = String(idx);

    const nameCell = document.createElement('span');
    nameCell.className = 'mono';
    nameCell.style.color = line.color;
    nameCell.style.overflow = 'hidden';
    nameCell.style.textOverflow = 'ellipsis';
    nameCell.textContent = line.name;
    nameCell.title = line.name;
    row.appendChild(nameCell);

    row.appendChild(numInput('', p.station == null ? '' : String(p.station), 'station', line.id, idx, '1'));
    row.appendChild(numInput('', p.lat.toFixed(7), 'lat', line.id, idx, '0.0000001'));
    row.appendChild(numInput('', p.lon.toFixed(7), 'lon', line.id, idx, '0.0000001'));
    row.appendChild(numInput('', p.elev == null ? '' : String(p.elev), 'elev', line.id, idx, '0.01'));

    const acts = document.createElement('span');
    acts.className = 'acts';
    const mk = (action: string, label: string, title: string, danger = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      if (danger) b.className = 'danger';
      b.dataset.a = action;
      b.dataset.lid = String(line.id);
      b.dataset.pi = String(idx);
      acts.appendChild(b);
    };
    mk('up', '↑', 'Move this point earlier on its line');
    mk('down', '↓', 'Move this point later on its line');
    mk('del', '✕', 'Delete this point', true);
    row.appendChild(acts);

    body.appendChild(row);
  }
}

/** Scroll a selected row into the middle of the table window. `scrollIntoView`
 *  fights virtualization (the row may not exist yet), so set scrollTop directly. */
function planScrollToRow(sel: PlanSel) {
  const wrap = $opt('spsPlanTblWrap');
  if (!wrap || planPane !== 'points') return;
  const rows = planTableRows();
  const r = rows.findIndex((x) => x.line.id === sel.lineId && x.idx === sel.idx);
  if (r < 0) return;
  const want = r * PLAN_ROW_H - wrap.clientHeight / 2;
  wrap.scrollTop = Math.max(0, want);
  planRenderTable();
}

/** Apply one edited table cell. Rejects anything non-finite or out of range. */
function planEditCell(lineId: number, idx: number, field: string, raw: string) {
  const line = planLineById(lineId);
  const cur = line?.points[idx];
  if (!line || !cur) return;
  const txt = raw.trim();
  const v = txt === '' ? NaN : parseFloat(txt);

  let next: PlanPoint | null = null;
  if (field === 'lat') {
    if (!isFinite(v) || Math.abs(v) > 90) { planRenderTable(); setText('spsCreateLabel', 'Latitude must be a number between -90 and 90.'); return; }
    next = { ...cur, lat: +v.toFixed(7), srcE: undefined, srcN: undefined, srcCrsKey: undefined };
  } else if (field === 'lon') {
    if (!isFinite(v) || Math.abs(v) > 180) { planRenderTable(); setText('spsCreateLabel', 'Longitude must be a number between -180 and 180.'); return; }
    next = { ...cur, lon: +v.toFixed(7), srcE: undefined, srcN: undefined, srcCrsKey: undefined };
  } else if (field === 'station') {
    next = { ...cur, station: txt === '' ? null : (isFinite(v) ? Math.round(v) : cur.station) };
  } else if (field === 'elev') {
    next = { ...cur, elev: txt === '' ? null : (isFinite(v) ? v : cur.elev) };
  }
  if (!next) return;
  planPushUndo(`edit ${field}`);
  const ln = planEditLine(lineId)!;
  ln.points[idx] = next;
  planSel = { lineId, idx };
  planRepaintAll();
}

/** Move a point within its line, or delete it. Dropping the last point of a line
 *  drops the line, matching what the old single-step undo did. */
function planRowAction(lineId: number, idx: number, action: string) {
  const line = planLineById(lineId);
  if (!line) return;
  if (action === 'del') {
    planPushUndo('delete point');
    const ln = planEditLine(lineId)!;
    ln.points.splice(idx, 1);
    if (!ln.points.length) planSetLines(createLines.filter((l) => l.id !== lineId));
    planSel = null;
    planRepaintAll();
    updateHeaderClear();
    return;
  }
  const ni = action === 'up' ? idx - 1 : idx + 1;
  if (ni < 0 || ni >= line.points.length) return;
  planPushUndo('reorder point');
  const ln = planEditLine(lineId)!;
  const tmp = ln.points[ni];
  ln.points[ni] = ln.points[idx];
  ln.points[idx] = tmp;
  planSel = { lineId, idx: ni };
  planRepaintAll();
}

/** Renumber the filtered line's stations 1..N. SPS numbering is per line, so this
 *  is deliberately NOT global - a global renumber would break multi-line surveys. */
function planRenumber() {
  const targets = planTableLines();
  if (!targets.length) { setText('spsCreateLabel', 'Nothing to renumber.'); return; }
  planPushUndo('renumber');
  for (const t of targets) {
    const ln = planEditLine(t.id)!;
    ln.points = ln.points.map((p, i) => ({ ...p, station: i + 1 }));
  }
  planRepaintAll();
  const what = targets.length === 1 ? `line ${targets[0].name}` : `${targets.length} lines`;
  setText('spsCreateLabel', `Renumbered ${what} 1..N`);
  undoToast(`Renumbered ${what}`, planUndo);
}

/** Sort every line's points by station number (un-numbered points keep their
 *  relative order at the end). Fixes a shuffled import in one click. */
function planSortByStation() {
  if (!planRealLines().length) { setText('spsCreateLabel', 'Nothing to sort.'); return; }
  planPushUndo('sort');
  const next = createLines.map((l) => {
    const idx = l.points.map((p, i) => ({ p, i }));
    idx.sort((a, b) => {
      const sa = a.p.station, sb = b.p.station;
      if (sa == null && sb == null) return a.i - b.i;
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sa - sb || a.i - b.i;
    });
    return { ...l, points: idx.map((x) => x.p) };
  });
  planSetLines(next);
  planSel = null;
  planRepaintAll();
  setText('spsCreateLabel', 'Sorted every line by station number');
  undoToast('Sorted by station', planUndo);
}

/** Render the plan-check findings. Each row selects and flies to its point. */
function planRenderChecks() {
  const host = $opt('spsPlanChecks');
  if (!host) return;
  host.innerHTML = '';
  if (!planRealLines().length) {
    const d = document.createElement('div');
    d.className = 'hdr-empty';
    d.textContent = 'No plan to check yet.';
    host.appendChild(d);
    return;
  }
  const res = planChecksOf();
  if (!res.findings.length) {
    const d = document.createElement('div');
    d.className = 'hdr-empty';
    d.textContent = 'No issues found in this plan.';
    host.appendChild(d);
    return;
  }
  for (const f of res.findings) {
    const row = document.createElement('div');
    row.className = 'fl';
    const pill = document.createElement('span');
    pill.className = 'pill ' + (f.sev === 'error' ? 'red' : f.sev === 'warn' ? 'amber' : 'neutral');
    pill.textContent = f.sev === 'error' ? 'ERROR' : f.sev === 'warn' ? 'WARN' : 'INFO';
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = f.msg;   // never innerHTML - the message carries a line name
    const cat = document.createElement('span');
    cat.className = 'cat';
    cat.textContent = f.cat;
    row.appendChild(pill);
    row.appendChild(msg);
    row.appendChild(cat);
    if (f.lineId != null) {
      row.addEventListener('click', () => {
        const line = planLineById(f.lineId!);
        if (!line) return;
        const idx = f.ptIdx != null && f.ptIdx < line.points.length ? f.ptIdx : 0;
        planSelect({ lineId: line.id, idx });
        const p = line.points[idx];
        if (p && isFinite(p.lat) && isFinite(p.lon)) createMap?.panTo([p.lat, p.lon]);
      });
    }
    host.appendChild(row);
  }
  if (res.truncated) {
    const more = document.createElement('div');
    more.className = 'hdr-empty';
    more.textContent = `...and ${res.omitted} more finding${res.omitted === 1 ? '' : 's'} not shown.`;
    host.appendChild(more);
  }
}

/** Render the per-line legend: colour, name, kind, counts, length, median interval,
 *  a visibility toggle and a zoom-to-line button. */
function planRenderLegend() {
  const host = $opt('spsPlanLegend');
  if (!host) return;
  host.innerHTML = '';
  const lines = planRealLines();
  if (!lines.length) {
    const d = document.createElement('div');
    d.className = 'hdr-empty';
    d.textContent = 'No lines yet - click the map to start one, or use Import plan…';
    host.appendChild(d);
    return;
  }
  let totalLen = 0;
  for (const l of lines) {
    const der = planDerivedOf(l);
    totalLen += der.lengthM;
    const row = document.createElement('div');
    row.className = 'plan-lg';

    const vis = document.createElement('input');
    vis.type = 'checkbox';
    vis.checked = l.visible;
    vis.title = 'Show this line on the map';
    vis.addEventListener('change', () => {
      const ln = planEditLine(l.id);
      if (!ln) return;
      ln.visible = vis.checked;
      drawPlan();
    });
    row.appendChild(vis);

    const nameWrap = document.createElement('span');
    const sw = document.createElement('span');
    sw.className = 'plan-sw';
    sw.style.display = 'inline-block';
    sw.style.background = l.color;
    sw.style.marginRight = '7px';
    nameWrap.appendChild(sw);
    nameWrap.appendChild(document.createTextNode(`Line ${l.name}`));
    const kind = document.createElement('span');
    kind.className = 'pill ' + (l.kind === 'preplot' ? 'teal' : 'neutral');
    kind.style.marginLeft = '7px';
    kind.textContent = l.kind === 'preplot' ? `preplot · ${l.role}` : 'resample';
    kind.title = l.kind === 'preplot'
      ? 'Stations are used exactly as given - positions and numbers are not changed.'
      : 'Points are line vertices; stations are laid along them at the acquisition interval.';
    nameWrap.appendChild(kind);
    row.appendChild(nameWrap);

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${l.points.length} pts · ${fmtCreateDist(der.lengthM) || '-'}` + (der.medianSegM ? ` · ~${fmtCreateDist(der.medianSegM)}` : '');
    meta.title = 'Points · total length · median interval';
    row.appendChild(meta);

    const zoom = document.createElement('button');
    zoom.type = 'button';
    zoom.className = 'btn sm';
    zoom.textContent = 'Zoom';
    zoom.title = 'Fit the map to this line';
    zoom.addEventListener('click', () => planFit(l.id));
    row.appendChild(zoom);

    host.appendChild(row);
  }
  const tot = document.createElement('div');
  tot.className = 'hint';
  tot.style.paddingTop = '8px';
  tot.textContent = `Total: ${lines.length} line${lines.length === 1 ? '' : 's'} · ${planTotalPoints()} points · ${fmtCreateDist(totalLen) || '0 m'}`;
  host.appendChild(tot);
}

/** Show one pane of the "Survey plan" card. */
function planShowPane(p: 'points' | 'checks' | 'lines') {
  planPane = p;
  $opt('spsPlanTabPts')?.classList.toggle('on', p === 'points');
  $opt('spsPlanTabChk')?.classList.toggle('on', p === 'checks');
  $opt('spsPlanTabLeg')?.classList.toggle('on', p === 'lines');
  $opt('spsPlanPanePts')?.classList.toggle('hidden', p !== 'points');
  $opt('spsPlanPaneChk')?.classList.toggle('hidden', p !== 'checks');
  $opt('spsPlanPaneLeg')?.classList.toggle('hidden', p !== 'lines');
  if (p === 'points') planRenderTable();
  else if (p === 'checks') planRenderChecks();
  else planRenderLegend();
}

// -- draft persistence --------------------------------------------------------
// A plan can take real work to lay out; losing it to a restart would be its own
// bug. Debounced, quota-guarded, corruption-tolerant, and skipped above a size that
// would not fit in localStorage anyway.

const PLAN_DRAFT_KEY = 'seisconv.spsplan';
/** Above this many points the draft is not written (5 MB localStorage quota). */
const PLAN_DRAFT_MAX_POINTS = 50_000;
let planDraftTimer: number | null = null;

function planSaveDraft() {
  if (planDraftTimer != null) window.clearTimeout(planDraftTimer);
  planDraftTimer = window.setTimeout(() => {
    planDraftTimer = null;
    try {
      if (planTotalPoints() > PLAN_DRAFT_MAX_POINTS) return;
      if (!createLines.length) { localStorage.removeItem(PLAN_DRAFT_KEY); return; }
      localStorage.setItem(PLAN_DRAFT_KEY, JSON.stringify({ lines: createLines, crs: createCrs, crsAuto: createCrsAuto, mode: createMode }));
    } catch { /* ignore quota / private mode */ }
  }, 1000);
}

/** Points restored from a saved draft that the user has not been told about yet.
 *  0 = nothing pending. Announced the first time the tab is opened, never at app
 *  start (a snackbar for a tab you are not looking at is noise). */
let planDraftPending = 0;

/**
 * Tell the user a plan came back from a saved draft, and offer one click to throw it
 * away. Nothing may ever appear on this map that the user did not put there without
 * the app saying where it came from.
 */
function planAnnounceDraft() {
  if (!planDraftPending) return;
  const n = planDraftPending;
  planDraftPending = 0;
  setText('spsCreateLabel', `Restored your last survey plan - ${grp(n)} point${n === 1 ? '' : 's'}`);
  undoToast(`Restored your last survey plan - ${grp(n)} point${n === 1 ? '' : 's'}`, () => {
    planPushUndo('discard restored plan');
    clearCreateRubberband();
    planSetLines([]);
    planSel = null;
    planTargetLineId = null;
    planRepaintAll();
    updateHeaderClear();
    setText('spsCreateLabel', 'Click the map to pick line vertices');
  }, 'Discard');
}

/** Reinstall a saved plan. A corrupt or partially-written draft loads as empty and
 *  never throws - the tab must always open. */
function planLoadDraft() {
  let raw: string | null = null;
  try { raw = localStorage.getItem(PLAN_DRAFT_KEY); } catch { return; }
  if (!raw) return;
  try {
    const o = JSON.parse(raw) as { lines?: unknown; crs?: unknown; crsAuto?: unknown; mode?: unknown };
    const lines = Array.isArray(o.lines) ? (o.lines as PlanLine[]).filter((l) => l && Array.isArray(l.points)) : [];
    if (!lines.length) return;
    let maxId = 0;
    for (const l of lines) {
      l.id = Number(l.id) || ++maxId;
      maxId = Math.max(maxId, l.id);
      l.name = typeof l.name === 'string' && l.name ? l.name : String(l.id);
      l.kind = l.kind === 'preplot' ? 'preplot' : 'resample';
      l.role = l.role === 'S' || l.role === 'SR' ? l.role : 'R';
      l.visible = l.visible !== false;
      l.color = typeof l.color === 'string' && l.color ? l.color : CREATE_LINE_COLORS[(l.id - 1) % CREATE_LINE_COLORS.length];
      l.points = l.points.filter((p) => p && isFinite(p.lat) && isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
    }
    planNextLineId = maxId + 1;
    planSetLines(lines.filter((l) => l.points.length));
    planDraftPending = planTotalPoints();
    if (o.crs && typeof o.crs === 'object') createCrs = o.crs as CreateCrs;
    createCrsAuto = o.crsAuto !== false;
    if (o.mode === '3D') createMode = '3D';
  } catch {
    // Unreadable draft: start clean rather than half-loaded.
    planSetLines([]);
  }
}

// -- Survey-plan IMPORT wizard ------------------------------------------------
// The user maps the file's real columns onto line / station / coordinates /
// elevation. Everything is parsed in-process by core's planio (which esbuild
// bundles into this file), so the preview updates as the mapping changes with no
// worker round-trip. The only thing main does is hand over the file's bytes - the
// sandboxed renderer has no connect-src and no usable <input type=file> path.

let piText = '';
let piFileName = '';
let piSniff: CsvSniff | null = null;
let piMap: PlanField[] = [];
let piKind: 'geo' | 'proj' = 'geo';
let piMode: 'replace' | 'append' = 'replace';
/** Rows from a GeoJSON source; when set, the CSV mapping UI is bypassed. */
let piGeoRows: PlanRow[] | null = null;
/** The CRS projected coordinates are expressed in (required for kind 'proj'). */
let piCrsEntry: CRS | null = null;

function planImportOpen(): boolean { return !!$opt('planImportBack')?.classList.contains('open'); }
function closePlanImport() { $opt('planImportBack')?.classList.remove('open'); }

/** A full core Projection built from an EPSG registry entry, for the inverse
 *  (projected → WGS84) direction the importer needs. */
function planProjFromCrs(c: CRS): Projection {
  return {
    subtype: c.subtype, zone: c.zone, hemi: c.hemi, a: c.a, f: c.f,
    lon0: c.lon0, lat0: c.lat0, k0: c.k0, FE: c.FE, FN: c.FN, helmert: c.helmert,
    ...extraProjFields(c),
  };
}

/** Open the importer, cleared back to a fresh session. */
async function openPlanImport() {
  piText = '';
  piFileName = '';
  piSniff = null;
  piMap = [];
  piGeoRows = null;
  piKind = 'geo';
  piMode = 'replace';
  piCrsEntry = null;
  setText('piFileNote', 'No file chosen yet.');
  setVal('piPaste', '');
  setVal('piCrsSearch', '');
  setText('piCrsPicked', '');
  setText('piCrsBtn', 'CRS: -');
  setText('piCoordGuess', '');
  setText('piStatus', '');
  const results = $opt('piCrsSearchResults');
  if (results) { results.classList.remove('show'); results.innerHTML = ''; }
  const delim = $opt('piDelim') as HTMLSelectElement | null; if (delim) delim.value = 'auto';
  const hdr = $opt('piHasHeader') as HTMLInputElement | null; if (hdr) hdr.checked = false;
  const swap = $opt('piSwapAB') as HTMLInputElement | null; if (swap) swap.checked = false;
  const role = $opt('piRole') as HTMLSelectElement | null; if (role) role.value = '';
  const pre = $opt('piAsPreplot') as HTMLInputElement | null; if (pre) pre.checked = true;
  piSyncSegments();
  piRenderMapRows();
  piRefreshPreview();
  $opt('planImportBack')?.classList.add('open');
}

/** Reflect the segmented controls' state. */
function piSyncSegments() {
  $opt('piKindGeo')?.classList.toggle('on', piKind === 'geo');
  $opt('piKindProj')?.classList.toggle('on', piKind === 'proj');
  $opt('piModeReplace')?.classList.toggle('on', piMode === 'replace');
  $opt('piModeAppend')?.classList.toggle('on', piMode === 'append');
  // The CRS row is shown for BOTH coordinate kinds, because it answers a real
  // question either way:
  //   projected -> which grid these numbers are already in (needed to read them)
  //   geographic -> which grid the SURVEY should be generated in (needed to write it)
  // Hiding it for lat/long input meant the output grid was chosen silently from the
  // location, so a user who wanted UTM 36N got ITM and was never asked.
  const crsRow = $opt('piCrsRow');
  if (crsRow) crsRow.style.display = '';
  const lbl = $opt('piCrsRowLabel');
  if (lbl) {
    lbl.textContent = piKind === 'proj'
      ? 'CRS these easting/northing values are already in - search the built-in EPSG database'
      : 'CRS to generate the survey in - search the built-in EPSG database (leave blank to let SeisConv suggest one from the location)';
  }
}

/** The delimiter to parse with: the explicit choice, else what the sniffer found. */
function piCurrentDelim(): Delim {
  const v = ($opt('piDelim') as HTMLSelectElement | null)?.value || 'auto';
  if (v === 'tab') return '\t';
  if (v === ',' || v === ';' || v === 'ws') return v;
  return piSniff?.delim ?? ',';
}

/** Ingest raw text: route GeoJSON straight through, else sniff the CSV. */
function piLoadText(text: string, name: string) {
  piText = text || '';
  piFileName = name || 'pasted text';
  piGeoRows = null;
  const head = piText.trimStart().slice(0, 1);
  if (head === '{' || head === '[') {
    const r = parsePlanGeoJson(piText);
    piGeoRows = r.rows;
    piSniff = null;
    piKind = 'geo';                       // RFC 7946 coordinates are always WGS84
    setText('piFileNote', `${piFileName} · GeoJSON · ${r.rows.length} point${r.rows.length === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} skipped` : ''}`);
    setText('piCoordGuess', 'GeoJSON coordinates are WGS84 lat/long by definition, so there is nothing to map.');
  } else {
    piSniff = sniffPlanCsv(piText);
    piMap = piSniff.guess.slice();
    const d = $opt('piDelim') as HTMLSelectElement | null;
    if (d && d.value === 'auto') { /* keep 'auto'; piCurrentDelim reads the sniff */ }
    const hdr = $opt('piHasHeader') as HTMLInputElement | null;
    if (hdr) hdr.checked = piSniff.hasHeader;
    // Guess the coordinate frame from the values, then say WHY - a wrong guess is
    // one click to fix, but a silent one is a wrong survey.
    piGuessKindFromValues();
    // A `# CRS:` tag in the file pre-selects the CRS, which is what makes a
    // SeisConv-exported coordinate CSV round-trip with no manual step.
    if (piSniff.crsTag) {
      const hit = resolveCrsTagCRS(piSniff.crsTag);
      if (hit) piAdoptCrs(hit, 'from the file’s # CRS tag');
    }
    const noteBits = [piFileName, `${piSniff.totalDataRows} row${piSniff.totalDataRows === 1 ? '' : 's'}`, `${piSniff.header.length} column${piSniff.header.length === 1 ? '' : 's'}`];
    if (piSniff.notes.length) noteBits.push(piSniff.notes.join('; '));
    setText('piFileNote', noteBits.join(' · '));
  }
  piSyncSegments();
  piRenderMapRows();
  piRefreshPreview();
}

/** Set the coordinate-frame guess from the mapped columns' actual values. */
function piGuessKindFromValues() {
  if (!piSniff) return;
  const ai = piMap.indexOf('lat') >= 0 && piMap.indexOf('lon') >= 0 ? [piMap.indexOf('lat'), piMap.indexOf('lon')]
    : piMap.indexOf('easting') >= 0 && piMap.indexOf('northing') >= 0 ? [piMap.indexOf('easting'), piMap.indexOf('northing')]
    : null;
  if (!ai) { setText('piCoordGuess', 'Map two coordinate columns to continue.'); return; }
  const A: number[] = [], B: number[] = [];
  for (const r of piSniff.rows) {
    A.push(parseFloat(r[ai[0]] ?? ''));
    B.push(parseFloat(r[ai[1]] ?? ''));
  }
  piKind = guessCoordKind(A, B);
  setText('piCoordGuess', piKind === 'geo'
    ? 'Auto-detected lat/long: every sampled value falls inside ±90 and ±180.'
    : 'Auto-detected projected metres: the sampled values are outside the range degrees can take.');
}

/** Adopt an EPSG entry as the source CRS of the projected coordinates. */
function piAdoptCrs(c: CRS, why: string) {
  piCrsEntry = c;
  setText('piCrsBtn', 'CRS: ' + c.code);
  const picked = $opt('piCrsPicked');
  if (picked) {
    picked.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = c.code;
    picked.appendChild(document.createTextNode('Using '));
    picked.appendChild(b);
    picked.appendChild(document.createTextNode(` - ${c.name} (${why})`));
  }
  piRefreshPreview();
}

/** One row per source column: name, a field select pre-set to the guess, samples. */
function piRenderMapRows() {
  const host = $opt('piMapRows');
  if (!host) return;
  host.innerHTML = '';
  if (piGeoRows) {
    const d = document.createElement('div');
    d.className = 'hdr-empty';
    d.style.padding = '8px 12px';
    d.textContent = 'GeoJSON carries its own structure - line, station and elevation are read from each feature’s properties.';
    host.appendChild(d);
    return;
  }
  if (!piSniff || !piSniff.header.length) {
    const d = document.createElement('div');
    d.className = 'hdr-empty';
    d.style.padding = '8px 12px';
    d.textContent = 'Choose a file or paste rows to map its columns.';
    host.appendChild(d);
    return;
  }
  piSniff.header.forEach((name, c) => {
    const row = document.createElement('div');
    row.className = 'pi-maprow';

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = name;          // file text - never innerHTML
    nm.title = name;
    row.appendChild(nm);

    const sel = document.createElement('select');
    sel.className = 'ctl';
    for (const f of PLAN_FIELDS) {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = PLAN_FIELD_LABELS[f];
      sel.appendChild(o);
    }
    sel.value = piMap[c] ?? 'skip';
    sel.addEventListener('change', () => {
      const want = sel.value as PlanField;
      // A field can only be mapped once; taking it releases whoever held it.
      if (want !== 'skip') for (let i = 0; i < piMap.length; i++) if (i !== c && piMap[i] === want) piMap[i] = 'skip';
      piMap[c] = want;
      piRenderMapRows();
      piGuessKindFromValues();
      piSyncSegments();
      piRefreshPreview();
    });
    row.appendChild(sel);

    const samples = document.createElement('span');
    samples.className = 'pi-samples';
    const vals = piSniff!.rows.slice(0, 3).map((r) => (r[c] ?? '').trim()).filter((v) => v !== '');
    samples.textContent = vals.length ? vals.join('  ·  ') : '(empty)';
    samples.title = samples.textContent;
    row.appendChild(samples);

    host.appendChild(row);
  });
}

/** Parse the preview slice against the current settings and repaint the preview,
 *  the issue list, and the Import button's enablement + label. */
function piRefreshPreview() {
  const prev = $opt('piPreview');
  const issues = $opt('piIssues');
  const btn = $opt('piImport') as HTMLButtonElement | null;
  if (!prev || !issues) return;
  issues.innerHTML = '';

  const role = ($opt('piRole') as HTMLSelectElement | null)?.value || '';
  let rows: PlanRow[] = [];
  let errs: string[] = [];
  let skipped = 0;
  let total = 0;

  if (piGeoRows) {
    rows = piGeoRows.slice(0, 12);
    total = piGeoRows.length;
  } else if (piSniff && piText) {
    // Preview parses a BOUNDED slice, so retyping a mapping stays instant even on
    // a very large file; Import re-parses the whole text once.
    const slice = piPreviewSlice();
    const r = parsePlanCsv(slice, piMap, {
      delim: piCurrentDelim(),
      hasHeader: ($opt('piHasHeader') as HTMLInputElement | null)?.checked === true,
      coordKind: piKind,
      swapAB: ($opt('piSwapAB') as HTMLInputElement | null)?.checked === true,
    });
    rows = r.rows.slice(0, 12);
    errs = r.errors;
    skipped = r.skipped;
    total = piSniff.totalDataRows;
  }

  if (!rows.length) {
    prev.textContent = piText ? 'No rows parsed with these settings.' : 'Nothing to preview yet.';
  } else {
    const head = piKind === 'geo' ? 'line       station  latitude      longitude     elev' : 'line       station  easting       northing      elev';
    const body = rows.map((r) => {
      const ln = (r.line || '-').padEnd(10).slice(0, 10);
      const st = (r.station == null ? '-' : String(r.station)).padStart(7);
      const a = r.a.toFixed(piKind === 'geo' ? 6 : 2).padStart(13);
      const b = r.b.toFixed(piKind === 'geo' ? 6 : 2).padStart(13);
      const el = (r.elev == null ? '-' : String(r.elev)).padStart(6);
      return `${ln} ${st}  ${a} ${b} ${el}`;
    });
    prev.textContent = [head, ...body].join('\n');
  }

  for (const e of errs.slice(0, 8)) {
    const d = document.createElement('div');
    d.className = 'bad';
    d.textContent = e;
    issues.appendChild(d);
  }
  if (skipped) {
    const d = document.createElement('div');
    d.textContent = `${skipped} row${skipped === 1 ? '' : 's'} rejected in the previewed slice.`;
    issues.appendChild(d);
  }

  // Enablement: something to import, a role chosen, and - for projected input - a
  // CRS to interpret the numbers with. Each blocked case says which one it is.
  let why = '';
  if (!rows.length) why = piText ? 'No rows parse with these settings.' : 'Choose a file or paste rows.';
  else if (!role) why = 'Choose whether these points are receivers, sources, or both.';
  else if (piKind === 'proj' && !piCrsEntry) why = 'Projected coordinates need a CRS - search the EPSG database above.';
  setText('piStatus', why);
  if (btn) {
    btn.disabled = !!why;
    btn.textContent = why || !total ? 'Import' : `Import ${grp(total)} point${total === 1 ? '' : 's'}`;
  }
}

/** A bounded head of the text for preview parsing (200 data rows plus comments). */
function piPreviewSlice(): string {
  const lines = piText.split('\n');
  return lines.length <= 220 ? piText : lines.slice(0, 220).join('\n');
}

/** Run the import: parse everything, group into lines, convert coordinates, and
 *  install into the plan under the chosen replace/append mode. */
async function piDoImport() {
  const roleRaw = ($opt('piRole') as HTMLSelectElement | null)?.value || '';
  if (roleRaw !== 'R' && roleRaw !== 'S' && roleRaw !== 'SR') return;
  const role = roleRaw;
  const asPreplot = ($opt('piAsPreplot') as HTMLInputElement | null)?.checked !== false;
  const kind: 'preplot' | 'resample' = asPreplot ? 'preplot' : 'resample';

  let rows: PlanRow[] = [];
  let errs: string[] = [];
  let skipped = 0;
  let truncated = false;

  if (piGeoRows) {
    rows = piGeoRows;
  } else {
    const big = (piSniff?.totalDataRows ?? 0) > 20000;
    if (big) showProgress(`Reading ${piFileName}…`);
    try {
      const r = parsePlanCsv(piText, piMap, {
        delim: piCurrentDelim(),
        hasHeader: ($opt('piHasHeader') as HTMLInputElement | null)?.checked === true,
        coordKind: piKind,
        swapAB: ($opt('piSwapAB') as HTMLInputElement | null)?.checked === true,
      });
      rows = r.rows;
      errs = r.errors;
      skipped = r.skipped;
      truncated = r.truncated;
    } finally {
      if (big) hideProgress();
    }
  }
  if (!rows.length) { setText('piStatus', 'Nothing was imported - no rows parsed.'); return; }

  // Convert to the plan's canonical WGS84, keeping the original projected numbers
  // when there are any, so Generate can write them back untouched.
  const proj = piKind === 'proj' && piCrsEntry ? planProjFromCrs(piCrsEntry) : null;
  const srcCrsKey = piCrsEntry ? createCrsKey(createCrsFromDb(piCrsEntry)) : '';
  const groups = groupPlanRows(rows);
  const built: PlanLine[] = [];
  let rejected = 0;
  for (const g of groups) {
    const points: PlanPoint[] = [];
    for (const r of g.rows) {
      let lat: number, lon: number;
      let srcE: number | undefined, srcN: number | undefined;
      if (piKind === 'geo') {
        lat = r.a; lon = r.b;
      } else {
        if (!proj) { rejected++; continue; }
        const ll = projToLatLon(r.a, r.b, proj, r.elev ?? 0);
        lat = ll.lat; lon = ll.lon;
        srcE = r.a; srcN = r.b;
      }
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { rejected++; continue; }
      points.push({
        lat: +lat.toFixed(7), lon: +lon.toFixed(7),
        station: r.station, elev: r.elev,
        ...(srcE != null && srcN != null ? { srcE, srcN, srcCrsKey } : {}),
      });
    }
    if (!points.length) continue;
    const id = planNextLineId++;
    built.push({
      id, name: g.name, kind, role, points,
      color: CREATE_LINE_COLORS[(id - 1) % CREATE_LINE_COLORS.length],
      visible: true,
    });
  }
  if (!built.length) { setText('piStatus', 'Nothing was imported - every row failed the coordinate checks.'); return; }

  snapshotBackup('sps-plan', { lines: createLines, crs: createCrs, mode: createMode }, planBackupLabel());
  planPushUndo(piMode === 'replace' ? 'import (replace)' : 'import (append)');

  if (piMode === 'replace') {
    planSetLines(built);
  } else {
    // Appending: a station number already used on a same-named line would become a
    // duplicate, so those (and only those) are renumbered past the existing maximum.
    const byName = new Map<string, PlanLine>();
    for (const l of createLines) if (!byName.has(l.name)) byName.set(l.name, l);
    for (const nl of built) {
      const clash = byName.get(nl.name);
      if (!clash) continue;
      const taken = new Set<number>();
      for (const p of clash.points) if (p.station != null) taken.add(p.station);
      let next = taken.size ? Math.max(...taken) : 0;
      nl.points = nl.points.map((p) => {
        if (p.station == null || !taken.has(p.station)) { if (p.station != null) taken.add(p.station); return p; }
        next = Math.max(next, p.station) + 1;
        taken.add(next);
        return { ...p, station: next };
      });
    }
    planSetLines([...createLines, ...built]);
  }

  // A CRS the user CHOSE always wins - for projected input it is the grid the
  // numbers are in, for geographic input it is the grid to generate the survey in.
  // (Requiring createCrsAuto here meant an explicit choice was ignored once any
  // earlier import had pinned one, which is how "export to UTM 36N" silently came
  // out as the location's auto-suggested ITM.)
  if (piCrsEntry) { createCrs = createCrsFromDb(piCrsEntry); createCrsAuto = false; updateCreateCrsBtn(); }
  else if (createCrsAuto && built[0]?.points[0]) { createCrs = createSuggestCrs(built[0].points[0].lat, built[0].points[0].lon); updateCreateCrsBtn(); }

  planSel = null;
  planTargetLineId = built[built.length - 1].id;
  planInvalidate();
  planFit();
  planRepaintAll();
  updateHeaderClear();
  closePlanImport();

  const n = built.reduce((a, l) => a + l.points.length, 0);
  const problems = skipped + rejected;
  audit('import', `survey plan: ${n} points, ${built.length} lines from ${piFileName}`, 'spscreate');
  setText('spsCreateLabel', `Imported ${grp(n)} point${n === 1 ? '' : 's'} on ${built.length} line${built.length === 1 ? '' : 's'}${problems ? ` · ${problems} row(s) skipped` : ''}${truncated ? ' · file truncated at the row cap' : ''}`);
  if (problems && errs.length) infoToast(`${problems} row(s) skipped - first: ${errs[0]}`);
  undoToast(`Imported ${grp(n)} points from ${piFileName}`, planUndo);
}

/** Wire the import wizard (called once from initSpsCreate). */
function initPlanImport() {
  $opt('piClose')?.addEventListener('click', closePlanImport);
  $opt('piCancel')?.addEventListener('click', closePlanImport);
  $opt('planImportBack')?.addEventListener('click', (e) => { if (e.target === $opt('planImportBack')) closePlanImport(); });
  $opt('piPickFile')?.addEventListener('click', () => void (async () => {
    try {
      const f = await api.openPlanText();
      if (!f) return;                       // cancelled
      piLoadText(f.text, f.name);
    } catch (e) {
      setText('piStatus', 'Could not read that file: ' + errMsg(e));
    }
  })());
  $opt('piUsePaste')?.addEventListener('click', () => {
    const txt = ($opt('piPaste') as HTMLTextAreaElement | null)?.value ?? '';
    if (!txt.trim()) { setText('piStatus', 'The paste box is empty.'); return; }
    piLoadText(txt, 'pasted text');
  });
  $opt('piDelim')?.addEventListener('change', () => { if (piText) piLoadText(piText, piFileName); });
  $opt('piHasHeader')?.addEventListener('change', () => {
    if (!piText || piGeoRows) { piRefreshPreview(); return; }
    // Re-guess the mapping: with the header on or off the columns mean different
    // things, and keeping a stale guess is worse than re-deriving it.
    piSniff = sniffPlanCsv(piText, { delim: piCurrentDelim() });
    piMap = piSniff.guess.slice();
    piRenderMapRows();
    piGuessKindFromValues();
    piSyncSegments();
    piRefreshPreview();
  });
  $opt('piSwapAB')?.addEventListener('change', piRefreshPreview);
  $opt('piRole')?.addEventListener('change', piRefreshPreview);
  $opt('piAsPreplot')?.addEventListener('change', piRefreshPreview);
  $opt('piKindGeo')?.addEventListener('click', () => { piKind = 'geo'; piSyncSegments(); setText('piCoordGuess', 'Set by hand: lat/long.'); piRefreshPreview(); });
  $opt('piKindProj')?.addEventListener('click', () => { piKind = 'proj'; piSyncSegments(); setText('piCoordGuess', 'Set by hand: projected metres.'); piRefreshPreview(); });
  $opt('piModeReplace')?.addEventListener('click', () => { piMode = 'replace'; piSyncSegments(); });
  $opt('piModeAppend')?.addEventListener('click', () => { piMode = 'append'; piSyncSegments(); });
  $opt('piImport')?.addEventListener('click', () => void piDoImport());
  // Built-in EPSG search, same local registry the Generate wizard uses.
  $opt('piCrsSearch')?.addEventListener('input', () => {
    if (piCrsTimer != null) window.clearTimeout(piCrsTimer);
    piCrsTimer = window.setTimeout(piRunCrsSearch, 160);
  });
}
let piCrsTimer: number | null = null;

/** Render the importer's EPSG results as clickable rows. */
function piRunCrsSearch() {
  const host = $opt('piCrsSearchResults');
  const q = ($opt('piCrsSearch') as HTMLInputElement | null)?.value ?? '';
  if (!host) return;
  if (!q.trim()) { host.classList.remove('show'); host.innerHTML = ''; return; }
  let list: CRS[] = [];
  try { list = searchEPSG(q); } catch { list = []; }
  host.innerHTML = '';
  host.classList.add('show');
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'crs-search-empty';
    d.textContent = 'No built-in CRS matches - try an EPSG code, a UTM zone (e.g. “UTM 36N”), or a name.';
    host.appendChild(d);
    return;
  }
  for (const c of list.slice(0, 40)) {
    const row = document.createElement('div');
    row.className = 'crs-search-row';
    row.setAttribute('role', 'option');
    const cc = document.createElement('span'); cc.className = 'cc'; cc.textContent = c.code;
    const cn = document.createElement('span'); cn.className = 'cn'; cn.textContent = c.name;
    row.appendChild(cc); row.appendChild(cn);
    row.addEventListener('click', () => {
      piAdoptCrs(c, 'chosen');
      host.classList.remove('show');
      host.innerHTML = '';
      setVal('piCrsSearch', '');
    });
    host.appendChild(row);
  }
}

// -- plan-level EXPORT ---------------------------------------------------------

/** The visible plan, with its derived per-segment metrics, in export shape. */
function planExportLines(): PlanExportLine[] {
  const crsKey = createCrsKey(createCrs);
  return planRealLines().filter((l) => l.visible).map((l) => {
    const der = planDerivedOf(l);
    return {
      name: l.name,
      kind: l.kind,
      points: l.points.map((p, i) => {
        const en = p.srcE != null && p.srcN != null && p.srcCrsKey === crsKey
          ? { e: p.srcE, n: p.srcN }
          : createProjectEN(p.lat, p.lon);
        return {
          lat: p.lat, lon: p.lon, station: p.station, elev: p.elev,
          easting: en ? en.e : null, northing: en ? en.n : null,
          cumM: der.cum[i], segM: der.seg[i], azDeg: der.az[i],
        };
      }),
    };
  });
}

/** A `# CRS:` tag for the plan's own CRS, when it maps to an EPSG code. */
function planCrsTag(): string | undefined {
  const d = (createCrs.datum || '').trim();
  if (/^EPSG:\d+$/i.test(d)) return `# CRS: ${d.toUpperCase()}`;
  if (createCrs.projType === 'UTM' && createCrs.zone != null && isFinite(createCrs.zone)) {
    return `# CRS: EPSG:${(createCrs.hemi === 'S' ? 32700 : 32600) + createCrs.zone}`;
  }
  return undefined;
}

/** A file-name stem for exports: the imported file's name when there was one. */
function planBaseName(): string {
  const raw = (piFileName || '').replace(/\.[^.]+$/, '').trim();
  const clean = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return clean || 'survey';
}

/**
 * Write the plan straight out as SPS 2.1 S / R / X files.
 *
 * The Generate wizard exists to LAY OUT a survey that is only a set of drawn lines -
 * it asks for station intervals, numbering and a receiver patch. An imported preplot
 * is already positioned and already numbered, so none of those questions apply: this
 * path skips the wizard entirely and writes what is on screen.
 *
 * Drawn (re-sampled) lines still need an interval, so a plan containing any is sent
 * to the wizard rather than being generated behind a silent 25 m default.
 */
async function planExportSps() {
  const { resample, preplot } = planGenerable();
  if (!resample.length && !preplot.length) { setText('spsCreateLabel', 'Nothing to export - the plan is empty.'); return; }
  if (resample.length) {
    setText('spsCreateLabel', `${resample.length} drawn line${resample.length === 1 ? '' : 's'} still need a station interval - use Generate… to set it.`);
    return;
  }
  const errs = planChecksOf().findings.filter((f) => f.sev === 'error');
  if (errs.length) {
    planShowPane('checks');
    setText('spsCreateLabel', `Fix ${errs.length} plan error${errs.length === 1 ? '' : 's'} first - see the Checks pane.`);
    return;
  }
  if (!createCrs.projType && !createCrs.datum) {
    setText('spsCreateLabel', 'No CRS yet - open the CRS button and choose one, or import a file that names its own.');
    return;
  }

  const crsKey = createCrsKey(createCrs);
  const req = {
    crs: createCrs,
    baseName: planBaseName(),
    picks: [],
    preplots: preplot.map((l) => ({
      lineName: l.name,
      role: l.role,
      stations: l.points.map((p, i) => ({
        lat: p.lat,
        lon: p.lon,
        point: p.station ?? i + 1,
        ...(p.elev != null && isFinite(p.elev) ? { elev: p.elev } : {}),
        ...(p.srcE != null && p.srcN != null && p.srcCrsKey === crsKey ? { e: p.srcE, n: p.srcN } : {}),
      })),
    })),
    mode: '2D' as const,
    relation: { type: 'full' as const },
  };
  const stations = preplot.reduce((a, l) => a + l.points.length, 0);
  setText('spsCreateLabel', `Writing SPS 2.1 · ${grp(stations)} stations…`);
  showProgress('Writing SPS 2.1…');
  try {
    const r = await api.spsCreate(req);
    if (!r.ok) { setText('spsCreateLabel', 'SPS export failed: ' + (r.error || 'unknown')); return; }
    // The worker now holds the generated survey; adopt it exactly as the wizard does
    // so the SPS tab shows what was just written.
    if (r.summary) adoptCreatedSurvey(r.summary);
    switchTab('sps');
    if (spsSummary) await refreshSps();
    if (r.savedPath) { infoToast('Saved ' + r.savedPath); audit('export', `SPS 2.1 from the survey plan → ${r.savedPath}`, 'spscreate'); }
    else if (r.canceled) infoToast('SPS built and loaded (not saved)');
    else infoToast('SPS 2.1 written');
  } catch (e) {
    setText('spsCreateLabel', 'SPS export failed: ' + errMsg(e));
  } finally {
    hideProgress();
  }
}

/** Save the PLAN (before generation) as CSV / GeoJSON / KML via a native dialog. */
async function planExport(kind: 'csv' | 'geojson' | 'kml') {
  const lines = planExportLines();
  if (!lines.length) { setText('spsCreateLabel', 'Nothing to export - the plan is empty.'); return; }
  const { name, text } =
    kind === 'csv' ? { name: 'survey_plan.csv', text: buildPlanCsv(lines, planCrsTag()) }
    : kind === 'geojson' ? { name: 'survey_plan.geojson', text: buildPlanGeoJson(lines) }
    : { name: 'survey_plan.kml', text: buildPlanKml(lines) };
  try {
    const r = await api.exportText(name, text);
    if (r.ok) {
      infoToast('Saved ' + r.path);
      audit('export', `survey plan ${kind.toUpperCase()} → ${r.path}`, 'spscreate');
    } else if (!r.canceled) {
      setText('spsCreateLabel', 'Export failed: ' + (r.error || 'unknown'));
    }
  } catch (e) {
    setText('spsCreateLabel', 'Export failed: ' + errMsg(e));
  }
}

// -- Generate wizard (in-app modal; sandboxed renderer - never window.prompt) --
function spsWizardOpen(): boolean { return !!$opt('spsWizardBack')?.classList.contains('open'); }
function closeCreateWizard() { $opt('spsWizardBack')?.classList.remove('open'); }
/** Enable the split-spread channel count only when the relation is split-spread;
 *  the moving-patch line count is enabled only for a 3D split relation. */
function updateCreateRelUI() {
  const rel = ($opt('cRelType') as HTMLSelectElement | null)?.value;
  const ch = $opt('cRelChannels') as HTMLInputElement | null;
  if (ch) ch.disabled = rel !== 'split';
  const patch = $opt('cPatchLines') as HTMLInputElement | null;
  if (patch) patch.disabled = !(rel === 'split' && createMode === '3D');
}

/** Switch the survey type (2D / 3D): toggle the toolbar segment, remember the
 *  mode, then re-sync the wizard's mode-specific UI (the wizard reads this on open). */
function setCreateMode(mode: '2D' | '3D') {
  createMode = mode;
  $opt('spsCreate2d')?.classList.toggle('on', mode === '2D');
  $opt('spsCreate3d')?.classList.toggle('on', mode === '3D');
  setText('spsCreateLabel', mode === '3D'
    ? '3D - picked lines are RECEIVER lines; source lines auto-generate perpendicular.'
    : 'Click the map to pick line vertices');
  updateCreateModeUI();
}

/** Show/hide the 3D-only wizard fields and relabel the relation choices for the
 *  active mode (2D: Full line / Split-spread · 3D: Full template / Moving patch). */
function updateCreateModeUI() {
  const is3d = createMode === '3D';
  $opt('cWiz3dGrp')?.classList.toggle('hidden', !is3d);
  $opt('cPatchLinesLbl')?.classList.toggle('hidden', !is3d);
  setText('cRelOptFull', is3d ? 'Full template' : 'Full line');
  setText('cRelOptSplit', is3d ? 'Moving patch' : 'Split-spread');
  updateCreateRelUI();
}

/** Map a built-in EPSG entry (from searchEPSG) onto the wizard's loose CreateCrs
 *  spec so the manual form prefills from it (and stays editable afterwards). */
function createCrsFromDb(c: CRS): CreateCrs {
  const projType = c.subtype === 'UTM' ? 'UTM' : c.subtype === 'GEO' ? 'GEO' : 'TM';
  const numU = (v: number | undefined) => (v != null && isFinite(v) ? v : undefined);
  return {
    datum: c.code || undefined,
    projType,
    zone: numU(c.zone),
    hemi: c.hemi === 'S' ? 'S' : c.hemi === 'N' ? 'N' : undefined,
    units: 'meters',
    centralMeridian: numU(c.lon0),
    latOrigin: numU(c.lat0),
    falseEasting: numU(c.FE),
    falseNorthing: numU(c.FN),
    scaleFactor: numU(c.k0),
  };
}

/** Render the EPSG search results as clickable rows (code - name). */
function renderCrsSearchResults(list: CRS[], query: string) {
  const host = $opt('cCrsSearchResults');
  if (!host) return;
  if (!query.trim()) { host.classList.remove('show'); host.innerHTML = ''; return; }
  host.classList.add('show');
  if (list.length === 0) {
    host.innerHTML = '<div class="crs-search-empty">No built-in CRS matches - try an EPSG code, a UTM zone (e.g. “UTM 36N”), or a name.</div>';
    return;
  }
  host.innerHTML = '';
  list.slice(0, 40).forEach((c) => {
    const row = document.createElement('div');
    row.className = 'crs-search-row';
    row.setAttribute('role', 'option');
    const cc = document.createElement('span'); cc.className = 'cc'; cc.textContent = c.code;
    const cn = document.createElement('span'); cn.className = 'cn'; cn.textContent = c.name;
    row.appendChild(cc); row.appendChild(cn);
    row.addEventListener('click', () => pickCrsResult(c));
    host.appendChild(row);
  });
}

/** Adopt a picked EPSG entry: fill the spec form, update the chip + picked label,
 *  and stop the location auto-suggest from overriding it on the next pick. */
function pickCrsResult(c: CRS) {
  const spec = createCrsFromDb(c);
  createCrs = spec;
  createCrsAuto = false;
  fillCreateCrsForm(spec);
  updateCreateCrsBtn();
  const picked = $opt('cCrsPicked');
  if (picked) picked.innerHTML = '';
  if (picked) {
    const b = document.createElement('b'); b.textContent = c.code;
    picked.appendChild(document.createTextNode('Picked '));
    picked.appendChild(b);
    picked.appendChild(document.createTextNode(' - ' + c.name));
  }
  const results = $opt('cCrsSearchResults');
  if (results) { results.classList.remove('show'); results.innerHTML = ''; }
  setVal('cCrsSearch', '');
  setText('spsWizardSummary', createWizardSummary());
}

/** Run the (debounced) built-in EPSG search from the wizard's search box. */
function runCrsSearch() {
  const q = ($opt('cCrsSearch') as HTMLInputElement | null)?.value ?? '';
  if (!q.trim()) { renderCrsSearchResults([], ''); return; }
  let list: CRS[] = [];
  try { list = searchEPSG(q); } catch { list = []; }
  renderCrsSearchResults(list, q);
}
/** Prefill the wizard's CRS-spec form (Header-Editor pattern) from a CreateCrs. */
function fillCreateCrsForm(c: CreateCrs) {
  setVal('cCrsDatum', c.datum ?? '');
  const pt = $opt('cCrsProjType') as HTMLSelectElement | null;
  if (pt) pt.value = c.projType === 'GEO' ? 'GEO' : c.projType === 'UTM' ? 'UTM' : 'TM';
  setVal('cCrsZone', c.zone != null ? String(c.zone) : '');
  const hemi = $opt('cCrsHemi') as HTMLSelectElement | null; if (hemi) hemi.value = c.hemi === 'S' ? 'S' : 'N';
  const units = $opt('cCrsUnits') as HTMLSelectElement | null; if (units) units.value = c.units === 'feet' ? 'feet' : 'meters';
  setVal('cCrsCM', c.centralMeridian != null ? String(c.centralMeridian) : '');
  setVal('cCrsLat0', c.latOrigin != null ? String(c.latOrigin) : '');
  setVal('cCrsFE', c.falseEasting != null ? String(c.falseEasting) : '');
  setVal('cCrsFN', c.falseNorthing != null ? String(c.falseNorthing) : '');
  setVal('cCrsK0', c.scaleFactor != null ? String(c.scaleFactor) : '');
}
/** Read the wizard's CRS-spec form into a CreateCrs (mirrors readCrsForm). */
function readCreateCrsForm(): CreateCrs {
  const projType = ($('cCrsProjType') as HTMLSelectElement).value;
  const numU = (id: string) => { const v = parseFloat(($(id) as HTMLInputElement).value); return isFinite(v) ? v : undefined; };
  const strU = (id: string) => { const v = ($(id) as HTMLInputElement).value.trim(); return v || undefined; };
  return {
    datum: strU('cCrsDatum'),
    projType,
    zone: numU('cCrsZone'),
    hemi: (($('cCrsHemi') as HTMLSelectElement).value === 'S' ? 'S' : 'N'),
    units: ($('cCrsUnits') as HTMLSelectElement).value,
    centralMeridian: numU('cCrsCM'),
    latOrigin: numU('cCrsLat0'),
    falseEasting: numU('cCrsFE'),
    falseNorthing: numU('cCrsFN'),
    scaleFactor: numU('cCrsK0'),
  };
}
/** Lines that can be generated, split by how they will be laid out. */
function planGenerable(): { resample: PlanLine[]; preplot: PlanLine[] } {
  const usable = createLines.filter((l) => l.points.length >= 2);
  return {
    resample: usable.filter((l) => l.kind === 'resample'),
    preplot: usable.filter((l) => l.kind === 'preplot'),
  };
}
/** One-line wizard summary: mode · line counts by kind · points · CRS. */
function createWizardSummary(): string {
  const { resample, preplot } = planGenerable();
  const totalV = [...resample, ...preplot].reduce((a, l) => a + l.points.length, 0);
  const role = createMode === '3D' ? ' (receiver lines)' : '';
  const parts: string[] = [];
  if (resample.length) parts.push(`${resample.length} re-sampled${role}`);
  if (preplot.length) parts.push(`${preplot.length} preplot (as-is)`);
  return `${createMode} · ${parts.join(' + ') || 'no lines'} · ${totalV} points · CRS ${createCrsLabel(createCrs)}`;
}
/** Generate… → validate the plan, then open the wizard prefilled from defaults. */
function openCreateWizard() {
  const { resample, preplot } = planGenerable();
  const partial = createLines.some((l) => l.points.length === 1);
  if (resample.length === 0 && preplot.length === 0) { setText('spsCreateLabel', 'Add at least one line with ≥2 points first.'); return; }
  if (partial) { setText('spsCreateLabel', 'A line has only one point - add another, or delete it.'); return; }
  // A blocking plan-check error means the generated survey would be wrong; say so
  // and point at the Checks pane rather than producing a bad SPS triplet.
  const errs = planChecksOf().findings.filter((f) => f.sev === 'error');
  if (errs.length) {
    planShowPane('checks');
    setText('spsCreateLabel', `Fix ${errs.length} plan error${errs.length === 1 ? '' : 's'} first - see the Checks pane.`);
    return;
  }
  fillCreateCrsForm(createCrs);
  const setIfBlank = (id: string, v: number) => { const el = $opt(id) as HTMLInputElement | null; if (el && el.value.trim() === '') el.value = String(v); };
  setIfBlank('cRcvInt', CREATE_DEFAULTS_UI.rcvInterval);
  setIfBlank('cSrcInt', CREATE_DEFAULTS_UI.srcInterval);
  setIfBlank('cRcvLineStart', CREATE_DEFAULTS_UI.rcvLineStart);
  setIfBlank('cRcvLineInc', CREATE_DEFAULTS_UI.rcvLineInc);
  setIfBlank('cRcvPtStart', CREATE_DEFAULTS_UI.rcvPointStart);
  setIfBlank('cRcvPtInc', CREATE_DEFAULTS_UI.rcvPointInc);
  setIfBlank('cSrcLineStart', CREATE_DEFAULTS_UI.srcLineStart);
  setIfBlank('cSrcLineInc', CREATE_DEFAULTS_UI.srcLineInc);
  setIfBlank('cSrcPtStart', CREATE_DEFAULTS_UI.srcPointStart);
  setIfBlank('cSrcPtInc', CREATE_DEFAULTS_UI.srcPointInc);
  // 3D defaults (mirror core's CREATE_DEFAULTS: SLI 300 m, moving-patch 8 lines).
  setIfBlank('cSrcLineSpacing', 300);
  setIfBlank('cPatchLines', 8);
  // Reset the EPSG picker for a fresh session.
  setVal('cCrsSearch', '');
  setText('cCrsPicked', '');
  renderCrsSearchResults([], '');
  setText('spsWizardSummary', createWizardSummary());
  setText('spsWizardStatus', '');
  updateCreateModeUI();
  $opt('spsWizardBack')?.classList.add('open');
}
/** Confirm → assemble the SPSCreateReq, call the worker, then adopt + show the
 *  generated survey on the SPS tab. On ok:false the wizard stays open with the error. */
async function confirmCreateWizard() {
  const { resample, preplot } = planGenerable();
  if (resample.length === 0 && preplot.length === 0) { setText('spsWizardStatus', 'Add at least one line with ≥2 points.'); return; }
  const numU = (id: string) => { const v = parseFloat(($(id) as HTMLInputElement).value); return isFinite(v) ? v : undefined; };
  const strU = (id: string) => { const v = ($(id) as HTMLInputElement).value.trim(); return v || undefined; };
  const rcvInterval = numU('cRcvInt');
  const srcInterval = numU('cSrcInt');
  if (rcvInterval == null || !(rcvInterval > 0) || srcInterval == null || !(srcInterval > 0)) {
    setText('spsWizardStatus', 'Receiver & source intervals must be finite numbers > 0.'); return;
  }
  const is3d = createMode === '3D';
  // Relation: 'split' = split-spread (2D) / moving patch (3D); needs channels ≥ 1
  // (+ a patch-line count ≥ 1 in 3D). 'full' = whole line (2D) / full template (3D).
  const relType = (($('cRelType') as HTMLSelectElement).value === 'split') ? 'split' : 'full';
  let relation: { type: 'full' | 'split'; channels?: number; patchLines?: number };
  if (relType === 'split') {
    let channels = numU('cRelChannels');
    if (channels == null || !(channels >= 1)) {
      setText('spsWizardStatus', (is3d ? 'Moving patch' : 'Split-spread') + ' needs a channel count ≥ 1.'); return;
    }
    channels = Math.round(channels);
    if (is3d) {
      let patchLines = numU('cPatchLines');
      if (patchLines == null || !(patchLines >= 1)) { setText('spsWizardStatus', 'Moving patch needs a patch-line count ≥ 1.'); return; }
      patchLines = Math.round(patchLines);
      relation = { type: 'split', channels, patchLines };
    } else {
      relation = { type: 'split', channels };
    }
  } else {
    relation = { type: 'full' };
  }
  // 3D-only source-line layout: spacing must be finite & > 0; azimuth optional
  // (blank = auto-derive from the longest picked receiver line).
  let srcLineSpacing: number | undefined;
  let azimuthDeg: number | undefined;
  if (is3d) {
    srcLineSpacing = numU('cSrcLineSpacing');
    if (srcLineSpacing == null || !(srcLineSpacing > 0)) { setText('spsWizardStatus', '3D source-line spacing must be a finite number > 0.'); return; }
    const azRaw = ($('cAzimuth') as HTMLInputElement).value.trim();
    if (azRaw !== '') {
      const az = parseFloat(azRaw);
      if (!isFinite(az)) { setText('spsWizardStatus', 'Azimuth must be a finite number (or leave it blank for auto).'); return; }
      azimuthDeg = az;
    }
  }
  const crs = readCreateCrsForm();
  const crsChanged = createCrsKey(crs) !== createCrsKey(createCrs);
  createCrs = crs; createCrsAuto = false; updateCreateCrsBtn();
  if (crsChanged) planInvalidate();   // every distance is measured in the survey CRS
  const crsKey = createCrsKey(crs);
  const baseName = strU('cBaseName') || 'survey';
  const req = {
    crs,
    baseName,
    picks: resample.map((l) => ({ vertices: l.points.map((v) => ({ lat: v.lat, lon: v.lon })) })),
    // A preplot station keeps its original projected coordinates only while they are
    // still expressed in the CRS being generated; otherwise the worker re-projects
    // its lat/long, which is the only correct answer once the CRS has changed.
    ...(preplot.length ? {
      preplots: preplot.map((l) => ({
        lineName: l.name,
        role: l.role,
        stations: l.points.map((p, i) => ({
          lat: p.lat,
          lon: p.lon,
          point: p.station ?? i + 1,
          ...(p.elev != null && isFinite(p.elev) ? { elev: p.elev } : {}),
          ...(p.srcE != null && p.srcN != null && p.srcCrsKey === crsKey ? { e: p.srcE, n: p.srcN } : {}),
        })),
      })),
    } : {}),
    mode: createMode,
    rcvInterval, srcInterval,
    rcvLineStart: numU('cRcvLineStart'), rcvLineInc: numU('cRcvLineInc'),
    rcvPointStart: numU('cRcvPtStart'), rcvPointInc: numU('cRcvPtInc'),
    srcLineStart: numU('cSrcLineStart'), srcLineInc: numU('cSrcLineInc'),
    srcPointStart: numU('cSrcPtStart'), srcPointInc: numU('cSrcPtInc'),
    ...(is3d ? { srcLineSpacing, azimuthDeg } : {}),
    relation,
    srcType: strU('cSrcType'), rcvType: strU('cRcvType'),
  };
  const btn = $opt('spsWizardCreate') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  setText('spsWizardStatus', 'Generating…');
  try {
    const r = await api.spsCreate(req);
    if (!r.ok) { setText('spsWizardStatus', 'Failed: ' + (r.error || 'unknown')); return; }
    // The worker now holds the generated survey - adopt it like loadSPS / renumber.
    if (r.summary) adoptCreatedSurvey(r.summary);
    closeCreateWizard();
    switchTab('sps');
    if (spsSummary) await refreshSps();
    if (r.savedPath) { infoToast('Saved ' + r.savedPath); audit('export', 'SPS created → ' + r.savedPath, 'sps'); }
    else if (r.canceled) infoToast('Created (not exported)');
    else infoToast('Survey created');
  } catch (e) {
    setText('spsWizardStatus', 'Failed: ' + errMsg(e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Wire up the SPS Creation tab + its Generate wizard (called once from init). */
function initSpsCreate() {
  $opt('spsCreateNextLine')?.addEventListener('click', createNextLine);
  $opt('spsCreateUndo')?.addEventListener('click', planUndo);
  $opt('spsCreateClear')?.addEventListener('click', createClear);
  $opt('spsCreateGenerate')?.addEventListener('click', openCreateWizard);
  $opt('spsCreateCrsBtn')?.addEventListener('click', () => {
    // The CRS is reviewed / overridden in the Generate wizard's CRS-spec form.
    if (createLines.some((l) => l.points.length >= 2)) openCreateWizard();
    else setText('spsCreateLabel', 'Add a line first - the CRS is auto-suggested from your first point.');
  });

  // -- display + editing sidebar --
  for (const id of ['plLinesOn', 'plArrowsOn', 'plLabelsOn', 'plStnsOn']) $opt(id)?.addEventListener('change', readPlanLayerControls);
  for (const id of ['plLinesOp', 'plArrowsOp', 'plLabelsOp', 'plStnsOp']) {
    $opt(id)?.addEventListener('input', readPlanLayerControls);
    $opt(id)?.addEventListener('change', readPlanLayerControls);
  }
  $opt('plTilesOn')?.addEventListener('change', applyPlanTileLayer);
  $opt('plTilesOp')?.addEventListener('input', applyPlanTileLayer);
  $opt('plTilesOp')?.addEventListener('change', applyPlanTileLayer);
  $opt('plZoomSpeed')?.addEventListener('change', applyPlanZoomSpeed);
  $opt('plModeView')?.addEventListener('click', () => setPlanMode('view'));
  $opt('plModeDrag')?.addEventListener('click', () => setPlanMode('drag'));
  $opt('plModeAdd')?.addEventListener('click', () => setPlanMode('add'));
  $opt('plTargetLine')?.addEventListener('change', () => {
    const v = ($opt('plTargetLine') as HTMLSelectElement).value;
    planTargetLineId = v === 'new' ? null : Number(v);
    if (planTargetLineId == null) startNewCreateLine();
    planRepaintAll();
  });

  // -- the plan card: panes, filter, bulk actions --
  $opt('spsPlanTabPts')?.addEventListener('click', () => planShowPane('points'));
  $opt('spsPlanTabChk')?.addEventListener('click', () => planShowPane('checks'));
  $opt('spsPlanTabLeg')?.addEventListener('click', () => planShowPane('lines'));
  $opt('spsPlanLineFilter')?.addEventListener('change', () => {
    const wrap = $opt('spsPlanTblWrap');
    if (wrap) wrap.scrollTop = 0;
    planRenderTable();
  });
  $opt('spsPlanRenumber')?.addEventListener('click', planRenumber);
  $opt('spsPlanSort')?.addEventListener('click', planSortByStation);
  $opt('spsPlanFit')?.addEventListener('click', () => planFit());
  $opt('spsPlanTblWrap')?.addEventListener('scroll', () => {
    // rAF-throttled: a fast scroll fires far more events than frames.
    if (planTblScrollRaf) return;
    planTblScrollRaf = requestAnimationFrame(() => { planTblScrollRaf = 0; planRenderTable(); });
  });
  // Delegated listeners: the table body is rebuilt constantly, so per-row handlers
  // would leak and cost more than the rows themselves.
  $opt('spsPlanTblBody')?.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (!t || !t.dataset || !t.dataset.f) return;
    planEditCell(Number(t.dataset.lid), Number(t.dataset.pi), t.dataset.f, t.value);
  });
  $opt('spsPlanTblBody')?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const act = t?.dataset?.a;
    if (act) { planRowAction(Number(t.dataset.lid), Number(t.dataset.pi), act); return; }
    const row = t?.closest?.('.plan-row') as HTMLElement | null;
    if (row && row.dataset.lid) planSelect({ lineId: Number(row.dataset.lid), idx: Number(row.dataset.pi) });
  });

  // -- plan-level import / export --
  $opt('spsPlanImportBtn')?.addEventListener('click', () => void openPlanImport());
  $opt('spsPlanExpSps')?.addEventListener('click', () => void planExportSps());
  $opt('spsPlanExpCsv')?.addEventListener('click', () => void planExport('csv'));
  $opt('spsPlanExpGeo')?.addEventListener('click', () => void planExport('geojson'));
  $opt('spsPlanExpKml')?.addEventListener('click', () => void planExport('kml'));
  $opt('spsWizardClose')?.addEventListener('click', closeCreateWizard);
  $opt('spsWizardCancel')?.addEventListener('click', closeCreateWizard);
  $opt('spsWizardBack')?.addEventListener('click', (e) => { if (e.target === $opt('spsWizardBack')) closeCreateWizard(); });
  $opt('spsWizardCreate')?.addEventListener('click', () => void confirmCreateWizard());
  $opt('cRelType')?.addEventListener('change', updateCreateRelUI);
  // Survey-type toggle (2D / 3D) - switches the wizard's mode-specific fields.
  $opt('spsCreate2d')?.addEventListener('click', () => setCreateMode('2D'));
  $opt('spsCreate3d')?.addEventListener('click', () => setCreateMode('3D'));
  // Built-in EPSG picker: debounced search; clicking a result fills the spec form.
  $opt('cCrsSearch')?.addEventListener('input', () => {
    if (crsSearchTimer != null) window.clearTimeout(crsSearchTimer);
    crsSearchTimer = window.setTimeout(runCrsSearch, 160);
  });
  initPlanImport();
  planLoadDraft();
  updateCreateCrsBtn();
  setPlanMode('view');
  readPlanLayerControls();
  planShowPane('points');
  planRepaintAll();
}
/** rAF handle for the table's scroll listener. */
let planTblScrollRaf = 0;

// -- Velocity / semblance --
function velGeom(cv: HTMLCanvasElement) {
  return { W: cv.clientWidth || 900, H: cv.clientHeight || 460, ML: 56, MR: 12, MT: 12, MB: 28 };
}

async function computeVelocity() {
  if (!summary || summary.traceCount === 0) {
    $('velLabel').textContent = 'Open a file first.';
    return;
  }
  $('velLabel').textContent = 'Computing…';
  showProgress('Computing velocity scan…');
  try {
    velResult = await api.semblance({ velMin: numVal('velMin') || 1000, velMax: numVal('velMax') || 5000, velStep: numVal('velStep') || 50 });
    $('velLabel').textContent = `${velResult.vels.length} velocities · ${velResult.offNote}`;
    velFit(); // new scan ⇒ auto-fit (clears any stale manual window) + draw
    updateHeaderClear();   // semblance result now present → enable header Clear
  } catch (e) {
    $('velLabel').textContent = 'Failed: ' + errMsg(e);
  } finally {
    hideProgress();
  }
}

function drawVelocity() {
  const cv = $('velCanvas') as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const { W, H, ML, MR, MT, MB } = velGeom(cv);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);
  if (!velResult) return;
  const { semb, vels, nT, dt } = velResult;
  const nV = vels.length;
  const pw = W - ML - MR;
  const ph = H - MT - MB;

  const off = document.createElement('canvas');
  off.width = nV;
  off.height = nT;
  const octx = off.getContext('2d')!;
  const img = octx.createImageData(nV, nT);
  for (let vi = 0; vi < nV; vi++) {
    for (let ti = 0; ti < nT; ti++) {
      const [r, g, b] = getColor(Math.max(0, Math.min(1, semb[vi * nT + ti])) * 2 - 1, 'viridis');
      const idx = (ti * nV + vi) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);

  const m = velMapping();
  if (!m) return;
  const { vLo, vHi, tLo, tHi, dataVLo, dataVHi, dataTHi } = m;
  // Crop the offscreen image (nV wide = velocity, nT tall = time) to the visible
  // [vLo,vHi]×[tLo,tHi] window, stretching it to fill the plot. Source fractions:
  // X across vels dataVLo..dataVHi; Y down time 0..dataTHi.
  const vDataSpan = Math.max(1, dataVHi - dataVLo);
  const tDataSpan = dataTHi || 1;
  const sx0 = (vLo - dataVLo) / vDataSpan, sx1 = (vHi - dataVLo) / vDataSpan;
  const sy0 = tLo / tDataSpan, sy1 = tHi / tDataSpan;
  const cl = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  let sx = cl(sx0) * nV, sw = (cl(sx1) - cl(sx0)) * nV;
  let sy = cl(sy0) * nT, sh = (cl(sy1) - cl(sy0)) * nT;
  if (!(sw >= 1)) { sw = 1; sx = Math.min(sx, nV - 1); }
  if (!(sh >= 1)) { sh = 1; sy = Math.min(sy, nT - 1); }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, sx, sy, sw, sh, ML, MT, pw, ph);

  // Pick markers - map (v,tMs) through the SAME visible window as the click test.
  const vSpan = Math.max(1, vHi - vLo);
  const tSpan = Math.max(1, tHi - tLo);
  ctx.save();
  ctx.beginPath(); ctx.rect(ML, MT, pw, ph); ctx.clip();
  ctx.strokeStyle = '#ff5d6c';
  ctx.lineWidth = 1.5;
  for (const p of velPicks) {
    const x = ML + ((p.v - vLo) / vSpan) * pw;
    const y = MT + ((p.tMs - tLo) / tSpan) * ph;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  ctx.fillText(`${Math.round(vLo)}-${Math.round(vHi)} m/s  (click to pick)`, ML, H - 8);
  for (let k = 0; k <= 4; k++) {
    const y = MT + (ph * k) / 4;
    const tAt = tLo + (tSpan * k) / 4;
    ctx.fillText(tAt.toFixed(0) + ' ms', 4, y + 3);
  }
  syncVelAxisPlaceholders();
}

/** Resolve the velocity panel's visible window: the manual X (velocity, m/s) / Y
 *  (time, ms) boxes when valid, else the full semblance extent. Returns both the
 *  visible [vLo,vHi]×[tLo,tHi] AND the full data extent (for the blit crop), all
 *  ordered + clamped. null when there's no result. Shared by draw + click so picks
 *  always land on the right (v,t) regardless of the active range. */
function velMapping(): {
  vLo: number; vHi: number; tLo: number; tHi: number;
  dataVLo: number; dataVHi: number; dataTHi: number;
} | null {
  if (!velResult) return null;
  const { vels, nT, dt } = velResult;
  const dataVLo = vels[0];
  const dataVHi = vels[vels.length - 1];
  const dataTHi = nT * dt * 1000;
  const wv = heatAxisWindow(velView.v0, velView.v1, dataVLo, dataVHi);
  const wt = heatAxisWindow(velView.t0, velView.t1, 0, dataTHi);
  return { vLo: wv.lo, vHi: wv.hi, tLo: wt.lo, tHi: wt.hi, dataVLo, dataVHi, dataTHi };
}

/** Push the velocity panel's effective window into its boxes as placeholders. */
function syncVelAxisPlaceholders() {
  if (!velAxisRange) return;
  const m = velMapping();
  if (!m) return;
  velAxisRange.setPlaceholders(m.vLo, m.vHi, m.tLo, m.tHi);
}

/** Apply the velocity manual X (velocity) / Y (time) boxes into velView, redraw.
 *  Each axis: a valid pair pins it; blank/invalid reverts that axis to auto. */
function applyVelAxisRange() {
  if (!velAxisRange) return;
  const v = velAxisRange.value();
  velView.v0 = v.xMin; velView.v1 = v.xMax;
  velView.t0 = v.yMin; velView.t1 = v.yMax;
  drawVelocity();
}

/** Wheel-zoom the velocity panel toward the cursor (X = velocity, Y = time). Seeds
 *  null edges from the data extent, narrows/widens by `factor` (<1 = in), clamps
 *  in-extent. Reuses the heatmap zoom math on a SpecRange view so picks stay valid. */
function velZoomAt(fx: number, fy: number, factor: number) {
  if (!velResult) return;
  const { vels, nT, dt } = velResult;
  const ext: HeatExtent = { xLo: vels[0], xHi: vels[vels.length - 1], yLo: 0, yHi: nT * dt * 1000 };
  // Bridge velView (v0/v1/t0/t1) ↔ a SpecRange so heatZoomAt can drive it.
  const view: SpecRange = { x0: velView.v0, x1: velView.v1, y0: velView.t0, y1: velView.t1 };
  heatZoomAt(view, ext, fx, fy, factor, false); // time axis runs down (not yUp)
  velView.v0 = view.x0; velView.v1 = view.x1; velView.t0 = view.y0; velView.t1 = view.y1;
  drawVelocity();
}

/** Toolbar +/- zoom (centred) for the velocity panel. */
function velZoomButton(factor: number) { if (velResult) velZoomAt(0.5, 0.5, factor); }

/** Reset the velocity panel to auto-fit (clear boxes + range state). */
function velFit() {
  velView.v0 = velView.v1 = velView.t0 = velView.t1 = null;
  velAxisRange?.clear();
  drawVelocity();
}

/** Wire the velocity panel's wheel-zoom + zoom buttons + manual X/Y range boxes
 *  (called once from init). Click-to-pick stays on its own handler. */
function velInteractions() {
  const cv = $('velCanvas') as HTMLCanvasElement;
  cv.addEventListener('wheel', (e) => {
    if ($('panel-vel').style.display === 'none' || !velResult) return;
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const { ML, MR, MT, MB } = velGeom(cv);
    const W = cv.clientWidth || 900, H = cv.clientHeight || 460;
    const pw = W - ML - MR, ph = H - MT - MB;
    if (pw <= 0 || ph <= 0) return;
    const fx = (e.clientX - r.left - ML) / pw, fy = (e.clientY - r.top - MT) / ph;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
    velZoomAt(fx, fy, e.deltaY < 0 ? 1 / 1.15 : 1.15);
  }, { passive: false });
  cv.addEventListener('dblclick', () => { if (velResult) velFit(); });
  $opt('velZoomIn')?.addEventListener('click', () => velZoomButton(1 / 1.4));
  $opt('velZoomOut')?.addEventListener('click', () => velZoomButton(1.4));
  $opt('velZoomFit')?.addEventListener('click', () => velFit());
  const axHost = $opt('velAxisRange');
  if (axHost) {
    velAxisRange = axisRangeControls(axHost, {
      xLabel: 'Vel m/s', yLabel: 'Time ms',
      xStep: '1', yStep: 'any',
      onChange: () => applyVelAxisRange(),
    });
  }
}

function onVelClick(e: MouseEvent) {
  if (!velResult) return;
  const cv = $('velCanvas') as HTMLCanvasElement;
  const rect = cv.getBoundingClientRect();
  const { ML, MR, MT, MB } = velGeom(cv);
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  const pw = W - ML - MR;
  const ph = H - MT - MB;
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  if (px < ML || px > ML + pw || py < MT || py > MT + ph) return;
  const m = velMapping();
  if (!m) return;
  const { vLo, vHi, tLo, tHi } = m;
  // Map the click through the SAME visible window the draw used, so a pick lands
  // on the v,t under the cursor even when a manual range is zoomed in.
  const vSpan = Math.max(1, vHi - vLo);
  const tSpan = Math.max(1, tHi - tLo);
  const v = Math.round(vLo + ((px - ML) / pw) * vSpan);
  const tMs = Math.round(tLo + ((py - MT) / ph) * tSpan);
  const near = velPicks.findIndex((p) => {
    const x = ML + ((p.v - vLo) / vSpan) * pw;
    const y = MT + ((p.tMs - tLo) / tSpan) * ph;
    return Math.hypot(px - x, py - y) < 12;
  });
  if (near >= 0) {
    // Removing an existing pick is a delete → confirm + undo (provenance).
    void velRemovePick(near);
  } else {
    velPicks.push({ v, tMs });
    drawVelocity();
    renderVelPicks();
  }
}

/** Confirmed, audited, undoable removal of velocity pick at index `idx`. */
async function velRemovePick(idx: number) {
  const saved = velPicks[idx];
  if (!saved) return;
  const what = `velocity pick ${saved.v} m/s @ ${saved.tMs} ms`;
  if (!(await confirmDelete(`Delete ${what}?`))) return;
  // The array may have shifted while the dialog was open; re-find by identity.
  const pos = velPicks.indexOf(saved);
  if (pos < 0) return;
  velPicks.splice(pos, 1);
  drawVelocity();
  renderVelPicks();
  audit('delete', what, 'vel');
  let undone = false;
  undoToast(`Deleted ${what}`, () => {
    if (undone) return;
    undone = true;
    const at = Math.min(pos, velPicks.length);
    velPicks.splice(at, 0, saved);
    drawVelocity();
    renderVelPicks();
    audit('undo-delete', what, 'vel');
  });
}

function renderVelPicks() {
  updateHeaderClear();   // picks changed → refresh header Clear state
  const el = $('velPicks');
  el.innerHTML = '';
  for (const p of velPicks.slice().sort((a, b) => a.tMs - b.tMs)) {
    const row = document.createElement('div');
    row.className = 'qc-row ok';
    const a = document.createElement('span');
    a.className = 'qc-sev';
    a.textContent = p.tMs + ' ms';
    const b = document.createElement('span');
    b.className = 'qc-cat';
    b.textContent = p.v + ' m/s';
    row.appendChild(a);
    row.appendChild(b);
    row.appendChild(document.createElement('span'));
    el.appendChild(row);
  }
}

/** Clear the velocity tab's own state: drop the semblance result + picks,
 *  clear the picks list, then repaint the now-empty velocity panel. The open
 *  seismic file is left untouched (use the Converter clear for that). */
function clearVelocity() {
  velResult = null;
  velPicks = [];
  velView.v0 = velView.v1 = velView.t0 = velView.t1 = null;
  velAxisRange?.clear();
  renderVelPicks();
  drawVelocity();
  $('velLabel').textContent = 'Open a file, then compute a velocity scan.';
}

async function exportPicks() {
  if (!velPicks.length) {
    $('velLabel').textContent = 'No picks to export.';
    return;
  }
  const csv = 't_ms,v_ms\n' + velPicks.slice().sort((a, b) => a.tMs - b.tMs).map((p) => `${p.tMs},${p.v}`).join('\n') + '\n';
  try {
    const r = await api.exportText('velocity_picks.csv', csv);
    if (r.ok) { $('velLabel').textContent = '✓ Saved ' + r.path; audit('export', `velocity picks (${velPicks.length}) → ${r.path}`, 'vel'); }
    else $('velLabel').textContent = r.canceled ? '' : 'Failed: ' + (r.error || 'unknown');
  } catch (e) {
    $('velLabel').textContent = 'Failed: ' + errMsg(e);
  }
}

// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
//  SPECTRUM ANALYSIS
//  Three frequency-domain QC views of the open file, switched by a segmented
//  control: the record's AVERAGE amplitude spectrum (shares the Trace Inspector's
//  drawSpectrum renderer), a single-trace SPECTROGRAM (STFT heatmap), and the
//  section's F-K (frequency-wavenumber) spectrum. The two heatmaps clone
//  drawVelocity's approach: fill an offscreen ImageData via getColor(...,'viridis')
//  and blit it (unsmoothed) into the plot rect, with axis labels + a colorbar.
// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

const SPEC_M = { ML: 56, MR: 64, MT: 14, MB: 30 }; // shared plot-rect margins (MR leaves room for the colorbar)

/** Set the active display (segmented control) and (re)fetch/paint it. */
function setSpecDisplay(d: SpecDisplay) {
  if (specDisplay === d) return;
  specDisplay = d;
  $opt('specDispAvg')?.classList.toggle('on', d === 'avg');
  $opt('specDispGram')?.classList.toggle('on', d === 'spectrogram');
  $opt('specDispFk')?.classList.toggle('on', d === 'fk');
  // Toggle which per-display control group is visible.
  $opt('specCtlsAvg')?.classList.toggle('hidden', d !== 'avg');
  $opt('specCtlsGram')?.classList.toggle('hidden', d !== 'spectrogram');
  $opt('specCtlsFk')?.classList.toggle('hidden', d !== 'fk');
  // The f-k explanatory note only applies to the F-K view.
  $opt('specFkNote')?.classList.toggle('hidden', d !== 'fk');
  // If a compute is already running, the active refresher will early-return on
  // specBusy; flag a rerun so its finally re-dispatches and paints THIS display.
  if (specBusy) { specRerunPending = true; return; }
  void refreshSpectrum();
}

/** Fetch (if needed) + paint whichever spectrum display is active. Requires an
 *  open file; otherwise paints the empty-state placeholder. */
async function refreshSpectrum() {
  if (!summary || summary.traceCount === 0) { drawSpecEmpty(); $('specLabel').textContent = 'Open a seismic file to analyse its spectrum.'; return; }
  if (specDisplay === 'avg') return refreshSpecAvg();
  if (specDisplay === 'spectrogram') return refreshSpecGram();
  return refreshSpecFk();
}

/** AVERAGE amplitude spectrum: fetch the mean spectrum, draw via the SHARED
 *  drawSpectrum renderer (dB|linear toggle, peak + bandwidth markers). */
async function refreshSpecAvg() {
  if (specBusy) return;
  // Optional trace-range window (blank = whole file).
  const t0i = ($opt('specTr0') as HTMLInputElement | null)?.value.trim();
  const t1i = ($opt('specTr1') as HTMLInputElement | null)?.value.trim();
  const opts: { traceStart?: number; traceEnd?: number } = {};
  if (t0i) opts.traceStart = Math.max(0, parseInt(t0i, 10) || 0);
  if (t1i) opts.traceEnd = Math.max(0, parseInt(t1i, 10) || 0);
  specBusy = true;
  $('specLabel').textContent = 'Computing average spectrum…';
  showProgress('Computing average spectrum…');
  try {
    specAvg = await api.avgSpectrum(opts);
    specAvgFit(); // new data ⇒ auto-fit (clears any stale manual window) + draw
    $('specLabel').textContent = specAvg.log || `Average over ${specAvg.nTraces} traces.`;
    updateHeaderClear();
  } catch (e) {
    $('specLabel').textContent = 'Failed: ' + errMsg(e);
  } finally { hideProgress(); specBusy = false; if (specRerunPending) { specRerunPending = false; void refreshSpectrum(); } }
}

/** Auto-fit extent of the Average view in DISPLAYED units (X = frequency Hz,
 *  Y = amplitude - linear peak, or dB FLOOR..0 per specDb). Used to seed the
 *  wheel-zoom from a null edge and to populate the box placeholders. */
function specAvgAutoExtent(): { f0: number; f1: number; a0: number; a1: number } {
  const sp = specAvg;
  if (!sp) return { f0: 0, f1: 1, a0: 0, a1: 1 };
  const f1 = sp.nyquist || 1;
  if (specDb) return { f0: 0, f1, a0: -60, a1: 0 };
  let amax = 0;
  for (let k = 1; k < sp.amp.length; k++) if (sp.amp[k] > amax) amax = sp.amp[k];
  if (!(amax > 0)) amax = 1;
  return { f0: 0, f1, a0: 0, a1: amax };
}

/** Repaint the cached average spectrum (no fetch) - used on dB toggle / resize. */
function drawSpecAvg() {
  const cv = $('specCanvas') as HTMLCanvasElement;
  if (!specAvg) { drawSpecEmpty(); return; }
  drawSpectrum(cv, specAvg, {
    dB: specDb,
    label: `mean of ${specAvg.nTraces} traces${specAvg.decimated ? ' (decimated)' : ''}`,
    fMin: specAvgView.x0, fMax: specAvgView.x1,
    aMin: specAvgView.y0, aMax: specAvgView.y1,
  });
  syncSpecAvgPlaceholders();
}

/** Reflect the Average view's effective window (manual edges or the live auto
 *  extent) as the box placeholders, so blank boxes still show the current range. */
function syncSpecAvgPlaceholders() {
  if (!specAvgAxis || !specAvg) return;
  const e = specAvgAutoExtent();
  specAvgAxis.setPlaceholders(
    specAvgView.x0 ?? e.f0, specAvgView.x1 ?? e.f1,
    specAvgView.y0 ?? e.a0, specAvgView.y1 ?? e.a1,
  );
}

/** Apply the Average view's manual X/Y boxes into specAvgView, then repaint.
 *  Each axis: a valid pair pins it; blank/invalid reverts that axis to auto. */
function applySpecAvgAxis() {
  if (!specAvgAxis) return;
  const v = specAvgAxis.value();
  specAvgView.x0 = v.xMin; specAvgView.x1 = v.xMax;
  specAvgView.y0 = v.yMin; specAvgView.y1 = v.yMax;
  if (specAvg) drawSpecAvg();
}

/** Wheel-zoom the Average view toward the cursor on the chosen axis pair. The
 *  null (auto) edges are first seeded from the live extent, then the window is
 *  narrowed/widened by `factor` (<1 = zoom in) and clamped so it never inverts
 *  or exceeds the data. Writes specAvgView (the same state the boxes drive). */
function specAvgZoomAt(fx: number, fy: number, factor: number) {
  if (!specAvg) return;
  const e = specAvgAutoExtent();
  // Current window (seed any auto edge from the extent).
  let x0 = specAvgView.x0 ?? e.f0, x1 = specAvgView.x1 ?? e.f1;
  let y0 = specAvgView.y0 ?? e.a0, y1 = specAvgView.y1 ?? e.a1;
  // X about the cursor.
  const ax = x0 + fx * (x1 - x0), wx = (x1 - x0) * factor;
  x0 = ax - fx * wx; x1 = ax + (1 - fx) * wx;
  // Y about the cursor (fy=0 at top = a1 / high amplitude).
  const ay = y1 - fy * (y1 - y0), wy = (y1 - y0) * factor;
  y1 = ay + fy * wy; y0 = ay - (1 - fy) * wy;
  // Clamp to the data extent + a minimum span so we never zoom to zero width.
  const minX = Math.max(1e-6, (e.f1 - e.f0) * 1e-3);
  const minY = Math.max(1e-9, (e.a1 - e.a0) * 1e-3);
  x0 = Math.max(e.f0, x0); x1 = Math.min(e.f1, x1); if (x1 - x0 < minX) { x1 = Math.min(e.f1, x0 + minX); x0 = x1 - minX; }
  y0 = Math.max(e.a0, y0); y1 = Math.min(e.a1, y1); if (y1 - y0 < minY) { y1 = Math.min(e.a1, y0 + minY); y0 = y1 - minY; }
  specAvgView.x0 = x0; specAvgView.x1 = x1; specAvgView.y0 = y0; specAvgView.y1 = y1;
  drawSpecAvg();
}

/** Reset the Average view to auto-fit (clear boxes + view state). */
function specAvgFit() {
  specAvgView.x0 = specAvgView.x1 = specAvgView.y0 = specAvgView.y1 = null;
  specAvgAxis?.clear();
  if (specAvg) drawSpecAvg();
}

// -- Heatmap (Spectrogram + F-K) range / zoom: both share a {x0,x1,y0,y1} view
//    over a payload extent {x:[xLo,xHi], y:[yLo,yHi]}. These generic helpers drive
//    both, so the box-apply / wheel-zoom / fit logic lives in one guarded place. --
type HeatExtent = { xLo: number; xHi: number; yLo: number; yHi: number };

/** Push the heatmap's effective window (manual edges or live extent) into its
 *  boxes as placeholders (blank boxes still mean auto). */
function syncHeatPlaceholders(axis: AxisRangeHandle | null, view: SpecRange, ext: HeatExtent) {
  axis?.setPlaceholders(view.x0 ?? ext.xLo, view.x1 ?? ext.xHi, view.y0 ?? ext.yLo, view.y1 ?? ext.yHi);
}

/** Apply a heatmap view's manual X/Y boxes into its range state (each axis null ⇒
 *  auto), then repaint via `redraw`. */
function applyHeatAxis(axis: AxisRangeHandle | null, view: SpecRange, redraw: () => void) {
  if (!axis) return;
  const v = axis.value();
  // Per-axis independence: a null pair means that axis was NOT edited (the boxes
  // only report dirty edges, and wheel/button zoom writes view fields without
  // marking the boxes dirty). Overwriting an unedited axis with null would wipe a
  // live zoom on the OTHER axis, so only write the axis pair that is present.
  if (v.xMin !== null && v.xMax !== null) { view.x0 = v.xMin; view.x1 = v.xMax; }
  if (v.yMin !== null && v.yMax !== null) { view.y0 = v.yMin; view.y1 = v.yMax; }
  redraw();
}

/** Wheel-zoom a heatmap view toward the cursor (fx,fy in 0..1 over the plot, fy=0
 *  at the top). `yUp` flips Y so fy=0 maps to the HIGH edge (F-K's freq-up axis).
 *  Seeds auto edges from the extent, narrows/widens by `factor`, clamps in-extent
 *  with a minimum span. Writes the same state the boxes drive. */
function heatZoomAt(view: SpecRange, ext: HeatExtent, fx: number, fy: number, factor: number, yUp: boolean) {
  let x0 = view.x0 ?? ext.xLo, x1 = view.x1 ?? ext.xHi;
  let y0 = view.y0 ?? ext.yLo, y1 = view.y1 ?? ext.yHi;
  const ax = x0 + fx * (x1 - x0), wx = (x1 - x0) * factor;
  x0 = ax - fx * wx; x1 = ax + (1 - fx) * wx;
  // For yUp, fy=0 (top) anchors the high edge; otherwise fy=0 anchors the low edge.
  const fyTop = yUp ? (1 - fy) : fy;
  const ay = y0 + fyTop * (y1 - y0), wy = (y1 - y0) * factor;
  y0 = ay - fyTop * wy; y1 = ay + (1 - fyTop) * wy;
  const minX = Math.max(1e-9, (ext.xHi - ext.xLo) * 1e-3);
  const minY = Math.max(1e-9, (ext.yHi - ext.yLo) * 1e-3);
  x0 = Math.max(ext.xLo, x0); x1 = Math.min(ext.xHi, x1); if (x1 - x0 < minX) { x1 = Math.min(ext.xHi, x0 + minX); x0 = x1 - minX; }
  y0 = Math.max(ext.yLo, y0); y1 = Math.min(ext.yHi, y1); if (y1 - y0 < minY) { y1 = Math.min(ext.yHi, y0 + minY); y0 = y1 - minY; }
  view.x0 = x0; view.x1 = x1; view.y0 = y0; view.y1 = y1;
}

/** Clear a heatmap view + its boxes (auto-fit), then repaint. */
function heatFit(axis: AxisRangeHandle | null, view: SpecRange, redraw: () => void) {
  view.x0 = view.x1 = view.y0 = view.y1 = null;
  axis?.clear();
  redraw();
}

/** Live data extent of the spectrogram (X = freq 0..fMax, Y = time 0..tMax). */
function specGramExtent(): HeatExtent {
  const g = specGram;
  const fMax = g && g.freqs.length ? g.freqs[g.freqs.length - 1] : 1;
  const tMax = g && g.times.length ? g.times[g.times.length - 1] : 1;
  return { xLo: 0, xHi: fMax || 1, yLo: 0, yHi: tMax || 1 };
}
function syncSpecGramPlaceholders() { if (specGram) syncHeatPlaceholders(specGramAxis, specGramView, specGramExtent()); }

/** Live data extent of the F-K panel (X = kx kMin..kMax, Y = freq 0..fMax). */
function specFkExtent(): HeatExtent {
  const fk = specFk;
  const kMin = fk && fk.kAxis.length ? fk.kAxis[0] : -0.5;
  const kMax = fk && fk.kAxis.length ? fk.kAxis[fk.kAxis.length - 1] : 0.5;
  const fMax = fk && fk.fAxis.length ? fk.fAxis[fk.fAxis.length - 1] : 1;
  return { xLo: kMin, xHi: kMax, yLo: 0, yHi: fMax || 1 };
}
function syncSpecFkPlaceholders() { if (specFk) syncHeatPlaceholders(specFkAxis, specFkView, specFkExtent()); }

/** SPECTROGRAM: fetch the STFT of the current trace, draw a time×frequency
 *  heatmap (cloning drawVelocity's offscreen-ImageData approach). */
async function refreshSpecGram() {
  if (specBusy || !summary) return;
  specTraceIdx = Math.max(0, Math.min(summary.traceCount - 1, specTraceIdx));
  // Clamp the window to an absolute ceiling (the worker enforces the same cap, but
  // bounding it here keeps the control from requesting an absurd FFT size).
  const winLen = Math.min(65536, Math.max(8, parseInt(($opt('specWin') as HTMLInputElement | null)?.value || '128', 10) || 128));
  specBusy = true;
  $('specLabel').textContent = 'Computing spectrogram…';
  showProgress('Computing spectrogram…');
  try {
    specGram = await api.spectrogram({ index: specTraceIdx, winLen });
    heatFit(specGramAxis, specGramView, () => drawSpecGram()); // new data ⇒ auto-fit + draw
    const ny = specGram.siUs > 0 ? 1e6 / specGram.siUs / 2 : 0;
    $('specLabel').textContent = `Trace ${specTraceIdx + 1} / ${summary.traceCount} · ${specGram.nFrames} frames × ${specGram.nBins} bins · 0-${ny.toFixed(0)} Hz`;
    const idIn = $opt('specTraceIdx') as HTMLInputElement | null; if (idIn) idIn.value = String(specTraceIdx);
  } catch (e) {
    $('specLabel').textContent = 'Failed: ' + errMsg(e);
  } finally { hideProgress(); specBusy = false; if (specRerunPending) { specRerunPending = false; void refreshSpectrum(); } }
}

function drawSpecGram() {
  const cv = $('specCanvas') as HTMLCanvasElement;
  const { ctx, W, H, plot } = setupHeatmapCanvas(cv);
  if (!specGram || specGram.nFrames === 0 || specGram.nBins === 0) { drawSpecEmpty(); return; }
  const { mag, nFrames, nBins, times, freqs, maxMag } = specGram;
  // Offscreen image is nBins (x = freq) × nFrames (y = time): one pixel per cell.
  // mag is row-major nFrames×nBins, so cell (frame f, bin k) = mag[f*nBins+k].
  const off = document.createElement('canvas');
  off.width = nBins; off.height = nFrames;
  const octx = off.getContext('2d')!;
  const img = octx.createImageData(nBins, nFrames);
  const inv = maxMag > 0 ? 1 / maxMag : 1;
  for (let f = 0; f < nFrames; f++) {
    const base = f * nBins;
    for (let k = 0; k < nBins; k++) {
      const [r, g, b] = getColor(Math.max(0, Math.min(1, mag[base + k] * inv)) * 2 - 1, 'viridis');
      const idx = (f * nBins + k) * 4;
      img.data[idx] = r; img.data[idx + 1] = g; img.data[idx + 2] = b; img.data[idx + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  // Data extent: X = frequency 0..fMax (left→right), Y = time 0..tMax (top→bottom).
  const fMax = freqs.length ? freqs[freqs.length - 1] : 0;
  const tMax = times.length ? times[times.length - 1] : 0;
  // Visible window from the manual X (freq) / Y (time) boxes (or full extent).
  const wx = heatAxisWindow(specGramView.x0, specGramView.x1, 0, fMax);
  const wy = heatAxisWindow(specGramView.y0, specGramView.y1, 0, tMax);
  // Crop the offscreen image to the window: X 0..fMax → 0..1; Y 0..tMax (top→bottom) → 0..1.
  const fSpan = fMax || 1, tSpan = tMax || 1;
  blitHeatCrop(ctx, off, plot, { sx0: wx.lo / fSpan, sx1: wx.hi / fSpan, sy0: wy.lo / tSpan, sy1: wy.hi / tSpan });
  ctx.strokeStyle = '#214564'; ctx.lineWidth = 1; ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);

  // Axes labelled over the visible window.
  drawHeatAxesXY(ctx, plot, {
    xLabel: 'Frequency (Hz) →', xMin: wx.lo, xMax: wx.hi,
    yLabel: 'Time (s) ↓', yMin: wy.lo, yMax: wy.hi, yUp: false,
  });
  drawColorbar(ctx, plot, W, 'magnitude');
  syncSpecGramPlaceholders();
}

/** F-K spectrum: fetch + draw a wavenumber(kx)×frequency(f) heatmap (kx centred
 *  at 0). Apparent velocity = f/kx (slope); dip + aliasing read off the panel. */
async function refreshSpecFk() {
  if (specBusy) return;
  specBusy = true;
  $('specLabel').textContent = 'Computing f-k spectrum…';
  showProgress('Computing F-K spectrum…');
  try {
    specFk = await api.fk({});
    heatFit(specFkAxis, specFkView, () => drawSpecFk()); // new data ⇒ auto-fit + draw
    $('specLabel').textContent = specFk.log || `f-k grid ${specFk.nF}×${specFk.nKx}.`;
  } catch (e) {
    $('specLabel').textContent = 'Failed: ' + errMsg(e);
  } finally { hideProgress(); specBusy = false; if (specRerunPending) { specRerunPending = false; void refreshSpectrum(); } }
}

function drawSpecFk() {
  const cv = $('specCanvas') as HTMLCanvasElement;
  const { ctx, W, H, plot } = setupHeatmapCanvas(cv);
  if (!specFk || specFk.nF === 0 || specFk.nKx === 0) { drawSpecEmpty(); return; }
  const { mag, nKx, nF, kAxis, fAxis, maxMag } = specFk;
  // Offscreen image is nKx (x = wavenumber) × nF (y = frequency). mag is row-major
  // nF×nKx, so cell (freq f, wavenumber c) = mag[f*nKx+c]. Log-compress amplitude
  // so the (huge) DC/low-freq energy doesn't wash out the panel.
  const off = document.createElement('canvas');
  off.width = nKx; off.height = nF;
  const octx = off.getContext('2d')!;
  const img = octx.createImageData(nKx, nF);
  const logMax = Math.log1p(maxMag > 0 ? maxMag : 1);
  for (let f = 0; f < nF; f++) {
    const base = f * nKx;
    for (let c = 0; c < nKx; c++) {
      const v = logMax > 0 ? Math.log1p(mag[base + c]) / logMax : 0;
      const [r, g, b] = getColor(Math.max(0, Math.min(1, v)) * 2 - 1, 'viridis');
      // Flip y so f = 0 sits at the BOTTOM (frequency increases upward, the usual
      // f-k convention). Source row f → image row (nF-1-f).
      const idx = ((nF - 1 - f) * nKx + c) * 4;
      img.data[idx] = r; img.data[idx + 1] = g; img.data[idx + 2] = b; img.data[idx + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  // Data extent: X = wavenumber kMin..kMax (left→right), Y = frequency 0..fMax
  // (0 at the BOTTOM, since image rows were flipped above).
  const kMin = kAxis.length ? kAxis[0] : -0.5;
  const kMax = kAxis.length ? kAxis[kAxis.length - 1] : 0.5;
  const fMax = fAxis.length ? fAxis[fAxis.length - 1] : 0;
  // Visible window from the manual X (kx) / Y (freq) boxes (or full extent).
  const wx = heatAxisWindow(specFkView.x0, specFkView.x1, kMin, kMax);
  const wy = heatAxisWindow(specFkView.y0, specFkView.y1, 0, fMax);
  // Crop the offscreen image. X: kMin..kMax → 0..1 across columns. Y: the image is
  // freq-flipped (row 0 = fMax at top, row last = 0 at bottom), so a [yLo,yHi]
  // freq window maps to source fractions sy0=(fMax-yHi)/fMax (top), sy1=(fMax-yLo)/fMax.
  const kSpan = kMax - kMin || 1, fSpan = fMax || 1;
  blitHeatCrop(ctx, off, plot, {
    sx0: (wx.lo - kMin) / kSpan, sx1: (wx.hi - kMin) / kSpan,
    sy0: (fMax - wy.hi) / fSpan, sy1: (fMax - wy.lo) / fSpan,
  });
  ctx.strokeStyle = '#214564'; ctx.lineWidth = 1; ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);

  // Axes labelled over the visible window.
  drawHeatAxesXY(ctx, plot, {
    xLabel: 'Wavenumber kx (cyc/trace) →', xMin: wx.lo, xMax: wx.hi,
    yLabel: 'Frequency (Hz) ↑', yMin: wy.lo, yMax: wy.hi, yUp: true,
  });
  // kx = 0 centre line - only when 0 falls inside the visible kx window.
  if (wx.lo < 0 && wx.hi > 0) {
    const kZeroX = plot.x + ((0 - wx.lo) / (wx.hi - wx.lo)) * plot.w;
    ctx.strokeStyle = 'rgba(255,180,84,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(kZeroX, plot.y); ctx.lineTo(kZeroX, plot.y + plot.h); ctx.stroke();
    ctx.setLineDash([]);
  }
  drawColorbar(ctx, plot, W, 'log |F|');

  ctx.fillStyle = '#9fb0c4'; ctx.font = '10px "Segoe UI", sans-serif';
  ctx.fillText('Slope f/kx = apparent velocity · steep dips ↔ aliasing at the kx edges', plot.x + 4, plot.y + plot.h + 22);
  syncSpecFkPlaceholders();
}

// -- Heatmap helpers (shared by the spectrogram + f-k panels) --

/** Resolve one heatmap axis to a visible [lo,hi] window: the manual edges when
 *  both finite + ordered, else the full data extent [dLo,dHi]. Always returns an
 *  ordered, in-extent pair (clamped) - never NaN - so the blit-crop + axis labels
 *  stay valid even with a stale/garbage box (the helper already guards, this is a
 *  belt-and-braces second line of defence). */
function heatAxisWindow(manualLo: number | null, manualHi: number | null, dLo: number, dHi: number): { lo: number; hi: number } {
  const span = dHi - dLo;
  if (!(span > 0)) return { lo: dLo, hi: dLo + 1 }; // degenerate extent ⇒ unit window
  let lo = (typeof manualLo === 'number' && Number.isFinite(manualLo)) ? manualLo : dLo;
  let hi = (typeof manualHi === 'number' && Number.isFinite(manualHi)) ? manualHi : dHi;
  if (!(hi > lo)) { lo = dLo; hi = dHi; }
  // Clamp inside the data and keep a minimum span (0.1% of the extent).
  const minW = span * 1e-3;
  lo = Math.max(dLo, Math.min(lo, dHi - minW));
  hi = Math.min(dHi, Math.max(hi, lo + minW));
  return { lo, hi };
}

/** Blit a cropped sub-rectangle of the offscreen heatmap into the plot rect,
 *  stretching the visible source window to fill the axes. `srcFrac` gives the
 *  crop in 0..1 source fractions (sx0<sx1 left→right, sy0<sy1 top→bottom of the
 *  OFFSCREEN image). All values are pre-clamped to [0,1] with a ≥1px source span
 *  so drawImage never gets a zero/negative rect (which throws). */
function blitHeatCrop(
  ctx: CanvasRenderingContext2D,
  off: HTMLCanvasElement,
  plot: { x: number; y: number; w: number; h: number },
  srcFrac: { sx0: number; sx1: number; sy0: number; sy1: number },
) {
  const cl = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  const sx0 = cl(srcFrac.sx0), sx1 = cl(srcFrac.sx1), sy0 = cl(srcFrac.sy0), sy1 = cl(srcFrac.sy1);
  let sx = sx0 * off.width, sw = (sx1 - sx0) * off.width;
  let sy = sy0 * off.height, sh = (sy1 - sy0) * off.height;
  if (!(sw >= 1)) { sw = 1; sx = Math.min(sx, off.width - 1); }
  if (!(sh >= 1)) { sh = 1; sy = Math.min(sy, off.height - 1); }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, sx, sy, sw, sh, plot.x, plot.y, plot.w, plot.h);
}

/** DPR-correct size the spectrum canvas, paint the dark background, and return a
 *  drawing context + the inner plot rectangle (margins from SPEC_M). */
function setupHeatmapCanvas(cv: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; W: number; H: number; plot: { x: number; y: number; w: number; h: number } } {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 900, H = cv.clientHeight || 460;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33'; ctx.fillRect(0, 0, W, H);
  const { ML, MR, MT, MB } = SPEC_M;
  return { ctx, W, H, plot: { x: ML, y: MT, w: W - ML - MR, h: H - MT - MB } };
}

/** Empty-state placeholder for the spectrum canvas (no file / no data). */
function drawSpecEmpty() {
  const cv = $('specCanvas') as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 900, H = cv.clientHeight || 460;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#5e7186'; ctx.font = '13px Consolas, monospace'; ctx.textAlign = 'center';
  ctx.fillText('Open a seismic file to analyse its spectrum', W / 2, H / 2);
  ctx.textAlign = 'left';
}

/** General heatmap axis labels: X from xMin→xMax, Y from yMin→yMax. `yUp` puts
 *  yMin at the bottom (frequency-up convention); otherwise yMin is at the top. */
function drawHeatAxesXY(
  ctx: CanvasRenderingContext2D,
  plot: { x: number; y: number; w: number; h: number },
  a: { xLabel: string; xMin: number; xMax: number; yLabel: string; yMin: number; yMax: number; yUp: boolean },
) {
  ctx.font = '10px Consolas, monospace';
  // X ticks.
  const xSpan = a.xMax - a.xMin || 1;
  const xStep = niceStep(xSpan, 8);
  const xStart = Math.ceil(a.xMin / xStep) * xStep;
  for (let v = xStart; v <= a.xMax + 1e-6; v += xStep) {
    const x = plot.x + ((v - a.xMin) / xSpan) * plot.w;
    if (x < plot.x - 0.5 || x > plot.x + plot.w + 0.5) continue;
    ctx.strokeStyle = 'rgba(33,69,100,0.35)';
    ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
    ctx.fillStyle = '#5e7186'; ctx.textAlign = 'center';
    ctx.fillText(Math.abs(v) < 1 && v !== 0 ? v.toFixed(2) : v.toFixed(0), x, plot.y + plot.h + 14);
  }
  ctx.textAlign = 'left';
  // Y ticks.
  const ySpan = a.yMax - a.yMin || 1;
  for (let g = 0; g <= 4; g++) {
    const frac = g / 4;
    const y = plot.y + frac * plot.h;
    const val = a.yUp ? a.yMax - frac * ySpan : a.yMin + frac * ySpan;
    ctx.strokeStyle = 'rgba(33,69,100,0.35)';
    ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
    ctx.fillStyle = '#5e7186';
    ctx.fillText(Math.abs(val) < 1 && val !== 0 ? val.toFixed(2) : val.toFixed(0), 4, y + 3);
  }
  // Axis titles. The X title sits above the plot (top-left). The Y title used to
  // share that same top-left line at x=4, so a long Y label (e.g. "Frequency (Hz) ↑")
  // ran right under the X label ("Wavenumber kx … →") and the two collided. Draw the
  // Y title rotated along the left margin, vertically centred, so they never overlap.
  ctx.fillStyle = '#7e93ac';
  ctx.fillText(a.xLabel, plot.x, plot.y - 4);
  ctx.save();
  ctx.translate(plot.x - 13, plot.y + plot.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(a.yLabel, 0, 0);
  ctx.restore();
}

/** Vertical viridis colorbar (0..1 normalized) to the right of the plot rect. */
function drawColorbar(ctx: CanvasRenderingContext2D, plot: { x: number; y: number; w: number; h: number }, W: number, label: string) {
  const bw = 12, bh = Math.min(plot.h, 160);
  const x0 = plot.x + plot.w + 14, y0 = plot.y + (plot.h - bh) / 2;
  for (let p = 0; p < bh; p++) {
    const t = 1 - p / (bh - 1); // 1 at top → 0 at bottom
    const [r, g, b] = colorViridis(t * 2 - 1);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x0, y0 + p, bw, 1);
  }
  ctx.strokeStyle = 'rgba(200,210,224,0.5)'; ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, bw, bh);
  ctx.fillStyle = '#c8d2e0'; ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'left';
  ctx.fillText('hi', x0 + bw + 4, y0 + 8);
  ctx.fillText('lo', x0 + bw + 4, y0 + bh);
  ctx.fillStyle = '#9fb0c4'; ctx.save(); ctx.translate(x0 + bw + 26, y0 + bh / 2); ctx.rotate(Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillText(label, 0, 0); ctx.restore(); ctx.textAlign = 'left';
}

/** Repaint the active display from cached data (no fetch) - for resize/theme. */
function repaintSpectrum() {
  if (!summary || summary.traceCount === 0) { drawSpecEmpty(); return; }
  if (specDisplay === 'avg') drawSpecAvg();
  else if (specDisplay === 'spectrogram') { if (specGram) drawSpecGram(); else drawSpecEmpty(); }
  else { if (specFk) drawSpecFk(); else drawSpecEmpty(); }
}

/** Cursor pixel → fractional position within the active spectrum view's plot
 *  rect: {fx,fy} in 0..1 (fy=0 at top). Uses the Average view's margins for 'avg'
 *  and SPEC_M for the two heatmaps. Returns null when off the plot rect. */
function specPlotFrac(cv: HTMLCanvasElement, e: MouseEvent): { fx: number; fy: number } | null {
  const r = cv.getBoundingClientRect();
  const W = cv.clientWidth || 900, H = cv.clientHeight || 460;
  // Avg view margins (drawSpectrum) vs heatmap margins (SPEC_M).
  const m = specDisplay === 'avg'
    ? { ML: 56, MR: 16, MT: 18, MB: 28 }
    : SPEC_M;
  const pw = W - m.ML - m.MR, ph = H - m.MT - m.MB;
  if (pw <= 0 || ph <= 0) return null;
  const fx = (e.clientX - r.left - m.ML) / pw;
  const fy = (e.clientY - r.top - m.MT) / ph;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return { fx, fy };
}

/** Wheel-zoom dispatcher: route a wheel event to the active spectrum view's zoom
 *  (centred on the cursor). factor <1 = zoom in (wheel up). */
function specWheelZoom(cv: HTMLCanvasElement, e: WheelEvent) {
  const f = specPlotFrac(cv, e);
  if (!f) return;
  const factor = e.deltaY < 0 ? 1 / 1.15 : 1.15;
  if (specDisplay === 'avg') {
    if (!specAvg) return;
    specAvgZoomAt(f.fx, f.fy, factor); // redraws inside
  } else if (specDisplay === 'spectrogram') {
    if (!specGram) return;
    heatZoomAt(specGramView, specGramExtent(), f.fx, f.fy, factor, false);
    drawSpecGram();
  } else {
    if (!specFk) return;
    heatZoomAt(specFkView, specFkExtent(), f.fx, f.fy, factor, true); // F-K freq axis is up
    drawSpecFk();
  }
}

/** Toolbar +/- zoom for the active spectrum view (centred on the plot). */
function specZoomButton(factor: number) {
  if (specDisplay === 'avg') { if (specAvg) specAvgZoomAt(0.5, 0.5, factor); }
  else if (specDisplay === 'spectrogram') { if (specGram) { heatZoomAt(specGramView, specGramExtent(), 0.5, 0.5, factor, false); drawSpecGram(); } }
  else { if (specFk) { heatZoomAt(specFkView, specFkExtent(), 0.5, 0.5, factor, true); drawSpecFk(); } }
}

/** Fit/reset the active spectrum view to auto-fit. */
function specZoomFit() {
  if (specDisplay === 'avg') specAvgFit();
  else if (specDisplay === 'spectrogram') heatFit(specGramAxis, specGramView, () => { if (specGram) drawSpecGram(); });
  else heatFit(specFkAxis, specFkView, () => { if (specFk) drawSpecFk(); });
}

/** Step the spectrogram's trace index by ±1 (clamped) and re-fetch. */
function specStepTrace(delta: number) {
  if (!summary) return;
  specTraceIdx = Math.max(0, Math.min(summary.traceCount - 1, specTraceIdx + delta));
  if (specDisplay === 'spectrogram') void refreshSpecGram();
}

/** Wire up the Spectrum tab's controls (called once from init). */
function initSpectrum() {
  // Display selector (segmented).
  $opt('specDispAvg')?.addEventListener('click', () => setSpecDisplay('avg'));
  $opt('specDispGram')?.addEventListener('click', () => setSpecDisplay('spectrogram'));
  $opt('specDispFk')?.addEventListener('click', () => setSpecDisplay('fk'));

  // Wheel-zoom over the shared canvas → the active view's range state.
  const specCv = $('specCanvas') as HTMLCanvasElement;
  specCv.addEventListener('wheel', (e) => {
    if ($('panel-spectrum').style.display === 'none' || !summary || summary.traceCount === 0) return;
    e.preventDefault();
    specWheelZoom(specCv, e);
  }, { passive: false });

  // -- Average-spectrum controls --
  $opt('specDbLin')?.addEventListener('click', () => setSpecDb(false));
  $opt('specDbDb')?.addEventListener('click', () => setSpecDb(true));
  $opt('specAvgCompute')?.addEventListener('click', () => void refreshSpecAvg());
  // Enter in either trace-range box recomputes the average.
  for (const id of ['specTr0', 'specTr1']) {
    $opt(id)?.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void refreshSpecAvg(); } });
  }
  // Average view: zoom buttons + manual X (freq) / Y (amp) range boxes.
  $opt('specAvgZoomIn')?.addEventListener('click', () => specZoomButton(1 / 1.4));
  $opt('specAvgZoomOut')?.addEventListener('click', () => specZoomButton(1.4));
  $opt('specAvgZoomFit')?.addEventListener('click', () => specZoomFit());
  const avgHost = $opt('specAvgAxis');
  if (avgHost) {
    specAvgAxis = axisRangeControls(avgHost, {
      xLabel: 'Freq Hz', yLabel: 'Amp',
      onChange: () => applySpecAvgAxis(),
    });
  }

  // -- Spectrogram controls --
  $opt('specPrev')?.addEventListener('click', () => specStepTrace(-1));
  $opt('specNext')?.addEventListener('click', () => specStepTrace(1));
  const idIn = $opt('specTraceIdx') as HTMLInputElement | null;
  idIn?.addEventListener('change', () => {
    if (!summary) return;
    specTraceIdx = Math.max(0, Math.min(summary.traceCount - 1, parseInt(idIn.value, 10) || 0));
    void refreshSpecGram();
  });
  $opt('specWin')?.addEventListener('change', () => void refreshSpecGram());
  // Spectrogram view: zoom buttons + manual X (freq) / Y (time) range boxes.
  $opt('specGramZoomIn')?.addEventListener('click', () => specZoomButton(1 / 1.4));
  $opt('specGramZoomOut')?.addEventListener('click', () => specZoomButton(1.4));
  $opt('specGramZoomFit')?.addEventListener('click', () => specZoomFit());
  const gramHost = $opt('specGramAxis');
  if (gramHost) {
    specGramAxis = axisRangeControls(gramHost, {
      xLabel: 'Freq Hz', yLabel: 'Time s',
      onChange: () => applyHeatAxis(specGramAxis, specGramView, () => { if (specGram) drawSpecGram(); }),
    });
  }

  // -- F-K controls --
  $opt('specFkCompute')?.addEventListener('click', () => void refreshSpecFk());
  // F-K view: zoom buttons + manual X (wavenumber) / Y (freq) range boxes.
  $opt('specFkZoomIn')?.addEventListener('click', () => specZoomButton(1 / 1.4));
  $opt('specFkZoomOut')?.addEventListener('click', () => specZoomButton(1.4));
  $opt('specFkZoomFit')?.addEventListener('click', () => specZoomFit());
  const fkHost = $opt('specFkAxis');
  if (fkHost) {
    specFkAxis = axisRangeControls(fkHost, {
      xLabel: 'kx', yLabel: 'Freq Hz',
      onChange: () => applyHeatAxis(specFkAxis, specFkView, () => { if (specFk) drawSpecFk(); }),
    });
  }

  // Initial segmented + control-group state, and an empty placeholder.
  $opt('specDispAvg')?.classList.add('on');
  $opt('specCtlsGram')?.classList.add('hidden');
  $opt('specCtlsFk')?.classList.add('hidden');
  $opt('specFkNote')?.classList.add('hidden'); // f-k note hidden until the F-K view
  $opt('specDbLin')?.classList.add('on');
  drawSpecEmpty();
}

/** Switch the Average view's amplitude axis between linear and dB + repaint. */
function setSpecDb(dB: boolean) {
  if (specDb === dB) return;
  specDb = dB;
  $opt('specDbLin')?.classList.toggle('on', !dB);
  $opt('specDbDb')?.classList.toggle('on', dB);
  // The amplitude axis unit changed (linear ↔ dB), so any manual amplitude window
  // no longer matches the axis. Reset the Average view to auto-fit (clears all four
  // boxes) so the redraw can't paint a stale dB value against a linear axis.
  specAvgFit();
}

/** Clear the spectrum tab's cached payloads + repaint the empty placeholder. The
 *  open seismic file is left untouched. */
function clearSpectrum() {
  specAvg = null; specGram = null; specFk = null;
  // Drop any manual windows + box contents so a re-loaded file starts auto-fit.
  for (const view of [specAvgView, specGramView, specFkView]) { view.x0 = view.x1 = view.y0 = view.y1 = null; }
  specAvgAxis?.clear(); specGramAxis?.clear(); specFkAxis?.clear();
  drawSpecEmpty();
  $('specLabel').textContent = 'Open a seismic file to analyse its spectrum.';
  updateHeaderClear();
}


function errMsg(e: unknown): string {
  let m = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
  // Strip Electron's IPC wrapper ("Error invoking remote method '…': Error: <real>")
  // so the user sees the actionable text, not the plumbing.
  m = m.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');
  return m;
}

// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
//  OBSERVER LOG
//  A wizard-configured, per-shot field log. The wizard (steps: project header,
//  columns, source type, rows) builds `logColumns` + optionally seeds `logRows`;
//  the hand-built editable grid then edits those rows in place. State persists to
//  localStorage so it survives tab switches. (Export to Excel arrives in part 2.)
// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

// -- Default column schema (grouped). The wizard pre-checks these groups; the
//    user toggles whole groups and adds custom columns on top. SOURCE carries a
//    `base` set plus per-source-type extras swapped in by the source-type step. --
const STATUS_OPTIONS = ['Good', 'Noisy', 'Dead', 'Misfire', 'No-data', 'Test', 'Re-shoot', 'Skip', 'DNP'];

type SchemaField = { key: string; label: string; type: LogColType; unit?: string; options?: string[] };
const LOG_SCHEMA: { group: string; fields: SchemaField[] }[] = [
  { group: 'Identity/Time', fields: [
    { key: 'ffid', label: 'FFID', type: 'number' },
    { key: 'fileTape', label: 'File/Tape #', type: 'text' },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'time', label: 'Time', type: 'time' },
    { key: 'doy', label: 'Day-of-year', type: 'number' },
  ] },
  // SOURCE base - per-type extras (explosive/vibroseis) are appended dynamically.
  { group: 'Source', fields: [
    { key: 'shotPoint', label: 'Shot point', type: 'number' },
    { key: 'srcLine', label: 'Source line', type: 'text' },
    { key: 'srcIndex', label: 'Source index', type: 'number' },
    { key: 'srcType', label: 'Source type', type: 'text' },
    { key: 'srcEasting', label: 'Easting', type: 'number', unit: 'm' },
    { key: 'srcNorthing', label: 'Northing', type: 'number', unit: 'm' },
    { key: 'srcElev', label: 'Elevation', type: 'number', unit: 'm' },
  ] },
  { group: 'Receiver spread', fields: [
    { key: 'firstStation', label: 'First station', type: 'number' },
    { key: 'lastStation', label: 'Last station', type: 'number' },
    { key: 'firstChannel', label: 'First channel', type: 'number' },
    { key: 'lastChannel', label: 'Last channel', type: 'number' },
    { key: 'liveChannels', label: '# live channels', type: 'number' },
    { key: 'deadChannels', label: 'Dead/bad channels', type: 'text' },
    { key: 'rcvLines', label: 'Receiver line(s)', type: 'text' },
  ] },
  { group: 'Statics/Elev', fields: [
    { key: 'staticMs', label: 'Static', type: 'number', unit: 'ms' },
    { key: 'replVel', label: 'Replacement velocity', type: 'number', unit: 'm/s' },
    { key: 'weathering', label: 'Weathering', type: 'number', unit: 'm' },
  ] },
  { group: 'Instrument', fields: [
    { key: 'sampleInt', label: 'Sample interval', type: 'number', unit: 'ms' },
    { key: 'recordLen', label: 'Record length', type: 'number', unit: 's' },
    { key: 'lowCut', label: 'Low-cut', type: 'number', unit: 'Hz' },
    { key: 'highCut', label: 'High-cut', type: 'number', unit: 'Hz' },
    { key: 'notch', label: 'Notch', type: 'number', unit: 'Hz' },
    { key: 'gain', label: 'Gain', type: 'text' },
  ] },
  { group: 'Environment', fields: [
    { key: 'weather', label: 'Weather', type: 'text' },
    { key: 'noiseLevel', label: 'Noise level', type: 'text' },
    { key: 'notes', label: 'Notes', type: 'text' },
  ] },
  { group: 'QC/Status', fields: [
    { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS },
    { key: 'comments', label: 'Comments', type: 'text' },
  ] },
];
// Groups pre-checked when the wizard first opens (sensible default working set).
const LOG_DEFAULT_GROUPS = ['Identity/Time', 'Source', 'Receiver spread', 'QC/Status'];

// Per-source-type extra SOURCE sub-columns (appended after the SOURCE base set).
const LOG_SRC_EXTRAS: Record<LogSrcType, SchemaField[]> = {
  explosive: [
    { key: 'holeDepth', label: 'Hole depth', type: 'number', unit: 'm' },
    { key: 'charge', label: 'Charge', type: 'number', unit: 'kg' },
    { key: 'numHoles', label: '# holes', type: 'number' },
    { key: 'uphole', label: 'Uphole', type: 'number', unit: 'ms' },
    { key: 'detonator', label: 'Detonator', type: 'text' },
  ],
  vibroseis: [
    { key: 'numVibes', label: '# vibes', type: 'number' },
    { key: 'numSweeps', label: '# sweeps', type: 'number' },
    { key: 'sweepLen', label: 'Sweep length', type: 'number', unit: 's' },
    { key: 'startHz', label: 'Start Hz', type: 'number', unit: 'Hz' },
    { key: 'endHz', label: 'End Hz', type: 'number', unit: 'Hz' },
    { key: 'drivePct', label: 'Drive', type: 'number', unit: '%' },
  ],
  nodal: [],
};

// Project-header (logMeta) fields shown in wizard step 1.
const LOG_META_FIELDS: { key: string; label: string; wide?: boolean }[] = [
  { key: 'project', label: 'Project' },
  { key: 'area', label: 'Area' },
  { key: 'client', label: 'Client' },
  { key: 'contractor', label: 'Geophysical contractor' },
  { key: 'crew', label: 'Crew' },
  { key: 'observer', label: 'Observer' },
  { key: 'instrument', label: 'Instrument' },
  { key: 'dateRange', label: 'Date range' },
  { key: 'crs', label: 'CRS / datum' },
  { key: 'units', label: 'Units' },
  { key: 'numbering', label: 'Numbering schemes (line / SP / station / FFID)', wide: true },
];

// -- Observer Log v2: column ROLE defaults --
// Maps a column (by key + type) to a sensible behavioural role + (for sps-linked
// source columns) the SpsSourceRecord field it pulls. Counters get auto-fill OPT-IN
// (default OFF). Applied at build time and backfilled onto older persisted columns.
//
//   FFID / Shot point / Line / Station   → 'counter'
//   Time                                 → 'time'
//   Date                                 → 'date'
//   Status (and any 'select')            → 'pick'
//   SPS-derived source columns           → 'sps' (+ matching srcField)
//   everything else                      → 'plain'
const LOG_COUNTER_KEYS = new Set([
  'ffid', 'shotPoint', 'srcLine', 'srcIndex', 'doy',
  'firstStation', 'lastStation', 'firstChannel', 'lastChannel',
]);
// Source columns that can be looked up from a loaded SPS survey's source points.
const LOG_SPS_SRCFIELD: Record<string, LogSrcField> = {
  srcLine: 'lineName', shotPoint: 'point',
  srcEasting: 'easting', srcNorthing: 'northing', srcElev: 'elevation',
  uphole: 'upholeMs', staticMs: 'staticMs', srcType: 'srcType',
};
function defaultColRole(c: { key: string; type: LogColType }): LogColRole {
  if (c.type === 'select') return 'pick';
  if (c.type === 'time') return 'time';
  if (c.type === 'date') return 'date';
  if (c.key in LOG_SPS_SRCFIELD) return 'sps';
  if (LOG_COUNTER_KEYS.has(c.key)) return 'counter';
  return 'plain';
}
/** Assign role/step/srcField defaults to a column IN PLACE (only when unset, so a
 *  user-chosen role survives). Returns the same column for chaining. */
function withColRoleDefaults(c: LogColumn): LogColumn {
  if (c.role == null) c.role = defaultColRole(c);
  if (c.role === 'sps' && c.srcField == null && c.key in LOG_SPS_SRCFIELD) c.srcField = LOG_SPS_SRCFIELD[c.key];
  if (c.role === 'counter' && c.step == null) c.step = 1;
  return c;
}
/** Backfill role defaults across the live column set (idempotent). */
function ensureColRoles() { for (const c of logColumns) withColRoleDefaults(c); }

/** Build the live `logColumns` from the wizard's chosen groups + source type +
 *  custom columns. SOURCE injects the per-type extras right after its base set. */
function buildLogColumns(): LogColumn[] {
  const groups = logEnabledGroups ?? new Set(LOG_DEFAULT_GROUPS);
  const cols: LogColumn[] = [];
  for (const g of LOG_SCHEMA) {
    if (!groups.has(g.group)) continue;
    for (const f of g.fields) {
      cols.push(withColRoleDefaults({ key: f.key, label: f.label, group: g.group, type: f.type, unit: f.unit, options: f.options }));
    }
    // Append the per-source-type extras at the END of the SOURCE group so the
    // base SOURCE columns always come first.
    if (g.group === 'Source') {
      for (const f of LOG_SRC_EXTRAS[logSrcType]) {
        cols.push(withColRoleDefaults({ key: f.key, label: f.label, group: 'Source', type: f.type, unit: f.unit, options: f.options }));
      }
    }
  }
  // Custom columns last, in their own group label.
  for (const c of logCustomCols) cols.push(withColRoleDefaults({ ...c }));
  return cols;
}

/** A blank row: every column key present, '' for text/select-less, Status seeded. */
function blankLogRow(): LogRow {
  const r: LogRow = {};
  for (const c of logColumns) r[c.key] = c.key === 'status' ? 'Good' : '';
  return r;
}

// -- Seeding ------------------------------------------------------------------
// "Seed from data" creates one row per shot. Priority: a loaded SPS survey's
// SOURCE points (line/point/E/N), else the open seismic file's traces grouped by
// unique FFID (bounded so huge files stay responsive).

/** Whether any data source is available to seed rows from. */
function logCanSeed(): boolean {
  return !!spsSummary || !!(summary && summary.traceCount > 0);
}

/** Short description of what "Seed from data" will use, for the wizard note. */
function logSeedNote(): string {
  if (spsSummary) return `Seed one row per source point from the loaded SPS survey (${spsSummary.sources} sources).`;
  if (summary && summary.traceCount > 0) return `Seed one row per FFID from “${summary.name}” (${summary.traceCount} traces).`;
  return 'No SPS survey or seismic file loaded yet - load one, or start blank.';
}

/** Seed rows from the loaded SPS survey's source points (uses the already-fetched
 *  grid geometry; lazily fetches projected E/N geometry if not cached). */
async function seedFromSps(): Promise<LogRow[]> {
  // Use projected E/N geometry (geo=false) so Easting/Northing are meaningful.
  let g = spsGeom;
  if (!g || g.geo) {
    try { g = await api.spsGeometry(false); } catch { g = null; }
  }
  const rows: LogRow[] = [];
  if (!g) return rows;
  const src = g.src;
  const n = src.pt.length; // x/y/line/pt are per-POINT; names is per-LINE (index = line[i])
  for (let i = 0; i < n; i++) {
    const r = blankLogRow();
    if ('shotPoint' in r) r['shotPoint'] = src.pt[i];
    if ('srcLine' in r) r['srcLine'] = src.names[src.line[i]] ?? String(src.line[i]);
    if ('srcIndex' in r) r['srcIndex'] = i + 1;
    if ('srcEasting' in r && isFinite(src.x[i])) r['srcEasting'] = round3(src.x[i]);
    if ('srcNorthing' in r && isFinite(src.y[i])) r['srcNorthing'] = round3(src.y[i]);
    rows.push(r);
  }
  return rows;
}

/** Seed rows from the open seismic file: one row per unique FFID (bounded scan). */
async function seedFromTraces(): Promise<LogRow[]> {
  const rows: LogRow[] = [];
  if (!summary || summary.traceCount === 0) return rows;
  const CAP = 2000;                                  // bound the per-trace scan
  const limit = Math.min(summary.traceCount, CAP);
  const seen = new Set<number>();
  for (let i = 0; i < limit; i++) {
    let t: TraceData;
    try { t = await api.getTrace(i); } catch { continue; }
    const ffid = num(t.hdr['fieldRec']);
    const key = ffid ?? i;                            // fall back to trace index
    if (seen.has(key)) continue;
    seen.add(key);
    const r = blankLogRow();
    if ('ffid' in r && ffid != null) r['ffid'] = ffid;
    const sp = num(t.hdr['srcPt']);
    if ('shotPoint' in r && sp != null) r['shotPoint'] = sp;
    if ('sampleInt' in r) r['sampleInt'] = round3(t.sampleInt / 1000);
    rows.push(r);
  }
  return rows;
}

function round3(v: number): number { return Math.round(v * 1000) / 1000; }
function num(v: number | string | undefined): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
}

// -- Persistence --------------------------------------------------------------
// The log is serialised to localStorage. Two things matter here:
//  1) A day's log is 2000-4000 rows, so the write is DEBOUNCED - typing a cell no
//     longer stringifies the whole log on every keystroke commit. saveLogFlush()
//     writes immediately (called on window unload/hide so nothing is left pending).
//  2) A failed write (quota exceeded) used to be swallowed, so the observer kept
//     logging into a store that no longer persisted and lost the day on restart.
//     A failure now raises a PERSISTENT banner above the grid (plus one toast).
let logSaveTimer = 0;
let logSaveDirty = false;
let logSaveFailed = false;
let logSaveWarned = false;
const LOG_SAVE_DEBOUNCE_MS = 400;

/** Queue a persist of the observer log (debounced). */
function saveLog() {
  logSaveDirty = true;
  if (logSaveTimer) return;
  logSaveTimer = window.setTimeout(() => { logSaveTimer = 0; saveLogFlush(); }, LOG_SAVE_DEBOUNCE_MS);
}

/** Persist the observer log NOW, reporting a failed write instead of hiding it. */
function saveLogFlush(): void {
  if (logSaveTimer) { window.clearTimeout(logSaveTimer); logSaveTimer = 0; }
  if (!logSaveDirty) return;
  logSaveDirty = false;
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify({
      meta: logMeta, columns: logColumns, rows: logRows,
      srcType: logSrcType, customCols: logCustomCols,
      groups: logEnabledGroups ? Array.from(logEnabledGroups) : null,
      // v2: persist the time-source choice + server (offset is session-only).
      timeSource: logTimeSource, ntpServer: logNtpServer,
    }));
    if (logSaveFailed) { logSaveFailed = false; logSaveWarned = false; renderLogSaveWarning(); }
  } catch {
    logSaveFailed = true;
    renderLogSaveWarning();
    if (!logSaveWarned) {
      logSaveWarned = true;
      infoToast('The observer log could NOT be saved - export it now.');
    }
  }
}

/** Show/hide the persistent "log is not being saved" banner above the grid. */
function renderLogSaveWarning(): void {
  const el = $opt('ologSaveWarn');
  if (!el) return;
  if (!logSaveFailed) { el.style.display = 'none'; el.textContent = ''; return; }
  el.textContent = '';
  const b = document.createElement('b');
  b.textContent = 'This log is NOT being saved. ';
  el.append(b, 'Browser storage is full, so nothing you type from here on will survive a restart. '
    + 'Export the log now (Excel / CSV / JSON) and keep the exported file.');
  el.style.display = '';
}

// Never leave a debounced write pending when the window goes away.
window.addEventListener('beforeunload', () => saveLogFlush());
window.addEventListener('pagehide', () => saveLogFlush());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveLogFlush(); });
// -- Defensive validation for persisted Observer-Log state --
// A malformed or partially-written localStorage value (e.g. after an abnormal
// crash mid-write) must never stall the grid render on next launch. These guards
// confirm the parsed shape and reject prototype-pollution keys; on any failure
// loadLogState() falls back to a clean default state instead of stalling.
const LOG_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafeLogKey(k: unknown): k is string { return typeof k === 'string' && k !== '' && !LOG_PROTO_KEYS.has(k); }
function isPlainObj(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function ownKeysSafe(o: Record<string, unknown>): boolean {
  for (const k of Object.keys(o)) if (LOG_PROTO_KEYS.has(k)) return false;
  return true;
}
function isValidLogColumns(v: unknown): v is LogColumn[] {
  if (!Array.isArray(v) || v.length > 1000) return false;
  return v.every((c) => isPlainObj(c) && ownKeysSafe(c) && isSafeLogKey(c.key) && typeof c.label === 'string');
}
function isValidLogRows(v: unknown): v is LogRow[] {
  if (!Array.isArray(v) || v.length > 200000) return false;
  return v.every((r) => isPlainObj(r) && ownKeysSafe(r)
    && Object.values(r).every((val) => typeof val === 'string' || typeof val === 'number'));
}
function isValidLogMeta(v: unknown): v is LogMeta {
  return isPlainObj(v) && ownKeysSafe(v) && Object.values(v).every((val) => typeof val === 'string');
}
function isValidLogGroups(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= 1000 && v.every((g) => isSafeLogKey(g));
}
function loadLogState() {
  try {
    const s = localStorage.getItem(LOG_KEY);
    if (!s) return;
    const o = JSON.parse(s) as Partial<{
      meta: LogMeta; columns: LogColumn[]; rows: LogRow[];
      srcType: LogSrcType; customCols: LogColumn[]; groups: string[] | null;
      timeSource: LogTimeSource; ntpServer: string;
    }>;
    if (!isPlainObj(o)) throw new Error('root is not an object');
    // Validate every present field's SHAPE *before* assigning anything - a single
    // malformed field aborts the whole load (→ clean default in the catch), so the
    // grid never half-loads stale/corrupt config and stalls.
    if (o.meta !== undefined && !isValidLogMeta(o.meta)) throw new Error('bad meta');
    if (o.columns !== undefined && !isValidLogColumns(o.columns)) throw new Error('bad columns');
    if (o.rows !== undefined && !isValidLogRows(o.rows)) throw new Error('bad rows');
    if (o.customCols !== undefined && !isValidLogColumns(o.customCols)) throw new Error('bad customCols');
    if (o.groups != null && !isValidLogGroups(o.groups)) throw new Error('bad groups');

    if (isValidLogMeta(o.meta)) logMeta = o.meta;
    if (Array.isArray(o.columns)) logColumns = o.columns;
    if (Array.isArray(o.rows)) logRows = o.rows;
    if (o.srcType === 'explosive' || o.srcType === 'vibroseis' || o.srcType === 'nodal') logSrcType = o.srcType;
    if (Array.isArray(o.customCols)) logCustomCols = o.customCols;
    if (isValidLogGroups(o.groups)) logEnabledGroups = new Set(o.groups);
    // v2: time-source choice + server (default to PC clock / pool.ntp.org).
    if (o.timeSource === 'pc' || o.timeSource === 'ntp') logTimeSource = o.timeSource;
    if (typeof o.ntpServer === 'string' && o.ntpServer.trim() !== '') logNtpServer = o.ntpServer.trim();
    // Backfill v2 roles onto columns saved by an older (pre-role) build.
    ensureColRoles();
    for (const c of logCustomCols) withColRoleDefaults(c);
  } catch (e) {
    // Corrupt / partially-written state - start from a clean default so the grid
    // still renders next launch (never stall). Surface it quietly.
    logMeta = {}; logColumns = []; logRows = [];
    logSrcType = 'explosive'; logCustomCols = []; logEnabledGroups = null;
    logTimeSource = 'pc'; logNtpServer = 'pool.ntp.org';
    try { console.warn('loadLogState: rejected corrupt Observer-Log state -', e); } catch { /* ignore */ }
    try { infoToast('Observer Log saved state was unreadable - started a fresh log.'); } catch { /* ignore */ }
  }
}

/** Clear only the log RECORDS (rows), keeping the configured columns + header.
 *  Snapshots the whole log first (so a Restore can bring the records back) and
 *  audits the clear. Uses the in-app confirm (window.confirm is unreliable in a
 *  sandboxed Electron renderer). */
async function clearLogRows() {
  if (logRows.length === 0) return;
  if (!(await confirmDelete('Clear all log records? The column configuration and project header are kept.'))) return;
  snapshotBackup('obslog', { meta: logMeta, columns: logColumns, rows: logRows }, `${logRows.length} records (before Clear)`);
  const n = logRows.length;
  logRows = [];
  saveLog();
  renderLog();
  audit('clear', `cleared observer-log records (${n} row${n === 1 ? '' : 's'})`, 'obslog');
  updateHeaderClear();
}

// -- File persistence: save / reload the whole log as JSON ----------------------

/** A short status line shown briefly under the toolbar after an export/save. */
function setLogExportStatus(msg: string) {
  setText('ologGridLabel', msg);
  // Restore the normal record/column count after a moment.
  window.setTimeout(() => {
    setText('ologGridLabel', `${logRows.length} record${logRows.length === 1 ? '' : 's'} · ${logColumns.length} columns`);
  }, 2600);
}

/** Save the whole log (header + columns + rows) to a JSON file via a save dialog.
 *  Reuses the existing exportText IPC; the payload round-trips through openLogJson. */
async function saveLogJson() {
  const payload = JSON.stringify({ meta: logMeta, columns: logColumns, rows: logRows }, null, 2);
  try {
    const r = await api.exportText('observer-log.json', payload);
    if (r?.ok) { setLogExportStatus('Saved log JSON.'); audit('export', `observer-log JSON (${logRows.length} records) → ${r.path}`, 'obslog'); }
  } catch { /* ignore - dialog cancelled / write error */ }
}

/** Reload a previously saved log JSON: restore meta/columns/rows and show the
 *  grid (skipping the wizard). Persists the restored state to localStorage too. */
async function reloadLogJson() {
  let data: LogJson | null = null;
  try { data = await api.openLogJson(); } catch { return; }
  if (!data) return;
  if (!Array.isArray(data.columns) || data.columns.length === 0) {
    setText('ologGridLabel', 'That file has no columns - not a valid Observer Log.');
    return;
  }
  // Reloading REPLACES the in-memory log wholesale - snapshot the current state
  // first (if any) so the user can roll back to what was on screen.
  if (logColumns.length || logRows.length) {
    snapshotBackup('obslog', { meta: logMeta, columns: logColumns, rows: logRows }, `${logRows.length} records (before Reload)`);
  }
  logMeta = (data.meta && typeof data.meta === 'object') ? data.meta : {};
  logColumns = data.columns;
  logRows = Array.isArray(data.rows) ? data.rows : [];
  ensureColRoles(); // backfill v2 roles onto columns from older saved files
  saveLog();        // mirror into localStorage so it survives a tab switch
  renderLog();      // logConfigured() is now true → grid is shown, wizard skipped
  updateHeaderClear();
  setLogExportStatus('Reloaded log JSON.');
  audit('reconfigure', `reloaded observer-log from file (${logRows.length} records, ${logColumns.length} columns)`, 'obslog');
}

// -- Tabular exports (CSV / XLSX / ODS / Report) --------------------------------

/** The display label for a column header in an export (label + unit if present). */
function logColHeader(c: LogColumn): string {
  return c.unit ? `${c.label} (${c.unit})` : c.label;
}

/** One cell value for export: numbers stay numeric; everything else → string. */
function logCellValue(row: LogRow, c: LogColumn): string | number {
  const raw = row[c.key];
  if (raw == null) return '';
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : '';
  // Numeric-typed columns whose stored value is a numeric string → emit a number
  // so spreadsheets treat the cell as a number, not text.
  if (c.type === 'number' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

/** Build the table model (header row + value matrix) shared by every exporter. */
function buildLogTable(): { header: string[]; rows: (string | number)[][] } {
  const header = logColumns.map(logColHeader);
  const rows = logRows.map((row) => logColumns.map((c) => logCellValue(row, c)));
  return { header, rows };
}

/** RFC-4180-escape one CSV field: quote when it contains a comma, quote, or
 *  newline; double any embedded quotes. Numbers pass through as plain text. */
function csvField(v: string | number): string {
  const s = typeof v === 'number' ? String(v) : v;
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Build the CSV text (CRLF rows, BOM prepended by the caller) from the table. */
function buildLogCsv(): string {
  const { header, rows } = buildLogTable();
  const lines: string[] = [];
  lines.push(header.map(csvField).join(','));
  for (const r of rows) lines.push(r.map(csvField).join(','));
  return lines.join('\r\n');
}

/** Export the log as a CSV file. Prepends a UTF-8 BOM so Excel reads non-ASCII. */
async function exportLogCsv() {
  if (logRows.length === 0) return;
  const text = '﻿' + buildLogCsv();
  try {
    const r = await api.exportText('observer-log.csv', text);
    if (r?.ok) { setLogExportStatus('Exported CSV.'); audit('export', `observer-log CSV (${logRows.length} records) → ${r.path}`, 'obslog'); }
  } catch { /* ignore */ }
}

/** Sheets fed to the xlsx / ods writers: a "Project" header sheet (only when the
 *  project header has any filled fields) plus the main "Observer Log" table. */
function buildLogSheets(): SheetTable[] {
  const sheets: SheetTable[] = [];
  const metaPairs = LOG_META_FIELDS
    .filter((f) => (logMeta[f.key] ?? '').trim() !== '')
    .map((f) => [f.label, logMeta[f.key]] as [string, string]);
  if (metaPairs.length) {
    sheets.push({ name: 'Project', header: ['Field', 'Value'], rows: metaPairs });
  }
  const { header, rows } = buildLogTable();
  sheets.push({ name: 'Observer Log', header, rows });
  return sheets;
}

/** Export the log as a real .xlsx (built in-core, zipped with JSZip, saved as bytes). */
async function exportLogXlsx() {
  if (logRows.length === 0) return;
  showProgress('Building Excel (.xlsx)…');
  try {
    const bytes = await buildXlsx(buildLogSheets(), new JSZip());
    const r = await api.exportBinary('observer-log.xlsx', bytes);
    if (r?.ok) { setLogExportStatus('Exported Excel (.xlsx).'); audit('export', `observer-log XLSX (${logRows.length} records) → ${r.path}`, 'obslog'); }
  } catch { setText('ologGridLabel', 'Excel export failed.'); }
  finally { hideProgress(); }
}

/** Export the log as a .ods (OpenDocument Spreadsheet) for LibreOffice / Calc. */
async function exportLogOds() {
  if (logRows.length === 0) return;
  showProgress('Building LibreOffice (.ods)…');
  try {
    const bytes = await buildOds(buildLogSheets(), new JSZip());
    const r = await api.exportBinary('observer-log.ods', bytes);
    if (r?.ok) { setLogExportStatus('Exported LibreOffice (.ods).'); audit('export', `observer-log ODS (${logRows.length} records) → ${r.path}`, 'obslog'); }
  } catch { setText('ologGridLabel', 'ODS export failed.'); }
  finally { hideProgress(); }
}

// -- Printable HTML report ------------------------------------------------------

/** HTML-escape text for safe insertion into the report document. */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build a clean, print-styled standalone HTML report (project header + table).
 *  Saved to disk; the user opens it and prints to PDF (the app denies new windows). */
function buildLogReportHtml(): string {
  const title = (logMeta['project'] ?? '').trim() || 'Observer Log';
  const metaRows = LOG_META_FIELDS
    .filter((f) => (logMeta[f.key] ?? '').trim() !== '')
    .map((f) => `<tr><th>${htmlEscape(f.label)}</th><td>${htmlEscape(logMeta[f.key] ?? '')}</td></tr>`)
    .join('');
  const { header, rows } = buildLogTable();
  const headHtml = header.map((h) => `<th>${htmlEscape(h)}</th>`).join('');
  const bodyHtml = rows
    .map((r, i) => {
      const cells = r.map((v) => `<td>${htmlEscape(typeof v === 'number' ? String(v) : v)}</td>`).join('');
      return `<tr><td class="rn">${i + 1}</td>${cells}</tr>`;
    })
    .join('');
  const generated = new Date().toLocaleString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${htmlEscape(title)} - Observer Log</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #11202e; margin: 28px; font-size: 12px; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  .sub { color: #5a6b78; font-size: 11px; margin-bottom: 16px; }
  table.meta { border-collapse: collapse; margin: 0 0 18px; }
  table.meta th { text-align: left; color: #5a6b78; font-weight: 600; padding: 2px 16px 2px 0; vertical-align: top; white-space: nowrap; }
  table.meta td { padding: 2px 0; }
  table.log { border-collapse: collapse; width: 100%; }
  table.log th, table.log td { border: 1px solid #cfd8df; padding: 4px 7px; text-align: left; vertical-align: top; }
  table.log thead th { background: #eef3f6; font-weight: 700; position: sticky; top: 0; }
  table.log td.rn { color: #8493a0; text-align: right; font-variant-numeric: tabular-nums; }
  table.log tbody tr:nth-child(even) td { background: #f7fafb; }
  .foot { margin-top: 14px; color: #8493a0; font-size: 10px; }
  @media print {
    body { margin: 0; }
    table.log thead th { background: #eef3f6 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    table.log tbody tr:nth-child(even) td { background: #f7fafb !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <h1>${htmlEscape(title)}</h1>
  <div class="sub">Observer Log · ${logRows.length} record${logRows.length === 1 ? '' : 's'} · generated ${htmlEscape(generated)}</div>
  ${metaRows ? `<table class="meta"><tbody>${metaRows}</tbody></table>` : ''}
  <table class="log">
    <thead><tr><th>#</th>${headHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table>
  <div class="foot">Print this page to PDF (Ctrl+P → “Save as PDF”) for a portable copy.</div>
</body>
</html>`;
}

/** Export the printable HTML report and save it via exportText. */
async function exportLogReport() {
  if (logRows.length === 0) return;
  // The report builds one HTML row per record on the renderer thread; gate the
  // spinner on a large log so a >3s build isn't silent, but tiny logs don't flash.
  const heavy = logRows.length > 3000;
  if (heavy) { showProgress('Building HTML report…', undefined, 0); await nextPaint(); }
  try {
    const r = await api.exportText('observer-log-report.html', buildLogReportHtml());
    if (r?.ok) { setLogExportStatus('Exported report (HTML).'); audit('export', `observer-log report (${logRows.length} records) → ${r.path}`, 'obslog'); }
  } catch { /* ignore */ }
  finally { if (heavy) hideProgress(); }
}

// -- Export toolbar -------------------------------------------------------------

/** Build/refresh the export-bar buttons (Excel / CSV / LibreOffice / Report).
 *  Buttons are disabled when there are no rows to export. */
function renderLogExportBar() {
  const host = $opt('obslogExportBar');
  if (!host) return;
  const disabled = logRows.length === 0;
  // Build once; on re-render just toggle the disabled state.
  if (!host.firstChild) {
    const mk = (label: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn sm';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    host.appendChild(mk('Excel (.xlsx)', 'Export the log as a Microsoft Excel workbook', () => void exportLogXlsx()));
    host.appendChild(mk('CSV', 'Export the log as a UTF-8 CSV file', () => void exportLogCsv()));
    host.appendChild(mk('LibreOffice (.ods)', 'Export the log as an OpenDocument spreadsheet', () => void exportLogOds()));
    host.appendChild(mk('Report', 'Export a printable HTML report (open it, then print to PDF)', () => void exportLogReport()));
    (host as HTMLElement).style.display = 'inline-flex';
    (host as HTMLElement).style.gap = '7px';
  }
  host.querySelectorAll('button').forEach((b) => { (b as HTMLButtonElement).disabled = disabled; });
}

// -- Wizard -------------------------------------------------------------------

/** True once the log has been built (columns exist) - controls wizard vs grid. */
function logConfigured(): boolean { return logColumns.length > 0; }

/** Show the wizard (hide the grid) and (re)paint its dynamic bodies. */
function openLogWizard() {
  const wiz = $opt('obslogWizard'); const grid = $opt('obslogGrid');
  if (wiz) wiz.style.display = '';
  if (grid) grid.style.display = 'none';
  // Prime the enabled-groups set on first open (or from persisted state).
  if (!logEnabledGroups) logEnabledGroups = new Set(LOG_DEFAULT_GROUPS);
  renderMetaForm();
  renderGroupList();
  renderCustomList();
  syncSrcRadios();
  syncRowRadios();
  setText('ologWizStatus', '');
}

/** Wizard step 1 - project-header form, two-up grid of inputs. */
function renderMetaForm() {
  const host = $opt('ologMetaForm');
  if (!host) return;
  host.innerHTML = '';
  for (const f of LOG_META_FIELDS) {
    const wrap = document.createElement('div');
    wrap.className = 'olog-field' + (f.wide ? ' wide' : '');
    const lab = document.createElement('label');
    lab.textContent = f.label;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = logMeta[f.key] ?? '';
    inp.addEventListener('input', () => { logMeta[f.key] = inp.value; });
    wrap.appendChild(lab); wrap.appendChild(inp);
    host.appendChild(wrap);
  }
}

/** Wizard step 2 - one collapsible-ish block per default group with field checkboxes. */
function renderGroupList() {
  const host = $opt('ologGroupList');
  if (!host) return;
  host.innerHTML = '';
  const enabled = logEnabledGroups ?? new Set(LOG_DEFAULT_GROUPS);
  for (const g of LOG_SCHEMA) {
    const block = document.createElement('div');
    block.className = 'olog-group';
    const head = document.createElement('div');
    head.className = 'ogh';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = enabled.has(g.group);
    cb.style.accentColor = 'var(--teal)';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) enabled.add(g.group); else enabled.delete(g.group);
      logEnabledGroups = enabled;
    });
    const title = document.createElement('span');
    title.textContent = g.group;
    const count = document.createElement('span');
    count.className = 'ogcount';
    const extra = g.group === 'Source' ? LOG_SRC_EXTRAS[logSrcType].length : 0;
    count.textContent = `${g.fields.length + extra} cols`;
    head.appendChild(cb); head.appendChild(title); head.appendChild(count);
    head.addEventListener('click', () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
    block.appendChild(head);
    // Field name preview (read-only - group toggle is the granularity).
    const cols = document.createElement('div');
    cols.className = 'olog-cols';
    const fields = g.group === 'Source' ? [...g.fields, ...LOG_SRC_EXTRAS[logSrcType]] : g.fields;
    for (const f of fields) {
      const c = document.createElement('span');
      c.className = 'olog-col';
      c.textContent = f.label + (f.unit ? ` (${f.unit})` : '');
      cols.appendChild(c);
    }
    block.appendChild(cols);
    host.appendChild(block);
  }
}

/** Wizard step 2 - render the user's custom-column chips. */
function renderCustomList() {
  const host = $opt('ologCustList');
  if (!host) return;
  host.innerHTML = '';
  for (let i = 0; i < logCustomCols.length; i++) {
    const c = logCustomCols[i];
    const chip = document.createElement('span');
    chip.className = 'olog-custom-chip';
    const lbl = document.createElement('span');
    lbl.textContent = c.label + (c.unit ? ` (${c.unit})` : '') + ` · ${c.type}`;
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'Remove column';
    x.addEventListener('click', () => { logCustomCols.splice(i, 1); renderCustomList(); });
    chip.appendChild(lbl); chip.appendChild(x);
    host.appendChild(chip);
  }
}

/** Add a custom column from the step-2 inputs. */
function addCustomColumn() {
  const nameEl = $opt('ologCustName') as HTMLInputElement | null;
  const typeEl = $opt('ologCustType') as HTMLSelectElement | null;
  const unitEl = $opt('ologCustUnit') as HTMLInputElement | null;
  const label = (nameEl?.value ?? '').trim();
  if (!label) { setText('ologWizStatus', 'Enter a column name first.'); return; }
  const type = (typeEl?.value ?? 'text') as LogColType;
  const unit = (unitEl?.value ?? '').trim() || undefined;
  // Derive a safe, unique key.
  let base = 'custom_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (base === 'custom_') base = 'custom_col';
  let key = base; let n = 2;
  const used = new Set([...LOG_SCHEMA.flatMap((g) => g.fields.map((f) => f.key)), ...logCustomCols.map((c) => c.key)]);
  while (used.has(key)) key = `${base}_${n++}`;
  logCustomCols.push({ key, label, group: 'Custom', type, unit });
  if (nameEl) nameEl.value = '';
  if (unitEl) unitEl.value = '';
  setText('ologWizStatus', '');
  renderCustomList();
}

/** Reflect `logSrcType` onto the step-3 radio cards + group preview counts. */
function syncSrcRadios() {
  document.querySelectorAll<HTMLElement>('#ologSrcRadios .olog-radio').forEach((card) => {
    const on = card.getAttribute('data-src') === logSrcType;
    card.classList.toggle('sel', on);
    const radio = card.querySelector('input') as HTMLInputElement | null;
    if (radio) radio.checked = on;
  });
  renderGroupList(); // Source column count depends on the source type
}

/** Reflect the row-seed choice onto the step-4 radio cards + availability note. */
function syncRowRadios() {
  setText('ologSeedNote', logSeedNote());
  const seedCard = document.querySelector<HTMLElement>('#ologRowRadios .olog-radio[data-rows="seed"]');
  const seedRadio = seedCard?.querySelector('input') as HTMLInputElement | null;
  const canSeed = logCanSeed();
  if (seedRadio) seedRadio.disabled = !canSeed;
  if (seedCard) seedCard.style.opacity = canSeed ? '1' : '.55';
  // If seeding is unavailable, default the selection to "blank".
  if (!canSeed) {
    const blankRadio = document.querySelector<HTMLInputElement>('#ologRowRadios input[value="blank"]');
    if (blankRadio) blankRadio.checked = true;
  }
  document.querySelectorAll<HTMLElement>('#ologRowRadios .olog-radio').forEach((card) => {
    const radio = card.querySelector('input') as HTMLInputElement | null;
    card.classList.toggle('sel', !!radio?.checked);
  });
}

/** Commit the wizard: build columns, optionally seed rows, hide wizard, show grid. */
async function buildLog() {
  // At least one group or custom column must be selected.
  logColumns = buildLogColumns();
  if (logColumns.length === 0) { setText('ologWizStatus', 'Select at least one column group or add a custom column.'); return; }

  const rowMode = (document.querySelector('#ologRowRadios input[name="ologRows"]:checked') as HTMLInputElement | null)?.value ?? 'blank';

  // Reconcile existing rows to the new column set (keep known keys, add blanks).
  if (logRows.length > 0) {
    logRows = logRows.map((old) => {
      const r = blankLogRow();
      for (const c of logColumns) if (c.key in old) r[c.key] = old[c.key];
      return r;
    });
  } else if (rowMode === 'seed' && logCanSeed()) {
    setText('ologWizStatus', 'Seeding rows…');
    const seeded = spsSummary ? await seedFromSps() : await seedFromTraces();
    logRows = seeded.length ? seeded : [blankLogRow()];
  } else {
    logRows = [blankLogRow()];
  }

  saveLog();
  renderLog();
  updateHeaderClear();
}

// -- Grid ---------------------------------------------------------------------

/** Top-level Observer Log renderer: wizard when unconfigured, grid otherwise. */
function renderLog() {
  const wiz = $opt('obslogWizard'); const grid = $opt('obslogGrid');
  if (!logConfigured()) { openLogWizard(); return; }
  if (wiz) wiz.style.display = 'none';
  if (grid) grid.style.display = '';
  renderLogMetaStrip();
  renderLogGrid();
  renderLogExportBar();
  syncSpsLinkUI();
  setText('ologGridLabel', `${logRows.length} record${logRows.length === 1 ? '' : 's'} · ${logColumns.length} columns`);
}

/** Compact project-header strip above the grid (only non-empty fields). */
function renderLogMetaStrip() {
  const host = $opt('ologMetaStrip');
  if (!host) return;
  host.innerHTML = '';
  const parts = LOG_META_FIELDS.filter((f) => (logMeta[f.key] ?? '').trim() !== '');
  if (parts.length === 0) { host.style.display = 'none'; return; }
  host.style.display = '';
  for (const f of parts) {
    const span = document.createElement('span');
    const b = document.createElement('b'); b.textContent = (logMeta[f.key] ?? '');
    span.append(f.label + ': ', b);
    host.appendChild(span);
  }
}

/** Signature of the current header/cell-affordance state; a change forces a full
 *  header + body rebuild (see renderLogGrid). */
let logGridSig = '';

/** Build the editable table: sticky header (with units) + a row per record. */
function renderLogGrid() {
  const thead = $opt('ologThead'); const tbody = $opt('ologTbody'); const empty = $opt('ologGridEmpty');
  if (!thead || !tbody) return;

  // Header - rebuilt only when the columns (or what the cells key off) changed;
  // a header rebuild invalidates every cached row element.
  const sig = JSON.stringify(logColumns) + '|' + logTimeSource
    + '|' + (spsLookupHook ? '1' : '0') + '|' + (spsLinkAvailable() ? '1' : '0');
  const headerChanged = sig !== logGridSig;
  logGridSig = sig;
  if (headerChanged) {
  thead.innerHTML = '';
  const htr = document.createElement('tr');
  const rh = document.createElement('th'); rh.className = 'olog-rowhdr'; rh.textContent = '#';
  htr.appendChild(rh);
  for (const c of logColumns) {
    const th = document.createElement('th');
    th.title = `${c.group} · ${c.type}`;
    th.textContent = c.label;
    if (c.unit) { const u = document.createElement('span'); u.className = 'ogh-unit'; u.textContent = c.unit; th.appendChild(u); }
    htr.appendChild(th);
  }
  const ah = document.createElement('th'); ah.textContent = ''; htr.appendChild(ah);
  thead.appendChild(htr);
  logRowEls = new WeakMap();
  }

  // Body - reconciled, NOT rebuilt. A production day is thousands of rows x tens
  // of columns; wiping the tbody and rebuilding every input froze the UI for
  // seconds on every trigger-created row. Each <tr> carries a value signature, so
  // an unchanged row keeps its existing DOM (and its listeners) and only rows that
  // actually changed - plus genuinely new ones - are built.
  if (headerChanged) tbody.innerHTML = '';
  if (logRows.length === 0) {
    if (empty) empty.style.display = '';
    if (tbody.firstChild) tbody.innerHTML = '';
    logRowEls = new WeakMap();
    return;
  }
  if (empty) empty.style.display = 'none';
  reconcileLogGridBody(tbody);
}

/** Per-<tr> cache: the row object it renders, and the value signature it shows. */
let logRowEls = new WeakMap<LogRow, HTMLTableRowElement>();
const LOG_SIG_SEP = '';

/** Signature of everything a rendered row displays (cell values + pending highlight). */
function logRowSig(row: LogRow): string {
  let out = trigPendingRows.has(row) ? '1' : '0';
  for (const c of logColumns) {
    const v = row[c.key];
    out += LOG_SIG_SEP + (v == null ? '' : String(v));
  }
  return out;
}

/** Bring the tbody in line with logRows, reusing every unchanged row element. */
function reconcileLogGridBody(tbody: HTMLElement): void {
  let node = tbody.firstElementChild as HTMLTableRowElement | null;
  for (let i = 0; i < logRows.length; i++) {
    const row = logRows[i];
    let tr = logRowEls.get(row) ?? null;
    if (tr && tr.parentNode !== tbody) tr = null;          // stale (header rebuild)
    if (tr && tr.dataset.sig !== logRowSig(row)) {          // content changed - rebuild it
      const fresh = buildLogRowEl(row);
      tr.replaceWith(fresh);
      tr = fresh;
    }
    if (!tr) tr = buildLogRowEl(row);
    if (tr !== node) tbody.insertBefore(tr, node);          // new row, or reordered
    else node = node.nextElementSibling as HTMLTableRowElement | null;
    const rh = tr.firstElementChild;
    const label = String(i + 1);
    if (rh && rh.textContent !== label) rh.textContent = label;   // renumber in place
  }
  // Drop whatever is left over (deleted rows).
  while (node) { const next = node.nextElementSibling as HTMLTableRowElement | null; node.remove(); node = next; }
}

// -- Observer Log v2: time-stamp helpers (PC clock + optional NTP offset) --
/** Effective "now" - the PC clock, corrected by the NTP offset when NTP mode is
 *  active and a sync has succeeded. */
function effectiveNow(): Date {
  const off = (logTimeSource === 'ntp' && logNtpSynced) ? logNtpOffsetMs : 0;
  return new Date(Date.now() + off);
}
/** Current local time as HH:MM:SS (for 'time' role cells). */
function nowTimeStr(): string {
  const d = effectiveNow();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
/** Today's local date as YYYY-MM-DD (for 'date' role cells). */
function todayDateStr(): string {
  const d = effectiveNow();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// -- Observer Log v2: SPS source lookup HOOK --
// The live lookup that resolves an sps-role cell's value from the loaded SPS
// survey. The hook is null until wired (installSpsLookupHook, called at init);
// when null the grid renders sps cells as plain editable inputs with a disabled
// 'SPS' button. Signature: given a row + column, return the looked-up value (or
// null if it can't resolve), already coerced to the cell's type.
type SpsLookupHook = (row: LogRow, col: LogColumn) => Promise<string | number | null>;
let spsLookupHook: SpsLookupHook | null = null;
/** Register (or clear) the SPS source-lookup implementation. */
function setSpsLookupHook(fn: SpsLookupHook | null): void { spsLookupHook = fn; }
// Expose on window so external code can attach/inspect without importing this module.
(window as unknown as { seisconvObsLog?: Record<string, unknown> }).seisconvObsLog = {
  setSpsLookupHook,
  // Read helpers the hook may need.
  getRows: () => logRows,
  getColumns: () => logColumns,
  refreshGrid: () => renderLog(),
};

// -- Observer Log v2: SPS source CACHE + matching --
// The flat source list is fetched once via api.spsSourceList() and cached; it is
// invalidated whenever the loaded survey changes (loadSPS / clearSPS null it).
let spsSourceCache: SpsSourceRecord[] | null = null;
let spsSourceFetch: Promise<SpsSourceRecord[]> | null = null;
// Bumped on every invalidation. An in-flight fetch captures the generation it was
// started under and only writes the cache if it still matches - so a fetch for
// survey A that resolves after A was cleared/replaced can't repopulate the cache
// (or service later lookups) with A's stale sources.
let spsSourceGen = 0;

/** Drop the cached SPS source list (call when the loaded survey changes). */
function invalidateSpsSourceCache(): void { spsSourceCache = null; spsSourceFetch = null; spsSourceGen++; }

/** Fetch (and cache) the loaded survey's source list. Resolves to [] - never
 *  rejects - when no SPS is loaded or the IPC is unavailable. */
async function getSpsSources(): Promise<SpsSourceRecord[]> {
  if (spsSourceCache) return spsSourceCache;
  if (!api?.spsSourceList) { spsSourceCache = []; return spsSourceCache; }
  if (!spsSourceFetch) {
    const gen = spsSourceGen;
    const fresh = () => gen === spsSourceGen; // false once invalidated mid-flight
    spsSourceFetch = api.spsSourceList()
      .then((r) => { const s = Array.isArray(r?.sources) ? r.sources : []; if (fresh()) spsSourceCache = s; return s; })
      .catch(() => { if (fresh()) spsSourceCache = []; return []; });
  }
  return spsSourceFetch;
}

/** Read a row's shot-point as a number (from whichever 'point'-linked column or
 *  the default shotPoint key exists), or null. */
function rowShotPoint(row: LogRow): number | null {
  const ptCol = logColumns.find((c) => c.role === 'sps' && c.srcField === 'point');
  if (ptCol) { const v = num(row[ptCol.key]); if (v != null) return v; }
  return num(row['shotPoint']);
}
/** Read a row's source line label (from a 'lineName'-linked column or srcLine),
 *  or null. Compared case-/whitespace-insensitively. */
function rowSrcLine(row: LogRow): string | null {
  const lnCol = logColumns.find((c) => c.role === 'sps' && c.srcField === 'lineName');
  const raw = lnCol ? row[lnCol.key] : row['srcLine'];
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}
/** Whether the live log carries a source-line column (drives line-aware matching). */
function logHasLineColumn(): boolean {
  return logColumns.some((c) => (c.role === 'sps' && c.srcField === 'lineName') || c.key === 'srcLine');
}

/** Find the SPS source matching a row: by point, and additionally by line when a
 *  line column exists + the row carries a line value. Returns null on no match. */
function matchSpsSource(sources: SpsSourceRecord[], point: number, line: string | null): SpsSourceRecord | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const wantLine = line != null && logHasLineColumn() ? norm(line) : null;
  let ptOnly: SpsSourceRecord | null = null;
  for (const s of sources) {
    if (s.point !== point) continue;
    if (wantLine == null) return s;                       // point-only match
    if (norm(s.lineName) === wantLine) return s;          // exact line+point match
    if (ptOnly == null) ptOnly = s;                       // remember a point-only fallback
  }
  return ptOnly; // no exact line+point hit → fall back to a point-only match (or null)
}

/** Coerce an SpsSourceRecord field to a cell value (null when the field is null). */
function spsFieldValue(src: SpsSourceRecord, field: LogSrcField): string | number | null {
  const v = src[field];
  if (v == null) return null;
  return typeof v === 'number' ? round3(v) : v;
}

/** The actual SPS-cell lookup: resolve one sps-role column's value for a row from
 *  the cached source list (matched by the row's shot-point [+ line]). */
async function spsLookupForCell(row: LogRow, col: LogColumn): Promise<string | number | null> {
  if (col.role !== 'sps' || col.srcField == null) return null;
  const point = rowShotPoint(row);
  if (point == null) return null;
  const sources = await getSpsSources();
  if (sources.length === 0) return null;
  const match = matchSpsSource(sources, point, rowSrcLine(row));
  return match ? spsFieldValue(match, col.srcField) : null;
}

/** Auto-fill EVERY sps-role column in row `i` from the matched SPS source. Used by
 *  the live lookup (triggered when a Shot point / Line cell is edited). Returns
 *  true when at least one cell was filled (so the caller can re-render the row). */
async function autoFillSpsRow(i: number): Promise<boolean> {
  const row = logRows[i];
  if (!row) return false;
  const spsCols = logColumns.filter((c) => c.role === 'sps' && c.srcField != null);
  if (spsCols.length === 0) return false;
  const point = rowShotPoint(row);
  if (point == null) return false;
  const sources = await getSpsSources();
  if (sources.length === 0) return false;
  const match = matchSpsSource(sources, point, rowSrcLine(row));
  if (!match) return false;
  let changed = false;
  for (const c of spsCols) {
    // Never overwrite the very column the user just typed into (point/line drivers
    // already hold the user's value); fill the rest.
    if (c.srcField === 'point' || c.srcField === 'lineName') continue;
    const v = spsFieldValue(match, c.srcField!);
    if (v == null) continue;
    if (row[c.key] !== v) { row[c.key] = v; changed = true; }
  }
  return changed;
}

/** Whether an SPS survey is loaded (gates the bulk-import button + live lookup). */
function spsLinkAvailable(): boolean { return !!spsSummary; }

/** Install the live SPS lookup hook (called at init). The hook itself no-ops
 *  gracefully when no survey is loaded (getSpsSources resolves []). */
function installSpsLookupHook(): void { setSpsLookupHook(spsLookupForCell); }

/** BULK 'Import sources from SPS' → one row per SPS source, pre-filling sps-role
 *  columns by srcField plus the Shot point / Source line counters. No-ops (with a
 *  status note) when no survey is loaded or it has no sources. */
async function importRowsFromSps(): Promise<void> {
  if (!spsLinkAvailable()) { setText('ologGridLabel', 'Load an SPS survey first.'); return; }
  setText('ologGridLabel', 'Importing sources from SPS…');
  const sources = await getSpsSources();
  if (sources.length === 0) { setText('ologGridLabel', 'The loaded survey has no source points.'); return; }
  // Columns that should receive a value, keyed by the SpsSourceRecord field they map to.
  const lineCol = logColumns.find((c) => (c.role === 'sps' && c.srcField === 'lineName') || c.key === 'srcLine');
  const ptCol = logColumns.find((c) => (c.role === 'sps' && c.srcField === 'point') || c.key === 'shotPoint');
  const spsCols = logColumns.filter((c) => c.role === 'sps' && c.srcField != null);
  const rows: LogRow[] = [];
  for (const s of sources) {
    const r = blankLogRow();
    if (lineCol && 'lineName' in s) r[lineCol.key] = s.lineName;
    if (ptCol) r[ptCol.key] = s.point;
    for (const c of spsCols) {
      const v = spsFieldValue(s, c.srcField!);
      if (v != null) r[c.key] = v;
    }
    rows.push(r);
  }
  if (logRows.length > 0 && !(await confirmDelete(`Replace the ${logRows.length} current record${logRows.length === 1 ? '' : 's'} with ${rows.length} rows imported from SPS?`))) {
    setText('ologGridLabel', `${logRows.length} record${logRows.length === 1 ? '' : 's'} · ${logColumns.length} columns`);
    return;
  }
  logRows = rows;
  saveLog();
  renderLog();
  updateHeaderClear();
  setLogExportStatus(`Imported ${rows.length} source${rows.length === 1 ? '' : 's'} from SPS.`);
}

// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
//  OBSERVER LOG v2 - COLUMNS MANAGER
//  Edit the live column set anytime (not just in the wizard): rename, reorder,
//  retype, re-role (+ role settings), set units, remove, add. Applying RECONCILES
//  logRows to the new column set without losing data for surviving keys.
// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

// A deep-ish working copy of logColumns the manager edits; committed on Apply.
let colMgrDraft: LogColumn[] = [];

/** Reconcile rows to a NEW column set: keep values for surviving keys, drop
 *  removed keys, default added keys (Status → 'Good', else ''). */
function reconcileLogRows(newCols: LogColumn[]): void {
  logRows = logRows.map((old) => {
    const r: LogRow = {};
    for (const c of newCols) {
      r[c.key] = (c.key in old) ? old[c.key] : (c.key === 'status' ? 'Good' : '');
    }
    return r;
  });
}

/** Derive a safe, unique column key from a label, avoiding collisions with the
 *  given set of in-use keys. */
function deriveColKey(label: string, used: Set<string>): string {
  let base = 'col_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (base === 'col_') base = 'col_new';
  let key = base; let n = 2;
  while (used.has(key)) key = `${base}_${n++}`;
  return key;
}

const COL_ROLES: { value: LogColRole; label: string }[] = [
  { value: 'plain', label: 'Plain' },
  { value: 'counter', label: 'Counter' },
  { value: 'time', label: 'Time' },
  { value: 'date', label: 'Date' },
  { value: 'pick', label: 'Pick (dropdown)' },
  { value: 'sps', label: 'SPS-linked' },
];
const COL_TYPES: LogColType[] = ['text', 'number', 'date', 'time', 'select'];
const SPS_SRCFIELDS: LogSrcField[] = ['lineName', 'point', 'easting', 'northing', 'elevation', 'upholeMs', 'staticMs', 'srcType'];
const SPS_SRCFIELD_LABEL: Record<LogSrcField, string> = {
  lineName: 'Line name', point: 'Point', easting: 'Easting', northing: 'Northing',
  elevation: 'Elevation', upholeMs: 'Uphole (ms)', staticMs: 'Static (ms)', srcType: 'Source type',
};

/** Open the Columns Manager modal (snapshots the live columns into a draft). */
function openColumnsManager(): void {
  colMgrDraft = logColumns.map((c) => ({ ...c, options: c.options ? [...c.options] : undefined }));
  renderColMgrList();
  const back = $opt('ologColMgrBack'); if (back) back.classList.add('open');
}
function closeColumnsManager(): void {
  const back = $opt('ologColMgrBack'); if (back) back.classList.remove('open');
}

/** Move a draft column up/down. */
function colMgrMove(i: number, delta: number): void {
  const j = i + delta;
  if (j < 0 || j >= colMgrDraft.length) return;
  const [c] = colMgrDraft.splice(i, 1);
  colMgrDraft.splice(j, 0, c);
  renderColMgrList();
}
/** Remove a draft column. */
function colMgrRemove(i: number): void {
  colMgrDraft.splice(i, 1);
  renderColMgrList();
}
/** Add a new blank draft column. */
function colMgrAdd(): void {
  const used = new Set(colMgrDraft.map((c) => c.key));
  const key = deriveColKey('column', used);
  colMgrDraft.push(withColRoleDefaults({ key, label: 'New column', group: 'Custom', type: 'text', role: 'plain' }));
  renderColMgrList();
  // Scroll the freshly added row into view.
  const list = $opt('ologColMgrList');
  if (list) list.scrollTop = list.scrollHeight;
}

/** Build the per-column editor list inside the manager modal. */
function renderColMgrList(): void {
  const host = $opt('ologColMgrList');
  if (!host) return;
  host.innerHTML = '';
  colMgrDraft.forEach((c, i) => host.appendChild(buildColMgrRow(c, i)));
  setText('ologColMgrCount', `${colMgrDraft.length} column${colMgrDraft.length === 1 ? '' : 's'}`);
}

/** One editor row in the Columns Manager. */
function buildColMgrRow(c: LogColumn, i: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'olog-cm-row';

  // Reorder + index
  const ord = document.createElement('div');
  ord.className = 'olog-cm-ord';
  ord.appendChild(cmIconBtn('↑', 'Move up', () => colMgrMove(i, -1)));
  ord.appendChild(cmIconBtn('↓', 'Move down', () => colMgrMove(i, 1)));
  row.appendChild(ord);

  // Label
  const label = cmInput('text', c.label, 'Label', (v) => { c.label = v; });
  label.classList.add('olog-cm-label');
  row.appendChild(cmField('Label', label));

  // Type
  const typeSel = cmSelect(COL_TYPES.map((t) => ({ value: t, label: t })), c.type, (v) => {
    c.type = v as LogColType;
    // Keep role/options coherent with the new type.
    if (c.type === 'select' && !c.options) c.options = ['Option 1'];
    renderColMgrList();
  });
  row.appendChild(cmField('Type', typeSel));

  // Role
  const roleSel = cmSelect(COL_ROLES, c.role ?? defaultColRole(c), (v) => {
    c.role = v as LogColRole;
    if (c.role === 'counter' && c.step == null) c.step = 1;
    if (c.role === 'sps' && c.srcField == null) c.srcField = LOG_SPS_SRCFIELD[c.key] ?? 'point';
    renderColMgrList();
  });
  row.appendChild(cmField('Role', roleSel));

  // Unit
  const unit = cmInput('text', c.unit ?? '', 'unit', (v) => { c.unit = v.trim() || undefined; });
  unit.classList.add('olog-cm-unit');
  row.appendChild(cmField('Unit', unit));

  // Role-specific settings
  const settings = document.createElement('div');
  settings.className = 'olog-cm-settings';
  const role = c.role ?? defaultColRole(c);
  if (role === 'counter') {
    const step = cmInput('number', String(c.step ?? 1), 'step', (v) => { const n = Number(v); c.step = isFinite(n) && n !== 0 ? n : 1; });
    step.classList.add('olog-cm-step');
    settings.appendChild(cmField('Step', step));
    const auto = document.createElement('label');
    auto.className = 'olog-cm-check';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!c.autoInc;
    cb.addEventListener('change', () => { c.autoInc = cb.checked; });
    auto.append(cb, document.createTextNode(' auto +'));
    settings.appendChild(auto);
  } else if (role === 'sps') {
    const fld = cmSelect(SPS_SRCFIELDS.map((f) => ({ value: f, label: SPS_SRCFIELD_LABEL[f] })), c.srcField ?? 'point', (v) => { c.srcField = v as LogSrcField; });
    settings.appendChild(cmField('SPS field', fld));
  } else if (c.type === 'select' || role === 'pick') {
    const opts = cmInput('text', (c.options ?? []).join(', '), 'comma,separated', (v) => {
      const arr = v.split(',').map((s) => s.trim()).filter((s) => s !== '');
      c.options = arr.length ? arr : ['Option 1'];
    });
    opts.classList.add('olog-cm-opts');
    settings.appendChild(cmField('Options', opts));
  }
  row.appendChild(settings);

  // Remove
  const rm = cmIconBtn('✕', 'Remove column', () => colMgrRemove(i));
  rm.classList.add('olog-cm-rm');
  row.appendChild(rm);
  return row;
}

// - small DOM builders for the manager -
function cmField(labelText: string, control: HTMLElement): HTMLElement {
  const f = document.createElement('div');
  f.className = 'olog-cm-field';
  const l = document.createElement('span'); l.className = 'olog-cm-flabel'; l.textContent = labelText;
  f.append(l, control);
  return f;
}
function cmInput(type: 'text' | 'number', value: string, ph: string, onChange: (v: string) => void): HTMLInputElement {
  const inp = document.createElement('input');
  inp.type = type; inp.value = value; inp.placeholder = ph; inp.className = 'olog-cm-input';
  inp.addEventListener('input', () => onChange(inp.value));
  return inp;
}
function cmSelect(opts: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'olog-cm-input';
  for (const o of opts) {
    const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label;
    if (o.value === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
function cmIconBtn(label: string, title: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'olog-cm-btn'; b.textContent = label; b.title = title;
  b.addEventListener('click', fn);
  return b;
}

/** Apply the manager draft: validate, normalise keys/roles, reconcile rows. */
function applyColumnsManager(): void {
  if (colMgrDraft.length === 0) { setText('ologColMgrStatus', 'Keep at least one column.'); return; }
  // Normalise: ensure non-empty labels, unique keys, role-coherent settings.
  const used = new Set<string>();
  const next: LogColumn[] = [];
  for (const c of colMgrDraft) {
    const label = (c.label ?? '').trim() || 'Column';
    let key = c.key;
    if (!key || used.has(key)) key = deriveColKey(label, used);
    used.add(key);
    const col: LogColumn = { ...c, key, label };
    // Drop stale role settings that don't apply to the chosen role.
    if (col.role !== 'counter') { delete col.step; delete col.autoInc; }
    if (col.role !== 'sps') delete col.srcField;
    if (col.type !== 'select' && col.role !== 'pick') delete col.options;
    withColRoleDefaults(col);
    next.push(col);
  }
  logColumns = next;
  reconcileLogRows(next);
  if (logRows.length === 0) logRows = [blankLogRow()];
  saveLog();
  closeColumnsManager();
  renderLog();
  updateHeaderClear();
  setLogExportStatus('Columns updated.');
}

// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
//  OBSERVER LOG v2 - TEMPLATES
//  A template = { meta (defaults), columns (roles + settings), srcType, timeSource,
//  ntpServer }. Save the current config under a name, load it onto the current /
//  fresh log, delete, plus Export → .json / Import ← .json.
// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

const LOG_TPL_KEY = 'seisconv.obslog.templates';
type LogTemplate = {
  name: string;
  meta: LogMeta;
  columns: LogColumn[];
  srcType: LogSrcType;
  timeSource: LogTimeSource;
  ntpServer: string;
};

/** Load the saved-templates map from localStorage ({} on miss / corruption). */
function loadTemplates(): Record<string, LogTemplate> {
  try {
    const s = localStorage.getItem(LOG_TPL_KEY);
    if (!s) return {};
    const o = JSON.parse(s) as Record<string, LogTemplate>;
    return (o && typeof o === 'object') ? o : {};
  } catch { return {}; }
}
function saveTemplates(map: Record<string, LogTemplate>): void {
  try { localStorage.setItem(LOG_TPL_KEY, JSON.stringify(map)); } catch { /* ignore quota */ }
}

/** Capture the current log configuration (NOT the rows) as a template object. */
function currentTemplate(name: string): LogTemplate {
  return {
    name,
    meta: { ...logMeta },
    columns: logColumns.map((c) => ({ ...c, options: c.options ? [...c.options] : undefined })),
    srcType: logSrcType,
    timeSource: logTimeSource,
    ntpServer: logNtpServer,
  };
}

/** Validate an unknown object as a template (returns a normalised copy or null). */
function asTemplate(o: unknown, fallbackName: string): LogTemplate | null {
  if (!o || typeof o !== 'object') return null;
  const t = o as Partial<LogTemplate>;
  if (!Array.isArray(t.columns) || t.columns.length === 0) return null;
  // Validate each column `key` against a safe identifier pattern and reject the
  // prototype-pollution names. Keys are used as dynamic object properties on plain
  // row objects (r[c.key] = …), so an imported template carrying key '__proto__'
  // (or 'constructor'/'prototype') would otherwise corrupt per-row state.
  const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const columns = t.columns
    .filter((c): c is LogColumn => {
      if (!c || typeof c !== 'object') return false;
      const k = (c as LogColumn).key;
      return typeof k === 'string' && SAFE_KEY.test(k) && !FORBIDDEN_KEYS.has(k);
    })
    .map((c) => withColRoleDefaults({ ...c }));
  if (columns.length === 0) return null;
  return {
    name: (typeof t.name === 'string' && t.name.trim()) ? t.name.trim() : fallbackName,
    meta: (t.meta && typeof t.meta === 'object') ? t.meta : {},
    columns,
    srcType: (t.srcType === 'explosive' || t.srcType === 'vibroseis' || t.srcType === 'nodal') ? t.srcType : 'explosive',
    timeSource: (t.timeSource === 'pc' || t.timeSource === 'ntp') ? t.timeSource : 'pc',
    ntpServer: (typeof t.ntpServer === 'string' && t.ntpServer.trim()) ? t.ntpServer.trim() : 'pool.ntp.org',
  };
}

/** Apply a template's columns/roles/meta-defaults/srcType/timeSource onto the log.
 *  Confirms before replacing columns when rows already exist. Reconciles rows so
 *  existing records survive (values kept for matching keys). */
async function applyTemplate(t: LogTemplate): Promise<void> {
  if (logColumns.length > 0 && logRows.length > 0 &&
      !(await confirmDelete(`Apply template “${t.name}”? It replaces the current ${logColumns.length} columns; existing record values are kept only for matching columns.`))) {
    return;
  }
  logMeta = { ...t.meta };
  logColumns = t.columns.map((c) => ({ ...c, options: c.options ? [...c.options] : undefined }));
  ensureColRoles();
  logSrcType = t.srcType;
  logTimeSource = t.timeSource;
  logNtpServer = t.ntpServer;
  reconcileLogRows(logColumns);
  if (logRows.length === 0) logRows = [blankLogRow()];
  saveLog();
  renderLog();
  syncTimeSrcUI();
  updateHeaderClear();
  setLogExportStatus(`Loaded template “${t.name}”.`);
}

/** Refresh the Templates <select> from localStorage (+ enable/disable actions). */
function refreshTemplateSelect(): void {
  const sel = $opt('ologTplSelect') as HTMLSelectElement | null;
  if (!sel) return;
  const map = loadTemplates();
  const names = Object.keys(map).sort((a, b) => a.localeCompare(b));
  const prev = sel.value;
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = names.length ? 'Choose template…' : '(no templates saved)';
  sel.appendChild(ph);
  for (const n of names) {
    const o = document.createElement('option'); o.value = n; o.textContent = n;
    sel.appendChild(o);
  }
  if (names.includes(prev)) sel.value = prev;
  const has = sel.value !== '';
  const load = $opt('ologTplLoad') as HTMLButtonElement | null;
  const del = $opt('ologTplDelete') as HTMLButtonElement | null;
  const exp = $opt('ologTplExport') as HTMLButtonElement | null;
  if (load) load.disabled = !has;
  if (del) del.disabled = !has;
  if (exp) exp.disabled = !has;
}

/** 'Save as template' - prompt for a name, store the current config. */
async function saveCurrentTemplate(): Promise<void> {
  if (logColumns.length === 0) { setLogExportStatus('Build the log first.'); return; }
  const suggested = (logMeta['project'] ?? '').trim() || 'Template';
  const name = (await promptInput('Save current configuration as template - name:', suggested, 'Save template') ?? '').trim();
  if (!name) return;
  const map = loadTemplates();
  if (map[name] && !(await confirmDelete(`A template named “${name}” exists - overwrite it?`))) return;
  map[name] = currentTemplate(name);
  saveTemplates(map);
  refreshTemplateSelect();
  const sel = $opt('ologTplSelect') as HTMLSelectElement | null;
  if (sel) { sel.value = name; refreshTemplateSelect(); }
  setLogExportStatus(`Saved template “${name}”.`);
}

/** 'Load' - apply the selected template. */
async function loadSelectedTemplate(): Promise<void> {
  const sel = $opt('ologTplSelect') as HTMLSelectElement | null;
  const name = sel?.value ?? '';
  if (!name) return;
  const map = loadTemplates();
  const t = map[name];
  if (!t) { refreshTemplateSelect(); return; }
  const norm = asTemplate(t, name);
  if (norm) await applyTemplate(norm);
}

/** 'Delete' - remove the selected template. */
async function deleteSelectedTemplate(): Promise<void> {
  const sel = $opt('ologTplSelect') as HTMLSelectElement | null;
  const name = sel?.value ?? '';
  if (!name) return;
  if (!(await confirmDelete(`Delete template “${name}”?`))) return;
  const map = loadTemplates();
  delete map[name];
  saveTemplates(map);
  refreshTemplateSelect();
  setLogExportStatus(`Deleted template “${name}”.`);
}

/** Export the selected template to a .json file (reuses exportText). */
async function exportSelectedTemplate(): Promise<void> {
  const sel = $opt('ologTplSelect') as HTMLSelectElement | null;
  const name = sel?.value ?? '';
  const map = loadTemplates();
  const t = name ? map[name] : null;
  // Fall back to the current config when nothing is selected.
  const tpl = t ?? (logColumns.length ? currentTemplate((logMeta['project'] ?? '').trim() || 'Template') : null);
  if (!tpl) { setLogExportStatus('Nothing to export.'); return; }
  const safe = (tpl.name || 'template').replace(/[^a-z0-9_-]+/gi, '-');
  try {
    const r = await api.exportText(`obslog-template-${safe}.json`, JSON.stringify(tpl, null, 2));
    if (r?.ok) setLogExportStatus(`Exported template “${tpl.name}”.`);
  } catch { /* ignore - dialog cancelled / write error */ }
}

/** Import a template from a .json file → save it + apply it. */
async function importTemplateJson(): Promise<void> {
  let raw: unknown = null;
  try { raw = await api.openTemplateJson(); } catch { return; }
  if (raw == null) return;
  const t = asTemplate(raw, 'Imported template');
  if (!t) { setLogExportStatus('That file is not a valid Observer Log template.'); return; }
  const map = loadTemplates();
  let name = t.name;
  if (map[name] && !(await confirmDelete(`A template named “${name}” exists - overwrite it?`))) {
    // Pick a non-clashing name rather than clobber.
    let n = 2; while (map[`${t.name} (${n})`]) n++;
    name = `${t.name} (${n})`;
    t.name = name;
  }
  map[name] = t;
  saveTemplates(map);
  refreshTemplateSelect();
  const sel = $opt('ologTplSelect') as HTMLSelectElement | null;
  if (sel) { sel.value = name; refreshTemplateSelect(); }
  await applyTemplate(t);
}

/** Build one <tr> for record index `i`, with editable cells + per-row actions.
 *  Each cell's editor is chosen by the column's ROLE (counter/time/date/pick/
 *  sps/plain); see buildLogCell. */
function buildLogRowEl(row: LogRow): HTMLTableRowElement {
  const i = logRows.indexOf(row);
  const tr = document.createElement('tr');
  tr.dataset.sig = logRowSig(row);
  logRowEls.set(row, tr);
  // Trigger Watch: a trigger-created row stays highlighted until the observer
  // edits it (the pending set is keyed by row-object identity, so it survives
  // re-renders and row reordering).
  if (trigPendingRows.has(row)) tr.classList.add('olog-row-pending');

  const rh = document.createElement('td');
  rh.className = 'olog-rowhdr';
  rh.textContent = String(i + 1);
  tr.appendChild(rh);

  for (const c of logColumns) tr.appendChild(buildLogCell(row, c));

  // Per-row action buttons: insert-above, delete, move up, move down.
  const act = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'olog-actions';
  // Indices shift as rows are inserted/deleted, so every action resolves the row's
  // CURRENT index by identity at click time.
  const at = () => logRows.indexOf(row);
  wrap.appendChild(rowBtn('+', 'Insert row above', () => { const k = at(); if (k < 0) return; logRows.splice(k, 0, blankLogRow()); saveLog(); renderLog(); }));
  wrap.appendChild(rowBtn('↑', 'Move up', () => moveLogRow(at(), -1)));
  wrap.appendChild(rowBtn('↓', 'Move down', () => moveLogRow(at(), 1)));
  wrap.appendChild(rowBtn('✕', 'Delete row', () => { void logDeleteRow(at()); }));
  act.appendChild(wrap);
  tr.appendChild(act);
  return tr;
}

/** Confirmed, audited, undoable delete of observer-log row at index `i`.
 *  Restores the row at its original position on undo. */
async function logDeleteRow(i: number) {
  if (i < 0 || i >= logRows.length) return;
  const saved = logRows[i];
  if (!(await confirmDelete(`Delete observer-log record ${i + 1}?`))) return;
  // Re-check by identity in case the list changed while the dialog was open.
  const pos = logRows.indexOf(saved);
  if (pos < 0) return;
  logRows.splice(pos, 1);
  saveLog();
  renderLog();
  updateHeaderClear();
  audit('delete', `observer-log record (row ${pos + 1})`, 'obslog');
  let undone = false;
  undoToast(`Deleted record ${pos + 1}`, () => {
    if (undone) return;
    undone = true;
    const at = Math.min(pos, logRows.length);
    logRows.splice(at, 0, saved);
    saveLog();
    renderLog();
    updateHeaderClear();
    audit('undo-delete', `observer-log record (row ${at + 1})`, 'obslog');
  });
}

/** Build a single editable <td> for row `i`, column `c`, dispatching on the
 *  column ROLE. Falls back to the plain editor for unknown roles. */
function buildLogCell(row: LogRow, c: LogColumn): HTMLTableCellElement {
  const role: LogColRole = c.role ?? defaultColRole(c);
  switch (role) {
    case 'pick': return logPickCell(row, c);
    case 'time': return logTimeCell(row, c);
    case 'date': return logDateCell(row, c);
    case 'counter': return logCounterCell(row, c);
    case 'sps': return logSpsCell(row, c);
    default: return logPlainCell(row, c);
  }
}

/** Read the current cell value as a display string. */
function logCellStr(row: LogRow, key: string): string {
  const raw = row?.[key];
  return raw == null ? '' : String(raw);
}

/** Commit a string value into a cell, coercing to number when the column is numeric.
 *  When the edited cell is a Shot point / Source line DRIVER, kick off a live SPS
 *  lookup that auto-fills the row's other sps-role columns (no-op without SPS). */
function commitLogCell(row: LogRow, c: LogColumn, v: string): void {
  const isNum = c.type === 'number' || c.role === 'counter';
  row[c.key] = isNum && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : v;
  saveLog();
  const i = logRows.indexOf(row);
  if (i < 0) return;
  // The row element now shows the committed value - keep its signature in step so
  // the next reconcile does not rebuild it needlessly.
  const tr = logRowEls.get(row);
  if (tr) tr.dataset.sig = logRowSig(row);
  trigClearPending(i); // an observer edit verifies a trigger-created pending row
  if (isSpsDriverColumn(c)) void liveSpsLookup(i);
}

/** Whether editing column `c` should trigger a live SPS row lookup (it carries the
 *  shot-point or source-line that drives the match). */
function isSpsDriverColumn(c: LogColumn): boolean {
  if (c.key === 'shotPoint' || c.key === 'srcLine') return true;
  return c.role === 'sps' && (c.srcField === 'point' || c.srcField === 'lineName');
}

/** Run the live SPS auto-fill for row `i`, re-rendering + persisting if it changed
 *  anything. Silently no-ops when there are no sps columns / no SPS loaded. */
async function liveSpsLookup(i: number): Promise<void> {
  if (!spsLinkAvailable()) return;
  try {
    if (await autoFillSpsRow(i)) { saveLog(); renderLog(); }
  } catch { /* ignore lookup failure */ }
}

/** Copy-on-Ctrl+C for a plain/number input (matches the original cell behaviour). */
function wireCellCopy(inp: HTMLInputElement): void {
  inp.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && inp.selectionStart === inp.selectionEnd) {
      void navigator.clipboard?.writeText(inp.value).catch(() => { /* ignore */ });
    }
  });
}

/** A bare cell wrapper that lays an input next to an optional inline button. */
function cellWithButton(inp: HTMLElement, btn?: HTMLElement): HTMLTableCellElement {
  const td = document.createElement('td');
  if (btn) {
    const wrap = document.createElement('div');
    wrap.className = 'olog-cell-wrap';
    wrap.append(inp, btn);
    td.appendChild(wrap);
  } else {
    td.appendChild(inp);
  }
  return td;
}

/** A small inline cell button (e.g. 'Now' / 'Today' / 'SPS'). */
function cellBtn(label: string, title: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'olog-cell-btn'; b.textContent = label; b.title = title;
  b.addEventListener('click', fn);
  return b;
}

/** 'plain' role - text/number input (the original default behaviour). */
function logPlainCell(row: LogRow, c: LogColumn): HTMLTableCellElement {
  const inp = document.createElement('input');
  inp.className = 'olog-cell' + (c.type === 'number' ? ' num' : '');
  inp.type = c.type === 'number' ? 'number' : 'text';
  inp.value = logCellStr(row, c.key);
  inp.addEventListener('change', () => commitLogCell(row, c, inp.value));
  wireCellCopy(inp);
  return cellWithButton(inp);
}

/** 'counter' role - number input. Auto-increment (prev+step) on add-row is an
 *  OPT-IN per-column flag honoured in addLogRow; the cell itself is a plain number. */
function logCounterCell(row: LogRow, c: LogColumn): HTMLTableCellElement {
  const inp = document.createElement('input');
  inp.className = 'olog-cell num';
  inp.type = 'number';
  if (c.step != null && isFinite(c.step)) inp.step = String(c.step);
  inp.value = logCellStr(row, c.key);
  if (c.autoInc) inp.title = `Auto-increment (+${c.step ?? 1}) on new row`;
  inp.addEventListener('change', () => commitLogCell(row, c, inp.value));
  wireCellCopy(inp);
  return cellWithButton(inp);
}

/** 'time' role - time input + a 'Now' button stamping HH:MM:SS from the (NTP-
 *  corrected) computer clock. */
function logTimeCell(row: LogRow, c: LogColumn): HTMLTableCellElement {
  const inp = document.createElement('input');
  inp.className = 'olog-cell';
  inp.type = 'time'; inp.step = '1';     // seconds resolution
  inp.value = logCellStr(row, c.key);
  inp.addEventListener('change', () => commitLogCell(row, c, inp.value));
  const btn = cellBtn('Now', `Stamp the current time (${logTimeSource === 'ntp' ? 'NTP-corrected' : 'PC clock'})`, () => {
    inp.value = nowTimeStr();
    commitLogCell(row, c, inp.value);
  });
  return cellWithButton(inp, btn);
}

/** 'date' role - date input + a 'Today' button. */
function logDateCell(row: LogRow, c: LogColumn): HTMLTableCellElement {
  const inp = document.createElement('input');
  inp.className = 'olog-cell';
  inp.type = 'date';
  inp.value = logCellStr(row, c.key);
  inp.addEventListener('change', () => commitLogCell(row, c, inp.value));
  const btn = cellBtn('Today', 'Set to today', () => {
    inp.value = todayDateStr();
    commitLogCell(row, c, inp.value);
  });
  return cellWithButton(inp, btn);
}

/** 'pick' role - <select> of the column's options (Status keeps its vocabulary
 *  + colour coding). */
function logPickCell(row: LogRow, c: LogColumn): HTMLTableCellElement {
  const td = document.createElement('td');
  const val = logCellStr(row, c.key);
  const sel = document.createElement('select');
  const isStatus = c.key === 'status';
  sel.className = 'olog-cell' + (isStatus ? ' olog-status-cell' : '');
  const opts = c.options ?? [];
  for (const opt of opts) {
    const o = document.createElement('option'); o.value = opt; o.textContent = opt;
    if (opt === val) o.selected = true;
    sel.appendChild(o);
  }
  if (isStatus) applyStatusClass(sel, val || (opts[0] ?? ''));
  sel.addEventListener('change', () => {
    row[c.key] = sel.value;
    const tr0 = logRowEls.get(row);
    if (isStatus) applyStatusClass(sel, sel.value);
    if (tr0) tr0.dataset.sig = logRowSig(row);
    saveLog();
  });
  td.appendChild(sel);
  return td;
}

/** 'sps' role - editable input plus an 'SPS' lookup affordance. The live lookup
 *  is wired by the backend agent via setSpsLookupHook; until then the button is
 *  disabled and the cell behaves as a plain editable input. */
function logSpsCell(row: LogRow, c: LogColumn): HTMLTableCellElement {
  const inp = document.createElement('input');
  inp.className = 'olog-cell' + (c.type === 'number' ? ' num' : '');
  inp.type = c.type === 'number' ? 'number' : 'text';
  inp.value = logCellStr(row, c.key);
  inp.addEventListener('change', () => commitLogCell(row, c, inp.value));
  wireCellCopy(inp);
  const btn = cellBtn('SPS', `Look up ${c.srcField ?? 'value'} from the loaded SPS survey`, () => {
    if (!spsLookupHook) return;
    void spsLookupHook(row, c).then((v) => {
      if (v == null) return;
      inp.value = String(v);
      row[c.key] = v;
      const tr1 = logRowEls.get(row);
      if (tr1) tr1.dataset.sig = logRowSig(row);
      saveLog();
    }).catch(() => { /* ignore lookup failure */ });
  });
  btn.disabled = !spsLookupHook || !spsLinkAvailable();  // needs the hook + a loaded survey
  return cellWithButton(inp, btn);
}

function rowBtn(label: string, title: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; b.title = title;
  b.addEventListener('click', fn);
  return b;
}

function moveLogRow(i: number, delta: number) {
  const j = i + delta;
  if (j < 0 || j >= logRows.length) return;
  const [r] = logRows.splice(i, 1);
  logRows.splice(j, 0, r);
  saveLog();
  renderLog();
}

/** Colour a Status <select> by its value (good/noisy/dead-family). */
function applyStatusClass(el: HTMLElement, val: string) {
  el.classList.remove('s-good', 's-noisy', 's-dead', 's-misfire', 's-reshoot');
  const v = val.toLowerCase();
  if (v === 'good') el.classList.add('s-good');
  else if (v === 'noisy') el.classList.add('s-noisy');
  else if (v === 'dead' || v === 'no-data' || v === 'dnp') el.classList.add('s-dead');
  else if (v === 'misfire') el.classList.add('s-misfire');
  else if (v === 're-shoot' || v === 'skip') el.classList.add('s-reshoot');
}

/** Append a fresh record + re-render. Counter columns with auto-increment ENABLED
 *  (the per-column opt-in flag, default OFF) pre-fill prev+step from the last row. */
function addLogRow() {
  const r = blankLogRow();
  const prev = logRows.length ? logRows[logRows.length - 1] : null;
  if (prev) {
    for (const c of logColumns) {
      if (c.role !== 'counter' || !c.autoInc) continue;
      const base = num(prev[c.key]);
      if (base == null) continue;           // nothing to count from → leave blank
      r[c.key] = base + (c.step ?? 1);
    }
  }
  logRows.push(r);
  saveLog();
  renderLog();
  updateHeaderClear();
}

// -- Renumber rows below (fix stuck / re-shot shots · recompute interval) --
// A small in-app dialog (NOT window.confirm/prompt): the observer picks an anchor
// row, confirms/edits its SP + the interval (+ optional File# start), and Apply
// recomputes SP (and optionally File#) for the anchor + every row after it using
// the pure `renumberBelow`. Every write is audited.
function closeRenumberModal(): void { $opt('ologRenumBack')?.classList.remove('open'); }
function openRenumberModal(): void {
  if (logRows.length === 0) { infoToast('Add or trigger some rows first - Renumber recomputes existing rows.'); return; }
  const from = $opt('ologRenumFrom') as HTMLInputElement | null;
  if (from) {
    from.min = '1'; from.max = String(logRows.length);
    const cur = Math.round(Number(from.value));
    if (!(cur >= 1 && cur <= logRows.length)) from.value = '1';
  }
  // Force a fresh pre-fill of SP + interval from the chosen anchor.
  const spEl = $opt('ologRenumSp') as HTMLInputElement | null; if (spEl) spEl.value = '';
  const intEl = $opt('ologRenumInterval') as HTMLInputElement | null; if (intEl) intEl.value = '';
  const fileEl = $opt('ologRenumFile') as HTMLInputElement | null; if (fileEl) fileEl.value = '';
  syncRenumberPreview();
  setText('ologRenumStatus', '');
  $opt('ologRenumBack')?.classList.add('open');
}
/** Pre-fill the anchor's current SP + a default interval, and describe the effect. */
function syncRenumberPreview(): void {
  const fromEl = $opt('ologRenumFrom') as HTMLInputElement | null;
  const idx = Math.max(1, Math.min(logRows.length, Math.round(Number(fromEl?.value ?? 1)) || 1)) - 1;
  const row = logRows[idx];
  const spEl = $opt('ologRenumSp') as HTMLInputElement | null;
  if (spEl && document.activeElement !== spEl) {
    const sp = row ? rowShotPoint(row) : null;
    spEl.value = sp != null ? String(sp) : '';
  }
  const intEl = $opt('ologRenumInterval') as HTMLInputElement | null;
  if (intEl && (intEl.value.trim() === '' || document.activeElement !== intEl)) {
    const an = trigCfg.autonum;
    const inc = an.spDir * an.spStep * an.spInterval;
    intEl.value = String(Number.isFinite(inc) && inc !== 0 ? inc : 1);
  }
  const below = Math.max(0, logRows.length - (idx + 1));
  setText('ologRenumHint', `Anchor = row ${idx + 1}. Its SP is set to the value below, then the ${below} row${below === 1 ? '' : 's'} after it recompute: SP advances by the interval each row (and File# by +1 when a File# start is given).`);
}
function applyRenumber(): void {
  const fromEl = $opt('ologRenumFrom') as HTMLInputElement | null;
  const spEl = $opt('ologRenumSp') as HTMLInputElement | null;
  const intEl = $opt('ologRenumInterval') as HTMLInputElement | null;
  const fileEl = $opt('ologRenumFile') as HTMLInputElement | null;
  const fromIdx = Math.round(Number(fromEl?.value ?? NaN)) - 1;
  if (!Number.isInteger(fromIdx) || fromIdx < 0 || fromIdx >= logRows.length) { setText('ologRenumStatus', 'Pick a valid anchor row (1…' + logRows.length + ').'); return; }
  const startSP = Number(spEl?.value ?? NaN);
  if (!Number.isFinite(startSP)) { setText('ologRenumStatus', 'Anchor SP must be a number.'); return; }
  const interval = Number(intEl?.value ?? NaN);
  if (!Number.isFinite(interval)) { setText('ologRenumStatus', 'Interval must be a number (may be negative for down-line).'); return; }
  const fileRaw = (fileEl?.value ?? '').trim();
  const startFile = fileRaw === '' ? null : Number(fileRaw);
  if (startFile != null && !Number.isFinite(startFile)) { setText('ologRenumStatus', 'File# start must be a number (or blank to leave File# alone).'); return; }
  const spKey = autonumSpColKey();
  const fKey = autonumFileColKey();
  if (!spKey) { setText('ologRenumStatus', 'This log has no Shot-point column to renumber.'); return; }
  const snapshot: RenumRow[] = logRows.map((r) => ({ sp: rowShotPoint(r), file: fKey ? num(r[fKey]) : null }));
  const out = renumberBelow(snapshot, fromIdx, { startSP, interval, startFile });
  for (let i = fromIdx; i < logRows.length; i++) {
    if (spKey && out[i].sp != null) logRows[i][spKey] = out[i].sp as number;
    if (fKey && startFile != null && out[i].file != null) logRows[i][fKey] = out[i].file as number;
    trigClearPending(i); // an authoritative human renumber verifies the touched rows
  }
  saveLog();
  renderLog();
  updateHeaderClear();
  const count = logRows.length - fromIdx;
  audit('renumber', `renumbered SP${startFile != null ? ' + File#' : ''} from row ${fromIdx + 1} (start SP ${startSP}, interval ${interval}${startFile != null ? `, File# start ${startFile}` : ''}) across ${count} row${count === 1 ? '' : 's'}`, 'obslog');
  closeRenumberModal();
  infoToast(`Renumbered ${count} row${count === 1 ? '' : 's'} from row ${fromIdx + 1}.`);
}

/** Wire the Observer Log controls (wizard + grid toolbar). Called once at init. */
function initObsLog() {
  loadLogState();
  // Wizard: source-type radios
  $opt('ologSrcRadios')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).value;
    if (v === 'explosive' || v === 'vibroseis' || v === 'nodal') { logSrcType = v; syncSrcRadios(); }
  });
  // Wizard: row-mode radios (just reflect selection)
  $opt('ologRowRadios')?.addEventListener('change', syncRowRadios);
  // Wizard: custom column add
  $opt('ologCustAdd')?.addEventListener('click', addCustomColumn);
  $opt('ologCustName')?.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); addCustomColumn(); } });
  // Wizard: build
  $opt('ologBuildBtn')?.addEventListener('click', () => void buildLog());
  // Grid toolbar
  $opt('ologAddRowBtn')?.addEventListener('click', addLogRow);
  // Renumber rows below (fix stuck / re-shot shots · recompute the interval).
  $opt('ologRenumBtn')?.addEventListener('click', openRenumberModal);
  $opt('ologRenumClose')?.addEventListener('click', closeRenumberModal);
  $opt('ologRenumCancel')?.addEventListener('click', closeRenumberModal);
  $opt('ologRenumApply')?.addEventListener('click', applyRenumber);
  $opt('ologRenumBack')?.addEventListener('click', (e) => { if (e.target === $opt('ologRenumBack')) closeRenumberModal(); });
  $opt('ologRenumFrom')?.addEventListener('input', syncRenumberPreview);
  $opt('ologRenumFrom')?.addEventListener('change', syncRenumberPreview);
  $opt('ologReconfigBtn')?.addEventListener('click', () => { openLogWizard(); });
  $opt('ologSaveBtn')?.addEventListener('click', () => void saveLogJson());
  $opt('ologReloadBtn')?.addEventListener('click', () => void reloadLogJson());
  // Columns Manager (edit columns anytime, not just in the wizard).
  $opt('ologColsBtn')?.addEventListener('click', openColumnsManager);
  $opt('ologColMgrClose')?.addEventListener('click', closeColumnsManager);
  $opt('ologColMgrBack')?.addEventListener('click', (e) => { if (e.target === $opt('ologColMgrBack')) closeColumnsManager(); });
  $opt('ologColMgrAdd')?.addEventListener('click', colMgrAdd);
  $opt('ologColMgrApply')?.addEventListener('click', applyColumnsManager);
  $opt('ologColMgrCancel')?.addEventListener('click', closeColumnsManager);
  // Templates (save / load / delete / export / import named configurations).
  refreshTemplateSelect();
  $opt('ologTplSelect')?.addEventListener('change', refreshTemplateSelect);
  $opt('ologTplSave')?.addEventListener('click', () => void saveCurrentTemplate());
  $opt('ologTplLoad')?.addEventListener('click', () => void loadSelectedTemplate());
  $opt('ologTplDelete')?.addEventListener('click', () => void deleteSelectedTemplate());
  $opt('ologTplExport')?.addEventListener('click', () => void exportSelectedTemplate());
  $opt('ologTplImport')?.addEventListener('click', () => void importTemplateJson());
  // SPS link: bulk 'Import sources from SPS' (live lookup is wired via the hook).
  $opt('ologSpsImportBtn')?.addEventListener('click', () => void importRowsFromSps());
  installSpsLookupHook();
  // Time-source control (PC clock | NTP + server + Sync).
  initLogTimeSource();
  // Trigger Watch (live row on shot trigger): bar + config + catch-up modals.
  initTrigWatch();
}

// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
//  Observer Log "Trigger Watch" - a live row the moment a shot TRIGGERS.
//
//  Sources (any combination, armed by the master toggle): the watched SCS
//  acquisition folder (works today; latency = the moment SCS writes the file),
//  a UDP listener (localhost by default), and - next update - the serial trigger
//  box's USB-serial [SHOT] feed. Main owns the sources (TriggerHub) and pushes
//  events here; this section owns the UI, the TWO-STAGE rows (instant pending
//  row → enriched when the shot file lands), the catch-up prompt, and the
//  persisted configuration. The observer stays in charge: auto-rows stay
//  highlighted until HE edits them, and every auto-write is audited.
// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

/** File# / FFID source mode for Auto-number:
 *   counter   - seed a start, +1 each trigger (instant, reads no file).
 *   reconcile - instant counter value on trigger, THEN correct it from the landed
 *               .dat's REAL File# (instant AND drift-proof; mismatches are flagged).
 *   real      - leave File# blank on trigger; fill it from the landed .dat. */
type TrigFileMode = 'counter' | 'reconcile' | 'real';
/** Auto-number (shot-controller) configuration for Trigger Watch. */
type TrigAutoNum = {
  enabled: boolean;          // master Auto-advance ON/OFF
  spStart: number;           // SP seeded on the first auto-row (no previous SP)
  spStep: number;            // station move per shot (≥ 0)
  spDir: 1 | -1;             // +1 up-line, -1 down-line
  spInterval: number;        // interval multiplier (delta = dir × step × interval)
  fileStart: number;         // File#/FFID seeded on the first auto-row
  fileMode: TrigFileMode;    // counter | reconcile | real
  scFilesDir: string;        // recorder save folder read for reconcile/real
};
type TrigWatchCfg = {
  sound: boolean;
  /** Chosen trigger system (extensible registry - see core/obslog/trigsystems).
   *  'geode' bundles the TempCom trigger + SC_Files File# sync; 'generic' is the
   *  self-wired folder/UDP/serial/SCS-log setup. */
  system: TrigSystemId;
  folder: { enabled: boolean; dir: string };
  udp: { enabled: boolean; port: number; bindAll: boolean };
  serial: { enabled: boolean; port: string; baud: number };
  scslog: { enabled: boolean; path: string };
  scstrig: { enabled: boolean; dir: string };
  autonum: TrigAutoNum;
  /** Newest shot-file mtime already logged - the catch-up "last row" mark. */
  lastMtimeMs: number;
};
const TRIGWATCH_KEY = 'seisconv.obslog.triggerwatch';
const TRIG_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400];
const TRIG_MATCH_WINDOW_MS = 120000; // trigger→file match window (arrival order)
const TRIG_SCS_DEFAULT_LOG = 'C:\\GeometricsSurveysAndSettings\\SC\\Survey Parameters\\SC_Survey.0000.log';
const TRIG_SCSTRIG_DEFAULT_DIR = 'C:\\GeometricsSurveysAndSettings\\SC\\TempCom';
const TRIG_SCFILES_DEFAULT_DIR = 'C:\\SC_Files';

function trigDefaultAutoNum(): TrigAutoNum {
  return {
    enabled: false,
    spStart: 1001,
    spStep: 1,
    spDir: 1,
    spInterval: 1,
    fileStart: 1,
    fileMode: 'counter',
    scFilesDir: TRIG_SCFILES_DEFAULT_DIR,
  };
}
function trigDefaultCfg(): TrigWatchCfg {
  return {
    sound: true,
    system: DEFAULT_TRIG_SYSTEM,
    folder: { enabled: true, dir: '' },
    udp: { enabled: false, port: 8626, bindAll: false },
    serial: { enabled: false, port: 'COM3', baud: 115200 },
    scslog: { enabled: false, path: TRIG_SCS_DEFAULT_LOG },
    scstrig: { enabled: false, dir: TRIG_SCSTRIG_DEFAULT_DIR },
    autonum: trigDefaultAutoNum(),
    lastMtimeMs: 0,
  };
}
let trigCfg: TrigWatchCfg = trigDefaultCfg();

// Which sources main confirmed as running (drives the armed dot / master state).
const trigActive = { folder: false, udp: false, serial: false, scslog: false, scstrig: false };
function trigIsOn(): boolean { return trigActive.folder || trigActive.udp || trigActive.serial || trigActive.scslog || trigActive.scstrig; }

// Trigger-created rows not yet verified by the observer, keyed by ROW OBJECT
// identity (stable across re-renders/reorders; dropped naturally on reload).
type TrigPendingInfo = {
  source: string;
  awaitingFile: boolean;
  createdMs: number;
  /** Auto-number reconcile/real: this row still awaits the recorder's landed .dat
   *  to correct (reconcile) or fill (real) its File#/FFID. */
  awaitingScFile?: boolean;
  scMode?: TrigFileMode;
};
const trigPendingRows = new Map<LogRow, TrigPendingInfo>();

let trigChain: Promise<void> = Promise.resolve(); // serialises event handling
let trigEventsWired = false;
let trigSessionCount = 0;
let trigAudio: AudioContext | null = null;
let trigDotTimer: number | null = null;
let trigCatchFiles: TrigScanFile[] = [];

// -- Config persistence (seisconv.obslog.triggerwatch) --
// Same defensive template as loadLogState: validate SHAPE + reject prototype-
// pollution keys; any malformed field falls back to a clean default config.
function saveTrigCfg(): void {
  try { localStorage.setItem(TRIGWATCH_KEY, JSON.stringify(trigCfg)); } catch { /* ignore quota */ }
}
function loadTrigCfg(): void {
  const cfg = trigDefaultCfg();
  try {
    const s = localStorage.getItem(TRIGWATCH_KEY);
    if (!s) { trigCfg = cfg; return; }
    const o = JSON.parse(s) as Record<string, unknown>;
    if (!isPlainObj(o) || !ownKeysSafe(o)) throw new Error('bad root');
    if (typeof o.sound === 'boolean') cfg.sound = o.sound;
    if (typeof o.lastMtimeMs === 'number' && Number.isFinite(o.lastMtimeMs) && o.lastMtimeMs >= 0) cfg.lastMtimeMs = o.lastMtimeMs;
    const f = o.folder;
    if (isPlainObj(f) && ownKeysSafe(f)) {
      if (typeof f.enabled === 'boolean') cfg.folder.enabled = f.enabled;
      if (typeof f.dir === 'string' && f.dir.length <= 512) cfg.folder.dir = f.dir;
    }
    const u = o.udp;
    if (isPlainObj(u) && ownKeysSafe(u)) {
      if (typeof u.enabled === 'boolean') cfg.udp.enabled = u.enabled;
      if (typeof u.port === 'number' && Number.isInteger(u.port) && u.port >= 1 && u.port <= 65535) cfg.udp.port = u.port;
      if (typeof u.bindAll === 'boolean') cfg.udp.bindAll = u.bindAll;
    }
    const se = o.serial;
    if (isPlainObj(se) && ownKeysSafe(se)) {
      if (typeof se.enabled === 'boolean') cfg.serial.enabled = se.enabled;
      if (typeof se.port === 'string' && /^COM\d{1,3}$/i.test(se.port)) cfg.serial.port = se.port.toUpperCase();
      if (typeof se.baud === 'number' && TRIG_BAUDS.includes(se.baud)) cfg.serial.baud = se.baud;
    }
    const sc = o.scslog;
    if (isPlainObj(sc) && ownKeysSafe(sc)) {
      if (typeof sc.enabled === 'boolean') cfg.scslog.enabled = sc.enabled;
      if (typeof sc.path === 'string' && sc.path.length <= 512) cfg.scslog.path = sc.path;
    }
    const st = o.scstrig;
    if (isPlainObj(st) && ownKeysSafe(st)) {
      if (typeof st.enabled === 'boolean') cfg.scstrig.enabled = st.enabled;
      if (typeof st.dir === 'string' && st.dir.length <= 512) cfg.scstrig.dir = st.dir;
    }
    // Trigger system (added later - older saved configs have no `system`). Migrate
    // old→new: a config that already had the SCS TempCom (scstrig) source enabled
    // is treated as the Geode system so those users keep working; everything else
    // keeps the historical folder-watch default (generic).
    cfg.system = migrateTrigSystemId(o.system, cfg.scstrig.enabled);
    // Auto-number block (added later - older saved configs have no `autonum`, so
    // every field falls back to the clean default). Numeric fields are validated
    // finite; the File# mode is restricted to the known set.
    const an = o.autonum;
    if (isPlainObj(an) && ownKeysSafe(an)) {
      if (typeof an.enabled === 'boolean') cfg.autonum.enabled = an.enabled;
      if (typeof an.spStart === 'number' && Number.isFinite(an.spStart)) cfg.autonum.spStart = an.spStart;
      if (typeof an.spStep === 'number' && Number.isFinite(an.spStep) && an.spStep >= 0) cfg.autonum.spStep = an.spStep;
      if (an.spDir === 1 || an.spDir === -1) cfg.autonum.spDir = an.spDir;
      if (typeof an.spInterval === 'number' && Number.isFinite(an.spInterval) && an.spInterval > 0) cfg.autonum.spInterval = an.spInterval;
      if (typeof an.fileStart === 'number' && Number.isFinite(an.fileStart)) cfg.autonum.fileStart = Math.trunc(an.fileStart);
      if (an.fileMode === 'counter' || an.fileMode === 'reconcile' || an.fileMode === 'real') cfg.autonum.fileMode = an.fileMode;
      if (typeof an.scFilesDir === 'string' && an.scFilesDir.length <= 512) cfg.autonum.scFilesDir = an.scFilesDir;
    }
    trigCfg = cfg;
  } catch (e) {
    trigCfg = trigDefaultCfg();
    try { console.warn('loadTrigCfg: rejected corrupt Trigger Watch config -', e); } catch { /* ignore */ }
  }
}

// -- UI sync + feedback (dot / labels / beep) --
function syncTrigUi(): void {
  const on = trigIsOn();
  const btn = $opt('otwToggle');
  if (btn) { btn.textContent = on ? 'Trigger Watch: ON' : 'Trigger Watch: OFF'; btn.classList.toggle('on', on); }
  $opt('otwDot')?.classList.toggle('armed', on);
  const snd = $opt('otwSound');
  if (snd) snd.textContent = trigCfg.sound ? 'Sound: ON' : 'Sound: OFF';
  const parts: string[] = [];
  if (on) {
    if (trigActive.folder) parts.push('folder');
    if (trigActive.udp) parts.push('UDP');
    if (trigActive.serial) parts.push('serial');
    if (trigActive.scslog) parts.push('SCS log');
    if (trigActive.scstrig) parts.push('SCS trigger');
  }
  setText('otwStatus', on
    ? `armed (${parts.join(' + ')})${trigSessionCount ? ` · ${trigSessionCount} trigger${trigSessionCount === 1 ? '' : 's'}` : ''}`
    : '');
}
/** Flash the status dot amber for a moment on every trigger event. */
function trigFlashDot(): void {
  const dot = $opt('otwDot');
  if (!dot) return;
  dot.classList.add('evt');
  if (trigDotTimer != null) clearTimeout(trigDotTimer);
  trigDotTimer = window.setTimeout(() => { dot.classList.remove('evt'); trigDotTimer = null; }, 650);
}
/** Short Web-Audio beep (no audio asset); honours the sound toggle. */
function trigBeep(): void {
  if (!trigCfg.sound) return;
  try {
    trigAudio ??= new AudioContext();
    const ctx = trigAudio;
    if (ctx.state === 'suspended') void ctx.resume();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch { /* no audio device - stay silent */ }
}

// -- Pending-row bookkeeping --
/** Un-highlight row `i` after an observer edit (the human verified it). */
function trigClearPending(i: number): void {
  const row = logRows[i];
  if (!row || !trigPendingRows.delete(row)) return;
  const tr = logRowEls.get(row);
  if (tr) { tr.classList.remove('olog-row-pending'); tr.dataset.sig = logRowSig(row); return; }
  const tbody = $opt('ologTbody');
  tbody?.children[i]?.classList.remove('olog-row-pending');
}
/** Oldest pending row still waiting for its shot file (within the match window). */
function trigOldestAwaiting(): LogRow | null {
  let best: LogRow | null = null;
  let bestMs = Infinity;
  const now = Date.now();
  for (const [row, info] of trigPendingRows) {
    if (!info.awaitingFile || now - info.createdMs > TRIG_MATCH_WINDOW_MS) continue;
    if (!logRows.includes(row)) { trigPendingRows.delete(row); continue; }
    if (info.createdMs < bestMs) { bestMs = info.createdMs; best = row; }
  }
  return best;
}
/** Oldest pending row still awaiting the recorder's .dat for File# reconcile/real
 *  (within the match window). Matches enrichment to rows by arrival order. */
function trigOldestAwaitingScFile(): LogRow | null {
  let best: LogRow | null = null;
  let bestMs = Infinity;
  const now = Date.now();
  for (const [row, info] of trigPendingRows) {
    if (!info.awaitingScFile || now - info.createdMs > TRIG_MATCH_WINDOW_MS) continue;
    if (!logRows.includes(row)) { trigPendingRows.delete(row); continue; }
    if (info.createdMs < bestMs) { bestMs = info.createdMs; best = row; }
  }
  return best;
}

/** ENRICHMENT (never a trigger) - a recorded .dat landed in the SC_Files folder.
 *  Correct (reconcile) or fill (real) the matching auto-row's File#/FFID from the
 *  file's REAL number (header FFID, else the file-name digits). Does NOT clear the
 *  row's pending highlight (only an observer edit verifies a row). Audited. */
function trigApplyScFile(ev: Extract<TrigEventMsg, { type: 'scfile' }>): void {
  const row = trigOldestAwaitingScFile();
  if (!row) return; // nothing awaiting - this .dat isn't for an auto-row we track
  const info = trigPendingRows.get(row);
  if (info) info.awaitingScFile = false;
  const fKey = autonumFileColKey();
  if (!fKey) return;
  const digits = /(\d{2,9})/.exec(ev.name);
  const real = ev.ffid ?? (digits ? Number(digits[1]) : null);
  if (real == null) return; // couldn't read a real File# - keep the counter value / blank
  const i = logRows.indexOf(row);
  const prev = num(row[fKey]);
  const mode = info?.scMode ?? 'reconcile';
  if (mode === 'reconcile' && prev != null && prev === real) {
    audit('trigger', `row ${i + 1} File# ${real} confirmed by ${ev.name}`, 'obslog');
    return; // counter already matched reality - nothing to correct
  }
  row[fKey] = real;
  saveLog();
  renderLog();
  if (mode === 'reconcile' && prev != null) {
    infoToast(`File# corrected on row ${i + 1}: ${prev} → ${real} (from ${ev.name}).`);
    audit('trigger', `row ${i + 1} File# corrected ${prev} → ${real} from ${ev.name} (reconcile mismatch)`, 'obslog');
  } else {
    infoToast(`File# ${real} filled on row ${i + 1} (from ${ev.name}).`);
    audit('trigger', `row ${i + 1} File# ${real} filled from ${ev.name} (${mode})`, 'obslog');
  }
}

// -- Row creation + enrichment (the two-stage flow) --
/** Event timestamp → Date: ISO first, then bare HH:MM:SS (today), else null. */
function trigParseTs(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (!isNaN(d.getTime())) return d;
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(ts.trim());
  if (hm) {
    const n = effectiveNow();
    n.setHours(Math.min(23, Number(hm[1])), Math.min(59, Number(hm[2])), Math.min(59, Number(hm[3] ?? 0)), 0);
    return n;
  }
  return null;
}
function trigFmtTime(d: Date): string { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function trigFmtDate(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
/** SCS-log `HH:MM:SS.ss` + `MM/DD/YYYY` → a local Date (the shot's own logged
 *  time, NOT the wall clock); null if either field is unparseable. */
function scsLogToDate(time: string, date: string): Date | null {
  const t = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(time.trim());
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date.trim()); // MM/DD/YYYY (US order)
  if (!t || !d) return null;
  const ms = t[4] ? Number((t[4] + '000').slice(0, 3)) : 0;
  const dt = new Date(Number(d[3]), Number(d[1]) - 1, Number(d[2]), Number(t[1]), Number(t[2]), Number(t[3]), ms);
  return isNaN(dt.getTime()) ? null : dt;
}

/** Fill the row's shot-point/line: the event's explicit SP when it carried one,
 *  else the NEXT source after the last logged SP in the loaded SPS order (the
 *  X/S shooting order as returned by the worker); first source when the log has
 *  no SP yet. No-op without an SPS. */
async function trigFillSourcePoint(r: LogRow, sp: number | null, line: string | null): Promise<void> {
  const ptCol = logColumns.find((c) => (c.role === 'sps' && c.srcField === 'point') || c.key === 'shotPoint');
  const lnCol = logColumns.find((c) => (c.role === 'sps' && c.srcField === 'lineName') || c.key === 'srcLine');
  let point = sp;
  let lineName = line;
  if (point == null) {
    const sources = await getSpsSources();
    if (sources.length > 0) {
      let lastIdx = -1;
      for (let i = logRows.length - 1; i >= 0; i--) {
        const p = rowShotPoint(logRows[i]);
        if (p == null) continue;
        const ln = rowSrcLine(logRows[i]);
        const norm = (s: string) => s.trim().toLowerCase();
        lastIdx = sources.findIndex((s) => s.point === p && (ln == null || norm(s.lineName) === norm(ln)));
        if (lastIdx < 0) lastIdx = sources.findIndex((s) => s.point === p);
        break;
      }
      const next = sources[lastIdx + 1]; // -1+1=0 → first source when none logged yet
      if (next) { point = next.point; lineName = next.lineName; }
    }
  }
  if (point != null && ptCol) r[ptCol.key] = point;
  if (lineName != null && lnCol && String(r[lnCol.key] ?? '') === '') r[lnCol.key] = lineName;
}

// -- Auto-number (shot-controller) row fill --
/** The live SP column key (an sps 'point'-linked column, else the default
 *  'shotPoint'), or null when the log has none. */
function autonumSpColKey(): string | null {
  const c = logColumns.find((col) => (col.role === 'sps' && col.srcField === 'point') || col.key === 'shotPoint');
  return c ? c.key : null;
}
/** The live File#/FFID column key ('ffid'), or null when the log has none. */
function autonumFileColKey(): string | null {
  return logColumns.some((col) => col.key === 'ffid') ? 'ffid' : null;
}
/** Newest numeric value of column `key` across the existing rows (scanning back). */
function autonumLastNum(key: string): number | null {
  for (let i = logRows.length - 1; i >= 0; i--) {
    const v = num(logRows[i][key]);
    if (v != null) return v;
  }
  return null;
}
/** Apply Auto-number to a fresh trigger row `r` (NOT yet pushed): fixed-step SP +
 *  File# per the chosen mode, OVERRIDING the counter++/SPS guesses so the log
 *  advances like a shot controller. Human-in-loop - the row stays highlighted and
 *  every cell inline-editable. Returns whether the row awaits the recorder's .dat
 *  for File# reconcile/real. */
function autonumApplyRow(r: LogRow): { awaitingScFile: boolean; scMode: TrigFileMode } {
  const an = trigCfg.autonum;
  const spKey = autonumSpColKey();
  if (spKey) {
    const prevSp = autonumLastNum(spKey);
    const cfg: SPStepCfg = { step: an.spStep, dir: an.spDir, interval: an.spInterval };
    const sp = prevSp != null ? nextSP(prevSp, cfg) : an.spStart; // seed the start on the first auto-row
    if (sp != null) r[spKey] = sp;
  }
  const fKey = autonumFileColKey();
  if (fKey) {
    if (an.fileMode === 'real') r[fKey] = '';                       // blank until the .dat lands
    else r[fKey] = nextFile(autonumLastNum(fKey), an.fileStart);    // counter + reconcile: instant value
  }
  return { awaitingScFile: an.fileMode === 'reconcile' || an.fileMode === 'real', scMode: an.fileMode };
}

/** STAGE 1 - append a highlighted pending row for one trigger event: counter++
 *  from the last row, time/date ← the event's (GPS) timestamp, next source
 *  station from the loaded SPS order, sps-linked columns auto-filled. When
 *  Auto-number is ON, fixed-step SP + File# (per mode) OVERRIDE those guesses.
 *  Audited. */
async function trigCreateRow(opts: { ts: string | null; sp: number | null; line: string | null; source: string; awaitingFile: boolean; ffid?: number | null; when?: Date | null }): Promise<LogRow> {
  const r = blankLogRow();
  const prev = logRows.length ? logRows[logRows.length - 1] : null;
  // counter++ on every counter-role column (trigger rows are auto-filled by
  // design; enrichment overwrites FFID with the real value when the file lands).
  if (prev) {
    for (const c of logColumns) {
      if (c.role !== 'counter') continue;
      const base = num(prev[c.key]);
      if (base != null) r[c.key] = base + (c.step ?? 1);
    }
  }
  // SCS-log rows carry the log's real File # as the FFID (not a counter++ guess).
  if (opts.ffid != null) {
    const ffidCol = logColumns.find((c) => c.key === 'ffid');
    if (ffidCol) r[ffidCol.key] = opts.ffid;
  }
  const d = opts.when ?? trigParseTs(opts.ts) ?? effectiveNow();
  for (const c of logColumns) {
    if (c.role === 'time') r[c.key] = trigFmtTime(d);
    else if (c.role === 'date') r[c.key] = trigFmtDate(d);
  }
  await trigFillSourcePoint(r, opts.sp, opts.line);
  // Auto-number (shot controller) OWNS SP + File# when enabled, overriding the
  // counter++/SPS guesses above so numbering advances predictably.
  const auto = trigCfg.autonum.enabled ? autonumApplyRow(r) : null;
  logRows.push(r);
  trigPendingRows.set(r, {
    source: opts.source, awaitingFile: opts.awaitingFile, createdMs: Date.now(),
    ...(auto?.awaitingScFile ? { awaitingScFile: true, scMode: auto.scMode } : {}),
  });
  // Auto-fill the remaining sps-role columns from the matched source (no-op
  // without an SPS); values land before the single render below.
  try { const i = logRows.indexOf(r); if (i >= 0) await autoFillSpsRow(i); } catch { /* lookup failure is fine */ }
  saveLog();
  renderLog();
  updateHeaderClear();
  const n = logRows.length;
  const spTxt = num(r['shotPoint']) != null ? ` SP ${r['shotPoint']}` : '';
  audit('trigger', `row ${n} added by trigger (${opts.source}${spTxt})`, 'obslog');
  return r;
}

/** STAGE 2 - enrich a row from the landed shot file: FFID (header, else the
 *  file-name digits), file name, traces / sample interval / record length.
 *  Retries once after 500 ms (SCS may still be writing). NEVER overwrites a
 *  cell the observer (or stage 1) already filled. */
async function trigEnrichRow(row: LogRow, filePath: string, fileName: string): Promise<void> {
  let meta: TrigQuickMeta | null = null;
  for (let attempt = 0; attempt < 2 && !meta; attempt++) {
    try {
      const res = await api.triggerQuickMeta(filePath);
      if (res?.ok && res.meta) meta = res.meta;
    } catch { /* worker/IPC hiccup → retry below */ }
    if (!meta && attempt === 0) await new Promise((res) => window.setTimeout(res, 500));
  }
  const info = trigPendingRows.get(row);
  if (info) info.awaitingFile = false;
  const put = (key: string, v: string | number | null | undefined) => {
    if (v == null || v === '') return;
    if (!logColumns.some((c) => c.key === key)) return;
    const cur = row[key];
    if (cur != null && cur !== '' && key !== 'ffid') return; // only FFID may replace its counter++ guess
    row[key] = v;
  };
  const digits = /(\d{2,9})/.exec(fileName);
  put('ffid', meta?.ffid ?? (digits ? Number(digits[1]) : null));
  put('fileTape', fileName);
  if (meta) {
    put('liveChannels', meta.traces);
    if (meta.siUs != null) put('sampleInt', round3(meta.siUs / 1000));
    if (meta.ns != null && meta.siUs != null) put('recordLen', round3((meta.ns * meta.siUs) / 1e6));
  }
  saveLog();
  renderLog();
  const i = logRows.indexOf(row);
  audit('trigger', `row ${i + 1} enriched from ${fileName}${meta
    ? ` (FFID ${meta.ffid ?? '-'}, ${meta.traces} traces × ${meta.ns ?? '-'} samples)`
    : ' (metadata unavailable)'}`, 'obslog');
}

// -- Event handling (serialised so bursts keep row order) --
function trigQueueEvent(ev: TrigEventMsg): void {
  trigChain = trigChain.then(() => handleTrigEvent(ev)).catch(() => { /* keep the chain alive */ });
}
async function handleTrigEvent(ev: TrigEventMsg): Promise<void> {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'status') {
    if (ev.state === 'started') trigActive[ev.source] = true;
    else trigActive[ev.source] = false;
    if (ev.state === 'error') infoToast(`Trigger Watch ${ev.source}: ${ev.detail || 'source error'}`);
    syncTrigUi();
    return;
  }
  if (ev.type === 'scfile') {
    // Enrichment only: correct/fill an auto-row's File# from the landed .dat. It is
    // NOT a trigger - no flash, no beep, no new row, no session count.
    if (trigIsOn() && logColumns.length > 0) trigApplyScFile(ev);
    return;
  }
  if (ev.type !== 'trigger' || !trigIsOn() || logColumns.length === 0) return;
  trigFlashDot();
  trigBeep();
  trigSessionCount++;
  if (ev.source === 'folder') {
    // A shot file landed. If a serial/UDP trigger already opened a pending row,
    // this file ENRICHES it (match by arrival order within the window);
    // otherwise the file event itself is the trigger → new row + enrich.
    const waiting = trigOldestAwaiting();
    if (waiting) {
      await trigEnrichRow(waiting, ev.path, ev.name);
      infoToast(`Shot file ${ev.name} - row ${logRows.indexOf(waiting) + 1} completed.`);
    } else {
      const row = await trigCreateRow({ ts: ev.ts, sp: null, line: null, source: 'folder', awaitingFile: false });
      await trigEnrichRow(row, ev.path, ev.name);
      infoToast(`Shot landed - row ${logRows.indexOf(row) + 1} added (${ev.name}).`);
    }
    if (ev.mtimeMs > trigCfg.lastMtimeMs) { trigCfg.lastMtimeMs = ev.mtimeMs; saveTrigCfg(); }
  } else if (ev.source === 'scslog') {
    // A real SCS trigger (logged even for unsaved shots): FFID = the log File #,
    // date/time from the log timestamp. It's a log event, NOT a file - no .dat
    // enrichment, so the row never awaits a folder landing.
    const row = await trigCreateRow({
      ts: null, when: scsLogToDate(ev.time, ev.date), sp: null, line: null,
      source: 'scslog', awaitingFile: false, ffid: ev.shot,
    });
    infoToast(`Shot trigger (SCS log) - row ${logRows.indexOf(row) + 1} added (File ${ev.shot}).`);
  } else if (ev.source === 'scstrig') {
    // A PASSIVE SCS trigger touch (TempCom scratch files rewritten at trigger
    // time). SCS gives us only the FACT that a trigger fired - no shot#/file -
    // so the row is a counter++ row stamped with the wall-clock arrival time,
    // and shot#/FFID are left for the observer (or a folder landing) to fill.
    const row = await trigCreateRow({
      ts: null, sp: null, line: null, source: 'SCS trigger',
      awaitingFile: trigActive.folder, // only expect a file when the folder source is also armed
    });
    infoToast(`Shot trigger (TempCom) - row ${logRows.indexOf(row) + 1} added.`);
  } else {
    const row = await trigCreateRow({
      ts: ev.ts, sp: ev.sp, line: ev.line, source: ev.source,
      awaitingFile: trigActive.folder, // only expect a file when the folder source is armed
    });
    infoToast(`Shot trigger (${ev.source}) - row ${logRows.indexOf(row) + 1} added.`);
  }
  syncTrigUi();
}

// -- Master toggle + start/stop --
/** The SC_Files enrichment watch is needed only when Auto-number is ON and the
 *  File# mode reads the landed .dat (reconcile / real). */
function trigScFilesNeeded(): boolean {
  return trigCfg.autonum.enabled && (trigCfg.autonum.fileMode === 'reconcile' || trigCfg.autonum.fileMode === 'real');
}
function trigBuildIpcCfg(): TrigWatchIpcCfg {
  return {
    folder: { enabled: trigCfg.folder.enabled, dir: trigCfg.folder.dir },
    udp: { enabled: trigCfg.udp.enabled, port: trigCfg.udp.port, bindAll: trigCfg.udp.bindAll },
    serial: { enabled: trigCfg.serial.enabled, port: trigCfg.serial.port, baud: trigCfg.serial.baud },
    scslog: { enabled: trigCfg.scslog.enabled, path: trigCfg.scslog.path },
    scstrig: { enabled: trigCfg.scstrig.enabled, dir: trigCfg.scstrig.dir },
    scfiles: { enabled: trigScFilesNeeded(), dir: trigCfg.autonum.scFilesDir },
  };
}
function trigFirstError(res: TrigWatchStartResult | null | undefined): string {
  return res?.folder.error || res?.udp.error || res?.serial.error || res?.scslog.error || res?.scstrig.error || res?.scfiles.error || 'unknown error';
}
async function trigStop(): Promise<void> {
  try { await api.triggerWatch(null); } catch { /* main is gone - nothing to stop */ }
  trigActive.folder = trigActive.udp = trigActive.serial = trigActive.scslog = trigActive.scstrig = false;
  syncTrigUi();
}
async function trigToggleMaster(): Promise<void> {
  if (trigIsOn()) {
    await trigStop();
    audit('trigger-watch', 'stopped', 'obslog');
    return;
  }
  if (logColumns.length === 0) { infoToast('Build the log first - Trigger Watch adds rows to the live grid.'); return; }
  if (!trigCfg.folder.enabled && !trigCfg.udp.enabled && !trigCfg.serial.enabled && !trigCfg.scslog.enabled && !trigCfg.scstrig.enabled) { openTrigCfgModal(); return; }
  if (trigCfg.folder.enabled && trigCfg.folder.dir.trim() === '') { openTrigCfgModal(); setText('otwCfgStatus', 'Pick the acquisition folder to watch.'); return; }
  if (trigCfg.scslog.enabled && trigCfg.scslog.path.trim() === '') { openTrigCfgModal(); setText('otwCfgStatus', 'Pick the SCS survey log to tail.'); return; }
  if (trigCfg.scstrig.enabled && trigCfg.scstrig.dir.trim() === '') { openTrigCfgModal(); setText('otwCfgStatus', 'Pick the SCS trigger (TempCom) folder to watch.'); return; }
  let res: TrigWatchStartResult | null = null;
  try { res = await api.triggerWatch(trigBuildIpcCfg()); } catch { /* fall through to the error toast */ }
  trigActive.folder = !!res?.folder.on;
  trigActive.udp = !!res?.udp.on;
  trigActive.serial = !!res?.serial.on;
  trigActive.scslog = !!res?.scslog.on;
  trigActive.scstrig = !!res?.scstrig.on;
  trigSessionCount = 0;
  syncTrigUi();
  if (!trigIsOn()) { infoToast('Trigger Watch could not start: ' + trigFirstError(res)); return; }
  if (res && !res.ok) infoToast('Trigger Watch: some sources failed - ' + trigFirstError(res));
  const armed = ['folder', 'udp', 'serial', 'scslog', 'scstrig'].filter((k) => trigActive[k as keyof typeof trigActive]).join(' + ');
  audit('trigger-watch', `started (${armed})`, 'obslog');
  if (trigActive.folder) await trigCatchUp(); // downtime catch-up - ALWAYS ask
}

// -- Catch-up (Add all / Add selected / Skip - the user chooses every time) --
async function trigCatchUp(): Promise<void> {
  let r: { ok: boolean; files: TrigScanFile[] } | null = null;
  try { r = await api.triggerScanFolder(); } catch { return; }
  if (!r?.ok) return;
  const unlogged = r.files.filter((f) => f.mtimeMs > trigCfg.lastMtimeMs);
  if (unlogged.length === 0) return;
  trigCatchFiles = unlogged;
  const list = $opt('otwCatchList');
  if (!list) return;
  list.innerHTML = '';
  for (let i = 0; i < unlogged.length; i++) {
    const f = unlogged[i];
    const lab = document.createElement('label');
    lab.className = 'otw-catch-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.idx = String(i);
    const name = document.createElement('span');
    name.className = 'ocn';
    name.textContent = f.name;
    const when = document.createElement('span');
    when.className = 'oct';
    when.textContent = `${trigFmtTime(new Date(f.mtimeMs))} · ${(f.size / 1e6).toFixed(1)} MB`;
    lab.append(cb, name, when);
    list.appendChild(lab);
  }
  setText('otwCatchHint', `${unlogged.length} shot file${unlogged.length === 1 ? '' : 's'} newer than the last logged trigger ${unlogged.length === 1 ? 'was' : 'were'} found in the watched folder. Add rows for them?`);
  $opt('otwCatchBack')?.classList.add('open');
}
function closeTrigCatchup(): void { $opt('otwCatchBack')?.classList.remove('open'); }
function trigCatchSelection(all: boolean): TrigScanFile[] {
  if (all) return trigCatchFiles.slice();
  const out: TrigScanFile[] = [];
  $opt('otwCatchList')?.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((cb) => {
    const i = Number(cb.dataset.idx);
    if (cb.checked && Number.isInteger(i) && trigCatchFiles[i]) out.push(trigCatchFiles[i]);
  });
  return out;
}
async function trigProcessCatchup(files: TrigScanFile[]): Promise<void> {
  closeTrigCatchup();
  if (files.length === 0) return;
  const many = files.length > 3;
  if (many) showProgress('Adding shots from catch-up…', undefined, 0);
  let done = 0;
  for (const f of files.slice().sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    const row = await trigCreateRow({ ts: new Date(f.mtimeMs).toISOString(), sp: null, line: null, source: 'catch-up', awaitingFile: false });
    await trigEnrichRow(row, f.path, f.name);
    if (f.mtimeMs > trigCfg.lastMtimeMs) trigCfg.lastMtimeMs = f.mtimeMs;
    done++;
    if (many) updateProgress(done, files.length);
  }
  saveTrigCfg();
  if (many) hideProgress();
  infoToast(`Catch-up: added ${done} shot row${done === 1 ? '' : 's'}.`);
  audit('trigger', `catch-up added ${done} row${done === 1 ? '' : 's'} from the watched folder`, 'obslog');
}

// -- Config modal --
function openTrigCfgModal(): void {
  const el = (id: string) => $opt(id) as HTMLInputElement | null;
  const f = el('otwCfgFolderOn'); if (f) f.checked = trigCfg.folder.enabled;
  const d = el('otwCfgDir'); if (d) d.value = trigCfg.folder.dir;
  const u = el('otwCfgUdpOn'); if (u) u.checked = trigCfg.udp.enabled;
  const p = el('otwCfgUdpPort'); if (p) p.value = String(trigCfg.udp.port);
  const l = el('otwCfgUdpLan'); if (l) l.checked = trigCfg.udp.bindAll;
  const so = el('otwCfgSerialOn'); if (so) so.checked = trigCfg.serial.enabled;
  const sp = el('otwCfgSerialPort'); if (sp) sp.value = trigCfg.serial.port;
  const sb = $opt('otwCfgSerialBaud') as HTMLSelectElement | null; if (sb) sb.value = String(trigCfg.serial.baud);
  const sc = el('otwCfgScsOn'); if (sc) sc.checked = trigCfg.scslog.enabled;
  const scp = el('otwCfgScsPath'); if (scp) scp.value = trigCfg.scslog.path;
  const st = el('otwCfgScsTrigOn'); if (st) st.checked = trigCfg.scstrig.enabled;
  const std = el('otwCfgScsTrigDir'); if (std) std.value = trigCfg.scstrig.dir;
  const s = el('otwCfgSoundOn'); if (s) s.checked = trigCfg.sound;
  // -- Trigger system selector (registry-driven; see core/obslog/trigsystems) --
  const sysSel = $opt('otwCfgSystem') as HTMLSelectElement | null; if (sysSel) sysSel.value = trigCfg.system;
  // -- Auto-number (shot controller) --
  const an = trigCfg.autonum;
  const ao = el('otwCfgAutoOn'); if (ao) ao.checked = an.enabled;
  const aSpStart = el('otwCfgSpStart'); if (aSpStart) aSpStart.value = String(an.spStart);
  const aSpStep = el('otwCfgSpStep'); if (aSpStep) aSpStep.value = String(an.spStep);
  const aSpDir = $opt('otwCfgSpDir') as HTMLSelectElement | null; if (aSpDir) aSpDir.value = String(an.spDir);
  const aSpInt = el('otwCfgSpInterval'); if (aSpInt) aSpInt.value = String(an.spInterval);
  const aFile = el('otwCfgFileStart'); if (aFile) aFile.value = String(an.fileStart);
  const aMode = $opt('otwCfgFileMode') as HTMLSelectElement | null; if (aMode) aMode.value = an.fileMode;
  const aScDir = el('otwCfgScFilesDir'); if (aScDir) aScDir.value = an.scFilesDir;
  syncAutonumModalUi();
  syncTrigSystemUi();
  setText('otwCfgStatus', '');
  $opt('otwCfgBack')?.classList.add('open');
}
/** Populate the Trigger-system <select> straight from the registry (so a new
 *  system added to TRIGGER_SYSTEMS appears here with no extra UI code). */
function trigPopulateSystemSelect(): void {
  const sel = $opt('otwCfgSystem') as HTMLSelectElement | null;
  if (!sel || sel.options.length > 0) return;
  for (const sys of TRIGGER_SYSTEMS) {
    const opt = document.createElement('option');
    opt.value = sys.id;
    opt.textContent = sys.label;
    sel.appendChild(opt);
  }
}
/** The system currently chosen in the modal (falls back to the saved config). */
function trigModalSystem(): TrigSystemId {
  const sel = $opt('otwCfgSystem') as HTMLSelectElement | null;
  return migrateTrigSystemId(sel?.value, false);
}
/** Reflect the chosen system: show its description, and fold the generic sources
 *  under "Advanced" for Geode (they stay editable), open for the generic system. */
function syncTrigSystemUi(): void {
  const id = trigModalSystem();
  const sys = resolveTrigSystem(id);
  const geode = id === 'geode';
  setText('otwCfgSystemDesc', sys.description);
  const adv = $opt('otwCfgAdvanced') as HTMLDetailsElement | null;
  if (adv) adv.open = !geode; // generic sources tucked away (but present) on Geode
  const geodeNote = $opt('otwCfgGeodeNote');
  if (geodeNote) (geodeNote as HTMLElement).style.display = geode ? '' : 'none';
}
/** Apply a system's registry defaults to the OPEN modal's form when the observer
 *  picks it (the "configures those under the hood" step). Only presets the fields
 *  the system declares; empty dir fields are seeded but non-empty paths are kept,
 *  and a non-'counter' File# mode the user already chose is preserved. */
function applyTrigSystemToForm(id: TrigSystemId): void {
  const d = resolveTrigSystem(id).defaults;
  const setChk = (elId: string, v: boolean) => {
    const e = $opt(elId) as HTMLInputElement | null;
    if (e) { e.checked = v; e.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  const srcChk: Record<string, string> = {
    folder: 'otwCfgFolderOn', udp: 'otwCfgUdpOn', serial: 'otwCfgSerialOn',
    scslog: 'otwCfgScsOn', scstrig: 'otwCfgScsTrigOn',
  };
  if (d.sources) {
    for (const [k, v] of Object.entries(d.sources)) { if (srcChk[k]) setChk(srcChk[k], !!v); }
  }
  const seedIfEmpty = (elId: string, val?: string) => {
    if (!val) return;
    const e = $opt(elId) as HTMLInputElement | null;
    if (e && e.value.trim() === '') e.value = val;
  };
  seedIfEmpty('otwCfgScsTrigDir', d.scstrigDir);
  seedIfEmpty('otwCfgScFilesDir', d.scFilesDir);
  if (d.autonum) {
    if (d.autonum.enabled != null) setChk('otwCfgAutoOn', d.autonum.enabled);
    if (d.autonum.fileMode) {
      const m = $opt('otwCfgFileMode') as HTMLSelectElement | null;
      // Don't override a real recorder-sync mode the user already picked.
      if (m && (m.value === 'counter' || id === 'geode')) m.value = d.autonum.fileMode;
    }
  }
  syncAutonumModalUi();
  syncTrigSystemUi();
}
/** Show/hide the Auto-number detail rows: the whole block dims when Auto-advance is
 *  OFF; the SC_Files folder row appears only for reconcile/real File# modes. */
function syncAutonumModalUi(): void {
  const on = !!($opt('otwCfgAutoOn') as HTMLInputElement | null)?.checked;
  const mode = ($opt('otwCfgFileMode') as HTMLSelectElement | null)?.value ?? 'counter';
  const body = $opt('otwCfgAutoBody');
  if (body) (body as HTMLElement).style.display = on ? '' : 'none';
  const scRow = $opt('otwCfgScFilesRow');
  if (scRow) (scRow as HTMLElement).style.display = (on && (mode === 'reconcile' || mode === 'real')) ? '' : 'none';
}
function closeTrigCfgModal(): void { $opt('otwCfgBack')?.classList.remove('open'); }
async function saveTrigCfgModal(): Promise<void> {
  const el = (id: string) => $opt(id) as HTMLInputElement | null;
  const folderOn = !!el('otwCfgFolderOn')?.checked;
  const dir = (el('otwCfgDir')?.value ?? '').trim();
  const udpOn = !!el('otwCfgUdpOn')?.checked;
  const port = Number(el('otwCfgUdpPort')?.value ?? NaN);
  const bindAll = !!el('otwCfgUdpLan')?.checked;
  const serialOn = !!el('otwCfgSerialOn')?.checked;
  const serialPort = (el('otwCfgSerialPort')?.value ?? '').trim().toUpperCase();
  const serialBaud = Number(($opt('otwCfgSerialBaud') as HTMLSelectElement | null)?.value ?? NaN);
  const scsOn = !!el('otwCfgScsOn')?.checked;
  const scsPath = (el('otwCfgScsPath')?.value ?? '').trim();
  const scsTrigOn = !!el('otwCfgScsTrigOn')?.checked;
  const scsTrigDir = (el('otwCfgScsTrigDir')?.value ?? '').trim();
  const sound = !!el('otwCfgSoundOn')?.checked;
  const systemRaw = ($opt('otwCfgSystem') as HTMLSelectElement | null)?.value;
  // -- Auto-number fields --
  const autoOn = !!el('otwCfgAutoOn')?.checked;
  const spStart = Number(el('otwCfgSpStart')?.value ?? NaN);
  const spStep = Number(el('otwCfgSpStep')?.value ?? NaN);
  const spDir = Number(($opt('otwCfgSpDir') as HTMLSelectElement | null)?.value ?? NaN);
  const spInterval = Number(el('otwCfgSpInterval')?.value ?? NaN);
  const fileStart = Number(el('otwCfgFileStart')?.value ?? NaN);
  const fileModeRaw = ($opt('otwCfgFileMode') as HTMLSelectElement | null)?.value ?? 'counter';
  const scFilesDir = (el('otwCfgScFilesDir')?.value ?? '').trim();
  if (folderOn && dir === '') { setText('otwCfgStatus', 'Pick the folder to watch (or disable the folder source).'); return; }
  if (dir.length > 512) { setText('otwCfgStatus', 'Folder path is too long.'); return; }
  if (udpOn && (!Number.isInteger(port) || port < 1 || port > 65535)) { setText('otwCfgStatus', 'UDP port must be an integer 1-65535.'); return; }
  if (serialOn && !/^COM\d{1,3}$/.test(serialPort)) { setText('otwCfgStatus', 'COM port must look like COM3 (COM + digits).'); return; }
  if (scsOn && scsPath === '') { setText('otwCfgStatus', 'Pick the SCS survey log (or disable the SCS-log source).'); return; }
  if (scsPath.length > 512) { setText('otwCfgStatus', 'SCS log path is too long.'); return; }
  if (scsTrigOn && scsTrigDir === '') { setText('otwCfgStatus', 'Pick the SCS trigger (TempCom) folder (or disable the SCS-trigger source).'); return; }
  if (scsTrigDir.length > 512) { setText('otwCfgStatus', 'TempCom folder path is too long.'); return; }
  if (autoOn) {
    if (!Number.isFinite(spStart)) { setText('otwCfgStatus', 'Auto-number: SP start must be a number.'); return; }
    if (!Number.isFinite(spStep) || spStep < 0) { setText('otwCfgStatus', 'Auto-number: SP step must be a number ≥ 0.'); return; }
    if (!Number.isFinite(spInterval) || spInterval <= 0) { setText('otwCfgStatus', 'Auto-number: interval must be a number > 0.'); return; }
    if (!Number.isFinite(fileStart)) { setText('otwCfgStatus', 'Auto-number: File# start must be a number.'); return; }
    if ((fileModeRaw === 'reconcile' || fileModeRaw === 'real') && scFilesDir === '') { setText('otwCfgStatus', 'Auto-number: pick the SC_Files folder for the reconcile / real File# mode.'); return; }
    if (scFilesDir.length > 512) { setText('otwCfgStatus', 'SC_Files folder path is too long.'); return; }
  }
  trigCfg.folder.enabled = folderOn;
  trigCfg.folder.dir = dir;
  trigCfg.udp.enabled = udpOn;
  if (Number.isInteger(port) && port >= 1 && port <= 65535) trigCfg.udp.port = port;
  trigCfg.udp.bindAll = bindAll;
  trigCfg.serial.enabled = serialOn;
  if (/^COM\d{1,3}$/.test(serialPort)) trigCfg.serial.port = serialPort;
  if (TRIG_BAUDS.includes(serialBaud)) trigCfg.serial.baud = serialBaud;
  trigCfg.scslog.enabled = scsOn;
  if (scsPath !== '' && scsPath.length <= 512) trigCfg.scslog.path = scsPath;
  trigCfg.scstrig.enabled = scsTrigOn;
  if (scsTrigDir !== '' && scsTrigDir.length <= 512) trigCfg.scstrig.dir = scsTrigDir;
  trigCfg.system = migrateTrigSystemId(systemRaw, scsTrigOn); // validated to a known id
  trigCfg.sound = sound;
  trigCfg.autonum.enabled = autoOn;
  if (Number.isFinite(spStart)) trigCfg.autonum.spStart = spStart;
  if (Number.isFinite(spStep) && spStep >= 0) trigCfg.autonum.spStep = spStep;
  if (spDir === 1 || spDir === -1) trigCfg.autonum.spDir = spDir;
  if (Number.isFinite(spInterval) && spInterval > 0) trigCfg.autonum.spInterval = spInterval;
  if (Number.isFinite(fileStart)) trigCfg.autonum.fileStart = Math.trunc(fileStart);
  if (fileModeRaw === 'counter' || fileModeRaw === 'reconcile' || fileModeRaw === 'real') trigCfg.autonum.fileMode = fileModeRaw;
  if (scFilesDir !== '' && scFilesDir.length <= 512) trigCfg.autonum.scFilesDir = scFilesDir;
  saveTrigCfg();
  closeTrigCfgModal();
  syncTrigUi();
  audit('trigger-watch', `configured (system ${trigCfg.system}, folder ${folderOn ? 'on' : 'off'}, udp ${udpOn ? `on :${trigCfg.udp.port}${bindAll ? ' LAN' : ''}` : 'off'}, serial ${serialOn ? `on ${trigCfg.serial.port}@${trigCfg.serial.baud}` : 'off'}, scslog ${scsOn ? 'on' : 'off'}, scstrig ${scsTrigOn ? 'on' : 'off'}, auto-number ${autoOn ? `on (SP ${trigCfg.autonum.spStart} ${trigCfg.autonum.spDir > 0 ? '+' : '-'}${trigCfg.autonum.spStep}×${trigCfg.autonum.spInterval}, File# ${trigCfg.autonum.fileMode} from ${trigCfg.autonum.fileStart})` : 'off'}, sound ${sound ? 'on' : 'off'})`, 'obslog');
  // Live watch → apply the new configuration immediately (restart semantics).
  if (trigIsOn()) {
    let res: TrigWatchStartResult | null = null;
    try { res = await api.triggerWatch(trigBuildIpcCfg()); } catch { /* toast below */ }
    trigActive.folder = !!res?.folder.on;
    trigActive.udp = !!res?.udp.on;
    trigActive.serial = !!res?.serial.on;
    trigActive.scslog = !!res?.scslog.on;
    trigActive.scstrig = !!res?.scstrig.on;
    syncTrigUi();
    if (!trigIsOn()) infoToast('Trigger Watch stopped: ' + trigFirstError(res));
    else if (res && !res.ok) infoToast('Trigger Watch: some sources failed - ' + trigFirstError(res));
  }
}

/** Wire the Trigger Watch bar + modals; subscribe to the main-process events.
 *  Called once from initObsLog. */
function initTrigWatch(): void {
  loadTrigCfg();
  syncTrigUi();
  trigPopulateSystemSelect();
  $opt('otwToggle')?.addEventListener('click', () => void trigToggleMaster());
  $opt('otwSound')?.addEventListener('click', () => { trigCfg.sound = !trigCfg.sound; saveTrigCfg(); syncTrigUi(); });
  $opt('otwConfig')?.addEventListener('click', openTrigCfgModal);
  // Config modal
  // Trigger-system selector: applying its registry defaults configures the sources
  // + File# sync "under the hood" when the observer picks a system.
  $opt('otwCfgSystem')?.addEventListener('change', () => applyTrigSystemToForm(trigModalSystem()));
  $opt('otwCfgClose')?.addEventListener('click', closeTrigCfgModal);
  $opt('otwCfgCancel')?.addEventListener('click', closeTrigCfgModal);
  $opt('otwCfgSave')?.addEventListener('click', () => void saveTrigCfgModal());
  $opt('otwCfgBack')?.addEventListener('click', (e) => { if (e.target === $opt('otwCfgBack')) closeTrigCfgModal(); });
  $opt('otwCfgBrowse')?.addEventListener('click', () => {
    void (async () => {
      try {
        const dir = await api.triggerPickFolder();
        if (dir) { const d = $opt('otwCfgDir') as HTMLInputElement | null; if (d) d.value = dir; }
      } catch { /* dialog unavailable */ }
    })();
  });
  $opt('otwCfgScsBrowse')?.addEventListener('click', () => {
    void (async () => {
      try {
        const p = await api.triggerPickLogFile();
        if (p) { const el = $opt('otwCfgScsPath') as HTMLInputElement | null; if (el) el.value = p; }
      } catch { /* dialog unavailable */ }
    })();
  });
  $opt('otwCfgScsTrigBrowse')?.addEventListener('click', () => {
    void (async () => {
      try {
        const dir = await api.triggerPickFolder();
        if (dir) { const el = $opt('otwCfgScsTrigDir') as HTMLInputElement | null; if (el) el.value = dir; }
      } catch { /* dialog unavailable */ }
    })();
  });
  // Auto-number: reveal/hide the detail rows as the master toggle + File# mode change.
  $opt('otwCfgAutoOn')?.addEventListener('change', syncAutonumModalUi);
  $opt('otwCfgFileMode')?.addEventListener('change', syncAutonumModalUi);
  $opt('otwCfgScFilesBrowse')?.addEventListener('click', () => {
    void (async () => {
      try {
        const dir = await api.triggerPickFolder();
        if (dir) { const el = $opt('otwCfgScFilesDir') as HTMLInputElement | null; if (el) el.value = dir; }
      } catch { /* dialog unavailable */ }
    })();
  });
  // Catch-up modal
  $opt('otwCatchClose')?.addEventListener('click', closeTrigCatchup);
  $opt('otwCatchSkip')?.addEventListener('click', closeTrigCatchup);
  $opt('otwCatchAddAll')?.addEventListener('click', () => void trigProcessCatchup(trigCatchSelection(true)));
  $opt('otwCatchAddSel')?.addEventListener('click', () => void trigProcessCatchup(trigCatchSelection(false)));
  $opt('otwCatchBack')?.addEventListener('click', (e) => { if (e.target === $opt('otwCatchBack')) closeTrigCatchup(); });
  // Main-process event stream (trigger + source-status pushes).
  if (!trigEventsWired && api?.onTriggerEvent) {
    trigEventsWired = true;
    api.onTriggerEvent(trigQueueEvent);
  }
}

/** Enable/disable the SPS-link controls based on whether a survey is loaded.
 *  Called whenever the grid re-renders so the toolbar tracks the SPS state. */
function syncSpsLinkUI(): void {
  const btn = $opt('ologSpsImportBtn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = !spsLinkAvailable();
    btn.title = spsLinkAvailable()
      ? 'Create one row per source point in the loaded SPS survey'
      : 'Load an SPS survey (SPS tab) to enable source import';
  }
}

// -- Observer Log v2: time-source toolbar (PC clock | NTP) --
/** Reflect the current time-source choice into the toolbar buttons / inputs. */
function syncTimeSrcUI() {
  $opt('ologTsPc')?.classList.toggle('on', logTimeSource === 'pc');
  $opt('ologTsNtp')?.classList.toggle('on', logTimeSource === 'ntp');
  const ctl = $opt('ologNtpControls');
  if (ctl) ctl.style.display = logTimeSource === 'ntp' ? '' : 'none';
  const srv = $opt('ologNtpServer') as HTMLInputElement | null;
  if (srv && srv.value !== logNtpServer) srv.value = logNtpServer;
}
/** Show the synced offset (e.g. '+0.42 s') or an error in the toolbar. */
function setNtpOffsetLabel(text: string, kind: '' | 'ok' | 'err') {
  const el = $opt('ologNtpOffset');
  if (!el) return;
  el.textContent = text;
  el.className = 'ots-offset' + (kind ? ' ' + kind : '');
}
function setTimeSource(src: LogTimeSource) {
  logTimeSource = src;
  syncTimeSrcUI();
  saveLog();
}
/** Query the configured NTP server, store the offset, and report it. */
async function syncNtp() {
  const srv = $opt('ologNtpServer') as HTMLInputElement | null;
  const server = (srv?.value.trim() || 'pool.ntp.org');
  logNtpServer = server;
  saveLog();
  if (!api?.ntpSync) { setNtpOffsetLabel('unavailable', 'err'); return; }
  setNtpOffsetLabel('syncing…', '');
  const syncBtn = $opt('ologNtpSync') as HTMLButtonElement | null;
  if (syncBtn) syncBtn.disabled = true;
  try {
    const r = await api.ntpSync(server);
    if (r?.ok && typeof r.offsetMs === 'number') {
      logNtpOffsetMs = r.offsetMs;
      logNtpSynced = true;
      const sec = r.offsetMs / 1000;
      setNtpOffsetLabel(`${sec >= 0 ? '+' : ''}${sec.toFixed(2)} s`, 'ok');
    } else {
      logNtpSynced = false;
      setNtpOffsetLabel(r?.error ? `error: ${r.error}` : 'sync failed', 'err');
    }
  } catch (e) {
    logNtpSynced = false;
    setNtpOffsetLabel(`error: ${(e as Error)?.message ?? 'sync failed'}`, 'err');
  } finally {
    if (syncBtn) syncBtn.disabled = false;
  }
}
function initLogTimeSource() {
  $opt('ologTsPc')?.addEventListener('click', () => setTimeSource('pc'));
  $opt('ologTsNtp')?.addEventListener('click', () => setTimeSource('ntp'));
  const srv = $opt('ologNtpServer') as HTMLInputElement | null;
  if (srv) {
    srv.value = logNtpServer;
    srv.addEventListener('change', () => { logNtpServer = srv.value.trim() || 'pool.ntp.org'; saveLog(); });
    srv.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void syncNtp(); } });
  }
  $opt('ologNtpSync')?.addEventListener('click', () => void syncNtp());
  syncTimeSrcUI();
}

// Wire the custom window-control buttons (frameless window) to the main process
// and keep the maximize/restore icon in sync with the real window state.
function initWindowControls() {
  $opt('winMin')?.addEventListener('click', () => api?.winMinimize?.());
  $opt('winMax')?.addEventListener('click', () => api?.winMaximizeToggle?.());
  $opt('winClose')?.addEventListener('click', () => api?.winClose?.());
  api?.onWinMaximized?.((m) => $opt('winMax')?.classList.toggle('maximized', m));
}

// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
// PROVENANCE FOUNDATION - signature identity · audit log · confirm + undo
// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
// All renderer-side. Timestamps use effectiveNow() (NTP-corrected when the
// Observer Log time-source is set to NTP) so audit entries honour a trusted clock.

// -- 1. Signature identity ------------------------------------------------------
const SIG_KEY = 'seisconv.signature';
let signatureName = '';
function loadSignature() {
  try { const s = localStorage.getItem(SIG_KEY); if (typeof s === 'string') signatureName = s.trim(); }
  catch { /* ignore */ }
}
function getSignature(): string { return signatureName; }
function setSignature(name: string) {
  signatureName = (name || '').trim();
  try { localStorage.setItem(SIG_KEY, signatureName); } catch { /* ignore quota */ }
  syncSignatureUi();
}
/** Pending callback to run once the user signs via the modal (used by ensureSignature). */
let sigResolve: (() => void) | null = null;
/** One-shot guard so the non-blocking sign invitation is offered once per session. */
let sigPromptScheduled = false;
/** Open the Audit/Identity modal focused on the signature field; resolves when a
 *  non-empty name is saved (or the modal is closed). Never uses window.prompt. */
function ensureSignature(): Promise<void> {
  if (getSignature()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    sigResolve = resolve;
    openAudit();
    const inp = $opt('auditSigInput') as HTMLInputElement | null;
    if (inp) { inp.focus(); setText('auditSigStatus', 'Enter your name so changes are attributable.'); }
  });
}
function syncSignatureUi() {
  const inp = $opt('auditSigInput') as HTMLInputElement | null;
  if (inp && document.activeElement !== inp) inp.value = getSignature();
}

// -- 2. Audit log ---------------------------------------------------------------
interface AuditEntry { ts: string; user: string; tab?: string; action: string; detail: string; }
const AUDIT_KEY = 'seisconv.auditlog';
const AUDIT_MAX = 5000;
let auditEntries: AuditEntry[] = [];
function loadAuditLog() {
  try {
    const s = localStorage.getItem(AUDIT_KEY);
    if (!s) return;
    const o = JSON.parse(s);
    if (Array.isArray(o)) auditEntries = o.filter((e): e is AuditEntry => !!e && typeof e.action === 'string');
  } catch { /* ignore corrupt state */ }
}
function persistAuditLog() {
  try { localStorage.setItem(AUDIT_KEY, JSON.stringify(auditEntries)); } catch { /* ignore quota */ }
}
/** Append an audit entry. If the user has not signed yet, invite them with a
 *  non-blocking snackbar (never an auto-opened modal); the entry records
 *  '(unsigned)' until a name is saved. */
function audit(action: string, detail: string, tab?: string) {
  if (!getSignature() && !sigPromptScheduled) {
    sigPromptScheduled = true;
    // NEVER auto-open the audit modal. It covers the whole viewport, so raising it
    // unasked stole the user's next click: over another dialog it killed the
    // GeoTIFF wizard's Export button (fixed in 4f310b7), and over a plain TAB it
    // swallowed the click on SPS Creation's "Generate…" - elementFromPoint over the
    // button returned DIV#auditBack.modal-back.open. The invitation is now a
    // non-blocking snackbar with a "Sign…" action: nothing is covered, no click is
    // eaten, and the modal opens only when the user asks for it. Offered once per
    // session; the entry below still records '(unsigned)' until signed.
    const invite = () => {
      if (getSignature()) return;
      // Don't clobber a result snackbar the user is still reading, and stay quiet
      // while a dialog is up so the invitation is not missed behind it.
      if ($opt('undoToast')?.classList.contains('show') || document.querySelector('.modal-back.open')) {
        window.setTimeout(invite, 1500);
        return;
      }
      // Kept short on purpose: the snackbar's message cell ellipsises, and a longer
      // sentence was cut off mid-word at the default window width.
      undoToast('Changes are logged as “(unsigned)” - set your name in Audit.',
        () => { void ensureSignature(); }, 'Sign…');
    };
    requestAnimationFrame(() => window.setTimeout(invite, 500));
  }
  const entry: AuditEntry = {
    ts: effectiveNow().toISOString(),
    user: getSignature() || '(unsigned)',
    tab,
    action,
    detail,
  };
  auditEntries.push(entry);
  // Cap to the newest AUDIT_MAX entries.
  if (auditEntries.length > AUDIT_MAX) auditEntries.splice(0, auditEntries.length - AUDIT_MAX);
  persistAuditLog();
  if (auditOpen()) renderAuditList();
}
function clearAuditLog() {
  auditEntries = [];
  persistAuditLog();
  if (auditOpen()) renderAuditList();
}
function auditCsvCell(s: string): string {
  // RFC-4180-ish: quote and double internal quotes when the cell contains special chars.
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportAuditCsv(): string {
  const head = 'timestamp,user,tab,action,detail\n';
  const body = auditEntries.map((e) =>
    [e.ts, e.user, e.tab || '', e.action, e.detail].map((c) => auditCsvCell(String(c ?? ''))).join(',')
  ).join('\n');
  return head + body + (body ? '\n' : '');
}
function exportAuditJson(): string {
  return JSON.stringify(auditEntries, null, 2);
}

// -- 2b. Backups / snapshots ------------------------------------------------------
// "Everything should have a backup": before a destructive in-app mutation we
// snapshot the affected in-memory state to localStorage under
// 'seisconv.backup.<kind>'. We keep the newest BACKUP_MAX snapshots per kind so a
// user can roll back. File-producing ops (conversions / exports) write NEW files
// via Save dialogs and are non-destructive, so they are only audited - not snapshotted.
type BackupKind = 'obslog' | 'workbench' | 'vel' | 'sps-draft' | 'sps-plan';
interface BackupSnap { ts: string; label: string; data: unknown; }
const BACKUP_PREFIX = 'seisconv.backup.';
const BACKUP_MAX = 5;
const BACKUP_KINDS: { kind: BackupKind; tab: Tab; title: string }[] = [
  { kind: 'obslog', tab: 'obslog', title: 'Observer Log' },
  { kind: 'workbench', tab: 'workbench', title: 'Trace Workbench' },
  { kind: 'vel', tab: 'vel', title: 'Velocity picks' },
  { kind: 'sps-draft', tab: 'sps', title: 'SPS header draft' },
  { kind: 'sps-plan', tab: 'spscreate', title: 'SPS survey plan' },
];
function backupKey(kind: BackupKind): string { return BACKUP_PREFIX + kind; }
function loadBackups(kind: BackupKind): BackupSnap[] {
  try {
    const s = localStorage.getItem(backupKey(kind));
    if (!s) return [];
    const o = JSON.parse(s);
    if (Array.isArray(o)) return o.filter((e): e is BackupSnap => !!e && typeof e.ts === 'string');
  } catch { /* ignore corrupt state */ }
  return [];
}
/** Snapshot the current in-memory state for a kind. `data` must be JSON-clonable;
 *  we deep-clone via JSON so later mutations to the live arrays do not bleed in. */
function snapshotBackup(kind: BackupKind, data: unknown, label: string) {
  let clone: unknown;
  try { clone = JSON.parse(JSON.stringify(data)); } catch { return; /* not clonable - skip */ }
  const list = loadBackups(kind);
  list.push({ ts: effectiveNow().toISOString(), label, data: clone });
  // Keep only the newest BACKUP_MAX.
  while (list.length > BACKUP_MAX) list.shift();
  try { localStorage.setItem(backupKey(kind), JSON.stringify(list)); } catch { /* ignore quota */ }
  if (auditOpen()) renderBackupList();
}
/** Restore the most recent snapshot for a kind into live state + re-render.
 *  Returns true on success. Each kind owns its own re-hydration. */
function restoreLastBackup(kind: BackupKind): boolean {
  const list = loadBackups(kind);
  const snap = list[list.length - 1];
  if (!snap) return false;
  try {
    switch (kind) {
      case 'obslog': {
        const d = snap.data as { meta?: unknown; columns?: unknown; rows?: unknown };
        if (Array.isArray(d.columns) && d.columns.length) {
          logMeta = (d.meta && typeof d.meta === 'object') ? d.meta as typeof logMeta : {};
          logColumns = d.columns as typeof logColumns;
          logRows = Array.isArray(d.rows) ? d.rows as typeof logRows : [];
          ensureColRoles();
          saveLog();
          renderLog();
          updateHeaderClear();
        }
        break;
      }
      case 'workbench': {
        if (Array.isArray(snap.data)) {
          wbTraces = snap.data as typeof wbTraces;
          wbView.init = false;
          wbFit();
          renderWorkbenchList();
          drawWorkbench();
          wbUpdateAnalysis();
          wbUpdateExport();
          updateHeaderClear();
        }
        break;
      }
      case 'vel': {
        if (Array.isArray(snap.data)) {
          velPicks = snap.data as typeof velPicks;
          drawVelocity();
          renderVelPicks();
          updateHeaderClear();
        }
        break;
      }
      case 'sps-draft': {
        if (Array.isArray(snap.data)) {
          spsHdrRawDraft = snap.data as typeof spsHdrRawDraft;
          paintSpsHdrRaw();
        }
        break;
      }
      case 'sps-plan': {
        const d = snap.data as { lines?: unknown; crs?: unknown; mode?: unknown };
        if (Array.isArray(d?.lines)) {
          planPushUndo('restore backup');
          const lines = (d.lines as PlanLine[]).filter((l) => l && Array.isArray(l.points) && l.points.length);
          let maxId = 0;
          for (const l of lines) maxId = Math.max(maxId, Number(l.id) || 0);
          planNextLineId = maxId + 1;
          planSetLines(lines);
          if (d.crs && typeof d.crs === 'object') { createCrs = d.crs as CreateCrs; createCrsAuto = false; updateCreateCrsBtn(); }
          if (d.mode === '3D' || d.mode === '2D') setCreateMode(d.mode);
          planSel = null;
          planRepaintAll();
          updateHeaderClear();
        }
        break;
      }
    }
  } catch { return false; }
  audit('restore', `restored "${snap.label}" snapshot`, kind === 'sps-draft' ? 'sps' : kind === 'sps-plan' ? 'spscreate' : kind);
  return true;
}

// -- 3a. Confirm-delete modal ----------------------------------------------------
let confirmResolve: ((ok: boolean) => void) | null = null;
function confirmOpen(): boolean { return !!$opt('confirmBack')?.classList.contains('open'); }
function closeConfirm(ok: boolean) {
  $opt('confirmBack')?.classList.remove('open');
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(ok);
}
/** In-app confirm dialog (Cancel / Delete). Resolves true on Delete, false otherwise.
 *  Replaces window.confirm, which is unreliable in a sandboxed Electron renderer. */
function confirmDelete(message: string): Promise<boolean> {
  // If a previous confirm is somehow still open, resolve it false first.
  if (confirmResolve) closeConfirm(false);
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve;
    setText('confirmMsg', message);
    $opt('confirmBack')?.classList.add('open');
    ($opt('confirmOk') as HTMLButtonElement | null)?.focus();
  });
}

// -- 3a-bis. Prompt (text-input) modal -------------------------------------------
let promptResolve: ((value: string | null) => void) | null = null;
function closePrompt(value: string | null) {
  $opt('promptBack')?.classList.remove('open');
  const r = promptResolve;
  promptResolve = null;
  if (r) r(value);
}
/** In-app text-input dialog (Cancel / OK). Resolves to the trimmed string on OK,
 *  or null on Cancel/close. Replaces window.prompt, which is unreliable in a
 *  sandboxed Electron renderer. */
function promptInput(message: string, defaultValue = '', title = 'Enter a value'): Promise<string | null> {
  // If a previous prompt is somehow still open, resolve it null first.
  if (promptResolve) closePrompt(null);
  return new Promise<string | null>((resolve) => {
    promptResolve = resolve;
    setText('promptTitle', title);
    setText('promptMsg', message);
    const inp = $opt('promptInput') as HTMLInputElement | null;
    if (inp) { inp.value = defaultValue; }
    $opt('promptBack')?.classList.add('open');
    if (inp) { inp.focus(); inp.select(); }
  });
}

// -- 3b. Undo snackbar -----------------------------------------------------------
let undoTimer: number | null = null;
let undoFn: (() => void) | null = null;
let undoUsed = false;
function hideUndoToast() {
  if (undoTimer != null) { window.clearTimeout(undoTimer); undoTimer = null; }
  undoFn = null;
  $opt('undoToast')?.classList.remove('show');
}
/** Transient snackbar with an action button. `onUndo` runs at most once (double-undo
 *  guarded). Auto-dismisses after ~8s. `actionLabel` renames the button for cases
 *  where "Undo" is the wrong word (e.g. "Discard" on a restored draft). */
function undoToast(message: string, onUndo: () => void, actionLabel = 'Undo') {
  hideUndoToast();
  undoUsed = false;
  undoFn = onUndo;
  setText('undoToastMsg', message);
  const btn = $opt('undoToastBtn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = false; btn.style.display = ''; btn.textContent = actionLabel; }
  $opt('undoToast')?.classList.add('show');
  undoTimer = window.setTimeout(hideUndoToast, 8000);
}
/** Plain transient snackbar (no Undo) - reuses the undo-toast DOM with the Undo
 *  button hidden. For one-shot result messages like "Saved …". Auto-dismisses. */
function infoToast(message: string) {
  hideUndoToast();
  undoUsed = true; undoFn = null;
  setText('undoToastMsg', message);
  const btn = $opt('undoToastBtn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.style.display = 'none'; }
  $opt('undoToast')?.classList.add('show');
  undoTimer = window.setTimeout(hideUndoToast, 6000);
}
function triggerUndo() {
  if (undoUsed) return;            // guard double-undo
  const fn = undoFn;
  if (!fn) return;
  undoUsed = true;
  const btn = $opt('undoToastBtn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  hideUndoToast();
  fn();
}

// -- 4. Audit / Identity modal ---------------------------------------------------
function auditOpen(): boolean { return !!$opt('auditBack')?.classList.contains('open'); }
function openAudit() {
  syncSignatureUi();
  renderAuditList();
  renderBackupList();
  $opt('auditBack')?.classList.add('open');
}
/** Render the per-kind backup rows in the Audit modal: each shows how many
 *  snapshots exist + when the newest was taken, with a Restore button. */
function renderBackupList() {
  const host = $opt('auditBackups');
  if (!host) return;
  host.innerHTML = '';
  for (const { kind, title } of BACKUP_KINDS) {
    const list = loadBackups(kind);
    const row = document.createElement('div');
    row.className = 'backup-row';
    const name = document.createElement('span'); name.className = 'bk-name'; name.textContent = title;
    const meta = document.createElement('span'); meta.className = 'bk-meta';
    if (list.length) {
      const last = list[list.length - 1];
      let when = last.ts;
      try { const d = new Date(last.ts); if (!isNaN(d.getTime())) when = d.toLocaleString(); } catch { /* keep raw */ }
      meta.textContent = `${list.length} snapshot${list.length === 1 ? '' : 's'} · last ${when}`;
      meta.title = last.label;
    } else {
      meta.textContent = 'No backups yet';
      meta.classList.add('bk-none');
    }
    const btn = document.createElement('button');
    btn.className = 'btn sm'; btn.type = 'button'; btn.textContent = 'Restore last';
    btn.disabled = list.length === 0;
    btn.addEventListener('click', () => {
      const ok = restoreLastBackup(kind);
      setText('auditSigStatus', ok ? `✓ Restored ${title} backup` : `No ${title} backup to restore`);
      renderBackupList();
    });
    row.append(name, meta, btn);
    host.appendChild(row);
  }
}
function closeAudit() {
  $opt('auditBack')?.classList.remove('open');
  // If a sign-in was awaited, resolve it now (signed or not) so callers proceed.
  const r = sigResolve; sigResolve = null;
  if (r) r();
}
function renderAuditList() {
  const host = $opt('auditList');
  if (!host) return;
  setText('auditCount', `${auditEntries.length} entr${auditEntries.length === 1 ? 'y' : 'ies'}`);
  host.innerHTML = '';
  if (!auditEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'audit-empty';
    empty.textContent = 'No audit entries yet. Deletes and applied changes will appear here.';
    host.appendChild(empty);
    return;
  }
  // Newest first.
  for (let i = auditEntries.length - 1; i >= 0; i--) {
    const e = auditEntries[i];
    const row = document.createElement('div');
    row.className = 'audit-entry';
    const ts = document.createElement('span'); ts.className = 'ae-ts';
    // Local-friendly compact timestamp; full ISO in the tooltip.
    let label = e.ts;
    try { const d = new Date(e.ts); if (!isNaN(d.getTime())) label = d.toLocaleString(); } catch { /* keep raw */ }
    ts.textContent = label; ts.title = e.ts;
    const user = document.createElement('span'); user.className = 'ae-user'; user.textContent = e.user || '(unsigned)';
    const act = document.createElement('span'); act.className = 'ae-act'; act.textContent = e.action;
    const det = document.createElement('span'); det.className = 'ae-detail';
    det.textContent = e.detail || '';
    if (e.tab) { const t = document.createElement('span'); t.className = 'ae-tab'; t.textContent = '  [' + e.tab + ']'; det.appendChild(t); }
    row.append(ts, user, act, det);
    host.appendChild(row);
  }
}
async function exportAuditFile(kind: 'csv' | 'json') {
  if (!auditEntries.length) { setText('auditSigStatus', 'Audit log is empty.'); return; }
  const payload = kind === 'csv' ? exportAuditCsv() : exportAuditJson();
  const fname = kind === 'csv' ? 'seisconv-audit.csv' : 'seisconv-audit.json';
  try {
    const r = await api.exportText(fname, payload);
    setText('auditSigStatus', r.ok ? '✓ Saved ' + r.path : r.canceled ? '' : 'Failed: ' + (r.error || 'unknown'));
  } catch (e) {
    setText('auditSigStatus', 'Failed: ' + errMsg(e));
  }
}
/** Wire the provenance UI (header button, confirm modal, undo toast, audit modal). */
function initProvenance() {
  loadSignature();
  loadAuditLog();
  // Header Audit button.
  $opt('auditBtn')?.addEventListener('click', openAudit);
  // Confirm modal.
  $opt('confirmOk')?.addEventListener('click', () => closeConfirm(true));
  $opt('confirmCancel')?.addEventListener('click', () => closeConfirm(false));
  $opt('confirmClose')?.addEventListener('click', () => closeConfirm(false));
  $opt('confirmBack')?.addEventListener('click', (e) => { if (e.target === $opt('confirmBack')) closeConfirm(false); });
  // Prompt (text-input) modal.
  const promptCommit = () => {
    const inp = $opt('promptInput') as HTMLInputElement | null;
    closePrompt((inp?.value ?? '').trim());
  };
  $opt('promptOk')?.addEventListener('click', promptCommit);
  $opt('promptCancel')?.addEventListener('click', () => closePrompt(null));
  $opt('promptClose')?.addEventListener('click', () => closePrompt(null));
  $opt('promptBack')?.addEventListener('click', (e) => { if (e.target === $opt('promptBack')) closePrompt(null); });
  $opt('promptInput')?.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Enter') promptCommit();
    else if (k === 'Escape') closePrompt(null);
  });
  // Undo toast.
  $opt('undoToastBtn')?.addEventListener('click', triggerUndo);
  $opt('undoToastClose')?.addEventListener('click', hideUndoToast);
  // Audit / Identity modal.
  $opt('auditClose')?.addEventListener('click', closeAudit);
  $opt('auditBack')?.addEventListener('click', (e) => { if (e.target === $opt('auditBack')) closeAudit(); });
  const saveSig = () => {
    const inp = $opt('auditSigInput') as HTMLInputElement | null;
    const name = (inp?.value || '').trim();
    if (!name) { setText('auditSigStatus', 'Enter a name first.'); return; }
    setSignature(name);
    setText('auditSigStatus', '✓ Signed as ' + name);
    // If a change was waiting on a signature, resolve it now and close.
    const r = sigResolve; sigResolve = null;
    if (r) { r(); $opt('auditBack')?.classList.remove('open'); }
  };
  $opt('auditSigSave')?.addEventListener('click', saveSig);
  $opt('auditSigInput')?.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') saveSig(); });
  $opt('auditExportCsv')?.addEventListener('click', () => void exportAuditFile('csv'));
  $opt('auditExportJson')?.addEventListener('click', () => void exportAuditFile('json'));
  $opt('auditClearBtn')?.addEventListener('click', async () => {
    if (!auditEntries.length) return;
    if (await confirmDelete('Clear the entire audit log? This cannot be undone.')) {
      clearAuditLog();
      setText('auditSigStatus', 'Audit log cleared.');
    }
  });
  syncSignatureUi();
}

// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
//  SWEEPS - vibroseis sweep builder + QC (core engine: core/dsp/sweepgen.ts)
//  Builder: spec form (+ ≤16-segment editor) → generateSweep → four live plots
//  (signal via drawTraceCore, freq-vs-time + Klauder via drawSweepXY, spectrum
//  via drawSpectrum). Per-survey presets in localStorage (seisconv.sweeps.presets,
//  same guarded pattern as the Observer Log templates). Exports + measured-sweep
//  QC live in the sections below the builder.
// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

let swResult: SweepResult | null = null;     // the last BUILT sweep
let swSpec: SweepSpec | null = null;         // the spec it was built from
let swKlauder: KlauderAnalysis | null = null;
let swSegments: SweepSegment[] = [];         // segment-editor rows (used when swSegUse)
let swSegUse = false;
let swMeasured: ExtractedTrace | null = null; // QC panel's loaded measured sweep
let swBuildTimer = 0;                        // debounce for live rebuilds

// Tunable QC thresholds (defaults per industry practice; stored in each preset).
type SweepQcThresholds = { avgPhaseDeg: number; peakPhaseDeg: number; thdPct: number };
const DEFAULT_SWEEP_QC: SweepQcThresholds = { avgPhaseDeg: 10, peakPhaseDeg: 20, thdPct: 35 };
let swQc: SweepQcThresholds = { ...DEFAULT_SWEEP_QC };

const swNum = (id: string, fallback: number): number => {
  const v = parseFloat(($opt(id) as HTMLInputElement | null)?.value ?? '');
  return Number.isFinite(v) ? v : fallback;
};

/** Read the designer form into a SweepSpec (validated by the caller). */
function swSpecFromForm(): SweepSpec {
  const type = ((($opt('swType') as HTMLSelectElement | null)?.value ?? 'linear') as SweepType);
  const slopeRaw = ($opt('swSlope') as HTMLInputElement | null)?.value ?? '';
  const slope = slopeRaw.trim() === '' ? undefined : parseFloat(slopeRaw);
  return {
    type,
    f0: swNum('swF0', DEFAULT_SWEEP_SPEC.f0),
    f1: swNum('swF1', DEFAULT_SWEEP_SPEC.f1),
    lengthMs: swNum('swLen', DEFAULT_SWEEP_SPEC.lengthMs),
    taperInMs: swNum('swTaperIn', DEFAULT_SWEEP_SPEC.taperInMs),
    taperOutMs: swNum('swTaperOut', DEFAULT_SWEEP_SPEC.taperOutMs),
    taperType: ((($opt('swTaperType') as HTMLSelectElement | null)?.value ?? 'cosine') as 'cosine' | 'blackman'),
    initialPhaseDeg: swNum('swPhase', 0),
    sampleIntervalUs: parseInt(($opt('swSi') as HTMLSelectElement | null)?.value ?? '500', 10) || 500,
    amplitude: swNum('swAmp', 1),
    slope: Number.isFinite(slope as number) ? slope : undefined,
    segments: swSegUse && swSegments.length ? swSegments.map((s) => ({ ...s })) : undefined,
  };
}

/** Show/hide + label the shaping-parameter box to match the selected type. */
function swSyncTypeUI() {
  const type = ((($opt('swType') as HTMLSelectElement | null)?.value ?? 'linear') as SweepType);
  const wrap = $opt('swSlopeWrap');
  if (wrap) wrap.style.display = type === 'linear' ? 'none' : '';
  const lbl = $opt('swSlopeLabel');
  if (lbl) lbl.textContent = type === 'dbhz' ? 'dB/Hz' : type === 'dboct' ? 'dB/Oct' : 'Exponent';
  const box = $opt('swSlope') as HTMLInputElement | null;
  if (box) box.placeholder = String(defaultSlope(type));
}

// -- Sweeps-tab plot zoom (drag-box + zoom in/out + reset · per-plot) ----------
// Mirrors the file/trace viewer's rubber-band box-zoom (canvasPx + an overlay
// rectangle) for EVERY Sweeps plot. Each plot keeps its OWN view window; the
// three renderers the tab uses (drawSweepXY / drawTraceCore / drawSpectrum) each
// report the pixel plot-rect + the data extent they actually drew via swZoomFrame,
// so the box→data mapping is exact regardless of a plot's margins or axis
// orientation (the pilot-signal plot runs time DOWNWARD → per-frame `yDown`).
// No window.confirm/prompt anywhere; controls are a small unobtrusive toolbar.
type SwZoomFrame = {
  rect: { x: number; y: number; w: number; h: number };
  xMin: number; xMax: number; yMin: number; yMax: number;
  yDown: boolean; // y-axis increases downward (signal: time down)
};
type SwZoomWin = { xMin: number; xMax: number; yMin: number; yMax: number };

const SW_ZOOM_IDS = [
  'swSignalCanvas', 'swFreqCanvas', 'swSpectrumCanvas', 'swKlauderCanvas',
  'swQcPhaseCanvas', 'swQcThdCanvas', 'swQcEnvCanvas', 'swQcSpecCanvas', 'swQcCorrCanvas',
] as const;
const SW_QC_ZOOM_IDS = ['swQcPhaseCanvas', 'swQcThdCanvas', 'swQcEnvCanvas', 'swQcSpecCanvas', 'swQcCorrCanvas'] as const;

const swZoomView = new Map<string, SwZoomWin>();     // id → active window (absent = auto-fit)
const swZoomFrame = new Map<string, SwZoomFrame>();  // id → last drawn frame (box→data mapping)
const swZoomRedraw = new Map<string, () => void>();  // id → repaint at the current view
let swZoomDrag: { id: string; cv: HTMLCanvasElement; x0: number; y0: number; x1: number; y1: number } | null = null;

/** Set (or clear, when win=null) a plot's view window and repaint it. */
function swZoomSet(id: string, win: SwZoomWin | null): void {
  if (win && win.xMax > win.xMin && win.yMax > win.yMin) swZoomView.set(id, win);
  else swZoomView.delete(id);
  swZoomRedraw.get(id)?.();
}

/** Silently forget the zoom state of the given plots (view + frame + repaint
 *  closure) WITHOUT repainting - used on Clear, where the canvas is blanked and a
 *  stale repaint closure would otherwise redraw the discarded series. */
function swZoomForget(ids: readonly string[]): void {
  for (const id of ids) { swZoomView.delete(id); swZoomFrame.delete(id); swZoomRedraw.delete(id); }
}

/** ＋/- button: scale the current window about its centre (factor<1 zooms in). */
function swZoomButton(id: string, factor: number): void {
  const cur = swZoomView.get(id) ?? (() => {
    const f = swZoomFrame.get(id);
    return f ? { xMin: f.xMin, xMax: f.xMax, yMin: f.yMin, yMax: f.yMax } : null;
  })();
  if (!cur) return;
  const cx = (cur.xMin + cur.xMax) / 2, hx = ((cur.xMax - cur.xMin) / 2) * factor;
  const cy = (cur.yMin + cur.yMax) / 2, hy = ((cur.yMax - cur.yMin) / 2) * factor;
  swZoomSet(id, { xMin: cx - hx, xMax: cx + hx, yMin: cy - hy, yMax: cy + hy });
}

/** Convert the drag-box (canvas px) to a data window via the plot's last frame. */
function swZoomFromBox(id: string, b: { x0: number; y0: number; x1: number; y1: number }): void {
  const f = swZoomFrame.get(id);
  if (!f || f.rect.w <= 0 || f.rect.h <= 0) return;
  if (Math.abs(b.x1 - b.x0) < 6 || Math.abs(b.y1 - b.y0) < 6) return; // ignore a click, not a drag
  const { rect } = f;
  const fx = (px: number) => Math.max(0, Math.min(1, (px - rect.x) / rect.w));
  const fy = (py: number) => Math.max(0, Math.min(1, (py - rect.y) / rect.h)); // 0 = top edge
  const fx0 = fx(Math.min(b.x0, b.x1)), fx1 = fx(Math.max(b.x0, b.x1));
  const fyTop = fy(Math.min(b.y0, b.y1)), fyBot = fy(Math.max(b.y0, b.y1));
  const xMin = f.xMin + fx0 * (f.xMax - f.xMin);
  const xMax = f.xMin + fx1 * (f.xMax - f.xMin);
  const yMin = f.yDown ? f.yMin + fyTop * (f.yMax - f.yMin) : f.yMax - fyBot * (f.yMax - f.yMin);
  const yMax = f.yDown ? f.yMin + fyBot * (f.yMax - f.yMin) : f.yMax - fyTop * (f.yMax - f.yMin);
  swZoomSet(id, { xMin, xMax, yMin, yMax });
}

/** Shared rubber-band overlay (fixed, drawn over the dragged canvas). */
function swZoomRubber(cv: HTMLCanvasElement, b: { x0: number; y0: number; x1: number; y1: number }): void {
  let el = document.getElementById('swZoomRubber');
  if (!el) {
    el = document.createElement('div');
    el.id = 'swZoomRubber';
    el.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;border:1px solid #34dbd0;background:rgba(52,219,208,0.14);display:none;';
    document.body.appendChild(el);
  }
  const r = cv.getBoundingClientRect();
  el.style.left = (r.left + Math.min(b.x0, b.x1)) + 'px';
  el.style.top = (r.top + Math.min(b.y0, b.y1)) + 'px';
  el.style.width = Math.abs(b.x1 - b.x0) + 'px';
  el.style.height = Math.abs(b.y1 - b.y0) + 'px';
  el.style.display = 'block';
}
function swZoomHideRubber(): void { const el = document.getElementById('swZoomRubber'); if (el) el.style.display = 'none'; }

/** Wrap a sweep canvas in a positioned box + inject a small ＋/-/⤢ toolbar. */
function swZoomDecorate(cv: HTMLCanvasElement): void {
  let wrap = cv.parentElement;
  if (!wrap) return;
  if (!wrap.classList.contains('sw-zoom-wrap')) {
    const w = document.createElement('div');
    w.className = 'sw-zoom-wrap';
    w.style.cssText = 'position:relative;';
    wrap.insertBefore(w, cv);
    w.appendChild(cv);
    wrap = w;
  }
  const bar = document.createElement('div');
  bar.style.cssText = 'position:absolute;top:6px;right:8px;display:flex;gap:3px;z-index:5;';
  const mk = (txt: string, title: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn sm'; b.textContent = txt; b.title = title;
    b.style.cssText = 'padding:0 7px;font-size:14px;line-height:1.7;min-width:0;';
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    b.addEventListener('mousedown', (e) => e.stopPropagation()); // don't start a box-drag under the button
    return b;
  };
  bar.appendChild(mk('+', 'Zoom in', () => swZoomButton(cv.id, 1 / 1.4)));
  bar.appendChild(mk('-', 'Zoom out', () => swZoomButton(cv.id, 1.4)));
  bar.appendChild(mk('⤢', 'Reset zoom (fit)', () => swZoomSet(cv.id, null)));
  wrap.appendChild(bar);
}

/** Wire every Sweeps plot for drag-box zoom + toolbar (called once at init). */
function initSweepZoom(): void {
  for (const id of SW_ZOOM_IDS) {
    const cv = $opt(id) as HTMLCanvasElement | null;
    if (!cv) continue;
    swZoomDecorate(cv);
    cv.style.cursor = 'crosshair';
    cv.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const p = canvasPx(cv, e);
      swZoomDrag = { id: cv.id, cv, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      swZoomRubber(cv, swZoomDrag);
      e.preventDefault();
    });
    cv.addEventListener('dblclick', () => swZoomSet(cv.id, null)); // double-click resets to fit
  }
  window.addEventListener('mousemove', (e) => {
    if (!swZoomDrag) return;
    const p = canvasPx(swZoomDrag.cv, e);
    swZoomDrag.x1 = p.x; swZoomDrag.y1 = p.y;
    swZoomRubber(swZoomDrag.cv, swZoomDrag);
  });
  window.addEventListener('mouseup', () => {
    if (!swZoomDrag) return;
    const d = swZoomDrag; swZoomDrag = null; swZoomHideRubber();
    swZoomFromBox(d.id, d);
  });
}

/** Generic X/Y polyline plot on the dark scientific canvas (freq-vs-time,
 *  Klauder wavelet, QC series). Multiple series supported; axes via
 *  drawHeatAxesXY. Decimates to ~2 points/px so long sweeps stay snappy.
 *  Per-plot zoom: an active view window (swZoomView) overrides the auto extent. */
function drawSweepXY(
  cv: HTMLCanvasElement,
  series: Array<{ xs: Float32Array; ys: Float32Array; color?: string }>,
  o: { xLabel: string; yLabel: string; zeroLine?: boolean },
) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800;
  const H = cv.clientHeight || 320;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);
  const plot = { x: 56, y: 22, w: W - 56 - 16, h: H - 22 - 30 };
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const s of series) {
    const n = Math.min(s.xs.length, s.ys.length);
    for (let i = 0; i < n; i++) {
      const x = s.xs[i], y = s.ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
  }
  if (!(xMax > xMin) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    ctx.fillStyle = '#5e7186'; ctx.font = '13px Consolas, monospace'; ctx.textAlign = 'center';
    ctx.fillText('Nothing to plot', W / 2, H / 2); ctx.textAlign = 'left';
    return;
  }
  if (yMax === yMin) { yMax += 1; yMin -= 1; }
  const pad = (yMax - yMin) * 0.06;
  yMin -= pad; yMax += pad;
  // Per-plot zoom: repaint closure + an active view window that overrides the auto
  // extent (no extra pad - the window is exact). The frame we record (plot rect +
  // final extent) lets the drag-box map pixels back to data coordinates.
  swZoomRedraw.set(cv.id, () => drawSweepXY(cv, series, o));
  const zv = swZoomView.get(cv.id);
  if (zv && zv.xMax > zv.xMin && zv.yMax > zv.yMin) {
    xMin = zv.xMin; xMax = zv.xMax; yMin = zv.yMin; yMax = zv.yMax;
  }
  swZoomFrame.set(cv.id, { rect: { ...plot }, xMin, xMax, yMin, yMax, yDown: false });
  drawHeatAxesXY(ctx, plot, { xLabel: o.xLabel, xMin, xMax, yLabel: o.yLabel, yMin, yMax, yUp: true });
  const X = (v: number) => plot.x + ((v - xMin) / (xMax - xMin)) * plot.w;
  const Y = (v: number) => plot.y + plot.h - ((v - yMin) / (yMax - yMin)) * plot.h;
  ctx.save();
  ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();
  if (o.zeroLine && yMin < 0 && yMax > 0) {
    ctx.strokeStyle = '#264a68'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plot.x, Y(0)); ctx.lineTo(plot.x + plot.w, Y(0)); ctx.stroke();
  }
  for (const s of series) {
    const n = Math.min(s.xs.length, s.ys.length);
    const step = Math.max(1, Math.floor(n / (plot.w * 2)));
    ctx.strokeStyle = s.color ?? '#34dbd0';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i += step) {
      const x = X(s.xs[i]), y = Y(s.ys[i]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** UNWINDOWED single-sided amplitude spectrum. For a sweep, time maps onto
 *  frequency, so amplitudeSpectrum()'s whole-trace Hann window would falsely
 *  bell-shape the in-band level; the pilot's own tapers already limit leakage. */
function swRawSpectrum(samples: Float32Array, siUs: number): SpectrumLike {
  const N = nextPow2(Math.max(2, samples.length));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  re.set(samples);
  fft(re, im, false);
  const half = N >> 1;
  const fs = siUs > 0 ? 1e6 / siUs : 1;
  const amp = new Float32Array(half);
  const freqs = new Float32Array(half);
  const n0 = samples.length || 1;
  for (let k = 0; k < half; k++) {
    const mag = Math.hypot(re[k], im[k]);
    amp[k] = (k === 0 ? mag : 2 * mag) / n0;
    freqs[k] = (k * fs) / N;
  }
  return { freqs, amp, nyquist: fs / 2 };
}

/** Paint the flat dark background on a sweep canvas (cleared state). */
function swBlankCanvas(id: string) {
  const cv = $opt(id) as HTMLCanvasElement | null;
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800, H = cv.clientHeight || 320;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33'; ctx.fillRect(0, 0, W, H);
}

/** Pilot-signal plot (drawTraceCore) with per-plot zoom. The plot's Y axis is the
 *  sample window (time runs down) and its X axis is amplitude, so the recorded
 *  frame uses yDown=true and X=[amp] - a drag-box maps to a sample + amp window. */
function swDrawSignalPlot(): void {
  const cv = $opt('swSignalCanvas') as HTMLCanvasElement | null;
  if (!cv || !swResult) return;
  const r = swResult;
  const n = r.meta.nSamples;
  const t: TraceData = { index: 0, nSamples: n, sampleInt: r.meta.sampleIntervalUs, hdr: {}, samples: r.samples };
  swZoomRedraw.set(cv.id, () => swDrawSignalPlot());
  const v = swZoomView.get(cv.id);
  let s0 = 0, s1 = n;
  let ampRange: { min: number; max: number } | null = null;
  if (v) {
    s0 = Math.max(0, Math.min(n - 1, Math.round(v.yMin)));
    s1 = Math.max(s0 + 1, Math.min(n, Math.round(v.yMax)));
    ampRange = { min: v.xMin, max: v.xMax };
  }
  drawTraceCore(cv, t, s0, s1, ampRange);
  const W = cv.clientWidth || 800, H = cv.clientHeight || 320;
  const rect = { x: TRC_ML, y: TRC_MT, w: W - TRC_ML - TRC_MR, h: H - TRC_MT - TRC_MB };
  let xMin: number, xMax: number;
  if (ampRange) { xMin = ampRange.min; xMax = ampRange.max; }
  else { const nf = normFactorPercentile(t.samples.subarray(s0, s1), 0.95) || 1; xMin = -nf; xMax = nf; }
  swZoomFrame.set(cv.id, { rect, xMin, xMax, yMin: s0, yMax: s1, yDown: true });
}

/** Amplitude-spectrum plot (drawSpectrum) with per-plot zoom (X=freq, Y=amp). */
function swDrawSpectrumPlot(): void {
  const cv = $opt('swSpectrumCanvas') as HTMLCanvasElement | null;
  if (!cv || !swResult) return;
  const r = swResult;
  // NOT amplitudeSpectrum(): its whole-trace Hann window maps onto the chirp's
  // time→frequency law and would bell-shape the flat band (raw FFT instead).
  const sp = swRawSpectrum(r.samples, r.meta.sampleIntervalUs);
  const fShow = Math.min(sp.nyquist, Math.max(20, r.meta.fMax * 1.6));
  swZoomRedraw.set(cv.id, () => swDrawSpectrumPlot());
  const v = swZoomView.get(cv.id);
  const fMin = v ? v.xMin : 0, fMax = v ? v.xMax : fShow;
  drawSpectrum(cv, sp, { label: 'designed pilot', fMin, fMax, aMin: v ? v.yMin : null, aMax: v ? v.yMax : null });
  const W = cv.clientWidth || 800, H = cv.clientHeight || 320;
  const rect = { x: 56, y: 18, w: W - 56 - 16, h: H - 18 - 28 }; // drawSpectrum's ML/MR/MT/MB
  let yMin: number, yMax: number;
  if (v) { yMin = v.yMin; yMax = v.yMax; }
  else {
    // auto amplitude extent = 0..global peak (skip DC), matching drawSpectrum
    let amax = 0;
    for (let k = 1; k < sp.amp.length; k++) if (sp.amp[k] > amax) amax = sp.amp[k];
    if (amax <= 0) amax = 1;
    yMin = 0; yMax = amax;
  }
  swZoomFrame.set(cv.id, { rect, xMin: fMin, xMax: fMax, yMin, yMax, yDown: false });
}

/** Redraw all four builder plots from the cached result (resize/tab-switch safe). */
function swDrawAll() {
  if (!swResult) return;
  const r = swResult;
  const n = r.meta.nSamples;
  const siUs = r.meta.sampleIntervalUs;
  // 1 · Pilot signal - shared single-trace renderer (time runs down), zoomable.
  swDrawSignalPlot();
  // 2 · Instantaneous frequency vs time.
  const fCv = $opt('swFreqCanvas') as HTMLCanvasElement | null;
  if (fCv) {
    const xs = new Float32Array(n);
    const msPer = siUs / 1000;
    for (let i = 0; i < n; i++) xs[i] = (i * msPer) / 1000;
    drawSweepXY(fCv, [{ xs, ys: r.freqOfT }], { xLabel: 'Time (s) →', yLabel: 'Frequency (Hz)' });
  }
  // 3 · Amplitude spectrum (shared renderer with peak + bandwidth markers).
  // NOT amplitudeSpectrum(): its whole-trace Hann window maps onto the chirp's
  // time→frequency law and would bell-shape the flat band (the sweep's own
  // tapers already control leakage). Raw FFT + a window around the sweep band.
  swDrawSpectrumPlot();
  // 4 · Klauder wavelet + side-lobe readout.
  const kCv = $opt('swKlauderCanvas') as HTMLCanvasElement | null;
  if (kCv && swKlauder) {
    drawSweepXY(kCv, [{ xs: swKlauder.lagsMs, ys: swKlauder.wavelet }], { xLabel: 'Lag (ms) →', yLabel: 'Amplitude (norm.)', zeroLine: true });
  }
  setText('swKlauderStats', swKlauder
    ? `peak/side-lobe ${swKlauder.peakSidelobeDb.toFixed(1)} dB · main lobe ${swKlauder.mainLobeMs.toFixed(1)} ms`
    : '-');
}

/** One-line description of a spec (summary pill, audit trail, sweep sheet). */
function swDescribe(spec: SweepSpec, nSamples: number): string {
  const segs = spec.segments?.length ? ` · ${spec.segments.length} segments` : '';
  const f = spec.segments?.length
    ? `${spec.segments[0].f0}-${spec.segments[spec.segments.length - 1].f1} Hz`
    : `${spec.f0}-${spec.f1} Hz`;
  const totalMs = spec.segments?.length ? spec.segments.reduce((a, s) => a + s.lengthMs, 0) : spec.lengthMs;
  return `${spec.type}${segs} · ${f} · ${(totalMs / 1000).toFixed(1)} s · ${nSamples} smp @ ${spec.sampleIntervalUs / 1000} ms`;
}

/** Build the sweep from the form and refresh every plot. `auto` = a live
 *  rebuild from a form edit (skips the audit entry). */
async function swBuildSweep(auto = false) {
  const spec = swSpecFromForm();
  const errs = validateSweepSpec(spec);
  if (errs.length) {
    setText('swStatus', '⚠ ' + errs[0]);
    return;
  }
  // >3s rule: a 65 s sweep at 0.25 ms autocorrelates over million-point FFTs.
  const totalMs = spec.segments?.length ? spec.segments.reduce((a, s) => a + s.lengthMs, 0) : spec.lengthMs;
  const expectSamples = Math.round((totalMs * 1000) / spec.sampleIntervalUs) + 1;
  const heavy = expectSamples > 100_000;
  if (heavy) { showProgress('Building sweep…', undefined, 0); await nextPaint(); }
  try {
    swResult = generateSweep(spec);
    swSpec = spec;
    swKlauder = klauderAnalysis(swResult.samples, swResult.meta.sampleIntervalUs, 250);
    swDrawAll();
    setText('swSummaryPill', swDescribe(spec, swResult.meta.nSamples));
    const adv = $opt('swAdvisories');
    if (adv) {
      adv.style.display = '';
      adv.textContent = swResult.meta.advisories.join('  ·  ');
    }
    setText('swStatus', `Built ${swResult.meta.nSamples} samples.`);
    if (!auto) audit('build', `sweep ${swDescribe(spec, swResult.meta.nSamples)}`, 'sweeps');
    swRefreshQC(auto); // re-run the measured-QC panel if a measured sweep is loaded
  } catch (e) {
    setText('swStatus', '⚠ ' + errMsg(e));
  } finally {
    if (heavy) hideProgress();
    updateHeaderClear();
  }
}

/** Live rebuild on form edits - only once a sweep exists (debounced). */
function swAutoBuild() {
  if (!swResult) return;
  if (swBuildTimer) clearTimeout(swBuildTimer);
  swBuildTimer = window.setTimeout(() => { swBuildTimer = 0; void swBuildSweep(true); }, 300);
}

/** Tab-switch refresh: canvases now have real sizes - repaint from cache. */
function refreshSweeps() {
  swRefreshPresetSelect();
  if (swResult) swDrawAll();
  if (swResult && swMeasured) swRefreshQC(true);
}

/** Clear the built sweep + measured trace (header Clear). Form values stay. */
function swClear() {
  swResult = null;
  swSpec = null;
  swKlauder = null;
  swMeasured = null;
  for (const id of ['swSignalCanvas', 'swFreqCanvas', 'swSpectrumCanvas', 'swKlauderCanvas']) swBlankCanvas(id);
  swZoomForget(SW_ZOOM_IDS); // drop all per-plot zoom windows so a fresh build fits
  setText('swKlauderStats', '-');
  setText('swSummaryPill', '-');
  setText('swStatus', 'Set the parameters, then Build.');
  const adv = $opt('swAdvisories');
  if (adv) { adv.style.display = 'none'; adv.textContent = ''; }
  swClearQCPanel();
  updateHeaderClear();
}

// -- Segment editor (Pelton segmented model, ≤16 segments) ------------------

function swSegDefault(): SweepSegment {
  const prev = swSegments[swSegments.length - 1];
  return {
    type: 'linear',
    f0: prev ? prev.f1 : swNum('swF0', 8),
    f1: swNum('swF1', 96),
    lengthMs: 6000,
  };
}

function swRenderSegs() {
  const host = $opt('swSegList');
  if (!host) return;
  host.innerHTML = '';
  swSegments.forEach((sg, i) => {
    const row = document.createElement('div');
    row.className = 'sec-bar';
    row.style.cssText = 'margin:4px 0 0;';
    const tag = document.createElement('span');
    tag.className = 'pill neutral mono';
    tag.textContent = `#${i + 1}`;
    row.appendChild(tag);
    const sel = document.createElement('select');
    sel.className = 'numin';
    sel.style.width = '104px';
    for (const [v, lbl] of [['linear', 'Linear'], ['dbhz', 'dB/Hz'], ['dboct', 'dB/Octave'], ['tpower', 'T-Power']]) {
      const op = document.createElement('option');
      op.value = v; op.textContent = lbl;
      if (sg.type === v) op.selected = true;
      sel.appendChild(op);
    }
    sel.addEventListener('change', () => { sg.type = sel.value as SweepType; swAutoBuild(); });
    const selLbl = document.createElement('label');
    selLbl.className = 'ctl-lbl';
    selLbl.append('Type ', sel);
    row.appendChild(selLbl);
    const mkNum = (label: string, value: number, step: number, title: string, on: (v: number) => void, allowBlank = false) => {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'numin';
      inp.style.width = '78px';
      inp.step = String(step);
      inp.value = allowBlank && !Number.isFinite(value) ? '' : String(value);
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        on(Number.isFinite(v) ? v : NaN);
        swAutoBuild();
      });
      const lb = document.createElement('label');
      lb.className = 'ctl-lbl';
      lb.title = title;
      lb.append(label + ' ', inp);
      row.appendChild(lb);
    };
    mkNum('Start Hz', sg.f0, 0.1, 'Segment start frequency (should equal the previous segment’s end for a smooth law)', (v) => { sg.f0 = v; });
    mkNum('End Hz', sg.f1, 0.1, 'Segment end frequency', (v) => { sg.f1 = v; });
    mkNum('Length ms', sg.lengthMs, 100, 'Segment length (total ≤ 65535 ms)', (v) => { sg.lengthMs = v; });
    mkNum('Shape', sg.slope ?? NaN, 0.1, 'Optional shaping parameter (blank = the type’s default: dB/Hz 0.1 · dB/Oct 3 · T-Power 2). Ignored for Linear.', (v) => { sg.slope = Number.isFinite(v) ? v : undefined; }, true);
    const rm = document.createElement('button');
    rm.className = 'btn sm';
    rm.textContent = '✕';
    rm.title = 'Remove this segment';
    rm.addEventListener('click', () => { swSegments.splice(i, 1); swRenderSegs(); swAutoBuild(); });
    row.appendChild(rm);
    host.appendChild(row);
  });
  const add = $opt('swSegAdd') as HTMLButtonElement | null;
  if (add) add.disabled = swSegments.length >= MAX_SWEEP_SEGMENTS;
}

function swSetSegUse(on: boolean) {
  swSegUse = on;
  const cb = $opt('swSegOn') as HTMLInputElement | null;
  if (cb) cb.checked = on;
  if (on && swSegments.length === 0) swSegments.push(swSegDefault());
  for (const id of ['swSegList', 'swSegAdd', 'swSegHint']) {
    const el = $opt(id);
    if (el) el.style.display = on ? '' : 'none';
  }
  if (on) swRenderSegs();
  swAutoBuild();
}

// -- Per-survey presets (clone of the Observer Log template pattern) ---------
//  localStorage key seisconv.sweeps.presets: { [name]: { name, spec, qc } }.
//  Same prototype-pollution guards: preset NAMES become object keys, so the
//  dangerous names are rejected on load, save and import.

const SWEEP_PRESET_KEY = 'seisconv.sweeps.presets';
type SweepPreset = { name: string; spec: SweepSpec; qc: SweepQcThresholds };
const SW_FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function swLoadPresets(): Record<string, SweepPreset> {
  try {
    const s = localStorage.getItem(SWEEP_PRESET_KEY);
    if (!s) return {};
    const o = JSON.parse(s) as Record<string, SweepPreset>;
    if (!o || typeof o !== 'object') return {};
    const out: Record<string, SweepPreset> = {};
    for (const k of Object.keys(o)) {
      if (SW_FORBIDDEN_NAMES.has(k)) continue;
      const p = swAsPreset(o[k], k);
      if (p) out[k] = p;
    }
    return out;
  } catch { return {}; }
}
function swSavePresets(map: Record<string, SweepPreset>): void {
  try { localStorage.setItem(SWEEP_PRESET_KEY, JSON.stringify(map)); } catch { /* ignore quota */ }
}

/** Validate an unknown object as a sweep preset (normalised copy or null). */
function swAsPreset(o: unknown, fallbackName: string): SweepPreset | null {
  if (!o || typeof o !== 'object') return null;
  const t = o as Partial<SweepPreset>;
  const s = t.spec as Partial<SweepSpec> | undefined;
  if (!s || typeof s !== 'object') return null;
  const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  const TYPES: SweepType[] = ['linear', 'dbhz', 'dboct', 'tpower'];
  const type = TYPES.includes(s.type as SweepType) ? (s.type as SweepType) : 'linear';
  const segments = Array.isArray(s.segments)
    ? s.segments
        .filter((g): g is SweepSegment => !!g && typeof g === 'object')
        .slice(0, MAX_SWEEP_SEGMENTS)
        .map((g) => ({
          type: TYPES.includes(g.type) ? g.type : 'linear',
          f0: num(g.f0, 8),
          f1: num(g.f1, 96),
          lengthMs: num(g.lengthMs, 6000),
          slope: typeof g.slope === 'number' && Number.isFinite(g.slope) ? g.slope : undefined,
          taperInMs: typeof g.taperInMs === 'number' && Number.isFinite(g.taperInMs) ? g.taperInMs : undefined,
          taperOutMs: typeof g.taperOutMs === 'number' && Number.isFinite(g.taperOutMs) ? g.taperOutMs : undefined,
        }))
    : undefined;
  const name = (typeof t.name === 'string' && t.name.trim() && !SW_FORBIDDEN_NAMES.has(t.name.trim()))
    ? t.name.trim()
    : fallbackName;
  if (SW_FORBIDDEN_NAMES.has(name)) return null;
  const qc = (t.qc && typeof t.qc === 'object') ? t.qc as Partial<SweepQcThresholds> : {};
  return {
    name,
    spec: {
      type,
      f0: num(s.f0, DEFAULT_SWEEP_SPEC.f0),
      f1: num(s.f1, DEFAULT_SWEEP_SPEC.f1),
      lengthMs: num(s.lengthMs, DEFAULT_SWEEP_SPEC.lengthMs),
      taperInMs: num(s.taperInMs, DEFAULT_SWEEP_SPEC.taperInMs),
      taperOutMs: num(s.taperOutMs, DEFAULT_SWEEP_SPEC.taperOutMs),
      taperType: s.taperType === 'blackman' ? 'blackman' : 'cosine',
      initialPhaseDeg: num(s.initialPhaseDeg, 0),
      sampleIntervalUs: ([250, 500, 1000, 2000] as number[]).includes(s.sampleIntervalUs as number) ? (s.sampleIntervalUs as number) : 500,
      amplitude: Math.min(1, Math.max(0.01, num(s.amplitude, 1))),
      slope: typeof s.slope === 'number' && Number.isFinite(s.slope) ? s.slope : undefined,
      segments: segments && segments.length ? segments : undefined,
    },
    qc: {
      avgPhaseDeg: num(qc.avgPhaseDeg, DEFAULT_SWEEP_QC.avgPhaseDeg),
      peakPhaseDeg: num(qc.peakPhaseDeg, DEFAULT_SWEEP_QC.peakPhaseDeg),
      thdPct: num(qc.thdPct, DEFAULT_SWEEP_QC.thdPct),
    },
  };
}

/** Push a preset's spec + QC thresholds onto the designer form. */
function swApplyPreset(p: SweepPreset) {
  const set = (id: string, v: string) => { const el = $opt(id) as HTMLInputElement | HTMLSelectElement | null; if (el) el.value = v; };
  set('swType', p.spec.type);
  set('swF0', String(p.spec.f0));
  set('swF1', String(p.spec.f1));
  set('swLen', String(p.spec.lengthMs));
  set('swTaperIn', String(p.spec.taperInMs));
  set('swTaperOut', String(p.spec.taperOutMs));
  set('swTaperType', p.spec.taperType);
  set('swPhase', String(p.spec.initialPhaseDeg));
  set('swSi', String(p.spec.sampleIntervalUs));
  set('swAmp', String(p.spec.amplitude));
  set('swSlope', p.spec.slope != null ? String(p.spec.slope) : '');
  swSegments = (p.spec.segments ?? []).map((s) => ({ ...s }));
  swQc = { ...p.qc };
  swSyncQcInputs();
  swSyncTypeUI();
  swSetSegUse(swSegments.length > 0);
  if (!swSegUse) swRenderSegs();
  setText('swPresetStatus', `Loaded preset “${p.name}”.`);
  void swBuildSweep(true);
}

function swRefreshPresetSelect() {
  const sel = $opt('swPresetSelect') as HTMLSelectElement | null;
  if (!sel) return;
  const map = swLoadPresets();
  const names = Object.keys(map).sort((a, b) => a.localeCompare(b));
  const prev = sel.value;
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = names.length ? 'Choose preset…' : '(no presets saved)';
  sel.appendChild(ph);
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    sel.appendChild(o);
  }
  if (names.includes(prev)) sel.value = prev;
  const has = sel.value !== '';
  for (const [id, need] of [['swPresetLoad', has], ['swPresetDelete', has], ['swPresetExport', true]] as Array<[string, boolean]>) {
    const b = $opt(id) as HTMLButtonElement | null;
    if (b) b.disabled = !need;
  }
}

async function swPresetSaveCurrent() {
  const name = ((await promptInput('Save the current sweep + QC thresholds as preset - name:', '', 'Save sweep preset')) ?? '').trim();
  if (!name) return;
  if (SW_FORBIDDEN_NAMES.has(name)) { setText('swPresetStatus', 'That name is not allowed.'); return; }
  const map = swLoadPresets();
  if (map[name] && !(await confirmDelete(`A preset named “${name}” exists - overwrite it?`))) return;
  map[name] = { name, spec: swSpecFromForm(), qc: { ...swQc } };
  swSavePresets(map);
  swRefreshPresetSelect();
  const sel = $opt('swPresetSelect') as HTMLSelectElement | null;
  if (sel) { sel.value = name; swRefreshPresetSelect(); }
  setText('swPresetStatus', `Saved preset “${name}”.`);
  audit('save', `sweep preset “${name}”`, 'sweeps');
}

function swPresetLoadSelected() {
  const sel = $opt('swPresetSelect') as HTMLSelectElement | null;
  const name = sel?.value ?? '';
  if (!name) return;
  const p = swLoadPresets()[name];
  if (p) swApplyPreset(p);
  else swRefreshPresetSelect();
}

async function swPresetDeleteSelected() {
  const sel = $opt('swPresetSelect') as HTMLSelectElement | null;
  const name = sel?.value ?? '';
  if (!name) return;
  if (!(await confirmDelete(`Delete sweep preset “${name}”?`))) return;
  const map = swLoadPresets();
  delete map[name];
  swSavePresets(map);
  swRefreshPresetSelect();
  setText('swPresetStatus', `Deleted preset “${name}”.`);
}

async function swPresetExportSelected() {
  const sel = $opt('swPresetSelect') as HTMLSelectElement | null;
  const name = sel?.value ?? '';
  const map = swLoadPresets();
  const p: SweepPreset = name && map[name] ? map[name] : { name: 'Current sweep', spec: swSpecFromForm(), qc: { ...swQc } };
  const safe = (p.name || 'preset').replace(/[^a-z0-9_-]+/gi, '-');
  try {
    const r = await api.exportText(`sweep-preset-${safe}.json`, JSON.stringify(p, null, 2));
    if (r?.ok) setText('swPresetStatus', `Exported preset “${p.name}”.`);
  } catch { /* dialog cancelled / write error */ }
}

async function swPresetImport() {
  let raw: unknown = null;
  try { raw = await api.openTemplateJson(); } catch { return; }
  if (raw == null) return;
  const p = swAsPreset(raw, 'Imported preset');
  if (!p) { setText('swPresetStatus', 'That file is not a valid sweep preset.'); return; }
  const map = swLoadPresets();
  let name = p.name;
  if (map[name] && !(await confirmDelete(`A preset named “${name}” exists - overwrite it?`))) {
    let n = 2;
    while (map[`${p.name} (${n})`]) n++;
    name = `${p.name} (${n})`;
    p.name = name;
  }
  map[name] = p;
  swSavePresets(map);
  swRefreshPresetSelect();
  const sel = $opt('swPresetSelect') as HTMLSelectElement | null;
  if (sel) { sel.value = name; swRefreshPresetSelect(); }
  swApplyPreset(p);
}

// -- Exports: pilot trace (SEG-Y Rev 2 / SU / CSV) · SCIO .SV · sweep sheet --

/** The built pilot as a 1-trace ParsedFile for the existing format writers. */
function swPilotParsedFile(): ParsedFile | null {
  if (!swResult) return null;
  const r = swResult;
  return {
    format: 'SEG-Y',
    revision: 2,
    bh: { sampleInt: Math.round(r.meta.sampleIntervalUs), samplesTrace: r.meta.nSamples, dataFmt: 5 },
    traces: [{ hdr: { fieldRec: 1, trcField: 1, traceId: 1 }, samples: r.samples, nSamples: r.meta.nSamples, dataFmt: 5 }],
    traceCount: 1,
    errors: [],
  };
}

/** File-name stem for sweep exports, from the built spec. */
function swBaseName(): string {
  if (!swSpec || !swResult) return 'sweep';
  const s = swSpec;
  const band = s.segments?.length
    ? `${s.segments[0].f0}-${s.segments[s.segments.length - 1].f1}Hz-${s.segments.length}seg`
    : `${s.f0}-${s.f1}Hz`;
  return `sweep-${s.type}-${band}-${(swResult.meta.durationMs / 1000).toFixed(1).replace(/\.0$/, '')}s`
    .replace(/[^a-z0-9.-]+/gi, '-');
}

/** Export the pilot trace via the existing writers + native save dialog. */
async function swExportPilot(fmt: 'segy' | 'su' | 'csv') {
  const pf = swPilotParsedFile();
  if (!pf || !swResult) { setText('swExportStatus', 'Build a sweep first.'); return; }
  const n = swResult.meta.nSamples;
  // 1.2 ns-guard: SEG-Y/SU carry ns in a 16-bit field. Refuse up-front with the
  // remedy (the writers also throw - no silent truncation either way).
  if (fmt !== 'csv' && n > 65535) {
    setText('swExportStatus', `⚠ ${n} samples exceed the SEG-Y/SU 16-bit limit (65535) - pick a coarser Pilot dt or export CSV.`);
    return;
  }
  try {
    const name = swBaseName();
    let r: { ok?: boolean; path?: string } | null = null;
    if (fmt === 'segy') r = await api.exportBinary(`${name}.segy`, writeSEGY(pf, 2));
    else if (fmt === 'su') r = await api.exportBinary(`${name}.su`, writeSU(pf));
    else r = await api.exportBinary(`${name}.csv`, writeCSV(pf));
    if (r?.ok) {
      setText('swExportStatus', `Exported pilot ${fmt.toUpperCase()} → ${r.path}`);
      audit('export', `sweep pilot ${fmt.toUpperCase()} (${n} smp @ ${swResult.meta.sampleIntervalUs / 1000} ms) → ${r.path}`, 'sweeps');
    }
  } catch (e) {
    setText('swExportStatus', '⚠ ' + errMsg(e));
  }
}

/** Export the SCIO .SV sweep-definition table (fixed 2048 samples/s). */
async function swExportSV() {
  if (!swSpec || !swResult) { setText('swExportStatus', 'Build a sweep first.'); return; }
  try {
    const text = buildSVText(swSpec);
    const lines = (swResult.meta.durationMs / 1000) * SV_RATE_HZ + 1;
    const r = await api.exportText(`${swBaseName()}.SV`, text);
    if (r?.ok) {
      setText('swExportStatus',
        `Exported .SV (${Math.round(lines)} lines @ ${SV_RATE_HZ} sps) → ${r.path} · ` +
        'Reminder: the .SV table is the fixed 2048 sps SCIO definition; the VibPro DSP itself runs at its native 0.25 ms rate.');
      audit('export', `SCIO .SV sweep table (${Math.round(lines)} lines) → ${r.path}`, 'sweeps');
    }
  } catch (e) {
    setText('swExportStatus', '⚠ ' + errMsg(e));
  }
}

/** Printable HTML sweep sheet: parameter table + the four plots (embedded PNGs)
 *  + advisories (+ the QC summary when a measured sweep has been checked). */
function buildSweepSheetHtml(): string {
  const spec = swSpec!;
  const r = swResult!;
  const rows: Array<[string, string]> = [
    ['Sweep type', spec.segments?.length ? `${spec.segments.length}-segment (see table below)` : spec.type],
    ['Frequency band', spec.segments?.length
      ? `${spec.segments[0].f0} → ${spec.segments[spec.segments.length - 1].f1} Hz (per segment below)`
      : `${spec.f0} → ${spec.f1} Hz`],
    ['Length', `${r.meta.durationMs} ms (${(r.meta.durationMs / 1000).toFixed(2)} s)`],
    ['Taper in / out', `${spec.taperInMs} / ${spec.taperOutMs} ms · ${spec.taperType}`],
    ['Initial phase', `${spec.initialPhaseDeg}°`],
    ['Pilot sample interval', `${spec.sampleIntervalUs / 1000} ms (${r.meta.nSamples} samples)`],
    ['Amplitude', `${spec.amplitude} of full scale`],
  ];
  if (spec.type !== 'linear' && !spec.segments?.length) {
    rows.splice(1, 0, ['Shaping', `${spec.slope ?? defaultSlope(spec.type)} ${spec.type === 'dbhz' ? 'dB/Hz' : spec.type === 'dboct' ? 'dB/octave' : '(T-power exponent)'}`]);
  }
  if (swKlauder) {
    rows.push(['Klauder wavelet', `peak/side-lobe ${swKlauder.peakSidelobeDb.toFixed(1)} dB · main lobe ${swKlauder.mainLobeMs.toFixed(1)} ms`]);
  }
  const metaHtml = rows
    .map(([k, v]) => `<tr><th>${htmlEscape(k)}</th><td>${htmlEscape(v)}</td></tr>`)
    .join('');
  const segHtml = spec.segments?.length
    ? `<h2>Segments</h2><table class="log"><thead><tr><th>#</th><th>Type</th><th>Start Hz</th><th>End Hz</th><th>Length ms</th><th>Shaping</th></tr></thead><tbody>${spec.segments
        .map((s, i) => `<tr><td>${i + 1}</td><td>${htmlEscape(s.type)}</td><td>${s.f0}</td><td>${s.f1}</td><td>${s.lengthMs}</td><td>${s.slope ?? (s.type === 'linear' ? '-' : defaultSlope(s.type))}</td></tr>`)
        .join('')}</tbody></table>`
    : '';
  // Plot PNGs straight off the live canvases (repainted first so they're current).
  swDrawAll();
  const png = (id: string): string => {
    const cv = $opt(id) as HTMLCanvasElement | null;
    try { return cv ? cv.toDataURL('image/png') : ''; } catch { return ''; }
  };
  const plots: Array<[string, string]> = [
    ['Pilot signal - amplitude vs time', png('swSignalCanvas')],
    ['Instantaneous frequency vs time', png('swFreqCanvas')],
    ['Amplitude spectrum', png('swSpectrumCanvas')],
    ['Klauder wavelet (autocorrelation)', png('swKlauderCanvas')],
  ];
  const plotsHtml = plots
    .filter(([, d]) => d !== '')
    .map(([cap, d]) => `<figure><img src="${d}" alt="${htmlEscape(cap)}"><figcaption>${htmlEscape(cap)}</figcaption></figure>`)
    .join('');
  const advHtml = r.meta.advisories.map((a) => `<li>${htmlEscape(a)}</li>`).join('');
  const qcHtml = swQcSummaryHtml();
  const generated = new Date().toLocaleString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Vibroseis Sweep Sheet - ${htmlEscape(swDescribe(spec, r.meta.nSamples))}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #11202e; margin: 28px; font-size: 12px; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  h2 { font-size: 14px; margin: 18px 0 6px; }
  .sub { color: #5a6b78; font-size: 11px; margin-bottom: 16px; }
  table.meta { border-collapse: collapse; margin: 0 0 6px; }
  table.meta th { text-align: left; color: #5a6b78; font-weight: 600; padding: 2px 16px 2px 0; vertical-align: top; white-space: nowrap; }
  table.meta td { padding: 2px 0; }
  table.log { border-collapse: collapse; }
  table.log th, table.log td { border: 1px solid #cfd8df; padding: 4px 9px; text-align: left; }
  table.log thead th { background: #eef3f6; font-weight: 700; }
  .plots { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 8px; }
  figure { margin: 0; }
  figure img { width: 100%; border: 1px solid #cfd8df; border-radius: 6px; }
  figcaption { color: #5a6b78; font-size: 10.5px; margin-top: 3px; }
  ul.adv { margin: 6px 0 0 18px; padding: 0; color: #405260; }
  .foot { margin-top: 14px; color: #8493a0; font-size: 10px; }
  @media print { body { margin: 0; } .plots { gap: 8px; } }
</style>
</head>
<body>
  <h1>Vibroseis Sweep Sheet</h1>
  <div class="sub">${htmlEscape(swDescribe(spec, r.meta.nSamples))} · generated ${htmlEscape(generated)} · SeisConv</div>
  <table class="meta"><tbody>${metaHtml}</tbody></table>
  ${segHtml}
  <h2>Plots</h2>
  <div class="plots">${plotsHtml}</div>
  <h2>Advisories</h2>
  <ul class="adv">${advHtml}</ul>
  ${qcHtml}
  <div class="foot">Print this page to PDF (Ctrl+P → “Save as PDF”) for a portable copy. Advisories are guidance only - the vibrator’s own limits govern.</div>
</body>
</html>`;
}

/** Export the printable sweep sheet via the native save dialog. */
async function swExportSheet() {
  if (!swSpec || !swResult) { setText('swExportStatus', 'Build a sweep first.'); return; }
  try {
    const r = await api.exportText(`${swBaseName()}-sheet.html`, buildSweepSheetHtml());
    if (r?.ok) {
      setText('swExportStatus', `Exported sweep sheet → ${r.path}`);
      audit('export', `sweep sheet (HTML) → ${r.path}`, 'sweeps');
    }
  } catch (e) {
    setText('swExportStatus', '⚠ ' + errMsg(e));
  }
}

// -- Sweep QC: designed vs measured -------------------------------------------
//  Load a recorded pilot / ground-force / similarity trace (any format parseAny
//  reads - the tab-scoped pickTraceFile/extractTrace flow the Workbench uses),
//  regenerate the DESIGN analytically at the measured rate, and compare:
//  phase-error vs time (FFT-Hilbert instantaneous phase), envelope + spectrum
//  overlays, THD vs time, and the designed×measured correlation wavelet.
//  Verdicts are advisory: numbers against the preset's tunable thresholds.

const SW_MEAS_COLOR = '#f0a94b'; // amber for the measured series (designed stays cyan)

type SweepQcMetrics = {
  avgPhaseDeg: number;
  peakPhaseDeg: number;
  avgThdPct: number;
  maxThdPct: number;
  corrPeakLagMs: number;
  corrCoef: number;
  corrSidelobeDb: number;
  measuredName: string;
  measuredTrace: number;
  rateNote: string;
};
let swQcMetrics: SweepQcMetrics | null = null;

/** Push the current thresholds into the QC inputs (preset load / init). */
function swSyncQcInputs() {
  const set = (id: string, v: number) => { const el = $opt(id) as HTMLInputElement | null; if (el) el.value = String(v); };
  set('swQcThrAvg', swQc.avgPhaseDeg);
  set('swQcThrPeak', swQc.peakPhaseDeg);
  set('swQcThrThd', swQc.thdPct);
}

/** Read the (tunable) thresholds back from the inputs. */
function swReadQcThresholds() {
  swQc = {
    avgPhaseDeg: Math.max(0, swNum('swQcThrAvg', DEFAULT_SWEEP_QC.avgPhaseDeg)),
    peakPhaseDeg: Math.max(0, swNum('swQcThrPeak', DEFAULT_SWEEP_QC.peakPhaseDeg)),
    thdPct: Math.max(0, swNum('swQcThrThd', DEFAULT_SWEEP_QC.thdPct)),
  };
}

/** Reset the QC panel (measured sweep dropped / Clear). */
function swClearQCPanel() {
  swQcMetrics = null;
  for (const id of ['swQcPhaseCanvas', 'swQcThdCanvas', 'swQcEnvCanvas', 'swQcSpecCanvas', 'swQcCorrCanvas']) swBlankCanvas(id);
  swZoomForget(SW_QC_ZOOM_IDS); // drop the QC plots' zoom windows when the measured sweep is dropped
  setText('swQcFileLabel', 'No measured sweep loaded.');
  setText('swQcReadout', '-');
  setText('swQcCorrStats', '-');
  const v = $opt('swQcVerdict');
  if (v) { v.textContent = 'no measured sweep'; (v as HTMLElement).style.color = ''; }
}

/** Pass/fail against the current thresholds → verdict pill + readout line. */
function swQcVerdictRefresh() {
  const v = $opt('swQcVerdict') as HTMLElement | null;
  if (!swQcMetrics) { if (v) { v.textContent = 'no measured sweep'; v.style.color = ''; } return; }
  const m = swQcMetrics;
  const fails: string[] = [];
  if (m.avgPhaseDeg > swQc.avgPhaseDeg) fails.push(`avg phase ${m.avgPhaseDeg.toFixed(1)}° > ${swQc.avgPhaseDeg}°`);
  if (m.peakPhaseDeg > swQc.peakPhaseDeg) fails.push(`peak phase ${m.peakPhaseDeg.toFixed(1)}° > ${swQc.peakPhaseDeg}°`);
  if (m.avgThdPct > swQc.thdPct) fails.push(`THD ${m.avgThdPct.toFixed(1)}% > ${swQc.thdPct}%`);
  if (v) {
    v.textContent = fails.length ? `✗ outside thresholds - ${fails.join(' · ')}` : '✓ within thresholds';
    v.style.color = fails.length ? 'var(--red, #e05555)' : 'var(--green, #2f9e6e)';
  }
  setText('swQcReadout',
    `avg |phase| ${m.avgPhaseDeg.toFixed(2)}° · peak ${m.peakPhaseDeg.toFixed(2)}° · ` +
    `THD avg ${m.avgThdPct.toFixed(1)}% / max ${m.maxThdPct.toFixed(1)}% · ` +
    `corr peak ${m.corrCoef.toFixed(3)} @ ${m.corrPeakLagMs.toFixed(2)} ms${m.rateNote}`);
}

/** Open a measured sweep (native picker + parse via the shared extract flow). */
async function swQcLoad() {
  if (!swResult || !swSpec) { setText('swQcFileLabel', 'Build/design the sweep first - QC compares against it.'); return; }
  let path: string | null = null;
  try { path = await api.pickTraceFile(); } catch { return; }
  if (!path) return;
  const idx = Math.max(0, Math.round(swNum('swQcTraceIdx', 0)));
  showProgress('Reading measured sweep…');
  try {
    swMeasured = await api.extractTrace(path, idx);
    setText('swQcFileLabel', `${swMeasured.name} · trace ${swMeasured.index + 1} of ${swMeasured.traceCount} · ${swMeasured.nSamples} smp @ ${(swMeasured.sampleInt / 1000).toFixed(3)} ms`);
    audit('load', `measured sweep ${swMeasured.name} (trace ${swMeasured.index})`, 'sweeps');
    swRefreshQC(false);
  } catch (e) {
    setText('swQcFileLabel', '⚠ ' + errMsg(e));
  } finally {
    hideProgress();
    updateHeaderClear();
  }
}

/** Recompute + redraw the whole designed-vs-measured comparison. */
function swRefreshQC(auto: boolean) {
  if (!swMeasured || !swResult || !swSpec) return;
  const meas = swMeasured;
  if (!meas.samples.length || !(meas.sampleInt > 0)) {
    setText('swQcFileLabel', '⚠ measured trace has no samples / no sample interval - cannot QC');
    return;
  }
  try {
    // Design at the MEASURED rate - regenerated analytically (no interpolation
    // error on the measured data; the designed law is exact at any rate).
    const sameRate = Math.abs(meas.sampleInt - swResult.meta.sampleIntervalUs) < 1e-6;
    const design = sameRate ? swResult : generateSweepAtRate(swSpec, 1e6 / meas.sampleInt);
    const rateNote = sameRate ? '' : ` · design regenerated @ ${(meas.sampleInt / 1000).toFixed(3)} ms`;
    const n = Math.min(design.meta.nSamples, meas.nSamples);
    const siUs = meas.sampleInt;
    const msPer = siUs / 1000;
    const mSamples = meas.samples.subarray(0, n);

    // -- Phase error vs time (FFT-Hilbert) --
    const ip = instantaneousPhase(mSamples);
    const phaseErr = new Float32Array(n);
    for (let i = 0; i < n; i++) phaseErr[i] = wrapDeg180(ip.phaseRad[i] * (180 / Math.PI) - design.phaseDeg[i]);
    // Stats over the FULL-DRIVE region (designed envelope above half amplitude,
    // 2% edges trimmed) - the tapers/edges carry no meaningful phase.
    const lo = Math.floor(n * 0.02);
    const hi = Math.ceil(n * 0.98);
    const half = 0.5 * (swSpec.amplitude || 1);
    let sumAbs = 0;
    let peakAbs = 0;
    let cnt = 0;
    for (let i = lo; i < hi; i++) {
      if (design.envelope[i] < half) continue;
      const a = Math.abs(phaseErr[i]);
      sumAbs += a;
      if (a > peakAbs) peakAbs = a;
      cnt++;
    }
    const avgPhase = cnt ? sumAbs / cnt : 0;

    const times = new Float32Array(n);
    for (let i = 0; i < n; i++) times[i] = (i * msPer) / 1000;
    // Plot the phase error over the SAME full-drive region the stats use - the
    // taper edges carry meaningless Hilbert edge spikes that would blow the
    // Y-scale to ±100° and hide the real (few-degree) error curve.
    let i0 = lo;
    while (i0 < hi && design.envelope[i0] < half) i0++;
    let i1 = hi - 1;
    while (i1 > i0 && design.envelope[i1] < half) i1--;
    const phCv = $opt('swQcPhaseCanvas') as HTMLCanvasElement | null;
    if (phCv) {
      drawSweepXY(phCv, [{ xs: times.subarray(i0, i1 + 1), ys: phaseErr.subarray(i0, i1 + 1) }],
        { xLabel: 'Time (s) →', yLabel: 'Phase error (°)', zeroLine: true });
    }

    // -- THD vs time --
    const thd = thdEstimate(mSamples, design.freqOfT, siUs);
    const thdCv = $opt('swQcThdCanvas') as HTMLCanvasElement | null;
    if (thdCv) {
      const tSec = new Float32Array(thd.timesMs.length);
      for (let i = 0; i < tSec.length; i++) tSec[i] = thd.timesMs[i] / 1000;
      drawSweepXY(thdCv, [{ xs: tSec, ys: thd.thdPct }], { xLabel: 'Time (s) →', yLabel: 'THD (%)' });
    }

    // -- Envelope overlay (both normalized to their full-drive median) --
    const envCv = $opt('swQcEnvCanvas') as HTMLCanvasElement | null;
    if (envCv) {
      const normTo = (env: Float32Array): Float32Array => {
        const vals: number[] = [];
        for (let i = lo; i < hi; i += Math.max(1, Math.floor(n / 2000))) {
          if (design.envelope[i] >= half) vals.push(env[i]);
        }
        vals.sort((a, b) => a - b);
        const med = vals.length ? vals[vals.length >> 1] : 1;
        const out = new Float32Array(n);
        const d = med > 0 ? med : 1;
        for (let i = 0; i < n; i++) out[i] = env[i] / d;
        return out;
      };
      drawSweepXY(envCv, [
        { xs: times, ys: normTo(design.envelope.subarray(0, n)) },
        { xs: times, ys: normTo(ip.envelope), color: SW_MEAS_COLOR },
      ], { xLabel: 'Time (s) →', yLabel: 'Envelope (norm.)' });
    }

    // -- Spectrum overlay (each normalized to its own peak) --
    const specCv = $opt('swQcSpecCanvas') as HTMLCanvasElement | null;
    if (specCv) {
      const fShow = Math.min(1e6 / siUs / 2, Math.max(20, design.meta.fMax * 1.6));
      const band = (sp: SpectrumLike): { xs: Float32Array; ys: Float32Array } => {
        let k1 = sp.freqs.length;
        for (let k = 0; k < sp.freqs.length; k++) if (sp.freqs[k] > fShow) { k1 = k; break; }
        let peak = 0;
        for (let k = 1; k < k1; k++) if (sp.amp[k] > peak) peak = sp.amp[k];
        const ys = new Float32Array(k1);
        const p = peak > 0 ? peak : 1;
        for (let k = 0; k < k1; k++) ys[k] = sp.amp[k] / p;
        return { xs: sp.freqs.subarray(0, k1) as Float32Array, ys };
      };
      const d = band(swRawSpectrum(design.samples.subarray(0, n), siUs));
      const m = band(swRawSpectrum(mSamples, siUs));
      drawSweepXY(specCv, [d, { ...m, color: SW_MEAS_COLOR }], { xLabel: 'Frequency (Hz) →', yLabel: 'Amplitude (norm.)' });
    }

    // -- Correlation wavelet: designed × measured --
    const corr = crossCorrelate(design.samples.subarray(0, n), mSamples, siUs);
    const zero = n - 1; // lag 0 of the centred sequence
    const winN = Math.max(2, Math.min(zero, Math.round(250_000 / siUs)));
    const m2 = 2 * winN + 1;
    const wXs = new Float32Array(m2);
    const wYs = new Float32Array(m2);
    let peakAbsC = 0;
    for (let i = 0; i < m2; i++) {
      const c = corr.corr[zero - winN + i];
      wXs[i] = (i - winN) * msPer;
      wYs[i] = c;
      const a = Math.abs(c);
      if (a > peakAbsC) peakAbsC = a;
    }
    if (peakAbsC > 0) for (let i = 0; i < m2; i++) wYs[i] /= peakAbsC;
    // Side lobes beyond the first zero crossing from the (windowed) peak.
    let pkI = winN;
    let pkV = 0;
    for (let i = 0; i < m2; i++) if (Math.abs(wYs[i]) > pkV) { pkV = Math.abs(wYs[i]); pkI = i; }
    let zc = 0;
    for (let i = 1; i < winN; i++) {
      const a = pkI + i, b = pkI + i - 1;
      if (a < m2 && (wYs[b] > 0) !== (wYs[a] > 0)) { zc = i; break; }
    }
    let side = 0;
    if (zc > 0) {
      for (let i = 0; i < m2; i++) {
        if (Math.abs(i - pkI) <= zc) continue;
        const a = Math.abs(wYs[i]);
        if (a > side) side = a;
      }
    }
    const sidelobeDb = side > 0 ? Math.min(120, 20 * Math.log10(1 / side)) : 120;
    const corrCv = $opt('swQcCorrCanvas') as HTMLCanvasElement | null;
    if (corrCv) drawSweepXY(corrCv, [{ xs: wXs, ys: wYs }], { xLabel: 'Lag (ms) →', yLabel: 'Correlation (norm.)', zeroLine: true });
    setText('swQcCorrStats', `peak ${corr.bestCoef.toFixed(3)} @ ${corr.bestLagMs.toFixed(2)} ms · side lobes -${sidelobeDb.toFixed(1)} dB`);

    swQcMetrics = {
      avgPhaseDeg: avgPhase,
      peakPhaseDeg: peakAbs,
      avgThdPct: thd.avgPct,
      maxThdPct: thd.maxPct,
      corrPeakLagMs: corr.bestLagMs,
      corrCoef: corr.bestCoef,
      corrSidelobeDb: sidelobeDb,
      measuredName: meas.name,
      measuredTrace: meas.index,
      rateNote,
    };
    swQcVerdictRefresh();
    if (!auto) {
      audit('qc', `sweep QC vs ${meas.name}: avg phase ${avgPhase.toFixed(2)}°, peak ${peakAbs.toFixed(2)}°, THD ${thd.avgPct.toFixed(1)}%`, 'sweeps');
    }
  } catch (e) {
    setText('swQcReadout', '⚠ ' + errMsg(e));
  }
}

/** QC summary block for the sweep sheet ('' when no measured sweep checked). */
function swQcSummaryHtml(): string {
  if (!swQcMetrics) return '';
  const m = swQcMetrics;
  const row = (k: string, v: string, ok?: boolean) =>
    `<tr><th>${htmlEscape(k)}</th><td>${htmlEscape(v)}${ok === undefined ? '' : ok ? ' ✓' : ' ✗'}</td></tr>`;
  return `<h2>Sweep QC - measured vs designed</h2>
  <table class="meta"><tbody>
    ${row('Measured sweep', `${m.measuredName} (trace ${m.measuredTrace + 1})${m.rateNote}`)}
    ${row('Avg |phase error|', `${m.avgPhaseDeg.toFixed(2)}° (threshold ≤ ${swQc.avgPhaseDeg}°)`, m.avgPhaseDeg <= swQc.avgPhaseDeg)}
    ${row('Peak |phase error|', `${m.peakPhaseDeg.toFixed(2)}° (threshold ≤ ${swQc.peakPhaseDeg}°)`, m.peakPhaseDeg <= swQc.peakPhaseDeg)}
    ${row('THD', `avg ${m.avgThdPct.toFixed(1)}% · max ${m.maxThdPct.toFixed(1)}% (threshold avg ≤ ${swQc.thdPct}%)`, m.avgThdPct <= swQc.thdPct)}
    ${row('Correlation', `peak ${m.corrCoef.toFixed(3)} @ ${m.corrPeakLagMs.toFixed(2)} ms · side lobes -${m.corrSidelobeDb.toFixed(1)} dB`)}
  </tbody></table>
  <div class="sub">Verdicts are advisory - thresholds are the survey preset's; accepting or re-shooting stays the observer's call.</div>`;
}

/** Wire the Sweeps tab (called once from init()). */
function initSweeps() {
  $opt('swBuildBtn')?.addEventListener('click', () => void swBuildSweep(false));
  $opt('swType')?.addEventListener('change', () => { swSyncTypeUI(); swAutoBuild(); });
  for (const id of ['swF0', 'swF1', 'swLen', 'swTaperIn', 'swTaperOut', 'swPhase', 'swAmp', 'swSlope']) {
    $opt(id)?.addEventListener('input', swAutoBuild);
  }
  for (const id of ['swTaperType', 'swSi']) $opt(id)?.addEventListener('change', swAutoBuild);
  $opt('swSegOn')?.addEventListener('change', () => swSetSegUse(($opt('swSegOn') as HTMLInputElement).checked));
  $opt('swSegAdd')?.addEventListener('click', () => {
    if (swSegments.length >= MAX_SWEEP_SEGMENTS) return;
    swSegments.push(swSegDefault());
    swRenderSegs();
    swAutoBuild();
  });
  $opt('swPresetLoad')?.addEventListener('click', swPresetLoadSelected);
  $opt('swPresetSelect')?.addEventListener('change', swRefreshPresetSelect);
  $opt('swPresetSave')?.addEventListener('click', () => void swPresetSaveCurrent());
  $opt('swPresetDelete')?.addEventListener('click', () => void swPresetDeleteSelected());
  $opt('swPresetExport')?.addEventListener('click', () => void swPresetExportSelected());
  $opt('swPresetImport')?.addEventListener('click', () => void swPresetImport());
  $opt('swExpSegy')?.addEventListener('click', () => void swExportPilot('segy'));
  $opt('swExpSu')?.addEventListener('click', () => void swExportPilot('su'));
  $opt('swExpCsv')?.addEventListener('click', () => void swExportPilot('csv'));
  $opt('swExpSv')?.addEventListener('click', () => void swExportSV());
  $opt('swExpSheet')?.addEventListener('click', () => void swExportSheet());
  $opt('swQcLoadBtn')?.addEventListener('click', () => void swQcLoad());
  $opt('swQcClearBtn')?.addEventListener('click', () => {
    swMeasured = null;
    swClearQCPanel();
    updateHeaderClear();
  });
  for (const id of ['swQcThrAvg', 'swQcThrPeak', 'swQcThrThd']) {
    $opt(id)?.addEventListener('input', () => { swReadQcThresholds(); swQcVerdictRefresh(); });
  }
  swSyncQcInputs();
  swSyncTypeUI();
  swRefreshPresetSelect();
  initSweepZoom(); // per-plot drag-box zoom + ＋/-/⤢ toolbar on every Sweeps plot
}

// ++++++++++++++++ WiFiSync ("Field") tab ++++++++++++++++
// A deliberately simple front-end over the native engine in electron/field:
// pick a shared folder, choose a role, discover a peer (or host a hotspot), and
// keep both machines mirror-identical. All privileged work is in main; here we
// only gather config, render peers/history, and reflect live events.
let fieldRole: FieldRole = 'both';
let fieldWatch: 'on_change' | 'interval' = 'on_change';
let fieldFolder = '';
let fieldRunning = false;
let fieldRoleLocked = false;
let fieldSettingsLoaded = false;
let fieldAdapters: FieldNetAdapter[] = [];
const fieldPeers = new Map<string, FieldPeerInfo>();
/** Hosts that announced themselves but have NOT been approved yet - listed with
 *  an Approve button; nothing syncs with them until the user clicks it. */
const fieldPending = new Map<string, FieldPeerInfo>();
const fieldLogLines: string[] = [];

const fInput = (id: string) => $opt(id) as HTMLInputElement | null;

function fldLog(msg: string): void {
  const box = $opt('fldLog');
  if (!box) return;
  const t = new Date().toLocaleTimeString();
  fieldLogLines.push(`[${t}] ${msg}`);
  if (fieldLogLines.length > 400) fieldLogLines.splice(0, fieldLogLines.length - 400);
  box.textContent = fieldLogLines.join('\n');
  box.scrollTop = box.scrollHeight;
}

function fldSetRoleSeg(role: FieldRole): void {
  fieldRole = role;
  document.querySelectorAll('#fldRoleSeg button').forEach((b) => {
    b.classList.toggle('on', (b as HTMLElement).dataset.role === role);
  });
}
function fldSetWatchSeg(w: 'on_change' | 'interval'): void {
  fieldWatch = w;
  document.querySelectorAll('#fldWatchSeg button').forEach((b) => {
    b.classList.toggle('on', (b as HTMLElement).dataset.watch === w);
  });
}

function fldSetRunning(on: boolean): void {
  fieldRunning = on;
  const dot = $opt('fldStateDot');
  const pill = $opt('fldStatePill');
  if (dot) dot.className = 'fld-dot' + (on ? ' on' : '');
  if (pill) pill.childNodes[1] && (pill.lastChild!.textContent = on ? 'Running' : 'Stopped');
  (fInput('fldStartBtn') as HTMLButtonElement | null)?.toggleAttribute('disabled', on);
  (fInput('fldStopBtn') as HTMLButtonElement | null)?.toggleAttribute('disabled', !on);
  (fInput('fldSyncNow') as HTMLButtonElement | null)?.toggleAttribute('disabled', !on);
  (fInput('fldConnectBtn') as HTMLButtonElement | null)?.toggleAttribute('disabled', !on);
}

/** Append a <td> whose text is set via textContent - peer-supplied strings (IP,
 *  role, file names) are never interpolated into HTML. */
function fldCell(tr: HTMLTableRowElement, text: string, title?: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  if (title !== undefined) td.setAttribute('title', title);
  tr.appendChild(td);
  return td;
}

function fldRenderPeers(): void {
  const body = $opt('fldPeerBody');
  const empty = $opt('fldPeerEmpty');
  if (!body) return;
  body.innerHTML = '';
  const roleName: Record<FieldRole, string> = { both: 'Two-way', master: 'Master', slave: 'Slave' };
  const addRow = (p: FieldPeerInfo, trusted: boolean): void => {
    const tr = document.createElement('tr');
    fldCell(tr, p.ip);
    fldCell(tr, String(p.port));
    fldCell(tr, roleName[p.role] ?? String(p.role));
    const td = document.createElement('td');
    const label = document.createElement('span');
    label.textContent = trusted ? 'Approved ✓ ' : 'Not approved ';
    td.appendChild(label);
    const btn = document.createElement('button');
    btn.className = 'btn sm';
    btn.type = 'button';
    btn.textContent = trusted ? 'Revoke' : 'Approve';
    btn.title = trusted
      ? 'Stop syncing with this machine and stop serving it files'
      : 'Trust this machine: sync with it and let it read the shared folder';
    btn.addEventListener('click', () => void fldTrustPeer(p.ip, !trusted));
    td.appendChild(btn);
    tr.appendChild(td);
    body.appendChild(tr);
  };
  for (const p of fieldPeers.values()) addRow(p, true);
  for (const p of fieldPending.values()) addRow(p, false);
  if (empty) empty.style.display = fieldPeers.size === 0 && fieldPending.size === 0 ? '' : 'none';
}

async function fldTrustPeer(ip: string, trusted: boolean): Promise<void> {
  const r = await api.fieldTrustPeer(ip, trusted);
  if (!r.ok) { setStatus('fldSyncStatus', r.error || 'Could not change the peer approval.', 'err'); return; }
  if (trusted) { fieldPending.delete(ip); fieldPeers.set(ip, fieldPeers.get(ip) ?? { ip, port: 47824, role: 'both' }); }
  else { fieldPeers.delete(ip); }
  fldRenderPeers();
  setStatus('fldSyncStatus', trusted ? `Approved ${ip}.` : `Revoked ${ip}.`, 'ok');
}

function fldFmtSize(n: number): string {
  if (!(n > 0)) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function fldLoadHistory(): Promise<void> {
  const body = $opt('fldHistBody');
  const empty = $opt('fldHistEmpty');
  if (!body) return;
  let entries: FieldHistoryEntry[] = [];
  try { entries = await api.fieldHistoryGet(); } catch { entries = []; }
  body.innerHTML = '';
  for (const e of entries.slice(0, 200)) {
    const time = new Date((e.timestamp || 0) * 1000).toLocaleTimeString();
    const icon = e.action === 'deleted' ? '🗑' : '⬇';
    const file = (e.filename || '').split('/').pop() || e.filename;
    // Every value below came from a peer over the network - build the cells with
    // textContent/setAttribute so nothing is ever parsed as markup.
    const tr = document.createElement('tr');
    fldCell(tr, time);
    fldCell(tr, `${icon} ${e.action}`);
    fldCell(tr, String(file ?? ''), String(e.filename ?? ''));
    fldCell(tr, e.peer_ip || '-');
    fldCell(tr, fldFmtSize(e.size_bytes));
    body.appendChild(tr);
  }
  if (empty) empty.style.display = entries.length === 0 ? '' : 'none';
}

async function fldPopulateAdapters(selectLabel?: string): Promise<void> {
  const sel = $opt('fldAdapter') as HTMLSelectElement | null;
  if (!sel) return;
  try {
    const r = await api.fieldListAdapters();
    fieldAdapters = r.adapters || [];
  } catch { fieldAdapters = []; }
  sel.innerHTML = '<option value="">Auto (broadcast on all)</option>';
  for (const a of fieldAdapters) {
    const opt = document.createElement('option');
    opt.value = a.label; opt.textContent = a.label;
    opt.dataset.ip = a.ip; opt.dataset.broadcast = a.broadcast;
    sel.appendChild(opt);
  }
  if (selectLabel && fieldAdapters.some((a) => a.label === selectLabel)) sel.value = selectLabel;
}

function fldSelectedAdapter(): { ip: string; broadcast: string } {
  const sel = $opt('fldAdapter') as HTMLSelectElement | null;
  const opt = sel?.selectedOptions?.[0];
  return { ip: opt?.dataset.ip || '', broadcast: opt?.dataset.broadcast || '<broadcast>' };
}

/** Populate the hotspot WiFi-adapter dropdown (option value = adapter Name). */
async function fldPopulateHsAdapters(): Promise<void> {
  const sel = $opt('fldHsAdapter') as HTMLSelectElement | null;
  if (!sel) return;
  let adapters: FieldWifiAdapter[] = [];
  try { const r = await api.fieldHotspotAdapters(); adapters = r.adapters || []; } catch { adapters = []; }
  const prev = sel.value;
  sel.innerHTML = '<option value="">Default WiFi adapter</option>';
  for (const a of adapters) {
    const opt = document.createElement('option');
    opt.value = a.name; opt.textContent = a.label;
    sel.appendChild(opt);
  }
  if (prev && adapters.some((a) => a.name === prev)) sel.value = prev;
}

/** The selected hotspot WiFi adapter Name ('' = let the engine pick the default). */
function fldSelectedHsAdapter(): string {
  const sel = $opt('fldHsAdapter') as HTMLSelectElement | null;
  return sel?.value || '';
}

/** Reveal/hide the "Fix Hyper-V conflict" button (only after a HYPERV_CONFLICT). */
function fldShowFixHyperV(show: boolean): void {
  const b = $opt('fldHsFixHyperV'); if (b) b.style.display = show ? '' : 'none';
}

function fldHsSetState(running: boolean, ssid?: string, clients?: number): void {
  const dot = $opt('fldHsDot');
  const pill = $opt('fldHsPill');
  if (dot) dot.className = 'fld-dot' + (running ? ' on' : '');
  if (pill && pill.lastChild) pill.lastChild.textContent = running ? `On${clients != null ? ` · ${clients} client(s)` : ''}` : 'Off';
  if (running && ssid) fldLog(`Hotspot "${ssid}" is on${clients != null ? ` (${clients} client(s))` : ''}.`);
}

async function fldRefreshHotspotStatus(): Promise<void> {
  try {
    const s = await api.fieldHotspotStatus();
    fldHsSetState(s.running, s.ssid, s.clients);
  } catch { /* ignore */ }
}

async function fldApplySettings(): Promise<void> {
  let s: FieldSettings;
  try { s = await api.fieldSettingsGet(); } catch { return; }
  fieldFolder = s.folder || '';
  const fp = $opt('fldFolder'); if (fp) fp.textContent = fieldFolder || '- not chosen -';
  fldSetRoleSeg(s.role || 'both');
  fldSetWatchSeg(s.sync_mode || 'on_change');
  const mip = fInput('fldManualIp'); if (mip) mip.value = s.manual_ip || '';
  const ssid = fInput('fldHsSsid'); if (ssid) ssid.value = s.hs_ssid || 'WifiSync_Host';
  const pass = fInput('fldHsPass'); if (pass) pass.value = s.hs_pass || '';
  const iv = fInput('fldInterval'); if (iv) iv.value = String(s.sync_interval || '5');
  const thr = fInput('fldThrottle'); if (thr) thr.checked = !!s.throttle_enabled;
  const ard = fInput('fldAllowDelete'); if (ard) ard.checked = !!s.allow_remote_delete;
  fieldPending.clear();
  fldRenderPeers();
  const kbps = fInput('fldKbps'); if (kbps) { kbps.value = String(s.throttle_kbps || '500'); kbps.disabled = !s.throttle_enabled; }
  await fldPopulateAdapters(s.adapter);
  await fldPopulateHsAdapters();
}

function fldGatherSettings(): FieldSettings {
  const sel = $opt('fldAdapter') as HTMLSelectElement | null;
  return {
    folder: fieldFolder,
    adapter: sel?.value || '',
    manual_ip: (fInput('fldManualIp')?.value || '').trim(),
    hs_ssid: fInput('fldHsSsid')?.value || 'WifiSync_Host',
    hs_pass: fInput('fldHsPass')?.value || '',
    role: fieldRole,
    sync_mode: fieldWatch,
    sync_interval: String(fInput('fldInterval')?.value || '5'),
    throttle_enabled: !!fInput('fldThrottle')?.checked,
    throttle_kbps: String(fInput('fldKbps')?.value || '500'),
    // trusted_peers is deliberately NOT echoed back: main owns that list and a
    // blind round-trip from here could clear it.
    allow_remote_delete: !!fInput('fldAllowDelete')?.checked,
  };
}

async function fldStart(): Promise<void> {
  if (!fieldFolder) { setStatus('fldEngineStatus', 'Choose a shared folder first.', 'err'); return; }
  const s = fldGatherSettings();
  try { await api.fieldSettingsSet(s); } catch { /* best effort */ }
  const adapter = fldSelectedAdapter();
  const cfg: FieldStartCfg = {
    folder: fieldFolder,
    role: fieldRole,
    watchMode: fieldWatch,
    syncInterval: Math.max(1, Number(fInput('fldInterval')?.value) || 5),
    maxKbps: s.throttle_enabled ? Math.max(1, Number(s.throttle_kbps) || 500) : 0,
    bindIp: adapter.ip,
    broadcastAddr: adapter.broadcast,
    manualIp: s.manual_ip,
  };
  setStatus('fldEngineStatus', 'Starting…');
  const r = await api.fieldStart(cfg);
  if (r.ok) {
    fldSetRunning(true);
    setStatus('fldEngineStatus', `Running - file server on 47824${r.discoveryOn ? ', discovery on' : ' (manual peer)'}.`, 'ok');
    fldLog('WiFiSync started.');
  } else {
    setStatus('fldEngineStatus', r.error || 'Failed to start.', 'err');
  }
}

async function fldStop(): Promise<void> {
  await api.fieldStop();
  fldSetRunning(false);
  fieldPeers.clear();
  fieldPending.clear();
  fldRenderPeers();
  setStatus('fldEngineStatus', 'Stopped.');
}

function fldHandleEvent(ev: FieldEventMsg): void {
  switch (ev.type) {
    case 'log': fldLog(ev.msg); break;
    case 'peer':
      if (ev.action === 'found') { fieldPending.delete(ev.ip); fieldPeers.set(ev.ip, { ip: ev.ip, port: ev.port ?? 47824, role: ev.role ?? 'both' }); }
      else if (ev.action === 'pending') fieldPending.set(ev.ip, { ip: ev.ip, port: ev.port ?? 47824, role: ev.role ?? 'both' });
      else { fieldPeers.delete(ev.ip); fieldPending.delete(ev.ip); }
      fldRenderPeers();
      break;
    case 'status':
      fieldPeers.clear();
      fieldPending.clear();
      for (const p of ev.peers) fieldPeers.set(p.ip, p);
      for (const p of ev.pending ?? []) fieldPending.set(p.ip, p);
      fldRenderPeers();
      if (ev.allowRemoteDelete !== undefined) { const ard = fInput('fldAllowDelete'); if (ard) ard.checked = ev.allowRemoteDelete; }
      fldSetRunning(ev.running);
      break;
    case 'sync':
      setStatus('fldSyncStatus', ev.ok ? `Synced - ${ev.detail}` : `Sync failed - ${ev.detail}`, ev.ok ? 'ok' : 'err');
      break;
    case 'file':
      fldLog(`${ev.kind === 'deleted' ? 'Deleted' : 'Pulled'} ${ev.relPath} (${fldFmtSize(ev.size)})`);
      void fldLoadHistory();
      break;
    case 'negotiated':
      fldSetRoleSeg(ev.role);
      fieldRoleLocked = true;
      document.querySelectorAll('#fldRoleSeg button').forEach((b) => (b as HTMLButtonElement).disabled = true);
      fldLog(`Auto-negotiated role "${ev.role}" (peer is "${ev.peerRole}").`);
      break;
    case 'renegotiable':
      fieldRoleLocked = false;
      document.querySelectorAll('#fldRoleSeg button').forEach((b) => (b as HTMLButtonElement).disabled = false);
      break;
  }
}

let fieldWired = false;
function initField(): void {
  if (fieldWired) return;
  fieldWired = true;

  $opt('fldPickFolder')?.addEventListener('click', async () => {
    const p = await api.fieldPickFolder();
    if (p) { fieldFolder = p; const el = $opt('fldFolder'); if (el) el.textContent = p; try { await api.fieldSettingsSet(fldGatherSettings()); } catch { /* ignore */ } }
  });

  $opt('fldRoleSeg')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-role]') as HTMLElement | null;
    if (!btn || fieldRoleLocked) return;
    const role = btn.dataset.role as FieldRole;
    fldSetRoleSeg(role);
    if (fieldRunning) void api.fieldSetRole(role);
  });
  $opt('fldWatchSeg')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-watch]') as HTMLElement | null;
    if (!btn) return;
    fldSetWatchSeg(btn.dataset.watch as 'on_change' | 'interval');
  });

  $opt('fldRefreshAdapters')?.addEventListener('click', () => void fldPopulateAdapters());
  fInput('fldThrottle')?.addEventListener('change', () => {
    const k = fInput('fldKbps'); if (k) k.disabled = !fInput('fldThrottle')?.checked;
  });
  fInput('fldAllowDelete')?.addEventListener('change', () => {
    const on = !!fInput('fldAllowDelete')?.checked;
    void api.fieldSetAllowRemoteDelete(on);
    fldLog(on
      ? 'Peer-driven deletions ENABLED - a file deleted on an approved peer will now be deleted here too.'
      : 'Peer-driven deletions disabled - peers can add and update files here, but never delete them.');
  });

  $opt('fldStartBtn')?.addEventListener('click', () => void fldStart());
  $opt('fldStopBtn')?.addEventListener('click', () => void fldStop());
  $opt('fldSyncNow')?.addEventListener('click', async () => {
    setStatus('fldSyncStatus', 'Syncing…');
    const r = await api.fieldSyncNow();
    setStatus('fldSyncStatus', r.ok ? `Synced - ${r.detail}` : `Sync failed - ${r.detail}`, r.ok ? 'ok' : 'err');
  });
  $opt('fldConnectBtn')?.addEventListener('click', async () => {
    const ip = (fInput('fldConnIp')?.value || '').trim();
    if (!ip) return;
    setStatus('fldSyncStatus', `Connecting to ${ip}…`);
    const r = await api.fieldConnectPeer(ip);
    setStatus('fldSyncStatus', r.ok ? `Added peer ${ip}.` : (r.error || 'Could not connect.'), r.ok ? 'ok' : 'err');
  });

  // -- Hotspot --
  $opt('fldHsReveal')?.addEventListener('click', () => {
    const p = fInput('fldHsPass'); if (p) p.type = p.type === 'password' ? 'text' : 'password';
  });
  $opt('fldHsRefreshAdapters')?.addEventListener('click', () => void fldPopulateHsAdapters());
  $opt('fldHsStart')?.addEventListener('click', async () => {
    const ssid = fInput('fldHsSsid')?.value || '';
    const pass = fInput('fldHsPass')?.value || '';
    if (!ssid.trim()) { fldLog('Give the hotspot a name before starting it.'); return; }
    // No password ships by default (it would be identical on every install), so the
    // operator must type one here. Say exactly what is wrong and what to do.
    if (!pass) {
      fldLog('No hotspot password set. Type one in the Password box above (at least 8 characters), then press Start hotspot. There is no default password.');
      fInput('fldHsPass')?.focus();
      return;
    }
    if (pass.length < 8) {
      fldLog(`Hotspot password is too short (${pass.length} of 8 characters). Add ${8 - pass.length} more, then press Start hotspot.`);
      fInput('fldHsPass')?.focus();
      return;
    }
    try { await api.fieldSettingsSet(fldGatherSettings()); } catch { /* ignore */ }
    const adapter = fldSelectedHsAdapter();
    fldLog(`Starting hotspot "${ssid}"${adapter ? ` on ${adapter}` : ''}…`);
    const r = await api.fieldHotspotStart(ssid, pass, adapter || undefined);
    if (r.ok) {
      fldHsSetState(true, ssid);
      fldShowFixHyperV(false);
      void fldRefreshHotspotStatus();
      try { const ip = await api.fieldHostIp(); const el = $opt('fldHostIp'); if (el) el.textContent = ip; } catch { /* ignore */ }
    } else {
      fldLog(`Hotspot start failed: ${r.error || 'unknown error'}`);
      // A Hyper-V external switch bound to WiFi surfaces as HYPERV_CONFLICT:<name>.
      fldShowFixHyperV(!!r.error && r.error.includes('HYPERV_CONFLICT'));
    }
  });
  $opt('fldHsStop')?.addEventListener('click', async () => {
    fldLog('Stopping hotspot…');
    const r = await api.fieldHotspotStop();
    if (r.ok) fldHsSetState(false); else fldLog(`Hotspot stop failed: ${r.error || 'unknown error'}`);
  });
  $opt('fldHsStatus')?.addEventListener('click', () => void fldRefreshHotspotStatus());
  $opt('fldHsSettings')?.addEventListener('click', () => void api.fieldOpenHotspotSettings());
  $opt('fldHsReset')?.addEventListener('click', async () => {
    const adapter = fldSelectedHsAdapter();
    if (!adapter) { fldLog('Select a WiFi adapter to reset first.'); return; }
    fldLog(`Resetting WiFi adapter "${adapter}" + hotspot service (UAC prompt)…`);
    const r = await api.fieldResetAdapter(adapter);
    fldLog(r.ok ? 'WiFi adapter and hotspot service reset - try Start hotspot again.' : `Reset failed: ${r.error || 'unknown error'}`);
  });
  $opt('fldHsFixHyperV')?.addEventListener('click', async () => {
    fldLog('Removing Hyper-V WiFi virtual switch (UAC prompt)…');
    const r = await api.fieldFixHyperV();
    if (r.ok) { fldLog('Hyper-V WiFi switch removed - try Start hotspot again.'); fldShowFixHyperV(false); }
    else fldLog(`Fix Hyper-V failed: ${r.error || 'unknown error'}`);
  });

  // -- Firewall + subnet scan (gui.py parity) --
  $opt('fldFirewall')?.addEventListener('click', async () => {
    fldLog('Opening WiFiSync firewall ports (UAC prompt on each rule)…');
    const r = await api.fieldOpenFirewall();
    fldLog(r.ok ? 'Firewall ports opened on this machine - do the same on the peer.' : `Firewall setup failed: ${r.error || 'unknown error'}`);
  });
  $opt('fldScanBtn')?.addEventListener('click', async () => {
    const { ip } = fldSelectedAdapter();
    if (!ip) { setStatus('fldSyncStatus', 'Select a network adapter to scan its subnet.', 'err'); return; }
    setStatus('fldSyncStatus', 'Scanning subnet…');
    fldLog(`Scanning ${ip.slice(0, ip.lastIndexOf('.'))}.1-254 for WiFiSync peers…`);
    const r = await api.fieldScan(ip);
    if (!r.ok) { setStatus('fldSyncStatus', r.error || 'Scan failed.', 'err'); return; }
    if (r.hosts.length === 0) { setStatus('fldSyncStatus', 'No WiFiSync peers found on this subnet.'); fldLog('Scan complete - no peers found.'); return; }
    fldLog(`Scan complete - found: ${r.hosts.join(', ')}`);
    const ci = fInput('fldConnIp'); if (ci) ci.value = r.hosts[0];
    setStatus('fldSyncStatus', r.hosts.length === 1 ? `Found ${r.hosts[0]} - filled in below.` : `Found ${r.hosts.length}: ${r.hosts.join(', ')}`, 'ok');
  });

  $opt('fldHistClear')?.addEventListener('click', async () => { await api.fieldHistoryClear(); void fldLoadHistory(); });

  api.onFieldEvent(fldHandleEvent);
}

async function refreshField(): Promise<void> {
  if (!fieldSettingsLoaded) { fieldSettingsLoaded = true; await fldApplySettings(); }
  // Reflect real engine state (in case it was started/stopped elsewhere).
  try {
    const st = await api.fieldStatus();
    fieldPeers.clear();
    for (const p of st.peers) fieldPeers.set(p.ip, p);
    fldRenderPeers();
    fldSetRunning(st.running);
    if (st.running) fldSetRoleSeg(st.mode);
  } catch { /* ignore */ }
  try { const ip = await api.fieldHostIp(); const el = $opt('fldHostIp'); if (el) el.textContent = ip; } catch { /* ignore */ }
  void fldLoadHistory();
}

// -- Wire up --
function init() {
  initTheme();
  initZoom();
  initWindowControls();
  for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => switchTab(t));
  $('openBtn2').addEventListener('click', onOpen);
  // Per-tab Open file + Clear (Phase 2 IA refactor): every data tab that imports
  // the shared seismic file gets its own prominent pair in its top bar, reusing the
  // existing open flow (onOpen) + per-tab Clear dispatch (clearActiveTab) - the same
  // approach as the Geometry QC tab. The header no longer carries a global Open/Clear;
  // Ctrl/Cmd+O still opens. The SPS tab keeps its own Open SPS / Clear SPS, the
  // Observer Log its own Clear log, and the Converter its in-panel wizard open.
  for (const id of ['traceOpenBtn', 'secOpenBtn', 'specOpenBtn', 'wbOpenBtn']) {
    $opt(id)?.addEventListener('click', () => void onOpen());
  }
  for (const id of ['traceClearBtn', 'secClearBtn', 'specClearBtn', 'wbTabClearBtn', 'ologClearBtn']) {
    $opt(id)?.addEventListener('click', () => clearActiveTab());
  }
  // Provenance foundation: signature identity · audit log · confirm + undo.
  initProvenance();

  // Sweeps tab (vibroseis sweep builder + QC).
  initSweeps();

  // WiFiSync tab (peer-to-peer folder sync + hotspot).
  initField();

  // -- Converter: mode switcher --
  $opt('modeSingle')?.addEventListener('click', () => setConvMode('single'));
  $opt('modeBatch')?.addEventListener('click', () => setConvMode('batch'));

  // -- Converter: format chips (both single + batch groups stay in sync) --
  const onChip = (e: Event) => {
    const btn = (e.target as HTMLElement).closest('button[data-fmt]') as HTMLElement | null;
    if (!btn || batchRunning) return;
    selectFormat(btn.getAttribute('data-fmt')!);
  };
  $opt('fmtChips')?.addEventListener('click', onChip);
  $opt('fmtChipsBatch')?.addEventListener('click', onChip);

  // -- Converter: output-name controls (checklist → template → live preview) --
  const dateEl = $opt('outNameDate') as HTMLInputElement | null;
  if (dateEl && !dateEl.value) {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    dateEl.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  // The checklist (toggles + custom text + separator) ASSEMBLES the template.
  for (const id of ['npName', 'npCustom', 'npFmt', 'npDate', 'npTime', 'npSeq']) {
    $opt(id)?.addEventListener('change', assembleNameTemplate);
  }
  $opt('outNameCustom')?.addEventListener('input', assembleNameTemplate);
  $opt('outNameSep')?.addEventListener('change', assembleNameTemplate);
  // Advanced free-text edits flow back onto the checklist (best-effort) + preview.
  $opt('outNameTpl')?.addEventListener('input', syncChecklistFromTemplate);
  $opt('outNameDate')?.addEventListener('input', updateNamePreview);
  // Seed the template from the default checklist state (name + date).
  assembleNameTemplate();

  // -- Converter: single-file --
  $('convertBtn').addEventListener('click', onConvert);
  $opt('clearBtn')?.addEventListener('click', () => void clearConverter());
  $opt('openSingleFolderBtn')?.addEventListener('click', () => void openOutputFolder('single'));
  $opt('openBatchFolderBtn')?.addEventListener('click', () => void openOutputFolder('batch'));

  // -- Converter: folder batch wizard --
  $opt('pickFolderBtn')?.addEventListener('click', () => void pickBatchFolder());
  $opt('pickOutBtn')?.addEventListener('click', () => void pickBatchOut());
  $opt('runBatchBtn')?.addEventListener('click', () => void runBatch());
  $opt('cancelBatchBtn')?.addEventListener('click', cancelBatch);
  $opt('clearBatchBtn')?.addEventListener('click', () => void clearConverter());
  // live per-file progress from the backend
  convProgressOff = api.onConvertProgress(onBatchProgress);
  // worker-side long-op progress (file open/index build, SPS load) → global bar
  workerProgOff = api.onWorkerProgress((p) => {
    updateProgress(p.done, p.total, p.label);
    setProgressSub(progressSubFor(p));
  });
  $opt('gProgCancel')?.addEventListener('click', () => { gProgCancelFn?.(); });

  // -- Help / Manual modal -- (opened from the rail "?" at the bottom-left)
  $opt('railHelp')?.addEventListener('click', openManual);
  $opt('manualClose')?.addEventListener('click', closeManual);
  $opt('manualBack')?.addEventListener('click', (e) => { if (e.target === $opt('manualBack')) closeManual(); });
  // -- Send Feedback modal --
  $opt('feedbackBtn')?.addEventListener('click', openFeedback);
  $opt('feedbackClose')?.addEventListener('click', closeFeedback);
  $opt('feedbackCancel')?.addEventListener('click', closeFeedback);
  $opt('feedbackBack')?.addEventListener('click', (e) => { if (e.target === $opt('feedbackBack')) closeFeedback(); });
  $opt('feedbackSend')?.addEventListener('click', () => void sendFeedback());
  $opt('feedbackCopy')?.addEventListener('click', () => void copyFeedback());
  const slider = $('traceSlider') as HTMLInputElement;
  slider.addEventListener('input', () => {
    traceIndex = parseInt(slider.value, 10) || 0;
    void refreshTrace();
  });
  $('tracePrev').addEventListener('click', () => {
    traceIndex--;
    void refreshTrace();
  });
  $('traceNext').addEventListener('click', () => {
    traceIndex++;
    void refreshTrace();
  });
  $('traceWave').addEventListener('click', () => setTraceMode('wave'));
  $('traceSpec').addEventListener('click', () => setTraceMode('spectrum'));
  // Trace Inspector: add the current trace to the Trace Workbench (shared add path).
  $opt('traceToWb')?.addEventListener('click', () => {
    if (!summary || !lastTrace) { $('traceLabel').textContent = 'Open a file and pick a trace first.'; return; }
    wbAddTrace(`${summary.name} #${lastTrace.index + 1}`, lastTrace.index, lastTrace.samples.slice(), lastTrace.sampleInt, lastTrace.nSamples);
    $('traceLabel').textContent = `Added trace ${lastTrace.index + 1} to Workbench`;
  });
  traceInteractions(); // wheel-zoom / drag-pan / dblclick-fit + toolbar on the trace TIME axis
  for (const id of ['secMode', 'secColor']) ($(id) as HTMLSelectElement).addEventListener('change', redrawSection);
  // Gain fires on every pixel of the drag - coalesce the full (potentially heavy
  // wiggle/VA) section repaint to ONE per animation frame so large sections stay
  // responsive while dragging. Behaviour is identical, just throttled to frame rate.
  let secGainRaf = false;
  ($('secGain') as HTMLInputElement).addEventListener('input', () => {
    if (secGainRaf) return;
    secGainRaf = true;
    requestAnimationFrame(() => { secGainRaf = false; redrawSection(); });
  });
  ($('secAgc') as HTMLInputElement).addEventListener('change', () => void refreshSection());
  sectionInteractions(); // wheel-zoom / drag-pan / dblclick-fit + toolbar on the section DATA
  // File Viewer trace-health QC: scan / sensitivity / clear-flags / export-report.
  $opt('secHealthBtn')?.addEventListener('click', () => void secRunHealth());
  $opt('secHealthSensBtn')?.addEventListener('click', () => secToggleSensPanel());
  $opt('secHealthClearBtn')?.addEventListener('click', () => { secHealthReset(); if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection); });
  $opt('secHealthExportBtn')?.addEventListener('click', () => void secHealthExport());
  // File Viewer first-breaks MODE: toggle + sub-bar controls (assisted picking).
  $opt('secFbToggle')?.addEventListener('click', () => setFbMode(!fbMode));
  $opt('secFbFillBtn')?.addEventListener('click', () => void secRunFirstBreaks());
  $opt('secFbAcceptBtn')?.addEventListener('click', () => fbAcceptAll());
  $opt('secFbRejectBtn')?.addEventListener('click', () => fbRejectFlagged());
  $opt('secFbClearBtn')?.addEventListener('click', () => fbClearPicks());
  $opt('secFbExportBtn')?.addEventListener('click', () => void fbExportCsv());
  $opt('secFbWindow')?.addEventListener('input', () => { fbWindowMs = fbWindowVal(); if (fbMode && lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection); });
  // Free-text filter over the findings table (complements the column sort).
  $opt('secHealthFilter')?.addEventListener('input', (e) => {
    secHealthFilter = (e.target as HTMLInputElement).value;
    if (secHealth) secRenderHealthFindings();
  });
  // Per-detector sensitivity selects + Advanced numeric overrides re-classify the
  // cached evidence LIVE (no re-scan).
  for (const id of ['sensDead', 'sensNoisy', 'sensAmp', 'sensClipped', 'sensReversed']) {
    $opt(id)?.addEventListener('change', () => { if (secHealth) secReclassifyHealth(); });
  }
  // The Advanced threshold sliders fire on every pixel of the drag, and each
  // re-classification walks EVERY scanned trace (up to half a million) on the UI
  // thread. Coalesce to one re-classification per animation frame - same guard the
  // section-gain slider above already uses; the result is identical, just throttled.
  let secHealthRaf = false;
  const secHealthReclassifyThrottled = () => {
    if (secHealthRaf) return;
    secHealthRaf = true;
    requestAnimationFrame(() => { secHealthRaf = false; if (secHealth) secReclassifyHealth(); });
  };
  for (const id of ['advFlatEps', 'advDeadFrac', 'advHotZ', 'advWeakZ', 'advNoiseZ', 'advSpecK', 'advZcrAbs', 'advClipRun', 'advSpikeK', 'advReverseCorr', 'advReverseConf']) {
    $opt(id)?.addEventListener('input', secHealthReclassifyThrottled);
    // A committed value (release / typed entry) always lands, even if the last
    // frame was coalesced away.
    $opt(id)?.addEventListener('change', () => { if (secHealth) secReclassifyHealth(); });
  }
  initZoomViewer();      // box-zoom region viewer (close / backdrop / header-drag wiring)
  // File Viewer: step to the previous/next seismic file in the open file's folder.
  $opt('filePrevBtn')?.addEventListener('click', () => void navFile(-1));
  $opt('fileNextBtn')?.addEventListener('click', () => void navFile(1));
  // File Viewer: page through a streamed/tape-image file in fixed blocks of traces.
  $opt('secPagePrev')?.addEventListener('click', () => void secPageStep(-1));
  $opt('secPageNext')?.addEventListener('click', () => void secPageStep(1));
  $opt('secPageSize')?.addEventListener('change', () => void secPageApplySize());
  $('spsLoadBtn').addEventListener('click', () => void loadSPS());
  $opt('spsClearBtn')?.addEventListener('click', () => void clearSPS());
  ($('spsShowS') as HTMLInputElement).addEventListener('change', () => void refreshSps());
  ($('spsShowR') as HTMLInputElement).addEventListener('change', () => void refreshSps());
  $opt('spsShowXrefs')?.addEventListener('change', () => {
    // Toggling off drops any shot emphasis; on triggers a lazy first fetch via refreshSps.
    if (!spsShowXrefs()) highlightedShot = null;
    void refreshSps();
  });
  // Fold/coverage: toggling on triggers a lazy first fetch via refreshSps.
  $opt('spsShowFold')?.addEventListener('change', () => void refreshSps());
  // Bin grid (P6/11 QC overlay): toggling on triggers the lazy bin-grid fetch and
  // redraw; toggling off must tear the Leaflet layer down immediately (refreshSps's
  // updateMap only rebuilds it when the toggle is on) and repaint the canvas.
  $opt('spsShowBinGrid')?.addEventListener('change', () => {
    if (!spsShowBinGrid() && leafletMap && binGridLayer) { leafletMap.removeLayer(binGridLayer); binGridLayer = null; }
    void refreshSps();
  });
  // Bin-size change invalidates the cached fold grid; refetch only if it's on.
  $opt('spsBinSize')?.addEventListener('change', () => {
    spsFold = null; spsFoldBin = 0;
    if (spsShowFold()) void refreshSps();
  });
  $('viewGrid').addEventListener('click', () => setView('grid'));
  $('viewMap').addEventListener('click', () => setView('map'));
  // Map rotation (real-map view only): slider + numeric box drive the bearing,
  // the reset button snaps back to North (0°). All paths go through
  // setMapBearing, which guards NaN/range and keeps map + UI in sync.
  $opt('spsRotate')?.addEventListener('input', (e) => setMapBearing(parseFloat((e.target as HTMLInputElement).value)));
  $opt('spsRotateNum')?.addEventListener('input', (e) => setMapBearing(parseFloat((e.target as HTMLInputElement).value)));
  $opt('spsRotateReset')?.addEventListener('click', () => setMapBearing(0));
  syncBearingUI();
  setRotateCtlEnabled(!!spsSummary); // enabled once a survey is loaded (either view)
  gridInteractions();
  $opt('spsInspClose')?.addEventListener('click', clearInspector);
  $('spsQcBtn').addEventListener('click', () => void runQC());
  $opt('spsGeomChkBtn')?.addEventListener('click', () => void runGeomCheck());
  $opt('spsGeomLoadBtn')?.addEventListener('click', () => void runGeomLoad());
  $opt('spsDeltaBtn')?.addEventListener('click', () => void runSpsDelta());
  // Geometry QC tab - its own Open file / Open SPS / Clear, operating on the
  // SHARED file + survey via the app's existing open flows (no new IPC). Each
  // refreshes the "Loaded:" readout afterwards; Clear reuses the per-tab dispatch.
  $opt('geomqcOpenFileBtn')?.addEventListener('click', () => void (async () => { await onOpen(); updateGeomqcReadout(); })());
  $opt('geomqcOpenSpsBtn')?.addEventListener('click', () => void (async () => { await loadSPS(); updateGeomqcReadout(); })());
  $opt('geomqcClearBtn')?.addEventListener('click', () => clearActiveTab());
  // Both CRS controls are searches over the FULL offline EPSG registry rather
  // than fixed <select> lists - a dropdown of ~7 000 entries is unusable, and the
  // old built-in list of ~135 could not offer most of the world's grids.
  initCrsPicker('epsgSearch', 'epsgResults', 'epsgPicked', 'No target CRS chosen yet.');
  initCrsPicker('shpCrsSearch', 'shpCrsResults', 'shpCrsPicked', "Native: the survey's own coordinates, with a .prj describing them.");
  $opt('spsExpShpBtn')?.addEventListener('click', () => void exportShapefile());
  $('spsExportBtn').addEventListener('click', () => void exportReprojected());
  $('spsExpKmlBtn').addEventListener('click', () => void exportSPS('kml'));
  $('spsExpGeojsonBtn').addEventListener('click', () => void exportSPS('geojson'));
  $('spsExpCsvBtn').addEventListener('click', () => void exportSPS('csv'));
  // P1/11, coord-CSV and SEG-P1 have no button of their own - they are written
  // by the "Export as" picker below, which reaches the same exportSPS(kind).
  $opt('spsExpFormatBtn')?.addEventListener('click', () => {
    const f = (($opt('spsExpFormat') as HTMLSelectElement | null)?.value || 'sps') as 'sps' | 'segp1' | 'p111' | 'coordcsv';
    void exportSPS(f, 'spsExpFmtStatus');
  });
  $('spsExpQcBtn').addEventListener('click', () => void exportSPS('qcreport'));
  initGeotiffWizard();      // GeoTIFF export wizard (area / resolution / layers)
  initSpsHeaders();         // SPS Header Viewer / Editor modal wiring
  initSpsRenumber();        // SPS Re-create / Renumber modal wiring
  initSpsCreate();          // SPS Creation tab + Generate wizard wiring
  $('velComputeBtn').addEventListener('click', () => void computeVelocity());
  $('velExportBtn').addEventListener('click', () => void exportPicks());
  ($('velCanvas') as HTMLCanvasElement).addEventListener('click', onVelClick);
  velInteractions();        // Velocity: wheel-zoom + zoom buttons + manual X/Y boxes
  initSpectrum();           // Spectrum tab: display selector + per-display controls
  workbenchInteractions(); // Trace Workbench: add/remove/clear + shared zoom/pan
  initObsLog();             // Observer Log: wizard + editable grid wiring
  // OS-aware key hints (replaces the hard-coded ⌘ glyphs everywhere).
  applyKeyHints();

  // Global keyboard shortcuts.
  document.addEventListener('keydown', onKeyDown);

  // Ctrl/Cmd + mouse-wheel zooms the whole UI (browser-style). Non-passive so we
  // can preventDefault and stop the page from scrolling while pinch-zooming.
  window.addEventListener('wheel', (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (e.deltaY !== 0) zoomBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // Tidy the progress subscription on teardown.
  window.addEventListener('beforeunload', () => { convProgressOff?.(); workerProgOff?.(); });

  // Paint the empty File-summary / Header-QC / status-strip placeholders.
  clearSummaryPanel();
  renderHeaderQc();
  updateStatusStrip();
  updateFileNav();
  setConvMode('single');
  refreshWizard();
  switchTab('conv');
}

/** App-wide keyboard shortcuts. */
function onKeyDown(e: KeyboardEvent) {
  // Esc closes whichever overlay is open (confirm dialog is the most modal, then
  // the audit modal / SPS header editor / manual; finally it dismisses the undo toast).
  if (e.key === 'Escape' && confirmOpen()) { closeConfirm(false); return; }
  // The value prompt is as modal as the confirm dialog - Esc cancels it.
  if (e.key === 'Escape' && $opt('promptBack')?.classList.contains('open')) { closePrompt(null); return; }
  // The box-zoom viewer + the magnifier select modes are dismissed by Esc too.
  if (e.key === 'Escape' && zoomViewerOpen()) { closeZoom(); return; }
  if (e.key === 'Escape' && (secBoxMode || traceBoxMode)) { exitBoxModes(); return; }
  // Abandoning a station drag has to restore map dragging, so it is handled before
  // any modal branch can swallow the key.
  if (e.key === 'Escape' && planDragArmed) { planDragFinish(); return; }
  if (e.key === 'Escape' && planImportOpen()) { closePlanImport(); return; }
  if (e.key === 'Escape' && auditOpen()) { closeAudit(); return; }
  if (e.key === 'Escape' && spsHeadersOpen()) { closeSpsHeaders(); return; }
  if (e.key === 'Escape' && spsRenumberOpen()) { closeSpsRenumber(); return; }
  if (e.key === 'Escape' && spsWizardOpen()) { closeCreateWizard(); return; }
  // The GeoTIFF wizard covers the icon rail, so without an Esc branch the user was
  // trapped in it (only its own ✕ / Cancel got out). Same for the three Observer Log
  // dialogs - the Help promises "Esc closes any dialog", so every modal honours it.
  if (e.key === 'Escape' && $opt('geotiffBack')?.classList.contains('open')) { closeGeotiffWizard(); return; }
  if (e.key === 'Escape' && $opt('ologColMgrBack')?.classList.contains('open')) { closeColumnsManager(); return; }
  if (e.key === 'Escape' && $opt('ologRenumBack')?.classList.contains('open')) { closeRenumberModal(); return; }
  if (e.key === 'Escape' && $opt('otwCfgBack')?.classList.contains('open')) { closeTrigCfgModal(); return; }
  if (e.key === 'Escape' && $opt('otwCatchBack')?.classList.contains('open')) { closeTrigCatchup(); return; }
  if (e.key === 'Escape' && manualOpen()) { closeManual(); return; }
  if (e.key === 'Escape' && feedbackOpen()) { closeFeedback(); return; }
  if (e.key === 'Escape' && $opt('undoToast')?.classList.contains('show')) { hideUndoToast(); return; }
  // App-wide UI zoom (browser-style): Ctrl/Cmd + '='/'+' in, Ctrl/Cmd + '-' out,
  // Ctrl/Cmd + '0' reset. Handled before the typing-in-a-field guard so it works
  // with any element focused, just like a browser.
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(1); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(-1); return; }
    if (e.key === '0') { e.preventDefault(); zoomReset(); return; }
  }
  // Ignore when typing in a field.
  const tgt = e.target as HTMLElement | null;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
  const mod = e.ctrlKey || e.metaKey;
  // '?' opens the manual (Shift+/ on most layouts).
  if (!mod && (e.key === '?' )) { e.preventDefault(); manualOpen() ? closeManual() : openManual(); return; }
  if (mod && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); void onOpen(); return; }
  if (mod && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); switchTab('conv'); setConvMode('batch'); return; }
  // Ctrl/Cmd+Z steps back through the survey plan's own history, on its tab only.
  if (mod && (e.key === 'z' || e.key === 'Z') && activeTab === 'spscreate') { e.preventDefault(); planUndo(); return; }
  // '[' / ']' step to the previous / next seismic file in the open file's folder.
  if (!mod && e.key === '[') { e.preventDefault(); void navFile(-1); return; }
  if (!mod && e.key === ']') { e.preventDefault(); void navFile(1); return; }
  if (!mod && e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key, 10) - 1;
    if (idx >= 0 && idx < TAB_DIGITS) { e.preventDefault(); switchTab(TABS[idx]); }
    return;
  }
  // Bare 'O' - the Observer Log, which has no digit since the digits follow the
  // rail. Reached only past the typing guard above, so an observer typing a note
  // with an 'o' in it stays in the field instead of teleporting between tabs.
  if (!mod && e.key.toUpperCase() === KEY_OBSLOG) { e.preventDefault(); switchTab(KEY_OBSLOG_TAB); return; }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
