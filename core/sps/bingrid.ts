// seisconv-core / sps - bin-grid model (P6/11 "P6/11" binary-grid header).
//
// A bin grid describes a regular survey grid in projected space: an origin, a
// per-inline / per-crossline step, and an orientation (inline azimuth). It is the
// natural target of a P6/11 file (a UKOOA/IOGP positioning-grid format), which
// carries a 3-D acquisition grid rather than a flat list of S/R points.
//
// This module is PURE (no DOM, no Node) so it runs in the worker AND in unit
// tests. The `parseBinGrid` body is a phase-2 stub - its SIGNATURE is a contract.

import type { SPSProjection } from './parse';

/**
 * A regular survey bin grid in projected (E/N) space.
 *  - origin{E,N}     : the grid origin (the first-inline/first-crossline node).
 *  - binI / binJ     : physical bin size along the inline / crossline axis.
 *  - nInline / nCrossline : node counts on each axis.
 *  - inlineAzimuth   : grid-north→inline-axis (I) bearing (degrees).
 *  - crosslineAzimuth: grid-north→crossline-axis (J) bearing (degrees). Carried
 *                      explicitly because a P6/11 grid's J-axis is NOT always
 *                      inline+90° (EPSG "I=J-90" handedness / sheared grids): the
 *                      renderer MUST use this, not assume orthogonality.
 *  - firstInline / firstCrossline / incInline / incCrossline : node-number
 *                      labelling (the grid may not start numbering at 1).
 *  - corners         : optional explicit grid-corner E/N (when the file gives them).
 *  - raw             : the source lines that produced the grid (audit/QC).
 */
export interface BinGrid {
  name?: string;
  crs?: SPSProjection | null;
  originE: number;
  originN: number;
  binI: number;
  binJ: number;
  nInline: number;
  nCrossline: number;
  inlineAzimuth: number;
  crosslineAzimuth: number;
  firstInline: number;
  firstCrossline: number;
  incInline: number;
  incCrossline: number;
  corners?: { e: number; n: number }[];
  raw: string[];
}

/** A fresh, zeroed BinGrid - the empty value the stub and any "no grid" path return. */
export function emptyBinGrid(): BinGrid {
  return {
    name: undefined,
    crs: null,
    originE: NaN,
    originN: NaN,
    binI: NaN,
    binJ: NaN,
    nInline: 0,
    nCrossline: 0,
    inlineAzimuth: NaN,
    crosslineAzimuth: NaN,
    firstInline: 0,
    firstCrossline: 0,
    incInline: 1,
    incCrossline: 1,
    corners: undefined,
    raw: [],
  };
}

/**
 * Parse a bin-grid definition from text into a {@link BinGrid}.
 *
 * CONTRACT (do not change this signature): `(text: string) => BinGrid`. Malformed
 * input must NEVER throw - return a (possibly empty) BinGrid and let the caller
 * decide. Phase-2 will fill the body; until then it returns an empty grid that
 * records the raw lines so the rest of the scaffold compiles and behaves.
 */
export function parseBinGrid(text: string): BinGrid {
  // TODO(phase2): parse the real bin-grid records (origin, bin size, node counts,
  // inline azimuth, corner coordinates). Apply the same DoS discipline as the
  // point parsers: cap line count + per-line length, never throw on bad input.
  const grid = emptyBinGrid();
  return grid;
}
