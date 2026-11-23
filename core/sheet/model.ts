// seisconv-core / sheet - the Parameters Sheet model, derived values and checks.
//
// One planned seismic job: the values a planner sets before the crew goes out.
// "Dry" values only - typed or derived, never measured. Numbers are held as
// numbers (null = not given) and units live in the field definition, never inside
// the value text, so "2.5 m" typed as text cannot happen.
//
// validateStep(step, model) returns {errors, warnings} for one wizard step; the
// cross-step checks (Nyquist, record length vs sweep, stations vs channels, typed
// totals vs derived, MASW array vs target depth, SH vs phone type) run from
// crossChecks() and again on the Review step.
//
// Pure: no DOM / Electron. Every number is finite-checked before it is used.

import { sourceKind, isHorizontalPhone, type SurveyGeometry } from './lists';
import { presetFor, isMaswJob, isShJob } from './presets';
import type { SheetLogo } from './logo';

/** Hard caps - a model can never hold more than this (drafts are clamped too). */
export const PS_MAX_LINES = 200;
export const PS_MAX_POINTS = 2000;
export const PS_MAX_TEXT = 200;
export const PS_MAX_NOTE = 1000;

export interface PsLine {
  name: string;
  /** Planned length, metres (for a borehole: depth). */
  lengthM: number | null;
}

/** One point of the coordinate list. For a geographic CRS x = longitude and
 *  y = latitude (degrees); otherwise x = Easting, y = Northing in the CRS unit. */
export interface PsPoint {
  id: string;
  x: number;
  y: number;
  /** Optional group (line name) the point belongs to. */
  group?: string;
}

export interface ParamSheet {
  v: 1;
  /** Optional company logo (title band of the sheet, map title block). */
  logo: SheetLogo | null;
  job: {
    jobType: string;
    geometry: SurveyGeometry;
    client: string;
    prospect: string;
    jobNumber: string;
    contractor: string;
    crew: string;
    manager: string;
    observer: string;
    /** ISO dates (YYYY-MM-DD) or ''. */
    startDate: string;
    endDate: string;
    targetDepthM: number | null;
    preparedBy: string;
    revision: string;
    notes: string;
  };
  geom: {
    rxIntervalM: number | null;
    sxIntervalM: number | null;
    /** Common line length, metres: the default for a new line. */
    lineLengthM: number | null;
    spreadType: string;
    spread: string;
    activeChannels: number | null;
    lines: PsLine[];
    /** Off-end distance of the source from the first live station, metres. */
    sourceOffsetM: number | null;
    highFlagLive: number | null;
    lowFlagLive: number | null;
    receiverTable: string;
    receiverArray: string;
    // -- 3D only --
    rliM: number | null;
    sliM: number | null;
    rxLines: number | null;
    sxLines: number | null;
    patchLines: number | null;
    patchChannelsPerLine: number | null;
    azimuthDeg: number | null;
  };
  source: {
    type: string;
    trigger: string;
    energy: string;
    manufacturer: string;
    model: string;
    /** Unit weight (kg) for surface sources, or peak force (kN) for vibrators. */
    unitWeight: number | null;
    unitWeightUnit: 'kg' | 'kN' | 't';
    waveType: string;
    plate: string;
    stack: number | null;
    array: string;
    sweepStartHz: number | null;
    sweepEndHz: number | null;
    sweepLengthS: number | null;
    sweepTaperS: number | null;
    sweepType: string;
    fleetSize: number | null;
    /** Impulsive sources: generic size, depth, pattern, count per point. */
    impSize: string;
    impDepthM: number | null;
    impPattern: string;
    impCount: number | null;
    comments: string;
  };
  receiver: {
    manufacturer: string;
    model: string;
    naturalFreqHz: number | null;
    geophoneType: string;
    phonesPerStation: number | null;
    comments: string;
  };
  recording: {
    instrumentMfr: string;
    instrumentModel: string;
    sampleRateMs: number | null;
    recordLengthS: number | null;
    lowCutHz: number | null;
    highCutHz: number | null;
    highCutAntiAlias: boolean;
    notchHz: number | null;
    preampGainDb: number | null;
    aux: [string, string, string, string];
    dataFormat: string;
    correlation: string;
    coordSystem: string;
  };
  totals: {
    totalShots: number | null;
    totalFiles: number | null;
    weather: string;
  };
  coords: {
    /** "No area yet": skip the coordinates step. */
    skip: boolean;
    /** Confirmed CRS of the points ('' = local grid / not chosen). */
    crsCode: string;
    crsName: string;
    /** True once the user confirmed the detected layout + CRS. */
    confirmed: boolean;
    points: PsPoint[];
    /** Basemap key for the map ('' = no basemap). */
    basemap: string;
  };
}

/** A fresh, empty model. Dates stay empty: the core never reads the clock. */
export function emptySheet(): ParamSheet {
  return {
    v: 1,
    logo: null,
    job: {
      jobType: '', geometry: '2D', client: '', prospect: '', jobNumber: '', contractor: '', crew: '',
      manager: '', observer: '', startDate: '', endDate: '', targetDepthM: null, preparedBy: '', revision: '', notes: '',
    },
    geom: {
      rxIntervalM: null, sxIntervalM: null, lineLengthM: null, spreadType: '', spread: '', activeChannels: null,
      lines: [], sourceOffsetM: null, highFlagLive: null, lowFlagLive: null, receiverTable: '', receiverArray: '',
      rliM: null, sliM: null, rxLines: null, sxLines: null, patchLines: null, patchChannelsPerLine: null, azimuthDeg: null,
    },
    source: {
      type: '', trigger: '', energy: '', manufacturer: '', model: '', unitWeight: null, unitWeightUnit: 'kg', waveType: '',
      plate: '', stack: null, array: '', sweepStartHz: null, sweepEndHz: null, sweepLengthS: null, sweepTaperS: null,
      sweepType: '', fleetSize: null, impSize: '', impDepthM: null, impPattern: '', impCount: null, comments: '',
    },
    receiver: { manufacturer: '', model: '', naturalFreqHz: null, geophoneType: '', phonesPerStation: null, comments: '' },
    recording: {
      instrumentMfr: '', instrumentModel: '', sampleRateMs: null, recordLengthS: null, lowCutHz: null, highCutHz: null,
      highCutAntiAlias: false, notchHz: null, preampGainDb: null, aux: ['', '', '', ''], dataFormat: '',
      correlation: '', coordSystem: '',
    },
    totals: { totalShots: null, totalFiles: null, weather: '' },
    coords: { skip: false, crsCode: '', crsName: '', confirmed: false, points: [], basemap: 'satellite' },
  };
}

/** Fill the job-type presets into a model (returns a new model). Values the
 *  preset does not cover are left as they are. */
export function applyPreset(m: ParamSheet, jobType: string): ParamSheet {
  const p = presetFor(jobType);
  const out: ParamSheet = JSON.parse(JSON.stringify(m));
  out.job.jobType = jobType;
  if (!p) return out;
  out.job.geometry = p.geometry;
  out.geom.rxIntervalM = p.rxIntervalM;
  out.geom.sxIntervalM = p.sxIntervalM;
  out.geom.sourceOffsetM = p.sourceOffsetM;
  out.geom.spreadType = p.spreadType;
  out.geom.activeChannels = p.channels;
  out.source.waveType = p.waveType;
  out.source.type = p.sourceType;
  out.source.stack = p.stack;
  out.receiver.naturalFreqHz = p.geophoneFreqHz;
  out.receiver.geophoneType = p.geophoneType;
  out.recording.sampleRateMs = p.sampleRateMs;
  out.recording.recordLengthS = p.recordLengthS;
  out.recording.lowCutHz = p.lowCutHz;
  out.recording.correlation = sourceKind(p.sourceType) === 'vibrator' ? 'Yes' : 'N/A';
  if (p.sweep) {
    out.source.sweepStartHz = p.sweep.startHz;
    out.source.sweepEndHz = p.sweep.endHz;
    out.source.sweepLengthS = p.sweep.lengthS;
    out.source.sweepTaperS = p.sweep.taperS;
    out.source.sweepType = p.sweep.type;
    out.source.unitWeightUnit = 'kN';
  } else {
    out.source.unitWeightUnit = 'kg';
  }
  return out;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pos = (v: unknown): v is number => fin(v) && v > 0;

// -- derived values -------------------------------------------------------------

export interface LineDerived {
  name: string;
  lengthM: number | null;
  stations: number | null;
  shots: number | null;
}

export interface Derived {
  lineCount: number;
  totalLengthM: number | null;
  lines: LineDerived[];
  /** Stations on the longest line. */
  maxStations: number | null;
  shots: number | null;
  /** Records the plan implies: shots x polarities (2 for SH work, else 1). */
  files: number | null;
  polarities: number;
  /** 2D nominal fold = channels x RI / (2 x SI). */
  fold2d: number | null;
  /** Spread length = (channels - 1) x RI (the live array length). */
  spreadLengthM: number | null;
  nyquistHz: number | null;
  samplesPerTrace: number | null;
  // -- 3D --
  binInlineM: number | null;
  binCrosslineM: number | null;
  fold3dInline: number | null;
  fold3dCrossline: number | null;
  fold3d: number | null;
  channels3d: number | null;
}

/** Number of points at `interval` along `length` including both ends. */
export function pointsAlong(lengthM: number | null, intervalM: number | null): number | null {
  if (!fin(lengthM) || !pos(intervalM) || lengthM < 0) return null;
  const n = Math.floor(lengthM / intervalM + 1e-9) + 1;
  return n > 0 && n < 1e9 ? n : null;
}

/** All derived (nominal, planned) values for a model. */
export function deriveSheet(m: ParamSheet): Derived {
  const g = m.geom;
  const isSh = isShJob(m.job.jobType, m.source.waveType);
  const polarities = isSh ? 2 : 1;
  const lines: LineDerived[] = g.lines.map((l) => ({
    name: l.name,
    lengthM: fin(l.lengthM) ? l.lengthM : null,
    stations: pointsAlong(l.lengthM, g.rxIntervalM),
    shots: pointsAlong(l.lengthM, g.sxIntervalM),
  }));
  let total: number | null = null;
  for (const l of lines) if (l.lengthM != null) total = (total ?? 0) + l.lengthM;
  let maxStations: number | null = null;
  for (const l of lines) if (l.stations != null) maxStations = Math.max(maxStations ?? 0, l.stations);
  let shots: number | null = null;
  if (lines.length && lines.every((l) => l.shots != null)) shots = lines.reduce((s, l) => s + (l.shots as number), 0);
  const files = shots != null ? shots * polarities : null;
  const ch = g.activeChannels;
  const fold2d = pos(ch) && pos(g.rxIntervalM) && pos(g.sxIntervalM) ? (ch * g.rxIntervalM) / (2 * g.sxIntervalM) : null;
  const spreadLengthM = pos(ch) && pos(g.rxIntervalM) ? (ch - 1) * g.rxIntervalM : null;
  const sr = m.recording.sampleRateMs;
  const nyquistHz = pos(sr) ? 500 / sr : null;
  const rl = m.recording.recordLengthS;
  const samplesPerTrace = pos(sr) && pos(rl) ? Math.floor((rl * 1000) / sr + 1e-9) + 1 : null;

  // 3D orthogonal, the classic nominal values: bin = RI/2 x SI/2, inline fold =
  // (channels per patch line x RI) / (2 x SLI), crossline fold = patch lines / 2,
  // total fold = inline x crossline.
  let binInlineM: number | null = null, binCrosslineM: number | null = null;
  let fold3dInline: number | null = null, fold3dCrossline: number | null = null, fold3d: number | null = null;
  let channels3d: number | null = null;
  if (m.job.geometry === '3D') {
    if (pos(g.rxIntervalM)) binInlineM = g.rxIntervalM / 2;
    if (pos(g.sxIntervalM)) binCrosslineM = g.sxIntervalM / 2;
    if (pos(g.patchChannelsPerLine) && pos(g.rxIntervalM) && pos(g.sliM)) fold3dInline = (g.patchChannelsPerLine * g.rxIntervalM) / (2 * g.sliM);
    if (pos(g.patchLines)) fold3dCrossline = g.patchLines / 2;
    if (fold3dInline != null && fold3dCrossline != null) fold3d = fold3dInline * fold3dCrossline;
    if (pos(g.patchLines) && pos(g.patchChannelsPerLine)) channels3d = g.patchLines * g.patchChannelsPerLine;
  }
  return {
    lineCount: lines.length, totalLengthM: total, lines, maxStations, shots, files, polarities,
    fold2d, spreadLengthM, nyquistHz, samplesPerTrace,
    binInlineM, binCrosslineM, fold3dInline, fold3dCrossline, fold3d, channels3d,
  };
}

// -- hints ----------------------------------------------------------------------
//
// Nothing in a parameter sheet is mandatory: the planner fills in whatever they
// want and it is exported as it stands. The checks below therefore only produce
// HINTS (StepCheck.warnings); `errors` is always empty and kept only so callers
// have one shape. A hint is a likely mistake (Nyquist, typed vs derived totals,
// MASW depth, SH phones, an end date before the start), never "field required".

export interface Issue {
  /** Model field path the issue is about (for outlining the input), or ''. */
  field: string;
  msg: string;
}
export interface StepCheck {
  errors: Issue[];
  warnings: Issue[];
}

/** Wizard steps, in order. */
export const PS_STEPS = ['job', 'geometry', 'source', 'receiver', 'recording', 'totals', 'coords', 'review'] as const;
export type PsStep = (typeof PS_STEPS)[number];
export const PS_STEP_TITLES: Record<PsStep, string> = {
  job: 'Job',
  geometry: 'Geometry',
  source: 'Source',
  receiver: 'Receiver',
  recording: 'Recording',
  totals: 'Totals and conditions',
  coords: 'Coordinates',
  review: 'Review and export',
};

/** True when the user filled at least one field of a step (the wizard's green
 *  "done" circle). Form defaults the user never chose (survey geometry 2D, the
 *  weight unit, the basemap, an unticked box) do not count; Coordinates counts
 *  only a confirmed point list or the "No area yet" skip. Review has no fields. */
export function stepFilled(m: ParamSheet, s: PsStep): boolean {
  const has = (v: unknown): boolean => {
    if (v == null || v === false) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (typeof v === 'number') return Number.isFinite(v);
    if (Array.isArray(v)) return v.some(has);
    if (typeof v === 'object') return Object.values(v as Record<string, unknown>).some(has);
    return true;
  };
  const anyBut = (o: Record<string, unknown>, skip: string[]) => Object.keys(o).some((k) => !skip.includes(k) && has(o[k]));
  switch (s) {
    case 'job': return !!m.logo || m.job.geometry !== '2D' || anyBut(m.job, ['geometry']);
    case 'geometry': return anyBut(m.geom, []);
    case 'source': return anyBut(m.source, ['unitWeightUnit']);
    case 'receiver': return anyBut(m.receiver, []);
    case 'recording': return anyBut(m.recording, []);
    case 'totals': return anyBut(m.totals, []);
    case 'coords': return m.coords.skip || (m.coords.confirmed && m.coords.points.length > 0);
    case 'review': return false;
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** True for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(s: string): boolean {
  const mm = ISO_DATE.exec(s || '');
  if (!mm) return false;
  const y = +mm[1], mo = +mm[2], d = +mm[3];
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= dim;
}

/** Check an optional number against [min, max]; integer when `int`. */
function num(out: Issue[], field: string, label: string, v: number | null, min: number, max: number, int = false, _optional = false): void {
  if (v == null) return;
  if (!fin(v)) { out.push({ field, msg: `${label} must be a number.` }); return; }
  if (int && !Number.isInteger(v)) { out.push({ field, msg: `${label} must be a whole number.` }); return; }
  if (v < min || v > max) out.push({ field, msg: `${label} must be between ${min} and ${max}.` });
}

function text(out: Issue[], field: string, label: string, v: string, max: number, _optional = false): void {
  if ((v || '').length > max) out.push({ field, msg: `${label} is longer than ${max} characters.` });
}

/** Per-step checks. Errors block Next; warnings are shown but do not block. */
export function validateStep(step: PsStep, m: ParamSheet): StepCheck {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const j = m.job, g = m.geom, s = m.source, r = m.receiver, rec = m.recording, t = m.totals;
  switch (step) {
    case 'job': {
      text(errors, 'job.jobType', 'Job type', j.jobType, PS_MAX_TEXT, true);
      for (const [k, label] of [['client', 'Client'], ['prospect', 'Prospect'], ['jobNumber', 'Job number'], ['contractor', 'Contractor'], ['crew', 'Crew'], ['manager', 'Manager'], ['observer', 'Observer'], ['preparedBy', 'Prepared by'], ['revision', 'Revision']] as const) {
        text(errors, `job.${k}`, label, j[k], PS_MAX_TEXT);
      }
      text(errors, 'job.notes', 'Notes', j.notes, PS_MAX_NOTE);
      if (j.startDate && !isIsoDate(j.startDate)) errors.push({ field: 'job.startDate', msg: 'Start date is not a valid date.' });
      if (j.endDate && !isIsoDate(j.endDate)) errors.push({ field: 'job.endDate', msg: 'End date is not a valid date.' });
      if (isIsoDate(j.startDate) && isIsoDate(j.endDate) && j.endDate < j.startDate) errors.push({ field: 'job.endDate', msg: 'End date is before the start date.' });
      num(errors, 'job.targetDepthM', 'Target depth', j.targetDepthM, 0.1, 20000);
      break;
    }
    case 'geometry': {
      const needIntervals = j.geometry === '2D' || j.geometry === '3D';
      num(errors, 'geom.rxIntervalM', 'Receiver point interval', g.rxIntervalM, 0.1, 10000, false, needIntervals);
      num(errors, 'geom.sxIntervalM', 'Source point interval', g.sxIntervalM, 0.1, 10000);
      num(errors, 'geom.lineLengthM', 'Line length', g.lineLengthM, 0.1, 1e6);
      num(errors, 'geom.activeChannels', 'Active channels', g.activeChannels, 1, 100000, true);
      num(errors, 'geom.sourceOffsetM', 'Source offset', g.sourceOffsetM, 0, 100000);
      num(errors, 'geom.highFlagLive', 'High flag live', g.highFlagLive, 1, 100000, true);
      num(errors, 'geom.lowFlagLive', 'Low flag live', g.lowFlagLive, 1, 100000, true);
      if (fin(g.highFlagLive) && fin(g.lowFlagLive) && g.lowFlagLive < g.highFlagLive) {
        warnings.push({ field: 'geom.lowFlagLive', msg: 'Low flag live is below high flag live.' });
      }
      text(errors, 'geom.spreadType', 'Spread type', g.spreadType, PS_MAX_TEXT);
      text(errors, 'geom.receiverTable', 'Receiver table', g.receiverTable, PS_MAX_TEXT);
      if (g.lines.length > PS_MAX_LINES) errors.push({ field: 'geom.lines', msg: `At most ${PS_MAX_LINES} lines.` });
      const seen = new Set<string>();
      g.lines.forEach((l, i) => {
        const nm = (l.name || '').trim();
        if (!nm) errors.push({ field: `geom.lines.${i}.name`, msg: `Line ${i + 1} has no name.` });
        else if (seen.has(nm.toLowerCase())) errors.push({ field: `geom.lines.${i}.name`, msg: `Line name "${nm}" is used twice.` });
        seen.add(nm.toLowerCase());
        if (nm.length > PS_MAX_TEXT) errors.push({ field: `geom.lines.${i}.name`, msg: `Line ${i + 1} name is too long.` });
        num(errors, `geom.lines.${i}.lengthM`, `Length of line ${nm || i + 1}`, l.lengthM, 0.1, 1e6, false, needIntervals);
      });
      if (j.geometry === '3D') {
        num(errors, 'geom.rliM', 'Receiver line interval', g.rliM, 0.1, 10000, false, true);
        num(errors, 'geom.sliM', 'Source line interval', g.sliM, 0.1, 10000, false, true);
        num(errors, 'geom.rxLines', 'Number of receiver lines', g.rxLines, 1, 100000, true);
        num(errors, 'geom.sxLines', 'Number of source lines', g.sxLines, 1, 100000, true);
        num(errors, 'geom.patchLines', 'Patch: active lines', g.patchLines, 1, 10000, true, true);
        num(errors, 'geom.patchChannelsPerLine', 'Patch: channels per line', g.patchChannelsPerLine, 1, 20000, true, true);
        num(errors, 'geom.azimuthDeg', 'Receiver line azimuth', g.azimuthDeg, 0, 360);
        if (pos(g.rliM) && pos(g.sxIntervalM) && Math.abs(g.rliM / g.sxIntervalM - Math.round(g.rliM / g.sxIntervalM)) > 1e-6) {
          warnings.push({ field: 'geom.rliM', msg: 'Receiver line interval is not a whole multiple of the source point interval.' });
        }
        if (pos(g.sliM) && pos(g.rxIntervalM) && Math.abs(g.sliM / g.rxIntervalM - Math.round(g.sliM / g.rxIntervalM)) > 1e-6) {
          warnings.push({ field: 'geom.sliM', msg: 'Source line interval is not a whole multiple of the receiver point interval.' });
        }
        const d = deriveSheet(m);
        if (d.fold3d != null && d.fold3d < 1) errors.push({ field: 'geom.patchLines', msg: `Nominal fold is ${d.fold3d.toFixed(2)}, below 1: the patch is too small for the line intervals.` });
      }
      if (j.geometry === '2D') {
        const d = deriveSheet(m);
        if (d.fold2d != null && d.fold2d < 1 && !isMaswJob(j.jobType)) warnings.push({ field: 'geom.sxIntervalM', msg: `Nominal fold is ${d.fold2d.toFixed(2)}, below 1.` });
      }
      break;
    }
    case 'source': {
      text(errors, 'source.type', 'Source type', s.type, PS_MAX_TEXT);
      for (const [k, label] of [['trigger', 'Trigger system'], ['energy', 'Energy source'], ['manufacturer', 'Manufacturer'], ['model', 'Model'], ['waveType', 'Source wave type'], ['plate', 'Plate type'], ['array', 'Source array'], ['sweepType', 'Sweep type'], ['impSize', 'Size'], ['impPattern', 'Pattern']] as const) {
        text(errors, `source.${k}`, label, s[k], PS_MAX_TEXT);
      }
      text(errors, 'source.comments', 'Comments', s.comments, PS_MAX_NOTE);
      num(errors, 'source.unitWeight', 'Unit weight / force', s.unitWeight, 0, 1e6);
      num(errors, 'source.stack', 'Stack', s.stack, 1, 1000, true);
      const kind = sourceKind(s.type);
      if (kind === 'vibrator') {
        num(errors, 'source.sweepStartHz', 'Sweep start frequency', s.sweepStartHz, 0.1, 1000);
        num(errors, 'source.sweepEndHz', 'Sweep end frequency', s.sweepEndHz, 0.1, 1000);
        num(errors, 'source.sweepLengthS', 'Sweep length', s.sweepLengthS, 0.1, 120);
        num(errors, 'source.sweepTaperS', 'Sweep taper', s.sweepTaperS, 0, 60);
        num(errors, 'source.fleetSize', 'Fleet size', s.fleetSize, 1, 100, true);
        if (pos(s.sweepTaperS) && pos(s.sweepLengthS) && 2 * s.sweepTaperS > s.sweepLengthS) {
          errors.push({ field: 'source.sweepTaperS', msg: 'The two tapers are longer than the sweep.' });
        }
      }
      if (kind === 'impulsive') {
        num(errors, 'source.impDepthM', 'Depth', s.impDepthM, 0, 1000);
        num(errors, 'source.impCount', 'Count per point', s.impCount, 1, 1000, true);
      }
      break;
    }
    case 'receiver': {
      text(errors, 'receiver.manufacturer', 'Manufacturer', r.manufacturer, PS_MAX_TEXT);
      text(errors, 'receiver.model', 'Model', r.model, PS_MAX_TEXT);
      text(errors, 'receiver.geophoneType', 'Geophone type', r.geophoneType, PS_MAX_TEXT);
      text(errors, 'receiver.comments', 'Comments', r.comments, PS_MAX_NOTE);
      num(errors, 'receiver.naturalFreqHz', 'Natural frequency', r.naturalFreqHz, 0.01, 999.99);
      num(errors, 'receiver.phonesPerStation', 'Phones per station', r.phonesPerStation, 1, 1000, true);
      break;
    }
    case 'recording': {
      text(errors, 'recording.instrumentMfr', 'Instrument manufacturer', rec.instrumentMfr, PS_MAX_TEXT);
      text(errors, 'recording.instrumentModel', 'Instrument model', rec.instrumentModel, PS_MAX_TEXT);
      num(errors, 'recording.sampleRateMs', 'Sample rate', rec.sampleRateMs, 0.01, 100, false, true);
      num(errors, 'recording.recordLengthS', 'Record length', rec.recordLengthS, 0.01, 86400, false, true);
      num(errors, 'recording.lowCutHz', 'Low cut', rec.lowCutHz, 0.01, 10000);
      num(errors, 'recording.highCutHz', 'High cut', rec.highCutHz, 0.01, 100000);
      num(errors, 'recording.notchHz', 'Notch filter', rec.notchHz, 1, 1000);
      num(errors, 'recording.preampGainDb', 'Pre-amp gain', rec.preampGainDb, -20, 120);
      rec.aux.forEach((a, i) => text(errors, `recording.aux.${i}`, `Aux trace ${i + 1}`, a, PS_MAX_TEXT));
      const d = deriveSheet(m);
      if (d.nyquistHz != null && fin(rec.highCutHz) && rec.highCutHz >= d.nyquistHz) {
        errors.push({ field: 'recording.highCutHz', msg: `High cut ${rec.highCutHz} Hz is at or above Nyquist (${fmtNum(d.nyquistHz)} Hz for ${rec.sampleRateMs} ms sampling).` });
      }
      if (fin(rec.lowCutHz) && fin(rec.highCutHz) && rec.lowCutHz >= rec.highCutHz) {
        errors.push({ field: 'recording.lowCutHz', msg: 'Low cut must be below the high cut.' });
      }
      if (d.samplesPerTrace != null && d.samplesPerTrace > 4_000_000) {
        errors.push({ field: 'recording.recordLengthS', msg: `Record length / sample rate gives ${d.samplesPerTrace} samples per trace - too many.` });
      }
      break;
    }
    case 'totals': {
      num(errors, 'totals.totalShots', 'Total shots', t.totalShots, 0, 1e7, true);
      num(errors, 'totals.totalFiles', 'Total files', t.totalFiles, 0, 1e8, true);
      text(errors, 'totals.weather', 'Weather / noise', t.weather, PS_MAX_TEXT);
      break;
    }
    case 'coords': {
      const c = m.coords;
      if (c.skip) break;
      if (c.points.length > PS_MAX_POINTS) errors.push({ field: 'coords.points', msg: `At most ${PS_MAX_POINTS} points.` });
      if (c.points.length && !c.confirmed) errors.push({ field: 'coords.crs', msg: 'The detected layout and coordinate system are not confirmed yet.' });
      if (c.points.some((p) => !fin(p.x) || !fin(p.y))) errors.push({ field: 'coords.points', msg: 'A point has a coordinate that is not a number.' });
      if (c.crsCode === 'EPSG:4326' && c.points.some((p) => Math.abs(p.y) > 90 || Math.abs(p.x) > 180)) {
        errors.push({ field: 'coords.points', msg: 'Latitude must be within +/-90 and longitude within +/-180.' });
      }
      break;
    }
    case 'review':
      break;
  }
  return { errors: [], warnings: errors.concat(warnings) };
}

/** Checks that need more than one step's values. Run on Recording, Totals and
 *  Review, and before export. */
export function crossChecks(m: ParamSheet): StepCheck {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const d = deriveSheet(m);
  const s = m.source, rec = m.recording, g = m.geom;
  const kind = sourceKind(s.type);
  if (kind === 'vibrator' && d.nyquistHz != null) {
    for (const [k, v] of [['sweepStartHz', s.sweepStartHz], ['sweepEndHz', s.sweepEndHz]] as const) {
      if (fin(v) && v >= d.nyquistHz) errors.push({ field: `source.${k}`, msg: `Sweep frequency ${v} Hz is at or above Nyquist (${fmtNum(d.nyquistHz)} Hz).` });
    }
  }
  // Correlated vibroseis: the uncorrelated record must hold sweep + listen time.
  if (kind === 'vibrator' && pos(s.sweepLengthS) && pos(rec.recordLengthS) && /^no$/i.test(rec.correlation)) {
    if (rec.recordLengthS <= s.sweepLengthS) errors.push({ field: 'recording.recordLengthS', msg: 'Uncorrelated record length must be longer than the sweep (sweep + listen time).' });
  }
  // Stations per line vs active channels.
  if (pos(g.activeChannels) && d.maxStations != null && (m.job.geometry === '2D')) {
    if (g.activeChannels > d.maxStations) {
      warnings.push({ field: 'geom.activeChannels', msg: `Active channels (${g.activeChannels}) exceed the stations on the longest line (${d.maxStations}).` });
    } else if (d.maxStations > g.activeChannels && !/roll/i.test(`${g.spread} ${g.spreadType}`)) {
      warnings.push({ field: 'geom.activeChannels', msg: `The longest line has ${d.maxStations} stations but only ${g.activeChannels} channels are live, and the spread is not roll-along.` });
    }
  }
  // Typed totals vs derived.
  const t = m.totals;
  if (fin(t.totalShots) && d.shots != null && t.totalShots !== d.shots) {
    warnings.push({ field: 'totals.totalShots', msg: `Total shots typed as ${t.totalShots}, but the lines and source interval give ${d.shots}.` });
  }
  if (fin(t.totalFiles) && d.files != null && t.totalFiles !== d.files) {
    warnings.push({ field: 'totals.totalFiles', msg: `Total files typed as ${t.totalFiles}, but the plan gives ${d.files}${d.polarities > 1 ? ' (two polarities per shot)' : ''}.` });
  }
  // MASW: the array must reach about 2x the target depth.
  if (isMaswJob(m.job.jobType) && pos(m.job.targetDepthM) && d.spreadLengthM != null && d.spreadLengthM < 2 * m.job.targetDepthM) {
    warnings.push({ field: 'geom.activeChannels', msg: `Array length ${fmtNum(d.spreadLengthM)} m is shorter than 2x the target depth (${fmtNum(2 * m.job.targetDepthM)} m).` });
  }
  // SH work needs horizontal phones.
  if (isShJob(m.job.jobType, s.waveType) && m.receiver.geophoneType && !isHorizontalPhone(m.receiver.geophoneType)) {
    warnings.push({ field: 'receiver.geophoneType', msg: `An SH job is planned with "${m.receiver.geophoneType}" phones; SH needs horizontal (or 3C) geophones.` });
  }
  // Geophone natural frequency above the sweep start rarely makes sense.
  if (kind === 'vibrator' && fin(m.receiver.naturalFreqHz) && fin(s.sweepStartHz) && m.receiver.naturalFreqHz > s.sweepStartHz * 2) {
    warnings.push({ field: 'receiver.naturalFreqHz', msg: 'Geophone natural frequency is well above the sweep start frequency.' });
  }
  return { errors: [], warnings: errors.concat(warnings) };
}

/** Short number text: up to 3 decimals, no trailing zeros. */
export function fmtNum(v: number | null | undefined, maxDec = 3): string {
  if (v == null || !Number.isFinite(v)) return '';
  const r = Number(v.toFixed(maxDec));
  return String(Object.is(r, -0) ? 0 : r);
}

/** Every hint for the whole sheet: each step's own plus the cross-step checks.
 *  Hints never block anything - the sheet is exported with whatever was filled. */
export function allHints(m: ParamSheet): Issue[] {
  const out: Issue[] = [];
  for (const s of PS_STEPS) out.push(...validateStep(s, m).warnings);
  out.push(...crossChecks(m).warnings);
  return out;
}
