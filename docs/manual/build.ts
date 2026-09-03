// docs/manual/build.ts - generator for the SeisConv PDF manual.
//
//   npm run manual            regenerate docs/manual/out/manual.html (runs the core
//                             test suite once, to source the test counts)
//   npm run manual -- --fast  skip the test run; the counts become a marked placeholder
//
// PART III (the tab-by-tab reference) IS GENERATED from renderer/src/manual.ts - the same
// single source of truth the in-app Help and MANUAL.md use. Never hand-edit a Part III
// chapter: change the topic in renderer/src/manual.ts and re-run this.
//
// Parts I, II, IV and the appendices are hand-written prose fragments under
// docs/manual/parts/, included verbatim. The PDF is produced from the emitted HTML by
// docs/manual/render-pdf.mjs (Electron printToPDF), which supplies the page size, the
// running header and the page numbers.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MANUAL, type HelpTopic } from '../../renderer/src/manual';
import { REPO, pkg, writers, epsgStats, shortcuts, tabs, testCounts, todo } from './sources';

const HERE = join(REPO, 'docs', 'manual');
const OUT = join(HERE, 'out');
const fast = process.argv.includes('--fast');

/** Same topic order the Help modal's nav uses: 'general' first, then app tab order. */
const ORDER = ['general', 'conv', 'trace', 'section', 'sps', 'spscreate', 'vel',
  'spectrum', 'workbench', 'obslog', 'geomqc', 'sweeps', 'field'];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Topic strings are trusted hand-authored HTML (they are injected as innerHTML in the
 *  app), so they pass through untouched - only the small tag set the topics use appears. */
function frag(html: string): string { return html; }

function slug(k: string): string { return `ref-${k}`; }

function topicHtml(key: string, t: HelpTopic): string {
  const out: string[] = [
    `<section class="chapter" id="${slug(key)}">`,
    `  <h2>${frag(t.title)}</h2>`,
    `  <p class="summary">${frag(t.what)}</p>`,
  ];
  const list = (h: string, items: string[] | undefined, ordered = false) => {
    if (!items || !items.length) return;
    const tag = ordered ? 'ol' : 'ul';
    out.push(`  <h3>${frag(h)}</h3>`, `  <${tag}>`);
    for (const it of items) out.push(`    <li>${frag(it)}</li>`);
    out.push(`  </${tag}>`);
  };
  list('Controls', t.controls);
  for (const sec of t.sections ?? []) list(sec.h, sec.items, sec.ordered);
  list('How to use it', t.steps, true);
  list('Tips', t.tips);
  list('Good to know', t.notes);
  out.push('</section>');
  return out.join('\n');
}

function part(no: string, title: string, blurb: string): string {
  return `<section class="part" id="part-${no.toLowerCase()}">
  <div class="kicker">Part ${no}</div>
  <h1>${esc(title)}</h1>
  <p class="blurb">${esc(blurb)}</p>
</section>`;
}

function include(file: string): string {
  const p = join(HERE, 'parts', file);
  if (!existsSync(p)) return `<section class="chapter"><h2>${esc(file)}</h2><p class="scaffold">${todo(`missing prose fragment docs/manual/parts/${file}`)}</p></section>`;
  return figures(readFileSync(p, 'utf8'));
}

// ---- figures ---------------------------------------------------------------------
// The screenshots under docs/manual/img/ are produced by docs/manual/shots.mjs, which
// drives the BUILT APP and writes, beside each PNG, a .json callout key: the numbered
// markers burned into the image and what each one points at. The caption and the
// numbered legend below every figure are generated FROM that key, so the picture, the
// numbers on it and the words under it cannot drift apart - nothing here is retyped.
//
// The PNGs are gitignored (they are regenerated per release), so a clone that has not
// run `npm run manual:shots` must still build: a missing image becomes a clearly marked
// placeholder that keeps the caption and the legend, and the build reports how many.
//
// A prose fragment places or cites a shot by name:
//     <!--FIG:09a-sps-map-->        place the figure here
//     <!--FIGREF:09a-sps-map-->     "Figure 12" (resolved once the whole body exists)
const NL = String.fromCharCode(10);
type Callout = { n: number; label: string };
type ShotMeta = { image?: string; caption?: string; callouts?: Callout[] };
const figNo = new Map<string, number>();
const figMissing: string[] = [];
const figUnknown: string[] = [];
let figCount = 0;

function figures(html: string): string {
  return html.replace(/<!--FIG:([a-z0-9-]+)-->/gi, (_m, name: string) => figureHtml(name));
}

function figureHtml(name: string): string {
  const metaPath = join(HERE, 'img', `${name}.json`);
  if (!existsSync(metaPath)) {
    figUnknown.push(name);
    return `<p class="scaffold">${todo(`figure "${esc(name)}" - no docs/manual/img/${esc(name)}.json callout key; run npm run manual:shots`)}</p>`;
  }
  let meta: ShotMeta;
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) as ShotMeta; }
  catch {
    figUnknown.push(name);
    return `<p class="scaffold">${todo(`figure "${esc(name)}" - docs/manual/img/${esc(name)}.json is not readable JSON`)}</p>`;
  }
  const n = figNo.get(name) ?? ++figCount;
  figNo.set(name, n);
  const rel = meta.image && meta.image.startsWith('img/') ? `../${meta.image}` : `../img/${name}.png`;
  const present = existsSync(join(HERE, 'img', `${name}.png`));
  if (!present) figMissing.push(name);
  const body = present
    ? `  <img src="${esc(rel)}" alt="${esc(meta.caption ?? name)}">`
    : `  <div class="img-missing">Screenshot not built - <span class="mono">docs/manual/img/${esc(name)}.png</span>. Run <span class="mono">npm run manual:shots</span> and rebuild.</div>`;
  const cos = (meta.callouts ?? []).slice().sort((a, b) => a.n - b.n);
  const items = cos.map((c) => `    <li value="${c.n}">${esc(c.label)}</li>`);
  const legend = cos.length
    ? ['', '  <ol class="legend">', ...items, '  </ol>'].join(NL)
    : '';
  return `<figure class="fig" id="fig-${esc(name)}">
${body}
  <figcaption><b>Figure ${n}</b> - ${esc(meta.caption ?? name)}</figcaption>${legend}
</figure>`;
}

/** Resolve <!--FIGREF:name--> once every placed figure has a number. */
function figrefs(html: string): string {
  return html.replace(/<!--FIGREF:([a-z0-9-]+)-->/gi, (_m, name: string) => {
    const n = figNo.get(name);
    if (!n) {
      figUnknown.push(`${name} (cited, never placed)`);
      return todo(`cross-reference to figure "${esc(name)}", which is not placed anywhere`);
    }
    return `<a class="figref" href="#fig-${esc(name)}">Figure ${n}</a>`;
  });
}

// ---- generated front matter: every number read from source ------------------------
function aboutHtml(): string {
  const p = pkg();
  const w = writers();
  const single = w.filter((x) => x.single);
  const batchOnly = w.filter((x) => x.batch && !x.single);
  const unlisted = w.filter((x) => !x.batch && !x.single);
  // If the chip groups ever move or are renamed, every writer would silently read as
  // "not offered" - say so loudly instead of publishing a wrong table.
  const chipsRead = single.length > 0 && w.some((x) => x.batch);
  const epsg = epsgStats();
  const tc = fast ? null : testCounts();
  const where = (x: typeof w[number]) => x.single && x.batch ? 'Single file and folder'
    : x.batch ? 'Folder (batch) only' : x.single ? 'Single file only' : 'Registered, not offered in the Converter';
  const rows = w.map((x) => `    <tr><td>${esc(x.label)}</td><td class="mono">.${esc(x.ext)}</td><td class="mono">${esc(x.id)}</td><td>${esc(where(x))}</td></tr>`).join('\n');
  const epsgText = epsg === null
    ? todo('EPSG counts (core/sps/epsg-registry.json unreadable)')
    : `${epsg.total.toLocaleString('en-GB')} systems in the built-in registry `
      + `(${epsg.projected.toLocaleString('en-GB')} projected, ${epsg.geographic.toLocaleString('en-GB')} geographic), `
      + 'all searchable by EPSG code or by name in the CRS picker';
  return `<section class="chapter" id="about-release">
  <h2>About this release</h2>
  <p class="summary">Everything on this page is read out of the source at generation time, so it describes the build on the cover and no other.</p>
  <ul>
    <li><b>Version</b> - ${esc(p.version)} (package.json)</li>
    <li><b>Licence</b> - ${esc(p.license)}</li>
    <li><b>Coordinate reference systems</b> - ${epsgText}</li>
    <li><b>Core unit tests</b> - ${tc ? `${tc.passed} passed, ${tc.failed} failed, ${tc.skipped} skipped, from an actual run of the suite. The skipped ones are the file-backed tests, which need a local sample-data folder (SEISCONV_DATA) that is not part of the repository.` : todo('core test counts - regenerate without --fast')}</li>
  </ul>
  <h3>Output formats</h3>
  <p>${chipsRead ? '' : todo('which formats the Converter offers - the chip groups #fmtChips / #fmtChipsBatch were not found in renderer/index.html') + ' '}${w.length} writers are registered; ${single.length} of them are offered as single-file
  outputs${batchOnly.length ? `, and ${batchOnly.map((x) => esc(x.label)).join(', ')} ${batchOnly.length === 1 ? 'is a batch-combine target offered in folder mode only' : 'are batch-combine targets offered in folder mode only'}` : ''}${unlisted.length ? `. ${unlisted.map((x) => esc(x.label)).join(', ')} ${unlisted.length === 1 ? 'is registered but not offered as a Converter output' : 'are registered but not offered as Converter outputs'}` : ''}.
  So the Converter shows ${single.length} format chips in single-file mode and
  ${w.filter((x) => x.batch).length} in folder mode.</p>
  <table>
    <thead><tr><th>Format</th><th>Extension</th><th>Writer id</th><th>Offered in</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="note">Writers read from core/formats/registry.ts; which of them the Converter offers read from the format chips in renderer/index.html.</p>
</section>`;
}

function shortcutsHtml(): string {
  const t = tabs();
  const named = (id: string) => MANUAL[id]?.title ?? id;
  // The digit keys reach TABS[0..8] only, so the last tabs have no shortcut at all -
  // say which, rather than leaving the reader to count.
  const reachable = t.slice(0, 9);
  const unreachable = t.slice(9);
  const rows = shortcuts().map((s) => {
    const action = /^1 … 9$/.test(s.keys.replace('Ctrl/Cmd + ', ''))
      ? `Jump straight to a tab, in rail order: ${reachable.map((id, i) => `<b>${i + 1}</b> ${named(id)}`).join(', ')}`
      : s.action;
    return `    <tr><td><span class="kbd">${s.keys}</span></td><td>${action}</td></tr>`;
  }).join('\n');
  const gap = unreachable.length
    ? `<p class="note">There is no number key for the last ${unreachable.length} tab${unreachable.length === 1 ? '' : 's'} (${unreachable.map(named).join(', ')}); reach ${unreachable.length === 1 ? 'it' : 'them'} from the icon rail.</p>`
    : '';
  return `<section class="chapter" id="app-shortcuts">
  <h2>Appendix B - Keyboard shortcuts</h2>
  <p class="summary">Parsed from the key handler in renderer/src/app.ts, so this table cannot drift from the app.</p>
  <table>
    <thead><tr><th>Keys</th><th>What it does</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="note">Ctrl on Windows and Linux, Cmd on macOS; the app shows the right glyph automatically.</p>
  ${gap}
</section>`;
}

// ---- assemble --------------------------------------------------------------------
const body: string[] = [];
body.push(aboutHtml());

body.push(part('I', 'Getting started', 'No jargon. What a seismic file is, what SeisConv does with it, and how to open, look at, convert and save one.'));
body.push(include('01-getting-started.html'));

body.push(part('II', 'Task recipes', 'One page per real job, in the form "I need to …" rather than "the Converter tab". This is the part most people will actually read.'));
body.push(include('02-recipes.html'));

body.push(part('III', 'Tab-by-tab reference', 'Generated from the app itself (renderer/src/manual.ts). Every control, every option, every state - the same text the in-app Help shows.'));
const seen = new Set<string>();
for (const k of [...ORDER, ...Object.keys(MANUAL)]) {
  if (seen.has(k) || !MANUAL[k]) continue;
  seen.add(k);
  body.push(topicHtml(k, MANUAL[k]));
}

body.push(part('IV', 'Formats and the maths', 'For the analyst: byte layouts, header maps, sample encodings, coordinates and projections, what is lossy and where, and the limits the parsers enforce.'));
body.push(include('04-formats.html'));

body.push(part('V', 'Appendices', 'Glossary, keyboard shortcuts, error messages, troubleshooting, and where the data lives.'));
body.push(include('A-glossary.html'));
body.push(shortcutsHtml());
body.push(include('C-errors.html'));
body.push(include('D-troubleshooting.html'));
body.push(include('E-data-locations.html'));

// Figure numbers exist only now that every part has been included, so resolve the
// cross-references over the finished body.
for (let i = 0; i < body.length; i++) body[i] = figrefs(body[i]);

// ---- table of contents, built from what was actually emitted ----------------------
type Node = { kind: 'part' | 'chapter'; id: string; title: string };
const nodes: Node[] = [];
for (const chunk of body) {
  for (const m of chunk.matchAll(/<section class="(part|chapter)"[^>]*id="([^"]+)"[^>]*>\s*(?:<div class="kicker">[^<]*<\/div>\s*)?<h[12]>([\s\S]*?)<\/h[12]>/g)) {
    nodes.push({ kind: m[1] as Node['kind'], id: m[2], title: m[3].replace(/<[^>]+>/g, '').trim() });
  }
}
const toc: string[] = ['<nav class="toc" id="toc">', '  <h2>Contents</h2>', '  <ol>'];
let open = false;
for (const n of nodes) {
  if (n.kind === 'part') {
    if (open) toc.push('    </ol></li>');
    toc.push(`    <li><a href="#${n.id}">${esc(n.title)}</a><ol>`);
    open = true;
  } else {
    const li = `      <li><a href="#${n.id}">${esc(n.title)}</a> <span class="pg">${todo('page number')}</span></li>`;
    if (!open) toc.push(li.replace(/^ {6}/, '    ')); else toc.push(li);
  }
}
if (open) toc.push('    </ol></li>');
toc.push('  </ol>', '</nav>');

const p = pkg();
const built = new Date().toISOString().slice(0, 10);
const css = readFileSync(join(HERE, 'print.css'), 'utf8');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SeisConv ${esc(p.version)} - User Manual</title>
<style>
${css}</style>
</head>
<body>
<div class="sheet">
<section class="cover">
  <h1>SeisConv</h1>
  <p class="tagline">${esc(p.description)}</p>
  <p class="ver">User Manual for version <b>${esc(p.version)}</b></p>
  <p class="built">Built ${esc(built)}</p>
  <p class="foot">Part III of this manual is generated from the application source, so it
  describes exactly the version named above.</p>
</section>
${toc.join('\n')}
${body.join('\n\n')}
</div>
</body>
</html>
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'manual.html'), html, 'utf8');
const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
console.log(`docs/manual/out/manual.html written - ${seen.size} generated reference topics, ${nodes.filter((n) => n.kind === 'chapter').length} chapters, ~${words} words${fast ? ' (--fast: test counts left as a placeholder)' : ''}`);
console.log(`  figures: ${figCount} placed` + (figMissing.length ? `, ${figMissing.length} WITHOUT AN IMAGE (placeholder shown): ${figMissing.join(', ')} - run npm run manual:shots` : ', every image present') + (figUnknown.length ? ` | ${figUnknown.length} UNKNOWN figure name(s): ${figUnknown.join(', ')}` : ''));
console.log('Render the PDF with:  npm run manual:pdf   (launches Electron)');
