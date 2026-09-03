# SeisConv - Manual

<!-- GENERATED FILE - DO NOT EDIT BY HAND.
     Source: renderer/src/manual.ts (the in-app Help, opened with `?`).
     Regenerate with:  npm run gen:manual  -->

This is the same content the app shows under **?** (Help), one topic per tab.
Key hints use **Ctrl** on Windows/Linux and **Cmd** on macOS; the app shows the
right glyph for your OS automatically.

---

## Getting started

SeisConv is an offline desktop toolkit for seismic field data: convert between formats, view and QC traces and sections, plot and check SPS survey geometry, analyse frequency content, and keep an observer’s log. Everything runs locally - no account, and your data never leaves the machine.

### Controls

- **Open file…** (header / each tab) - open one seismic file (SEG-Y, SEG-D, SEG-2/.dat, SU). It is shared across every tab: the Converter, the viewers and Geometry QC all work on the same open file.
- **Clear** - forget the open file (or, on a tab, that tab’s inputs) and reset its panels.
- **Loaded: … · SPS: …** (header centre) - the seismic file and SPS survey currently shared across all tabs; shows “-” when nothing is loaded.
- **Audit** (header) - the audit log & signature (provenance of every change).
- **Feedback** (header) - send a message to the developer.
- **Theme toggle** - switch between light and dark UI.
- **UI size** (status bar, bottom) - make the whole interface bigger or smaller: drag the slider, or use **-** / **+**. The percentage next to it shows the current size and clicking it resets to 100%. The same thing as `Ctrl +` / `Ctrl -` / `Ctrl 0`, and it is remembered between sessions. The range is 50% to 250%: drop to 70-80% if the app feels too big on a small laptop screen, or push it up on a bright site where the text is hard to read.
- **Icon rail** (left) - switch between the tabs; the active one is highlighted. The **?** at the bottom opens this manual.

### The tabs at a glance

- **Converter** - convert one file or a whole folder to another format.
- **Trace Inspector** - one trace at a time: waveform or spectrum, with the live trace header.
- **File Viewer** - the whole record as a section image; plus the Health scan and First breaks QC tools.
- **SPS** - load, plot, QC and reproject survey geometry on a grid or real basemap.
- **SPS Creation** - draw acquisition lines on a map and generate a fresh SPS survey.
- **Geometry QC** - cross-check trace-header geometry against the SPS, diff as-laid vs pre-plot, and stamp SPS coordinates into a SEG-Y.
- **Velocity** - an NMO semblance panel for picking a stacking-velocity function.
- **Spectrum** - amplitude spectrum, spectrogram and F-K of the record.
- **Trace Workbench** - collect traces from any file(s) and compare them.
- **Observer Log** - a per-shot field log, wizard-built and exportable.
- **Sweeps** - design, inspect and export a vibroseis pilot sweep, and QC a recorded one against the design.
- **WiFiSync** - keep a folder identical on two machines over WiFi, with no router, cloud or account.

### Keyboard shortcuts

- `Ctrl+O` - open a single file
- `Ctrl+B` - Converter, folder (batch) mode
- `1-9` - switch tabs, no modifier. The digits follow the icon rail from the top: **1** Converter, **2** Trace Inspector, **3** File Viewer, **4** SPS, **5** SPS Creation, **6** Geometry QC, **7** Velocity, **8** Spectrum, **9** Trace Workbench.
- `O` - Observer Log (mnemonic: **O**bserver). It sits tenth on the rail, past the last digit, but it is the one tab an observer works in all day, so it gets a letter of its own. **Sweeps** and **WiFiSync** are the only two tabs with no keyboard shortcut at all - click them on the rail. They are set-up and QC tools you visit occasionally rather than live in, so they do not spend a key.
- Every one of these (the digits, **O**, `[` / `]` and `?`) is ignored while you are typing in a box, so a note that contains an “o” or a digit stays in the field.
- `[` / `]` - step to the previous / next file in the open file’s folder
- `Ctrl/Cmd + =` / `-` / `0` - UI zoom in / out / reset
- `Wheel` over a canvas - zoom the data · drag to pan · double-click to fit
- `?` - this manual · `Esc` - close any dialog / exit a magnifier mode

### Supported file formats

- **SEG-Y** (.segy / .sgy) - the standard exchange format; revisions 0, 1 and 2. Read and written.
- **SEG-D** (.segd / .seg) - raw field-record format; revisions 1 and 3. Read and written.
- **SEG-2** (.seg2 / .dat) - engineering / shallow-seismic format. Read and written.
- **SU** (.su) - Seismic Unix; trace stream with no reel/textual header. Read and written.
- **CSV** - samples as plain numbers, one trace per column. Export only (not re-readable as seismic).
- **Tape Image** - a multi-file archive container; a folder batch can be combined into one. Read and written.
- **SPS / SEG-P1 / IOGP P1-11 / P6-11 / coord-CSV** - survey geometry (sources, receivers, relations, bin grid). Read on the SPS and Geometry tabs.

### Audit log & signature

- **Signature** - type your name once; every change (load, convert, QC, edit, export) is stamped with it and a timestamp. Until you do, entries are recorded as `(unsigned)` and the first audited action raises a one-off snackbar with a **Sign…** button. It is only an invitation - it never covers the screen and never blocks what you are doing; ignore it and carry on, or open **Audit** yourself at any time.
- **Audit list** - the running log of those stamped actions, per tab.
- **Export CSV / JSON** - save the audit trail for the record.
- **Clear log** - **destructive.** Deletes every entry in the audit log on this machine, after a confirmation. There is no undo and no backup of the log: once cleared, the provenance trail of everything you did before that point is gone for good. Export CSV or JSON first if the record matters. Your signature, and the files you already produced, are not touched.
- **Backups** - snapshots taken automatically before destructive changes; restore the most recent if needed.

### Send Feedback

- Pick a category, type your message and **Send** - SeisConv opens your default mail app with it pre-filled. **Copy to clipboard** is the fallback if no mail app is configured.

### Where things save

- Converting, exporting or saving always asks you for the destination with a native Save dialog - nothing is written silently.
- Your signature, theme and UI zoom are remembered between sessions on this machine.

### How to use it

1. Open a seismic file from the header, or load files inside a tab (e.g. SPS files on the SPS tab).
2. Use the icon rail, or number keys `1`-`9` (plus `O` for the Observer Log), to move between tabs.
3. Press `?` on any tab for help on that tab; `Esc` closes it.
4. Set your name once in **Audit** so every change is signed.

### Good to know

- Amplitude in SEG-Y/SEG-D carries no physical unit - SeisConv labels it “Amplitude (sample value)” and never invents volts or millivolts.
- SeisConv is offline-first. The SPS “Real map” basemap is the only feature that uses the internet (to fetch map tiles); everything else works with no connection.

---

## Converter

Read a seismic file - or a whole folder of them - and write it out in another format, off the UI thread so the app stays responsive on large files.

### Controls

- **Convert single file** / **Convert a folder (batch)** - the two cards at the top choose the mode.
- **Pick a seismic file…** (single) / **Pick folder…** (batch) - choose the source. Batch lists every .segy / .sgy / .segd / .seg / .seg2 / .dat / .bat / .su file in the folder.
- **Format chips** - the output format. Single offers SEG-Y Rev 0/1/2, SU, SEG-2, SEG-D Rev 1/3 and CSV; batch adds **Tape Image**.
- **Output name** card - build the result file name from a checklist (below); a live preview and the file extension are shown.
- **Convert & Save…** (single) / **Convert files** (batch) - run it; a native Save dialog (single) or destination folder (batch) is asked for.
- **Cancel** - stop a running batch part-way; files already written are kept.
- **Clear** - forget the open file / picked folder and empty the panels.
- **File summary** - format, trace count, samples/trace, sample interval, record length, data format, revision, byte order and CRS of the loaded file.
- **Header QC** - automatic sanity flags on the file’s headers (e.g. an odd sample interval or inconsistent counts).

### Output formats

- **SEG-Y Rev 0** - the original layout; broadest compatibility, no extended headers.
- **SEG-Y Rev 1** - adds the extended textual headers and standard trace-header positions. A safe default.
- **SEG-Y Rev 2** - the latest revision; larger trace counts and microsecond timing.
- **SU** - Seismic Unix; SEG-Y trace headers with no reel/textual header. For SU/CWP workflows.
- **SEG-2** - engineering / shallow-seismic instruments.
- **SEG-D Rev 1 / Rev 3** - raw field-record format written by many acquisition systems.
- **CSV** - samples as plain numbers (one trace per column) for spreadsheets or scripts. Export only; not re-readable as seismic.
- **Tape Image** (batch only) - a single archive container. Converting a *folder* to Tape Image **combines every file in it into one archive**, rather than writing one output per input.

### Output-name checklist

- **Original name** - the input file’s base name → token `{name}`.
- **Custom text** - your own text (e.g. a line name) → `{custom}`.
- **Format** - the chosen format id (segy1, su, …) → `{fmt}`.
- **Date YYYYMMDD** - the date from the picker → `{date}`.
- **Time HHMM** - a time stamp → `{time}`.
- **Sequence #** (batch only) - a per-file counter so names stay unique → `{seq3}` (001, 002…) or `{n}` (1-based index).
- **Separator** - underscore, hyphen or none; joins the ticked parts.
- **Advanced - name template** - edit the raw `{token}` string directly; it stays in sync with the checklist both ways.

### Examples

- Tick **Original name** + **Date**, underscore → `shot001_20260629.sgy`.
- Tick **Custom text** “line12” + **Format** → `line12_segy1.sgy`.
- Batch with **Original name** + **Sequence #** → `rec_001.su`, `rec_002.su`, … The live **Examples** box shows the first few real names before you run.

### How to use it

1. Choose **single** or **folder (batch)** mode.
2. Pick the file (or folder) and choose an output **format**.
3. Tick the **output-name** parts you want; check the live preview.
4. Click **Convert & Save…** / **Convert files** and choose where the result goes. Watch the progress; **Cancel** stops a batch.

### Tips

- Check **Header QC** before converting - a flagged sample interval or trace count usually means the input format guess is off.
- CSV is for inspection in a spreadsheet, not for round-tripping; convert to SEG-Y/SU if you need to re-open the result as seismic.

### Good to know

- Malformed or partly-corrupt inputs are skipped and reported, not crashed on - a batch finishes the files it can and lists what it could not.

---

## Trace Inspector

Inspect one trace at a time as a time-domain waveform or its amplitude spectrum, with the full SEG-Y trace header alongside.

### Controls

- **‹ Prev** / **Next ›** and the **slider** - step through traces; the label shows the current index and total.
- **Waveform** / **Spectrum** - the time-domain wiggle, or its amplitude spectrum (FFT).
- **-** / **Fit** / **+** - zoom the time axis; or wheel-zoom, drag-pan, double-click to fit on the canvas.
- **Magnifier** (the magnifying-glass icon button, no text label) - click it, then drag a box over the trace to open that time/amplitude region enlarged in a zoom viewer (`Esc` exits).
- **Axis range** - type an exact time and/or amplitude window instead of auto-fit; blank or invalid reverts that axis to auto.
- **Add to Workbench** - push the current trace to the Trace Workbench to compare later.
- **Hover read-out** - under the canvas, the time and amplitude under the cursor.
- **Trace header** table - the live SEG-Y header for the current trace, grouped; it updates on every move.

### How to use it

1. Open a seismic file.
2. Move through traces with **Prev**/**Next** or the slider.
3. Toggle **Waveform** / **Spectrum**; zoom or set an exact axis range.
4. Read the live **Trace header**; optionally **Add to Workbench**.

### Good to know

- The amplitude axis is labelled “Amplitude (sample value)” - SEG-Y/SEG-D samples are raw counts with no physical unit.

---

## File Viewer

Render the whole record as a section image - variable-density, wiggle or variable-area - and run two QC tools over it: a trace Health scan and First-break picking.

### Controls

- **Open file…** / **Clear** - open or forget the seismic file (shared with every tab).
- **[** / **]** - step to the previous / next file in the same folder.
- **Display mode** - Variable Density (colour by amplitude), Wiggle (traditional wiggle traces), Variable Area (filled wiggle), or VD + Wiggle (both overlaid).
- **Colormap** - Seismic (blue-white-red), Gray, Amber or Viridis.
- **Gain** slider - scale amplitude for display only (it does not change the data).
- **AGC** - automatic gain control: equalises strong and weak traces so faint far-offset arrivals show. Display only.
- **-** / **Fit** / **+** - zoom the data; wheel to zoom, drag to pan, double-click to fit. Zoom re-fetches real samples (not a pixel stretch).
- **Magnifier** (the magnifying-glass icon button, no text label) - click it, then drag a box to open that trace/time region enlarged in a zoom viewer (`Esc` exits).
- **Axis range** - type exact trace and/or time extents.
- **+ Workbench** - toggle on, then click a trace on the canvas to send it to the Trace Workbench.
- **Trace paging** (huge / tape-image files) - a file too large to show at once is paged in fixed blocks; **◀**/**▶** step blocks and **Block** sets the block size.
- **Hover read-out** - trace · time · amplitude under the cursor, with the trace’s FFID / CDP / node and its station (receiver, and source when resolvable - matched to the loaded SPS survey, or the header source point) fetched as you hover.

### Health scan - flag bad traces (QC proposes, you confirm)

- **What it does** - scans the record for problem traces and *proposes* them for review. It never edits or kills traces on its own - you confirm what to act on.
- **Run scan** - analyse the open record and list the findings.
- **Sensitivity Low / Med / High** (+ Advanced numeric) - how readily a trace is flagged; the flagged count updates live as you move it. Start at Med; lower it if good traces are flagged, raise it if bad ones slip through.
- **Findings table** - sortable / filterable: trace · FFID:channel · offset · problem · metric vs local baseline · confidence · status. Click a row to locate that trace on the section.
- **Coverage banner** - an honest statement of how much was scanned (e.g. “scanned 20k of 84k traces; polarity on contiguous blocks”). It never implies 100% coverage on very large files.
- **Confirm / Dismiss** - review each finding; confirmed traces build a kill-list you can **Kill/zero**, **Mute** or **Reverse-polarity**.
- **Export** - the kill-list (actionable) and a QC-report CSV (per-detector score, confidence, reason and the local baseline).

### Health flags - what each one means

- **Dead** - a flat-line or near-silent trace, judged against its live neighbours on an early time-gate (so a normally-quiet far-offset trace is not called dead).
- **Noisy** - abnormally high energy versus neighbours (a robust outlier), or a bad spectrum (narrow band, out-of-band energy, 50/60 Hz hum).
- **Reversed** - flipped polarity: flagged only on strong, coherent, consistent negative correlation with a neighbour pilot in the first-break window - a genuine AVO reversal is deliberately not flagged.
- **Hot / weak** - amplitude far above or below the local median; the catch-all so a real bad trace does not slip past the narrower families.
- **Clipped / spiky** - runs of samples pinned at the rail, or isolated spikes well above the local spread.
- **Confidence vs severity** - *severity* is how bad the trace looks; *confidence* is how sure the test is (how many neighbours contributed, whether it could even run). A high-severity, low-confidence flag is worth a manual look.

### First breaks - pick the first arrival (assisted)

- **What a first break is** - the onset of the first seismic energy on each trace (the direct / refracted arrival), used for refraction statics and QC.
- **How it works** - you drop a few **seed** picks, SeisConv draws a moveout **guide** curve (with a shaded ±search-window band) through them, then **Assisted fill** picks every other trace inside that window. The auto-pick is a *first guess to edit*, not a final answer.
- **First breaks** toggle - turns the mode on; a sub-bar appears and the same section canvas gains the pick overlay.
- **Click** a trace at the onset to set a seed; **drag** to adjust (the guide re-fills live); **right-click** to delete a pick.
- **Assisted fill** - run the engine across the gather (needs 2+ seeds). **Accept all** confirms every pick; **Reject flagged** drops the low-confidence / off-trend ones; **Clear picks** removes them all.
- **Phase** (peak / trough / zero-cross) - which part of the wavelet a pick snaps onto. **±ms** sets the search half-window around the guide (smaller = stricter, less far-trace scatter); **Detector** selects the onset detector (STA/LTA).
- **Read-out** - trace, FFID, channel, offset, pick (ms), source (seed / auto / edited / flagged) and confidence. **Export CSV…** saves the picks (absIdx, FFID, channel, offset, tMs, source, confidence). Writing picks into SEG-Y headers is not part of this step - CSV only.

### How to use it

1. Open a seismic file.
2. Pick a **display mode** and **colormap**; tune **Gain** / **AGC** and zoom in on detail.
3. For QC, run a **Health scan**, review the findings table, then confirm what to act on.
4. For statics, turn on **First breaks**, drop 2+ seeds, **Assisted fill**, edit, then **Export CSV**.

### Tips

- Empty Health scan? Run a scan first and nudge the sensitivity if it over- or under-flags.
- Empty First breaks? Drop at least two seed picks, then **Assisted fill** - the guide needs seeds to anchor the moveout.

### Good to know

- Both QC tools work on real adjacent traces, not the display-decimated view - flags and picks are computed on the true samples even when the section is zoomed out.
- Gain and AGC change only how the section looks, never the underlying samples or what you export.

---

## SPS

Load, plot, QC and reproject survey geometry - sources, receivers and their relations - on an offline survey grid or a real-world basemap.

### Controls

- **Load SPS files (S/R/X)…** - load source (.s), receiver (.r) and relation (.x) files. Reads SPS, SEG-P1, IOGP P1/11, P6/11 and coordinate-CSV. Loads accumulate, so you can add files in stages.
- **Clear SPS** - forget the loaded survey.
- **Stats bar** - counts of sources, receivers and relations, the line count and survey extent.
- **Sources** / **Receivers** - overlay toggles for the two point sets.
- **X-ref spider** - draw the shot→receiver fans from the relation (X) file; click a shot to emphasise its fan.
- **Fold / coverage** + **Bin m** - a CMP fold/coverage heat-map; **Bin m** sets the bin size.
- **Bin grid** - overlay the P6/11 acquisition bin grid if the survey has one.
- **Survey grid** / **Real map** - an offline projected grid, or a Leaflet basemap with a scale bar. The grid has a **rotation** slider (reset to **N** = north-up).
- **Basemap layers** - the layer control (top-right of the map) offers four keyless basemaps. **Satellite** (Esri World Imagery) is the default and is sharp all the way to survey scale (native zoom 21), which is where 2-30 m station spacing is actually worked at. **Streets** (OpenStreetMap) is detailed to about zoom 19. **Light (regional)** and **Dark (regional)** are Esri grey canvases for regional context - their detail stops at about zoom 16, so they go soft when you zoom into a line. All four keep zooming past their native levels (upscaled) rather than going blank.
- **Headers…** - view and edit the survey’s H-record header block, in three tabs (**CRS / Datum**, **Admin**, **Raw records**), with a scope selector that applies your edits to all S / R / X files at once or to just one of them. **Apply** changes the in-memory survey; **Export corrected (ZIP)…** writes the edited files out - your original files on disk are never overwritten in place.
- **Fix the label only** / **Reproject the coordinates too** (inside **Headers… › CRS / Datum**) - which of the two very different things you mean when you change the CRS. **Fix the label only** rewrites the header text and leaves every easting, northing and elevation *exactly* as it is; use it when the numbers were always right and only the stated CRS was wrong. **Reproject the coordinates too** means the numbers themselves must change: **Apply** does not transform anything itself - it closes the dialog and sends you to **Reproject to** + **Export reprojected (ZIP)…** on the SPS tab, which recomputes every source, receiver and X-ref coordinate into the target CRS and writes a new ZIP. Your original files on disk are never overwritten, but the reprojected output cannot be undone back to the originals: a round trip is not bit-exact, and if the survey was not really in the CRS you reprojected *from*, the whole survey moves and nothing warns you. When in doubt, keep the originals and re-load them.
- **Re-create / Renumber…** - re-map the survey’s source & receiver line and point numbers, then save the rewritten S / R / X files. Every X-ref range is kept consistent with the new numbering, and vendor columns the data model does not carry are preserved from the original text.
- **Station read-out** - hover any station (grid or map) for a small tooltip with its type (S/R), line and point; click it to open the full inspector.
- **Station inspector** - click any point to see its line/point, coordinates, elevation and the lines through it.
- **Run QC** - check Src int, Rcv int, Tol and Max off; findings list below, each clickable to ring the station on the map.
- **Reproject to** - search the built-in EPSG registry (about 7,000 coordinate reference systems, fully offline) by code, by name, or loosely ("utm 36n"), then **Export reprojected (ZIP)…**. A CRS SeisConv cannot compute is still listed, but greyed out with the reason.
- **Export** - the map/report exports: KML, GeoJSON, CSV and the QC report. Positioning formats are not here; they all come out of **Export as**.
- **Export as** - the single route for any-to-any positioning export: whatever was loaded can be written back out as **SPS 2.1** (.s / .r / .x), **SEG-P1** (the deprecated fixed-column post-plot file, kept because some legacy processing packages still demand it - grid easting/northing in decimetres), **IOGP P1/11** or **Coordinate CSV**. P6/11 is absent on purpose - it defines a bin grid, not a point survey, so it cannot be produced from source/receiver geometry.
- **Shapefile** - export sources and receivers as ESRI Shapefile point layers (.shp/.shx/.dbf/.prj), zipped. Leave the CRS box empty to write the survey’s own coordinates untouched with a .prj describing them; pick a CRS to reproject instead.
- **GeoTIFF…** - a three-step wizard: drag the area on the map (or take the whole survey plus a margin), set the ground resolution in units per pixel, then choose the layers - CMP fold, an elevation surface, and/or the survey layout as a picture. Every layer shares one grid, so they stack in GIS.

### Reading the plot

- Sources and receivers are drawn as separate point layers; the X-ref spider links them per the relation file.
- The fold/coverage map bins midpoints - warmer bins have more fold. Use it to spot gaps and the edges of full fold.
- On **Real map** the points sit on a basemap with a scale bar; on **Survey grid** they sit in projected metres and the rotation slider turns the whole survey for a north-up or line-parallel view.

### QC checks

- **Src int / Rcv int** - the expected source / receiver station spacing; flags points off by more than the tolerance.
- **Tol** - the match tolerance in metres.
- **Max off** - the largest source→receiver offset allowed; longer offsets are flagged.
- Each finding is clickable - it centres and rings the offending station.

### Creating / re-creating an SPS

- Build a brand-new survey from scratch on the **SPS Creation** tab (draw lines → generate S/R/X).
- Re-create or correct an existing one by loading it here, editing station fields in **Headers…**, renumbering with **Re-create / Renumber…**, reprojecting, and writing it back out with **Export as**.

### How to use it

1. Click **Load SPS files (S/R/X)…** and pick your survey files.
2. Toggle overlays; switch between **Survey grid** and **Real map**; rotate the grid as needed.
3. Click a point to inspect it; run **Run QC** and click findings to locate them.
4. Reproject to another EPSG and **export** KML / GeoJSON / CSV / P1-11 / QC report.

### Tips

- Loads accumulate - add the S, R and X files one at a time and the plot grows.
- No internet? Stay on **Survey grid**; only **Real map** needs to fetch basemap tiles. The EPSG registry is built in, so CRS search and reprojection work fully offline.
- Loaded a SEG-P1 or a coordinate CSV and need SPS 2.1? Use **Export as** - every format feeds the same data model, so any of the four can be written from any of them.
- The elevation GeoTIFF never extrapolates: a pixel with no station inside the search radius is written as nodata rather than an invented height.

### Good to know

- The **SPS 2.1** export carries a matching ESRI **.prj** when the survey’s CRS can be described, because that export is already a ZIP. The other three positioning formats are single files and stay single files - a .prj beside them would turn “save a .csv” into “save a .zip” - so they state their CRS inside the file instead: coordinate CSV a `# CRS:` tag, IOGP P1/11 an `H,CRS` record, SEG-P1 an `H GRID: … DATUM …` line. A survey whose CRS cannot be described honestly gets NO .prj rather than a guessed one.
- Coordinate reference systems come from the **EPSG Geodetic Parameter Dataset**, © IOGP (International Association of Oil & Gas Producers), redistributed under its terms of use with attribution. IOGP is not responsible for any modification made to the data, and this use does not imply IOGP endorsement. The authoritative source is the EPSG Registry at epsg.org.
- SeisConv computes Transverse Mercator, UTM, geographic, Lambert Conformal Conic, Mercator, Cassini-Soldner, Albers, Lambert Azimuthal Equal Area and Polar/Oblique Stereographic - about 97% of the projected CRSs in the dataset. The rest stay listed but are refused with a reason, as are CRSs whose datum tie needs an NTv2/NADCON grid file (OSGB36, NAD27 and similar). Native export still works for those, and the .prj names the CRS correctly so your GIS can do the shift properly.

---

## SPS Creation

Build the survey plan - draw acquisition lines on a basemap or import an existing preplot - edit it point by point, check it, then generate a fresh SPS survey (or export the plan straight out).

### Controls

- **2D** / **3D** - the acquisition mode, and it changes what your picked lines *mean*. In **2D** each picked line is walked once: sources and receivers are laid along that same line. In **3D** the picked lines are **receiver lines** and source lines are generated perpendicular to them, so the **Generate…** wizard gains three extra fields - **Source-line spacing (m)** (how far apart the generated source lines sit across the receiver lines), **Azimuth (° CW from N)** (the receiver-line bearing; leave it empty to take the bearing from the longest picked line) and, for the **Moving patch** relation, **Patch lines** (how many receiver lines each shot records into). The relation choices are relabelled with the mode: **Full line** / **Split-spread** in 2D become **Full template** / **Moving patch** in 3D.
- **CRS** - the coordinate reference system, auto-suggested from your first pick (ITM inside Israel, otherwise the UTM zone); click to review or override it in the wizard.
- **Import plan…** - load an existing survey plan from CSV / TSV / GeoJSON, mapping the file’s columns onto line, station, coordinates and elevation. An imported preplot is already positioned and numbered, so it can go straight out again without a layout wizard.
- **SPS 2.1** / **CSV** / **GeoJSON** / **KML** (Export plan) - write the plan out as it stands. **SPS 2.1** produces the S / R / X files directly - no layout wizard - and is available only when every line is a preplot (a drawn line still needs a station interval, so use **Generate…** for those). **CSV** carries line, station, lat/long, elevation, E/N and per-segment metrics; **GeoJSON** writes a LineString per line plus a Point per station; **KML** writes a Folder per line.
- **Map** - click to drop line vertices; the cursor read-out shows lat/long and projected E/N.
- **+ Next line** - finish the current line (needs ≥2 vertices) and start a new one.
- **Undo** (`Ctrl+Z` on this tab) - step back through the plan’s own history; **Clear** removes every line.
- **Generate…** - open the wizard (intervals, line/point numbering, relation, source/receiver type, output name), then create & save the S / R / X files.

### Editing the plan on the map

- **View** / **Drag points** / **Add on click** - the three edit modes. **View** pans the map and a click opens a station’s details; **Drag points** moves a station by dragging it; **Add on click** appends a point to the line chosen in **Target line**.
- **Target line** - which line a newly added point joins, so you can go back and extend an earlier line instead of always the last one.
- **Layers** - **Basemap**, **Connection lines**, **Direction arrows**, **Distance labels** and **Stations & numbers**, each with its own on/off tick and an opacity slider - turn the map down to read the stations, or the stations down to read the map.
- **Basemap layers** - the layer control (top-right of the map) offers four keyless basemaps. **Satellite** (Esri World Imagery) is the default and is sharp all the way to survey scale (native zoom 21), which is where 2-30 m station spacing is actually worked at. **Streets** (OpenStreetMap) is detailed to about zoom 19. **Light (regional)** and **Dark (regional)** are Esri grey canvases for regional context - their detail stops at about zoom 16, so they go soft when you zoom into a line. All four keep zooming past their native levels (upscaled) rather than going blank.
- **Zoom speed** - how far one wheel notch zooms the map; slow it down for fine positioning work.

### The Points / Checks / Lines panes

- **Points** - every point of the plan in an editable table, filterable to one line. **Renumber 1..N** renumbers the shown line’s stations (SPS numbering is per line), **Sort by station** orders every line’s points by station number, and **Fit map to plan** zooms the map to the whole plan.
- **Checks** - the consistency checks run over the plan; click a finding to locate it.
- **Lines** - one row per acquisition line, with its colour, station count and length.

### Plan checks that block Generate

- Only findings of severity **error** block **Generate…** and the **SPS 2.1** plan export - warnings and info are shown but never stop you. When one is present the Checks pane opens and the status line says how many to fix.
- **Duplicate line name** - two lines share a name, so they would merge into one line in the generated survey.
- **Line with fewer than 2 points** - a line needs at least two stations to be a line.
- **Zero-length segment** - two consecutive stations at the same position.
- **Duplicate station on a line** - the same station number twice on one line; SPS numbering is per line and must be unique within it.
- **Preplot line with missing station numbers** - a preplot is used as-is, so every one of its points must carry a station number.

### How to use it

1. Click the map to place the vertices of the first acquisition line, or **Import plan…** to bring in an existing preplot.
2. Use **+ Next line** for additional lines; **Undo** (Ctrl+Z) / **Clear** to correct, and the **Drag points** / **Add on click** modes plus the **Points** table to fix individual stations.
3. Review the auto-suggested **CRS** (override if needed) and read the **Checks** pane - clear every error.
4. Click **Generate…**, confirm the parameters, then create & save - the new survey opens on the **SPS** tab. An already-numbered preplot can instead go straight out via the **SPS 2.1** plan export.

### Tips

- Errors block, warnings do not - an over-long segment or an odd spacing is flagged for you to judge, not refused.

### Good to know

- 3D design generates a regular orthogonal grid: your picked lines are taken as the receiver lines and the source lines are laid perpendicular to them at the spacing you give. It is not a template designer - the patch is either the full template or the **Patch lines** &times; **Channels** moving patch nearest each shot, and the generated point count is capped, so very large grids are refused with a message rather than half-written. Check the result on the **SPS** tab before you take it to the field.
- The generated survey carries a matching ESRI **.prj** when its CRS can be described, so it opens georeferenced in a GIS.

---

## Velocity

Compute an NMO semblance panel from the open gather and pick a stacking-velocity function.

### Controls

- **Vmin** / **Vmax** / **Step** - the velocity scan range and increment.
- **Compute semblance** - build the semblance panel from the open record.
- **Panel** - click to add velocity picks along the time axis; the picked function is drawn through them.
- **-** / **Fit** / **+** and **Axis range** - zoom the panel.
- **Export picks CSV…** - save the picked time/velocity pairs.

### How to use it

1. Open a seismic file (a CMP/CDP gather gives the cleanest semblance).
2. Set **Vmin** / **Vmax** / **Step** and click **Compute semblance**.
3. Click the bright semblance peaks to add picks down the panel.
4. Click **Export picks CSV…** to save the velocity function.

### Good to know

- Semblance is strongest on a sorted gather with moveout; on a raw shot the peaks will be less focused.

---

## Spectrum

Frequency-domain QC of the open record: amplitude spectrum, spectrogram and frequency-wavenumber (F-K).

### Controls

- **Average spectrum** / **Spectrogram** / **F-K** - choose the view.
- Average: **Linear** / **dB** scale, a **From**/**To** trace window to average over, and **Recompute**.
- Spectrogram: **Prev**/**Next** or **Trace #** to choose the trace, and a **Window** length (longer = finer frequency, coarser time).
- F-K: **Recompute** builds the frequency-wavenumber panel.
- **-** / **Fit** / **+** and axis controls - zoom each view.

### Reading the views

- **Amplitude spectrum** - energy vs frequency, averaged over the trace window. Shows the signal band and where it rolls off; spikes at 50/60 Hz are mains hum.
- **Spectrogram** - how one trace’s frequency content changes with time; useful for spotting dispersive noise or ringing.
- **F-K** - energy in frequency vs wavenumber; coherent dipping events (ground roll, multiples) map to distinct lines, aiding dip / velocity QC.

### How to use it

1. Open a seismic file.
2. Choose **Average spectrum**, **Spectrogram** or **F-K**.
3. Set that view’s parameters and click **Recompute**.
4. Zoom in to inspect the band, the hum lines or the dipping energy.

### Good to know

- The amplitude axis carries no physical unit; use **dB** to compare relative levels across the band.

---

## Trace Workbench

Collect individual traces from any file(s) and compare them side-by-side or overlaid, with cross-correlation, difference and stats between any two.

### Controls

- **Pick file…**, **Trace #**, **Add open trace** - gather traces into the bench from any file.
- Click traces in from **Trace Inspector** (Add to Workbench) or the **File Viewer** (+ Workbench, then click a trace).
- **Collected list** - each trace with a colour swatch, label and a remove button.
- **Side-by-side** / **Overlay** - layout for the collected traces.
- **-** / **Fit** / **+** and **Axis range** - zoom all traces in lock-step.
- **Invert** - flip trace polarity in the plot. Display only: the collected samples, the analysis and the export are unaffected.
- **A** / **B** selectors (in the **Analysis** card) - choose two traces for cross-correlation, difference and stats (lag, peak correlation, RMS difference). The pair of drop-downs appears once at least two traces are collected.
- **Clear all** - empty the collected list.
- **Export** - a format drop-down (SEG-Y Rev 0 / 1 / 2, Seismic Unix, SEG-2 / .dat, SEG-D Rev 1 / 3, CSV / ASCII) next to **Export…**, which asks where to save. If the collected traces have different sample intervals a note says so - the output takes the first trace’s interval.

### How to use it

1. Add traces via **Pick file…** + **Add**, or push from Trace Inspector / File Viewer.
2. Compare with **Side-by-side** or **Overlay**; zoom in lock-step.
3. Select **A** and **B** in the Analysis card to read cross-correlation and difference; **Invert** if one trace was recorded with opposite polarity.
4. Choose an export **format** and click **Export…** to save the collected traces.

### Tips

- Traces from different files keep their own labels and colours, so you can A/B a trace against the same channel from another shot.

---

## Observer Log

Build and maintain a per-shot field log - wizard-configured columns, an editable grid, time-stamping and one-click export.

### Controls

- **Wizard** - project header, columns (field groups + custom columns), source type (Explosive / Vibroseis / Nodal), and how rows are seeded (from the open data or blank).
- **Build log** - create the grid from the wizard settings.
- **+ Add row** - append a shot row; rows can be inserted, deleted and reordered.
- **Renumber below…** - pick an anchor row, confirm/edit its Shot point + interval (+ optional File# start), and recompute SP / File# for the anchor and every row after it. Fixes a stuck / re-shot / skipped shot and recalculates the interval; audited.
- **Columns…** - rename, reorder, retype, set a role and unit, add or remove columns; existing values for surviving columns are kept.
- **Import sources from SPS** - seed shot rows from the loaded SPS survey.
- **Reconfigure…** - re-run the wizard over the current log.
- **Time-source** - stamp times from the PC clock or an NTP server (with the offset shown).
- **Trigger Watch** - master ON/OFF + status dot + sound toggle + **Configure…**: pick a **trigger system** and add a highlighted row the moment a shot triggers (see below).
- **Save log** / **Reload…** and **Templates** - persist, restore and reuse configurations.
- **Export** - Excel, CSV, LibreOffice or a formatted Report.

### Column roles

- A column’s **role** tells SeisConv what it holds (e.g. shot number, FFID, time, coordinate, comment) so it can fill, validate and format it - set roles in **Columns…**.
- Roles drive features like **Import sources from SPS** (which fields it fills) and time-source stamping (which column gets “Now”).

### Trigger Watch - a live row on every shot

- **Trigger system** (in **Configure…**) - pick your recording system and its sources + File# sync are configured for you. **Geometrics Geode (SCS)** is system #1: it triggers on the SCS **TempCom** event (passive, file-independent - it fires even for shots that are never saved) and keeps the log’s File# in sync with SCS’s real recorder file number, read from the `.dat` in the SC_Files save folder. The generic sources (folder watch / UDP / serial / SCS log) stay available under **Advanced / generic sources** for non-Geode setups. New trigger systems can be added as registry entries without rewiring the UI.
- **Sources** (any combination, under **Advanced** in **Configure…**): **watch the acquisition folder** - a row when the recorder (e.g. SCS) writes the shot file (works today, zero hardware; latency equals the file-write moment); **SCS survey log** - tail the Geometrics `SC_Survey.####.log`: a row per shot at the **real trigger time**, straight from the recorder - it fires **even for shots that are never saved** (independent of the .dat file / Auto-Save). FFID = the log’s File #, time from the log timestamp; `READ` (file re-read) lines are ignored; **UDP listener** - one-line text or JSON `{"trig":id,"ts":…}` datagrams, 127.0.0.1 only unless LAN is explicitly enabled; **serial trigger box** - the true trigger-time feed: the serial trigger box’s `[SHOT] #id Lline:SPsp ts=…` USB-serial line at contact closure (GPS time; plain TRIG-style lines from other hardware are accepted too). Pick the COM port + baud in Configure…; the end-to-end hardware check happens in the field with the box connected.
- **Two-stage rows** - a trigger adds a highlighted **pending** row instantly: counters advance, the time column takes the event/GPS timestamp, and the next source station is pre-filled from the loaded SPS order. When the shot file lands in the watched folder the row is **enriched** (FFID, file name, traces, sample interval, record length).
- **Auto-number (shot controller · File# sync)** - turn it on in **Configure…** to advance the Shot point and keep the File# in sync on every trigger, while every cell stays editable. **SP is a fixed step**: new SP = previous SP + (direction × step × interval); the first auto-row seeds the **SP start** (no SPS geometry needed - change step / interval any time; SP auto-advance is unchanged). On the **Geometrics Geode (SCS)** system the **File# mode** keeps the log’s File# synced to SCS’s real recorder file number, with two per-survey choices: **Seed + auto-correct** - enter SCS’s current/next File# once; each Geode trigger shows it INSTANTLY (counter from the seed) and auto-corrects from the real `.dat` File# when it lands in SC_Files (a mismatch is flagged); or **Read from file** - File# is blank on the trigger, then filled with SCS’s exact number read from the `.dat`. (A generic **Counter only** mode, +1 each trigger with no recorder sync, is also available.) Triggering ALWAYS fires on the trigger EVENT above - the `.dat` read is enrichment only, never a trigger; the number syncs from the saved file.
- **Stuck / re-shot shots** - no auto-detect and no Hold button: every SP / File# cell is inline-editable, and **Renumber below…** recomputes SP + File# for a chosen row and all rows after it (using a possibly-changed interval). That is how re-shoots, skips and drift are fixed.
- A pending row stays highlighted until **you edit it** - the log is yours; Trigger Watch only assists. Every auto-write (advance, enrichment, reconcile correction, renumber) lands in the audit trail.
- **Catch-up** - when the watch starts, shot files newer than the last logged trigger are listed and you choose every time: **Add all**, **Add selected**, or **Skip**.
- Each trigger flashes the status dot, shows a toast and (optionally) beeps - toggle the beep with **Sound**.
- The folder is only ever watched and read - SeisConv never writes into the acquisition folder.

### How to use it

1. Run the **wizard**: header → columns → source type → rows.
2. Click **Build log** to create the grid.
3. Edit cells; add, insert, delete or reorder rows; stamp times from PC / NTP.
4. Save, or **export** to Excel / CSV / Report.

### Tips

- Save a configured-but-empty log as a **Template** to start every crew day from the same layout.

---

## Geometry QC

Cross-check the open seismic file’s trace-header geometry against the loaded SPS, diff an as-laid survey against a pre-plot reference, and stamp SPS coordinates into a SEG-Y.

### Controls

- **Open file…** / **Open SPS…** / **Clear** - the seismic file and SPS survey to check (shared with the other tabs).
- **Tolerance** (check) - the station-match tolerance in metres (default 2).
- **Geometry check results** - how many trace headers match an SPS station within tolerance, and the mismatches. Clickable findings ring the station on the SPS map.
- **Load geometry → save SEG-Y** - stamp the SPS survey’s coordinates into the open SEG-Y’s trace headers and save a new geometry-loaded SEG-Y.
- **Tolerance** (load) - the match tolerance used when stamping.
- **Scalar** - the SEG-Y coordinate scalar written to the headers (controls stored precision).
- **Coordinates** / **Elevations** / **Offset** / **CDP X/Y** - which fields to stamp: source & group X/Y, source & receiver elevation, source→receiver offset, and CDP / ensemble-midpoint X/Y.
- **As-laid vs pre-plot delta** - pick a pre-plot (reference) SPS triplet and diff the loaded as-laid survey against it; reports the per-station skid (the as-laid↔pre-plot distance).

### The three jobs

- **Check** - does the SEG-Y already carry geometry that agrees with the SPS? Lists matched and unmatched traces within tolerance.
- **Load** - write SPS coordinates / elevations / offset / CDP into the SEG-Y trace headers, producing a geometry-loaded copy (the original is untouched).
- **Delta** - compare where stations were actually laid against where they were planned (as-laid vs pre-plot), per station.

### How to use it

1. Open the seismic file and the SPS survey.
2. Set the **Tolerance** and read the geometry-check results; click a finding to locate it.
3. To stamp geometry: choose the **Scalar** and the fields, then **Load geometry & save…**.
4. To audit positioning: **Compare to reference SPS…** for the as-laid vs pre-plot delta.

### Good to know

- Loading geometry writes a new SEG-Y - your input file is never modified in place.
- Stations that do not match any SPS point within tolerance are reported as unmatched and left unstamped, not guessed.

---

## Sweeps

Design the vibroseis pilot sweep - the controlled chirp a vibrator shakes into the ground - inspect it (signal, frequency-vs-time, spectrum, Klauder wavelet), export it (pilot trace, SCIO .SV table, printable sweep sheet) and QC a recorded sweep against the design.

### Controls

- **Type** - the frequency law. **Linear**: constant Hz/s. **dB/Hz** / **dB/Octave**: nonlinear dwell - the sweep spends more (or less) time per Hz so the energy spectrum tilts by the given slope. **T-Power**: the sweep rate grows as tⁿ, dwelling at the start frequency. Pseudo-random sweeps are deliberately not offered.
- **Start / End Hz** - the band (0.1-999.9 Hz); End below Start gives a downsweep.
- **Length ms** - sweep duration (1-65535 ms).
- **Taper in / out** - ramp the envelope at the ends (ms). Tapers keep the vibrator from slamming to full force instantly and control spectral edge ripple (Gibbs).
- **Taper** shape - **Cosine** (half-cosine ramp) or **Blackman** (softer shoulders, slightly wider skirts).
- **Phase °** - the initial phase φ₀. 180° inverts the pilot’s polarity (see the polarity note below).
- **Pilot dt** - the exported pilot trace’s sample interval (0.25 / 0.5 / 1 / 2 ms; default 0.5). This is only the pilot file’s rate - the vibrator’s own DSP rate is fixed by its electronics, and the SCIO .SV table is always written at 2048 samples/s.
- **Amplitude** - peak envelope as a fraction of full scale (scales the .SV envelope column: 1.0 ≡ 10 V).
- **Segmented sweep** - chain up to 16 segments, each with its own law / band / length; the generator keeps phase continuous across every join.
- **Survey presets** - save/load the whole design + QC thresholds per survey (each crew’s specs differ); export/import as .json to share between machines.
- **Build sweep** - generate and refresh the four plots.
- **Export** - pilot trace (SEG-Y Rev 2 / SU / CSV), SCIO **.SV** sweep table, and a printable HTML **sweep sheet** with the plots embedded.
- **Load measured sweep…** (QC panel) - open a recorded pilot / ground-force / similarity trace and compare it against the design: phase error vs time, envelope + spectrum overlays, THD vs time, and the designed×measured correlation wavelet.

### The four plots

- **Pilot signal** - the sweep itself, amplitude vs time, tapers visible at the ends.
- **Frequency vs time** - the sweep law; segments show as slope changes with no jumps.
- **Amplitude spectrum** - in-band level and edge roll-off; nonlinear sweeps show their designed tilt.
- **Klauder wavelet** - the sweep’s autocorrelation: the effective source wavelet after correlation. Narrow main lobe = better time resolution; the peak/side-lobe ratio (dB) is the readout to watch.

### Sweep QC verdicts

- **Phase error vs time** - instantaneous phase of the measured sweep minus the design; industry practice holds the average within ~10° and peaks within ~20-25°.
- **THD vs time** - harmonic distortion of the measured sweep (windowed-FFT harmonics over the fundamental); high THD at low frequency usually means the mass or flow limit was hit.
- **Envelope / spectrum overlays** - drive drop-outs, decoupling and resonances show here.
- **Correlation wavelet** - designed × measured; a clean sweep reproduces the Klauder wavelet with the peak at lag 0.
- The pass/fail thresholds (avg phase ≤ 10°, peak ≤ 20°, THD ≤ 35% by default) are editable and stored in the survey preset - set them to your contract’s QC spec.

### Polarity - the accelerometer trap

- Vibrator electronics that follow the SEG polarity standard have accelerometers wired **positive-UP**, while the SEG field-recording convention expects the first breaks of a compressive source **negative** (upward ground motion at the start of a downward push reads positive on the accel). On Pelton-style systems the practical rule is: if the recorded similarity/ground-force polarity comes out inverted against the pilot, run the pilot at **Phase = 180°** rather than rewiring - the correlation then restores standard polarity.
- Check polarity once per crew/instrument combination with a similarity test before production - do not assume.

### How to use it

1. Set the sweep parameters (or **Load** a survey preset), then **Build sweep**.
2. Read the plots: the signal and its envelope, the frequency-vs-time law, the amplitude spectrum, and the Klauder wavelet (what a spike looks like after correlation with this sweep) with its side-lobe readout.
3. Export what the job needs: the pilot trace for the recorder/processing, the .SV table for the sweep generator, the sweep sheet for the observer’s book.
4. To QC a recorded sweep: **Load measured sweep…**, pick the trace, and judge the phase-error / THD / envelope panels against the thresholds (editable; saved with the preset).

### Tips

- A longer sweep or wider band both sharpen the Klauder wavelet; tapers trade a little in-band energy for much cleaner spectral edges.
- Long sweeps at 0.25 ms can exceed 65535 samples - SEG-Y/SU cannot carry that in one trace; the exporter will say so and suggest a coarser pilot dt or CSV.

### Good to know

- The advisories shown after a build (force setpoint 50-80% of hold-down, low-frequency displacement limit) are guidance only - the vibrator’s own limits always govern what the machine physically does.
- Sweep QC verdicts here are advisory: they flag numbers against your thresholds; accepting or re-shooting a VP stays the observer’s call.

---

## WiFiSync

Keep a folder identical on two machines over WiFi, with no router, cloud or account. One machine can even host a WiFi hotspot so the pair connects anywhere in the field. It speaks the same wire protocol as the standalone WiFiSync app, so it interoperates with it directly.

### Controls

- **Folder · Choose…** - the folder that is kept mirror-identical with the peer. Everything under it (recursively) is synced.
- **Role** - **Two-way** (default): both machines push and pull changes. **Master**: this machine owns the data and only serves it (never pulls). **Slave**: mirror the master exactly - pull everything and delete local extras. When a peer advertises Master or Slave, the app auto-adopts the complement and locks the radios.
- **Adapter** - which network adapter to discover/broadcast on; “Auto” broadcasts on all. On a hotspot host this is usually the 192.168.137.x adapter.
- **Peer IP** - optional: connect straight to a known peer IP instead of auto-discovery.
- **Open firewall ports…** - open UDP 47823 + TCP 47824 in the Windows Firewall (Private profile only). Run it on BOTH machines when discovery or transfers are blocked.
- **Scan network** - actively sweep the selected adapter’s subnet for other WiFiSync instances, for when the passive discovery broadcasts do not get through.
- **Sync mode** - **On change** syncs the instant a file changes; **Every N s** polls on the interval.
- **Rate limit** - cap transfer speed (KB/s) so a sync does not saturate a field link.
- **Start / Stop WiFiSync** - bring the engine (file server + discovery) up or down.
- **Peers** - machines discovered on the network; **Add peer** connects one by IP; **Sync now** runs a single pass immediately.
- **WiFi hotspot** - **Name / Password** then **Start hotspot** to host a network from this PC (Windows Mobile Hotspot). **Status** reads the live state; **Host IP** shows the address to give the peer; **Open Windows Mobile Hotspot…** jumps to the Windows setting. **Reset WiFi** restarts the WiFi adapter and the hotspot service (UAC prompt) when the hotspot refuses to come up.
- **Fix Hyper-V conflict** - **changes this machine’s network configuration.** It appears only when starting the hotspot failed because a Hyper-V *virtual switch* is bound to the WiFi adapter and holding it. Clicking it asks for administrator rights (UAC) and then **deletes that Hyper-V virtual switch**. SeisConv cannot put it back: any virtual machine, WSL or Docker network that was using that switch loses its connection until you recreate the switch yourself in Hyper-V Manager. If this PC runs VMs you care about, fix the conflict there instead and leave this button alone.
- **Activity & transfers** - the live log plus the pulled/deleted history (newest first); **Clear history** empties the log.

### How to use it

1. Pick the shared **Folder** on both machines and leave **Role** on Two-way.
2. On one machine, optionally **Start hotspot** and connect the other machine’s WiFi to it; note the **Host IP**.
3. Press **Start WiFiSync** on both. A peer appears in the list within a few seconds (or use **Add peer** with the Host IP).
4. Edit files in the folder - they copy across automatically; use **Sync now** to force a pass.

### Good to know

- Deletions propagate via tombstones, and a guard prevents a peer whose drive went offline (empty manifest) from wiping your local files.
- The file server is unauthenticated by design - only run WiFiSync on a trusted field network (or the hotspot you host). Firewall rules it may add are scoped to the Private profile.
- Hotspot and adapter/firewall changes only ever happen on your explicit click; nothing here mutates the network on its own.

---
