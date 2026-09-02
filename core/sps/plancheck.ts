// seisconv-core / sps - QC for a survey PLAN (geometry still being designed).
//
// Distinct from `qc.ts` / runSPSQC, which grades a GENERATED survey: a plan has no
// X-file, no source/receiver split and possibly no CRS, so most of those checks are
// inapplicable - and running them live would mean regenerating the whole survey on
// every keystroke. These checks answer the only question that matters before
// Generate: "is this geometry self-consistent enough to become a survey?"
//
// `distM` is INJECTED rather than imported so this module stays CRS-agnostic. The
// renderer passes a function that measures in the chosen survey CRS and falls back
// to a spherical distance; a test can pass anything, including one that returns NaN.
//
// PURE: no DOM, no Node. Never throws; every collector is bounded.

/** One point of a plan, as the checker needs to see it. */
export interface PlanCheckPoint {
  lat: number;
  lon: number;
  /** Preplot station number, or null when the point is an un-numbered bend point. */
  station: number | null;
  elev: number | null;
}

/** One acquisition line of a plan. */
export interface PlanCheckLine {
  id: number;
  name: string;
  /** 'preplot' points are placed verbatim; 'resample' points are polyline vertices. */
  kind: 'preplot' | 'resample';
  points: PlanCheckPoint[];
}

/** One problem found. `cat` is a stable slug the UI may group or filter on. */
export interface PlanFinding {
  sev: 'error' | 'warn' | 'info';
  cat: string;
  msg: string;
  lineId?: number;
  /** Index into that line's `points`, when the finding names a single point. */
  ptIdx?: number;
}

/** Per-line geometry summary - what the legend renders. */
export interface PlanStats {
  lineId: number;
  name: string;
  count: number;
  lengthM: number;
  medianSegM: number;
  minSegM: number;
  maxSegM: number;
}

export interface PlanCheckResult {
  findings: PlanFinding[];
  stats: PlanStats[];
  totalPoints: number;
  totalLengthM: number;
  /** True when `maxFindings` stopped the collector. */
  truncated: boolean;
  /** How many findings were dropped by that cap. */
  omitted: number;
}

/** Default tolerance for the station-interval regularity check, in percent. */
const DEFAULT_SEG_TOL_PCT = 15;
/** Default distance under which two stations count as coincident, in metres. */
const DEFAULT_DUP_TOL_M = 0.5;
/** Default cap on reported findings. */
const DEFAULT_MAX_FINDINGS = 200;
/** A segment this many times the line median is a gross outlier (a typo'd digit),
 *  not merely an irregular interval. */
const OUTLIER_FACTOR = 10;
/** Plausible ground elevations, metres. Outside this is almost always a unit or
 *  column error rather than real terrain (Dead Sea shore is about -430 m). */
const ELEV_MIN_M = -500;
const ELEV_MAX_M = 9000;

/** Median of a numeric list. Empty -> 0. Does not mutate the input. */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Round for display without ever emitting NaN into a message. */
function m1(v: number): string {
  return isFinite(v) ? v.toFixed(1) : '?';
}

/**
 * Check a survey plan.
 *
 * Every distance comes from `distM`; a non-finite result is treated as "unknown"
 * and simply drops out of the statistics rather than poisoning them, so no NaN can
 * reach a caller (and from there a canvas).
 *
 * CONTRACT: never throws.
 */
export function checkPlan(
  lines: PlanCheckLine[],
  distM: (aLat: number, aLon: number, bLat: number, bLon: number) => number,
  opts?: { segTolPct?: number; dupTolM?: number; maxFindings?: number },
): PlanCheckResult {
  const out: PlanCheckResult = { findings: [], stats: [], totalPoints: 0, totalLengthM: 0, truncated: false, omitted: 0 };
  const tolPct = Number.isFinite(opts?.segTolPct) ? Math.max(0, opts!.segTolPct!) : DEFAULT_SEG_TOL_PCT;
  const dupTol = Number.isFinite(opts?.dupTolM) ? Math.max(0, opts!.dupTolM!) : DEFAULT_DUP_TOL_M;
  const maxFindings = Number.isFinite(opts?.maxFindings) ? Math.max(1, opts!.maxFindings!) : DEFAULT_MAX_FINDINGS;

  const add = (f: PlanFinding) => {
    if (out.findings.length >= maxFindings) {
      out.truncated = true;
      out.omitted++;
      return;
    }
    out.findings.push(f);
  };

  try {
    const ls = Array.isArray(lines) ? lines : [];

    // -- check 2: duplicate line names (two lines with one name merge in SPS) --
    const nameSeen = new Map<string, number>();
    for (const ln of ls) {
      const nm = (ln?.name ?? '').trim();
      if (!nm) continue;
      const prev = nameSeen.get(nm);
      if (prev === undefined) nameSeen.set(nm, ln.id);
      else add({ sev: 'error', cat: 'line-name', msg: `Line name "${nm}" is used more than once - the two lines would merge into one in the generated survey.`, lineId: ln.id });
    }

    // Cross-line station numbers, for the informational check.
    const stationLines = new Map<number, Set<number>>();

    for (const ln of ls) {
      if (!ln || !Array.isArray(ln.points)) continue;
      const pts = ln.points;
      const nm = (ln.name ?? '').trim() || String(ln.id);
      out.totalPoints += pts.length;

      // -- check 7: a line needs two points to be a line --
      if (pts.length < 2) {
        add({ sev: 'error', cat: 'short-line', msg: `Line ${nm} has ${pts.length} point${pts.length === 1 ? '' : 's'} - a line needs at least 2.`, lineId: ln.id });
      }

      // -- segment lengths (unknown distances drop out rather than becoming NaN) --
      const segs: (number | null)[] = new Array(pts.length).fill(null);
      const known: number[] = [];
      let lengthM = 0;
      for (let i = 1; i < pts.length; i++) {
        const d = distM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
        if (isFinite(d)) {
          segs[i] = d;
          known.push(d);
          lengthM += d;
        }
      }
      const med = median(known);
      out.stats.push({
        lineId: ln.id,
        name: nm,
        count: pts.length,
        lengthM,
        medianSegM: med,
        minSegM: known.length ? Math.min(...known) : 0,
        maxSegM: known.length ? Math.max(...known) : 0,
      });
      out.totalLengthM += lengthM;

      // -- checks 3, 4 and 8: segment geometry --
      for (let i = 1; i < pts.length; i++) {
        const d = segs[i];
        if (d === null) continue;
        const from = pts[i - 1].station ?? i;
        const to = pts[i].station ?? i + 1;
        if (d <= dupTol) {
          add({
            sev: 'error',
            cat: 'coincident',
            msg: `Line ${nm}: ${from} and ${to} are ${m1(d)} m apart - effectively the same position. A zero-length segment cannot be laid out.`,
            lineId: ln.id, ptIdx: i,
          });
          continue;
        }
        if (!med) continue;
        if (d > OUTLIER_FACTOR * med) {
          add({
            sev: 'warn',
            cat: 'outlier',
            msg: `Line ${nm}: ${from} to ${to} is ${m1(d)} m, over ${OUTLIER_FACTOR}x the line median of ${m1(med)} m - check for a mistyped coordinate.`,
            lineId: ln.id, ptIdx: i,
          });
        } else if (Math.abs(d - med) > (tolPct / 100) * med) {
          add({
            sev: 'warn',
            cat: 'interval',
            msg: `Line ${nm}: ${from} to ${to} is ${m1(d)} m against a median of ${m1(med)} m.`,
            lineId: ln.id, ptIdx: i,
          });
        }
      }

      // -- checks 1, 5, 6 and 9: station numbering and elevation --
      const seenStation = new Map<number, number>(); // station -> first index
      let missingStations = 0;
      let lastStation: number | null = null;
      let monotonicReported = false;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const s = p.station;

        if (s == null || !Number.isFinite(s)) {
          missingStations++;
        } else {
          const first = seenStation.get(s);
          if (first === undefined) seenStation.set(s, i);
          else {
            add({
              sev: 'error',
              cat: 'dup-station',
              msg: `Line ${nm}: station ${s} appears twice (rows ${first + 1} and ${i + 1}).`,
              lineId: ln.id, ptIdx: i,
            });
          }
          if (lastStation != null && s < lastStation && !monotonicReported) {
            monotonicReported = true; // one per line - a shuffled import would spam
            add({
              sev: 'warn',
              cat: 'monotonic',
              msg: `Line ${nm}: station numbers do not increase along the line (${lastStation} then ${s}). Sorting by line and station fixes this.`,
              lineId: ln.id, ptIdx: i,
            });
          }
          lastStation = s;
          let set = stationLines.get(s);
          if (!set) { set = new Set(); stationLines.set(s, set); }
          set.add(ln.id);
        }

        if (p.elev != null && Number.isFinite(p.elev) && (p.elev < ELEV_MIN_M || p.elev > ELEV_MAX_M)) {
          add({
            sev: 'warn',
            cat: 'elevation',
            msg: `Line ${nm}: elevation ${m1(p.elev)} m at row ${i + 1} is outside ${ELEV_MIN_M}..${ELEV_MAX_M} m - check the units and the column.`,
            lineId: ln.id, ptIdx: i,
          });
        }
      }

      // -- check 6: a preplot line is defined by its numbers; it cannot lack them --
      if (ln.kind === 'preplot' && missingStations > 0) {
        add({
          sev: 'error',
          cat: 'no-station',
          msg: `Line ${nm} is a preplot (stations used as-is) but ${missingStations} point${missingStations === 1 ? ' has' : 's have'} no station number. Renumber the line, or switch it to re-sample.`,
          lineId: ln.id,
        });
      }
    }

    // -- check 1b: the same station number on more than one line is normal in SPS
    // (numbering is per line), so this is information, never an error. --
    let crossLine = 0;
    for (const set of stationLines.values()) if (set.size > 1) crossLine++;
    if (crossLine > 0 && ls.length > 1) {
      add({
        sev: 'info',
        cat: 'dup-station-cross',
        msg: `${crossLine} station number${crossLine === 1 ? ' is' : 's are'} used on more than one line. That is normal in SPS, where numbering is per line.`,
      });
    }

    // Severity first, so the panel leads with what blocks a generation. Stable
    // within a severity, so the order stays predictable between runs.
    const rank = { error: 0, warn: 1, info: 2 } as const;
    out.findings = out.findings
      .map((f, i) => ({ f, i }))
      .sort((a, b) => rank[a.f.sev] - rank[b.f.sev] || a.i - b.i)
      .map((x) => x.f);
  } catch (e) {
    out.findings.push({ sev: 'error', cat: 'internal', msg: `Plan check failed - ${(e as Error).message}` });
  }
  return out;
}
