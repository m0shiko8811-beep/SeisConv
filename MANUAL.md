# SeisConv - Manual

SeisConv reads common seismic exchange formats off the UI thread and converts
them between formats, with built-in QC and quick visual checks. Use the icon
rail on the left to move between tabs; press **1-5** to jump directly to a tab,
or **?** to open this manual in-app (**Esc** closes it).

> Key hints below use **Ctrl** on Windows/Linux and **Cmd** on macOS. The app
> shows the right glyph for your OS automatically.

---

## Converter tab

Two modes, chosen from the cards at the top of the Converter tab.

### Convert single file
1. **Open a seismic file** - `Ctrl+O` / the **Open seismic file…** button. The
   file is parsed off the UI thread, so large files stay responsive.
2. Review the **File summary** (traces, samples, sample interval, record length,
   data format, revision, byte order, CRS) and the **Header QC** flags.
3. Pick an **output format** chip (see the 9 formats below).
4. **Convert & Save…** - choose where the converted file is written via a native
   save dialog. A converting indicator appears while it runs.

### Convert a folder (batch)
1. **Pick folder…** - choose a source directory. SeisConv lists every file whose
   extension is one of `.segy .sgy .segd .seg .seg2 .dat .bat .su`
   (case-insensitive) and shows **“Found N seismic files in &lt;dir&gt;”**.
2. **Output format** - pick one of the same 9 writers used for single files.
3. **Pick destination…** - the folder the converted files are written into, each
   as `<basename>.<writer-ext>`.
4. **Convert N files** - runs the batch. A **live progress bar** shows
   `Converting X / N · <file> · <FORMAT>`, and a per-file result list marks each
   file **QUEUED → CONVERTING → DONE / ERROR**.
5. **Cancel** - visible while a batch runs; stops after the current file. Files
   already converted are kept.

### Clear
The **Clear** button (in either mode) resets the Converter: it forgets the open
file, clears the cached state in the worker, and empties all panels back to the
empty Converter.

---

## Trace Inspector

Step through individual traces with **‹ Prev** / **Next ›** or the slider, and
toggle between the **Waveform** and the **amplitude Spectrum** (FFT) of the
selected trace.

## File Viewer

Render the whole record as a section - **Variable Density**, **Wiggle**,
**Variable Area**, or **VD + Wiggle** - with a choice of colormap
(Seismic / Gray / Amber / Viridis), a **Gain** slider, and optional **AGC**.

## SPS 2.1

Load SPS **S / R / X** files to plot source/receiver geometry on a **Survey grid**
(offline; pan, zoom, hover for line/point/coordinates) or a **Real map** basemap
(Dark / Satellite / Streets). **Run QC** checks station intervals and offsets
against the values you enter; you can **reproject** the survey to another EPSG
CRS and export it.

## Velocity

Compute an **NMO semblance** panel over a velocity range (Vmin / Vmax / Step),
then click the panel to pick a stacking-velocity function and **Export picks CSV**.

---

## The 9 output formats

| Format        | Ext      | Notes                                                        |
| ------------- | -------- | ------------------------------------------------------------ |
| SEG-Y Rev 1   | `.sgy`   | Most common modern SEG-Y; IEEE/IBM floats, big-endian.       |
| SEG-Y Rev 0   | `.sgy`   | Original SEG-Y for legacy tooling.                           |
| SEG-Y Rev 2   | `.sgy`   | Latest SEG-Y revision with extended headers.                 |
| Seismic Unix  | `.su`    | SU trace format (SEG-Y traces, no reel header).              |
| SEG-2 / .dat  | `.dat`   | SEG-2 engineering format (e.g. Geode land recorders).        |
| SEG-D Rev 1   | `.segd`  | Field acquisition format, revision 1.                        |
| SEG-D Rev 3   | `.segd`  | Field acquisition format, revision 3.                        |
| Tape Image    | `.tim`   | Raw tape-image container.                                    |
| CSV / ASCII   | `.csv`   | Plain numeric export for spreadsheets / scripts.             |

The output file extension is determined by the writer for the chosen format.

---

## Keyboard shortcuts

| Keys      | Action                            |
| --------- | --------------------------------- |
| `Ctrl+O`  | Open a single file                |
| `Ctrl+B`  | Jump to folder (batch) mode       |
| `1`-`5`   | Switch tabs                       |
| `?`       | Open / close this manual          |
| `Esc`     | Close the manual                  |

On macOS, use `Cmd` in place of `Ctrl`.

---

## Theme

A light/dark toggle lives in the top-right header. Seismic plot canvases keep a
dark scientific background in both themes for consistent waveform contrast.
