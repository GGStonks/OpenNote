// The Rust GPU canvas (crates/canvas, docs/rust-native-canvas.md N1) against the app's own canvas
// drawing of the same page: the 36 reference strokes of bench/rust-ref/ink.json (fountain pen,
// ballpoint, highlighter) laid out on one 816 x 1056 page, drawn by strokeRenderer.drawStrokes in
// headless Chromium and by opennote_canvas_cli, at the scales given. Every inked pixel of each must
// lie within 1 px of the other's ink and the total ink darkness must agree within 2%.
//
//   node bench/canvasCompare.mjs [--scales 1,4] [--shots <dir>]   (writes <dir>/canvas-<scale>.png:
//   app | GPU | difference, red only the app, blue only the GPU)
//
// Needs bench/rust-ref/ink.json (npm run bench:rustref -- bench/rust-ref/ink.json), playwright-core
// and Playwright's Chromium as bench/ui.mjs does, and cargo (the CLI is built here, release).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? '/home/ds/AI/camofox-browser/node_modules/playwright-core');
const pwDir = join(homedir(), '.cache/ms-playwright');
const executablePath = join(pwDir, readdirSync(pwDir).filter((d) => /^chromium-\d+$/.test(d)).sort().pop(), 'chrome-linux64/chrome');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const scales = arg('scales', '1,4').split(',').map(Number);
const shots = arg('shots');
if (shots) mkdirSync(shots, { recursive: true });

// The page: as crates/canvas/tests/compare.rs lays it out (rows 0-3 fountain, 4 ballpoint, 5 highlighter).
const ref = JSON.parse(readFileSync(join(ROOT, 'bench/rust-ref/ink.json'), 'utf8'));
const strokes = ref.strokes.map((r, i) => {
  const pts = r.points.map(([x, y, t, p]) => ({ x, y, t, pressure: p }));
  const minX = Math.min(...pts.map((p) => p.x)), minY = Math.min(...pts.map((p) => p.y));
  const maxX = Math.max(...pts.map((p) => p.x)), maxY = Math.max(...pts.map((p) => p.y));
  const s = Math.min(1, 120 / Math.max(1, maxX - minX), 150 / Math.max(1, maxY - minY));
  const col = i % 6, row = Math.floor(i / 6);
  const ox = 15 + col * 133, oy = 20 + row * 172;
  const points = pts.map((p) => ({ ...p, x: ox + (p.x - minX) * s, y: oy + (p.y - minY) * s }));
  const kind = row === 4 ? { tool: 'pen', penStyle: 'ballpoint', color: '#1a3d8f' } : row === 5 ? { tool: 'highlighter', color: '#f5c400' } : { tool: 'pen', penStyle: 'fountain', color: '#000000' };
  return { id: `s${i}`, createdAt: i, width: r.width, opacity: 1, lineStyle: 'solid', ...kind, points, ...(r.penEndFlag && kind.tool === 'pen' ? { penEnd: true } : {}) };
});
const pageFile = join(ROOT, 'node_modules/.cache/canvas-compare-page.json');
writeFileSync(pageFile, JSON.stringify(strokes));

execFileSync('cargo', ['build', '-q', '--release', '-p', 'canvas', '--bin', 'opennote_canvas_cli'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '4' } });
const cli = join(ROOT, 'target/release/opennote_canvas_cli');
execFileSync('npx', ['esbuild', 'bench/canvasDraw.ts', '--bundle', '--format=iife', '--log-level=error', '--outfile=node_modules/.cache/canvas-draw.js'], { cwd: ROOT, stdio: 'inherit' });
const drawJs = readFileSync(join(ROOT, 'node_modules/.cache/canvas-draw.js'), 'utf8');

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.addScriptTag({ content: drawJs });
let failed = false;
for (const scale of scales) {
  const W = Math.round(816 * scale), H = Math.round((scale > 1 ? 300 : 1056) * scale);
  const app = Buffer.from(await page.evaluate(([s, w, h, k]) => window.drawApp(s, w, h, k, '#ffffff'), [strokes, W, H, scale]), 'base64');
  const t0 = performance.now();
  const gpu = execFileSync(cli, [pageFile, String(W), String(H), String(scale), '#ffffff'], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  const gpuMs = performance.now() - t0;
  const luma = (b, i) => 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
  const mask = (b) => { const m = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) m[i] = luma(b, i * 4) < 245; return m; };
  const ma = mask(app), mg = mask(gpu);
  const near = (m, x, y) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && m[yy * W + xx]) return true; } return false; };
  let na = 0, ng = 0, ha = 0, hg = 0, darkA = 0, darkG = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (ma[i]) { na++; if (near(mg, x, y)) ha++; }
    if (mg[i]) { ng++; if (near(ma, x, y)) hg++; }
    darkA += 255 - luma(app, i * 4); darkG += 255 - luma(gpu, i * 4);
  }
  const inA = ha / Math.max(1, na), inG = hg / Math.max(1, ng), dark = darkG / Math.max(1, darkA);
  const ok = inA >= 0.995 && inG >= 0.995 && Math.abs(dark - 1) <= 0.02;
  if (!ok) failed = true;
  console.log(`canvas ${scale}x: ink px app ${na}, GPU ${ng}; within 1 px: ${(inA * 100).toFixed(2)}% of the app's, ${(inG * 100).toFixed(2)}% of the GPU's; darkness GPU/app ${dark.toFixed(3)}; GPU ${gpuMs.toFixed(0)} ms incl. process start${ok ? '' : '  FAIL'}`);
  if (shots) {
    const diff = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const [r, g, b] = ma[i] && mg[i] ? [0, 0, 0] : ma[i] ? [230, 40, 40] : mg[i] ? [40, 80, 230] : [255, 255, 255];
      diff[i * 4] = r; diff[i * 4 + 1] = g; diff[i * 4 + 2] = b; diff[i * 4 + 3] = 255;
    }
    await page.setContent('<body style="margin:0;background:#888"><canvas id=c></canvas></body>');
    await page.evaluate(([bufs, w, h]) => {
      const c = document.getElementById('c'); c.width = w * 3 + 40; c.height = h + 40;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#888'; ctx.fillRect(0, 0, c.width, c.height);
      bufs.forEach((b64, k) => { const bin = atob(b64), arr = new Uint8ClampedArray(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); ctx.putImageData(new ImageData(arr, w, h), 10 + k * (w + 10), 30); });
      ctx.fillStyle = '#000'; ctx.font = '20px sans-serif';
      ['App (canvas)', 'Rust GPU canvas', 'Red: only app  Blue: only GPU'].forEach((t, k) => ctx.fillText(t, 10 + k * (w + 10), 22));
    }, [[app.toString('base64'), gpu.toString('base64'), diff.toString('base64')], W, H]);
    await page.locator('#c').screenshot({ path: join(shots, `canvas-${scale}.png`) });
    await page.addScriptTag({ content: drawJs });
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
