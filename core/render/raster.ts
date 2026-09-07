// seisconv-core - per-cell heatmap rasterisation into RGBA bytes
//
// Four per-cell loops in `renderer/src/app.ts` do the same job with two
// different INPUT layouts and one optional vertical flip:
//
//   paintSection  `:3468-3479`  x-major   (data[t * colLen + s]), no flip
//   drawVelocity  `:11912-11920` x-major   (semb[vi * nT + ti]),  no flip
//   drawSpecGram  `:12421-12428` row-major (mag[f * nBins + k]),  no flip
//   drawSpecFk    `:12480-12490` row-major (mag[f * nKx + c]),    FLIPPED
//
// Both of those are parameters here, because getting either one backwards
// transposes or mirrors an entire panel while still "working".
//
// Pure TS: it returns a Uint8ClampedArray, never an ImageData, so no DOM type
// leaks into core. The renderer copies the bytes into an ImageData, or passes
// `imageData.data` in as `out` to write straight through.

import { getColorWriter, type ColorMapName } from './colormaps';

/** How the SOURCE array is indexed.
 *  - 'xMajor': `data[x * h + y]` - one contiguous run per column (per trace).
 *  - 'rowMajor': `data[y * w + x]` - one contiguous run per row. */
export type RasterLayout = 'xMajor' | 'rowMajor';

/** Maps a raw stored value to the [-1,1] unit the colour maps take.
 *
 *  It receives the column index as well, because paintSection applies a
 *  PER-TRACE gain there (`data[base + s] * g * cInv` at `app.ts:3471`, where
 *  `g = gf[t]`). Multiplication order inside the callback matters for exact
 *  reproduction, so the callback owns the whole expression - including its
 *  clamp. The clamps differ: the section clamps to [-1,1] and passes that value
 *  straight through, while the other three clamp to [0,1] and then do `* 2 - 1`. */
export type ValueToUnit = (raw: number, x: number, y: number) => number;

/** Rasterise a w x h grid of values into RGBA bytes, row-major, 4 bytes per
 *  pixel, alpha 255 - the layout an ImageData expects.
 *
 *  `flipY` writes source row y to output row `h - 1 - y`, which is drawSpecFk's
 *  frequency-up convention at `app.ts:12487`.
 *
 *  A non-finite value is passed to the colour map UNTOUCHED. Every map in
 *  colormaps.ts already begins with its own finite check, and adding a second
 *  one here would change nothing on screen while diverging from the tree, which
 *  this extraction step forbids.
 *
 *  Returns `out` when supplied (so the caller can write into `imageData.data`),
 *  otherwise a fresh buffer. Throws only if `out` is too small, which is a
 *  programming error rather than bad input data. */
export function rasterizeToRGBA(
  data: ArrayLike<number>,
  w: number,
  h: number,
  valueToUnit: ValueToUnit,
  mapName: ColorMapName | string,
  out?: Uint8ClampedArray,
  flipY = false,
  layout: RasterLayout = 'rowMajor',
): Uint8ClampedArray {
  const wi = w | 0, hi = h | 0;
  const need = Math.max(0, wi) * Math.max(0, hi) * 4;
  if (out && out.length < need) {
    throw new Error(`rasterizeToRGBA: out buffer holds ${out.length} bytes, needs ${need}`);
  }
  const buf = out ?? new Uint8ClampedArray(need);
  if (wi <= 0 || hi <= 0) return buf;
  // Resolve the map once: it cannot change mid-raster, and the writer form
  // colours straight into `buf` so a 2000x2000 section no longer allocates
  // four million throwaway [r,g,b] tuples for the GC to collect.
  const write = getColorWriter(mapName);
  for (let y = 0; y < hi; y++) {
    const srcRow = layout === 'rowMajor' ? y * wi : 0;
    const dstRow = (flipY ? (hi - 1 - y) : y) * wi;
    for (let x = 0; x < wi; x++) {
      const src = layout === 'rowMajor' ? srcRow + x : x * hi + y;
      const idx = (dstRow + x) * 4;
      write(valueToUnit(data[src], x, y), buf, idx);
      buf[idx + 3] = 255;
    }
  }
  return buf;
}

/** paintSection's cell transform, `app.ts:3471`. `gain(x)` is the per-trace
 *  factor `gf[t]`, `cInv` the clip inverse. Multiplication order preserved. */
export function sectionUnit(gain: (x: number) => number, cInv: number): ValueToUnit {
  return (raw, x) => Math.max(-1, Math.min(1, raw * gain(x) * cInv));
}

/** The `Math.max(0, Math.min(1, v * scale)) * 2 - 1` transform shared by
 *  drawVelocity (`app.ts:11914`, scale 1) and drawSpecGram (`:12422`,
 *  scale `1 / maxMag`). */
export function magnitudeUnit(scale: number): ValueToUnit {
  return (raw) => Math.max(0, Math.min(1, raw * scale)) * 2 - 1;
}

/** drawSpecFk's log-compressed transform, `app.ts:12483-12484`. `logMax` is
 *  `Math.log1p(maxMag > 0 ? maxMag : 1)`; a non-positive logMax yields 0, the
 *  same short-circuit the tree uses. */
export function logMagnitudeUnit(logMax: number): ValueToUnit {
  return (raw) => {
    const v = logMax > 0 ? Math.log1p(raw) / logMax : 0;
    return Math.max(0, Math.min(1, v)) * 2 - 1;
  };
}
