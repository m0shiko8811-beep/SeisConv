// seisconv-core - release version comparison + release-note marker parsing.
//
// Behind the on-demand "Check for updates" action: the main process asks GitHub
// for the newest published release and has to decide whether that tag is really
// newer than the running build, and whether its notes were deliberately marked
// critical. All of that is pure string work with no network and no DOM, so it
// lives here and is unit-tested like every other parser in core.
//
// EVERYTHING HERE IS UNTRUSTED TEXT OFF THE NETWORK. A tag is length-capped
// before it is matched, the matcher is anchored with no nested quantifier (so it
// cannot be made to backtrack), the notes scan is capped, and anything that is
// not a version parses to null instead of throwing.

/** Longest tag string worth looking at at all - real tags are "v0.8.1"-sized. */
export const MAX_VERSION_TAG = 64;
/** Longest reason kept off a SEISCONV_CRITICAL: line. */
export const MAX_CRITICAL_REASON = 200;
/** How much release-note text is ever scanned for the marker. */
export const MAX_NOTES_SCAN = 20000;
/** The marker a release author writes into the notes to flag a critical release.
 *  Authored by hand, never inferred: no heuristic decides that a release matters. */
export const CRITICAL_MARKER = 'SEISCONV_CRITICAL';

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers ('beta', '2'); [] for a final release. */
  pre: string[];
}

// v?MAJOR[.MINOR[.PATCH]][-PRERELEASE][+BUILD]. Anchored, bounded repeats only.
const VERSION_RE =
  /^[vV]?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:-([0-9A-Za-z.-]{1,32}))?(?:\+[0-9A-Za-z.-]{1,32})?$/;

/**
 * Parse a release tag into its numeric parts. Tolerates a leading 'v' and a
 * missing minor/patch (treated as 0). Returns null for anything that is not a
 * version - an empty string, a branch name, a date, a tag that is too long.
 */
export function parseVersion(tag: string): Version | null {
  if (typeof tag !== 'string') return null;
  const s = tag.trim();
  if (!s || s.length > MAX_VERSION_TAG) return null;
  const m = VERSION_RE.exec(s);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  const patch = m[3] === undefined ? 0 : Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  const pre = m[4] ? m[4].split('.').filter((p) => p.length > 0) : [];
  return { major, minor, patch, pre };
}

/** Compare two pre-release identifier lists by the semver rule: a release with
 *  identifiers ranks BELOW the same release without them; numeric identifiers
 *  compare numerically and rank below alphanumeric ones; a longer list wins when
 *  every shared identifier is equal. */
function comparePre(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;   // 1.0.0 > 1.0.0-beta
  if (!b.length) return -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;    // numeric identifiers rank below alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
}

/**
 * Compare two version tags: -1 / 0 / +1 for a < b / a == b / a > b, and **null**
 * when either side is not a version (the caller then knows it cannot tell, rather
 * than being handed a made-up ordering).
 */
export function compareVersions(a: string, b: string): number | null {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  return comparePre(va.pre, vb.pre);
}

/** True only when `candidate` parses, `current` parses, and candidate > current.
 *  An unreadable tag is never "newer": the app stays quiet rather than nagging. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}

/**
 * Should the quiet "an update is known" marker be shown?
 *
 * True only when `latest` is genuinely newer than `current` AND the user has not
 * already dismissed it. A dismissal covers the version dismissed and everything
 * at or below it, so:
 *   - the marker clears itself once the running build catches up, with no click;
 *   - a LATER, greater release brings it back on its own;
 *   - a release that is pulled after being dismissed does not resurrect the
 *     marker by coming back as a lower (but still newer) tag.
 * An unreadable tag on either side shows nothing: the app stays quiet rather
 * than nagging about something it cannot read.
 */
export function updateBadgeVisible(latest: string, current: string, dismissed: string): boolean {
  if (!isNewerVersion(latest, current)) return false;
  if (!dismissed || !parseVersion(dismissed)) return true;
  return isNewerVersion(latest, dismissed);
}

/** Drop control characters (including the ESC that drives a terminal escape
 *  sequence) but keep tabs and newlines where the caller wants them. */
function stripControls(s: string, keepNewlines: boolean): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x0a || c === 0x0d) { if (keepNewlines) out += ch; else out += ' '; continue; }
    if (c === 0x09) { out += ' '; continue; }
    if (c < 0x20 || c === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * Pull the reason off a `SEISCONV_CRITICAL: <one line reason>` line in a release
 * body. Returns null when the marker is absent or carries no reason, so a normal
 * release can never be promoted to critical by accident. The marker must open its
 * own line (leading whitespace and a leading markdown bullet are allowed, because
 * release notes are written as markdown lists).
 */
export function parseCriticalReason(body: string): string | null {
  if (typeof body !== 'string' || !body) return null;
  const text = body.length > MAX_NOTES_SCAN ? body.slice(0, MAX_NOTES_SCAN) : body;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s>*+-]{0,8}/, '');
    if (!line.startsWith(CRITICAL_MARKER)) continue;
    const rest = line.slice(CRITICAL_MARKER.length);
    const m = /^\s*:\s*(.*)$/.exec(rest);
    if (!m) continue;
    const reason = stripControls(m[1], false).replace(/\s+/g, ' ').trim();
    if (!reason) return null;
    return reason.length > MAX_CRITICAL_REASON ? reason.slice(0, MAX_CRITICAL_REASON) + '…' : reason;
  }
  return null;
}

/**
 * Bound a release body down to displayable plain text: control characters out,
 * CRLF normalised, runs of blank lines collapsed, length capped. The result is
 * still shown with textContent (never innerHTML) - this only keeps the payload
 * small and free of terminal/format control codes.
 */
export function releaseNotesText(body: string, maxChars = 4000): string {
  if (typeof body !== 'string' || !body) return '';
  const cap = Math.max(0, Math.min(MAX_NOTES_SCAN, Math.floor(maxChars)));
  const clipped = body.length > cap ? body.slice(0, cap) + '\n…' : body;
  return stripControls(clipped.replace(/\r\n?/g, '\n'), true)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
