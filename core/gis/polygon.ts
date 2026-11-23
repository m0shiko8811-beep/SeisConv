// seisconv-core / gis - planar polygon and polyline helpers.
//
// Area (shoelace), perimeter, path length, bounding box, ring clean-up, a
// self-intersection test and a convex hull, all in the plane of a projected CRS
// (metres in, metres out). Bounded and NaN-safe: non-finite vertices are dropped
// before any arithmetic, and the O(n^2) intersection test is capped.
//
// Pure: no DOM / Electron.

export interface XY { x: number; y: number }

export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

/** Most vertices any helper here looks at. */
export const POLY_MAX_VERTICES = 5000;

const finXY = (p: XY): boolean => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

/** Finite vertices only, capped at POLY_MAX_VERTICES. */
export function finitePoints(pts: readonly XY[]): XY[] {
  const out: XY[] = [];
  for (const p of pts) {
    if (out.length >= POLY_MAX_VERTICES) break;
    if (finXY(p)) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Bounding box of the finite vertices, or null when there are none. */
export function bbox(pts: readonly XY[]): BBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of finitePoints(pts)) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** True when the first and last vertex coincide within `tol`. */
export function isClosed(pts: readonly XY[], tol = 1e-9): boolean {
  if (pts.length < 4) return false;
  const a = pts[0], b = pts[pts.length - 1];
  return finXY(a) && finXY(b) && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

/** Clean a ring: drop non-finite and consecutive duplicate vertices and the
 *  duplicate closing vertex. The result is an OPEN ring (first != last). */
export function cleanRing(pts: readonly XY[], tol = 1e-9): XY[] {
  const out: XY[] = [];
  for (const p of finitePoints(pts)) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - p.x) <= tol && Math.abs(q.y - p.y) <= tol) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol) out.pop();
    else break;
  }
  return out;
}

/** Absolute area of a ring (shoelace), in squared input units. 0 for < 3 vertices. */
export function ringArea(pts: readonly XY[]): number {
  const r = cleanRing(pts);
  if (r.length < 3) return 0;
  // Shift to the first vertex so large projected coordinates do not lose precision.
  const ox = r[0].x, oy = r[0].y;
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    s += (a.x - ox) * (b.y - oy) - (b.x - ox) * (a.y - oy);
  }
  return Math.abs(s) / 2;
}

/** Length of an open path through the vertices. */
export function pathLength(pts: readonly XY[]): number {
  const r = finitePoints(pts);
  let s = 0;
  for (let i = 1; i < r.length; i++) s += Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y);
  return s;
}

/** Perimeter of a closed ring (the closing edge is included once). */
export function ringPerimeter(pts: readonly XY[]): number {
  const r = cleanRing(pts);
  if (r.length < 2) return 0;
  return pathLength(r) + Math.hypot(r[0].x - r[r.length - 1].x, r[0].y - r[r.length - 1].y);
}

function orient(a: XY, b: XY, c: XY): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}
function onSeg(a: XY, b: XY, p: XY): boolean {
  return Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
}
/** True when segments ab and cd share any point. */
export function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSeg(a, b, c)) return true;
  if (o2 === 0 && onSeg(a, b, d)) return true;
  if (o3 === 0 && onSeg(c, d, a)) return true;
  if (o4 === 0 && onSeg(c, d, b)) return true;
  return false;
}

/** True when two non-adjacent edges of the closed ring touch or cross. Rings
 *  above `cap` vertices are not tested (returns false) - the check is O(n^2). */
export function selfIntersects(pts: readonly XY[], cap = 2000): boolean {
  const r = cleanRing(pts);
  const n = r.length;
  if (n < 4 || n > cap) return false;
  for (let i = 0; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n];
    for (let k = i + 2; k < n; k++) {
      if (i === 0 && k === n - 1) continue; // first and last edge share vertex 0
      const c = r[k], d = r[(k + 1) % n];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/** Convex hull (Andrew's monotone chain), counter-clockwise, open ring. */
export function convexHull(pts: readonly XY[]): XY[] {
  const p = finitePoints(pts).sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: XY, a: XY, b: XY) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: XY[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: XY[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
