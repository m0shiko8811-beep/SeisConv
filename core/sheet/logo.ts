// seisconv-core / sheet - the optional company logo of a parameter sheet.
//
// The logo is chosen in the main process (native dialog, PNG or JPEG only,
// decoded, downscaled to fit 600 x 300 px), then travels with the draft as
// base64. Everything that reads it back goes through sanitizeLogo(): the format
// must be png / jpeg, the base64 strict, the decoded bytes must carry the
// matching signature, and the size is capped. Anything else is dropped.
//
// Pure: no DOM / Electron.

import { base64ToBytes } from '../base64';
import { isPng, isJpeg } from '../export/xlsx';

/** Largest logo picture kept, pixels. */
export const LOGO_MAX_W = 600;
export const LOGO_MAX_H = 300;
/** Largest logo after downscaling, bytes. */
export const LOGO_MAX_BYTES = 1_000_000;

export interface SheetLogo {
  /** Base64 of the encoded picture. */
  data: string;
  format: 'png' | 'jpeg';
  /** Pixel size of the picture. */
  w: number;
  h: number;
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A validated logo, or null for anything that is not one. */
export function sanitizeLogo(raw: unknown): SheetLogo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const own = (k: string) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const data = own('data'), format = own('format'), w = own('w'), h = own('h');
  if (format !== 'png' && format !== 'jpeg') return null;
  if (typeof data !== 'string' || !data || data.length % 4 !== 0 || data.length > Math.ceil(LOGO_MAX_BYTES / 3) * 4 || !B64.test(data)) return null;
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isInteger(w) || !Number.isInteger(h)) return null;
  if (w < 1 || h < 1 || w > LOGO_MAX_W || h > LOGO_MAX_H) return null;
  const bytes = base64ToBytes(data);
  if (bytes.length > LOGO_MAX_BYTES || !(format === 'png' ? isPng(bytes) : isJpeg(bytes))) return null;
  return { data, format, w, h };
}

/** The logo's bytes (only call on a sanitized logo). */
export function logoBytes(l: SheetLogo): Uint8Array {
  return base64ToBytes(l.data);
}

/** Fit (w, h) inside (maxW, maxH) keeping the aspect ratio, never enlarging.
 *  Returns whole pixels, at least 1 x 1; null for a non-finite or empty size. */
export function fitInside(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } | null {
  if (![w, h, maxW, maxH].every((v) => Number.isFinite(v) && v > 0)) return null;
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Fit (w, h) to exactly `height` keeping the aspect ratio, capped at `maxW`
 *  (then the height shrinks instead). For placing a logo in a title band. */
export function fitToHeight(w: number, h: number, height: number, maxW: number): { w: number; h: number } | null {
  if (![w, h, height, maxW].every((v) => Number.isFinite(v) && v > 0)) return null;
  let k = height / h;
  if (w * k > maxW) k = maxW / w;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
