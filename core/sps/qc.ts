// seisconv-core / sps - survey QC checks.
//
// Pure quality-control over parsed SPS data: per-line duplicates, point gaps and
// intervals, X-file source/receiver existence, elevation plausibility, and max
// offset. Ported from the SeisConv reference (globals → parameters).

import type { SPSData, SPSPoint } from './parse';

export interface QCParams {
  /** Max allowed source point gap (m); 0 = disabled. */
  maxSrc?: number;
  /** Expected source interval (m); 0 = disabled. */
  srcInt?: number;
  /** Interval tolerance (m). */
  tol?: number;
  /** Max allowed receiver point gap (m); 0 = disabled. */
  maxRcv?: number;
  /** Expected receiver interval (m); 0 = disabled. */
  rcvInt?: number;
  /** Max source→receiver offset (m); 0 = disabled. */
  maxOff?: number;
}

export interface QCResult {
  sev: 'error' | 'warn' | 'ok';
  cat: string;
  msg: string;
  pts?: SPSPoint[];
}

const DEFAULTS: Required<QCParams> = { maxSrc: 0, srcInt: 0, tol: 1, maxRcv: 0, rcvInt: 0, maxOff: 0 };

function dist2d(a: SPSPoint, b: SPSPoint): number {
  const de = a.easting - b.easting;
  const dn = a.northing - b.northing;
  return Math.sqrt(de * de + dn * dn);
}

export function groupByLine(arr: SPSPoint[]): Record<string, SPSPoint[]> {
  const g: Record<string, SPSPoint[]> = {};
  for (const p of arr) {
    const k = (p.lineName || '').trim();
    (g[k] ||= []).push(p);
  }
  for (const k in g) g[k].sort((a, b) => a.point - b.point);
  return g;
}

function num(v: string | number | undefined): number {
  return typeof v === 'number' ? v : v != null ? parseFloat(v) : NaN;
}

export function runSPSQC(data: SPSData, params: QCParams = {}): QCResult[] {
  const p = { ...DEFAULTS, ...params };
  const res: QCResult[] = [];
  const srcByLine = groupByLine(data.sources);
  const rcvByLine = groupByLine(data.receivers);

  const lineSeq = (byLine: Record<string, SPSPoint[]>, label: string, kind: string, maxGap: number, interval: number) => {
    for (const [line, pts] of Object.entries(byLine)) {
      const seen = new Set<string>();
      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i];
        const key = `${pt.point}_${pt.idx}`;
        if (seen.has(key)) {
          res.push({ sev: 'error', cat: 'Duplicate', msg: `Duplicate ${kind}: Line ${line} ${label} ${pt.point}${pt.idx ? '.' + pt.idx : ''}`, pts: [pt] });
          continue;
        }
        seen.add(key);
        if (i === 0) continue;
        const prev = pts[i - 1];
        const d = dist2d(pt, prev);
        if (maxGap > 0 && d > maxGap)
          res.push({ sev: 'error', cat: 'Gap', msg: `${kind} gap: Line ${line} ${label} ${prev.point}→${pt.point} = ${d.toFixed(1)}m (max ${maxGap}m)`, pts: [prev, pt] });
        if (interval > 0 && Math.abs(d - interval) > p.tol)
          res.push({ sev: 'warn', cat: 'Interval', msg: `${kind} interval: Line ${line} ${label} ${prev.point}→${pt.point} = ${d.toFixed(1)}m (expected ${interval}±${p.tol}m)`, pts: [prev, pt] });
      }
    }
  };

  lineSeq(srcByLine, 'SP', 'source', p.maxSrc, p.srcInt);
  lineSeq(rcvByLine, 'ST', 'receiver', p.maxRcv, p.rcvInt);

  // X-file existence checks
  if (data.xrefs.length > 0) {
    const srcMap = new Map(data.sources.map((s) => [`${s.lineName}|${s.point}`, s]));
    for (const x of data.xrefs) {
      if (!srcMap.has(`${x.srcLine}|${num(x.srcPt)}`))
        res.push({ sev: 'error', cat: 'X-Ref', msg: `Missing source in X-file: Line ${x.srcLine} SP ${x.srcPt} (FFID ${x.ffid})` });
      // A relation can span rcvLineFrom..rcvLineTo: rcvPtFrom lives on rcvLineFrom
      // and rcvPtTo on rcvLineTo. Resolve each endpoint against ITS OWN line so a
      // cross-line relation isn't range-checked against the wrong station list
      // (which would yield spurious or missed warnings). When they're the same
      // line this reduces to the original single-line check.
      const fromLine = String(x.rcvLineFrom).trim();
      const toLine = String(x.rcvLineTo ?? x.rcvLineFrom).trim();
      const rangeOf = (pts: number[]) => {
        let lo = Infinity, hi = -Infinity;
        for (const v of pts) { if (v < lo) lo = v; if (v > hi) hi = v; }
        return { lo, hi, n: pts.length };
      };
      const fromR = rangeOf((rcvByLine[fromLine] || []).map((r) => r.point));
      const toR = toLine === fromLine ? fromR : rangeOf((rcvByLine[toLine] || []).map((r) => r.point));
      const fromBad = fromR.n > 0 && num(x.rcvPtFrom) < fromR.lo;
      const toBad = toR.n > 0 && num(x.rcvPtTo) > toR.hi;
      if (fromBad || toBad)
        res.push({ sev: 'warn', cat: 'X-Ref', msg: `X-file receiver range may exceed station list: Line ${x.rcvLineFrom}${toLine !== fromLine ? `-${x.rcvLineTo}` : ''} ST ${x.rcvPtFrom}-${x.rcvPtTo}` });
    }
  }

  // Elevation plausibility
  for (const p2 of [...data.sources, ...data.receivers]) {
    if (!isFinite(p2.elevation)) continue;
    if (p2.elevation < -500 || p2.elevation > 8849)
      res.push({ sev: 'warn', cat: 'Elevation', msg: `Suspicious elevation: ${p2.rtype} Line ${p2.lineName} #${p2.point}: ${p2.elevation}m`, pts: [p2] });
  }

  // Max offset (sampled)
  if (p.maxOff > 0 && data.xrefs.length > 0) {
    const srcMap = new Map(data.sources.map((s) => [`${s.lineName}|${s.point}`, s]));
    const rcvMap = new Map(data.receivers.map((r) => [`${r.lineName}|${r.point}`, r]));
    for (const x of data.xrefs.slice(0, 2000)) {
      const src = srcMap.get(`${x.srcLine}|${num(x.srcPt)}`);
      if (!src) continue;
      const from = num(x.rcvPtFrom), to = num(x.rcvPtTo), incr = Math.max(1, num(x.rcvPtIncr) || 1);
      for (let rp = from; rp <= to; rp += incr) {
        const rcv = rcvMap.get(`${String(x.rcvLineFrom).trim()}|${rp}`);
        if (!rcv) continue;
        const off = dist2d(src, rcv);
        if (off > p.maxOff) {
          res.push({ sev: 'warn', cat: 'Offset', msg: `Max offset exceeded: SP ${x.srcPt} line ${x.srcLine} → ST ${rp} = ${off.toFixed(0)}m (max ${p.maxOff}m)`, pts: [src, rcv] });
          break;
        }
      }
    }
  }

  // Aggregate repeated identical findings: real files can emit the same message
  // hundreds of times (Tveria: one X-file receiver-range warning × 389 relations),
  // which buries every other finding. Collapse exact (sev, cat, msg) repeats into
  // the first occurrence with a ×count suffix; order and pts are preserved from
  // the first occurrence.
  const counts = new Map<string, { first: QCResult; n: number }>();
  const collapsed: QCResult[] = [];
  for (const r of res) {
    const k = `${r.sev}${r.cat}${r.msg}`;
    const hit = counts.get(k);
    if (hit) { hit.n++; continue; }
    counts.set(k, { first: r, n: 1 });
    collapsed.push(r);
  }
  for (const { first, n } of counts.values()) if (n > 1) first.msg = `${first.msg} (×${n})`;

  if (!collapsed.length) collapsed.push({ sev: 'ok', cat: 'QC', msg: 'No issues found.' });
  return collapsed;
}
