// docs/manual/render-pdf.mjs - render docs/manual/out/manual.html to PDF with Electron's
// printToPDF. Run AFTER `npm run manual`:
//
//     npm run manual:pdf
//
// TWO PASSES, because the table of contents needs real page numbers. Chromium cannot
// tell a document where its own headings landed, so this renders once, reads the page
// each anchor actually fell on out of the PDF, re-emits the HTML with those numbers in
// place of the placeholders, and renders again. The numbers are MEASURED, never guessed,
// and they are measured per page size: A4 and Letter paginate differently.
//
// This LAUNCHES ELECTRON, so it must not run while another agent or a QA driver is
// driving the app. It produces both page sizes required by the plan:
//     docs/manual/out/SeisConv-Manual-A4.pdf
//     docs/manual/out/SeisConv-Manual-Letter.pdf
// Running headers, footers and page numbers come from headerTemplate/footerTemplate below
// (Chromium's own paged-media header slots), not from the stylesheet.
import { app, BrowserWindow } from 'electron';
import { writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'out', 'manual.html');
const version = JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8')).version;

const HEADER = `<div style="font-size:8px;font-family:Segoe UI,Arial,sans-serif;color:#8b949e;
  width:100%;padding:0 16mm;display:flex;justify-content:space-between;">
  <span>SeisConv ${version} - User Manual</span><span class="title"></span></div>`;
const FOOTER = `<div style="font-size:8px;font-family:Segoe UI,Arial,sans-serif;color:#8b949e;
  width:100%;padding:0 16mm;text-align:center;">
  <span class="pageNumber"></span> / <span class="totalPages"></span></div>`;

const PAGES = [
  { size: 'A4', out: 'SeisConv-Manual-A4.pdf' },
  { size: 'Letter', out: 'SeisConv-Manual-Letter.pdf' },
];

// ------------------------------------------------------------------ PDF page lookup
/**
 * Map every named destination in a Chromium-produced PDF to its 1-based page number.
 *
 * Skia writes the catalogue's /Dests as a plain dictionary of `/<anchor id> [<page ref>
 * /XYZ ...]`, and the page tree as uncompressed /Pages nodes, so the whole lookup is a
 * byte scan - no PDF library, no new dependency. If the layout ever changes, this
 * returns an empty map and the caller says so loudly rather than printing wrong numbers.
 */
function destPages(pdf) {
  const b = pdf.toString('latin1');
  const obj = (n) => {
    const key = String.fromCharCode(10) + n + ' 0 obj';
    const at = b.indexOf(key);
    if (at < 0) return '';
    const end = b.indexOf('endobj', at);
    return end < 0 ? '' : b.slice(at + key.length, end);

  };
  // Page order: walk the page tree from the catalogue's /Pages root, depth first.
  const cat = /\/Type\s*\/Catalog[\s\S]*?\/Pages\s+(\d+) 0 R/.exec(b);
  const dests = /\/Type\s*\/Catalog[\s\S]*?\/Dests\s+(\d+) 0 R/.exec(b);
  if (!cat || !dests) return new Map();
  const order = [];
  const walk = (n, depth) => {
    if (depth > 8 || order.length > 5000) return;
    const body = obj(n);
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(body);
    if (kids) { for (const m of kids[1].matchAll(/(\d+) 0 R/g)) walk(Number(m[1]), depth + 1); return; }
    order.push(n);
  };
  walk(Number(cat[1]), 0);
  const pageOf = new Map(order.map((n, i) => [n, i + 1]));
  const out = new Map();
  for (const m of obj(Number(dests[1])).matchAll(/\/([^\s/()<>\[\]]+)\s*\[\s*(\d+) 0 R/g)) {
    const pg = pageOf.get(Number(m[2]));
    if (pg) out.set(m[1], pg);
  }
  return { pages: order.length, dests: out };
}

/**
 * Replace each TOC placeholder with the measured page number for that anchor.
 *
 * LINE BY LINE ON PURPOSE. The generator emits one <li> per line, and a Part entry has
 * an anchor but NO page span. A document-wide regex happily matched a Part's href to the
 * NEXT chapter's span and printed the divider's page for the chapter after it - an
 * off-by-one that looked plausible and was wrong. Matching within a single line cannot
 * cross an entry boundary.
 */
function fillToc(html, dests) {
  let filled = 0; const missed = [];
  const NL = String.fromCharCode(10);
  const lines = html.split(NL).map((line) => {
    if (!line.includes('<span class="pg">')) return line;
    const m = /href="#([^"]+)"/.exec(line);
    const pg = m && dests.get(m[1]);
    if (!pg) { missed.push(m ? m[1] : line.trim().slice(0, 40)); return line; }
    filled++;
    return line.replace(/<span class="pg">[\s\S]*?<\/span><\/span>/, `<span class="pg">${pg}</span>`)
               .replace(/<span class="pg">(?!\d)[^<]*<\/span>/, `<span class="pg">${pg}</span>`);
  });
  return { html: lines.join(NL), filled, missed };
}

app.whenReady().then(async () => {
  if (!existsSync(SRC)) {
    console.error(`Missing ${SRC}. Run \`npm run manual\` first.`);
    app.exit(1);
    return;
  }
  const srcHtml = readFileSync(SRC, 'utf8');
  const placeholders = (srcHtml.match(/<span class="pg">/g) || []).length;
  const win = new BrowserWindow({ show: false, width: 1200, height: 1600 });

  const render = async (size) => win.webContents.printToPDF({
    pageSize: size,
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: HEADER,
    footerTemplate: FOOTER,
    margins: { marginType: 'custom', top: 0.7, bottom: 0.7, left: 0.6, right: 0.6 },
    generateTaggedPDF: true,
    generateDocumentOutline: true,
  });

  let bad = 0;
  for (const p of PAGES) {
    // PASS 1 - the document with placeholders, rendered only to find out where things land.
    await win.loadURL(pathToFileURL(SRC).href);
    const probe = destPages(await render(p.size));
    const found = probe.dests ? probe.dests.size : 0;
    // PASS 2 - the same document with the measured page numbers written into the TOC.
    let pass2 = srcHtml, filled = 0, missed = placeholders;
    if (found) {
      const r = fillToc(srcHtml, probe.dests);
      pass2 = r.html; filled = r.filled; missed = r.missed.length;
      if (r.missed.length) console.warn(`  ${p.size}: no destination for ${r.missed.join(', ')}`);
    } else {
      console.warn(`  ${p.size}: could not read destinations out of the pass-1 PDF - TOC page numbers left as placeholders`);
    }
    const tmp = join(HERE, 'out', `.pass2-${p.size}.html`);
    writeFileSync(tmp, pass2, 'utf8');
    await win.loadURL(pathToFileURL(tmp).href);
    const buf = await render(p.size);
    const check = destPages(buf);
    // The second pass must not repaginate: a TOC that says page 12 for a chapter that
    // moved to 13 is worse than no number at all. One page-number span is a few
    // characters, so this only fires if the TOC itself overflowed onto another page.
    let drift = [];
    if (check.dests) for (const [id, pg] of probe.dests) if (check.dests.get(id) !== pg) drift.push(`${id} ${pg}->${check.dests.get(id)}`);
    writeFileSync(join(HERE, 'out', p.out), buf);
    rmSync(tmp, { force: true });
    const flag = missed || drift.length ? '  !! ' + [missed ? `${missed} placeholder(s) left` : '', drift.length ? `page drift: ${drift.join(', ')}` : ''].filter(Boolean).join('; ') : '';
    if (missed || drift.length) bad++;
    console.log(`${join(HERE, 'out', p.out)} - ${check.pages} pages, ${(buf.length / 1024 / 1024).toFixed(2)} MB, ${filled}/${placeholders} TOC page numbers measured${flag}`);
  }
  win.destroy();
  app.exit(bad ? 1 : 0);
});
