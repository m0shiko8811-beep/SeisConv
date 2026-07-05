// seisconv-core / sps — survey geometry generator (feature B).
//
// Generate a fresh SPS survey (sources, receivers, cross-references) from a
// polyline-per-line geometry model. 2D acquisition walks receivers + sources
// along each picked line by arc length (crooked lines OK). 3D acquisition treats
// the picked lines as RECEIVER lines and generates SOURCE lines perpendicular to
// the receiver-line bearing, then emits either a full-template or moving-patch X
// model. Pure — no DOM/Node/Electron.

import type { SPSData, SPSPoint, SPSProjection, SPSXref } from './parse';

/** One acquisition line as an ordered E/N polyline (≥2 vertices; crooked OK). */
export interface SurveyLine {
  vertices: { e: number; n: number }[];
}

export interface CreateParams {
  mode: '2D' | '3D';
  lines: SurveyLine[];
  rcvInterval: number;
  srcInterval: number;
  rcvLineStart: number;
  rcvLineInc: number;
  rcvPointStart: number;
  rcvPointInc: number;
  srcLineStart: number;
  srcLineInc: number;
  srcPointStart: number;
  srcPointInc: number;
  /** 3D only: distance between adjacent (generated) source lines, measured along
   *  the in-line / receiver-line bearing (SLI). Ignored in 2D. */
  srcLineSpacing?: number;
  /** 3D only: receiver-line bearing in degrees clockwise from North. When omitted
   *  the bearing is derived from the picks (net direction of the longest line). */
  azimuthDeg?: number;
  /** Cross-reference model. 2D: `full` = every receiver on the line per shot;
   *  `split` = a window of `channels` receivers around the shot. 3D: `full` =
   *  full template (every shot records every receiver); `split` = moving patch of
   *  `patchLines` receiver lines × `channels` stations around each shot. */
  relation: { type: 'full' | 'split'; channels?: number; patchLines?: number };
  srcType?: string;
  rcvType?: string;
}

/** Sensible starting parameters for the Create UI (mode + lines supplied live).
 *  `srcLineSpacing` + `relation.{channels,patchLines}` seed the 3D controls. */
export const CREATE_DEFAULTS = {
  rcvInterval: 25,
  srcInterval: 25,
  rcvLineStart: 1000,
  rcvLineInc: 2,
  rcvPointStart: 1000,
  rcvPointInc: 2,
  srcLineStart: 1000,
  srcLineInc: 2,
  srcPointStart: 1000,
  srcPointInc: 2,
  srcLineSpacing: 300,
  relation: { type: 'full' as const, channels: 240, patchLines: 8 },
} satisfies Omit<CreateParams, 'mode' | 'lines'>;

// DoS discipline (mirrors parse.ts MAX_SPS_* caps): never allocate an unbounded
// number of points from caller geometry × interval. Total = sources + receivers.
const MAX_GENERATED_POINTS = 5_000_000;

function reqPos(v: number, what: string): void {
  if (!isFinite(v) || v <= 0) throw new Error(`generateSPS: ${what} must be a finite number > 0 (got ${v})`);
}
function reqFinite(v: number, what: string): void {
  if (!isFinite(v)) throw new Error(`generateSPS: ${what} must be a finite number (got ${v})`);
}

/** Arc-length parameterisation of a polyline: total length + point-at-distance. */
function arcLength(vertices: { e: number; n: number }[]): { L: number; at: (t: number) => { e: number; n: number } } {
  const cum = [0];
  for (let i = 1; i < vertices.length; i++) {
    const de = vertices[i].e - vertices[i - 1].e;
    const dn = vertices[i].n - vertices[i - 1].n;
    cum[i] = cum[i - 1] + Math.sqrt(de * de + dn * dn);
  }
  const L = cum[cum.length - 1];
  const at = (t: number): { e: number; n: number } => {
    if (!(t > 0)) return { e: vertices[0].e, n: vertices[0].n };
    if (t >= L) { const last = vertices[vertices.length - 1]; return { e: last.e, n: last.n }; }
    let i = 1;
    while (i < cum.length && cum[i] < t) i++;
    const seg = cum[i] - cum[i - 1];
    const frac = seg > 0 ? (t - cum[i - 1]) / seg : 0;
    return {
      e: vertices[i - 1].e + frac * (vertices[i].e - vertices[i - 1].e),
      n: vertices[i - 1].n + frac * (vertices[i].n - vertices[i - 1].n),
    };
  };
  return { L, at };
}

/** Number of stations placed at 0, d, 2d, … that fit within length L (incl. 0). */
function stationCount(L: number, d: number): number {
  return Math.floor(L / d + 1e-9) + 1;
}

function dist2d(a: { e: number; n: number }, b: { e: number; n: number }): number {
  const de = a.e - b.e, dn = a.n - b.n;
  return Math.sqrt(de * de + dn * dn);
}

/**
 * Generate an {@link SPSData} from acquisition geometry. `mode:'2D'` walks each
 * picked line; `mode:'3D'` treats the picks as receiver lines and generates
 * perpendicular source lines (see {@link generate3D}). The output round-trips
 * through {@link buildSPS} → {@link parseSPSText} and passes {@link runSPSQC} with
 * no error-severity findings.
 */
export function generateSPS(params: CreateParams, proj: SPSProjection): SPSData {
  if (params.mode === '3D') return generate3D(params, proj);
  if (params.mode !== '2D') throw new Error(`generateSPS: unsupported mode '${params.mode}'`);
  if (!Array.isArray(params.lines) || params.lines.length === 0) throw new Error('generateSPS: at least one survey line is required');

  reqPos(params.rcvInterval, 'rcvInterval');
  reqPos(params.srcInterval, 'srcInterval');
  for (const [k, v] of Object.entries({
    rcvLineStart: params.rcvLineStart, rcvLineInc: params.rcvLineInc, rcvPointStart: params.rcvPointStart, rcvPointInc: params.rcvPointInc,
    srcLineStart: params.srcLineStart, srcLineInc: params.srcLineInc, srcPointStart: params.srcPointStart, srcPointInc: params.srcPointInc,
  })) reqFinite(v, k);

  const split = params.relation.type === 'split';
  if (split) reqPos(params.relation.channels ?? NaN, 'relation.channels');

  // Validate geometry + bound total point count BEFORE allocating.
  const geom = params.lines.map((ln, k) => {
    if (!ln || !Array.isArray(ln.vertices) || ln.vertices.length < 2)
      throw new Error(`generateSPS: line ${k} needs ≥2 vertices`);
    for (const v of ln.vertices) {
      if (!isFinite(v.e) || !isFinite(v.n)) throw new Error(`generateSPS: line ${k} has a non-finite vertex`);
    }
    return arcLength(ln.vertices);
  });
  let total = 0;
  for (const g of geom) total += stationCount(g.L, params.rcvInterval) + stationCount(g.L, params.srcInterval);
  if (total > MAX_GENERATED_POINTS)
    throw new Error(`generateSPS: ${total} points exceeds the cap of ${MAX_GENERATED_POINTS} (reduce lines/length or increase interval)`);

  const sources: SPSPoint[] = [];
  const receivers: SPSPoint[] = [];
  const xrefs: SPSXref[] = [];
  let ffid = 1;

  params.lines.forEach((_, k) => {
    const g = geom[k];
    const rcvLine = String(params.rcvLineStart + k * params.rcvLineInc);
    const srcLine = String(params.srcLineStart + k * params.srcLineInc);

    // Receivers along the line.
    const nR = stationCount(g.L, params.rcvInterval);
    const rcvPts: number[] = [];
    const rcvPos: { e: number; n: number }[] = [];
    for (let i = 0; i < nR; i++) {
      const pos = g.at(i * params.rcvInterval);
      const point = params.rcvPointStart + i * params.rcvPointInc;
      rcvPts.push(point);
      rcvPos.push(pos);
      receivers.push(mkPoint('R', rcvLine, point, pos, params.rcvType));
    }

    // Sources along the line + their cross-reference relations.
    const nS = stationCount(g.L, params.srcInterval);
    for (let j = 0; j < nS; j++) {
      const pos = g.at(j * params.srcInterval);
      const srcPt = params.srcPointStart + j * params.srcPointInc;
      sources.push(mkPoint('S', srcLine, srcPt, pos, params.srcType));
      if (nR === 0) continue;

      let winStart = 0, winEnd = nR - 1;
      if (split) {
        const ch = params.relation.channels!;
        // Receiver nearest the shot.
        let nearest = 0, best = Infinity;
        for (let i = 0; i < nR; i++) { const d = dist2d(pos, rcvPos[i]); if (d < best) { best = d; nearest = i; } }
        const half = Math.floor(ch / 2);
        winStart = Math.max(0, nearest - half);
        winEnd = Math.min(nR - 1, winStart + ch - 1);
        winStart = Math.max(0, winEnd - ch + 1); // re-clip the start if we hit the far end
      }
      xrefs.push({
        tape: '', ffid: ffid++, srcLine, srcPt, srcIdx: '1',
        fromCh: winStart + 1, toCh: winEnd + 1, chIncr: 1,
        rcvLine, rcvPtFrom: rcvPts[winStart], rcvPtTo: rcvPts[winEnd], rcvIdx: '1',
        rcvLineFrom: rcvLine, rcvLineTo: rcvLine, layout: 'SPS2.1',
      });
    }
  });

  return { sources, receivers, xrefs, headers: [], errors: [], skipped: 0, layout: 'SPS2.1', projection: proj };
}

/** Azimuth (degrees clockwise from North) → in-line unit vector in E/N. */
function unitFromAzimuth(azimuthDeg: number): { e: number; n: number } {
  const a = (azimuthDeg * Math.PI) / 180;
  return { e: Math.sin(a), n: Math.cos(a) };
}

/** One generated shot, kept in the (in-line s, cross-line t) frame for patching. */
interface Shot3D { srcLine: string; srcPt: number; s: number; t: number; }

/** Build one SPS 2.1 X relation row (single receiver line) for a 3D shot. */
function mkXref3D(ffid: number, shot: Shot3D, fromCh: number, toCh: number, rcvLine: string, rcvPtFrom: number, rcvPtTo: number): SPSXref {
  return {
    tape: '', ffid, srcLine: shot.srcLine, srcPt: shot.srcPt, srcIdx: '1',
    fromCh, toCh, chIncr: 1,
    rcvLine, rcvPtFrom, rcvPtTo, rcvIdx: '1',
    rcvLineFrom: rcvLine, rcvLineTo: rcvLine, layout: 'SPS2.1',
  };
}

/**
 * 3D acquisition. The picked polylines are the RECEIVER lines (receivers walked
 * along each by `rcvInterval`). SOURCE lines are generated PERPENDICULAR to the
 * receiver-line bearing (`azimuthDeg`, else the net direction first→last of the
 * longest picked line): parallel source lines spaced `srcLineSpacing` apart along
 * the in-line axis, each spanning the cross-line extent of the receiver spread,
 * with sources every `srcInterval`. `relation.type` selects the X model:
 *  - `full`  → FULL TEMPLATE: every shot records every receiver; one X row per
 *    receiver line covering its full point range, channels accumulating across
 *    lines, one ffid per shot.
 *  - `split` → MOVING PATCH: the `patchLines` receiver lines nearest cross-line to
 *    the shot × the `channels` stations nearest in-line, clipped to the survey;
 *    one X row per active line with a running channel offset, one ffid per shot.
 * Output round-trips through {@link buildSPS} → {@link parseSPSText} and is QC-clean.
 */
function generate3D(params: CreateParams, proj: SPSProjection): SPSData {
  if (!Array.isArray(params.lines) || params.lines.length === 0) throw new Error('generateSPS: at least one survey line is required');
  reqPos(params.rcvInterval, 'rcvInterval');
  reqPos(params.srcInterval, 'srcInterval');
  reqPos(params.srcLineSpacing ?? NaN, 'srcLineSpacing');
  for (const [k, v] of Object.entries({
    rcvLineStart: params.rcvLineStart, rcvLineInc: params.rcvLineInc, rcvPointStart: params.rcvPointStart, rcvPointInc: params.rcvPointInc,
    srcLineStart: params.srcLineStart, srcLineInc: params.srcLineInc, srcPointStart: params.srcPointStart, srcPointInc: params.srcPointInc,
  })) reqFinite(v, k);
  if (params.azimuthDeg != null) reqFinite(params.azimuthDeg, 'azimuthDeg');

  const split = params.relation.type === 'split';
  const channels = split ? Math.floor(params.relation.channels ?? CREATE_DEFAULTS.relation.channels) : 0;
  const patchLines = split ? Math.floor(params.relation.patchLines ?? CREATE_DEFAULTS.relation.patchLines) : 0;
  if (split) { reqPos(channels, 'relation.channels'); reqPos(patchLines, 'relation.patchLines'); }

  // Validate geometry + arc-length each receiver polyline.
  const geom = params.lines.map((ln, k) => {
    if (!ln || !Array.isArray(ln.vertices) || ln.vertices.length < 2)
      throw new Error(`generateSPS: line ${k} needs ≥2 vertices`);
    for (const vtx of ln.vertices) {
      if (!isFinite(vtx.e) || !isFinite(vtx.n)) throw new Error(`generateSPS: line ${k} has a non-finite vertex`);
    }
    return arcLength(ln.vertices);
  });

  // Receiver-line bearing → in-line unit vector u; cross-line unit v ⟂ u.
  let u: { e: number; n: number };
  if (params.azimuthDeg != null) {
    u = unitFromAzimuth(params.azimuthDeg);
  } else {
    let li = 0, best = -1;
    geom.forEach((g, i) => { if (g.L > best) { best = g.L; li = i; } });
    const vs = params.lines[li].vertices;
    const de = vs[vs.length - 1].e - vs[0].e, dn = vs[vs.length - 1].n - vs[0].n;
    const Llin = Math.sqrt(de * de + dn * dn);
    if (!(Llin > 0)) throw new Error('generateSPS: cannot derive a receiver-line bearing from the picks; pass azimuthDeg');
    u = { e: de / Llin, n: dn / Llin };
  }
  const cv = { e: -u.n, n: u.e };
  const sOf = (p: { e: number; n: number }): number => p.e * u.e + p.n * u.n;
  const tOf = (p: { e: number; n: number }): number => p.e * cv.e + p.n * cv.n;
  const world = (s: number, t: number): { e: number; n: number } => ({ e: s * u.e + t * cv.e, n: s * u.n + t * cv.n });

  // Bound the receiver count BEFORE allocating (DoS discipline).
  let totalR = 0;
  for (const g of geom) totalR += stationCount(g.L, params.rcvInterval);
  if (totalR > MAX_GENERATED_POINTS)
    throw new Error(`generateSPS: ${totalR} receivers exceeds the cap of ${MAX_GENERATED_POINTS} (reduce lines/length or increase rcvInterval)`);

  // Receivers along each picked (receiver) line; track per-line station list +
  // in-line coords + mean cross-line coord, and the global (s,t) bounding box.
  const receivers: SPSPoint[] = [];
  interface RLine { name: string; points: number[]; s: number[]; meanT: number; }
  const rlines: RLine[] = [];
  let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
  params.lines.forEach((_, k) => {
    const g = geom[k];
    const name = String(params.rcvLineStart + k * params.rcvLineInc);
    const nR = stationCount(g.L, params.rcvInterval);
    const points: number[] = [], sArr: number[] = [];
    let tsum = 0;
    for (let i = 0; i < nR; i++) {
      const pos = g.at(i * params.rcvInterval);
      const point = params.rcvPointStart + i * params.rcvPointInc;
      receivers.push(mkPoint('R', name, point, pos, params.rcvType));
      const s = sOf(pos), t = tOf(pos);
      points.push(point); sArr.push(s); tsum += t;
      if (s < sMin) sMin = s;
      if (s > sMax) sMax = s;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
    rlines.push({ name, points, s: sArr, meanT: nR ? tsum / nR : 0 });
  });
  if (!isFinite(sMin) || !isFinite(tMin)) throw new Error('generateSPS: no receivers were generated (check intervals/geometry)');

  // Source lines run along v (⟂ to u), spaced srcLineSpacing apart across the
  // in-line extent; each spans the cross-line extent, sources every srcInterval.
  const inlineExtent = sMax - sMin;
  const crossExtent = tMax - tMin;
  const nSL = Math.floor(inlineExtent / params.srcLineSpacing! + 1e-9) + 1;
  const nSrcPerLine = Math.floor(crossExtent / params.srcInterval + 1e-9) + 1;
  const totalS = nSL * nSrcPerLine;
  if (totalR + totalS > MAX_GENERATED_POINTS)
    throw new Error(`generateSPS: ${totalR + totalS} points exceeds the cap of ${MAX_GENERATED_POINTS} (increase intervals / srcLineSpacing or reduce extent)`);

  const sources: SPSPoint[] = [];
  const shots: Shot3D[] = [];
  for (let m = 0; m < nSL; m++) {
    const sCoord = sMin + m * params.srcLineSpacing!;
    const srcLine = String(params.srcLineStart + m * params.srcLineInc);
    for (let j = 0; j < nSrcPerLine; j++) {
      const tCoord = tMin + j * params.srcInterval;
      const srcPt = params.srcPointStart + j * params.srcPointInc;
      sources.push(mkPoint('S', srcLine, srcPt, world(sCoord, tCoord), params.srcType));
      shots.push({ srcLine, srcPt, s: sCoord, t: tCoord });
    }
  }

  // X relations. Bound the row count BEFORE allocating.
  const nRcvLines = rlines.length;
  const rowsPerShot = split ? Math.min(patchLines, nRcvLines) : nRcvLines;
  if (totalS * rowsPerShot > MAX_GENERATED_POINTS)
    throw new Error(`generateSPS: ${totalS * rowsPerShot} X-relations exceeds the cap of ${MAX_GENERATED_POINTS} (use a smaller patch / fewer shots)`);

  const xrefs: SPSXref[] = [];
  let ffid = 1;
  for (const shot of shots) {
    let ch0 = 0;
    if (!split) {
      // FULL TEMPLATE: every shot records every receiver; channels accumulate
      // across receiver lines, one X row per line covering its full point range.
      for (const rl of rlines) {
        const nR = rl.points.length;
        if (!nR) continue;
        xrefs.push(mkXref3D(ffid, shot, ch0 + 1, ch0 + nR, rl.name, rl.points[0], rl.points[nR - 1]));
        ch0 += nR;
      }
    } else {
      // MOVING PATCH: the patchLines receiver lines nearest cross-line to the shot
      // × the channels stations nearest in-line, clipped to the survey. Patch lines
      // are accumulated in natural (line-index) order for a stable channel offset.
      const order = rlines
        .map((rl, idx) => ({ idx, d: Math.abs(rl.meanT - shot.t) }))
        .sort((a, b) => a.d - b.d || a.idx - b.idx)
        .slice(0, Math.min(patchLines, nRcvLines))
        .map((o) => o.idx)
        .sort((a, b) => a - b);
      for (const idx of order) {
        const rl = rlines[idx];
        const nR = rl.points.length;
        if (!nR) continue;
        let nearest = 0, best = Infinity;
        for (let i = 0; i < nR; i++) { const dd = Math.abs(rl.s[i] - shot.s); if (dd < best) { best = dd; nearest = i; } }
        const half = Math.floor(channels / 2);
        let winStart = Math.max(0, nearest - half);
        const winEnd = Math.min(nR - 1, winStart + channels - 1);
        winStart = Math.max(0, winEnd - channels + 1); // re-clip the start if we hit the far end
        const cnt = winEnd - winStart + 1;
        xrefs.push(mkXref3D(ffid, shot, ch0 + 1, ch0 + cnt, rl.name, rl.points[winStart], rl.points[winEnd]));
        ch0 += cnt;
      }
    }
    ffid++;
  }

  return { sources, receivers, xrefs, headers: [], errors: [], skipped: 0, layout: 'SPS2.1', projection: proj };
}

function mkPoint(rtype: 'S' | 'R', lineName: string, point: number, pos: { e: number; n: number }, type?: string): SPSPoint {
  const p: SPSPoint = {
    rtype, lineName, point, idx: '1',
    easting: pos.e, northing: pos.n, elevation: 0,
    raw: '', lineNum: 0,
  };
  if (type && rtype === 'S') p.srcType = type;
  return p;
}
