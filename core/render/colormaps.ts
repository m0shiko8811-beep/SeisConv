// seisconv-core / render - color maps for variable-density display.
//
// Each maps a normalized amplitude v ∈ [-1, 1] to an [r,g,b] triple.
// Ported verbatim from the SeisConv reference. Pure - no DOM.

export type RGB = [number, number, number];
export type ColorMapName = 'seismic' | 'gray' | 'amber' | 'viridis';

/** Red-white-blue (the classic seismic map). */
export function colorSeismic(v: number): RGB {
  if (v >= 0) {
    const f = Math.min(v, 1);
    return [255, Math.round(255 * (1 - f)), Math.round(255 * (1 - f))];
  }
  const f = Math.min(-v, 1);
  return [Math.round(255 * (1 - f)), Math.round(255 * (1 - f)), 255];
}

export function colorGray(v: number): RGB {
  const c = Math.round(128 + v * 127);
  return [c, c, c];
}

export function colorAmber(v: number): RGB {
  if (v >= 0) {
    const f = Math.min(v, 1);
    return [255, Math.round(140 * f), 0];
  }
  const f = Math.min(-v, 1);
  return [0, Math.round(212 * f), 255];
}

export function colorViridis(v: number): RGB {
  const t = Math.max(0, Math.min(1, (v + 1) / 2));
  const r = Math.max(0, Math.min(255, Math.round(68 + t * (253 - 68))));
  const g = Math.max(0, Math.min(255, Math.round(1 + t * (231 - 1))));
  const b = Math.max(0, Math.min(255, Math.round(84 + t * (37 - 84))));
  return [r, g, b];
}

/** Dispatch by name (defaults to seismic). */
export function getColor(v: number, map: ColorMapName | string): RGB {
  if (map === 'gray') return colorGray(v);
  if (map === 'amber') return colorAmber(v);
  if (map === 'viridis') return colorViridis(v);
  return colorSeismic(v);
}
