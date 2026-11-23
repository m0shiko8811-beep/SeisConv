// seisconv-core / sheet - a saved parameter-sheet CONFIGURATION (.seisparams).
//
// A configuration is a portable JSON file the user saves from the Review step
// and loads into a later, similar job (or sends to a colleague). It does not
// break the "the sheet starts empty on every launch" rule: only what the user chose
// to save is kept, as a file or as a named layout (core/sheet/layouts.ts).
//
//   { format: "seisconv-paramsheet-config", version: 1, savedWith, savedAt, model }
//
// Two groups are optional on save (both left out by default): the coordinate
// list, and the job-specific details. Everything read back goes through
// sanitizeSheet(): only the fields of the model are copied (unknown fields and
// __proto__ / constructor / prototype keys are dropped), strings are capped,
// numbers must be finite, lists are bounded and the logo is re-validated.
// Malformed input never throws: parseConfig returns { ok: false, error }.
//
// Pure: no DOM / Electron.

import { emptySheet, PS_MAX_LINES, PS_MAX_POINTS, PS_MAX_TEXT, PS_MAX_NOTE, type ParamSheet, type PsLine, type PsPoint } from './model';
import { SURVEY_GEOMETRIES } from './lists';
import { sanitizeLogo } from './logo';

export const CONFIG_FORMAT = 'seisconv-paramsheet-config';
export const CONFIG_VERSION = 1;
export const CONFIG_EXT = 'seisparams';
/** Largest configuration file read, bytes (the main process caps the file too). */
export const CONFIG_MAX_BYTES = 5 * 1024 * 1024;

/** The job-specific details left out unless the user ticks them in. */
export const JOB_DETAIL_KEYS = ['jobNumber', 'startDate', 'endDate', 'client', 'prospect', 'preparedBy', 'revision', 'notes'] as const;

export interface ConfigOptions {
  /** Include the coordinate list (points). */
  coords: boolean;
  /** Include the job-specific details (JOB_DETAIL_KEYS). */
  jobDetails: boolean;
}

export interface ConfigInfo {
  lines: number;
  logo: boolean;
  points: number;
  jobDetails: boolean;
  savedWith: string;
  savedAt: string;
}

export type ConfigResult = { ok: true; model: ParamSheet; info: ConfigInfo } | { ok: false; error: string };

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LONG_TEXT = new Set(['notes', 'comments']);
const NUM_MAX = 1e12;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function own(o: Record<string, unknown>, k: string): unknown {
  return !BAD_KEYS.has(k) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}
function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}
function num(v: unknown): number | null | undefined {
  if (v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= NUM_MAX ? v : undefined;
}

/** Copy one section: only the keys of the template, each checked by its type. */
function section<T extends object>(tpl: T, raw: unknown): T {
  const out = { ...tpl } as Record<string, unknown>;
  if (!isObj(raw)) return out as T;
  for (const k of Object.keys(tpl)) {
    const t = (tpl as Record<string, unknown>)[k];
    const v = own(raw, k);
    if (v === undefined) continue;
    if (typeof t === 'string') { const s = str(v, LONG_TEXT.has(k) ? PS_MAX_NOTE : PS_MAX_TEXT); if (s !== undefined) out[k] = s; }
    else if (typeof t === 'boolean') { if (typeof v === 'boolean') out[k] = v; }
    else if (t === null || typeof t === 'number') { const n = num(v); if (n !== undefined) out[k] = n; }
  }
  return out as T;
}

/** A complete, valid model from anything (unknown / bad values fall back to empty). */
export function sanitizeSheet(raw: unknown): ParamSheet {
  const e = emptySheet();
  const r = isObj(raw) ? raw : {};
  const m: ParamSheet = {
    v: 1,
    logo: sanitizeLogo(own(r, 'logo')),
    job: section(e.job, own(r, 'job')),
    geom: section(e.geom, own(r, 'geom')),
    source: section(e.source, own(r, 'source')),
    receiver: section(e.receiver, own(r, 'receiver')),
    recording: section(e.recording, own(r, 'recording')),
    totals: section(e.totals, own(r, 'totals')),
    coords: section(e.coords, own(r, 'coords')),
  };
  if (!SURVEY_GEOMETRIES.some((g) => g.value === m.job.geometry)) m.job.geometry = '2D';
  if (!['kg', 'kN', 't'].includes(m.source.unitWeightUnit)) m.source.unitWeightUnit = 'kg';
  // Lines (bounded).
  const g = own(r, 'geom');
  const rawLines = isObj(g) ? own(g, 'lines') : undefined;
  const lines: PsLine[] = [];
  if (Array.isArray(rawLines)) {
    for (const l of rawLines.slice(0, PS_MAX_LINES)) {
      if (!isObj(l)) continue;
      const len = num(own(l, 'lengthM'));
      lines.push({ name: str(own(l, 'name'), PS_MAX_TEXT) ?? '', lengthM: len === undefined || (len !== null && len < 0) ? null : len });
    }
  }
  m.geom.lines = lines;
  // Recording aux: exactly four strings.
  const rec = own(r, 'recording');
  const aux = isObj(rec) ? own(rec, 'aux') : undefined;
  m.recording.aux = ['', '', '', ''];
  if (Array.isArray(aux)) for (let i = 0; i < 4; i++) m.recording.aux[i] = str(aux[i], PS_MAX_TEXT) ?? '';
  // Points (bounded, finite).
  const c = own(r, 'coords');
  const rawPts = isObj(c) ? own(c, 'points') : undefined;
  const pts: PsPoint[] = [];
  if (Array.isArray(rawPts)) {
    for (const p of rawPts.slice(0, PS_MAX_POINTS)) {
      if (!isObj(p)) continue;
      const x = num(own(p, 'x')), y = num(own(p, 'y'));
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      const pt: PsPoint = { id: str(own(p, 'id'), PS_MAX_TEXT) ?? '', x, y };
      const grp = str(own(p, 'group'), PS_MAX_TEXT);
      if (grp) pt.group = grp;
      pts.push(pt);
    }
  }
  m.coords.points = pts;
  if (!pts.length) m.coords.confirmed = false;
  return m;
}

/** The configuration file text for a model (unticked groups are left out). */
export function buildConfig(m: ParamSheet, opts: ConfigOptions, meta: { version: string; savedAt: string }): string {
  const s = sanitizeSheet(m);
  const job: Record<string, unknown> = { ...s.job };
  if (!opts.jobDetails) for (const k of JOB_DETAIL_KEYS) delete job[k];
  const coords: Record<string, unknown> = { ...s.coords };
  if (!opts.coords) { delete coords.points; delete coords.confirmed; }
  const model = { ...s, job, coords };
  return JSON.stringify({
    format: CONFIG_FORMAT, version: CONFIG_VERSION,
    savedWith: String(meta.version).slice(0, 40), savedAt: String(meta.savedAt).slice(0, 40),
    model,
  }, null, 2) + '\n';
}

/** Read a configuration file's text. Never throws. */
export function parseConfig(text: unknown): ConfigResult {
  const notOurs = 'This file is not a SeisConv parameter configuration.';
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: notOurs };
  if (text.length > CONFIG_MAX_BYTES) return { ok: false, error: 'The configuration file is larger than 5 MB.' };
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch { return { ok: false, error: notOurs }; }
  if (!isObj(raw) || own(raw, 'format') !== CONFIG_FORMAT) return { ok: false, error: notOurs };
  const ver = own(raw, 'version');
  if (typeof ver !== 'number' || !Number.isInteger(ver) || ver < 1) return { ok: false, error: notOurs };
  if (ver > CONFIG_VERSION) return { ok: false, error: 'This configuration was saved by a newer SeisConv; update SeisConv to load it.' };
  const rm = own(raw, 'model');
  if (!isObj(rm)) return { ok: false, error: notOurs };
  const model = sanitizeSheet(rm);
  const rj = own(rm, 'job');
  const jobDetails = isObj(rj) && JOB_DETAIL_KEYS.some((k) => typeof own(rj, k) === 'string' && (own(rj, k) as string) !== '');
  return {
    ok: true, model,
    info: {
      lines: model.geom.lines.length, logo: !!model.logo, points: model.coords.points.length, jobDetails,
      savedWith: str(own(raw, 'savedWith'), 40) ?? '', savedAt: str(own(raw, 'savedAt'), 40) ?? '',
    },
  };
}

/** One line for the toast after a load, e.g. "3 lines, logo, no coordinates". */
export function describeConfig(i: ConfigInfo): string {
  const parts = [`${i.lines} line${i.lines === 1 ? '' : 's'}`, i.logo ? 'logo' : 'no logo',
    i.points ? `${i.points} coordinate point${i.points === 1 ? '' : 's'}` : 'no coordinates'];
  if (i.jobDetails) parts.push('job details');
  return parts.join(', ');
}
