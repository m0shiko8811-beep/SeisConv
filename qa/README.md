# SeisConv automated QA harness

A reusable Playwright (`_electron`) harness that **launches the built desktop app and
drives it end-to-end** — getting past the native file-dialog wall by mocking the
open/save dialogs in the Electron *main* process — then exercises every tab and
reports issues (console errors, uncaught exceptions, blank canvases, broken flows).

## What it does

For each tab on the left rail it switches to the tab, runs its core flow, takes a
screenshot into `qa/shots/`, and asserts:

- **no uncaught exceptions** (Playwright `win.on('pageerror')`)
- **no error-level console output** (`win.on('console')`)
- the tab's key **`<canvas>` is not blank** — it reads the canvas back as pixels and
  fails if every sampled pixel is the dark plot background (`#0d1f33`) / transparent

Tabs / flows covered:

| Step | Tab | Flow exercised |
|------|-----|----------------|
| 1 | Converter (`#tab-conv`) | open big-endian SEG-Y → read File summary (traces/format/samples) |
| 2 | Trace Inspector (`#tab-trace`) | header table · Waveform↔Spectrum toggle · zoom in/out/fit · Next |
| 3 | File Viewer (`#tab-section`) | section render · next/prev sibling file · render-mode switch |
| 4 | SPS 2.1 (`#tab-sps`) | load S/R/X (multi-select) · survey-grid canvas · Run QC · stats |
| 5 | Velocity (`#tab-vel`) | compute NMO semblance · semblance canvas |
| 6 | Trace Workbench (`#tab-workbench`) | add open trace · pick the LE file · analysis canvas |
| 7 | Converter (re-open) | re-open the little-endian SEG-Y (expects **251 traces**) |

## Prerequisites

```sh
npm install            # app deps incl. electron
npm install -D playwright   # the _electron driver ships in the playwright package
npm run build          # produces dist/main.js + renderer/dist/app.js (required)
```

> No browser download is needed — `_electron` drives the app's own Electron binary,
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

Defaults point at the developer machine; override any of them with absolute paths:

| Env var | Default | Used by |
|---------|---------|---------|
| `SEISCONV_QA_SEGY` | `./samples/example.segy` | Converter / Trace / Section / Velocity |
| `SEISCONV_QA_LE`   | `./samples/example-tape.sgy` | Workbench + LE re-open (251 traces) |
| `SEISCONV_QA_SPS`  | `./samples/survey.s01;...r01;...x01` (`;`-separated) | SPS tab (multiSelections) |

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
