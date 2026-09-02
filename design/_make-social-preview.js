// Build design/social-preview.html (self-contained) and screenshot it to
// design/social-preview.png at exactly 1280x640 via Playwright.
// Brand-neutral. No personal data, no version, no real coordinates.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const dir = __dirname;
const iconB64 = fs.readFileSync(path.join(dir, '..', 'build', 'icon.png')).toString('base64');

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1280px; height: 640px; overflow: hidden; }
  body {
    position: relative;
    font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    background: linear-gradient(180deg, #0B1220 0%, #111C2E 100%);
    color: #fff;
  }
  #traces {
    position: absolute; top: 0; right: 0; width: 620px; height: 640px;
  }
  /* soft fade so the trace motif blends into the gradient on its left edge */
  #fade {
    position: absolute; top: 0; right: 0; width: 700px; height: 640px;
    background: linear-gradient(90deg, #0B1220 0%, rgba(11,18,32,0.55) 22%, rgba(11,18,32,0) 55%);
    pointer-events: none;
  }
  #left {
    position: absolute; left: 80px; top: 0; height: 640px; width: 720px;
    display: flex; flex-direction: column; justify-content: center;
  }
  #brand { display: flex; align-items: center; gap: 26px; }
  #brand img { width: 96px; height: 96px; display: block; }
  #wordmark {
    font-size: 92px; font-weight: 800; letter-spacing: -1px; line-height: 1;
    color: #FFFFFF;
  }
  #underline {
    width: 132px; height: 4px; border-radius: 2px; background: #00C853;
    margin: 30px 0 22px 2px;
  }
  #tagline {
    font-size: 30px; font-weight: 400; color: #9DB2CE; line-height: 1.35;
    max-width: 640px;
  }
  #chips {
    position: absolute; left: 82px; bottom: 54px;
    display: flex; gap: 12px; flex-wrap: wrap;
  }
  .chip {
    font-size: 20px; font-weight: 600; color: #C7D6EC;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(157,178,206,0.28);
    border-radius: 999px; padding: 8px 18px; letter-spacing: 0.2px;
  }
</style>
</head>
<body>
  <canvas id="traces" width="620" height="640"></canvas>
  <div id="fade"></div>
  <div id="left">
    <div id="brand">
      <img src="data:image/png;base64,${iconB64}" alt=""/>
      <div id="wordmark">SeisConv</div>
    </div>
    <div id="underline"></div>
    <div id="tagline">Desktop seismic data toolkit &mdash;<br/>convert, inspect, view, QC</div>
  </div>
  <div id="chips">
    <span class="chip">SEG-Y</span>
    <span class="chip">SEG-D</span>
    <span class="chip">SEG-2</span>
    <span class="chip">SU</span>
    <span class="chip">SPS</span>
    <span class="chip">P1/11</span>
  </div>
<script>
  // Deterministic synthetic wiggle / variable-density motif. Pure PRNG, no real data.
  const cv = document.getElementById('traces');
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  let seed = 20260706;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  const nTraces = 46;
  const gap = W / nTraces;
  const amp = gap * 1.7;
  // per-trace synthetic reflectivity convolved with a Ricker-ish wavelet
  for (let t = 0; t < nTraces; t++) {
    const x0 = t * gap + gap * 0.5;
    // build a smooth trace via summed decaying sinusoids with random phase
    const comps = [];
    for (let k = 0; k < 5; k++) {
      comps.push({ f: 0.006 + rnd() * 0.03, p: rnd() * 6.283, a: (0.4 + rnd() * 0.6) });
    }
    const pts = [];
    for (let y = 0; y <= H; y += 2) {
      let v = 0;
      for (const c of comps) v += c.a * Math.sin(y * c.f + c.p);
      // gentle envelope so amplitude varies down the trace
      const env = 0.55 + 0.45 * Math.sin(y * 0.004 + t * 0.3);
      v = (v / comps.length) * env;
      pts.push({ x: x0 + v * amp, y, v });
    }
    // variable-density fill (blue for negative, red for positive) at low opacity
    g.lineWidth = 1.1;
    for (let i = 1; i < pts.length; i++) {
      const v = pts[i].v;
      const mag = Math.min(1, Math.abs(v));
      let col;
      if (v >= 0) col = 'rgba(232,96,96,' + (0.05 + mag * 0.18) + ')';   // muted red
      else        col = 'rgba(96,150,232,' + (0.05 + mag * 0.18) + ')';  // muted blue
      g.strokeStyle = col;
      g.beginPath();
      g.moveTo(pts[i - 1].x, pts[i - 1].y);
      g.lineTo(pts[i].x, pts[i].y);
      g.stroke();
    }
    // white-ish wiggle line over the top, low opacity
    g.strokeStyle = 'rgba(210,224,244,0.16)';
    g.lineWidth = 1.0;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.stroke();
    // filled positive lobes (variable-area) faint red
    g.fillStyle = 'rgba(232,96,96,0.06)';
    g.beginPath();
    g.moveTo(x0, 0);
    for (const p of pts) { if (p.v > 0) g.lineTo(p.x, p.y); else g.lineTo(x0, p.y); }
    g.lineTo(x0, H);
    g.closePath();
    g.fill();
  }
</script>
</body>
</html>`;

const htmlPath = path.join(dir, 'social-preview.html');
fs.writeFileSync(htmlPath, html);
console.log('wrote', htmlPath, html.length, 'bytes');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await page.goto('file://' + htmlPath.replace(/\\/g, '/'));
  await page.waitForTimeout(400);
  const pngPath = path.join(dir, 'social-preview.png');
  await page.screenshot({ path: pngPath, clip: { x: 0, y: 0, width: 1280, height: 640 } });
  await browser.close();
  const st = fs.statSync(pngPath);
  console.log('wrote', pngPath, st.size, 'bytes');
})();
