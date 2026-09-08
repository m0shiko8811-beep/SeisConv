// docs/manual/frame-safety.mjs - the denylist behind the manual's "no real data in a
// picture" rule. Split out of shots.mjs so it can be unit-driven without launching the app.
//
// WHY THIS FILE IS SPLIT IN TWO HALVES.
// This repository is public. A denylist that spells out the very names it is protecting
// publishes them: the guard leaks exactly what it guards, and anyone can read the real
// survey names, folder names and account names straight out of the source. So the list is
// split by what each entry actually IS:
//
//   GENERIC (below, committed)   - path roots and account-name shapes. They name nobody and
//                                  nothing, they are the same on every machine, and every
//                                  contributor benefits from them out of the box.
//   SITE TERMS (per machine)     - real survey names, real corpus folder names, the operator's
//                                  account name, an employer. These are exactly the strings
//                                  that must not be published, so they live in
//                                  qa/local-paths.json, which is git-ignored, under the key
//                                  `forbiddenTerms`. qa/local-paths.example.json shows the
//                                  shape with obviously fake placeholders.
//
// HOW TO ADD YOUR OWN SITE TERMS.
//   1. Copy qa/local-paths.example.json to qa/local-paths.json (git-ignored, never commit it).
//   2. Put your own survey / site / account strings in "forbiddenTerms".
//      Each entry is a REGULAR-EXPRESSION SOURCE, matched case-insensitively, so a shape
//      like "SURVEY-\\d{4}" or a whole-word "\\bACME\\b" works. Remember JSON needs the
//      backslash doubled. An entry that will not compile stops the run rather than being
//      quietly skipped - a dropped pattern is an invisible hole in the guard.
//   3. Or set SEISCONV_FORBIDDEN_TERMS (';'-separated) for a one-off run. A pattern that
//      itself contains ';' has to go in the JSON file instead.
//
// WITHOUT ANY CONFIG the guard still fires on a drive-letter path root, on AppData and on
// an account name inside a path ("Users\\someone"). What it cannot know is your site's own
// vocabulary: a bare account name with no path around it, a survey name, a job folder. So
// buildForbidden() prints one line when the site half is empty, and the manual run says
// plainly that the check is running in its partial form.
import { resolveList } from '../../qa/local-paths.mjs';

/**
 * The half that is safe to publish: absolute path roots, the Windows per-user data folder,
 * and the "Users/<name>" shape that exposes whatever account the machine runs under.
 * These describe a SHAPE, never a person or a place.
 */
export const GENERIC = [
  /D:\\Projects/i, /D:\/Projects/i, /C:\\Users/i, /C:\/Users/i, /AppData/i,
  /Users[\\/][A-Za-z]/,
];

/** The per-machine half: regex sources from qa/local-paths.json / SEISCONV_FORBIDDEN_TERMS. */
export function siteTerms() {
  return resolveList('forbiddenTerms', 'SEISCONV_FORBIDDEN_TERMS', []);
}

/**
 * Compile `terms` (regex sources) and put them AHEAD of the generic half, so a leak is
 * reported by the most specific pattern that saw it. Throws on a source that will not
 * compile: a silently dropped entry would weaken the guard without anyone noticing.
 * @param {string[]} terms
 * @param {{ quiet?: boolean }} [opts]
 */
export function buildForbidden(terms = siteTerms(), opts = {}) {
  const site = terms.map((t) => {
    try { return new RegExp(t, 'i'); } catch (e) {
      throw new Error(`forbiddenTerms: ${JSON.stringify(t)} is not a valid regular expression (${e.message}). `
        + 'Fix it in qa/local-paths.json or SEISCONV_FORBIDDEN_TERMS; it cannot be skipped.');
    }
  });
  if (!site.length && !opts.quiet) {
    console.log('  frame safety: no forbiddenTerms configured - only the generic path/account '
      + 'patterns are active. See qa/local-paths.example.json to add your own site terms.');
  }
  return [...site, ...GENERIC];
}

/** Every distinct match of `list` in `txt`, in list order. */
export function scanText(txt, list) {
  const hits = [];
  for (const re of list) { const m = String(txt).match(re); if (m) hits.push(m[0]); }
  return [...new Set(hits)];
}
