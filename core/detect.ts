// seisconv-core — format detection
//
// Identifies the container format from filename extension + magic bytes.
// Ported verbatim from the SeisConv reference.

import { asciiPrintable, bcd2 } from './binary';
import type { Bytes, SeismicFormat } from './types';

/**
 * iX1 NT "Stand Alone Mode" SEG-D tape image: a 128-byte ASCII volume header —
 * four spaces, then `SD<rev>RECORD…` (e.g. `SD2.1RECORDB1` / `SD3.0RECORDB2`)
 * with a `SCSI#…` field — followed by raw back-to-back SEG-D records (NO
 * ANSI/VOL1 block framing). Verified on real field tapes. Recognized
 * explicitly so it fails FAST and honestly: walked as a framed tape, the
 * leading spaces read as a ~512 MB "block length" and GB-scale garbage gets
 * extracted + misparsed as SEG-Y (minutes + GBs of RAM for a misleading error).
 */
export function isIX1SegdTape(b: Bytes): boolean {
  if (b.length < 160) return false;
  if (b[0] !== 0x20 || b[1] !== 0x20 || b[2] !== 0x20 || b[3] !== 0x20) return false;
  const head = asciiPrintable(b.slice(4, 128));
  return /^SD\d\.\dRECORD/.test(head) && head.includes('SCSI#');
}

export interface DetectResult {
  format: SeismicFormat;
  /** true when NO signature matched and the format is only a best-effort guess
   *  (an unrecognized blob big enough to hold a SEG-Y header, attempted as
   *  SEG-Y). UIs should say "unrecognized — attempting SEG-Y" rather than
   *  asserting the format. */
  assumed: boolean;
}

/** Detect the seismic format of `b` with an honesty flag — like {@link detect}
 *  but reports whether the answer is a real signature match or an assumption. */
export function detectEx(b: Bytes, name?: string): DetectResult {
  // iX1 SEG-D tape: signature-checked FIRST (any filename/extension) so no path
  // ever walks it as a framed tape or assumes SEG-Y. parseAny fails it fast.
  if (isIX1SegdTape(b)) return { format: 'TPIMAGE', assumed: false };

  const ext = (name || '').toLowerCase().split('.').pop();

  if (ext === 'tpimage') {
    // Some acquisition systems (Inova/ION "Stand Alone Mode") save SEG-Y as
    // .tpimage — check magic bytes before committing to TPIMAGE.
    if ((b[0] === 0xc3 || b[0] === 0xc1 || b[0] === 0x40 || b[0] === 0x43) && b.length >= 3600) return { format: 'SEG-Y', assumed: false };
    if ((b[0] === 0x3a && b[1] === 0x55) || (b[0] === 0x55 && b[1] === 0x3a)) return { format: 'SEG-2', assumed: false };
    return { format: 'TPIMAGE', assumed: false };
  }
  if (ext === 'su') return { format: 'SU', assumed: false }; // Seismic Unix — headerless, no magic bytes
  if (ext === 'dat' || ext === 'seg2' || ext === 'bat') return { format: 'SEG-2', assumed: false }; // .dat = Geode, .bat = legacy

  // Tpimage magic: first 4 bytes = BE block length 80, then "VOL1".
  if (b.length >= 88) {
    const bl = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
    if (bl === 80 && b[4] === 0x56 && b[5] === 0x4f && b[6] === 0x4c && b[7] === 0x31) return { format: 'TPIMAGE', assumed: false };
  }
  if ((b[0] === 0x3a && b[1] === 0x55) || (b[0] === 0x55 && b[1] === 0x3a)) return { format: 'SEG-2', assumed: false };
  if ((b[0] === 0xc3 || b[0] === 0xc1 || b[0] === 0x40 || b[0] === 0x43) && b.length >= 3600) return { format: 'SEG-Y', assumed: false };

  const fc = bcd2(b[2]) * 100 + bcd2(b[3]);
  if ([8058, 8068, 8048, 8015, 32, 8032, 4, 8064].includes(fc)) return { format: 'SEG-D', assumed: false };
  // A blob large enough to hold a SEG-Y text+binary header is still a plausible
  // (header-only-recognisable) SEG-Y; anything smaller matched no signature, so
  // report UNKNOWN rather than forcing it through parseSEGY (which would emit a
  // misleading '<3600 bytes' error instead of 'unsupported file'). This is a
  // GUESS, not a detection — hence assumed: true.
  if (b.length >= 3600) return { format: 'SEG-Y', assumed: true };
  return { format: 'UNKNOWN', assumed: false };
}

/** Detect the seismic format of `b`, using `name` (filename) for the extension hint. */
export function detect(b: Bytes, name?: string): SeismicFormat {
  return detectEx(b, name).format;
}
