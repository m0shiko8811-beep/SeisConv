// seisconv-core / sheet - load a stored Parameters Sheet draft safely.
//
// A draft lives in localStorage (key `seisconv.paramsheet`) and can be edited by
// anything with access to the profile, so it is treated as untrusted input:
//   - the JSON text is length-capped before parsing;
//   - any object carrying a `__proto__` / `constructor` / `prototype` key is
//     refused outright (prototype-pollution keys);
//   - only the known fields are copied, onto a fresh emptySheet();
//   - every string is capped, every number must be finite and is clamped to a
//     sane range, every array is length-capped; unknown fields are dropped.
// Malformed input returns null (or a partial model), never throws.
//
// Pure: no DOM / Electron.

import { emptySheet, PS_MAX_LINES, PS_MAX_POINTS, PS_MAX_TEXT, PS_MAX_NOTE, isIsoDate, type ParamSheet } from './model';
import type { SurveyGeometry } from './lists';

export const PS_DRAFT_KEY = 'seisconv.paramsheet';
export const PS_DRAFT_MAX_CHARS = 1_500_000;

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True when any object in the tree (depth-capped) has a pollution key. */
export function hasPollutionKey(v: unknown, depth = 0): boolean {
  if (depth > 12 || v == null || typeof v !== 'object') return false;
  if (Array.isArray(v)) {
    for (let i = 0; i < Math.min(v.length, 5000); i++) if (hasPollutionKey(v[i], depth + 1)) return true;
    return false;
  }
  for (const k of Object.keys(v)) {
    if (BAD_KEYS.has(k)) return true;
    if (hasPollutionKey((v as Record<string, unknown>)[k], depth + 1)) return true;
  }
  return false;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

function str(o: Obj, k: string, max = PS_MAX_TEXT, dflt = ''): string {
  const v = own(o, k);
  return typeof v === 'string' ? v.slice(0, max) : dflt;
}
function nn(o: Obj, k: string, min: number, max: number, int = false): number | null {
  const v = own(o, k);
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const c = Math.min(max, Math.max(min, v));
  return int ? Math.round(c) : c;
}
function bool(o: Obj, k: string): boolean {
  return own(o, k) === true;
}

/** Copy a sanitized ParamSheet out of any parsed value. */
export function sanitizeSheet(raw: unknown): ParamSheet | null {
  if (!isObj(raw) || hasPollutionKey(raw)) return null;
  const m = emptySheet();
  const j = isObj(own(raw, 'job')) ? own(raw, 'job') as Obj : {};
  const g = isObj(own(raw, 'geom')) ? own(raw, 'geom') as Obj : {};
  const s = isObj(own(raw, 'source')) ? own(raw, 'source') as Obj : {};
  const rc = isObj(own(raw, 'receiver')) ? own(raw, 'receiver') as Obj : {};
  const r = isObj(own(raw, 'recording')) ? own(raw, 'recording') as Obj : {};
  const t = isObj(own(raw, 'totals')) ? own(raw, 'totals') as Obj : {};
  const c = isObj(own(raw, 'coords')) ? own(raw, 'coords') as Obj : {};

  for (const k of ['jobType', 'client', 'prospect', 'jobNumber', 'contractor', 'crew', 'manager', 'observer', 'preparedBy', 'revision'] as const) {
    m.job[k] = str(j, k, PS_MAX_TEXT, m.job[k]);
  }
  m.job.notes = str(j, 'notes', PS_MAX_NOTE);
  const geo = own(j, 'geometry');
  m.job.geometry = (['2D', '3D', 'borehole', 'point'] as const).includes(geo as SurveyGeometry) ? geo as SurveyGeometry : '2D';
  for (const k of ['startDate', 'endDate'] as const) { const d = str(j, k, 10); m.job[k] = isIsoDate(d) ? d : ''; }
  m.job.targetDepthM = nn(j, 'targetDepthM', 0, 1e6);

  for (const k of ['rxIntervalM', 'sxIntervalM', 'lineLengthM', 'sourceOffsetM', 'rliM', 'sliM'] as const) m.geom[k] = nn(g, k, 0, 1e7);
  for (const k of ['activeChannels', 'highFlagLive', 'lowFlagLive', 'rxLines', 'sxLines', 'patchLines', 'patchChannelsPerLine'] as const) m.geom[k] = nn(g, k, 0, 1e7, true);
  m.geom.azimuthDeg = nn(g, 'azimuthDeg', 0, 360);
  for (const k of ['spreadType', 'spread', 'receiverTable', 'receiverArray'] as const) m.geom[k] = str(g, k);
  const lines = own(g, 'lines');
  if (Array.isArray(lines)) {
    m.geom.lines = lines.slice(0, PS_MAX_LINES).filter(isObj).map((l) => ({ name: str(l, 'name'), lengthM: nn(l, 'lengthM', 0, 1e7) }));
  }

  for (const k of ['type', 'trigger', 'energy', 'manufacturer', 'model', 'waveType', 'plate', 'array', 'sweepType', 'impSize', 'impPattern'] as const) m.source[k] = str(s, k);
  m.source.comments = str(s, 'comments', PS_MAX_NOTE);
  m.source.unitWeight = nn(s, 'unitWeight', 0, 1e7);
  const uwu = own(s, 'unitWeightUnit');
  m.source.unitWeightUnit = uwu === 'kN' || uwu === 't' ? uwu : 'kg';
  m.source.stack = nn(s, 'stack', 0, 100000, true);
  for (const k of ['sweepStartHz', 'sweepEndHz', 'sweepLengthS', 'sweepTaperS', 'impDepthM'] as const) m.source[k] = nn(s, k, 0, 1e6);
  m.source.fleetSize = nn(s, 'fleetSize', 0, 1000, true);
  m.source.impCount = nn(s, 'impCount', 0, 100000, true);

  for (const k of ['manufacturer', 'model', 'geophoneType'] as const) m.receiver[k] = str(rc, k);
  m.receiver.comments = str(rc, 'comments', PS_MAX_NOTE);
  m.receiver.naturalFreqHz = nn(rc, 'naturalFreqHz', 0, 1e5);
  m.receiver.phonesPerStation = nn(rc, 'phonesPerStation', 0, 100000, true);

  for (const k of ['instrumentMfr', 'instrumentModel', 'dataFormat', 'correlation', 'coordSystem'] as const) m.recording[k] = str(r, k);
  for (const k of ['sampleRateMs', 'recordLengthS', 'lowCutHz', 'highCutHz', 'notchHz'] as const) m.recording[k] = nn(r, k, 0, 1e6);
  m.recording.preampGainDb = nn(r, 'preampGainDb', -100, 200);
  m.recording.highCutAntiAlias = bool(r, 'highCutAntiAlias');
  const aux = own(r, 'aux');
  if (Array.isArray(aux)) {
    const a = aux.slice(0, 4).map((x) => (typeof x === 'string' ? x.slice(0, PS_MAX_TEXT) : ''));
    while (a.length < 4) a.push('');
    m.recording.aux = [a[0], a[1], a[2], a[3]];
  }

  m.totals.totalShots = nn(t, 'totalShots', 0, 1e9, true);
  m.totals.totalFiles = nn(t, 'totalFiles', 0, 1e9, true);
  m.totals.weather = str(t, 'weather');

  m.coords.skip = bool(c, 'skip');
  m.coords.confirmed = bool(c, 'confirmed');
  const code = str(c, 'crsCode', 20);
  m.coords.crsCode = /^(EPSG:\d{4,5})?$/.test(code) ? code : '';
  m.coords.crsName = str(c, 'crsName');
  const bm = str(c, 'basemap', 20, 'satellite');
  m.coords.basemap = ['', 'satellite', 'streets', 'light', 'dark'].includes(bm) ? bm : 'satellite';
  const pts = own(c, 'points');
  if (Array.isArray(pts)) {
    m.coords.points = pts.slice(0, PS_MAX_POINTS).filter(isObj)
      .map((p) => {
        const q: { id: string; x: number; y: number; group?: string } = { id: str(p, 'id', 80), x: own(p, 'x') as number, y: own(p, 'y') as number };
        const grp = str(p, 'group', 80);
        if (grp) q.group = grp;
        return q;
      })
      .filter((p) => typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 1e9 && Math.abs(p.y) < 1e9);
  }
  // A list that changed under a confirmation is not confirmed any more.
  if (!m.coords.points.length) m.coords.confirmed = false;
  return m;
}

/** Parse and sanitize a stored draft string; null when unusable. */
export function loadDraft(text: string | null | undefined): ParamSheet | null {
  if (typeof text !== 'string' || !text || text.length > PS_DRAFT_MAX_CHARS) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isObj(raw) || own(raw, 'v') !== 1) return null;
  return sanitizeSheet(raw);
}
