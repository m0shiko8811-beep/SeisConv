// SeisConv renderer - the "Parameters Sheet" tab.
//
// A step-by-step wizard (the Converter's .wiz-step stepper) that collects one
// planned seismic job and exports ONE styled XLSX: Parameters, Area, Map (the
// area map as an embedded PNG) and About. All the rules live in core/sheet (pure,
// unit-tested); this file is the DOM around them.
//
// Kept out of app.ts on purpose: app.ts hands in the few helpers it owns (modals,
// toasts, progress, audit, the CRS picker, the IPC api) through `PsDeps`, so this
// tab adds no state to the shared file.
//
// NOTHING IS STORED (Moshe, 23.11.2026): the sheet starts empty on every launch.
// What was typed lives only in memory for the running session (switching tabs
// keeps it); no draft, no remembered client names, no logo is written to disk,
// and any draft an older build left in localStorage is deleted at startup.

import JSZip from 'jszip';
import { buildStyledXlsx } from '../../core/export/xlsx';
import {
  JOB_TYPES, SURVEY_GEOMETRIES, INTERVALS_M, SPREAD_TYPES, SPREADS, CHANNELS, SAMPLE_RATES_MS, RECORD_LENGTHS_S,
  LOW_CUTS_HZ, HIGH_CUTS_HZ, NOTCH_HZ, GAINS_DB, DATA_FORMATS, COORD_SYSTEMS, SOURCE_TYPES, TRIGGER_SYSTEMS,
  SOURCE_MANUFACTURERS, WAVE_TYPES, CORRELATION, STACKS, PLATES, MANUFACTURERS, modelsFor, PHONES_PER_STATION,
  GEOPHONE_FREQS_HZ, GEOPHONE_TYPES, AUX_CHANNELS, WEATHER, SWEEP_TYPES, sourceKind,
} from '../../core/sheet/lists';
import { presetFor, type JobPreset } from '../../core/sheet/presets';
import {
  emptySheet, applyPreset, deriveSheet, validateStep, crossChecks, allHints, fmtNum, stepFilled,
  PS_STEPS, PS_STEP_TITLES, PS_MAX_LINES, type ParamSheet, type PsStep, type Issue,
} from '../../core/sheet/model';
import { sniffCoords, crsGuessName, type SniffResult } from '../../core/sheet/coordsniff';
import { sanitizeLogo, fitInside } from '../../core/sheet/logo';
import { bytesToBase64 } from '../../core/base64';
import { buildSheetWorkbook, type AreaInfo, type AreaPoint, type MapInfo } from '../../core/sheet/layout';
import { fitMapGrid, toPx, niceStep, scaleBarMetres, ticks, fmtDistance, type MapGrid } from '../../core/sheet/mapframe';
import { ringArea, ringPerimeter, pathLength, convexHull, isClosed, type XY } from '../../core/gis/polygon';
import { coordLines, lineMismatch, linesFromCoords } from '../../core/sheet/reconcile';
import { buildConfig, parseConfig, describeConfig, CONFIG_EXT, type ConfigOptions } from '../../core/sheet/config';

export interface PsDeps {
  api: {
    paramSheetCoords(args: { code: string; points: [number, number][]; gridCode?: string }): Promise<{
      ok: boolean; error?: string; crsName?: string; geographic?: boolean; gridCode?: string; gridName?: string;
      latlon?: ([number, number] | null)[]; en?: ([number, number] | null)[];
    }>;
    paramSheetBasemap(args: { code: string; grid: MapGrid; source: string }): Promise<{
      ok: boolean; error?: string; rgb?: Uint8Array | null; attribution?: string; label?: string;
      tilesTotal?: number; tilesFailed?: number; tilesBlank?: number; notes?: string[];
    }>;
    exportBinary(name: string, bytes: Uint8Array): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
    openPlanText(opts?: { coords?: boolean }): Promise<{ name: string; text: string } | null>;
    paramSheetPickLogo(): Promise<{ ok: boolean; error?: string; data?: Uint8Array; format?: 'png' | 'jpeg'; w?: number; h?: number; name?: string } | null>;
    paramSheetOpenConfig(): Promise<{ ok: boolean; error?: string; text?: string; name?: string } | null>;
    exportText(name: string, text: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  };
  showProgress(label: string, onCancel?: () => void, delayMs?: number): void;
  hideProgress(): void;
  infoToast(message: string): void;
  /** In-app confirm; `okLabel` names the OK button (defaults to "Delete"). */
  confirm(message: string, okLabel?: string): Promise<boolean>;
  audit(action: string, detail: string, tab?: string): void;
  initCrsPicker(inputId: string, resultsId: string, pickedId: string, emptyLabel: string, onPick?: (code: string, name: string) => void): void;
  crsPickerSet(inputId: string, code: string, name: string): void;
  errMsg(e: unknown): string;
  version: string;
}

let D: PsDeps;
let M: ParamSheet = emptySheet();
let step: PsStep = 'job';
/** Detection result of the current coordinate text (not persisted). */
let sniff: SniffResult | null = null;
let coordText = '';
let coordFile = '';
/** Basemap RGB fetched for the review preview, keyed to the frame it was for. */
let previewBasemap: { key: string; rgb: Uint8Array | null; attribution: string; note: string } | null = null;
let mapToken = 0;

const $ = (id: string) => document.getElementById(id);
/** Keys an older build used to persist drafts / client names; removed at startup. */
const LEGACY_KEYS = ['seisconv.paramsheet', 'seisconv.paramsheet.clients'];
const MAP_W = 1600;
const MAP_H = 1130;
const MAP_PLOT = { left: 120, top: 128, right: 56, bottom: 108 };
const BASEMAPS: { value: string; label: string }[] = [
  { value: 'satellite', label: 'Satellite (Esri World Imagery)' },
  { value: 'streets', label: 'Streets (OpenStreetMap)' },
  { value: 'light', label: 'Light grey (Esri)' },
  { value: 'dark', label: 'Dark grey (Esri)' },
  { value: '', label: 'No basemap (works offline)' },
];

// -- model paths ------------------------------------------------------------------

type Leaf = string | number | boolean | null;
function getPath(path: string): Leaf {
  let o: unknown = M;
  for (const k of path.split('.')) {
    if (o == null || typeof o !== 'object') return null;
    o = (o as Record<string, unknown>)[k];
  }
  return (o ?? null) as Leaf;
}
function setPath(path: string, v: Leaf): void {
  const ks = path.split('.');
  let o: Record<string, unknown> = M as unknown as Record<string, unknown>;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] as Record<string, unknown>;
  o[ks[ks.length - 1]] = v;
}
const fieldId = (path: string) => `ps-${path.replace(/\./g, '-')}`;

// -- field specs --------------------------------------------------------------------

type Kind = 'text' | 'num' | 'int' | 'date' | 'select' | 'textarea' | 'check';
interface FSpec {
  path: string;
  label: string;
  kind: Kind;
  unit?: string;
  list?: () => readonly (string | number | null)[];
  options?: () => readonly { value: string; label: string }[];
  hint?: keyof JobPreset['hints'];
  show?: () => boolean;
  wide?: boolean;
  placeholder?: string;
  /** Re-render the form when this field changes (it drives other fields). */
  rerender?: boolean;
}

const is3D = () => M.job.geometry === '3D';
const kindNow = () => sourceKind(M.source.type);
/** Client names typed in THIS session (memory only, gone on restart). */
let sessionClients: string[] = [];
const clientsList = (): string[] => sessionClients;
function rememberClient(name: string): void {
  const n = (name || '').trim().slice(0, 80);
  if (!n) return;
  sessionClients = [n, ...sessionClients.filter((x) => x.toLowerCase() !== n.toLowerCase())].slice(0, 30);
}

const SPECS: Record<Exclude<PsStep, 'coords' | 'review'>, FSpec[]> = {
  job: [
    { path: 'job.jobType', label: 'Job type', kind: 'text', list: () => JOB_TYPES, rerender: true, placeholder: 'Choose or type a job type' },
    { path: 'job.geometry', label: 'Survey geometry', kind: 'select', options: () => SURVEY_GEOMETRIES, rerender: true },
    { path: 'job.targetDepthM', label: 'Target depth', kind: 'num', unit: 'm' },
    { path: 'job.client', label: 'Client', kind: 'text', list: clientsList },
    { path: 'job.contractor', label: 'Contractor', kind: 'text' },
    { path: 'job.manager', label: 'Manager', kind: 'text' },
    { path: 'job.prospect', label: 'Prospect', kind: 'text' },
    { path: 'job.crew', label: 'Crew #', kind: 'text' },
    { path: 'job.observer', label: 'Observer', kind: 'text' },
    { path: 'job.jobNumber', label: 'Job number', kind: 'text' },
    { path: 'job.startDate', label: 'Start date', kind: 'date' },
    { path: 'job.endDate', label: 'End date', kind: 'date' },
    { path: 'job.preparedBy', label: 'Prepared by', kind: 'text' },
    { path: 'job.revision', label: 'Revision', kind: 'text' },
    { path: 'job.notes', label: 'Notes', kind: 'textarea', wide: true },
  ],
  geometry: [
    { path: 'geom.rxIntervalM', label: 'Receiver point interval', kind: 'num', unit: 'm', list: () => INTERVALS_M, hint: 'rxInterval' },
    { path: 'geom.sxIntervalM', label: 'Source point interval', kind: 'num', unit: 'm', list: () => INTERVALS_M, hint: 'sxInterval' },
    { path: 'geom.lineLengthM', label: 'Line length (for new lines)', kind: 'num', unit: 'm' },
    { path: 'geom.spreadType', label: 'Spread type', kind: 'text', list: () => SPREAD_TYPES, hint: 'spreadType' },
    { path: 'geom.spread', label: 'Spread', kind: 'text', list: () => SPREADS },
    { path: 'geom.activeChannels', label: 'Active channels', kind: 'int', list: () => CHANNELS, hint: 'channels' },
    { path: 'geom.highFlagLive', label: 'High flag live', kind: 'int' },
    { path: 'geom.lowFlagLive', label: 'Low flag live', kind: 'int' },
    { path: 'geom.sourceOffsetM', label: 'Source offset (off-end)', kind: 'num', unit: 'm' },
    { path: 'geom.receiverTable', label: 'Receiver table', kind: 'text' },
    { path: 'geom.receiverArray', label: 'Receiver array', kind: 'text' },
    { path: 'geom.rliM', label: 'Receiver line interval', kind: 'num', unit: 'm', show: is3D },
    { path: 'geom.sliM', label: 'Source line interval', kind: 'num', unit: 'm', show: is3D },
    { path: 'geom.azimuthDeg', label: 'Receiver line azimuth', kind: 'num', unit: 'deg', show: is3D },
    { path: 'geom.rxLines', label: 'Number of receiver lines', kind: 'int', show: is3D },
    { path: 'geom.sxLines', label: 'Number of source lines', kind: 'int', show: is3D },
    { path: 'geom.patchLines', label: 'Patch: active lines', kind: 'int', show: is3D },
    { path: 'geom.patchChannelsPerLine', label: 'Patch: channels per line', kind: 'int', show: is3D },
  ],
  source: [
    { path: 'source.type', label: 'Source type', kind: 'text', list: () => SOURCE_TYPES.map((s) => s.label), hint: 'source', rerender: true },
    { path: 'source.trigger', label: 'Trigger system', kind: 'text', list: () => TRIGGER_SYSTEMS },
    { path: 'source.energy', label: 'Energy source', kind: 'text' },
    { path: 'source.manufacturer', label: 'Manufacturer', kind: 'text', list: () => SOURCE_MANUFACTURERS },
    { path: 'source.model', label: 'Model', kind: 'text' },
    { path: 'source.waveType', label: 'Source wave type', kind: 'text', list: () => WAVE_TYPES },
    { path: 'source.unitWeight', label: 'Unit weight / peak force', kind: 'num' },
    { path: 'source.unitWeightUnit', label: 'Weight / force unit', kind: 'select', options: () => [{ value: 'kg', label: 'kg' }, { value: 't', label: 't' }, { value: 'kN', label: 'kN' }] },
    { path: 'source.plate', label: 'Plate type', kind: 'text', list: () => PLATES },
    { path: 'source.stack', label: 'Stack', kind: 'int', list: () => STACKS, hint: 'stack' },
    { path: 'source.array', label: 'Source array', kind: 'text' },
    { path: 'source.sweepStartHz', label: 'Sweep start', kind: 'num', unit: 'Hz', show: () => kindNow() === 'vibrator' },
    { path: 'source.sweepEndHz', label: 'Sweep end', kind: 'num', unit: 'Hz', show: () => kindNow() === 'vibrator' },
    { path: 'source.sweepLengthS', label: 'Sweep length', kind: 'num', unit: 's', show: () => kindNow() === 'vibrator' },
    { path: 'source.sweepTaperS', label: 'Sweep tapers (each)', kind: 'num', unit: 's', show: () => kindNow() === 'vibrator' },
    { path: 'source.sweepType', label: 'Sweep type', kind: 'text', list: () => SWEEP_TYPES, show: () => kindNow() === 'vibrator' },
    { path: 'source.fleetSize', label: 'Fleet size', kind: 'int', show: () => kindNow() === 'vibrator' },
    { path: 'source.impSize', label: 'Size', kind: 'text', show: () => kindNow() === 'impulsive' },
    { path: 'source.impDepthM', label: 'Depth', kind: 'num', unit: 'm', show: () => kindNow() === 'impulsive' },
    { path: 'source.impPattern', label: 'Pattern', kind: 'text', show: () => kindNow() === 'impulsive' },
    { path: 'source.impCount', label: 'Count per point', kind: 'int', show: () => kindNow() === 'impulsive' },
    { path: 'source.comments', label: 'Comments', kind: 'textarea', wide: true },
  ],
  receiver: [
    { path: 'receiver.manufacturer', label: 'Manufacturer', kind: 'text', list: () => MANUFACTURERS, rerender: true },
    { path: 'receiver.model', label: 'Model', kind: 'text', list: () => modelsFor(M.receiver.manufacturer) },
    { path: 'receiver.naturalFreqHz', label: 'Natural frequency', kind: 'num', unit: 'Hz', list: () => GEOPHONE_FREQS_HZ, hint: 'geophoneFreq' },
    { path: 'receiver.geophoneType', label: 'Geophone type', kind: 'text', list: () => GEOPHONE_TYPES, hint: 'geophoneType' },
    { path: 'receiver.phonesPerStation', label: 'Phones per station', kind: 'int', list: () => PHONES_PER_STATION },
    { path: 'receiver.comments', label: 'Comments', kind: 'textarea', wide: true },
  ],
  recording: [
    { path: 'recording.instrumentMfr', label: 'Instrument manufacturer', kind: 'text', list: () => MANUFACTURERS, rerender: true },
    { path: 'recording.instrumentModel', label: 'Instrument model', kind: 'text', list: () => modelsFor(M.recording.instrumentMfr) },
    { path: 'recording.dataFormat', label: 'Data format', kind: 'text', list: () => DATA_FORMATS },
    { path: 'recording.sampleRateMs', label: 'Sample rate', kind: 'num', unit: 'ms', list: () => SAMPLE_RATES_MS, hint: 'sampleRate' },
    { path: 'recording.recordLengthS', label: 'Record length', kind: 'num', unit: 's', list: () => RECORD_LENGTHS_S, hint: 'recordLength' },
    { path: 'recording.lowCutHz', label: 'Low cut (empty = none)', kind: 'num', unit: 'Hz', list: () => LOW_CUTS_HZ, hint: 'lowCut' },
    { path: 'recording.highCutHz', label: 'High cut (empty = none)', kind: 'num', unit: 'Hz', list: () => HIGH_CUTS_HZ },
    { path: 'recording.highCutAntiAlias', label: 'High cut: anti-alias filter', kind: 'check' },
    { path: 'recording.notchHz', label: 'Notch filter (empty = none)', kind: 'num', unit: 'Hz', list: () => NOTCH_HZ },
    { path: 'recording.preampGainDb', label: 'Pre-amp gain', kind: 'num', unit: 'dB', list: () => GAINS_DB },
    { path: 'recording.correlation', label: 'Correlation', kind: 'text', list: () => CORRELATION },
    { path: 'recording.coordSystem', label: 'Coordinate system', kind: 'text', list: () => COORD_SYSTEMS.map((c) => c.label) },
    { path: 'recording.aux.0', label: 'Aux trace 1', kind: 'text', list: () => AUX_CHANNELS },
    { path: 'recording.aux.1', label: 'Aux trace 2', kind: 'text', list: () => AUX_CHANNELS },
    { path: 'recording.aux.2', label: 'Aux trace 3', kind: 'text', list: () => AUX_CHANNELS },
    { path: 'recording.aux.3', label: 'Aux trace 4', kind: 'text', list: () => AUX_CHANNELS },
  ],
  totals: [
    { path: 'totals.totalShots', label: 'Total shots (typed)', kind: 'int' },
    { path: 'totals.totalFiles', label: 'Total files (typed)', kind: 'int' },
    { path: 'totals.weather', label: 'Weather / noise', kind: 'text', list: () => WEATHER },
  ],
};

// -- logo ---------------------------------------------------------------------------

const logoUrl = (): string => (M.logo ? `data:image/${M.logo.format};base64,${M.logo.data}` : '');
/** The decoded logo for the map canvas, cached per logo. */
let logoImgCache: { data: string; img: HTMLImageElement } | null = null;
async function logoImage(): Promise<HTMLImageElement | null> {
  if (!M.logo) return null;
  if (logoImgCache && logoImgCache.data === M.logo.data) return logoImgCache.img;
  const img = new Image();
  img.src = logoUrl();
  try { await img.decode(); } catch { return null; }
  logoImgCache = { data: M.logo.data, img };
  return img;
}

async function pickLogo(): Promise<void> {
  let r: Awaited<ReturnType<PsDeps['api']['paramSheetPickLogo']>>;
  try { r = await D.api.paramSheetPickLogo(); } catch (e) { D.infoToast('Could not open the logo: ' + D.errMsg(e)); return; }
  if (!r) return;                                   // cancelled
  if (!r.ok || !r.data) { D.infoToast(r.error || 'That picture cannot be used as a logo.'); return; }
  const logo = sanitizeLogo({ data: bytesToBase64(r.data), format: r.format, w: r.w, h: r.h });
  if (!logo) { D.infoToast('That picture cannot be used as a logo.'); return; }
  M.logo = logo;

  changed(true);
  D.infoToast(`Logo added (${logo.w} x ${logo.h} px).`);
}

/** The "Logo (optional)" control of the Job step. */
function renderLogoField(form: HTMLElement): void {
  const wrap = el('div', { class: 'olog-field wide', id: 'psLogoField' });
  wrap.appendChild(el('label', {}, 'Logo (optional)'));
  const row = el('div', { class: 'ps-in', style: 'justify-content:flex-start;gap:10px;' });
  if (M.logo) {
    const fit = fitInside(M.logo.w, M.logo.h, 160, 56);
    const img = el('img', { id: 'psLogoThumb', src: logoUrl(), alt: 'Logo', style: `width:${fit?.w ?? 80}px;height:${fit?.h ?? 40}px;border:1px solid var(--hair);border-radius:6px;background:#fff;padding:3px;flex:none;` });
    row.appendChild(img);
  }
  const pick = el('button', { class: 'btn sm', type: 'button', id: 'psLogoPick', style: 'flex:none;' }, M.logo ? 'Choose another logo...' : 'Choose logo file...');
  pick.addEventListener('click', () => void pickLogo());
  row.appendChild(pick);
  if (M.logo) {
    const rm = el('button', { class: 'btn sm ghost', type: 'button', id: 'psLogoRemove', style: 'flex:none;' }, 'Remove logo');
    rm.addEventListener('click', () => { M.logo = null; changed(true); });
    row.appendChild(rm);
  }
  wrap.appendChild(row);
  wrap.appendChild(el('span', { class: 'ps-note' }, 'PNG or JPEG, up to 5 MB. Shown at the right of the sheet title and on the map. Not kept after the app closes.'));
  form.appendChild(wrap);
}

// -- saved configurations (.seisparams) -----------------------------------------------
// A configuration is a FILE the user chooses to write (Review step) and load into a
// later, similar job. The app itself still stores nothing; the format and the
// sanitiser are in core/sheet/config.ts.

/** True when anything at all is filled in the current sheet. */
function sheetHasData(): boolean {
  return !!M.logo || M.coords.points.length > 0 || PS_STEPS.some((s) => stepFilled(M, s));
}

/** The in-app "Save as configuration" dialog: two opt-in groups, both off. */
function askConfigOptions(): Promise<ConfigOptions | null> {
  let back = $('psCfgBack');
  if (!back) {
    back = el('div', { class: 'modal-back', id: 'psCfgBack', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'psCfgTitle' });
    const modal = el('div', { class: 'modal confirm-modal' });
    const head = el('div', { class: 'mh' });
    head.appendChild(el('h2', { id: 'psCfgTitle' }, 'Save as configuration'));
    modal.appendChild(head);
    const body = el('div', { class: 'mbody' });
    body.appendChild(el('p', {}, 'Saves every parameter, the lines and the logo to a .seisparams file you can load next time there is a similar job (or send to a colleague).'));
    const box = (id: string, text: string) => {
      const lab = el('label', { style: 'display:flex;gap:8px;align-items:flex-start;margin:8px 0;cursor:pointer;' });
      const cb = el('input', { type: 'checkbox', id, style: 'margin-top:3px;accent-color:var(--teal);' });
      lab.appendChild(cb);
      lab.appendChild(el('span', {}, text));
      body.appendChild(lab);
    };
    box('psCfgCoords', 'Include the coordinate list');
    box('psCfgJob', 'Include job-specific details (job number, dates, client, prospect, prepared by, revision, notes)');
    modal.appendChild(body);
    const foot = el('div', { class: 'mh confirm-foot' });
    foot.appendChild(el('span', { style: 'flex:1' }));
    foot.appendChild(el('button', { class: 'btn sm', type: 'button', id: 'psCfgCancel' }, 'Cancel'));
    foot.appendChild(el('button', { class: 'btn sm btn-primary', type: 'button', id: 'psCfgOk' }, 'Save...'));
    modal.appendChild(foot);
    back.appendChild(modal);
    document.body.appendChild(back);
  }
  const b = back;
  (b.querySelector('#psCfgCoords') as HTMLInputElement).checked = false;
  (b.querySelector('#psCfgJob') as HTMLInputElement).checked = false;
  b.classList.add('open');
  return new Promise((resolve) => {
    const done = (v: ConfigOptions | null) => {
      b.classList.remove('open');
      okBtn.removeEventListener('click', onOk); cancelBtn.removeEventListener('click', onCancel); b.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const okBtn = b.querySelector('#psCfgOk') as HTMLButtonElement;
    const cancelBtn = b.querySelector('#psCfgCancel') as HTMLButtonElement;
    const onOk = () => done({
      coords: (b.querySelector('#psCfgCoords') as HTMLInputElement).checked,
      jobDetails: (b.querySelector('#psCfgJob') as HTMLInputElement).checked,
    });
    const onCancel = () => done(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') done(null); };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    b.addEventListener('keydown', onKey);
    okBtn.focus();
  });
}

async function saveConfig(): Promise<void> {
  const opts = await askConfigOptions();
  if (!opts) return;
  const now = new Date();
  const text = buildConfig(M, opts, { version: D.version, savedAt: `${todayIso()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
  const stem = (M.job.jobType || 'parameters').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'parameters';
  try {
    const r = await D.api.exportText(`${stem}.${CONFIG_EXT}`, text);
    if (r?.ok) {
      setStatus(`Saved configuration ${r.path ?? ''}`);
      D.infoToast('Configuration saved.');
      D.audit('export', `parameter configuration (coords ${opts.coords ? 'in' : 'out'}, job details ${opts.jobDetails ? 'in' : 'out'}) -> ${r.path}`, 'paramsheet');
    } else if (!r?.canceled) setStatus('Save failed: ' + (r?.error || 'unknown'));
  } catch (e) {
    setStatus('Could not save the configuration: ' + D.errMsg(e));
  }
}

async function loadConfig(): Promise<void> {
  let r: Awaited<ReturnType<PsDeps['api']['paramSheetOpenConfig']>>;
  try { r = await D.api.paramSheetOpenConfig(); } catch (e) { D.infoToast('Could not open the configuration: ' + D.errMsg(e)); return; }
  if (!r) return;                                   // cancelled
  if (!r.ok) { D.infoToast(r.error || 'This file is not a SeisConv parameter configuration.'); return; }
  const res = parseConfig(r.text);
  if (!res.ok) { D.infoToast(res.error); return; }
  if (sheetHasData() && !(await D.confirm('Replace the current sheet with the configuration?', 'Replace'))) return;
  M = res.model;
  lastPresetFor = M.job.jobType;
  sniff = null; coordText = ''; coordFile = ''; previewBasemap = null;
  D.crsPickerSet('psCrsSearch', M.coords.crsCode, M.coords.crsName);
  const what = describeConfig(res.info);
  D.audit('import', `parameter configuration ${r.name ?? ''}: ${what}`, 'paramsheet');
  setStatus('');
  go('job');
  D.infoToast(`Loaded configuration: ${what}`);
}

function configButton(kind: 'save' | 'load', id: string): HTMLButtonElement {
  // Save sits beside the large primary XLSX button, so it matches its size; Load is a
  // normal secondary button at the top of the Job step.
  const b = el('button', { class: kind === 'save' ? 'btn lg' : 'btn', type: 'button', id },
    kind === 'save' ? 'Save as configuration...' : 'Load configuration...');
  b.title = kind === 'save'
    ? 'Save the parameters, lines and logo to a .seisparams file to load next time there is a similar job'
    : 'Fill the sheet from a saved .seisparams configuration';
  b.addEventListener('click', () => void (kind === 'save' ? saveConfig() : loadConfig()));
  return b;
}

// -- rendering ------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

const showNum = (v: Leaf): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

function renderField(f: FSpec): HTMLElement {
  const wrap = el('div', { class: 'olog-field' + (f.wide ? ' wide' : ''), 'data-path': f.path });
  const id = fieldId(f.path);
  const lab = el('label', { for: id }, f.label + (f.unit ? ` (${f.unit})` : ''));
  wrap.appendChild(lab);
  const v = getPath(f.path);
  let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (f.kind === 'select') {
    const s = el('select', { id });
    for (const o of f.options?.() ?? []) {
      const opt = el('option', { value: o.value }, o.label);
      if (String(v ?? '') === o.value) opt.selected = true;
      s.appendChild(opt);
    }
    input = s;
  } else if (f.kind === 'textarea') {
    const t = el('textarea', { id, rows: '2' });
    t.value = typeof v === 'string' ? v : '';
    input = t;
  } else if (f.kind === 'check') {
    const c = el('input', { id, type: 'checkbox' });
    c.checked = v === true;
    c.style.width = '16px';
    input = c;
  } else {
    const i = el('input', { id, type: f.kind === 'date' ? 'date' : f.kind === 'text' ? 'text' : 'number', autocomplete: 'off', spellcheck: 'false' });
    if (f.kind === 'num') i.step = 'any';
    if (f.kind === 'int') i.step = '1';
    if (f.placeholder) i.placeholder = f.placeholder;
    i.value = f.kind === 'num' || f.kind === 'int' ? showNum(v) : typeof v === 'string' ? v : '';
    const list = f.list?.() ?? [];
    if (list.length) {
      const dl = el('datalist', { id: `${id}-dl` });
      for (const x of list) if (x != null) dl.appendChild(el('option', { value: String(x) }));
      i.setAttribute('list', dl.id);
      wrap.appendChild(dl);
    }
    input = i;
  }
  const row = el('div', { class: 'ps-in' });
  row.appendChild(input);
  if (f.unit) row.appendChild(el('span', { class: 'ps-unit' }, f.unit));
  wrap.appendChild(row);
  if (f.hint) {
    const h = presetFor(M.job.jobType)?.hints[f.hint];
    if (h) wrap.appendChild(el('span', { class: 'ps-hint' }, `Recommended: ${h}`));
  }
  const commit = () => {
    if (f.kind === 'check') setPath(f.path, (input as HTMLInputElement).checked);
    else if (f.kind === 'num' || f.kind === 'int') {
      const raw = input.value.trim();
      setPath(f.path, raw === '' ? null : Number(raw));
    } else setPath(f.path, input.value.slice(0, f.kind === 'textarea' ? 1000 : 200));
  };
  if (f.kind === 'select' || f.kind === 'check') {
    input.addEventListener('change', () => { commit(); changed(f.rerender === true); });
  } else {
    input.addEventListener('input', () => { commit(); changed(false); });
    input.addEventListener('change', () => {
      commit();
      if (f.path === 'job.jobType') onJobTypeChange();
      if (f.path === 'job.client') rememberClient(M.job.client);
      changed(f.rerender === true);
    });
  }
  return wrap;
}

/** Fill the presets when the job type changes to a known one. */
let lastPresetFor = '';
function onJobTypeChange(): void {
  const jt = M.job.jobType.trim();
  if (!presetFor(jt) || jt.toLowerCase() === lastPresetFor.toLowerCase()) return;
  M = applyPreset(M, jt);
  lastPresetFor = jt;
  D.infoToast(`Filled the recommended values for "${jt}". Every value stays editable.`);
}

function changed(rerender: boolean): void {
  if (rerender) renderStep();
  else refreshChecks();
}

function derivedBox(lines: [string, string][]): HTMLElement {
  const box = el('div', { class: 'ps-box', id: 'psDerived' });
  box.appendChild(el('div', { class: 'ps-sub', style: 'margin-top:0;' }, 'Derived (nominal, planned)'));
  const dl = el('div', { style: 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px 14px;' });
  for (const [k, v] of lines) {
    const d = el('div');
    d.appendChild(document.createTextNode(`${k}: `));
    d.appendChild(el('b', {}, v || '-'));
    dl.appendChild(d);
  }
  box.appendChild(dl);
  return box;
}

function derivedFor(s: PsStep): [string, string][] {
  const d = deriveSheet(M);
  const u = (v: number | null, unit: string, dec = 3) => (v == null ? '' : `${fmtNum(v, dec)} ${unit}`.trim());
  if (s === 'geometry') {
    const out: [string, string][] = [
      ['Lines', d.lineCount > 0 ? String(d.lineCount) : ''],
      ['Total line length', u(d.totalLengthM, 'm')],
      ['Stations per line (max)', d.maxStations != null ? String(d.maxStations) : ''],
      ['Shots', d.shots != null ? String(d.shots) : ''],
      ['Spread length', u(d.spreadLengthM, 'm')],
    ];
    if (M.job.geometry === '2D') out.push(['Nominal fold', d.fold2d != null ? fmtNum(d.fold2d, 2) : '']);
    if (M.job.geometry === '3D') {
      out.push(['Bin size', d.binInlineM != null && d.binCrosslineM != null ? `${fmtNum(d.binInlineM)} x ${fmtNum(d.binCrosslineM)} m` : '']);
      out.push(['Nominal fold', d.fold3d != null ? fmtNum(d.fold3d, 2) : '']);
      out.push(['Channels per shot', d.channels3d != null ? String(d.channels3d) : '']);
    }
    return out;
  }
  if (s === 'recording') return [['Nyquist', u(d.nyquistHz, 'Hz', 2)], ['Samples per trace', d.samplesPerTrace != null ? String(d.samplesPerTrace) : '']];
  if (s === 'receiver') return [['Receiver interval (from Geometry)', u(M.geom.rxIntervalM, 'm')]];
  if (s === 'totals') {
    return [
      ['Shots from the plan', d.shots != null ? String(d.shots) : ''],
      ['Files from the plan', d.files != null ? `${d.files}${d.polarities > 1 ? ' (2 polarities)' : ''}` : ''],
    ];
  }
  return [];
}

function renderLines(form: HTMLElement): void {
  form.appendChild(el('div', { class: 'ps-sub wide', style: 'grid-column:1 / -1;' }, 'Lines (name and length; the count is derived)'));
  const holder = el('div', { style: 'grid-column:1 / -1;' });
  const t = el('table', { class: 'ps-tbl', id: 'psLines' });
  const head = el('tr');
  for (const h of ['#', 'Line name', 'Length (m)', 'Stations (derived)', 'Shots (derived)', '']) head.appendChild(el('th', {}, h));
  t.appendChild(head);
  const d = deriveSheet(M);
  M.geom.lines.forEach((l, i) => {
    const tr = el('tr', { 'data-path': `geom.lines.${i}` });
    tr.appendChild(el('td', {}, String(i + 1)));
    const nameIn = el('input', { type: 'text', id: `psLineName-${i}`, value: l.name, 'aria-label': `Line ${i + 1} name` });
    const lenIn = el('input', { type: 'number', step: 'any', id: `psLineLen-${i}`, value: showNum(l.lengthM), 'aria-label': `Line ${i + 1} length` });
    nameIn.addEventListener('input', () => { l.name = nameIn.value.slice(0, 200); changed(false); });
    lenIn.addEventListener('input', () => { const r = lenIn.value.trim(); l.lengthM = r === '' ? null : Number(r); changed(false); });
    lenIn.addEventListener('change', () => renderStep());
    const td1 = el('td'); td1.appendChild(nameIn);
    const td2 = el('td'); td2.appendChild(lenIn);
    tr.appendChild(td1); tr.appendChild(td2);
    tr.appendChild(el('td', {}, d.lines[i]?.stations != null ? String(d.lines[i].stations) : '-'));
    tr.appendChild(el('td', {}, d.lines[i]?.shots != null ? String(d.lines[i].shots) : '-'));
    const del = el('button', { class: 'btn sm ghost', type: 'button', title: 'Remove this line' }, 'Remove');
    del.addEventListener('click', () => { M.geom.lines.splice(i, 1); changed(true); });
    const td3 = el('td'); td3.appendChild(del);
    tr.appendChild(td3);
    t.appendChild(tr);
  });
  holder.appendChild(t);
  const add = el('button', { class: 'btn sm', type: 'button', id: 'psAddLineBtn', style: 'margin-top:8px;' }, 'Add line');
  add.disabled = M.geom.lines.length >= PS_MAX_LINES;
  add.addEventListener('click', () => {
    const n = M.geom.lines.length + 1;
    M.geom.lines.push({ name: `Line ${n}`, lengthM: M.geom.lineLengthM });
    changed(true);
    (document.getElementById(`psLineName-${n - 1}`) as HTMLInputElement | null)?.focus();
  });
  holder.appendChild(add);
  form.appendChild(holder);
}

// -- coordinates step ------------------------------------------------------------------

function readCoords(text: string, fileName: string, order?: 'xy' | 'yx'): void {
  coordText = text.slice(0, 4_000_000);
  coordFile = fileName;
  const hint = COORD_SYSTEMS.find((c) => c.label === M.recording.coordSystem.trim())?.code;
  sniff = sniffCoords(coordText, { fileName, hintCode: hint, order });
  M.coords.points = sniff.points.map((p) => (p.group ? { id: p.id, x: p.x, y: p.y, group: p.group } : { id: p.id, x: p.x, y: p.y }));
  M.coords.confirmed = false;
  if (sniff.crs) { M.coords.crsCode = sniff.crs.code; M.coords.crsName = sniff.crs.name; }
  else { M.coords.crsCode = ''; M.coords.crsName = ''; }
  previewBasemap = null;
  changed(true);
}

function renderCoords(form: HTMLElement): void {
  form.style.gridTemplateColumns = 'minmax(0,1fr)';
  const c = M.coords;
  const skipLab = el('label', { class: 'olog-col', style: 'font-size:12.5px;' });
  const skip = el('input', { type: 'checkbox', id: 'psNoArea' });
  skip.checked = c.skip;
  skip.addEventListener('change', () => { c.skip = skip.checked; changed(true); });
  skipLab.appendChild(skip);
  skipLab.appendChild(document.createTextNode('No area yet - skip this step (the XLSX then has no Area or Map sheet and says "Survey area: not provided")'));
  form.appendChild(skipLab);
  if (c.skip) return;

  form.appendChild(el('div', { class: 'ps-sub' }, 'Coordinate list'));
  form.appendChild(el('div', { class: 'ps-note' },
    'Paste points (TXT / CSV, any delimiter, with or without a header) or load a TXT / CSV / KML / GeoJSON file. ' +
    'Columns, degrees or metres, and the coordinate system are detected and shown for you to confirm.'));
  const ta = el('textarea', { id: 'psCoordText', rows: '7', class: 'mono', spellcheck: 'false', placeholder: 'id, Easting, Northing\nA, 200000, 600000\n...' });
  ta.value = coordText;
  form.appendChild(ta);
  const bar = el('div', { class: 'wiz-actions', style: 'margin-top:8px;' });
  const read = el('button', { class: 'btn sm', type: 'button', id: 'psCoordRead' }, 'Read the list');
  read.addEventListener('click', () => readCoords(ta.value, ''));
  const load = el('button', { class: 'btn sm', type: 'button', id: 'psCoordLoad' }, 'Load file...');
  load.addEventListener('click', () => void (async () => {
    try {
      const f = await D.api.openPlanText({ coords: true });
      if (!f) return;
      readCoords(f.text, f.name);
    } catch (e) { setStatus('Could not read that file: ' + D.errMsg(e)); }
  })());
  bar.appendChild(read);
  bar.appendChild(load);
  if (coordFile) bar.appendChild(el('span', { class: 'trace-label' }, `File: ${coordFile}`));
  form.appendChild(bar);

  if (c.points.length) {
    const box = el('div', { class: 'ps-box', id: 'psDetect', style: 'margin-top:10px;' });
    const s = sniff;
    const head = el('div');
    head.appendChild(document.createTextNode(s ? 'Detected: ' : 'Loaded from the configuration: '));
    head.appendChild(el('b', { id: 'psDetectText' }, s ? s.summary : `${c.points.length} points`));
    box.appendChild(head);
    if (s && s.orderAmbiguous) {
      box.appendChild(el('div', { style: 'margin-top:8px;' }, 'The numbers do not tell which column is latitude. Which is it?'));
      const chips = el('div', { class: 'ps-chips' });
      const yx = el('button', { class: 'btn sm', type: 'button', id: 'psOrderYX' }, 'First column is latitude');
      const xy = el('button', { class: 'btn sm', type: 'button', id: 'psOrderXY' }, 'First column is longitude');
      yx.addEventListener('click', () => readCoords(coordText, coordFile, 'yx'));
      xy.addEventListener('click', () => readCoords(coordText, coordFile, 'xy'));
      chips.appendChild(yx); chips.appendChild(xy);
      box.appendChild(chips);
    }
    if (s && !s.confident && s.candidates.length) {
      box.appendChild(el('div', { style: 'margin-top:8px;' }, 'The coordinate system cannot be told from the numbers alone. Choose one:'));
      const chips = el('div', { class: 'ps-chips' });
      s.candidates.forEach((cand, i) => {
        const b = el('button', { class: 'btn sm' + (c.crsCode === cand.code && c.crsName === cand.name ? ' on' : ''), type: 'button', id: `psCand-${i}` },
          cand.code ? `${cand.name} (${cand.code})` : cand.name);
        b.addEventListener('click', () => { c.crsCode = cand.code; c.crsName = cand.name; c.confirmed = false; changed(true); });
        chips.appendChild(b);
      });
      box.appendChild(chips);
    }
    const cur = el('div', { style: 'margin-top:10px;' });
    cur.appendChild(document.createTextNode('Coordinate system: '));
    cur.appendChild(el('b', { id: 'psCrsNow' }, c.crsName ? (c.crsCode ? `${c.crsName} (${c.crsCode})` : c.crsName) : 'not chosen'));
    box.appendChild(cur);
    const blk = $('psCrsBlock');
    if (blk) {
      blk.style.marginTop = '6px';
      box.appendChild(blk);
    }
    const local = el('button', { class: 'btn sm ghost', type: 'button', id: 'psLocalGrid', style: 'margin-top:6px;' }, 'It is a local grid (no basemap)');
    local.addEventListener('click', () => { c.crsCode = ''; c.crsName = crsGuessName(''); c.confirmed = false; changed(true); });
    box.appendChild(local);
    if (s && s.skipped.length) {
      const sk = s.skipped.slice(0, 5).map((x) => `line ${x.line}: ${x.reason}`).join('; ');
      box.appendChild(el('div', { class: 'trace-label', style: 'margin-top:6px;' }, `${s.skipped.length} line(s) skipped (${sk}${s.skipped.length > 5 ? '; ...' : ''}).`));
    }
    if (s && s.truncated) box.appendChild(el('div', { class: 'trace-label' }, 'The list was longer than the limit; only the first points were read.'));
    const conf = el('button', { class: 'btn btn-primary sm', type: 'button', id: 'psCoordConfirm', style: 'margin-top:10px;' },
      c.confirmed ? 'Confirmed' : 'Confirm layout and coordinate system');
    conf.disabled = c.confirmed || !c.crsName;
    conf.addEventListener('click', () => { c.confirmed = true; previewBasemap = null; changed(true); });
    box.appendChild(conf);
    form.appendChild(box);
    // Only now is the picker back in the document (the setter looks it up by id).
    D.crsPickerSet('psCrsSearch', c.crsCode, c.crsName);

    // Points preview.
    const t = el('table', { class: 'ps-tbl', id: 'psPtsTbl', style: 'margin-top:10px;' });
    const geo = c.crsCode === 'EPSG:4326';
    const hr = el('tr');
    for (const h of ['#', 'Point', 'Line', geo ? 'Longitude' : 'X / Easting', geo ? 'Latitude' : 'Y / Northing']) hr.appendChild(el('th', {}, h));
    t.appendChild(hr);
    c.points.slice(0, 30).forEach((p, i) => {
      const tr = el('tr');
      for (const v of [String(i + 1), p.id, p.group ?? '', String(p.x), String(p.y)]) tr.appendChild(el('td', {}, v));
      t.appendChild(tr);
    });
    form.appendChild(t);
    if (c.points.length > 30) form.appendChild(el('div', { class: 'trace-label' }, `... and ${c.points.length - 30} more.`));
    if (c.confirmed) appendLineCheck(form);
  }

  form.appendChild(el('div', { class: 'ps-sub' }, 'Map basemap'));
  const sel = el('select', { id: 'psBasemap', class: 'numin', style: 'width:280px;font-family:inherit;' });
  for (const b of BASEMAPS) {
    const o = el('option', { value: b.value }, b.label);
    if (b.value === c.basemap) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { c.basemap = sel.value; previewBasemap = null; changed(false); });
  form.appendChild(sel);
  form.appendChild(el('div', { class: 'ps-note', style: 'margin-top:4px;' },
    'Tiles are downloaded only when the sheet is saved (or on "Preview with basemap"). Offline, the map is still made, on grey, with a note.'));
}

// -- Geometry lines vs coordinate lines ---------------------------------------------------

/** Add a placeholder that fills (async: the coordinates may need converting in
 *  main) with a warning and a fix button when the coordinate list names other
 *  lines than the Geometry step. Nothing is shown when they agree. */
function appendLineCheck(form: HTMLElement): void {
  const box = el('div', { class: 'ps-box', id: 'psLineCheck', style: 'display:none;margin-top:10px;border-color:var(--amber);' });
  form.appendChild(box);
  const mine = ++lineCheckToken;
  void (async () => {
    let area: AreaInfo | null = null;
    try { area = await computeArea(); } catch { return; }
    if (mine !== lineCheckToken || !area) return;
    const cl = coordLines(area.points);
    const diff = lineMismatch(M.geom.lines, cl);
    if (!diff) return;
    box.innerHTML = '';
    box.appendChild(el('div', { id: 'psLineCheckMsg', style: 'color:var(--amber);' }, `Check: ${diff}`));
    const ul = el('div', { class: 'trace-label', style: 'margin-top:4px;white-space:normal;' },
      'From the coordinates: ' + cl.slice(0, 8).map((l) => `${l.name} ${fmtNum(linesFromCoords([l], M.geom.rxIntervalM)[0].lengthM, 2)} m`).join(', ') + (cl.length > 8 ? ', ...' : ''));
    box.appendChild(ul);
    const b = el('button', { class: 'btn sm', type: 'button', id: 'psUseCoordLines', style: 'margin-top:8px;' }, 'Use the line names and lengths from the coordinates');
    b.addEventListener('click', () => {
      M.geom.lines = linesFromCoords(cl, M.geom.rxIntervalM);
      D.infoToast(`Geometry now has ${M.geom.lines.length} line${M.geom.lines.length === 1 ? '' : 's'} from the coordinates (lengths rounded to the receiver interval).`);
      changed(true);
    });
    box.appendChild(b);
    box.style.display = '';
  })();
}
let lineCheckToken = 0;

// -- area + map ---------------------------------------------------------------------------

async function computeArea(): Promise<AreaInfo | null> {
  const c = M.coords;
  if (c.skip || !c.points.length) return null;
  let pts: AreaPoint[];
  let gridCode = c.crsCode, gridName = c.crsName;
  if (!c.crsCode) {
    pts = c.points.map((p) => ({ id: p.id, group: p.group, x: p.x, y: p.y, e: p.x, n: p.y, lat: null, lon: null }));
    gridName = 'Local grid';
  } else {
    const r = await D.api.paramSheetCoords({ code: c.crsCode, points: c.points.map((p) => [p.x, p.y] as [number, number]) });
    if (!r.ok || !r.en || !r.latlon) throw new Error(r.error || 'coordinate conversion failed');
    gridCode = r.gridCode || c.crsCode;
    gridName = r.gridName || c.crsName;
    pts = c.points.map((p, i) => ({
      id: p.id, group: p.group, x: p.x, y: p.y,
      e: r.en![i]?.[0] ?? null, n: r.en![i]?.[1] ?? null,
      lat: r.latlon![i]?.[0] ?? null, lon: r.latlon![i]?.[1] ?? null,
    }));
  }
  const xy: XY[] = pts.filter((p) => p.e != null && p.n != null).map((p) => ({ x: p.e as number, y: p.n as number }));
  // A closed ring is an outline whether it came ungrouped (a pasted list) or as
  // the one ring of a KML / GeoJSON polygon; several groups are lines.
  const groupCount = new Set(pts.map((p) => p.group).filter(Boolean)).size;
  const hasGroups = groupCount > 0;
  const closed = groupCount <= 1 && isClosed(xy);
  let areaM2: number | null = null, lengthM: number | null = null;
  if (closed) { areaM2 = ringArea(xy); lengthM = ringPerimeter(xy); }
  else {
    areaM2 = xy.length >= 3 ? ringArea(convexHull(xy)) : 0;
    if (hasGroups && !closed) {
      lengthM = 0;
      for (const g of groupsOf(pts)) lengthM += pathLength(g.pts.map((p) => ({ x: p.e as number, y: p.n as number })));
    }
  }
  let extent: AreaInfo['extent'] = null;
  if (xy.length) {
    extent = { minE: Infinity, minN: Infinity, maxE: -Infinity, maxN: -Infinity };
    for (const p of xy) {
      extent.minE = Math.min(extent.minE, p.x); extent.maxE = Math.max(extent.maxE, p.x);
      extent.minN = Math.min(extent.minN, p.y); extent.maxN = Math.max(extent.maxN, p.y);
    }
  }
  return { crsCode: c.crsCode, crsName: c.crsName || 'Local grid', gridCode, gridName, points: pts, closed, areaM2, lengthM, extent };
}

function groupsOf(pts: AreaPoint[]): { name: string; pts: AreaPoint[] }[] {
  const m = new Map<string, AreaPoint[]>();
  for (const p of pts) {
    if (!p.group || p.e == null || p.n == null) continue;
    const a = m.get(p.group) ?? [];
    a.push(p);
    m.set(p.group, a);
  }
  return [...m.entries()].map(([name, ps]) => ({ name, pts: ps }));
}

const LINE_COLORS = ['#e63946', '#1d70b8', '#2a9d8f', '#e9a23b', '#8e44ad', '#c0392b', '#16a085', '#d35400'];
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function mapTitle(): string {
  const jt = M.job.jobType.trim(), pr = M.job.prospect.trim();
  return `${jt || 'Survey'}${pr ? ` - ${pr}` : ''}`;
}
function mapDates(): string {
  const a = M.job.startDate, b = M.job.endDate;
  if (a && b) return `planned ${a} to ${b}`;
  if (a) return `planned from ${a}`;
  return 'planned dates not set';
}

/** Draw the area map onto `cv` (MAP_W x MAP_H). Every number is finite-checked. */
function drawAreaMap(cv: HTMLCanvasElement, area: AreaInfo, grid: MapGrid, rgb: Uint8Array | null, attribution: string, note: string, logo: HTMLImageElement | null = null): void {
  cv.width = grid.width;
  cv.height = grid.height;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const W = grid.width, H = grid.height;
  const P = MAP_PLOT;
  const px = grid.pixelSize;
  if (!fin(px) || px <= 0) return;
  // Background: basemap or paper-section grey.
  if (rgb && rgb.length === W * H * 3) {
    const img = ctx.createImageData(W, H);
    for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) { img.data[o] = rgb[i]; img.data[o + 1] = rgb[i + 1]; img.data[o + 2] = rgb[i + 2]; img.data[o + 3] = 255; }
    ctx.putImageData(img, 0, 0);
  } else {
    ctx.fillStyle = '#ececec';
    ctx.fillRect(0, 0, W, H);
  }
  const font = (size: number, bold = false) => `${bold ? 'bold ' : ''}${size}px "Segoe UI", Arial, sans-serif`;
  const onDark = !!rgb;
  // Coordinate grid inside the plot.
  const e0 = grid.originX + P.left * px, e1 = grid.originX + (W - P.right) * px;
  const n1 = grid.originY - P.top * px, n0 = grid.originY - (H - P.bottom) * px;
  const step = niceStep(Math.max(e1 - e0, n1 - n0), 7);
  const ex = ticks(e0, e1, step), ny = ticks(n0, n1, step);
  ctx.save();
  ctx.beginPath();
  ctx.rect(P.left, P.top, W - P.left - P.right, H - P.top - P.bottom);
  ctx.clip();
  ctx.lineWidth = 1;
  ctx.strokeStyle = onDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.18)';
  for (const e of ex) { const x = Math.round(toPx(grid, e, 0).x) + 0.5; if (fin(x)) { ctx.beginPath(); ctx.moveTo(x, P.top); ctx.lineTo(x, H - P.bottom); ctx.stroke(); } }
  for (const n of ny) { const y = Math.round(toPx(grid, 0, n).y) + 0.5; if (fin(y)) { ctx.beginPath(); ctx.moveTo(P.left, y); ctx.lineTo(W - P.right, y); ctx.stroke(); } }

  const pts = area.points.filter((p) => fin(p.e) && fin(p.n));
  const pxOf = (p: AreaPoint) => toPx(grid, p.e as number, p.n as number);
  // A closed outline is drawn as a polygon with numbered corners, never as a line.
  const groups = area.closed ? [] : groupsOf(pts);
  // Extent outline (light) or the closed polygon (filled).
  if (area.closed && pts.length >= 3) {
    ctx.beginPath();
    pts.forEach((p, i) => { const q = pxOf(p); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,170,0,0.15)';
    ctx.fill();
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = '#d35400'; ctx.stroke();
  } else if (pts.length >= 3) {
    const hull = convexHull(pts.map((p) => ({ x: p.e as number, y: p.n as number })));
    if (hull.length >= 3) {
      ctx.beginPath();
      hull.forEach((h, i) => { const q = toPx(grid, h.x, h.y); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,200,40,0.10)';
      ctx.fill();
      ctx.setLineDash([12, 8]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = onDark ? 'rgba(255,255,255,0.85)' : 'rgba(40,40,40,0.6)';
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  const halo = (text: string, x: number, y: number, color: string, size: number, align: CanvasTextAlign = 'left') => {
    if (!fin(x) || !fin(y)) return;
    ctx.font = font(size, true);
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };
  // Named lines: polyline, start circle, end square, name at the start.
  groups.forEach((g, gi) => {
    const col = LINE_COLORS[gi % LINE_COLORS.length];
    const qs = g.pts.map(pxOf);
    if (qs.length >= 2) {
      ctx.beginPath();
      qs.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
      ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
      ctx.lineWidth = 4; ctx.strokeStyle = col; ctx.stroke();
    }
    const a = qs[0], b = qs[qs.length - 1];
    if (a && fin(a.x) && fin(a.y)) {
      ctx.beginPath(); ctx.arc(a.x, a.y, 8, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    }
    if (b && qs.length >= 2 && fin(b.x) && fin(b.y)) {
      ctx.fillStyle = col; ctx.fillRect(b.x - 7, b.y - 7, 14, 14);
      ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.strokeRect(b.x - 7, b.y - 7, 14, 14);
    }
    if (a) {
      const dx = b && qs.length >= 2 ? a.x - b.x : -1, dy = b && qs.length >= 2 ? a.y - b.y : 0;
      const len = Math.hypot(dx, dy) || 1;
      halo(g.name, a.x + (dx / len) * 18, a.y + (dy / len) * 18, col, 20, dx >= 0 ? 'left' : 'right');
    }
  });
  // Numbered points (ungrouped lists and polygon corners) - numbers match the Area sheet.
  const loose = area.closed ? pts : pts.filter((p) => !p.group);
  const lastDup = area.closed ? 1 : 0;
  if (loose.length <= 300) {
    loose.slice(0, loose.length - lastDup).forEach((p) => {
      const q = pxOf(p);
      if (!fin(q.x) || !fin(q.y)) return;
      ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#d35400'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      halo(String(area.points.indexOf(p) + 1), q.x + 10, q.y - 12, '#222222', 16);
    });
  }
  ctx.restore();

  // Margins (a map sheet: white around the plot), frame.
  ctx.fillStyle = '#fbfbfa';
  ctx.fillRect(0, 0, W, P.top);
  ctx.fillRect(0, H - P.bottom, W, P.bottom);
  ctx.fillRect(0, P.top, P.left, H - P.top - P.bottom);
  ctx.fillRect(W - P.right, P.top, P.right, H - P.top - P.bottom);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#333333';
  ctx.strokeRect(P.left, P.top, W - P.left - P.right, H - P.top - P.bottom);

  // Grid labels.
  const fmtC = (v: number) => (step >= 1 ? Math.round(v).toLocaleString('en-US').replace(/,/g, ' ') : v.toFixed(2));
  ctx.fillStyle = '#333333';
  ctx.font = font(15);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (const e of ex) { const x = toPx(grid, e, 0).x; if (fin(x) && x > P.left + 30 && x < W - P.right - 30) ctx.fillText(fmtC(e), x, H - P.bottom + 8); }
  for (const n of ny) {
    const y = toPx(grid, 0, n).y;
    if (!fin(y) || y < P.top + 30 || y > H - P.bottom - 30) continue;
    ctx.save(); ctx.translate(P.left - 10, y); ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'bottom'; ctx.textAlign = 'center'; ctx.fillText(fmtC(n), 0, 0);
    ctx.restore();
  }
  const unit = area.gridCode ? 'm' : 'units';
  ctx.font = font(15, true);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText(`Easting (${unit})`, P.left + (W - P.left - P.right) / 2, H - P.bottom + 30);
  ctx.save(); ctx.translate(P.left - 52, P.top + (H - P.top - P.bottom) / 2); ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'bottom'; ctx.fillText(`Northing (${unit})`, 0, 0);
  ctx.restore();

  // Title block.
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#1f2d3d';
  ctx.font = font(34, true);
  ctx.fillText(mapTitle(), P.left, 58);
  ctx.font = font(18);
  ctx.fillStyle = '#44505c';
  const crsTxt = area.gridCode ? `${area.gridName} (${area.gridCode})` : area.gridName;
  ctx.fillText(`${crsTxt}   |   ${mapDates()}   |   planned, not measured`, P.left, 94);
  // The optional logo, right-aligned in the title block (aspect kept, never stretched).
  if (logo && logo.naturalWidth > 0 && logo.naturalHeight > 0) {
    const fit = fitInside(logo.naturalWidth, logo.naturalHeight, 300, P.top - 30);
    if (fit) ctx.drawImage(logo, W - P.right - fit.w, Math.round((P.top - 8 - fit.h) / 2), fit.w, fit.h);
  }

  // North arrow (grid north = up), top right inside the plot.
  const ax = W - P.right - 46, ay = P.top + 30;
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillRect(ax - 26, ay - 10, 52, 86);
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + 14, ay + 44); ctx.lineTo(ax, ay + 34); ctx.lineTo(ax - 14, ay + 44); ctx.closePath();
  ctx.fillStyle = '#1f2d3d'; ctx.fill();
  ctx.font = font(20, true); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('N', ax, ay + 48);

  // Scale bar, bottom left inside the plot.
  const lenM = scaleBarMetres(px, 300);
  const barPx = lenM / px;
  if (lenM > 0 && fin(barPx) && barPx > 4) {
    const bx = P.left + 24, by = H - P.bottom - 34;
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillRect(bx - 10, by - 30, barPx + 70, 52);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? '#ffffff' : '#1f2d3d';
      ctx.fillRect(bx + (i * barPx) / 4, by, barPx / 4, 10);
    }
    ctx.lineWidth = 1; ctx.strokeStyle = '#1f2d3d'; ctx.strokeRect(bx, by, barPx, 10);
    ctx.fillStyle = '#1f2d3d'; ctx.font = font(15, true); ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left'; ctx.fillText('0', bx - 4, by - 4);
    ctx.textAlign = 'center'; ctx.fillText(area.gridCode ? fmtDistance(lenM) : `${fmtNum(lenM)} units`, bx + barPx, by - 4);
  }

  // Attribution (burned in) and the note.
  ctx.font = font(14);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#555555';
  ctx.fillText(attribution ? `Basemap: ${attribution}` : 'No basemap', W - P.right, H - 18);
  if (note) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#b03a2e';
    ctx.font = font(16, true);
    ctx.fillText(note, P.left, H - 44);
  }
}

function mapGridFor(area: AreaInfo): MapGrid | null {
  if (!area.extent) return null;
  return fitMapGrid(area.extent, MAP_W, MAP_H, MAP_PLOT, 0.12);
}

/** Fetch the basemap for a frame. Never throws: offline -> rgb null + a note. */
async function fetchBasemap(area: AreaInfo, grid: MapGrid): Promise<{ rgb: Uint8Array | null; attribution: string; note: string }> {
  const src = M.coords.basemap;
  if (!src) return { rgb: null, attribution: '', note: '' };
  if (!area.gridCode) return { rgb: null, attribution: '', note: 'Local grid: no basemap can be placed. Outline and coordinates are exact.' };
  try {
    const r = await D.api.paramSheetBasemap({ code: area.gridCode, grid, source: src });
    if (!r.ok) return { rgb: null, attribution: '', note: `Basemap not available (${r.error || 'error'}). Outline and coordinates are exact.` };
    if (!r.rgb) return { rgb: null, attribution: '', note: 'Basemap not available (offline). Outline and coordinates are exact.' };
    const miss = r.tilesFailed ?? 0, total = r.tilesTotal ?? 0;
    const note = miss > 0 ? `${miss} of ${total} basemap tiles could not be downloaded and are grey.` : (r.tilesBlank && total && r.tilesBlank / total > 0.5 ? 'The basemap has no imagery this close in for this area.' : '');
    return { rgb: r.rgb, attribution: r.attribution || '', note };
  } catch (e) {
    return { rgb: null, attribution: '', note: `Basemap not available (${D.errMsg(e)}). Outline and coordinates are exact.` };
  }
}

/** Draw the review map preview (no tiles unless the user asked for them). */
async function renderMapPreview(withBasemap: boolean): Promise<void> {
  const cv = $('psMapCanvas') as HTMLCanvasElement | null;
  const msg = $('psMapMsg');
  if (!cv) return;
  const mine = ++mapToken;
  let area: AreaInfo | null;
  try { area = await computeArea(); } catch (e) { if (msg) msg.textContent = 'Map: ' + D.errMsg(e); return; }
  if (mine !== mapToken || !area) return;
  const grid = mapGridFor(area);
  if (!grid) { if (msg) msg.textContent = 'Map: no point could be placed.'; return; }
  const key = JSON.stringify([grid, area.gridCode, M.coords.basemap]);
  let bm = { rgb: null as Uint8Array | null, attribution: '', note: '' };
  if (withBasemap) {
    if (previewBasemap && previewBasemap.key === key) bm = previewBasemap;
    else {
      D.showProgress('Downloading basemap tiles for the preview...');
      try { bm = await fetchBasemap(area, grid); } finally { D.hideProgress(); }
      previewBasemap = { key, ...bm };
    }
  } else if (previewBasemap && previewBasemap.key === key) {
    bm = previewBasemap;
  }
  const lg = await logoImage();
  if (mine !== mapToken) return;
  drawAreaMap(cv, area, grid, bm.rgb, bm.attribution, bm.note, lg);
  if (msg) msg.textContent = bm.rgb ? 'Preview with basemap.' : 'Preview without basemap tiles (they are fetched when the sheet is saved).';
}

// -- review + export -----------------------------------------------------------------------

/** The Review text of a field, '' when it was not filled in. Form defaults the
 *  user never chose (survey geometry 2D, the weight unit) are not shown, the same
 *  rule the exported sheet follows. */
function valueText(f: FSpec): string {
  const v = getPath(f.path);
  if (v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return '';
  if (typeof v === 'boolean') return v ? 'yes' : '';
  if (f.path === 'source.unitWeightUnit') return '';
  if (f.path === 'source.unitWeight') return `${v} ${M.source.unitWeightUnit}`;
  if (f.path === 'job.geometry') {
    const g = M.geom;
    const chosen = !!presetFor(M.job.jobType) || v !== '2D' || g.lines.length > 0
      || [g.rxIntervalM, g.sxIntervalM, g.lineLengthM, g.activeChannels].some((x) => x != null);
    if (!chosen) return '';
  }
  if (f.kind === 'select') return f.options?.().find((o) => o.value === String(v))?.label ?? String(v);
  return `${v}${f.unit ? ` ${f.unit}` : ''}`;
}

function renderReview(form: HTMLElement): void {
  form.style.gridTemplateColumns = 'minmax(0,1fr)';
  const wrap = el('div', { class: 'ps-review', id: 'psReview' });
  for (const s of PS_STEPS) {
    if (s === 'review') continue;
    const h = el('h3', {}, PS_STEP_TITLES[s]);
    const edit = el('button', { class: 'btn sm ghost', type: 'button', 'data-goto': s }, 'Edit');
    edit.addEventListener('click', () => go(s));
    h.appendChild(edit);
    wrap.appendChild(h);
    if (s === 'job' && M.logo) {
      const fit = fitInside(M.logo.w, M.logo.h, 200, 60);
      wrap.appendChild(el('img', { id: 'psReviewLogo', src: logoUrl(), alt: 'Logo', style: `width:${fit?.w ?? 80}px;height:${fit?.h ?? 40}px;margin:2px 0 6px;background:#fff;border:1px solid var(--hair);border-radius:6px;padding:3px;` }));
    }
    const dl = el('dl');
    const add = (k: string, v: string) => { if (!v) return; dl.appendChild(el('dt', {}, k)); dl.appendChild(el('dd', {}, v)); };
    if (s === 'coords') {
      const c = M.coords;
      if (c.skip) add('Survey area', 'not provided');
      else if (c.points.length) {
        add('Points', String(c.points.length));
        add('Coordinate system', c.crsName ? (c.crsCode ? `${c.crsName} (${c.crsCode})` : c.crsName) : 'not chosen');
        add('Confirmed', c.confirmed ? 'yes' : 'no');
        add('Basemap', BASEMAPS.find((b) => b.value === c.basemap)?.label ?? c.basemap);
      }
    } else {
      for (const f of SPECS[s]) if (!f.show || f.show()) add(f.label, valueText(f));
      if (s === 'geometry') M.geom.lines.forEach((l) => add(`Line: ${l.name}`, l.lengthM != null ? `${l.lengthM} m` : ''));
      for (const [k, v] of derivedFor(s)) add(`${k} (derived)`, v);
    }
    if (!dl.childElementCount) {
      wrap.appendChild(el('div', { class: 'trace-label' }, 'Nothing filled in (left out of the sheet).'));
      continue;
    }
    wrap.appendChild(dl);
  }
  form.appendChild(wrap);
  if (!M.coords.skip && M.coords.points.length) appendLineCheck(form);

  if (!M.coords.skip && M.coords.points.length) {
    form.appendChild(el('div', { class: 'ps-sub' }, 'Area map (goes into the XLSX)'));
    const cv = el('canvas', { id: 'psMapCanvas', class: 'ps-map', width: String(MAP_W), height: String(MAP_H) });
    form.appendChild(cv);
    const bar = el('div', { class: 'wiz-actions', style: 'margin-top:6px;' });
    const pb = el('button', { class: 'btn sm', type: 'button', id: 'psMapBasemapBtn' }, 'Preview with basemap');
    pb.disabled = !M.coords.basemap || !M.coords.crsCode;
    pb.addEventListener('click', () => void renderMapPreview(true));
    bar.appendChild(pb);
    bar.appendChild(el('span', { class: 'trace-label', id: 'psMapMsg' }, 'Drawing the map...'));
    form.appendChild(bar);
    void renderMapPreview(false);
  }

  const exp = el('div', { class: 'wiz-actions', style: 'margin-top:14px;' });
  const btn = el('button', { class: 'btn btn-primary lg', type: 'button', id: 'psExportBtn' }, 'Save parameter sheet (XLSX)...');
  btn.addEventListener('click', () => void exportSheet());
  exp.appendChild(btn);
  exp.appendChild(configButton('save', 'psCfgSaveBtn'));
  form.appendChild(exp);
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Encode the map: JPEG (quality 0.85) over a photo basemap keeps the workbook
 *  near 1 MB; a grey / no-basemap map stays a lossless PNG. */
async function encodeMap(cv: HTMLCanvasElement, jpeg: boolean): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => (jpeg ? cv.toBlob(res, 'image/jpeg', 0.85) : cv.toBlob(res, 'image/png')));
  if (!blob) throw new Error('could not encode the map image');
  return new Uint8Array(await blob.arrayBuffer());
}

async function exportSheet(): Promise<void> {
  D.showProgress('Building the parameter sheet (XLSX)...', undefined, 0);
  try {
    const area = await computeArea();
    let map: MapInfo | null = null;
    if (area) {
      const grid = mapGridFor(area);
      if (grid) {
        const bm = await fetchBasemap(area, grid);
        const cv = document.createElement('canvas');
        drawAreaMap(cv, area, grid, bm.rgb, bm.attribution, bm.note, await logoImage());
        const jpeg = !!bm.rgb;
        map = { data: await encodeMap(cv, jpeg), format: jpeg ? 'jpeg' : 'png', widthPx: grid.width, heightPx: grid.height, attribution: bm.attribution, note: bm.note };
      }
    }
    const now = new Date();
    const meta = { version: D.version, preparedDate: todayIso(), generatedAt: `${todayIso()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` };
    const bytes = await buildStyledXlsx(buildSheetWorkbook(M, area, map, meta), new JSZip());
    const stem = (M.job.jobNumber || M.job.prospect || M.job.jobType || 'job').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'job';
    const r = await D.api.exportBinary(`${stem}_parameter_sheet.xlsx`, bytes);
    if (r?.ok) {
      rememberClient(M.job.client);
      setStatus(`Saved ${r.path ?? ''}${map?.note ? `  (${map.note})` : ''}`);
      D.infoToast('Parameter sheet saved.');
      D.audit('export', `parameter sheet XLSX (${area ? `${area.points.length} points` : 'no area'}) -> ${r.path}`, 'paramsheet');
    } else if (r?.canceled) setStatus('');
    else setStatus('Save failed: ' + (r?.error || 'unknown'));
  } catch (e) {
    setStatus('Could not build the sheet: ' + D.errMsg(e));
  } finally {
    D.hideProgress();
  }
}

// -- step frame, issues, navigation -----------------------------------------------------------

function setStatus(msg: string): void {
  const s = $('psStatus');
  if (s) s.textContent = msg;
}

/** The step's own checks plus the cross-step checks that point into it. The
 *  Review step shows everything that blocks export. */
function issuesFor(s: PsStep): { errors: Issue[]; warnings: Issue[] } {
  if (s === 'review') return { errors: [], warnings: allHints(M) };
  const own = validateStep(s, M);
  const prefix: Partial<Record<PsStep, string>> = { geometry: 'geom.', totals: 'totals.', receiver: 'receiver.', recording: 'recording.', source: 'source.' };
  const pre = prefix[s];
  if (!pre) return own;
  const cc = crossChecks(M);
  // Sweep-vs-Nyquist is raised against the source fields but only becomes
  // knowable once the sample rate is set, so the Recording step shows it too.
  const rel = (i: Issue) => i.field.startsWith(pre) || (s === 'recording' && i.field.startsWith('source.sweep'));
  return { errors: own.errors.concat(cc.errors.filter(rel)), warnings: own.warnings.concat(cc.warnings.filter(rel)) };
}

function renderIssues(errors: Issue[], warnings: Issue[]): void {
  const box = $('psIssues');
  if (!box) return;
  box.innerHTML = '';
  // Nothing is mandatory: every finding is a gentle hint, never a block or a red field.
  for (const w of errors.concat(warnings).slice(0, 40)) box.appendChild(el('div', { class: 'w' }, `Hint: ${w.msg}`));
}

function stepSummary(s: PsStep): string {
  const d = deriveSheet(M);
  switch (s) {
    case 'job': return M.job.jobType || 'Job type first: it fills the defaults';
    case 'geometry': {
      const bits = [d.lineCount ? `${d.lineCount} line${d.lineCount === 1 ? '' : 's'}` : '', M.geom.rxIntervalM != null ? `RI ${fmtNum(M.geom.rxIntervalM)} m` : '', M.geom.activeChannels != null ? `${M.geom.activeChannels} ch` : ''].filter(Boolean);
      return bits.length ? bits.join(', ') : 'Intervals, spread, lines';
    }
    case 'source': return M.source.type || 'Source type, energy, stack';
    case 'receiver': return [M.receiver.geophoneType, M.receiver.naturalFreqHz != null ? `${fmtNum(M.receiver.naturalFreqHz)} Hz` : ''].filter(Boolean).join(', ') || 'Geophones';
    case 'recording': return [M.recording.sampleRateMs != null ? `${fmtNum(M.recording.sampleRateMs, 4)} ms` : '', M.recording.recordLengthS != null ? `${fmtNum(M.recording.recordLengthS)} s` : ''].filter(Boolean).join(', ') || 'Instrument, sampling, filters';
    case 'totals': return d.shots != null ? `${d.shots} shots planned` : 'Typed totals vs the plan';
    case 'coords': return M.coords.skip ? 'No area yet' : M.coords.points.length ? `${M.coords.points.length} points${M.coords.confirmed ? ', confirmed' : ', not confirmed'}` : 'Paste or load points (or skip)';
    case 'review': { const n = allHints(M).length; return n ? `${n} hint${n === 1 ? '' : 's'}, ready to save` : 'Ready to save'; }
  }
}

function refreshChecks(): void {
  const { errors, warnings } = issuesFor(step);
  renderIssues(errors, warnings);
  const next = $('psNextBtn') as HTMLButtonElement | null;
  if (next) { next.disabled = step === 'review'; next.style.visibility = step === 'review' ? 'hidden' : ''; }
  const back = $('psBackBtn') as HTMLButtonElement | null;
  if (back) back.disabled = step === 'job';
  for (const s of PS_STEPS) {
    const row = $(`psStep-${s}`);
    if (!row) continue;
    row.classList.toggle('active', s === step);
    // Green only when something in the step was filled; visiting it is not enough.
    row.classList.toggle('done', s !== step && stepFilled(M, s));
    row.classList.remove('err');
    const sum = $(`psSum-${s}`);
    if (sum) sum.textContent = stepSummary(s);
  }
  const exp = $('psExportBtn') as HTMLButtonElement | null;
  if (exp) exp.disabled = false;
  const der = $('psDerived');
  if (der && step !== 'review') {
    const fresh = derivedBox(derivedFor(step));
    fresh.style.gridColumn = '1 / -1';
    der.replaceWith(fresh);
  }
}

function renderStep(): void {
  const form = $('psForm');
  if (!form) return;
  // Park the CRS picker before the form is rebuilt (it is moved, never recreated).
  const blk = $('psCrsBlock');
  const hold = $('psHold');
  if (blk && hold && blk.parentElement !== hold) hold.appendChild(blk);
  form.innerHTML = '';
  form.className = 'ps-form';
  form.style.gridTemplateColumns = '';
  const idx = PS_STEPS.indexOf(step);
  const title = $('psStepTitle'); if (title) title.textContent = PS_STEP_TITLES[step];
  const pill = $('psStepPill'); if (pill) pill.textContent = `step ${idx + 1} of ${PS_STEPS.length}`;
  if (step === 'coords') renderCoords(form);
  else if (step === 'review') renderReview(form);
  else {
    // Loading a saved configuration starts a job, so it sits at the top of the Job step.
    if (step === 'job') {
      const cfg = el('div', { class: 'olog-field wide', id: 'psCfgField' });
      cfg.appendChild(el('label', {}, 'Saved configuration (optional)'));
      const row = el('div', { class: 'ps-in', style: 'justify-content:flex-start;gap:10px;' });
      const lb = configButton('load', 'psCfgLoadBtn');
      lb.style.flex = 'none';
      row.appendChild(lb);
      row.appendChild(el('span', { class: 'ps-note' }, 'Fill this sheet from a .seisparams file saved on the Review step of an earlier, similar job.'));
      cfg.appendChild(row);
      form.appendChild(cfg);
    }
    for (const f of SPECS[step]) if (!f.show || f.show()) form.appendChild(renderField(f));
    if (step === 'geometry') renderLines(form);
    const dv = derivedFor(step);
    if (dv.length) {
      const box = derivedBox(dv);
      box.style.gridColumn = '1 / -1';
      form.appendChild(box);
    }
    if (step === 'job') {
      renderLogoField(form);
      const p = presetFor(M.job.jobType);
      if (p) form.appendChild(el('div', { class: 'ps-box', style: 'grid-column:1 / -1;' }, `Planning note for ${p.jobType}: ${p.note}`));
    }
  }
  refreshChecks();
}

function go(s: PsStep): void {
  step = s;
  renderStep();
  const top = $('panel-paramsheet');
  top?.scrollIntoView({ block: 'start' });
}

function next(): void {
  const idx = PS_STEPS.indexOf(step);
  if (step === 'job') rememberClient(M.job.client);
  if (idx < PS_STEPS.length - 1) go(PS_STEPS[idx + 1]);
}
function back(): void {
  const idx = PS_STEPS.indexOf(step);
  if (idx > 0) go(PS_STEPS[idx - 1]);
}

/** Start over (asks first). Also the tab's Clear. */
export async function paramSheetNew(): Promise<void> {
  const ok = await D.confirm('Start a new, empty parameter sheet? Everything typed in this sheet, the coordinates and the logo are cleared.', 'Clear sheet');
  if (!ok) return;
  M = emptySheet();
  lastPresetFor = '';
  sniff = null; coordText = ''; coordFile = ''; previewBasemap = null;
  D.audit('clear', 'cleared the parameter sheet', 'paramsheet');
  setStatus('');
  go('job');
}

/** Called by switchTab when the tab is shown. */
export function paramSheetShown(): void {
  renderStep();
}

/** Wire the tab once at start. */
export function initParamSheet(deps: PsDeps): void {
  D = deps;
  // Every launch starts with an empty sheet; delete anything an older build stored.
  M = emptySheet();
  for (const k of LEGACY_KEYS) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  D.initCrsPicker('psCrsSearch', 'psCrsResults', 'psCrsPicked', 'No CRS picked from the registry.', (code, name) => {
    M.coords.crsCode = code;
    M.coords.crsName = name;
    M.coords.confirmed = false;
    previewBasemap = null;
    changed(true);
  });
  for (const s of PS_STEPS) {
    const row = $(`psStep-${s}`);
    row?.addEventListener('click', () => go(s));
    row?.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') { e.preventDefault(); go(s); } });
  }
  $('psNextBtn')?.addEventListener('click', next);
  $('psBackBtn')?.addEventListener('click', back);
  $('psNewBtn')?.addEventListener('click', () => void paramSheetNew());
  // Enter moves to Next when the step is valid (not inside a text area or the CRS search).
  $('psForm')?.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    const t = ke.target as HTMLElement;
    if (ke.key !== 'Enter' || t.tagName === 'TEXTAREA' || t.id === 'psCrsSearch' || t.tagName === 'BUTTON') return;
    if (step !== 'review') { (t as HTMLInputElement).blur?.(); window.setTimeout(next, 0); }
  });
  renderStep();
}
