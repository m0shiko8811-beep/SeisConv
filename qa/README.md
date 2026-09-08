# SeisConv automated QA harness

A reusable Playwright (`_electron`) harness that **launches the built desktop app and
drives it end-to-end** - getting past the native file-dialog wall by mocking the
open/save dialogs in the Electron *main* process - then exercises every tab and
reports issues (console errors, uncaught exceptions, blank canvases, broken flows).

## What it does

For each tab on the left rail it switches to the tab, runs its core flow, takes a
screenshot into `qa/shots/`, and asserts:

- **no uncaught exceptions** (Playwright `win.on('pageerror')`)
- **no error-level console output** (`win.on('console')`)
- the tab's key **`<canvas>` is not blank** - it reads the canvas back as pixels and
  fails if every sampled pixel is the dark plot background (`#0d1f33`) / transparent

Tabs / flows covered:

| Step | Tab | Flow exercised |
|------|-----|----------------|
| 1 | Converter (`#tab-conv`) | open big-endian SEG-Y → read File summary (traces/format/samples) |
| 2 | Trace Inspector (`#tab-trace`) | header table · Waveform↔Spectrum toggle · zoom in/out/fit · Next |
| 3 | File Viewer (`#tab-section`) | section render · next/prev sibling file · render-mode switch |
| 4 | SPS 2.1 (`#tab-sps`) | load S/R/X (multi-select) · survey-grid canvas · Run QC · stats |
| 4b | SPS headers (`#tab-sps`) | open the H-record modal · assert it populates · close |
| 4c | SPS 2.1 (`#tab-sps`) | export the loaded survey as a **real** coordinate CSV (seeds step 4d) |
| 4d | SPS Creation (`#tab-spscreate`) | import that CSV through the column-mapping wizard · column guess · projected-coordinate detection · `# CRS:` adoption · Import gated until a role is chosen · point table (virtualized) · legend · plan overlay canvas |
| 5 | Velocity (`#tab-vel`) | compute NMO semblance · semblance canvas |
| 6 | Trace Workbench (`#tab-workbench`) | add open trace · pick the LE file · analysis canvas |
| 7 | Converter (re-open) | re-open the little-endian SEG-Y (expects **251 traces**) |

## Prerequisites

```sh
npm install            # app deps incl. electron
npm install -D playwright   # the _electron driver ships in the playwright package
npm run build          # produces dist/main.js + renderer/dist/app.js (required)
```

> No browser download is needed - `_electron` drives the app's own Electron binary,
> not a bundled Chromium.

## Run it

```sh
npm run qa
# or
node qa/drive.mjs
```

Exit code is `0` when every tab-step passes, `1` when any step fails, and `2`/`3`/`4`
for build-missing / launch-failed / harness-crash. A per-tab PASS/FAIL report prints
to the console; screenshots land in `qa/shots/`.

## Test files (env-configurable)

No site or job identifier is hard-coded. Each input resolves as
**env var > `qa/local-paths.json` (git-ignored, per machine) > neutral default
under `SEISCONV_QA_DATA_ROOT`** (no default; set it to wherever your sample data lives):

| Env var | local-paths.json key | Default | Used by |
|---------|----------------------|---------|---------|
| `SEISCONV_QA_SEGY` | `segy` | `<DATA_ROOT>/example.segy` | Converter / Trace / Section / Velocity |
| `SEISCONV_QA_LE`   | `le`   | `<DATA_ROOT>/example-le.sgy` (a little-endian SEG-Y) | Workbench + LE re-open |
| `SEISCONV_QA_SPS`  | `sps`  | `<DATA_ROOT>/example.{s01,r01,x01}` (`;`-separated) | SPS tab (multiSelections) |

### Where the test window opens

Every driver that launches through `harness.launch()` (and `qa/drive.mjs`) puts
the app window on the **secondary display** and shows it **without taking focus**,
so a run does not interrupt whoever is working on the primary screen. The window
SIZE is never changed - the render-golden pixel oracle depends on 1240x860.

| Variable | Values | Default |
|---|---|---|
| `SEISCONV_QA_WINDOW_POS` | `secondary` / `primary` / `x,y` | `secondary` |
| `SEISCONV_QA_WINDOW_INACTIVE` | `1` (show without focus) / `0` | `1` |

`electron/main.ts` validates the request against the real displays: with a single
display, or an `x,y` that would leave the window off-screen, it centres on the
primary display instead, so a run can never open a window nobody can see.

The defaults are placeholder names, not files that ship with the repo: bring your
own SEG-Y and SPS triplet. Nothing here names a real survey, site or job, and
nothing that does may ever be committed. If an input is missing the harness
prints which key it was and the three ways to point it somewhere real.

`qa/local-paths.json` (optional, never committed). Copy
`qa/local-paths.example.json` to `qa/local-paths.json` and fill in your own
absolute paths:

```json
{
  "segy": "C:\\path\\to\\your.segy",
  "le": "C:\\path\\to\\your-little-endian.sgy",
  "sps": ["C:\\path\\to\\your.s01", "C:\\path\\to\\your.r01", "C:\\path\\to\\your.x01"]
}
```

The same file also feeds `scripts/test-fuzz.ts`, `scripts/test-crossformat.ts`
and `scripts/positioning-qc.ts` (`npm run test:fuzz` / `test:crossformat` /
`qc:positioning`, all three rolled into `npm run test:all`), via the shared
resolver in `qa/local-paths.mjs` (env var > this file > loud failure - never a
silent fallback to a real path):

| Env var | local-paths.json key | Used by |
|---------|----------------------|---------|
| `SEISCONV_FUZZ_DATA` | `fuzzData` | `test:fuzz` - a folder of `.segd`/`.segy` files to mutate |
| `SEISCONV_FUZZ_DIRS` | `fuzzDirs` | `test:fuzz` - optional `;`-separated sub-directories under `fuzzData` |
| `SEISCONV_XFMT_DIR` | `xfmtDir` | `test:crossformat` - a corpus root holding paired `SEGD_Rev_2` / `SEGD_Rev_3` / `SEGY_REV_0` / `SEGY_Rev_2` sub-directories |
| `SEISCONV_SPS_DIR` + `SEISCONV_SPS_BASE` | `spsDir` + `spsBase` | `qc:positioning` - a folder holding `<spsBase>.s01/.r01/.x01` |

With none of those set, each script names exactly what to set and exits
non-zero (`test:fuzz`/`test:crossformat`) or SKIPs with exit 0
(`qc:positioning`, matching the file-backed-tests convention) - it never
falls back to a path baked into the repo.

```sh
# PowerShell
$env:SEISCONV_QA_SEGY = "C:\data\my.sgy"; npm run qa
# bash
SEISCONV_QA_SEGY=/c/data/my.sgy npm run qa
```

## How the dialog mock works

The native `dialog.showOpenDialog` / `showSaveDialog` block on a real OS dialog, so
the harness replaces them in the main process before each file action:

```js
await app.evaluate(async ({ dialog }, paths) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  dialog.showSaveDialog = async () => ({ canceled: true }); // never writes to disk
}, [TESTFILE]);
```

The return `filePaths` is set **per step** before clicking the button that triggers
that dialog (single path for Open, the three S/R/X paths for the SPS multi-select).
Save dialogs are made to cancel, so conversion flows run their full pipeline without
writing files.
