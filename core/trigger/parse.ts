// seisconv-core - trigger-message parsers (Observer Log "Trigger Watch").
//
// Pure, framework-free parsers for the live shot-trigger feeds. No Node/DOM
// imports so they run in main, the worker, and the unit tests unchanged.
//
// Two wire formats are understood:
//   • Serial trigger-box lines - the serial ESP32 trigger box emits
//         [SHOT] #<id> L<line>:SP<sp> ts=<gps-iso>
//     on USB-serial at every contact closure. The parse is TOLERANT: any
//     spacing/case, any subset of the id / line:SP / ts fields, and any generic
//     "TRIG"-style line (bare `TRIG`, `TRIGGER 5`, …) is also accepted so other
//     trigger hardware can feed the same path.
//   • UDP datagrams - either one-line text (same grammar as serial) or a small
//     JSON object like {"trig":12,"sp":1042,"line":"0395","ts":"…"}.
//
// Everything here is DEFENSIVE: inputs are length-capped, control characters
// are stripped, numbers are range-checked, and anything unparseable returns
// null (caller drops the packet) instead of throwing.

/** One parsed trigger message, normalised across serial/UDP wire formats. */
export interface TriggerMsg {
  /** 'shot' = an explicit [SHOT] record (or JSON with an id/SP); 'trig' = a
   *  generic trigger line with no shot identity. */
  kind: 'shot' | 'trig';
  /** Trigger-box shot counter (`#<id>`), or null when absent. */
  id: number | null;
  /** Source line label (`L<line>:`), or null. */
  line: string | null;
  /** Source point (`SP<sp>`), or null. */
  sp: number | null;
  /** Timestamp TEXT as sent (`ts=<…>`, GPS ISO or HH:MM:SS) - not validated as
   *  a date here; the consumer decides how to interpret it. Null when absent. */
  ts: string | null;
  /** The cleaned line/datagram the fields were parsed from (audit trail). */
  raw: string;
}

/** Hard cap on any single trigger line / datagram we will look at. */
export const TRIGGER_TEXT_MAX = 512;

// Control characters (except tab) are stripped before parsing; a serial feed
// can glitch mid-byte and a UDP packet is attacker-controllable.
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Length-cap + control-strip + trim. Null when not a usable one-liner. */
function cleanText(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > TRIGGER_TEXT_MAX) return null;
  const s = raw.replace(/[\r\n]+/g, ' ').replace(CTRL_RE, '').trim();
  return s === '' ? null : s;
}

/** Parse a decimal string to a finite number, or null. */
function toNum(s: string | undefined | null): number | null {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one serial trigger-box line. Returns null when the line is not a
 * trigger message (boot chatter, GPS NMEA, corruption) so the reader can skip
 * it silently. Field extraction is piecewise (id / L:SP / ts each optional) so
 * firmware variations in spacing or field order still parse.
 */
export function parseTriggerLine(raw: unknown): TriggerMsg | null {
  const s = cleanText(raw);
  if (s == null) return null;
  const isShot = /\[\s*SHOT\s*\]/i.test(s);
  // Generic trigger lines from other hardware ("TRIG", "TRIGGER 5", …).
  const isTrig = /\bTRIG(?:GER)?\b/i.test(s);
  if (!isShot && !isTrig) return null;
  // `#<id>` anywhere in the line (≤ 9 digits so it can't overflow anything).
  let id = toNum(/#\s*(\d{1,9})\b/.exec(s)?.[1]);
  // A generic "TRIGGER 5" without '#': take the number right after the keyword.
  if (id == null && !isShot) id = toNum(/\bTRIG(?:GER)?\b[^\d-]{0,8}(\d{1,9})\b/i.exec(s)?.[1]);
  // `L<line>:SP<sp>` - line label ≤ 32 chars, SP may be negative / fractional.
  const lp = /\bL\s*([A-Za-z0-9._-]{1,32})\s*:\s*SP\s*(-?\d{1,9}(?:\.\d{1,6})?)\b/i.exec(s);
  // `ts=<token>` - kept as TEXT (GPS ISO / HH:MM:SS), ≤ 64 chars.
  const ts = /\bts\s*=\s*(\S{1,64})/i.exec(s)?.[1] ?? null;
  return {
    kind: isShot ? 'shot' : 'trig',
    id,
    line: lp ? lp[1] : null,
    sp: lp ? toNum(lp[2]) : null,
    ts,
    raw: s,
  };
}

/**
 * Parse one UDP datagram (already decoded to text; caller enforces the byte
 * cap, this re-caps characters). Accepts a JSON object - recognised keys:
 * `trig`/`id`/`shot` (number), `sp` (number), `line` (string ≤ 32), `ts`/`time`
 * (ISO string ≤ 64, or epoch seconds/milliseconds) - or falls through to the
 * plain-text line grammar. Returns null for anything else (packet dropped).
 */
export function parseUdpTrigger(raw: unknown): TriggerMsg | null {
  const s = cleanText(raw);
  if (s == null) return null;
  if (!s.startsWith('{')) return parseTriggerLine(s);
  let parsed: unknown;
  try { parsed = JSON.parse(s); } catch { return null; }
  // Only a plain object is a trigger message. (JSON.parse never assigns the
  // prototype, so a crafted "__proto__" key is inert - we also only READ a
  // fixed set of own keys below.)
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const idRaw = o['trig'] ?? o['id'] ?? o['shot'];
  const id = typeof idRaw === 'number' && Number.isFinite(idRaw) && idRaw >= 0 && idRaw <= 1e9
    ? Math.floor(idRaw) : null;
  const spRaw = o['sp'];
  const sp = typeof spRaw === 'number' && Number.isFinite(spRaw) && Math.abs(spRaw) <= 1e9 ? spRaw : null;
  const lineRaw = o['line'];
  const line = typeof lineRaw === 'string' && lineRaw.length > 0 && lineRaw.length <= 32
    ? (lineRaw.replace(CTRL_RE, '').trim() || null) : null;
  let ts: string | null = null;
  const tsRaw = o['ts'] ?? o['time'];
  if (typeof tsRaw === 'string' && tsRaw.length > 0 && tsRaw.length <= 64) {
    ts = tsRaw.replace(CTRL_RE, '').trim() || null;
  } else if (typeof tsRaw === 'number' && Number.isFinite(tsRaw) && tsRaw > 0) {
    // Epoch heuristic: ≥ 1e11 ⇒ milliseconds, else seconds. Range-checked so
    // Date never sees a value it can't represent.
    const ms = tsRaw >= 1e11 ? tsRaw : tsRaw * 1000;
    if (ms < 4e12) { try { ts = new Date(ms).toISOString(); } catch { ts = null; } }
  }
  // A JSON packet with none of the trigger fields is noise, not a trigger.
  if (id == null && sp == null && ts == null) return null;
  return { kind: id != null || sp != null ? 'shot' : 'trig', id, line, sp, ts, raw: s };
}

/**
 * One parsed line of the Geometrics SCS survey log (`SC_Survey.####.log`). SCS
 * writes ONE line per shot at TRIGGER time - even when the shot is never saved -
 * so tailing this log is the true, file-independent trigger feed. `kb`/`status`
 * are present only on a `SAVED`/`READ` tail; a `READ` line is a file RE-READ,
 * not a new shot, so the caller must skip it (see `status`).
 */
export interface ScsLogShot {
  /** SCS "File" number - the record/FFID counter. */
  shot: number;
  /** Stack index within this file (`Stack N`). */
  stack: number;
  /** Shot location in metres (may be negative / fractional). */
  shotLoc: number;
  /** Timestamp TEXT as logged (`HH:MM:SS.ss`) - not re-interpreted here. */
  time: string;
  /** Date TEXT as logged (`MM/DD/YYYY`). */
  date: string;
  /** File size in KBytes, when the line carried a SAVED/READ tail. */
  kb?: number;
  /** 'SAVED' = shot written to disk; 'READ' = an existing file re-read (skip). */
  status?: 'SAVED' | 'READ';
}

// One SCS survey-log shot record. The whole status tail is OPTIONAL (an unsaved
// shot is logged with only its time/date) and, WITHIN it, the `<n> KBytes` size
// is itself optional: on real SCS 11.1.69 a SAVED line carries the size
// (`… 208 KBytes SAVED`) but a re-read is logged WITHOUT it (`… 06/26/2024 READ`).
// Keeping KBytes optional is what lets `status === 'READ'` fire for those bare
// re-read lines so the caller can skip them (a `KBytes`-required tail would miss
// them and wrongly emit a phantom shot). No `$` anchor - trailing spaces (already
// trimmed by cleanText) or extra tokens don't defeat the match.
const SCS_LOG_RE = /^\s*File\s+(\d+)\s+\(Stack\s+(\d+),\s*Shot Loc:\s*(-?\d+(?:\.\d+)?)\s*Meters\)\s+(\d{2}:\d{2}:\d{2}\.\d{2})\s+(\d{2}\/\d{2}\/\d{4})(?:\s+(?:(\d+)\s+KBytes\s+)?(SAVED|READ))?/;

/**
 * Parse one line of the SCS survey log. Returns null for any non-shot line
 * (banner, blank line, `READ`-only re-read chatter that doesn't match the shot
 * grammar, corruption) so the tail reader can skip it silently. A matching line
 * with `status === 'READ'` DOES parse (so the caller can dedupe on it) but the
 * caller MUST NOT treat it as a new shot.
 */
export function parseScsLogLine(line: unknown): ScsLogShot | null {
  const s = cleanText(line);
  if (s == null) return null;
  const m = SCS_LOG_RE.exec(s);
  if (!m) return null;
  const shot = toNum(m[1]);
  const stack = toNum(m[2]);
  const shotLoc = toNum(m[3]);
  if (shot == null || stack == null || shotLoc == null) return null;
  const out: ScsLogShot = { shot, stack, shotLoc, time: m[4], date: m[5] };
  if (m[6] != null) { const kb = toNum(m[6]); if (kb != null) out.kb = kb; }
  if (m[7] === 'SAVED' || m[7] === 'READ') out.status = m[7];
  return out;
}

/**
 * Dedupe key for a parsed SCS shot: `<shot>@<time>`. Two stacks of the SAME
 * file number are logged at different ms timestamps ⇒ distinct keys (both are
 * real shots); an identical line replayed on a re-read collapses to one key.
 */
export function scsLogKey(p: { shot: number; time: string }): string {
  return `${p.shot}@${p.time}`;
}

// -- SCS TempCom passive-trigger source (core/trigger, framework-free) --
// SCS touches ~6 scratch files in C:\GeometricsSurveysAndSettings\SC\TempCom
// (TmpH0.00N, TmpN0.00N, …) at the instant of EACH trigger - even for shots that
// are never saved - so a fs.watch on that folder is a PASSIVE, file-independent
// trigger feed (we NEVER write to it or send SCS any input). Two pure helpers so
// the "one physical trigger = exactly one row" behaviour is unit-testable.

/** Default collapse window: one physical trigger touches several `Tmp*` files
 *  within a few hundred ms, so all touches inside this window are ONE trigger. */
export const SCS_TRIG_WINDOW_MS = 1200;

/**
 * Does a TempCom filename count as an SCS trigger touch? SCS rewrites its `Tmp*`
 * scratch files at every trigger, so those touches ARE the event; `STAT.*` is a
 * periodic heartbeat that fires between shots and must be ignored. Anything else
 * (empty, non-string, oversized, or a sub-path with no `Tmp*` basename) is not a
 * trigger. Case-insensitive; any path separators are stripped so a watcher event
 * that carries a sub-path still matches on its basename.
 */
export function isScsTrigTouch(name: unknown): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 260) return false;
  const base = name.split(/[\\/]/).pop() ?? '';
  if (base === '' || /^STAT\./i.test(base)) return false;   // heartbeat, not a trigger
  return /^Tmp/i.test(base);
}

/**
 * Leading-edge debounce over a sequence of accepted TempCom touch times (ms):
 * returns how many DISTINCT trigger events they collapse to. The first touch
 * emits; every later touch within `windowMs` of the last EMITTED touch is
 * absorbed into it. This is the exact rule the live watcher applies, factored
 * out so a simulated 6-file burst can be asserted to yield exactly one event.
 */
export function scsTrigCollapse(touchMs: number[], windowMs: number = SCS_TRIG_WINDOW_MS): number {
  let emitted = 0;
  let lastEmit = -Infinity;
  for (const t of touchMs) {
    if (!(typeof t === 'number' && Number.isFinite(t))) continue;
    if (t - lastEmit >= windowMs) { emitted++; lastEmit = t; }
  }
  return emitted;
}
