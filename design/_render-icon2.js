// Offscreen-Electron renderer for the SeisConv "icon 2" (concentric seismic waves).
// Loads design/icon-2.svg into a small HTML wrapper at each requested size and
// uses BrowserWindow.capturePage() to grab a crisp PNG with alpha. No native deps.
//
// Run from the repo root:  electron design/_render-icon2.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const DESIGN_DIR = __dirname;
const SVG_PATH = path.join(DESIGN_DIR, 'icon-2.svg');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function htmlFor(svg, size) {
  // Strip width/height so the SVG scales to the wrapper box; keep viewBox.
  const scaled = svg
    .replace(/\swidth="[^"]*"/, '')
    .replace(/\sheight="[^"]*"/, '');
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent;}
  #box{width:${size}px;height:${size}px;}
  #box svg{display:block;width:${size}px;height:${size}px;}
</style></head>
<body><div id="box">${scaled}</div></body></html>`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loadOnce(win, file) {
  // Resolve only when the page actually finishes loading; reject on failure.
  return new Promise((resolve, reject) => {
    const onDone = () => { cleanup(); resolve(); };
    const onFail = (_e, code, desc) => { cleanup(); reject(new Error(`did-fail-load ${code} ${desc}`)); };
    function cleanup() {
      win.webContents.removeListener('did-finish-load', onDone);
      win.webContents.removeListener('did-fail-load', onFail);
    }
    win.webContents.once('did-finish-load', onDone);
    win.webContents.once('did-fail-load', onFail);
    win.loadFile(file).catch(() => { /* handled by did-fail-load */ });
  });
}

async function renderSize(svg, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: false, devTools: false, backgroundThrottling: false },
  });

  const tmp = path.join(DESIGN_DIR, `._icon2-wrapper-${size}.html`);
  fs.writeFileSync(tmp, htmlFor(svg, size), 'utf8');

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await loadOnce(win, tmp);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await sleep(150);
    }
  }
  if (lastErr) { win.destroy(); try { fs.unlinkSync(tmp); } catch {} throw lastErr; }

  // Let the SVG paint.
  await sleep(150);
  const image = await win.capturePage();
  const buf = image.toPNG();
  const out = path.join(DESIGN_DIR, `icon-2-${size}.png`);
  fs.writeFileSync(out, buf);
  const meta = image.getSize();
  win.destroy();
  try { fs.unlinkSync(tmp); } catch {}
  console.log(`wrote icon-2-${size}.png  (${meta.width}x${meta.height}, ${buf.length} bytes)`);
}

// Prevent Electron from auto-quitting when we destroy a window between sizes
// (default Windows behavior quits once the last window closes).
app.on('window-all-closed', () => { /* keep running until we call app.quit() */ });

app.disableHardwareAcceleration();
// Force a 1x device scale so capturePage() yields exact size x size bitmaps
// regardless of the host display's DPI scaling.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('high-dpi-support', '1');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG_PATH, 'utf8');
  let failed = false;
  for (const size of SIZES) {
    try {
      await renderSize(svg, size);
    } catch (e) {
      console.error(`FAILED size ${size}:`, e.message || e);
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
  app.quit();
});
