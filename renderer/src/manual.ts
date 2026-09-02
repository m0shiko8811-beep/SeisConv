// seisconv renderer - the in-app Help ("manual") content.
//
// SINGLE SOURCE OF TRUTH for the user manual. `MANUAL.md` at the repo root is
// GENERATED from this file by `npm run gen:manual` (scripts/gen-manual.ts) - edit
// the topics here and re-run it, never edit MANUAL.md by hand. That is why the
// content lives in its own module rather than inside app.ts: a plain Node script
// can import it, while app.ts cannot be imported outside the browser bundle.
//
// -- Help / Manual modal (context-sensitive) --
// Per-topic help content, keyed by the same tab ids the app uses (TABS) plus a
// shared 'general' section. `what` = one-line purpose; `controls` = the REAL
// controls on that tab (label + what it does); `steps` = a short workflow.
// Strings are trusted, hand-authored literals (safe to inject as innerHTML).
export type HelpSection = { h: string; items: string[]; ordered?: boolean };
export type HelpTopic = {
  title: string;
  what: string;
  controls: string[];
  steps: string[];
  // Optional richer content, rendered (only when present) after Controls in this
  // order: extra labelled lists (formats, checklists, flag glossaries, examples…),
  // then "Tips" and honest "Good to know" callouts. Same trusted-literal contract
  // as controls/steps - hand-authored, safe to inject as innerHTML.
  sections?: HelpSection[];
  tips?: string[];
  notes?: string[];
};
export const MANUAL: Record<string, HelpTopic> = {
  general: {
    title: 'Getting started',
    what: 'SeisConv is an offline desktop toolkit for seismic field data: convert between formats, view and QC traces and sections, plot and check SPS survey geometry, analyse frequency content, and keep an observer’s log. Everything runs locally - no account, and your data never leaves the machine.',
    controls: [
      '<b>Open file…</b> (header / each tab) - open one seismic file (SEG-Y, SEG-D, SEG-2/.dat, SU). It is shared across every tab: the Converter, the viewers and Geometry QC all work on the same open file.',
      '<b>Clear</b> - forget the open file (or, on a tab, that tab’s inputs) and reset its panels.',
      '<b>Loaded: … · SPS: …</b> (header centre) - the seismic file and SPS survey currently shared across all tabs; shows “-” when nothing is loaded.',
      '<b>Audit</b> (header) - the audit log &amp; signature (provenance of every change).',
      '<b>Feedback</b> (header) - send a message to the developer.',
      '<b>Theme toggle</b> - switch between light and dark UI.',
      '<b>Icon rail</b> (left) - switch between the tabs; the active one is highlighted. The <b>?</b> at the bottom opens this manual.',
    ],
    steps: [
      'Open a seismic file from the header, or load files inside a tab (e.g. SPS files on the SPS tab).',
      'Use the icon rail, or number keys <span class="kbd">1</span>-<span class="kbd">9</span>, to move between tabs.',
      'Press <span class="kbd" data-key="help">?</span> on any tab for help on that tab; <span class="kbd">Esc</span> closes it.',
      'Set your name once in <b>Audit</b> so every change is signed.',
    ],
    sections: [
      { h: 'The tabs at a glance', items: [
        '<b>Converter</b> - convert one file or a whole folder to another format.',
        '<b>Trace Inspector</b> - one trace at a time: waveform or spectrum, with the live trace header.',
        '<b>File Viewer</b> - the whole record as a section image; plus the Health scan and First breaks QC tools.',
        '<b>SPS</b> - load, plot, QC and reproject survey geometry on a grid or real basemap.',
        '<b>SPS Creation</b> - draw acquisition lines on a map and generate a fresh SPS survey.',
        '<b>Velocity</b> - an NMO semblance panel for picking a stacking-velocity function.',
        '<b>Spectrum</b> - amplitude spectrum, spectrogram and F-K of the record.',
        '<b>Trace Workbench</b> - collect traces from any file(s) and compare them.',
        '<b>Observer Log</b> - a per-shot field log, wizard-built and exportable.',
        '<b>Geometry QC</b> - cross-check trace-header geometry against the SPS, diff as-laid vs pre-plot, and stamp SPS coordinates into a SEG-Y.',
        '<b>Sweeps</b> - design, inspect and export a vibroseis pilot sweep, and QC a recorded one against the design.',
        '<b>WiFiSync</b> - keep a folder identical on two machines over WiFi, with no router, cloud or account.',
      ] },
      { h: 'Keyboard shortcuts', items: [
        '<span class="kbd" data-key="open">Ctrl+O</span> - open a single file',
        '<span class="kbd" data-key="batch">Ctrl+B</span> - Converter, folder (batch) mode',
        '<span class="kbd" data-key="tabs">1-9</span> - switch tabs, no modifier (1 = Converter … 9 = Observer Log). Geometry QC, Sweeps and WiFiSync are click-only - there are no digits left.',
        '<span class="kbd">[</span> / <span class="kbd">]</span> - step to the previous / next file in the open file’s folder',
        '<span class="kbd">Ctrl/Cmd&nbsp;+&nbsp;=</span> / <span class="kbd">-</span> / <span class="kbd">0</span> - UI zoom in / out / reset',
        '<span class="kbd">Wheel</span> over a canvas - zoom the data · drag to pan · double-click to fit',
        '<span class="kbd" data-key="help">?</span> - this manual · <span class="kbd">Esc</span> - close any dialog / exit a magnifier mode',
      ] },
      { h: 'Supported file formats', items: [
        '<b>SEG-Y</b> (.segy / .sgy) - the standard exchange format; revisions 0, 1 and 2. Read and written.',
        '<b>SEG-D</b> (.segd / .seg) - raw field-record format; revisions 1 and 3. Read and written.',
        '<b>SEG-2</b> (.seg2 / .dat) - engineering / shallow-seismic format. Read and written.',
        '<b>SU</b> (.su) - Seismic Unix; trace stream with no reel/textual header. Read and written.',
        '<b>CSV</b> - samples as plain numbers, one trace per column. Export only (not re-readable as seismic).',
        '<b>Tape Image</b> - a multi-file archive container; a folder batch can be combined into one. Read and written.',
        '<b>SPS / SEG-P1 / IOGP P1-11 / P6-11 / coord-CSV</b> - survey geometry (sources, receivers, relations, bin grid). Read on the SPS and Geometry tabs.',
      ] },
      { h: 'Audit log &amp; signature', items: [
        '<b>Signature</b> - type your name once; every change (load, convert, QC, edit, export) is stamped with it and a timestamp.',
        '<b>Audit list</b> - the running log of those stamped actions, per tab.',
        '<b>Export CSV / JSON</b> - save the audit trail for the record.',
        '<b>Backups</b> - snapshots taken automatically before destructive changes; restore the most recent if needed.',
      ] },
      { h: 'Send Feedback', items: [
        'Pick a category, type your message and <b>Send</b> - SeisConv opens your default mail app with it pre-filled. <b>Copy to clipboard</b> is the fallback if no mail app is configured.',
      ] },
      { h: 'Where things save', items: [
        'Converting, exporting or saving always asks you for the destination with a native Save dialog - nothing is written silently.',
        'Your signature, theme and UI zoom are remembered between sessions on this machine.',
      ] },
    ],
    notes: [
      'Amplitude in SEG-Y/SEG-D carries no physical unit - SeisConv labels it “Amplitude (sample value)” and never invents volts or millivolts.',
      'SeisConv is offline-first. The SPS “Real map” basemap is the only feature that uses the internet (to fetch map tiles); everything else works with no connection.',
    ],
  },
  conv: {
    title: 'Converter',
    what: 'Read a seismic file - or a whole folder of them - and write it out in another format, off the UI thread so the app stays responsive on large files.',
    controls: [
      '<b>Convert single file</b> / <b>Convert a folder (batch)</b> - the two cards at the top choose the mode.',
      '<b>Pick a seismic file…</b> (single) / <b>Pick folder…</b> (batch) - choose the source. Batch lists every .segy / .sgy / .segd / .seg / .seg2 / .dat / .bat / .su file in the folder.',
      '<b>Format chips</b> - the output format. Single offers SEG-Y Rev 0/1/2, SU, SEG-2, SEG-D Rev 1/3 and CSV; batch adds <b>Tape Image</b>.',
      '<b>Output name</b> card - build the result file name from a checklist (below); a live preview and the file extension are shown.',
      '<b>Convert &amp; Save…</b> (single) / <b>Convert files</b> (batch) - run it; a native Save dialog (single) or destination folder (batch) is asked for.',
      '<b>Cancel</b> - stop a running batch part-way; files already written are kept.',
      '<b>Clear</b> - forget the open file / picked folder and empty the panels.',
      '<b>File summary</b> - format, trace count, samples/trace, sample interval, record length, data format, revision, byte order and CRS of the loaded file.',
      '<b>Header QC</b> - automatic sanity flags on the file’s headers (e.g. an odd sample interval or inconsistent counts).',
    ],
    sections: [
      { h: 'Output formats', items: [
        '<b>SEG-Y Rev 0</b> - the original layout; broadest compatibility, no extended headers.',
        '<b>SEG-Y Rev 1</b> - adds the extended textual headers and standard trace-header positions. A safe default.',
        '<b>SEG-Y Rev 2</b> - the latest revision; larger trace counts and microsecond timing.',
        '<b>SU</b> - Seismic Unix; SEG-Y trace headers with no reel/textual header. For SU/CWP workflows.',
        '<b>SEG-2</b> - engineering / shallow-seismic instruments.',
        '<b>SEG-D Rev 1 / Rev 3</b> - raw field-record format written by many acquisition systems.',
        '<b>CSV</b> - samples as plain numbers (one trace per column) for spreadsheets or scripts. Export only; not re-readable as seismic.',
        '<b>Tape Image</b> (batch only) - a single archive container. Converting a <i>folder</i> to Tape Image <b>combines every file in it into one archive</b>, rather than writing one output per input.',
      ] },
      { h: 'Output-name checklist', items: [
        '<b>Original name</b> - the input file’s base name → token <span class="kbd">{name}</span>.',
        '<b>Custom text</b> - your own text (e.g. a line name) → <span class="kbd">{custom}</span>.',
        '<b>Format</b> - the chosen format id (segy1, su, …) → <span class="kbd">{fmt}</span>.',
        '<b>Date YYYYMMDD</b> - the date from the picker → <span class="kbd">{date}</span>.',
        '<b>Time HHMM</b> - a time stamp → <span class="kbd">{time}</span>.',
        '<b>Sequence #</b> (batch only) - a per-file counter so names stay unique → <span class="kbd">{seq3}</span> (001, 002…) or <span class="kbd">{n}</span> (1-based index).',
        '<b>Separator</b> - underscore, hyphen or none; joins the ticked parts.',
        '<b>Advanced - name template</b> - edit the raw <span class="kbd">{token}</span> string directly; it stays in sync with the checklist both ways.',
      ] },
      { h: 'Examples', items: [
        'Tick <b>Original name</b> + <b>Date</b>, underscore → <span class="kbd">shot001_20260629.sgy</span>.',
        'Tick <b>Custom text</b> “line12” + <b>Format</b> → <span class="kbd">line12_segy1.sgy</span>.',
        'Batch with <b>Original name</b> + <b>Sequence #</b> → <span class="kbd">rec_001.su</span>, <span class="kbd">rec_002.su</span>, … The live <b>Examples</b> box shows the first few real names before you run.',
      ] },
    ],
    steps: [
      'Choose <b>single</b> or <b>folder (batch)</b> mode.',
      'Pick the file (or folder) and choose an output <b>format</b>.',
      'Tick the <b>output-name</b> parts you want; check the live preview.',
      'Click <b>Convert &amp; Save…</b> / <b>Convert files</b> and choose where the result goes. Watch the progress; <b>Cancel</b> stops a batch.',
    ],
    tips: [
      'Check <b>Header QC</b> before converting - a flagged sample interval or trace count usually means the input format guess is off.',
      'CSV is for inspection in a spreadsheet, not for round-tripping; convert to SEG-Y/SU if you need to re-open the result as seismic.',
    ],
    notes: [
      'Malformed or partly-corrupt inputs are skipped and reported, not crashed on - a batch finishes the files it can and lists what it could not.',
    ],
  },
  trace: {
    title: 'Trace Inspector',
    what: 'Inspect one trace at a time as a time-domain waveform or its amplitude spectrum, with the full SEG-Y trace header alongside.',
    controls: [
      '<b>‹ Prev</b> / <b>Next ›</b> and the <b>slider</b> - step through traces; the label shows the current index and total.',
      '<b>Waveform</b> / <b>Spectrum</b> - the time-domain wiggle, or its amplitude spectrum (FFT).',
      '<b>-</b> / <b>Fit</b> / <b>+</b> - zoom the time axis; or wheel-zoom, drag-pan, double-click to fit on the canvas.',
      '<b>Magnifier</b> (the magnifying-glass icon button, no text label) - click it, then drag a box over the trace to open that time/amplitude region enlarged in a zoom viewer (<span class="kbd">Esc</span> exits).',
      '<b>Axis range</b> - type an exact time and/or amplitude window instead of auto-fit; blank or invalid reverts that axis to auto.',
      '<b>Add to Workbench</b> - push the current trace to the Trace Workbench to compare later.',
      '<b>Hover read-out</b> - under the canvas, the time and amplitude under the cursor.',
      '<b>Trace header</b> table - the live SEG-Y header for the current trace, grouped; it updates on every move.',
    ],
    steps: [
      'Open a seismic file.',
      'Move through traces with <b>Prev</b>/<b>Next</b> or the slider.',
      'Toggle <b>Waveform</b> / <b>Spectrum</b>; zoom or set an exact axis range.',
      'Read the live <b>Trace header</b>; optionally <b>Add to Workbench</b>.',
    ],
    notes: [
      'The amplitude axis is labelled “Amplitude (sample value)” - SEG-Y/SEG-D samples are raw counts with no physical unit.',
    ],
  },
  section: {
    title: 'File Viewer',
    what: 'Render the whole record as a section image - variable-density, wiggle or variable-area - and run two QC tools over it: a trace Health scan and First-break picking.',
    controls: [
      '<b>Open file…</b> / <b>Clear</b> - open or forget the seismic file (shared with every tab).',
      '<b>[</b> / <b>]</b> - step to the previous / next file in the same folder.',
      '<b>Display mode</b> - Variable Density (colour by amplitude), Wiggle (traditional wiggle traces), Variable Area (filled wiggle), or VD + Wiggle (both overlaid).',
      '<b>Colormap</b> - Seismic (blue-white-red), Gray, Amber or Viridis.',
      '<b>Gain</b> slider - scale amplitude for display only (it does not change the data).',
      '<b>AGC</b> - automatic gain control: equalises strong and weak traces so faint far-offset arrivals show. Display only.',
      '<b>-</b> / <b>Fit</b> / <b>+</b> - zoom the data; wheel to zoom, drag to pan, double-click to fit. Zoom re-fetches real samples (not a pixel stretch).',
      '<b>Magnifier</b> (the magnifying-glass icon button, no text label) - click it, then drag a box to open that trace/time region enlarged in a zoom viewer (<span class="kbd">Esc</span> exits).',
      '<b>Axis range</b> - type exact trace and/or time extents.',
      '<b>+ Workbench</b> - toggle on, then click a trace on the canvas to send it to the Trace Workbench.',
      '<b>Trace paging</b> (huge / tape-image files) - a file too large to show at once is paged in fixed blocks; <b>◀</b>/<b>▶</b> step blocks and <b>Block</b> sets the block size.',
      '<b>Hover read-out</b> - trace · time · amplitude under the cursor, with the trace’s FFID / CDP / node and its station (receiver, and source when resolvable - matched to the loaded SPS survey, or the header source point) fetched as you hover.',
    ],
    sections: [
      { h: 'Health scan - flag bad traces (QC proposes, you confirm)', items: [
        '<b>What it does</b> - scans the record for problem traces and <i>proposes</i> them for review. It never edits or kills traces on its own - you confirm what to act on.',
        '<b>Run scan</b> - analyse the open record and list the findings.',
        '<b>Sensitivity Low / Med / High</b> (+ Advanced numeric) - how readily a trace is flagged; the flagged count updates live as you move it. Start at Med; lower it if good traces are flagged, raise it if bad ones slip through.',
        '<b>Findings table</b> - sortable / filterable: trace · FFID:channel · offset · problem · metric vs local baseline · confidence · status. Click a row to locate that trace on the section.',
        '<b>Coverage banner</b> - an honest statement of how much was scanned (e.g. “scanned 20k of 84k traces; polarity on contiguous blocks”). It never implies 100% coverage on very large files.',
        '<b>Confirm / Dismiss</b> - review each finding; confirmed traces build a kill-list you can <b>Kill/zero</b>, <b>Mute</b> or <b>Reverse-polarity</b>.',
        '<b>Export</b> - the kill-list (actionable) and a QC-report CSV (per-detector score, confidence, reason and the local baseline).',
      ] },
      { h: 'Health flags - what each one means', items: [
        '<b>Dead</b> - a flat-line or near-silent trace, judged against its live neighbours on an early time-gate (so a normally-quiet far-offset trace is not called dead).',
        '<b>Noisy</b> - abnormally high energy versus neighbours (a robust outlier), or a bad spectrum (narrow band, out-of-band energy, 50/60 Hz hum).',
        '<b>Reversed</b> - flipped polarity: flagged only on strong, coherent, consistent negative correlation with a neighbour pilot in the first-break window - a genuine AVO reversal is deliberately not flagged.',
        '<b>Hot / weak</b> - amplitude far above or below the local median; the catch-all so a real bad trace does not slip past the narrower families.',
        '<b>Clipped / spiky</b> - runs of samples pinned at the rail, or isolated spikes well above the local spread.',
        '<b>Confidence vs severity</b> - <i>severity</i> is how bad the trace looks; <i>confidence</i> is how sure the test is (how many neighbours contributed, whether it could even run). A high-severity, low-confidence flag is worth a manual look.',
      ] },
      { h: 'First breaks - pick the first arrival (assisted)', items: [
        '<b>What a first break is</b> - the onset of the first seismic energy on each trace (the direct / refracted arrival), used for refraction statics and QC.',
        '<b>How it works</b> - you drop a few <b>seed</b> picks, SeisConv draws a moveout <b>guide</b> curve (with a shaded ±search-window band) through them, then <b>Assisted fill</b> picks every other trace inside that window. The auto-pick is a <i>first guess to edit</i>, not a final answer.',
        '<b>First breaks</b> toggle - turns the mode on; a sub-bar appears and the same section canvas gains the pick overlay.',
        '<b>Click</b> a trace at the onset to set a seed; <b>drag</b> to adjust (the guide re-fills live); <b>right-click</b> to delete a pick.',
        '<b>Assisted fill</b> - run the engine across the gather (needs 2+ seeds). <b>Accept all</b> confirms every pick; <b>Reject flagged</b> drops the low-confidence / off-trend ones; <b>Clear picks</b> removes them all.',
        '<b>Phase</b> (peak / trough / zero-cross) - which part of the wavelet a pick snaps onto. <b>±ms</b> sets the search half-window around the guide (smaller = stricter, less far-trace scatter); <b>Detector</b> selects the onset detector (STA/LTA).',
        '<b>Read-out</b> - trace, FFID, channel, offset, pick (ms), source (seed / auto / edited / flagged) and confidence. <b>Export CSV…</b> saves the picks (absIdx, FFID, channel, offset, tMs, source, confidence). Writing picks into SEG-Y headers is not part of this step - CSV only.',
      ] },
    ],
    steps: [
      'Open a seismic file.',
      'Pick a <b>display mode</b> and <b>colormap</b>; tune <b>Gain</b> / <b>AGC</b> and zoom in on detail.',
      'For QC, run a <b>Health scan</b>, review the findings table, then confirm what to act on.',
      'For statics, turn on <b>First breaks</b>, drop 2+ seeds, <b>Assisted fill</b>, edit, then <b>Export CSV</b>.',
    ],
    tips: [
      'Empty Health scan? Run a scan first and nudge the sensitivity if it over- or under-flags.',
      'Empty First breaks? Drop at least two seed picks, then <b>Assisted fill</b> - the guide needs seeds to anchor the moveout.',
    ],
    notes: [
      'Both QC tools work on real adjacent traces, not the display-decimated view - flags and picks are computed on the true samples even when the section is zoomed out.',
      'Gain and AGC change only how the section looks, never the underlying samples or what you export.',
    ],
  },
  sps: {
    title: 'SPS',
    what: 'Load, plot, QC and reproject survey geometry - sources, receivers and their relations - on an offline survey grid or a real-world basemap.',
    controls: [
      '<b>Load SPS files (S/R/X)…</b> - load source (.s), receiver (.r) and relation (.x) files. Reads SPS, SEG-P1, IOGP P1/11, P6/11 and coordinate-CSV. Loads accumulate, so you can add files in stages.',
      '<b>Clear SPS</b> - forget the loaded survey.',
      '<b>Stats bar</b> - counts of sources, receivers and relations, the line count and survey extent.',
      '<b>Sources</b> / <b>Receivers</b> - overlay toggles for the two point sets.',
      '<b>X-ref spider</b> - draw the shot→receiver fans from the relation (X) file; click a shot to emphasise its fan.',
      '<b>Fold / coverage</b> + <b>Bin m</b> - a CMP fold/coverage heat-map; <b>Bin m</b> sets the bin size.',
      '<b>Bin grid</b> - overlay the P6/11 acquisition bin grid if the survey has one.',
      '<b>Survey grid</b> / <b>Real map</b> - an offline projected grid, or a Leaflet basemap with a scale bar. The grid has a <b>rotation</b> slider (reset to <b>N</b> = north-up).',
      '<b>Headers…</b> - view the raw loaded file headers; edit station fields where supported.',
      '<b>Re-create / Renumber…</b> - re-map the survey&rsquo;s source &amp; receiver line and point numbers, then save the rewritten S / R / X files. Every X-ref range is kept consistent with the new numbering, and vendor columns the data model does not carry are preserved from the original text.',
      '<b>Station read-out</b> - hover any station (grid or map) for a small tooltip with its type (S/R), line and point; click it to open the full inspector.',
      '<b>Station inspector</b> - click any point to see its line/point, coordinates, elevation and the lines through it.',
      '<b>Run QC</b> - check Src int, Rcv int, Tol and Max off; findings list below, each clickable to ring the station on the map.',
      '<b>Reproject to</b> - search the built-in EPSG registry (about 7,000 coordinate reference systems, fully offline) by code, by name, or loosely (&quot;utm 36n&quot;), then <b>Export reprojected (ZIP)…</b>. A CRS SeisConv cannot compute is still listed, but greyed out with the reason.',
      '<b>Export</b> - KML, GeoJSON, CSV, IOGP P1/11, coordinate CSV, <b>SEG-P1</b> (the deprecated fixed-column post-plot file, kept because some legacy processing packages still demand it - grid easting/northing in decimetres) and the QC report.',
      '<b>Export as</b> - any-to-any positioning export: whatever was loaded can be written back out as <b>SPS 2.1</b> (.s / .r / .x), <b>SEG-P1</b>, <b>IOGP P1/11</b> or <b>Coordinate CSV</b>. P6/11 is absent on purpose - it defines a bin grid, not a point survey, so it cannot be produced from source/receiver geometry.',
      '<b>Shapefile</b> - export sources and receivers as ESRI Shapefile point layers (.shp/.shx/.dbf/.prj), zipped. Leave the CRS box empty to write the survey&rsquo;s own coordinates untouched with a .prj describing them; pick a CRS to reproject instead.',
      '<b>GeoTIFF…</b> - a three-step wizard: drag the area on the map (or take the whole survey plus a margin), set the ground resolution in units per pixel, then choose the layers - CMP fold, an elevation surface, and/or the survey layout as a picture. Every layer shares one grid, so they stack in GIS.',
    ],
    sections: [
      { h: 'Reading the plot', items: [
        'Sources and receivers are drawn as separate point layers; the X-ref spider links them per the relation file.',
        'The fold/coverage map bins midpoints - warmer bins have more fold. Use it to spot gaps and the edges of full fold.',
        'On <b>Real map</b> the points sit on a basemap with a scale bar; on <b>Survey grid</b> they sit in projected metres and the rotation slider turns the whole survey for a north-up or line-parallel view.',
      ] },
      { h: 'QC checks', items: [
        '<b>Src int / Rcv int</b> - the expected source / receiver station spacing; flags points off by more than the tolerance.',
        '<b>Tol</b> - the match tolerance in metres.',
        '<b>Max off</b> - the largest source→receiver offset allowed; longer offsets are flagged.',
        'Each finding is clickable - it centres and rings the offending station.',
      ] },
      { h: 'Creating / re-creating an SPS', items: [
        'Build a brand-new survey from scratch on the <b>SPS Creation</b> tab (draw lines → generate S/R/X).',
        'Re-create or correct an existing one by loading it here, editing station fields in <b>Headers…</b>, renumbering with <b>Re-create / Renumber…</b>, reprojecting, and writing it back out with <b>Export as</b>.',
      ] },
    ],
    steps: [
      'Click <b>Load SPS files (S/R/X)…</b> and pick your survey files.',
      'Toggle overlays; switch between <b>Survey grid</b> and <b>Real map</b>; rotate the grid as needed.',
      'Click a point to inspect it; run <b>Run QC</b> and click findings to locate them.',
      'Reproject to another EPSG and <b>export</b> KML / GeoJSON / CSV / P1-11 / QC report.',
    ],
    tips: [
      'Loads accumulate - add the S, R and X files one at a time and the plot grows.',
      'No internet? Stay on <b>Survey grid</b>; only <b>Real map</b> needs to fetch basemap tiles. The EPSG registry is built in, so CRS search and reprojection work fully offline.',
      'Loaded a SEG-P1 or a coordinate CSV and need SPS 2.1? Use <b>Export as</b> - every format feeds the same data model, so any of the four can be written from any of them.',
      'The elevation GeoTIFF never extrapolates: a pixel with no station inside the search radius is written as nodata rather than an invented height.',
    ],
    notes: [
      'The <b>SPS 2.1</b> export carries a matching ESRI <b>.prj</b> when the survey&rsquo;s CRS can be described, because that export is already a ZIP. The other three positioning formats are single files and stay single files - a .prj beside them would turn &ldquo;save a .csv&rdquo; into &ldquo;save a .zip&rdquo; - so they state their CRS inside the file instead: coordinate CSV a <span class="mono"># CRS:</span> tag, IOGP P1/11 an <span class="mono">H,CRS</span> record, SEG-P1 an <span class="mono">H GRID: … DATUM …</span> line. A survey whose CRS cannot be described honestly gets NO .prj rather than a guessed one.',
      'Coordinate reference systems come from the <b>EPSG Geodetic Parameter Dataset</b>, &copy; IOGP (International Association of Oil &amp; Gas Producers), redistributed under its terms of use with attribution. IOGP is not responsible for any modification made to the data, and this use does not imply IOGP endorsement. The authoritative source is the EPSG Registry at epsg.org.',
      'SeisConv computes Transverse Mercator, UTM, geographic, Lambert Conformal Conic, Mercator, Cassini-Soldner, Albers, Lambert Azimuthal Equal Area and Polar/Oblique Stereographic - about 97% of the projected CRSs in the dataset. The rest stay listed but are refused with a reason, as are CRSs whose datum tie needs an NTv2/NADCON grid file (OSGB36, NAD27 and similar). Native export still works for those, and the .prj names the CRS correctly so your GIS can do the shift properly.',
    ],
  },
  spscreate: {
    title: 'SPS Creation',
    what: 'Build the survey plan - draw acquisition lines on a basemap or import an existing preplot - edit it point by point, check it, then generate a fresh SPS survey (or export the plan straight out).',
    controls: [
      '<b>2D</b> / <b>3D</b> - acquisition mode (3D is coming soon and disabled).',
      '<b>CRS</b> - the coordinate reference system, auto-suggested from your first pick (ITM inside Israel, otherwise the UTM zone); click to review or override it in the wizard.',
      '<b>Import plan…</b> - load an existing survey plan from CSV / TSV / GeoJSON, mapping the file&rsquo;s columns onto line, station, coordinates and elevation. An imported preplot is already positioned and numbered, so it can go straight out again without a layout wizard.',
      '<b>SPS 2.1</b> / <b>CSV</b> / <b>GeoJSON</b> / <b>KML</b> (Export plan) - write the plan out as it stands. <b>SPS 2.1</b> produces the S / R / X files directly - no layout wizard - and is available only when every line is a preplot (a drawn line still needs a station interval, so use <b>Generate…</b> for those). <b>CSV</b> carries line, station, lat/long, elevation, E/N and per-segment metrics; <b>GeoJSON</b> writes a LineString per line plus a Point per station; <b>KML</b> writes a Folder per line.',
      '<b>Map</b> - click to drop line vertices; the cursor read-out shows lat/long and projected E/N.',
      '<b>+ Next line</b> - finish the current line (needs ≥2 vertices) and start a new one.',
      '<b>Undo</b> (<span class="kbd">Ctrl+Z</span> on this tab) - step back through the plan&rsquo;s own history; <b>Clear</b> removes every line.',
      '<b>Generate…</b> - open the wizard (intervals, line/point numbering, relation, source/receiver type, output name), then create &amp; save the S / R / X files.',
    ],
    sections: [
      { h: 'Editing the plan on the map', items: [
        '<b>View</b> / <b>Drag points</b> / <b>Add on click</b> - the three edit modes. <b>View</b> pans the map and a click opens a station&rsquo;s details; <b>Drag points</b> moves a station by dragging it; <b>Add on click</b> appends a point to the line chosen in <b>Target line</b>.',
        '<b>Target line</b> - which line a newly added point joins, so you can go back and extend an earlier line instead of always the last one.',
        '<b>Layers</b> - <b>Basemap</b>, <b>Connection lines</b>, <b>Direction arrows</b>, <b>Distance labels</b> and <b>Stations &amp; numbers</b>, each with its own on/off tick and an opacity slider - turn the map down to read the stations, or the stations down to read the map.',
        '<b>Zoom speed</b> - how far one wheel notch zooms the map; slow it down for fine positioning work.',
      ] },
      { h: 'The Points / Checks / Lines panes', items: [
        '<b>Points</b> - every point of the plan in an editable table, filterable to one line. <b>Renumber 1..N</b> renumbers the shown line&rsquo;s stations (SPS numbering is per line), <b>Sort by station</b> orders every line&rsquo;s points by station number, and <b>Fit map to plan</b> zooms the map to the whole plan.',
        '<b>Checks</b> - the consistency checks run over the plan; click a finding to locate it.',
        '<b>Lines</b> - one row per acquisition line, with its colour, station count and length.',
      ] },
      { h: 'Plan checks that block Generate', items: [
        'Only findings of severity <b>error</b> block <b>Generate…</b> and the <b>SPS 2.1</b> plan export - warnings and info are shown but never stop you. When one is present the Checks pane opens and the status line says how many to fix.',
        '<b>Duplicate line name</b> - two lines share a name, so they would merge into one line in the generated survey.',
        '<b>Line with fewer than 2 points</b> - a line needs at least two stations to be a line.',
        '<b>Zero-length segment</b> - two consecutive stations at the same position.',
        '<b>Duplicate station on a line</b> - the same station number twice on one line; SPS numbering is per line and must be unique within it.',
        '<b>Preplot line with missing station numbers</b> - a preplot is used as-is, so every one of its points must carry a station number.',
      ] },
    ],
    steps: [
      'Click the map to place the vertices of the first acquisition line, or <b>Import plan…</b> to bring in an existing preplot.',
      'Use <b>+ Next line</b> for additional lines; <b>Undo</b> (Ctrl+Z) / <b>Clear</b> to correct, and the <b>Drag points</b> / <b>Add on click</b> modes plus the <b>Points</b> table to fix individual stations.',
      'Review the auto-suggested <b>CRS</b> (override if needed) and read the <b>Checks</b> pane - clear every error.',
      'Click <b>Generate…</b>, confirm the parameters, then create &amp; save - the new survey opens on the <b>SPS</b> tab. An already-numbered preplot can instead go straight out via the <b>SPS 2.1</b> plan export.',
    ],
    tips: [
      'Errors block, warnings do not - an over-long segment or an odd spacing is flagged for you to judge, not refused.',
    ],
    notes: [
      '3D acquisition design is not available yet - the 2D workflow is the supported one.',
      'The generated survey carries a matching ESRI <b>.prj</b> when its CRS can be described, so it opens georeferenced in a GIS.',
    ],
  },
  vel: {
    title: 'Velocity',
    what: 'Compute an NMO semblance panel from the open gather and pick a stacking-velocity function.',
    controls: [
      '<b>Vmin</b> / <b>Vmax</b> / <b>Step</b> - the velocity scan range and increment.',
      '<b>Compute semblance</b> - build the semblance panel from the open record.',
      '<b>Panel</b> - click to add velocity picks along the time axis; the picked function is drawn through them.',
      '<b>-</b> / <b>Fit</b> / <b>+</b> and <b>Axis range</b> - zoom the panel.',
      '<b>Export picks CSV…</b> - save the picked time/velocity pairs.',
    ],
    steps: [
      'Open a seismic file (a CMP/CDP gather gives the cleanest semblance).',
      'Set <b>Vmin</b> / <b>Vmax</b> / <b>Step</b> and click <b>Compute semblance</b>.',
      'Click the bright semblance peaks to add picks down the panel.',
      'Click <b>Export picks CSV…</b> to save the velocity function.',
    ],
    notes: [
      'Semblance is strongest on a sorted gather with moveout; on a raw shot the peaks will be less focused.',
    ],
  },
  spectrum: {
    title: 'Spectrum',
    what: 'Frequency-domain QC of the open record: amplitude spectrum, spectrogram and frequency-wavenumber (F-K).',
    controls: [
      '<b>Average spectrum</b> / <b>Spectrogram</b> / <b>F-K</b> - choose the view.',
      'Average: <b>Linear</b> / <b>dB</b> scale, a <b>From</b>/<b>To</b> trace window to average over, and <b>Recompute</b>.',
      'Spectrogram: <b>Prev</b>/<b>Next</b> or <b>Trace #</b> to choose the trace, and a <b>Window</b> length (longer = finer frequency, coarser time).',
      'F-K: <b>Recompute</b> builds the frequency-wavenumber panel.',
      '<b>-</b> / <b>Fit</b> / <b>+</b> and axis controls - zoom each view.',
    ],
    sections: [
      { h: 'Reading the views', items: [
        '<b>Amplitude spectrum</b> - energy vs frequency, averaged over the trace window. Shows the signal band and where it rolls off; spikes at 50/60 Hz are mains hum.',
        '<b>Spectrogram</b> - how one trace’s frequency content changes with time; useful for spotting dispersive noise or ringing.',
        '<b>F-K</b> - energy in frequency vs wavenumber; coherent dipping events (ground roll, multiples) map to distinct lines, aiding dip / velocity QC.',
      ] },
    ],
    steps: [
      'Open a seismic file.',
      'Choose <b>Average spectrum</b>, <b>Spectrogram</b> or <b>F-K</b>.',
      'Set that view’s parameters and click <b>Recompute</b>.',
      'Zoom in to inspect the band, the hum lines or the dipping energy.',
    ],
    notes: [
      'The amplitude axis carries no physical unit; use <b>dB</b> to compare relative levels across the band.',
    ],
  },
  workbench: {
    title: 'Trace Workbench',
    what: 'Collect individual traces from any file(s) and compare them side-by-side or overlaid, with cross-correlation, difference and stats between any two.',
    controls: [
      '<b>Pick file…</b>, <b>Trace #</b>, <b>Add open trace</b> - gather traces into the bench from any file.',
      'Click traces in from <b>Trace Inspector</b> (Add to Workbench) or the <b>File Viewer</b> (+ Workbench, then click a trace).',
      '<b>Collected list</b> - each trace with a colour swatch, label and a remove button.',
      '<b>Side-by-side</b> / <b>Overlay</b> - layout for the collected traces.',
      '<b>-</b> / <b>Fit</b> / <b>+</b> and <b>Axis range</b> - zoom all traces in lock-step.',
      '<b>Invert</b> - flip trace polarity in the plot. Display only: the collected samples, the analysis and the export are unaffected.',
      '<b>A</b> / <b>B</b> selectors (in the <b>Analysis</b> card) - choose two traces for cross-correlation, difference and stats (lag, peak correlation, RMS difference). The pair of drop-downs appears once at least two traces are collected.',
      '<b>Clear all</b> - empty the collected list.',
      '<b>Export</b> - a format drop-down (SEG-Y Rev 0 / 1 / 2, Seismic Unix, SEG-2 / .dat, SEG-D Rev 1 / 3, CSV / ASCII) next to <b>Export…</b>, which asks where to save. If the collected traces have different sample intervals a note says so - the output takes the first trace&rsquo;s interval.',
    ],
    steps: [
      'Add traces via <b>Pick file…</b> + <b>Add</b>, or push from Trace Inspector / File Viewer.',
      'Compare with <b>Side-by-side</b> or <b>Overlay</b>; zoom in lock-step.',
      'Select <b>A</b> and <b>B</b> in the Analysis card to read cross-correlation and difference; <b>Invert</b> if one trace was recorded with opposite polarity.',
      'Choose an export <b>format</b> and click <b>Export…</b> to save the collected traces.',
    ],
    tips: [
      'Traces from different files keep their own labels and colours, so you can A/B a trace against the same channel from another shot.',
    ],
  },
  obslog: {
    title: 'Observer Log',
    what: 'Build and maintain a per-shot field log - wizard-configured columns, an editable grid, time-stamping and one-click export.',
    controls: [
      '<b>Wizard</b> - project header, columns (field groups + custom columns), source type (Explosive / Vibroseis / Nodal), and how rows are seeded (from the open data or blank).',
      '<b>Build log</b> - create the grid from the wizard settings.',
      '<b>+ Add row</b> - append a shot row; rows can be inserted, deleted and reordered.',
      '<b>Renumber below…</b> - pick an anchor row, confirm/edit its Shot point + interval (+ optional File# start), and recompute SP / File# for the anchor and every row after it. Fixes a stuck / re-shot / skipped shot and recalculates the interval; audited.',
      '<b>Columns…</b> - rename, reorder, retype, set a role and unit, add or remove columns; existing values for surviving columns are kept.',
      '<b>Import sources from SPS</b> - seed shot rows from the loaded SPS survey.',
      '<b>Reconfigure…</b> - re-run the wizard over the current log.',
      '<b>Time-source</b> - stamp times from the PC clock or an NTP server (with the offset shown).',
      '<b>Trigger Watch</b> - master ON/OFF + status dot + sound toggle + <b>Configure…</b>: pick a <b>trigger system</b> and add a highlighted row the moment a shot triggers (see below).',
      '<b>Save log</b> / <b>Reload…</b> and <b>Templates</b> - persist, restore and reuse configurations.',
      '<b>Export</b> - Excel, CSV, LibreOffice or a formatted Report.',
    ],
    sections: [
      { h: 'Column roles', items: [
        'A column’s <b>role</b> tells SeisConv what it holds (e.g. shot number, FFID, time, coordinate, comment) so it can fill, validate and format it - set roles in <b>Columns…</b>.',
        'Roles drive features like <b>Import sources from SPS</b> (which fields it fills) and time-source stamping (which column gets “Now”).',
      ] },
      { h: 'Trigger Watch - a live row on every shot', items: [
        '<b>Trigger system</b> (in <b>Configure…</b>) - pick your recording system and its sources + File# sync are configured for you. <b>Geometrics Geode (SCS)</b> is system #1: it triggers on the SCS <b>TempCom</b> event (passive, file-independent - it fires even for shots that are never saved) and keeps the log’s File# in sync with SCS’s real recorder file number, read from the <span class="mono">.dat</span> in the SC_Files save folder. The generic sources (folder watch / UDP / serial / SCS log) stay available under <b>Advanced / generic sources</b> for non-Geode setups. New trigger systems can be added as registry entries without rewiring the UI.',
        '<b>Sources</b> (any combination, under <b>Advanced</b> in <b>Configure…</b>): <b>watch the acquisition folder</b> - a row when the recorder (e.g. SCS) writes the shot file (works today, zero hardware; latency equals the file-write moment); <b>SCS survey log</b> - tail the Geometrics <span class="mono">SC_Survey.####.log</span>: a row per shot at the <b>real trigger time</b>, straight from the recorder - it fires <b>even for shots that are never saved</b> (independent of the .dat file / Auto-Save). FFID = the log’s File #, time from the log timestamp; <span class="mono">READ</span> (file re-read) lines are ignored; <b>UDP listener</b> - one-line text or JSON <span class="mono">{"trig":id,"ts":…}</span> datagrams, 127.0.0.1 only unless LAN is explicitly enabled; <b>serial trigger box</b> - the true trigger-time feed: the serial trigger box’s <span class="mono">[SHOT] #id Lline:SPsp ts=…</span> USB-serial line at contact closure (GPS time; plain TRIG-style lines from other hardware are accepted too). Pick the COM port + baud in Configure…; the end-to-end hardware check happens in the field with the box connected.',
        '<b>Two-stage rows</b> - a trigger adds a highlighted <b>pending</b> row instantly: counters advance, the time column takes the event/GPS timestamp, and the next source station is pre-filled from the loaded SPS order. When the shot file lands in the watched folder the row is <b>enriched</b> (FFID, file name, traces, sample interval, record length).',
        '<b>Auto-number (shot controller · File# sync)</b> - turn it on in <b>Configure…</b> to advance the Shot point and keep the File# in sync on every trigger, while every cell stays editable. <b>SP is a fixed step</b>: new SP = previous SP + (direction × step × interval); the first auto-row seeds the <b>SP start</b> (no SPS geometry needed - change step / interval any time; SP auto-advance is unchanged). On the <b>Geometrics Geode (SCS)</b> system the <b>File# mode</b> keeps the log’s File# synced to SCS’s real recorder file number, with two per-survey choices: <b>Seed + auto-correct</b> - enter SCS’s current/next File# once; each Geode trigger shows it INSTANTLY (counter from the seed) and auto-corrects from the real <span class="mono">.dat</span> File# when it lands in SC_Files (a mismatch is flagged); or <b>Read from file</b> - File# is blank on the trigger, then filled with SCS’s exact number read from the <span class="mono">.dat</span>. (A generic <b>Counter only</b> mode, +1 each trigger with no recorder sync, is also available.) Triggering ALWAYS fires on the trigger EVENT above - the <span class="mono">.dat</span> read is enrichment only, never a trigger; the number syncs from the saved file.',
        '<b>Stuck / re-shot shots</b> - no auto-detect and no Hold button: every SP / File# cell is inline-editable, and <b>Renumber below…</b> recomputes SP + File# for a chosen row and all rows after it (using a possibly-changed interval). That is how re-shoots, skips and drift are fixed.',
        'A pending row stays highlighted until <b>you edit it</b> - the log is yours; Trigger Watch only assists. Every auto-write (advance, enrichment, reconcile correction, renumber) lands in the audit trail.',
        '<b>Catch-up</b> - when the watch starts, shot files newer than the last logged trigger are listed and you choose every time: <b>Add all</b>, <b>Add selected</b>, or <b>Skip</b>.',
        'Each trigger flashes the status dot, shows a toast and (optionally) beeps - toggle the beep with <b>Sound</b>.',
        'The folder is only ever watched and read - SeisConv never writes into the acquisition folder.',
      ] },
    ],
    steps: [
      'Run the <b>wizard</b>: header → columns → source type → rows.',
      'Click <b>Build log</b> to create the grid.',
      'Edit cells; add, insert, delete or reorder rows; stamp times from PC / NTP.',
      'Save, or <b>export</b> to Excel / CSV / Report.',
    ],
    tips: [
      'Save a configured-but-empty log as a <b>Template</b> to start every crew day from the same layout.',
    ],
  },
  geomqc: {
    title: 'Geometry QC',
    what: 'Cross-check the open seismic file’s trace-header geometry against the loaded SPS, diff an as-laid survey against a pre-plot reference, and stamp SPS coordinates into a SEG-Y.',
    controls: [
      '<b>Open file…</b> / <b>Open SPS…</b> / <b>Clear</b> - the seismic file and SPS survey to check (shared with the other tabs).',
      '<b>Tolerance</b> (check) - the station-match tolerance in metres (default 2).',
      '<b>Geometry check results</b> - how many trace headers match an SPS station within tolerance, and the mismatches. Clickable findings ring the station on the SPS map.',
      '<b>Load geometry → save SEG-Y</b> - stamp the SPS survey’s coordinates into the open SEG-Y’s trace headers and save a new geometry-loaded SEG-Y.',
      '<b>Tolerance</b> (load) - the match tolerance used when stamping.',
      '<b>Scalar</b> - the SEG-Y coordinate scalar written to the headers (controls stored precision).',
      '<b>Coordinates</b> / <b>Elevations</b> / <b>Offset</b> / <b>CDP X/Y</b> - which fields to stamp: source &amp; group X/Y, source &amp; receiver elevation, source→receiver offset, and CDP / ensemble-midpoint X/Y.',
      '<b>As-laid vs pre-plot delta</b> - pick a pre-plot (reference) SPS triplet and diff the loaded as-laid survey against it; reports the per-station skid (the as-laid↔pre-plot distance).',
    ],
    sections: [
      { h: 'The three jobs', items: [
        '<b>Check</b> - does the SEG-Y already carry geometry that agrees with the SPS? Lists matched and unmatched traces within tolerance.',
        '<b>Load</b> - write SPS coordinates / elevations / offset / CDP into the SEG-Y trace headers, producing a geometry-loaded copy (the original is untouched).',
        '<b>Delta</b> - compare where stations were actually laid against where they were planned (as-laid vs pre-plot), per station.',
      ] },
    ],
    steps: [
      'Open the seismic file and the SPS survey.',
      'Set the <b>Tolerance</b> and read the geometry-check results; click a finding to locate it.',
      'To stamp geometry: choose the <b>Scalar</b> and the fields, then <b>Load geometry &amp; save…</b>.',
      'To audit positioning: <b>Compare to reference SPS…</b> for the as-laid vs pre-plot delta.',
    ],
    notes: [
      'Loading geometry writes a new SEG-Y - your input file is never modified in place.',
      'Stations that do not match any SPS point within tolerance are reported as unmatched and left unstamped, not guessed.',
    ],
  },
  sweeps: {
    title: 'Sweeps',
    what: 'Design the vibroseis pilot sweep - the controlled chirp a vibrator shakes into the ground - inspect it (signal, frequency-vs-time, spectrum, Klauder wavelet), export it (pilot trace, SCIO .SV table, printable sweep sheet) and QC a recorded sweep against the design.',
    controls: [
      '<b>Type</b> - the frequency law. <b>Linear</b>: constant Hz/s. <b>dB/Hz</b> / <b>dB/Octave</b>: nonlinear dwell - the sweep spends more (or less) time per Hz so the energy spectrum tilts by the given slope. <b>T-Power</b>: the sweep rate grows as tⁿ, dwelling at the start frequency. Pseudo-random sweeps are deliberately not offered.',
      '<b>Start / End Hz</b> - the band (0.1-999.9 Hz); End below Start gives a downsweep.',
      '<b>Length ms</b> - sweep duration (1-65535 ms).',
      '<b>Taper in / out</b> - ramp the envelope at the ends (ms). Tapers keep the vibrator from slamming to full force instantly and control spectral edge ripple (Gibbs).',
      '<b>Taper</b> shape - <b>Cosine</b> (half-cosine ramp) or <b>Blackman</b> (softer shoulders, slightly wider skirts).',
      '<b>Phase °</b> - the initial phase φ₀. 180° inverts the pilot’s polarity (see the polarity note below).',
      '<b>Pilot dt</b> - the exported pilot trace’s sample interval (0.25 / 0.5 / 1 / 2 ms; default 0.5). This is only the pilot file’s rate - the vibrator’s own DSP rate is fixed by its electronics, and the SCIO .SV table is always written at 2048 samples/s.',
      '<b>Amplitude</b> - peak envelope as a fraction of full scale (scales the .SV envelope column: 1.0 ≡ 10 V).',
      '<b>Segmented sweep</b> - chain up to 16 segments, each with its own law / band / length; the generator keeps phase continuous across every join.',
      '<b>Survey presets</b> - save/load the whole design + QC thresholds per survey (each crew’s specs differ); export/import as .json to share between machines.',
      '<b>Build sweep</b> - generate and refresh the four plots.',
      '<b>Export</b> - pilot trace (SEG-Y Rev 2 / SU / CSV), SCIO <b>.SV</b> sweep table, and a printable HTML <b>sweep sheet</b> with the plots embedded.',
      '<b>Load measured sweep…</b> (QC panel) - open a recorded pilot / ground-force / similarity trace and compare it against the design: phase error vs time, envelope + spectrum overlays, THD vs time, and the designed×measured correlation wavelet.',
    ],
    steps: [
      'Set the sweep parameters (or <b>Load</b> a survey preset), then <b>Build sweep</b>.',
      'Read the plots: the signal and its envelope, the frequency-vs-time law, the amplitude spectrum, and the Klauder wavelet (what a spike looks like after correlation with this sweep) with its side-lobe readout.',
      'Export what the job needs: the pilot trace for the recorder/processing, the .SV table for the sweep generator, the sweep sheet for the observer’s book.',
      'To QC a recorded sweep: <b>Load measured sweep…</b>, pick the trace, and judge the phase-error / THD / envelope panels against the thresholds (editable; saved with the preset).',
    ],
    sections: [
      { h: 'The four plots', items: [
        '<b>Pilot signal</b> - the sweep itself, amplitude vs time, tapers visible at the ends.',
        '<b>Frequency vs time</b> - the sweep law; segments show as slope changes with no jumps.',
        '<b>Amplitude spectrum</b> - in-band level and edge roll-off; nonlinear sweeps show their designed tilt.',
        '<b>Klauder wavelet</b> - the sweep’s autocorrelation: the effective source wavelet after correlation. Narrow main lobe = better time resolution; the peak/side-lobe ratio (dB) is the readout to watch.',
      ] },
      { h: 'Sweep QC verdicts', items: [
        '<b>Phase error vs time</b> - instantaneous phase of the measured sweep minus the design; industry practice holds the average within ~10° and peaks within ~20-25°.',
        '<b>THD vs time</b> - harmonic distortion of the measured sweep (windowed-FFT harmonics over the fundamental); high THD at low frequency usually means the mass or flow limit was hit.',
        '<b>Envelope / spectrum overlays</b> - drive drop-outs, decoupling and resonances show here.',
        '<b>Correlation wavelet</b> - designed × measured; a clean sweep reproduces the Klauder wavelet with the peak at lag 0.',
        'The pass/fail thresholds (avg phase ≤ 10°, peak ≤ 20°, THD ≤ 35% by default) are editable and stored in the survey preset - set them to your contract’s QC spec.',
      ] },
      { h: 'Polarity - the accelerometer trap', items: [
        'Vibrator electronics that follow the SEG polarity standard have accelerometers wired <b>positive-UP</b>, while the SEG field-recording convention expects the first breaks of a compressive source <b>negative</b> (upward ground motion at the start of a downward push reads positive on the accel). On Pelton-style systems the practical rule is: if the recorded similarity/ground-force polarity comes out inverted against the pilot, run the pilot at <b>Phase = 180°</b> rather than rewiring - the correlation then restores standard polarity.',
        'Check polarity once per crew/instrument combination with a similarity test before production - do not assume.',
      ] },
    ],
    tips: [
      'A longer sweep or wider band both sharpen the Klauder wavelet; tapers trade a little in-band energy for much cleaner spectral edges.',
      'Long sweeps at 0.25 ms can exceed 65535 samples - SEG-Y/SU cannot carry that in one trace; the exporter will say so and suggest a coarser pilot dt or CSV.',
    ],
    notes: [
      'The advisories shown after a build (force setpoint 50-80% of hold-down, low-frequency displacement limit) are guidance only - the vibrator’s own limits always govern what the machine physically does.',
      'Sweep QC verdicts here are advisory: they flag numbers against your thresholds; accepting or re-shooting a VP stays the observer’s call.',
    ],
  },
  field: {
    title: 'WiFiSync',
    what: 'Keep a folder identical on two machines over WiFi, with no router, cloud or account. One machine can even host a WiFi hotspot so the pair connects anywhere in the field. It speaks the same wire protocol as the standalone WiFiSync app, so it interoperates with it directly.',
    controls: [
      '<b>Folder · Choose…</b> - the folder that is kept mirror-identical with the peer. Everything under it (recursively) is synced.',
      '<b>Role</b> - <b>Two-way</b> (default): both machines push and pull changes. <b>Master</b>: this machine owns the data and only serves it (never pulls). <b>Slave</b>: mirror the master exactly - pull everything and delete local extras. When a peer advertises Master or Slave, the app auto-adopts the complement and locks the radios.',
      '<b>Adapter</b> - which network adapter to discover/broadcast on; “Auto” broadcasts on all. On a hotspot host this is usually the 192.168.137.x adapter.',
      '<b>Peer IP</b> - optional: connect straight to a known peer IP instead of auto-discovery.',
      '<b>Open firewall ports…</b> - open UDP 47823 + TCP 47824 in the Windows Firewall (Private profile only). Run it on BOTH machines when discovery or transfers are blocked.',
      '<b>Scan network</b> - actively sweep the selected adapter&rsquo;s subnet for other WiFiSync instances, for when the passive discovery broadcasts do not get through.',
      '<b>Sync mode</b> - <b>On change</b> syncs the instant a file changes; <b>Every N s</b> polls on the interval.',
      '<b>Rate limit</b> - cap transfer speed (KB/s) so a sync does not saturate a field link.',
      '<b>Start / Stop WiFiSync</b> - bring the engine (file server + discovery) up or down.',
      '<b>Peers</b> - machines discovered on the network; <b>Add peer</b> connects one by IP; <b>Sync now</b> runs a single pass immediately.',
      '<b>WiFi hotspot</b> - <b>Name / Password</b> then <b>Start hotspot</b> to host a network from this PC (Windows Mobile Hotspot). <b>Status</b> reads the live state; <b>Host IP</b> shows the address to give the peer; <b>Open Windows Mobile Hotspot…</b> jumps to the Windows setting. <b>Reset WiFi</b> restarts the WiFi adapter and the hotspot service (UAC prompt) when the hotspot refuses to come up.',
      '<b>Activity &amp; transfers</b> - the live log plus the pulled/deleted history (newest first); <b>Clear history</b> empties the log.',
    ],
    steps: [
      'Pick the shared <b>Folder</b> on both machines and leave <b>Role</b> on Two-way.',
      'On one machine, optionally <b>Start hotspot</b> and connect the other machine’s WiFi to it; note the <b>Host IP</b>.',
      'Press <b>Start WiFiSync</b> on both. A peer appears in the list within a few seconds (or use <b>Add peer</b> with the Host IP).',
      'Edit files in the folder - they copy across automatically; use <b>Sync now</b> to force a pass.',
    ],
    notes: [
      'Deletions propagate via tombstones, and a guard prevents a peer whose drive went offline (empty manifest) from wiping your local files.',
      'The file server is unauthenticated by design - only run WiFiSync on a trusted field network (or the hotspot you host). Firewall rules it may add are scoped to the Private profile.',
      'Hotspot and adapter/firewall changes only ever happen on your explicit click; nothing here mutates the network on its own.',
    ],
  },
};
