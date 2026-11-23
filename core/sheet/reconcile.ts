// seisconv-core / sheet - reconcile the Geometry lines with the coordinate list.
//
// A planner types the lines on the Geometry step (name + length) and, later,
// pastes coordinates whose ids often carry their own line names (A-01-S, A-01-E
// ...). When the two disagree the parameter sheet and its map would describe
// different lines, so the wizard warns and offers to take the names and lengths
// from the coordinates. Lengths come from the points (metric E / N), rounded to
// the receiver point interval.
//
// Pure: no DOM / Electron. Non-finite points are skipped.

import type { PsLine } from './model';

export interface CoordLinePoint { group?: string; e: number | null; n: number | null }
export interface CoordLine { name: string; lengthM: number }

/** The named lines of a coordinate list, in first-seen order, with the length of
 *  the path through their points (metres). */
export function coordLines(points: readonly CoordLinePoint[]): CoordLine[] {
  const order: string[] = [];
  const pts = new Map<string, { e: number; n: number }[]>();
  for (const p of points) {
    const g = (p.group || '').trim();
    if (!g || typeof p.e !== 'number' || typeof p.n !== 'number' || !Number.isFinite(p.e) || !Number.isFinite(p.n)) continue;
    if (!pts.has(g)) { pts.set(g, []); order.push(g); }
    pts.get(g)!.push({ e: p.e, n: p.n });
  }
  return order.slice(0, 1000).map((name) => {
    const q = pts.get(name)!;
    let len = 0;
    for (let i = 1; i < q.length; i++) len += Math.hypot(q[i].e - q[i - 1].e, q[i].n - q[i - 1].n);
    return { name, lengthM: len };
  });
}

const key = (s: string) => (s || '').trim().toLowerCase();

/** A one-line description of how the Geometry lines differ from the coordinate
 *  lines, or null when they match (same count, same names in any order). */
export function lineMismatch(geom: readonly PsLine[], coords: readonly CoordLine[]): string | null {
  if (!coords.length) return null;
  const a = geom.map((l) => key(l.name)).sort();
  const b = coords.map((l) => key(l.name)).sort();
  if (a.length === b.length && a.every((x, i) => x === b[i])) return null;
  const show = (xs: readonly { name: string }[]) => {
    const s = xs.slice(0, 6).map((x) => x.name).join(', ');
    return xs.length > 6 ? `${s}, ...` : s;
  };
  return `Geometry has ${geom.length} line${geom.length === 1 ? '' : 's'} (${show(geom) || 'none'}) but the coordinates name `
    + `${coords.length} (${show(coords)}).`;
}

/** Round a length to the receiver interval (nearest whole interval), or to
 *  0.1 m when there is no usable interval. */
export function roundToInterval(lengthM: number, intervalM: number | null): number {
  if (!Number.isFinite(lengthM) || lengthM < 0) return 0;
  if (typeof intervalM === 'number' && Number.isFinite(intervalM) && intervalM > 0) {
    return Number((Math.round(lengthM / intervalM) * intervalM).toFixed(6));
  }
  return Math.round(lengthM * 10) / 10;
}

/** Geometry lines taken from the coordinate lines. */
export function linesFromCoords(coords: readonly CoordLine[], rxIntervalM: number | null): PsLine[] {
  return coords.slice(0, 200).map((c) => ({ name: c.name.slice(0, 200), lengthM: roundToInterval(c.lengthM, rxIntervalM) }));
}
