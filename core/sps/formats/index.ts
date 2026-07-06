// seisconv-core / sps / formats - positioning-format dispatch.
//
// One front door for every survey-positioning format SeisConv ingests. The rest
// of the app (worker, exporters, views) talks to THIS module, never to the
// individual format parsers, so adding a format is local to core/sps/formats.
//
// Two result shapes flow out of a parse:
//   - kind:'points'   → an SPSData (sources/receivers/xrefs) - the SPS-style view.
//   - kind:'bingrid'  → a BinGrid  (a P6/11 acquisition grid).
//
// 'sps' MUST stay byte-identical to the legacy path: it goes straight through
// parseSPSText, unchanged. PURE: no DOM, no Node - runs in the worker AND tests.

import { parseSPSText, type SPSData } from '../parse';
import { type BinGrid } from '../bingrid';
import { parseSegP1 } from './segp1';
import { parseP111, buildP111 } from './p111';
import { parseCoordCsv, buildCoordCsv } from './coordcsv';
import { parseP611 } from './p611';

// Re-export the individual format parsers/writers so consumers (and the test
// suite) can reach a single format directly through the core barrel, not just via
// the parsePositioning dispatch.
export { parseSegP1 } from './segp1';
export { parseP111, buildP111 } from './p111';
export { parseCoordCsv, buildCoordCsv } from './coordcsv';
export { parseP611 } from './p611';

/** Every positioning format the dispatch understands. */
export type PositioningFormatId = 'sps' | 'segp1' | 'p111' | 'p611' | 'coordcsv';

/** The discriminated result of {@link parsePositioning}. */
export type PositioningParseResult =
  | { kind: 'points'; data: SPSData }
  | { kind: 'bingrid'; grid: BinGrid };

/** Lowercased file extension (no dot), or '' when the name has none. */
function extOf(filename: string): string {
  const base = (filename || '').toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1) : '';
}

/**
 * Decide which positioning format a file is, extension-first then content-sniff.
 *
 * Extension rules:
 *   - .sps, or any .s* / .r* / .x* sidecar (s01, r1, x02, …)  → 'sps'
 *   - .p1 / .segp1                                            → 'segp1'
 *   - .p111 / .p1-11                                          → 'p111'
 *   - .p611                                                   → 'p611'
 *   - .csv                                                    → 'coordcsv'
 * When the extension is ambiguous/unknown, sniff `headText`. Default 'sps' for
 * back-compat (the historical path assumed SPS), so an un-suffixed S/R/X file
 * still parses exactly as before.
 */
export function detectPositioningFormat(filename: string, headText: string): PositioningFormatId {
  const ext = extOf(filename);

  // -- extension-first --
  if (ext === 'sps') return 'sps';
  if (ext === 'segp1' || ext === 'p1') return 'segp1';
  if (ext === 'p111' || ext === 'p1-11') return 'p111';
  if (ext === 'p611') return 'p611';
  if (ext === 'csv') return 'coordcsv';
  // Classic SPS sidecars: s/r/x optionally followed by digits (s, r01, x2, …).
  if (/^[srx]\d*$/.test(ext)) return 'sps';

  // -- content sniff (extension gave no answer) --
  const head = (headText || '').slice(0, 8192);
  // P6/11 / P1/11 carry an IOGP/UKOOA "H" provenance banner mentioning the format.
  if (/\bP6\/11\b/i.test(head) || /\bP6-11\b/i.test(head)) return 'p611';
  if (/\bP1\/11\b/i.test(head) || /\bP1-11\b/i.test(head)) return 'p111';
  // SEG-P1 banner.
  if (/SEG[ -]?P1\b/i.test(head)) return 'segp1';
  // A comma in the first non-empty line with no SPS-style S/R/X leader → CSV.
  const firstLine = head.split(/\r?\n/).find((l) => l.trim()) || '';
  if (firstLine.includes(',') && !/^[HSRX]/i.test(firstLine.trim())) return 'coordcsv';

  // Default: assume SPS (preserves the legacy behavior exactly).
  return 'sps';
}

/**
 * Parse positioning `text` according to `fmt`, returning either the SPSData
 * point model (kind:'points') or a BinGrid (kind:'bingrid'). 'sps' routes to the
 * unchanged {@link parseSPSText}; the others to their format module. Parsers
 * never throw - malformed input surfaces in SPSData.errors / an empty BinGrid.
 */
export function parsePositioning(fmt: PositioningFormatId, text: string): PositioningParseResult {
  switch (fmt) {
    case 'sps':
      return { kind: 'points', data: parseSPSText(text) };
    case 'segp1':
      return { kind: 'points', data: parseSegP1(text) };
    case 'p111':
      return { kind: 'points', data: parseP111(text) };
    case 'coordcsv':
      return { kind: 'points', data: parseCoordCsv(text) };
    case 'p611':
      return { kind: 'bingrid', grid: parseP611(text) };
    default:
      // Exhaustive - but stay defensive: fall back to the SPS path.
      return { kind: 'points', data: parseSPSText(text) };
  }
}

/**
 * Serialize a parsed survey to a writable positioning format.
 * Only the round-trippable point formats are exportable here ('p111', 'coordcsv').
 * Returns one-or-more named files for the caller to save / zip.
 */
export function buildPositioningExport(kind: 'p111' | 'coordcsv', data: SPSData): { name: string; text: string }[] {
  if (kind === 'p111') return buildP111(data);
  if (kind === 'coordcsv') return buildCoordCsv(data);
  return [];
}
