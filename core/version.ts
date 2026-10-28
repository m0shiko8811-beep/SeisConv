// seisconv-core - release version comparison + release-note marker parsing.
//
// Behind the on-demand "Check for updates" action: the main process asks GitHub
// for the newest published release and has to decide whether that tag is really
// newer than the running build, and whether its notes were deliberately marked
// critical. All of that is pure string work with no network and no DOM, so it
// lives here and is unit-tested like every other parser in core. The same goes
// for the "Update now" helpers at the end (installer asset, digest, URL checks).
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

// Markdown, line by line. Every pattern is anchored or bounded, with no nested
// quantifier, so untrusted notes cannot make them backtrack.
const MD_RULE = /^\s{0,3}([-*_])(?:\s{0,3}\1){2,}\s*$/;
const MD_HEADING = /^\s{0,3}#{1,6}\s+/;
const MD_BULLET = /^\s{0,8}[-*+]\s+/;
const MD_ORDERED = /^\s{0,8}\d{1,3}[.)]\s+/;
const MD_QUOTE = /^\s{0,3}>\s?/;
/** Lines that only make sense on the GitHub release page, where the assets sit
 *  under the notes ("Download X below", "the manual is attached", what Windows
 *  SmartScreen says about an installer opened from the browser). In the app they
 *  point at nothing, so they are dropped. */
const MD_PAGE_ONLY: readonly RegExp[] = [
  /\bdownload\b.{0,200}\b(?:below|above)\b/i,
  /\b(?:is|are)\s+attached\b/i,
  /\bSmartScreen\b/i,
];

/** Inline Markdown to its text: links and images keep their text, code spans,
 *  bold and italics lose their markers. snake_case words are left alone. */
function mdInline(s: string): string {
  return s
    .replace(/!\[([^\]\n]{0,300})\]\([^)\n]{0,2000}\)/g, '$1')
    .replace(/\[([^\]\n]{0,300})\]\([^)\n]{0,2000}\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]{1,2000})>/g, '$1')
    .replace(/`{1,3}([^`\n]{1,500})`{1,3}/g, '$1')
    .replace(/\*\*([^*\n]{1,500})\*\*/g, '$1')
    .replace(/__([^_\n]{1,500})__/g, '$1')
    .replace(/(^|[^\w*])\*([^*\n]{1,500})\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_([^_\n]{1,500})_(?!\w)/g, '$1$2');
}

/**
 * Release-note Markdown to readable plain text: headings become their text,
 * rules and page-only lines go, bullets become "• ", link syntax keeps the link
 * text, emphasis and code markers are removed, and a paragraph or list item that
 * the author hard-wrapped is joined back into one line (Markdown's own reading
 * of a single line break).
 */
function markdownToPlain(text: string): string {
  const out: string[] = [];
  let open = false;   // the last output line may take a soft-wrapped continuation
  for (const raw of text.split('\n')) {
    if (!raw.trim() || MD_RULE.test(raw)) { out.push(''); open = false; continue; }
    if (MD_PAGE_ONLY.some((re) => re.test(raw))) { open = false; continue; }
    const h = MD_HEADING.exec(raw);
    if (h) { out.push(mdInline(raw.slice(h[0].length).replace(/\s+#+\s*$/, '')).trim()); open = false; continue; }
    const b = MD_BULLET.exec(raw);
    if (b) { out.push('• ' + mdInline(raw.slice(b[0].length)).trim()); open = true; continue; }
    const o = MD_ORDERED.exec(raw);
    if (o) { out.push(o[0].trim() + ' ' + mdInline(raw.slice(o[0].length)).trim()); open = true; continue; }
    const line = mdInline(raw.replace(MD_QUOTE, '')).trim();
    if (open && out.length) out[out.length - 1] += ' ' + line;
    else { out.push(line); open = true; }
  }
  return out.join('\n');
}

/**
 * Bound a release body down to displayable plain text: length capped, control
 * characters out, CRLF normalised, Markdown reduced to plain text (see
 * markdownToPlain), runs of blank lines collapsed. The result is still shown
 * with textContent (never innerHTML) - this only keeps the payload small,
 * readable and free of terminal/format control codes.
 */
export function releaseNotesText(body: string, maxChars = 4000): string {
  if (typeof body !== 'string' || !body) return '';
  const cap = Math.max(0, Math.min(MAX_NOTES_SCAN, Math.floor(maxChars)));
  const clipped = body.length > cap ? body.slice(0, cap) + '\n…' : body;
  return markdownToPlain(stripControls(clipped.replace(/\r\n?/g, '\n'), true))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// -- "Update now": picking and checking the release installer ------------------
// The one-click update of the GitHub (NSIS) build downloads the installer asset of
// the release a manual check found, verifies it against the SHA-256 digest GitHub
// publishes for that asset, and only then runs it. Which asset, which URLs may be
// fetched on the way and whether two fingerprints agree is pure string work, so it
// lives here beside the version helpers and is unit-tested. The release JSON is
// UNTRUSTED: every field is type-checked and bounded, nothing is coerced.

/** The only repository an installer is ever taken from. */
export const UPDATE_REPO = 'm0shiko8811-beep/SeisConv';
/** Hard ceiling on an installer download. The real one is about 114 MB; this
 *  leaves room for growth while refusing anything absurd before it is fetched. */
export const UPDATE_INSTALLER_MAX_BYTES = 400 * 1024 * 1024;
/** How many entries of a release's asset list are looked at, at most. */
export const MAX_RELEASE_ASSETS = 64;
/** Hosts a release download may be redirected to (GitHub's asset storage). The
 *  first hop is always github.com itself, checked by isReleaseDownloadUrl. */
export const UPDATE_REDIRECT_HOSTS: readonly string[] = [
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
];

/** An installer asset that passed every check, as main is allowed to use it. */
export interface InstallerAsset {
  name: string;
  url: string;
  size: number;
  /** Lower-case hex SHA-256 from the asset's `digest`, or null when GitHub
   *  published none (the asset then cannot be verified and is never run). */
  sha256: string | null;
}

/** "v0.8.8" -> "SeisConv-Setup-0.8.8.exe", the electron-builder NSIS artifact
 *  name (the same rule scripts/install-latest.ps1 uses). null for a non-version. */
export function installerAssetName(tag: string): string | null {
  if (!parseVersion(tag)) return null;
  return `SeisConv-Setup-${tag.trim().replace(/^[vV]/, '')}.exe`;
}

/** GitHub's asset digest "sha256:<64 hex>" -> lower-case hex; null for anything
 *  else (missing, another algorithm, wrong length, stray characters). */
export function parseSha256Digest(digest: unknown): string | null {
  if (typeof digest !== 'string' || digest.length > 80) return null;
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(digest.trim());
  return m ? m[1].toLowerCase() : null;
}

/** True when two SHA-256 fingerprints are both well-formed 64-hex strings and
 *  equal (case-insensitive). Two empty or malformed strings never "agree". */
export function sha256Equal(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!/^[0-9a-fA-F]{64}$/.test(a) || !/^[0-9a-fA-F]{64}$/.test(b)) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** Parse an https URL with no credentials and no explicit port; null otherwise. */
function strictHttpsUrl(url: unknown): URL | null {
  if (typeof url !== 'string' || !url || url.length > 2048) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  return u;
}

/** The FIRST hop of a download: a release-download URL of the SeisConv repo on
 *  github.com, and nothing else. */
export function isReleaseDownloadUrl(url: unknown): boolean {
  const u = strictHttpsUrl(url);
  return !!u && u.hostname === 'github.com' && u.pathname.startsWith(`/${UPDATE_REPO}/releases/download/`);
}

/** Any hop of a download: the github.com release URL above, or one of GitHub's
 *  asset-storage hosts it redirects to. */
export function isAllowedDownloadUrl(url: unknown): boolean {
  if (isReleaseDownloadUrl(url)) return true;
  const u = strictHttpsUrl(url);
  return !!u && UPDATE_REDIRECT_HOSTS.includes(u.hostname);
}

/**
 * Pick the Windows installer out of a release's `assets` array: the entry named
 * exactly installerAssetName(tag), whose download URL is a release download of
 * THIS repo ending in that name, and whose size is a whole number of bytes within
 * the cap. Returns null when there is no such asset. A missing or malformed
 * digest does not hide the asset (sha256 comes back null) so the caller can say
 * plainly that it cannot be verified.
 */
export function selectInstallerAsset(assets: unknown, tag: string): InstallerAsset | null {
  const want = installerAssetName(tag);
  if (!want || !Array.isArray(assets)) return null;
  const n = Math.min(assets.length, MAX_RELEASE_ASSETS);
  for (let i = 0; i < n; i++) {
    const a = assets[i] as Record<string, unknown> | null;
    if (!a || typeof a !== 'object' || a.name !== want) continue;
    const url = a.browser_download_url;
    if (typeof url !== 'string' || !isReleaseDownloadUrl(url)) return null;
    if (!new URL(url).pathname.endsWith(`/${want}`)) return null;
    const size = a.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > UPDATE_INSTALLER_MAX_BYTES) return null;
    return { name: want, url, size, sha256: parseSha256Digest(a.digest) };
  }
  return null;
}
