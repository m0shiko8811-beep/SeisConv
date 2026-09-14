// Regenerate qa/conform/ebcdic-appendix-f.json from the SEG-Y rev 2.0 PDF.
//
// WHY THIS EXISTS. qa/conform/conform.mjs has to decode the EBCDIC textual
// header that core/formats/segy.ts WROTE. If it decoded that header with
// core/binary.ts's own `ebcdic()` table, a wrong table would decode its own
// wrong encoding perfectly and the check would prove nothing. So the table is
// lifted out of the standard itself - SEG-Y rev 2.0, Appendix F, "EBCDIC and
// ASCII Codes", Table 19, printed pages 143 to 146 (PDF pages 147 to 150) -
// and this script is how, so a reviewer can re-run it and get the same file.
//
//   node qa/conform/extract-ebcdic.mjs "<path to seg_y_rev2.0.pdf>"
//
// The PDF stays outside the repository. Only the extracted table is committed.
//
// HOW THE EXTRACTION IS KEPT HONEST:
//  * pdftotext -layout renders each row of Table 19 as "<char> xEE xAA <name>".
//    The leading character column floats and sometimes collides with the next
//    column, so ONLY the two hex fields and the trailing name are read.
//  * Rows are grouped by EBCDIC code. A code that appears with two DIFFERENT
//    ASCII targets is column bleed, not a real mapping: it is DROPPED and
//    listed in `ambiguous`, never guessed at.
//  * Every row whose name identifies a character outright ("Latin capital
//    letter H", "Digit seven", "Space") is cross-checked: the ASCII hex in the
//    table must equal that character's real code point. The count of rows that
//    passed that check is written into the output as `selfChecked`. If any row
//    fails, the script refuses to write anything.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'ebcdic-appendix-f.json');
const FIRST_PAGE = 147;
const LAST_PAGE = 150;

// Spelled-out digit names as Table 19 writes them. English words, not recalled
// byte values - this map only turns "Digit seven" into the character '7'.
const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** The character a Table 19 row names outright, or null when the row names a
 *  control code or a punctuation mark by description rather than by glyph. */
function namedChar(desc) {
  let m = /Latin capital letter ([A-Z])\b/.exec(desc);
  if (m) return m[1];
  m = /Latin small letter ([A-Za-z])\b/.exec(desc);
  if (m) return m[1].toLowerCase();
  m = /Digit ([a-z]+)/i.exec(desc);
  if (m) {
    const i = DIGIT_WORDS.indexOf(m[1].toLowerCase());
    if (i >= 0) return String(i);
  }
  if (/^Space\b/.test(desc)) return ' ';
  return null;
}

function main() {
  const pdf = process.argv[2];
  if (!pdf) {
    console.error('usage: node qa/conform/extract-ebcdic.mjs <path to seg_y_rev2.0.pdf>');
    return 2;
  }

  const r = spawnSync('pdftotext', ['-f', String(FIRST_PAGE), '-l', String(LAST_PAGE), '-layout', pdf, '-'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) {
    console.error('pdftotext failed (status ' + r.status + '). Is it on PATH?');
    return 3;
  }

  const rows = [];
  // Table 19 is printed in two side-by-side column pairs, so ONE text line can
  // carry TWO rows ("... Colon xC3 x43 Latin capital letter C"). The
  // description is therefore tempered: it runs to the end of the line OR to the
  // start of the next "xEE xAA" pair, whichever comes first. Without this the
  // name of the neighbouring row gets attached to this row's hex pair, and the
  // self-check below fires - which is how this was found.
  const re = /x([0-9A-F]{2})\s+x([0-9A-F]{2})\s+((?:(?!x[0-9A-F]{2}\s+x[0-9A-F]{2})[^\r\n])*)/g;
  let m;
  while ((m = re.exec(r.stdout)) !== null) {
    rows.push({ eb: parseInt(m[1], 16), as: parseInt(m[2], 16), desc: m[3].replace(/\s+/g, ' ').trim() });
  }
  if (rows.length < 100) {
    console.error('only ' + rows.length + ' table rows matched - the extraction is not trustworthy, refusing to write');
    return 3;
  }

  // Group by EBCDIC code. Two different ASCII targets for one code means the
  // layout bled a neighbouring column into this row: drop it, do not guess.
  const byEb = new Map();
  for (const row of rows) {
    if (!byEb.has(row.eb)) byEb.set(row.eb, []);
    byEb.get(row.eb).push(row);
  }

  const table = {};
  const names = {};
  const ambiguous = [];
  for (const [eb, group] of [...byEb.entries()].sort((a, b) => a[0] - b[0])) {
    const targets = [...new Set(group.map((g) => g.as))];
    if (targets.length !== 1) {
      ambiguous.push({
        ebcdic: hex(eb),
        sawAscii: targets.map(hex),
        note: 'dropped: Table 19 rendered more than one ASCII target for this EBCDIC code',
      });
      continue;
    }
    table[hex(eb)] = hex(targets[0]);
    const named = group.map((g) => g.desc).sort((a, b) => a.length - b.length)[0];
    names[hex(eb)] = named;
  }

  // Cross-check every row that names its own character.
  let selfChecked = 0;
  const failures = [];
  for (const row of rows) {
    const ch = namedChar(row.desc);
    if (ch === null) continue;
    if (row.as !== ch.charCodeAt(0)) {
      failures.push(hex(row.eb) + ' -> ' + hex(row.as) + '  "' + row.desc + '"');
      continue;
    }
    selfChecked++;
  }
  if (failures.length) {
    console.error('self-check FAILED on ' + failures.length + ' row(s); refusing to write the table:');
    for (const f of failures) console.error('  ' + f);
    return 3;
  }

  const out = {
    _what: 'EBCDIC to ASCII byte mapping, extracted from the SEG-Y rev 2.0 standard, not from any SeisConv source file.',
    _citation: {
      doc: 'SEG-Y rev 2.0 (January 2017)',
      section: 'Appendix F. EBCDIC and ASCII Codes',
      table: 'Table 19 IBM 3270 Char Set Ref Ch 10, GA27-2837-9, April 1987',
      pagePrinted: '143 to 146',
      pagePdf: FIRST_PAGE + ' to ' + LAST_PAGE,
    },
    _howToRegenerate: 'node qa/conform/extract-ebcdic.mjs <path to seg_y_rev2.0.pdf>',
    rowsMatched: rows.length,
    codesMapped: Object.keys(table).length,
    selfChecked,
    ambiguous,
    names,
    table,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('rows matched      : ' + rows.length);
  console.log('EBCDIC codes kept : ' + Object.keys(table).length);
  console.log('dropped ambiguous : ' + ambiguous.length + (ambiguous.length ? ' (' + ambiguous.map((a) => a.ebcdic).join(', ') + ')' : ''));
  console.log('self-checked rows : ' + selfChecked + ' (named character vs its ASCII code point)');
  console.log('written           : qa/conform/ebcdic-appendix-f.json');
  return 0;
}

function hex(n) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

process.exitCode = main();
