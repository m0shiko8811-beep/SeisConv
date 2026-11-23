// seisconv-core / sheet - SAVED LAYOUTS of the Parameters Sheet.
//
// A layout is a parameter configuration (core/sheet/config.ts, the .seisparams
// format) that the app keeps on this computer, so the user can start a similar job
// from a list instead of hunting for a file. The main process stores one JSON file
// per layout under <userData>/paramsheet-layouts/; the file is exactly a
// .seisparams configuration plus a top-level "name" (parseConfig ignores unknown
// top-level keys, so an exported layout is a normal .seisparams file).
//
// The rules live here so they are unit-tested: generated ids only (the user's name
// text never becomes a path), names trimmed to 1..80 chars without control
// characters, at most 200 layouts, 5 MB per file, A-Z listing.
//
// Pure: no DOM / Electron / fs.

import { parseConfig, CONFIG_MAX_BYTES, type ConfigInfo } from './config';

export const LAYOUT_DIR = 'paramsheet-layouts';
export const LAYOUT_ID_RE = /^[a-z0-9-]{1,64}$/;
export const LAYOUT_MAX_COUNT = 200;
export const LAYOUT_MAX_BYTES = CONFIG_MAX_BYTES;
export const LAYOUT_NAME_MAX = 80;
const FILE_RE = /^([a-z0-9-]{1,64})\.json$/;
const CONTROL_RE = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f) + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const BOM = String.fromCharCode(0xfeff);
const stripBom = (t: string) => (t.startsWith(BOM) ? t.slice(1) : t);

export interface LayoutEntry {
  id: string;
  name: string;
  savedAt: string;
  info: ConfigInfo;
}

export function isLayoutId(id: unknown): id is string {
  return typeof id === 'string' && LAYOUT_ID_RE.test(id);
}

/** The file name of a layout id (`<id>.json`); null for an invalid id. */
export function layoutFileName(id: unknown): string | null {
  return isLayoutId(id) ? `${id}.json` : null;
}

/** The id of a directory entry, or null when it is not a layout file (temp files, junk). */
export function layoutIdFromFile(file: unknown): string | null {
  if (typeof file !== 'string') return null;
  const m = FILE_RE.exec(file);
  return m ? m[1] : null;
}

/** A clean display name: control characters removed, whitespace collapsed, trimmed,
 *  at most 80 characters. null when nothing is left. */
export function cleanLayoutName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // C0 / C1 controls and the two Unicode line separators (built from char codes so
  // the source stays plain ASCII).
  const s = raw.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return Array.from(s).slice(0, LAYOUT_NAME_MAX).join('').trim() || null;
}

/** Same name, ignoring case and surrounding whitespace. */
export function sameLayoutName(a: string, b: string): boolean {
  return (cleanLayoutName(a) ?? '').toLocaleLowerCase() === (cleanLayoutName(b) ?? '').toLocaleLowerCase();
}

/** A-Z by name (case-insensitive, numbers in natural order), ties by id. Returns a new array. */
export function sortLayouts<T extends { id: string; name: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The first layout carrying this name (case-insensitive), excluding `exceptId`. */
export function findLayoutByName<T extends { id: string; name: string }>(list: readonly T[], name: string, exceptId?: string): T | undefined {
  return list.find((l) => l.id !== exceptId && sameLayoutName(l.name, name));
}

/** A fresh layout id from random bytes (lowercase hex, matches LAYOUT_ID_RE). */
export function newLayoutId(bytes: Uint8Array): string {
  const hex = Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return `l-${hex || '0'}`;
}

/** The stored file text: the configuration text with the cleaned name set on top.
 *  null when the text is not a valid configuration or the name is empty. */
export function buildLayoutText(name: unknown, configText: unknown): string | null {
  const nm = cleanLayoutName(name);
  if (!nm || typeof configText !== 'string' || configText.length > LAYOUT_MAX_BYTES) return null;
  if (!parseConfig(configText).ok) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(stripBom(configText)) as Record<string, unknown>; } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = { name: nm };
  for (const k of Object.keys(raw)) if (k !== 'name' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') out[k] = raw[k];
  const text = JSON.stringify(out, null, 2) + '\n';
  return text.length > LAYOUT_MAX_BYTES ? null : text;
}

/** Read one stored layout file. Never throws; malformed -> null. */
export function readLayoutText(id: unknown, text: unknown): LayoutEntry | null {
  if (!isLayoutId(id) || typeof text !== 'string' || text.length > LAYOUT_MAX_BYTES) return null;
  const res = parseConfig(text);
  if (!res.ok) return null;
  let raw: unknown;
  try { raw = JSON.parse(stripBom(text)); } catch { return null; }
  const nm = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, 'name')
    ? cleanLayoutName((raw as Record<string, unknown>).name) : null;
  if (!nm) return null;
  return { id, name: nm, savedAt: res.info.savedAt, info: res.info };
}
