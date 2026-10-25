/**
 * UI performance on a slow device, in headless Chromium (Playwright's build).
 *
 * Seeds a note of real handwriting (bench/recordings) over several pages, opens it on an iPad Air
 * sized screen (820x1180 @2x) with the CPU slowed down (default 4x, a mid-range tablet), then:
 *
 *   pen     replays recorded pen strokes as real input (CDP pen events, 240 Hz like the Pencil)
 *           on the page in view, and reports frame times and input lag: from a pen event to the
 *           frame that showed it
 *   scroll  scrolls through the note with the mouse wheel, and reports frame times
 *   swipe   one finger flicks the note up and down (the app's own finger scrolling and momentum)
 *   pinch   two fingers zoom in and out (including the repaint at the new zoom when they lift)
 *   lasso   selects a block of handwriting with the lasso and drags it around
 *   pages   drags a page in the page manager
 *
 * For the finger scenarios the lag is from a pointer event to the next frame.
 * --only pen,scroll,swipe,pinch,lasso,pages runs some of them (default: all).
 *
 * Run: npm run build && node bench/ui.mjs [--cpu 4] [--pages 8] [--headed]
 * Needs playwright-core (/home/ds/AI/camofox-browser/node_modules) and Playwright's Chromium.
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const CPU = Number(arg('cpu', 4));
const PAGES = Number(arg('pages', 8));
const HEADED = process.argv.includes('--headed');
/** Also prints where the main thread's time went (CPU profile, self time by function). */
const PROFILE = process.argv.includes('--profile');
/** Prints the main thread's time by trace event for the warm scroll (rendering work JS profiles miss). */
const TRACE = process.argv.includes('--trace');
const PORT = 4179;

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? '/home/ds/AI/camofox-browser/node_modules/playwright-core');
const pwDir = join(homedir(), '.cache/ms-playwright');
const chromeDir = readdirSync(pwDir).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const executablePath = join(pwDir, chromeDir, 'chrome-linux64/chrome');

// ---------------------------------------------------------------------------------- the note
const recDir = join(ROOT, 'bench/recordings');
const recorded = readdirSync(recDir)
  .filter((f) => f.endsWith('.json'))
  .flatMap((f) => JSON.parse(readFileSync(join(recDir, f), 'utf8')).strokes)
  .filter((s) => s.tool === 'pen' && s.samples.length > 3);

const PAGE_W = 816, PAGE_H = 1056;
function seedNote() {
  // Each page is filled with recorded strokes laid out in lines of handwriting.
  const strokes = [];
  let n = 0;
  for (let page = 0; page < PAGES; page++) {
    for (let line = 0; line < 22; line++) {
      let x = 90;
      while (x < PAGE_W - 120) {
        const s = recorded[n++ % recorded.length];
        const xs = s.samples.map((p) => p[0]), ys = s.samples.map((p) => p[1]);
        const minX = Math.min(...xs), minY = Math.min(...ys), w = Math.max(...xs) - minX, h = Math.max(...ys) - minY;
        const k = Math.min(1, 26 / Math.max(1, h), 60 / Math.max(1, w));
        const ox = x, oy = page * PAGE_H + 90 + line * 40;
        strokes.push({
          id: `stroke_${n}_${page}`,
          tool: 'pen', color: '#111827', width: s.width || 1.6, opacity: 1, penStyle: s.penStyle || 'fountain',
          createdAt: 1700000000000 + strokes.length,
          points: s.samples.map((p) => ({ x: ox + (p[0] - minX) * k, y: oy + (p[1] - minY) * k, pressure: p[3] || 0.5, t: p[2] })),
        });
        x += w * k + 14;
      }
    }
  }
  const now = Date.now();
  // --latex: a converted formula on the first page, made halfway through the writing (the ink is
  // then two layers, under and over the formula, as after a LaTeX conversion).
  const latexBlocks = process.argv.includes('--latex')
    ? [process.env.BENCH_LATEX_BIG
        ? { id: 'latex_bench', x: 60, y: 200, width: 640, height: 400, scale: 2.2, latexCode: 'Sia $f(x) = \\int_0^x e^{-t^2}\\,dt$ la funzione degli errori. Allora per ogni $x > 0$ vale la stima seguente, che si dimostra integrando per parti due volte e confrontando i termini:\n\n$$\\sum_{n=0}^{\\infty} \\frac{(-1)^n x^{2n+1}}{n!\\,(2n+1)} = f(x)$$\n\nIn particolare la serie converge uniformemente sui compatti e la funzione è analitica ovunque.', createdAt: 1700000000000 + Math.floor(strokes.length / 2) }
        : { id: 'latex_bench', x: 120, y: 300, width: 300, height: 60, latexCode: '\\int_0^1 x^2\\,dx = \\frac{1}{3}', createdAt: 1700000000000 + Math.floor(strokes.length / 2) }]
    : [];
  return {
    id: 'doc_bench', title: 'Bench note', createdAt: now, updatedAt: now, paperStyle: 'ruled', paperColor: 'white', schemaVersion: 3,
    pages: [{ id: 'page_bench', pageNumber: 1, strokes, latexBlocks, textBlocks: [], imageBlocks: [] }],
  };
}

// ---------------------------------------------------------------------------------- stats
const pct = (v, q) => (v.length ? v.slice().sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * q))] : NaN);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
function frameStats(label, frames) {
  const d = frames.slice(1).map((t, i) => t - frames[i]);
  const long = d.filter((x) => x > 25).length;
  console.log(`${label.padEnd(8)} frames ${String(d.length).padStart(4)}  fps ${f1(1000 / (d.reduce((a, b) => a + b, 0) / Math.max(1, d.length)))}  frame p50 ${f1(pct(d, 0.5))} p95 ${f1(pct(d, 0.95))} max ${f1(Math.max(...d))} ms  >25ms: ${long}`);
}

// ---------------------------------------------------------------------------------- run
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
const cleanup = () => server.kill();
process.on('exit', cleanup);
await new Promise((r) => setTimeout(r, 1500));

// BENCH_GPU=1: WebGL on this PC's GPU (ANGLE over Vulkan) instead of the software renderer.
const gpuArgs = process.env.BENCH_GPU ? (process.env.BENCH_GPU_ARGS ?? '--use-angle=vulkan --enable-features=Vulkan').split(' ') : [];
const browser = await chromium.launch({ executablePath, headless: !HEADED, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist', ...gpuArgs] });
// --dpr: the screen's density (2 = iPad; Android tablets are often 2.6-3.5).
// --landscape: an iPad held sideways (the page fits the width at about 140%).
const LANDSCAPE = process.argv.includes('--landscape');
const ctx = await browser.newContext({ viewport: LANDSCAPE ? { width: 1180, height: 820 } : { width: 820, height: 1180 }, deviceScaleFactor: Number(arg('dpr', 2)), hasTouch: true });
// --native: as in the apps, a native ink bridge is present (a stand-in that only takes the messages),
// so the page leaves the live stroke to it (nativeInk.ts).
if (process.argv.includes('--native')) await ctx.addInitScript(() => { window.__inkMsgs = []; window.OpenNoteInk = { post(m) { if (m[0] === 'b' || m[0] === 'e' || m[0] === 'c') window.__inkMsgs.push(m.split(',')[0] + (m[0] === 'b' ? ':' + m.split(',')[10] : m[0] === 'e' ? ':' + (m.split(',')[1] ?? '') : '')); } }; });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
if (process.env.BENCH_CONSOLE) page.on('console', (m) => console.log('console:', m.text()));
// BENCH_NO_GL=1: pinches without the GPU ink (the bitmaps), to compare.
if (process.env.BENCH_NO_GL) await page.addInitScript(() => localStorage.setItem('opennote_gl', 'off'));
const url = `http://localhost:${PORT}/`;
await page.goto(url);
await page.evaluate(async (note) => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('OpenNote_Database');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  await new Promise((res, rej) => {
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').put(note);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}, seedNote());
await page.reload();
await page.getByText('Bench note').first().click();
await page.waitForTimeout(2500);
// --css "<rules>": extra CSS for experiments (e.g. hiding a kind of element to see what it costs).
if (arg('css')) await page.addStyleTag({ content: arg('css') });

const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });

// Frame clock and input lag, measured in the page (installed again after each reopen).
const instrument = () => page.evaluate(() => {
  const w = window;
  w.__bench = { frames: [], moves: [], lags: [], on: false };
  const loop = (t) => {
    if (w.__bench.on) w.__bench.frames.push(t);
    const now = performance.now();
    for (const at of w.__bench.moves) w.__bench.lags.push(now - at);
    w.__bench.moves = [];
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.addEventListener('pointermove', (e) => w.__bench.on && w.__bench.moves.push(e.timeStamp), true);
});
await instrument();
async function profiled(label, run) {
  if (!PROFILE) return run();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const out = await run();
  const { profile } = await cdp.send('Profiler.stop');
  const dt = profile.timeDeltas;
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const n = byId.get(id).callFrame;
    const key = `${n.functionName || '(anon)'} ${n.url.split('/').pop()}:${n.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  console.log(`  ${label} profile (self ms, of ${total.toFixed(0)}):`);
  [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).forEach(([k, v]) => console.log(`    ${v.toFixed(0).padStart(7)}  ${k}`));
  return out;
}
async function traced(label, run) {
  if (!TRACE) return run();
  await browser.startTracing(page, { categories: (arg('cats') ?? 'devtools.timeline,disabled-by-default-devtools.timeline').split(',') });
  const out = await run();
  const { traceEvents } = JSON.parse((await browser.stopTracing()).toString());
  const main = traceEvents.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  const by = new Map(), longest = new Map();
  for (const e of traceEvents) {
    if (e.ph !== 'X' || !e.dur || (main && (e.pid !== main.pid || e.tid !== main.tid))) continue;
    by.set(e.name, (by.get(e.name) ?? 0) + e.dur / 1000);
    longest.set(e.name, Math.max(longest.get(e.name) ?? 0, e.dur / 1000));
  }
  // What the long tasks (> 30 ms) were made of.
  const mainEv = traceEvents.filter((e) => e.ph === 'X' && e.dur && main && e.pid === main.pid && e.tid === main.tid);
  const longTasks = mainEv.filter((e) => e.name === 'RunTask' && e.dur > 30000);
  const inLong = new Map();
  for (const t of longTasks) {
    for (const e of mainEv) {
      if (e === t || e.ts < t.ts || e.ts + e.dur > t.ts + t.dur) continue;
      const d = e.args?.data ?? {};
      const k = e.name + (d.functionName !== undefined ? ` ${d.functionName || '(anon)'} ${(d.url ?? '').split('/').pop()}:${d.lineNumber ?? ''}` : d.type ? ` ${d.type}` : '');
      inLong.set(k, (inLong.get(k) ?? 0) + e.dur / 1000);
    }
  }
  console.log(`  ${label}: ${longTasks.length} tasks > 30 ms, made of:`);
  [...inLong.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, v]) => console.log(`    ${v.toFixed(0).padStart(7)}  ${k}`));
  console.log(`  ${label} main thread by event (total / longest ms):`);
  [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log(`    ${v.toFixed(0).padStart(7)} ${longest.get(k).toFixed(0).padStart(6)}  ${k}`));
  return out;
}
/** --count: draw calls and resizes per canvas size during each scenario (which canvases do work). */
const COUNT = process.argv.includes('--count');
const start = async () => {
  if (COUNT) await page.evaluate(() => {
    window.__draws = new Map();
    if (window.__countInstalled) return;
    window.__countInstalled = true;
    const P = CanvasRenderingContext2D.prototype;
    for (const m of ['fill', 'stroke', 'clearRect', 'drawImage']) {
      const orig = P[m];
      P[m] = function (...a) {
        const k = `${m} ${this.canvas.width}x${this.canvas.height}`;
        window.__draws.set(k, (window.__draws.get(k) ?? 0) + 1);
        return orig.apply(this, a);
      };
    }
    const w = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', { get: w.get, set(v) { window.__draws.set(`resize ${v}`, (window.__draws.get(`resize ${v}`) ?? 0) + 1); w.set.call(this, v); } });
  });
  await page.evaluate(() => Object.assign(window.__bench, { frames: [], moves: [], lags: [], on: true }));
};
const stop = async () => {
  if (COUNT) console.log('  canvases:', await page.evaluate(() => JSON.stringify([...window.__draws.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))));
  return page.evaluate(() => { window.__bench.on = false; return { frames: window.__bench.frames, lags: window.__bench.lags }; });
};

const mouse = (type, x, y, force = 0.5) =>
  cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force });

console.log(`CPU ${CPU}x slower, ${PAGES} pages, ${recorded.length} recorded strokes`);
const ONLY = new Set((arg('only', 'pen,scroll,swipe,pinch,lasso,pages')).split(','));

/** Back to a freshly opened note (each scenario starts from the same state). */
async function reopen() {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.reload();
  await page.getByText('Bench note').first().click();
  await page.waitForTimeout(2500);
  await instrument();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
}
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Moves fingers from `a` to `b` (arrays of [x, y]) in `ms`, one event per 8 ms. */
async function fingers(a, b, ms, end = true) {
  await touch('touchStart', a);
  const n = Math.max(1, Math.round(ms / 8));
  for (let i = 1; i <= n; i++) {
    await touch('touchMove', a.map(([x, y], k) => [x + ((b[k][0] - x) * i) / n, y + ((b[k][1] - y) * i) / n]));
    await sleep(8);
  }
  if (end) await touch('touchEnd', []);
}
async function report(label, run) {
  await start();
  const t = Date.now();
  await traced(label, () => profiled(label, run));
  const r = await stop();
  frameStats(label, r.frames);
  if (r.lags.length) console.log(`${label.padEnd(8)} input lag p50 ${f1(pct(r.lags, 0.5))} p95 ${f1(pct(r.lags, 0.95))} max ${f1(Math.max(...r.lags))} ms, ${((Date.now() - t) / 1000).toFixed(1)} s`);
}

if (ONLY.has('swipe')) {
  await reopen();
  await report('swipe', async () => {
    const top = () => page.evaluate(() => Math.round([...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 500 && getComputedStyle(d).overflow === 'auto')?.scrollTop ?? -1));
    const t0 = await top();
    for (let i = 0; i < 3; i++) {
      await fingers([[410, 900]], [[410, 400]], 160);
      await sleep(900);
    }
    console.log(`swipe    scrolled ${t0} -> ${await top()} px after three flicks`);
    for (let i = 0; i < 3; i++) {
      await fingers([[410, 400]], [[410, 900]], 160);
      await sleep(900);
    }
  });
}
// --only pinchsplit: frames while two fingers move, separately from the second after they lift
// (the note's ink prepared first, so first-use costs are left out).
if (ONLY.has('pinchsplit')) {
  await reopen();
  await sleep(8000);
  const deltas = { moving: [], after: [] };
  const phase = async (name, run) => {
    await start();
    await run();
    const f = (await stop()).frames;
    for (let j = 1; j < f.length; j++) deltas[name].push(f[j] - f[j - 1]);
  };
  for (let i = 0; i < 2; i++) {
    for (const [a, b] of [[[[360, 600], [460, 600]], [[210, 600], [610, 600]]], [[[210, 600], [610, 600]], [[360, 600], [460, 600]]]]) {
      await phase('moving', () => traced('pinch moving', () => fingers(a, b, 600, false)));
      await phase('after', async () => {
        await touch('touchEnd', []);
        await sleep(1000);
      });
    }
  }
  for (const [k, d] of Object.entries(deltas)) {
    console.log(`${('pinch ' + k).padEnd(13)} frames ${d.length}  frame p50 ${f1(pct(d, 0.5))} p95 ${f1(pct(d, 0.95))} max ${f1(Math.max(...d))} ms  >25ms: ${d.filter((x) => x > 25).length}`);
  }
}
if (ONLY.has('pinch')) {
  await reopen();
  await report('pinch', async () => {
    for (let i = 0; i < 2; i++) {
      await fingers([[360, 600], [460, 600]], [[210, 600], [610, 600]], 400);
      await sleep(1200);
      if (arg('shots') && i === 0) await page.screenshot({ path: join(arg('shots'), 'zoomed.png') });
      await fingers([[210, 600], [610, 600]], [[360, 600], [460, 600]], 400);
      await sleep(1200);
    }
  });
}
// Not in the default run: --only zoomshots --shots <dir> saves close-ups of the ink while two
// fingers zoom (still down) and after they lift, at a medium and a high zoom.
if (ONLY.has('zoomshots') && arg('shots')) {
  for (const [name, spread] of [['low', 92], ['mid', 230], ['high', 420]]) {
    await reopen();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await fingers([[410 - 50, 600], [410 + 50, 600]], [[410 - spread, 600], [410 + spread, 600]], 500, false);
    await sleep(300);
    await page.screenshot({ path: join(arg('shots'), `zoom-${name}-pinching.png`), clip: { x: 260, y: 480, width: 300, height: 240 } });
    // The same moment with the sharp ink switched off (the stretched tiles): the ink must be in the same place.
    await page.evaluate(() => document.querySelectorAll('[data-sharp-ink]').forEach((el) => { el.setAttribute('data-bench-off', ''); el.removeAttribute('data-sharp-ink'); el.querySelectorAll(':scope > canvas[style*="z-index: 6"]').forEach((c) => (c.style.visibility = 'hidden')); }));
    await page.screenshot({ path: join(arg('shots'), `zoom-${name}-pinching-tiles.png`), clip: { x: 260, y: 480, width: 300, height: 240 } });
    await page.evaluate(() => document.querySelectorAll('[data-bench-off]').forEach((el) => { el.removeAttribute('data-bench-off'); el.setAttribute('data-sharp-ink', ''); el.querySelectorAll(':scope > canvas[style*="z-index: 6"]').forEach((c) => (c.style.visibility = '')); }));
    await touch('touchEnd', []);
    // Right after the fingers lift: the ink must never be missing (the tiles keep their picture
    // while they repaint at the new zoom).
    let waited = 0;
    for (const at of [30, 150, 500, 1500]) {
      await sleep(at - waited);
      waited = at;
      await page.screenshot({ path: join(arg('shots'), `zoom-${name}-after-${at}.png`), clip: { x: 260, y: 480, width: 300, height: 240 } });
    }
    await page.screenshot({ path: join(arg('shots'), `zoom-${name}-after.png`), clip: { x: 260, y: 480, width: 300, height: 240 } });
    console.log(`zoomshots ${name}: zoom ${await page.evaluate(() => document.body.innerText.match(/(\d+)%/)?.[1])}%`);
  }
}
// Not in the default run: --only pinchwork: the main thread's work while two fingers zoom and move
// (layouts, style recalculations, script time), from Chrome's performance counters.
if (ONLY.has('pinchwork')) {
  await reopen();
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const a = await metrics();
  await fingers([[360, 640], [460, 640]], [[420, 420], [760, 520]], 1000, false);
  const b = await metrics();
  await touch('touchEnd', []);
  await sleep(500);
  const d = (k) => b[k] - a[k];
  console.log(`pinchwork layouts ${d('LayoutCount')}  style recalcs ${d('RecalcStyleCount')}  layout ${(d('LayoutDuration') * 1000).toFixed(0)} ms  style ${(d('RecalcStyleDuration') * 1000).toFixed(0)} ms  script ${(d('ScriptDuration') * 1000).toFixed(0)} ms  (1 s gesture, ${CPU}x slower CPU)`);
}
// Not in the default run: --only zpinch: two fingers zooming in and out from an already zoomed-in
// page (its sharp tiles painted): frames, and the ink canvases on screen in the middle of the pinch
// (only one set of them should be composited while they cover the view).
if (ONLY.has('zpinch')) {
  await reopen();
  await fingers([[360, 600], [460, 600]], [[210, 600], [610, 600]], 400);
  await sleep(2500);
  const shown = () => page.evaluate(() => [...document.querySelectorAll('canvas')].filter((c) => c.width * c.height > 1 && c.checkVisibility({ visibilityProperty: true }) && c.getBoundingClientRect().bottom > 0 && c.getBoundingClientRect().top < innerHeight).length);
  const before = await shown();
  let midIn = 0, midOut = 0;
  await report('zpinch', async () => {
    for (let i = 0; i < 2; i++) {
      await fingers([[360, 600], [460, 600]], [[300, 600], [520, 600]], 300, false);
      midIn = await shown();
      await touch('touchEnd', []);
      await sleep(1500);
      await fingers([[300, 600], [520, 600]], [[360, 600], [460, 600]], 300, false);
      midOut = await shown();
      await touch('touchEnd', []);
      await sleep(1500);
    }
  });
  console.log(`zpinch   canvases on screen: resting ${before}, zooming in ${midIn}, zooming out ${midOut}`);
  console.log(`zpinch   frame rate measured: ${await page.evaluate(() => JSON.parse(localStorage.getItem('opennote_crashlog_v1') || '{}').current?.crumbs.filter((c) => c.kind === 'frame-rate').map((c) => c.hz).join(', ') || 'none')} Hz`);
  console.log(`zpinch   GPU ink pieces: ${await page.evaluate(() => window.__opennoteGlInk?.shared()?.pieces ?? 'none')}`);
  const logged = await page.evaluate(() => JSON.parse(localStorage.getItem('opennote_crashlog_v1') || '{}').current?.crumbs.filter((c) => c.kind === 'pinch').slice(-2));
  for (const c of logged ?? []) console.log(`zpinch   crash log: ${JSON.stringify(c)}`);
}
// --only glwrite: a stroke written, then two fingers zoom 150 ms later, three times: each pinch
// must be drawn by the GPU (crash log 'pinch' gl) with the new stroke added, not rebuilt.
if (ONLY.has('glwrite')) {
  await reopen();
  await page.waitForFunction(() => (window.__opennoteGlInk?.shared()?.pieces ?? 0) > 0, null, { timeout: 120000, polling: 100 }).catch(() => null);
  const pieces = () => page.evaluate(() => window.__opennoteGlInk?.shared()?.pieces ?? 0);
  const p0 = await pieces();
  for (let r = 0; r < 3; r++) {
    const y = 420 + r * 60;
    await mouse('mouseMoved', 200, y, 0);
    await mouse('mousePressed', 200, y);
    for (let i = 1; i <= 24; i++) {
      await mouse('mouseMoved', 200 + i * 9, y + Math.sin(i / 3) * 14);
      await sleep(8);
    }
    await mouse('mouseReleased', 416, y, 0);
    await sleep(150);
    const last = r === 2 && arg('shots');
    await fingers([[360, 640], [460, 640]], [[300, 640], [520, 640]], 300, !last);
    if (last) {
      // Mid-pinch: the strokes just written must be there (drawn by the GPU).
      await page.screenshot({ path: join(arg('shots'), 'glwrite-pinching.png') });
      await touch('touchEnd', []);
    }
    await sleep(1200);
  }
  const log = await page.evaluate(() => JSON.parse(localStorage.getItem('opennote_crashlog_v1') || '{}').current?.crumbs.filter((c) => c.kind === 'pinch').slice(-3));
  console.log(`glwrite  pieces ${p0} -> ${await pieces()}; pinches: ${(log ?? []).map((c) => `${c.gl}${c.glStartMs !== undefined ? ' ' + c.glStartMs + ' ms' : ''}`).join(', ')}`);
}
// --only latexshift (with --latex): the LaTeX block's content, in page units, at zooms from the
// fit width up to 500% (zoom buttons). It must not move or change size with the zoom.
if (ONLY.has('latexshift')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const measure = () => page.evaluate(() => {
    const c = document.querySelector('.on-page');
    const k = document.querySelector('.on-math .katex') ?? document.querySelector('.on-math');
    const box = document.querySelector('.on-math')?.closest('.absolute[style*="left"]');
    if (!c || !k) return null;
    const cr = c.getBoundingClientRect(), kr = k.getBoundingClientRect();
    const zoom = Number(document.body.innerText.match(/(\d+)%/)?.[1] ?? 0) / 100;
    const s = cr.width / c.offsetWidth;
    const f = (v) => Math.round(v * 100) / 100;
    const parts = [...document.querySelectorAll('.on-math p, .on-math .katex-display, .on-math .katex-html')].slice(0, 6).map((e) => f((e.getBoundingClientRect().top - cr.top) / s));
    return { zoom, x: f((kr.left - cr.left) / s), y: f((kr.top - cr.top) / s), w: f(kr.width / s), h: f(kr.height / s), box: box ? f(box.getBoundingClientRect().width / s) : null, parts };
  });
  const rows = [await measure()];
  for (let i = 0; i < 12; i++) {
    const b = page.locator('[title^="Zoom in"]').first();
    if (!(await b.isEnabled().catch(() => false))) break;
    await b.click();
    await sleep(500);
    rows.push(await measure());
  }
  if (arg('shots')) {
    const r = await page.evaluate(() => { const b = document.querySelector('.on-math .katex')?.getBoundingClientRect(); return b ? { x: b.left, y: b.top } : null; });
    if (r) await page.screenshot({ path: join(arg('shots'), 'latex-500.png'), clip: { x: Math.max(0, r.x - 20), y: Math.max(0, r.y - 20), width: 600, height: 300 } });
  }
  for (const r of rows) console.log(`latexshift ${r ? `zoom ${r.zoom}  x ${r.x}  y ${r.y}  w ${r.w}  h ${r.h}  (block w ${r.box})  tops ${r.parts.join(' ')}` : 'no LaTeX'}`);
}
// --only library: the home screen with 24 notes like the bench note: how long the main thread is
// blocked while the library shows (long tasks over 50 ms in the first 6 s, at the CPU slowdown).
if (ONLY.has('library')) {
  await page.evaluate(async (note) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('OpenNote_Database');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('notes', 'readwrite');
      // As the app stores them (db.ts packNote): each stroke's points in one Float64Array.
      const pack = (st) => {
        const { points, ...rest } = st;
        const pts = new Float64Array(points.length * 6);
        points.forEach((q, i) => pts.set([q.x, q.y, q.pressure, q.t ?? NaN, q.alt ?? NaN, q.az ?? NaN], i * 6));
        return { ...rest, pts };
      };
      const packed = { ...note, pages: note.pages.map((pg) => ({ ...pg, strokes: pg.strokes.map(pack) })) };
      for (let i = 0; i < 24; i++) tx.objectStore('notes').put({ ...packed, id: `doc_lib_${i}`, title: `Library note ${i}`, updatedAt: note.updatedAt - i * 1000 });
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, seedNote());
  for (const pass of ['first', 'again']) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.addInitScript(() => {
      window.__long = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ entryTypes: ['longtask'] });
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    const t0 = Date.now();
    const run = async () => {
      await page.reload();
      await sleep(6000);
    };
    const drawAll = async () => {
      // Every card's thumbnail drawn and stored before the second opening.
      // (Only the cards near the screen are drawn: until no new one appears for 3 s.)
      let n = -1, still = 0;
      while (still < 6) {
        await sleep(500);
        const m = await page.evaluate(() => document.querySelectorAll('img').length);
        still = m === n ? still + 1 : 0;
        n = m;
      }
    };
    if (pass === 'first') await profiled('library', run);
    else await run();
    const long = await page.evaluate(() => window.__long ?? []);
    const imgs = await page.evaluate(() => document.querySelectorAll('img').length);
    if (pass === 'first') await drawAll();
    if (arg('shots')) {
      await sleep(2000);
      await page.screenshot({ path: join(arg('shots'), `library-${pass}.png`) });
    }
    if (process.env.BENCH_DEBUG) console.log('library  geom', JSON.stringify(await page.evaluate(() => {
      const im = document.querySelector('img'); if (!im) return null;
      const r = im.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 3);
      const cs = getComputedStyle(im);
      return { r: [r.left, r.top, r.width, r.height].map(Math.round), vis: cs.visibility, op: cs.opacity, disp: cs.display, top: top?.tagName + '.' + (top?.className?.toString?.() ?? ''), chain: (() => { const a = []; let e = im; for (let i = 0; i < 6 && e; i++) { a.push(e.tagName + ' ' + (e.getAttribute('class') ?? '') + ' ' + (e.getAttribute('style') ?? '').slice(0, 80)); e = e.parentElement; } return a; })() };
    })));
    if (process.env.BENCH_DEBUG) console.log('library  imgs', JSON.stringify(await page.evaluate(async () => Promise.all([...document.querySelectorAll('img')].slice(0, 2).map(async (im) => {
      await im.decode().catch(() => null);
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(im, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data; let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 128) ink++;
      return { w: im.naturalWidth, h: im.naturalHeight, ink, style: im.getAttribute('style'), len: im.src.length, parent: im.parentElement?.getAttribute('style') };
    })))));
    console.log(`library  ${pass}: long tasks ${long.length}, total ${Math.round(long.reduce((a, b) => a + b, 0))} ms, longest ${Math.round(Math.max(0, ...long))} ms in ${((Date.now() - t0) / 1000).toFixed(1)} s (${imgs} images)`);
  }
}
// --only longpinch --shots <dir> (best with --latex): one pinch from the fit width to 500%, the
// fingers still down at the end: the screenshot then must be sharp (the pinch commits its zoom on
// the way, crash log 'rebases'), and match the one after the fingers lift.
if (ONLY.has('longpinch') && arg('shots')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await sleep(1500);
  await fingers([[390, 600], [430, 600]], [[60, 600], [760, 600]], 1500, false);
  await sleep(400);
  await page.screenshot({ path: join(arg('shots'), 'longpinch-down.png') });
  if (process.env.BENCH_DEBUG) console.log('longpinch state', JSON.stringify(await page.evaluate(() => {
    const c = document.querySelector('.on-page');
    const gl = [...document.querySelectorAll('canvas')].find((x) => x.style.zIndex === '1');
    const inks = [...document.querySelectorAll('[data-ink-layer]')].map((e) => getComputedStyle(e).visibility);
    return { cls: c?.className, gl: gl ? { d: gl.style.display, w: gl.width, h: gl.height } : null, inks: inks.slice(0, 4), zoom: document.body.innerText.match(/(\d+)%/)?.[1] };
  })));
  await touch('touchEnd', []);
  await sleep(1500);
  await page.screenshot({ path: join(arg('shots'), 'longpinch-after.png') });
  const log = await page.evaluate(() => JSON.parse(localStorage.getItem('opennote_crashlog_v1') || '{}').current?.crumbs.filter((c) => c.kind === 'pinch').slice(-1)[0]);
  console.log(`longpinch zoom ${await page.evaluate(() => document.body.innerText.match(/(\d+)%/)?.[1])}%  ${JSON.stringify(log)}`);
}
// --only uishots --shots <dir>: the draw tool's options with the custom colour open (no sideways
// scrolling), the highlighter's, a new text box (handles, format bar, typeface list), the export
// dialog, and the library's cards.
if (ONLY.has('uishots') && arg('shots')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const shot = (name) => page.screenshot({ path: join(arg('shots'), `ui-${name}.png`) });
  const draw = page.locator('button[title^="Smart pen"]').first();
  await draw.click();
  await sleep(200);
  await draw.click();
  await sleep(300);
  await page.locator('button[title^="Any colour"]').first().click();
  await sleep(300);
  const pop = await page.evaluate(() => { const p = [...document.querySelectorAll('div')].find((d) => d.className.includes('no-scrollbar') && d.className.includes('w-80')); return p ? { sw: p.scrollWidth, cw: p.clientWidth } : null; });
  console.log(`uishots draw popover scrollWidth ${pop?.sw} clientWidth ${pop?.cw}`);
  await shot('draw');
  const hl = page.locator('button[title="Highlighter"]').first();
  await hl.click();
  await sleep(200);
  await hl.click();
  await sleep(300);
  await shot('highlighter');
  await page.locator('button[title="Text"]').first().click();
  await sleep(200);
  await mouse('mousePressed', 300, 700);
  await mouse('mouseReleased', 300, 700, 0);
  await sleep(400);
  await page.keyboard.type('Hello text box');
  await sleep(300);
  await shot('textbox');
  const handles = await page.evaluate(() => [...document.querySelectorAll('[data-text-resize]')].map((h) => { const r = h.getBoundingClientRect(); return `${h.getAttribute('data-text-resize')}:${Math.round(r.width)}`; }).join(' '));
  console.log(`uishots text box handles ${handles}`);
  await page.locator('button[title="Typeface"]').first().dispatchEvent('pointerdown');
  await sleep(300);
  await shot('fonts');
  await page.keyboard.press('Escape');
  await page.locator('button[title="Export"]').first().click();
  await sleep(400);
  await shot('export');
}
// --only boxes (with --latex): the text tool reopens an existing text box (no new one), and a LaTeX
// block's side handle stretches it one way only.
if (ONLY.has('boxes')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const count = () => page.evaluate(() => document.querySelectorAll('textarea').length + document.querySelectorAll('.whitespace-pre-wrap.break-words').length);
  await page.locator('button[title="Text"]').first().click();
  await sleep(200);
  await mouse('mousePressed', 300, 760);
  await mouse('mouseReleased', 300, 760, 0);
  await sleep(300);
  await page.keyboard.type('First box');
  await mouse('mousePressed', 600, 1000);
  await mouse('mouseReleased', 600, 1000, 0);
  await sleep(400);
  const before = await count();
  await mouse('mousePressed', 310, 765);
  await mouse('mouseReleased', 310, 765, 0);
  await sleep(400);
  const editing = await page.evaluate(() => document.querySelector('textarea')?.value ?? null);
  console.log(`boxes    text boxes ${before} -> ${await count()}, editing: ${JSON.stringify(editing)}, format bar ${await page.locator('[data-text-format]').count()}`);
  // LaTeX: select it with the lasso (tap), drag the right side handle.
  await page.locator('button[title^="Lasso"]').click();
  await sleep(200);
  const m = await page.locator('.on-math').first().boundingBox();
  if (m) {
    // A lasso around the formula (a tap would pick the ink lying over it).
    const cx = m.x + m.width / 2, cy = m.y + m.height / 2, rx = m.width / 2 + 30, ry = m.height / 2 + 30;
    const loop = Array.from({ length: 50 }, (_, i) => [cx + Math.cos((i / 49) * Math.PI * 2) * rx, cy + Math.sin((i / 49) * Math.PI * 2) * ry]);
    await mouse('mousePressed', loop[0][0], loop[0][1]);
    for (const [x, y] of loop.slice(1)) {
      await mouse('mouseMoved', x, y);
      await sleep(8);
    }
    await mouse('mouseReleased', loop[49][0], loop[49][1], 0);
    await sleep(500);
    console.log('boxes    after tap: selection', JSON.stringify(await page.locator('[data-selection-box]').first().boundingBox().catch(() => null)));
    const h = await page.locator('[data-resize="1,0"]').boundingBox();
    if (h) {
      const tr0 = await page.evaluate(() => getComputedStyle(document.querySelector('.on-math')).transform);
      await mouse('mousePressed', h.x + h.width / 2, h.y + h.height / 2);
      for (let i = 1; i <= 20; i++) {
        await mouse('mouseMoved', h.x + h.width / 2 + i * 6, h.y + h.height / 2);
        await sleep(10);
      }
      await mouse('mouseReleased', h.x + h.width / 2 + 120, h.y + h.height / 2, 0);
      await sleep(800);
      const tr1 = await page.evaluate(() => getComputedStyle(document.querySelector('.on-math')).transform);
      console.log('boxes    selection box', JSON.stringify(await page.locator('[data-selection-box]').first().boundingBox()), 'math box', JSON.stringify(await page.locator('.on-math').first().boundingBox()), 'handle was', JSON.stringify(h));
      console.log(`boxes    LaTeX transform ${tr0} -> ${tr1}`);
    } else console.log('boxes    no side handle on the LaTeX selection');
  }
}
// --only fitwidth --shots <dir>: a note with a portrait page then a landscape one: "fit to width"
// on each must fill the screen's width (the page's edges a few px from the screen's).
if (ONLY.has('fitwidth')) {
  await page.evaluate(async (note) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('OpenNote_Database'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction('notes', 'readwrite');
      tx.objectStore('notes').put({ ...note, id: 'doc_fit', title: 'Fit note', schemaVersion: 5, updatedAt: note.updatedAt + 5000,
        pages: [{ ...note.pages[0], strokes: note.pages[0].strokes.slice(0, 40) }],
        sheets: [{ id: 'sh_a', size: 'letter', orientation: 'portrait' }, { id: 'sh_b', size: 'letter', orientation: 'landscape' }, { id: 'sh_c', size: 'letter', orientation: 'portrait' }] });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, seedNote());
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.reload();
  await page.getByText('Fit note').first().click();
  await sleep(2000);
  const edges = () => page.evaluate(() => {
    const sc = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 200 && getComputedStyle(d).overflow === 'auto');
    if (!sc) return { error: 'no scroller', text: document.body.innerText.slice(0, 120) };
    const er = sc.getBoundingClientRect();
    const page0 = document.querySelector('.on-page');
    if (!page0) return { error: 'no page', title: document.title, text: document.body.innerText.slice(0, 80) };
    const papers = [...page0.children].filter((e) => e.className.includes('shadow-') && e.getBoundingClientRect().height > 200);
    if (!papers.length) return { error: 'no paper', n: page0.children.length };
    const mid = er.top + er.height / 3;
    const p = papers.find((e) => { const r = e.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; }) ?? papers[0];
    const r = p.getBoundingClientRect();
    return { left: Math.round(r.left - er.left), right: Math.round(er.right - r.right), width: Math.round(r.width), zoom: document.body.innerText.match(/(\d+)%/)?.[1] };
  });
  console.log(`fitwidth page 1 (portrait) on open: ${JSON.stringify(await edges())}`);
  // Scroll to the landscape page: fit to width follows it.
  await page.evaluate(() => { const sc = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 200 && getComputedStyle(d).overflow === 'auto'); sc.scrollTop += 1150; });
  await sleep(1500);
  console.log(`fitwidth page 2 (landscape) after scrolling: ${JSON.stringify(await edges())}`);
  // A pinch ending near the page's width snaps to it; a larger one keeps its zoom.
  await fingers([[260, 900], [560, 900]], [[250, 900], [570, 900]], 200);
  await sleep(1200);
  console.log(`fitwidth after a 1.07x pinch (snaps): ${JSON.stringify(await edges())}`);
  await fingers([[260, 900], [560, 900]], [[200, 900], [620, 900]], 300);
  await sleep(1200);
  console.log(`fitwidth after a 1.4x pinch (kept): ${JSON.stringify(await edges())}`);
  if (arg('shots')) await page.screenshot({ path: join(arg('shots'), 'fitwidth.png') });
}
// --only papershots --shots <dir>: the paper menu with any colour for the paper (spectrum open) and
// a pattern colour, then the page with them.
if (ONLY.has('papershots') && arg('shots')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.locator('button[title="Paper"]').first().click();
  await sleep(300);
  await page.locator('button[title="#EF4444"]').first().click();
  await page.locator('button[title^="Any colour"]').first().click();
  await sleep(300);
  const sq = await page.locator('.cursor-crosshair').first().boundingBox();
  await page.mouse.click(sq.x + sq.width * 0.3, sq.y + sq.height * 0.12);
  await sleep(600);
  await page.screenshot({ path: join(arg('shots'), 'paper-menu.png') });
  await page.locator('button[title="Paper"]').first().click();
  await sleep(600);
  const bg = await page.evaluate(() => { const p = [...document.querySelectorAll('.on-page > div')].find((e) => e.className.includes('shadow-')); return p && getComputedStyle(p).backgroundColor; });
  console.log(`papershots paper colour on the page: ${bg}`);
  await page.screenshot({ path: join(arg('shots'), 'paper-page.png') });
}
// --only inkcolors: a formula's colours from the ink (colorByInk.ts). Handwriting is made from the
// typeset formula with its symbols moved and resized at random (as handwriting is spaced unlike
// type), each in its own colour; the model's reply has every colour wrong. Every symbol must come
// back in its ink's colour.
if (ONLY.has('inkcolors')) {
  await reopen();
  await page.waitForFunction(() => window.__opennoteColorByInk);
  const out = await page.evaluate(() => {
    const { colorByInk, inkColors, katex } = window.__opennoteColorByInk;
    const Wh = '#F3F4F6', R = '#DC2626', G = '#16A34A', T = '#0D9488', O = '#F59E0B', P = '#9333EA', DG = '#14532D', B = '#2563EB';
    const tag = (k, t) => `{\\htmlClass{t t-${k}}{${t}}}`;
    // truth: the formula with each symbol tagged (k: index into cols); parts: container ink
    // (selector, colour, shape); reply: the model's answer (wrong colours, sometimes a symbol off);
    // want: the colours of the reply's glyphs in order, and of its parts.
    const cases = [
      {
        name: 'report example', sameAsTruth: true,
        truth: [['\\int', Wh], ['3', Wh], ['y', Wh], ['2', Wh, '^'], ['d', Wh], ['y', Wh], ['-', R], ['7', G], ['i', T], ['l', O], ['o', O], ['g', O], ['(', T], ['8', P], ['z', P], ['3', P, '^'], [')', DG]].map(([t, c, sup], k) => [`${sup ? '^' : ''}${tag(k, t)}`, c]),
        reply: '\\textcolor{#14532D}{\\int 3}\\textcolor{#F3F4F6}{y}^{\\textcolor{#14532D}{2}}\\textcolor{#14532D}{dy}\\textcolor{#F3F4F6}{-}\\textcolor{#DC2626}{7}\\textcolor{#16A34A}{i}\\textcolor{#F59E0B}{\\log}\\textcolor{#F3F4F6}{(}\\textcolor{#9333EA}{8}\\textcolor{#14532D}{z}^{\\textcolor{#9333EA}{3}}\\textcolor{#F3F4F6}{)}',
        want: [Wh, Wh, Wh, Wh, Wh, Wh, R, G, T, O, O, O, T, P, P, P, DG],
      },
      {
        name: 'fraction', sameAsTruth: true,
        truth: [[`\\frac{${tag(0, 'a')}${tag(1, '+')}${tag(2, 'b')}}{${tag(3, 'c')}}`], [tag(4, '=')], [tag(5, 'x')], [`^${tag(6, '2')}`]],
        cols: [R, Wh, G, B, Wh, O, T],
        parts: [['.frac-line', P, 'bar']],
        reply: '\\textcolor{#9333EA}{\\frac{a+b}{c}}=x^{2}',
        want: [R, Wh, G, B, Wh, O, T],
        wantParts: [['.frac-line', P]],
      },
      {
        name: 'root, three-stroke H', sameAsTruth: true,
        truth: [[`\\sqrt{${tag(0, 'x')}}`], [tag(1, '+')], [tag(2, 'H')]],
        cols: [G, Wh, B],
        parts: [['.sqrt', R, 'radical']],
        multi: { 2: 'H' },
        reply: '\\sqrt{x}+\\textcolor{#DC2626}{H}',
        want: [G, Wh, B],
        wantParts: [['.sqrt .hide-tail', R]],
      },
      {
        name: 'model dropped a symbol',
        truth: [['a', R], ['+', Wh], ['b', G], ['=', Wh], ['c', B], ['d', B]].map(([t, c], k) => [tag(k, t), c]),
        reply: 'a+b=c',
        want: [R, Wh, G, Wh, B],
      },
      {
        name: 'model added a symbol',
        truth: [['x', R], ['=', Wh], ['5', G]].map(([t, c], k) => [tag(k, t), c]),
        reply: 'x=5y',
        want: [R, Wh, G, G],
      },
    ];
    const host = document.createElement('div');
    Object.assign(host.style, { position: 'fixed', left: '0', top: '0', fontSize: '40px', whiteSpace: 'nowrap', background: '#1C1C1F', color: Wh });
    document.body.appendChild(host);
    const hex = (c) => '#' + c.match(/\d+/g).slice(0, 3).map((v) => (+v).toString(16).padStart(2, '0')).join('').toUpperCase();
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const report = [];
    for (const cs of cases) {
      const colOf = (k) => cs.cols ? cs.cols[k] : cs.truth[k][1];
      katex.render(cs.truth.map((t) => t[0]).join(''), host, { displayMode: true, trust: true, strict: 'ignore', output: 'html' });
      const nSyms = host.querySelectorAll('.t').length;
      const boxes = Array.from({ length: nSyms }, (_, k) => host.querySelector(`.t-${k}`).getBoundingClientRect());
      const partBoxes = (cs.parts ?? []).map(([sel, c, shape]) => [host.querySelector(sel).getBoundingClientRect(), c, shape]);
      const all = [...boxes, ...partBoxes.map((p) => p[0])];
      const x0 = Math.min(...all.map((b) => b.left)), Wd = Math.max(...all.map((b) => b.right)) - x0;
      let perfect = 0, wrongSyms = 0;
      const fails = [];
      for (let trial = 0; trial < 30; trial++) {
        const amp = 0.02 + (trial / 30) * 0.08, ph = rnd() * 6.28;
        const warp = (x) => x + amp * Wd * Math.sin(((x - x0) / Wd) * 6.28 * 1.3 + ph);
        const strokes = [];
        const line = (pts, c) => strokes.push({ id: 's' + strokes.length, tool: 'pen', color: c, width: 2, opacity: 1, points: pts.map(([x, y]) => ({ x, y, pressure: 0.5 })) });
        boxes.forEach((b, k) => {
          const sc = 0.75 + rnd() * 0.5, dy = (rnd() - 0.5) * 6;
          const bx0 = warp(b.left), bx1 = warp(b.right), w = (bx1 - bx0) * sc, h = b.height * 0.6 * sc;
          const cx = (bx0 + bx1) / 2, cy = (b.top + b.bottom) / 2 + dy;
          if (cs.multi?.[k] === 'H') {
            line([[cx - w / 2, cy - h / 2], [cx - w / 2, cy + h / 2]], colOf(k));
            line([[cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2]], colOf(k));
            line([[cx - w / 2, cy], [cx + w / 2, cy]], colOf(k));
            return;
          }
          line(Array.from({ length: 12 }, (_, i) => [cx - w / 2 + (w * i) / 11, cy - h / 2 + (i % 2 ? h * 0.8 : h * 0.2)]), colOf(k));
          if (cs.truth[k]?.[0]?.includes('{i}')) line([[cx, cy - h * 0.9], [cx + 1, cy - h * 0.9]], colOf(k));
        });
        for (const [b, c, shape] of partBoxes) {
          const l = warp(b.left), r = warp(b.right), my = (b.top + b.bottom) / 2;
          if (shape === 'bar') line([[l, my], [r, my]], c);
          else line([[l, my], [l + (r - l) * 0.04, b.bottom], [l + (r - l) * 0.1, b.top + 2], [r, b.top + 2]], c);
        }
        const xs = strokes.flatMap((s) => s.points.map((p) => p.x)), ys = strokes.flatMap((s) => s.points.map((p) => p.y));
        const bx = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
        const info = inkColors(strokes.sort(() => rnd() - 0.5), bx);
        const got = colorByInk(cs.reply, strokes, info);
        if (!got) { fails.push('null'); wrongSyms += cs.want.length; continue; }
        host.style.color = info.base;
        katex.render(got, host, { displayMode: true, strict: 'ignore', output: 'html' });
        const glyphs = readGlyphs();
        let want = cs.want;
        if (cs.sameAsTruth) {
          const saved = host.innerHTML;
          katex.render(cs.truth.map((t) => t[0]).join('').replace(/\\htmlClass\{t t-(\d+)\}/g, (_m, k) => `\\textcolor{${colOf(+k)}}`), host, { displayMode: true, strict: 'ignore', output: 'html' });
          want = readGlyphs();
          host.innerHTML = saved;
        }
        let bad = glyphs.filter((c, i) => c !== want[i]).length + Math.abs(glyphs.length - want.length);
        const partsGot = (cs.wantParts ?? []).map(([sel, c]) => { const el = host.querySelector(sel); const g = el ? hex(getComputedStyle(el).color) : 'none'; if (g !== c) bad++; return g; });
        if (!bad) perfect++;
        else { wrongSyms += bad; if (fails.length < 2) fails.push(`amp ${amp.toFixed(2)}: ${glyphs.join(' ')} want ${want.join(' ')} | parts ${partsGot.join(' ')} | ${got}`); }
      }
      report.push({ name: cs.name, perfect, trials: 30, wrongSyms, fails });
    }
    host.remove();
    return report;
    /** The rendered glyphs' colours in reading order (columns left to right, top to bottom in each). */
    function readGlyphs() {
        const gl = [];
        const tw = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        const rg = document.createRange();
        while (tw.nextNode()) {
          const t = tw.currentNode;
          for (let i = 0; i < t.length; i++) {
            if (!t.data[i].trim()) continue;
            rg.setStart(t, i); rg.setEnd(t, i + 1);
            const r = rg.getBoundingClientRect();
            if (r.width > 0.5) gl.push({ r, c: hex(getComputedStyle(t.parentElement).color) });
          }
        }
        gl.sort((a, b) => a.r.left - b.r.left);
        const cols = [];
        for (const g of gl) {
          const col = cols[cols.length - 1];
          if (col && Math.min(col.x1, g.r.right) - Math.max(col.x0, g.r.left) > 0.5 * Math.min(g.r.width, col.x1 - col.x0)) { col.items.push(g); col.x0 = Math.min(col.x0, g.r.left); col.x1 = Math.max(col.x1, g.r.right); }
          else cols.push({ x0: g.r.left, x1: g.r.right, items: [g] });
        }
        return cols.flatMap((c) => c.items.sort((a, b) => a.r.top - b.r.top).map((g) => g.c));
    }
  });
  for (const r of out) {
    console.log(`inkcolors ${r.name.padEnd(24)} ${r.perfect}/${r.trials} fully right, ${r.wrongSyms} wrong`);
    for (const f of r.fails) console.log(`inkcolors     ${f}`);
  }
}
// --only glinfo: which WebGL renderer the benchmark's browser has.
if (ONLY.has('glinfo')) {
  console.log('glinfo  ', await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const x = gl?.getExtension('WEBGL_debug_renderer_info'); return gl ? gl.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : 'no webgl2'; }));
}
// --only glwarm: how long after opening the note the GPU ink of a pinch is ready (usePinchInk's
// preparation, at the benchmark's CPU slowdown).
if (ONLY.has('glwarm')) {
  await reopen();
  const t0 = Date.now();
  await page.waitForFunction(() => (window.__opennoteGlInk?.shared()?.pieces ?? 0) > 0, null, { timeout: 120000, polling: 100 }).catch(() => null);
  console.log(`glwarm   ready ${((Date.now() - t0) / 1000 + 2.5).toFixed(1)} s after opening (${CPU}x slower CPU), ${await page.evaluate(() => window.__opennoteGlInk?.shared()?.pieces ?? 'none')} pieces`);
}
// Not in the default run: --only glcompare, every kind of stroke drawn by the GPU renderer of a
// pinch (glInk.ts) and by the canvas, at three scales: how far apart they are (mean difference of
// the composited pixels, 0-255, and the share of pixels off by more than 64).
if (ONLY.has('glcompare')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.waitForFunction(() => window.__opennoteGlInk);
  const out = await page.evaluate(() => {
    const { GlInk, drawStrokes } = window.__opennoteGlInk;
    const pts = (f, n = 60) => Array.from({ length: n }, (_, i) => { const t = i / (n - 1); const [x, y, p] = f(t); return { x, y, pressure: p ?? 0.5, t: i * 8 }; });
    const wave = (y0, amp = 12) => (t) => [20 + t * 160, y0 + Math.sin(t * 9) * amp, 0.25 + 0.75 * Math.sin(t * 3.1) ** 2];
    let n = 0;
    const S = (o) => ({ id: 's' + n++, tool: 'pen', color: '#1f2937', width: 2, opacity: 1, penStyle: 'fountain', ...o });
    const rect = (x, y, w, h) => [{ x, y, pressure: 0.5 }, { x: x + w, y, pressure: 0.5 }, { x: x + w, y: y + h, pressure: 0.5 }, { x, y: y + h, pressure: 0.5 }];
    const cases = {
      fountain: [S({ points: pts(wave(40)), modeled: 'proportional' })],
      fountainRaw: [S({ points: pts(wave(40)) })],
      ballpoint: [S({ penStyle: 'ballpoint', points: pts(wave(40)) })],
      highlighter: [S({ tool: 'highlighter', color: '#facc15', width: 3, penStyle: 'ballpoint', points: pts(wave(40, 4)) })],
      translucent: [S({ penStyle: 'ballpoint', width: 4, opacity: 0.5, points: pts((t) => [40 + 120 * Math.cos(t * 6.28 * 1.5), 40 + 25 * Math.sin(t * 6.28 * 1.5)], 80) })],
      dashed: [S({ isShape: true, lineStyle: 'dashed', points: pts((t) => [20 + t * 160, 20 + t * 40], 2) })],
      dotted: [S({ isShape: true, lineStyle: 'dotted', points: pts((t) => [20 + t * 160, 60 - t * 40], 2) })],
      arrow: [S({ isShape: true, arrow: true, width: 3, points: pts((t) => [20 + t * 150, 40], 2) })],
      solidFill: [S({ isShape: true, closed: true, fill: 'solid', color: '#2563eb', points: rect(30, 10, 120, 60) })],
      hatch: [S({ isShape: true, closed: true, fill: 'crosshatch', color: '#dc2626', points: rect(30, 10, 120, 60) })],
      hole: [S({ tool: 'highlighter', color: '#22c55e', width: 6, penStyle: 'ballpoint', points: pts((t) => [10 + t * 180, 40], 2) }), S({ isShape: true, closed: true, fill: 'hole', points: rect(60, 15, 60, 50) })],
      curve: [S({ isShape: true, shapeKind: 'curve', closed: true, fill: 'solid', color: '#7c3aed', points: [{ x: 30, y: 40, pressure: 0.5 }, { x: 100, y: 10, pressure: 0.5 }, { x: 170, y: 40, pressure: 0.5 }, { x: 100, y: 70, pressure: 0.5 }] })],
      point: [S({ isShape: true, shapeKind: 'point', width: 3, points: [{ x: 100, y: 40, pressure: 0.5 }] })],
    };
    const gl = GlInk.create();
    if (!gl) return { error: 'no webgl2' };
    const res = {};
    for (const [name, strokes] of Object.entries(cases)) {
      res[name] = [];
      for (const k of [1.5, 4, 10]) {
        const W = Math.round(200 * k), H = Math.round(80 * k);
        const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
        const ctx = c2.getContext('2d'); ctx.setTransform(k, 0, 0, k, 0, 0); drawStrokes(ctx, strokes, {});
        gl.setStrokes(strokes, false); gl.resize(W, H); gl.draw({ scale: k, ox: 0, oy: 0 });
        const c3 = document.createElement('canvas'); c3.width = W; c3.height = H;
        const x3 = c3.getContext('2d'); x3.drawImage(gl.canvas, 0, 0);
        const a = ctx.getImageData(0, 0, W, H).data, b = x3.getImageData(0, 0, W, H).data;
        let sum = 0, big = 0, inked = 0;
        for (let i = 0; i < a.length; i += 4) {
          // Composited over white.
          let d = 0;
          for (let ch = 0; ch < 3; ch++) {
            const va = 255 - (a[i + 3] / 255) * (255 - a[i + ch]), vb = 255 - (b[i + 3] / 255) * (255 - b[i + ch]);
            d = Math.max(d, Math.abs(va - vb));
          }
          if (a[i + 3] > 0 || b[i + 3] > 0) { inked++; sum += d; if (d > 64) big++; }
        }
        res[name].push(`x${k}: ${(sum / Math.max(1, inked)).toFixed(1)} / ${((100 * big) / Math.max(1, inked)).toFixed(1)}%`);
      }
    }
    return res;
  });
  for (const [k, v] of Object.entries(out)) console.log(`glcompare ${k.padEnd(12)} ${Array.isArray(v) ? v.join('   ') : v}`);
}
// Not in the default run: --only probe, the frame-rate test of Settings > Diagnostics on the open note.
if (ONLY.has('probe')) {
  await reopen();
  await page.waitForFunction(() => window.__opennoteFrameProbe);
  const r = await page.evaluate(() => window.__opennoteFrameProbe.run());
  console.log(`probe    ${Object.entries(r.phases).map(([k, v]) => `${k} ${v ? `${v.fps} fps (p50 ${v.p50} ms)` : '-'}`).join('  ')}  (${CPU}x slower CPU)`);
}
// Not in the default run (run it alone: it installs a stand-in shell): --only nativepinch, the
// messages the iOS shell's pinch snapshot gets (nativePinch.ts), and where its last transform puts a
// page against where the page really is once drawn at the new zoom (they must match: no jump when
// the snapshot goes).
if (ONLY.has('nativepinch')) {
  await page.addInitScript(() => {
    window.__pinchMsgs = [];
    // Low Power Mode: the shell draws the pinch (useViewport, shellDrawsPinch).
    window.OpenNoteNative = { platform: 'ios', version: 'bench', lowPower: true };
    // The page where it is when the snapshot is taken ('b').
    const sheet = () => { const r = document.querySelector('[data-ink-key]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; };
    window.webkit = { messageHandlers: { opennotePinch: { postMessage: (m) => { if (m[0] === 'b') window.__pinchAt = sheet(); window.__pinchMsgs.push([performance.now(), m]); } } } };
  });
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const sheet = () => page.evaluate(() => { const r = document.querySelector('[data-ink-key]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; });
  for (const [a, b] of [[[[360, 640], [460, 640]], [[420, 420], [760, 520]]], [[[300, 600], [520, 600]], [[380, 700], [440, 700]]]]) {
    await page.evaluate(() => (window.__pinchMsgs = []));
    await fingers(a, b, 500, false);
    await touch('touchEnd', []);
    await sleep(1200);
    const after = await sheet();
    const msgs = await page.evaluate(() => window.__pinchMsgs);
    const before = await page.evaluate(() => window.__pinchAt);
    const kinds = msgs.map(([, m]) => m[0]).join('');
    const B = msgs.find(([, m]) => m[0] === 'b')[1].split(',').map(Number);
    const M = msgs.filter(([, m]) => m[0] === 'm').pop()[1].split(',').map(Number);
    const [ax, ay, c0x, c0y] = [B[2], B[3], B[6], B[7]], [k, cx, cy] = [M[2], M[3], M[4]];
    // The snapshot maps a point p (relative to the area) to c + k (p - c0).
    const px = ax + cx + k * (before.x - ax - c0x), py = ay + cy + k * (before.y - ay - c0y);
    const E = msgs.find(([, m]) => m[0] === 'e'), lastMove = msgs.filter(([, m]) => m[0] === 'm').pop()[0];
    const e = E?.[1].split(',').map(Number) ?? [];
    const settled = e.length >= 5 ? `, settles at (${(ax + e[3] + e[2] * (before.x - ax - c0x)).toFixed(1)}, ${(ay + e[4] + e[2] * (before.y - ay - c0y)).toFixed(1)}) w ${(before.w * e[2]).toFixed(1)}` : '';
    console.log(`nativepinch ${kinds[0]} m x${(kinds.match(/m/g) ?? []).length} ${kinds.slice(-1)}  fingers leave the page at (${px.toFixed(1)}, ${py.toFixed(1)}) w ${(before.w * k).toFixed(1)}${settled}; drawn at (${after.x.toFixed(1)}, ${after.y.toFixed(1)}) w ${after.w.toFixed(1)}  end ${E ? (E[0] - lastMove).toFixed(0) + ' ms after the last move' : 'MISSING'}`);
  }
}
// Not in the default run: --only panpinch --shots <dir>: two fingers zoom in while moving across
// the screen; the page must be where the fingers left it, while they move and after they lift.
if (ONLY.has('panpinch') && arg('shots')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await fingers([[360, 640], [460, 640]], [[420, 420], [760, 520]], 500, false);
  await sleep(300);
  await page.screenshot({ path: join(arg('shots'), 'panpinch-moving.png'), clip: { x: 300, y: 300, width: 400, height: 300 } });
  await touch('touchEnd', []);
  await sleep(1200);
  await page.screenshot({ path: join(arg('shots'), 'panpinch-after.png'), clip: { x: 300, y: 300, width: 400, height: 300 } });
  console.log(`panpinch zoom ${await page.evaluate(() => document.body.innerText.match(/(\d+)%/)?.[1])}%`);
}
// Not in the default run: --only closeup --shots <dir> zooms to 500% with the buttons (no pinch) and
// saves the ink at full resolution, to judge how handwriting looks zoomed in.
if (ONLY.has('closeup') && arg('shots')) {
  // One recording at its real size (page px as written on the iPad), in a note of its own.
  const file = arg('rec', 'pen-20261013-150111-114strokes.json');
  const rec = JSON.parse(readFileSync(join(recDir, file), 'utf8'));
  const strokes = rec.strokes.filter((st) => st.tool === 'pen').map((st, i) => ({
    id: `cu_${i}`, tool: 'pen', color: '#111827', width: st.width || 1.6, opacity: 1, penStyle: st.penStyle || 'fountain', createdAt: 1700000000000 + i,
    points: st.samples.map((p) => ({ x: p[0], y: p[1], pressure: p[3], t: p[2] })),
  }));
  const now = Date.now();
  await page.evaluate(async (note) => {
    const db = await new Promise((res) => { const r = indexedDB.open('OpenNote_Database'); r.onsuccess = () => res(r.result); });
    await new Promise((res) => { const tx = db.transaction('notes', 'readwrite'); tx.objectStore('notes').put(note); tx.oncomplete = res; });
    db.close();
  }, { id: 'doc_closeup', title: 'Closeup note', createdAt: now, updatedAt: now + 1e6, paperStyle: 'blank', paperColor: 'white', schemaVersion: 3,
       pages: [{ id: 'page_cu', pageNumber: 1, strokes, latexBlocks: [], textBlocks: [], imageBlocks: [] }] });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.reload();
  await page.getByText('Closeup note').first().click();
  await sleep(2500);
  // Centre the view on the writing, at a few zoom levels (canvas ink below about 250%, vector above).
  const xs = strokes.flatMap((st) => st.points.map((p) => p.x)), ys = strokes.flatMap((st) => st.points.map((p) => p.y));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = Math.min(...ys) + 60;
  const centre = () => page.evaluate(([cx, cy]) => {
    const el = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 500 && getComputedStyle(d).overflow === 'auto');
    const outer = el.firstElementChild;
    const z = parseFloat(document.body.innerText.match(/(\d+)%/)[1]) / 100;
    el.scrollLeft = outer.offsetLeft + (16 + cx) * z - el.clientWidth / 2;
    el.scrollTop = outer.offsetTop + (16 + cy) * z - el.clientHeight / 2;
  }, [cx, cy]);
  let steps = 0;
  // --steps: zoom-in steps (x1.25 each from fitting the width) for each close-up.
  for (const target of arg('steps', '3,4,5,12').split(',').map(Number)) {
    while (steps < target) {
      await page.keyboard.press('Control+Equal');
      await sleep(150);
      steps++;
    }
    await sleep(600);
    await centre();
    await sleep(1500);
    const z = await page.evaluate(() => document.body.innerText.match(/(\d+)%/)?.[1]);
    console.log(`closeup  zoom ${z}%, ${strokes.length} strokes from ${file}`);
    await page.screenshot({ path: join(arg('shots'), `closeup-${z}.png`), clip: { x: 0, y: 250, width: 820, height: 800 } });
  }
  // Zoomed in, the committed ink is a sharp canvas over the view (SharpInk) with a hole in the page
  // canvases under it. Scrolled: right away the page canvases show the ink there (never blank),
  // once the view rests it is sharp again.
  const sharpState = () => page.evaluate(() => {
    const sharp = [...document.querySelectorAll('canvas')].filter((c) => c.style.display !== 'none' && c.className.includes('absolute') && c.parentElement?.classList.contains('on-page'));
    const holes = [...document.querySelectorAll("[data-ink-key]")].filter((d) => d.style.visibility === "hidden").length;
    return sharp.map((c) => `${c.width}x${c.height} at ${c.style.left},${c.style.top} size ${c.style.width}`).join(' ') + ` | page canvases hidden ${holes}`;
  });
  console.log(`closeup  sharp canvas: ${await sharpState()}`);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 500 && getComputedStyle(d).overflow === 'auto');
    el.scrollTop += 700;
    el.scrollLeft -= 300;
  });
  await sleep(30);
  await page.screenshot({ path: join(arg('shots'), 'closeup-scrolled-now.png'), clip: { x: 0, y: 250, width: 820, height: 800 } });
  await sleep(800);
  await page.screenshot({ path: join(arg('shots'), 'closeup-scrolled-rested.png'), clip: { x: 0, y: 250, width: 820, height: 800 } });
  console.log(`closeup  after scrolling: ${await sharpState()}`);
}
// Not in the default run: --only canvasmem reports the canvases' backing memory at a few zooms
// (zoomed with the buttons, view on the first page). WebKit gives a canvas a GPU backing only up to
// 5120x2880 px, and a 4 GB iPad runs short of that memory long before a newer one.
if (ONLY.has('canvasmem')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const report = () => page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].filter((c) => c.width * c.height > 1);
    const px = cs.map((c) => c.width * c.height);
    const mb = (n) => ((n * 4) / 1048576).toFixed(0);
    const z = document.body.innerText.match(/(\d+)%/)?.[1];
    const big = cs.filter((c) => c.width * c.height > 5120 * 2880).map((c) => `${c.width}x${c.height} (css ${c.style.width} x ${c.style.height}, ${c.parentElement?.dataset.inkKey ? 'page tile' : c.className || 'canvas'})`);
    return `zoom ${z}%: ${cs.length} canvases, ${mb(px.reduce((a, b) => a + b, 0))} MB, largest ${mb(Math.max(0, ...px))} MB, ${big.length} over the GPU limit${big.length ? ': ' + big.join(', ') : ''}`;
  });
  console.log(`canvasmem ${await report()}`);
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press('Control+Equal');
    await sleep(900);
    console.log(`canvasmem ${await report()}`);
  }
}
// --only resize8: lassoes handwriting, drags the right side handle, then the top-left corner: the
// side must change only the width, the corner both, with the opposite corner staying put.
if (ONLY.has('resize8')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.locator('button[title^="Lasso"]').click();
  await sleep(300);
  const loop = Array.from({ length: 60 }, (_, i) => {
    const a = (i / 59) * Math.PI * 2;
    return [300 + Math.cos(a) * 120, 470 + Math.sin(a) * 45];
  });
  await mouse('mousePressed', loop[0][0], loop[0][1]);
  for (const [x, y] of loop.slice(1)) {
    await mouse('mouseMoved', x, y);
    await sleep(8);
  }
  await mouse('mouseReleased', loop[59][0], loop[59][1]);
  await sleep(800);
  const boxOf = () => page.locator('[data-selection-box]').first().boundingBox();
  const drag = async (handle, ddx, ddy) => {
    const h = await page.locator(`[data-resize="${handle}"]`).boundingBox();
    if (!h) return false;
    const hx = h.x + h.width / 2, hy = h.y + h.height / 2;
    await mouse('mousePressed', hx, hy);
    for (let i = 1; i <= 20; i++) {
      await mouse('mouseMoved', hx + (ddx * i) / 20, hy + (ddy * i) / 20);
      await sleep(10);
    }
    await mouse('mouseReleased', hx + ddx, hy + ddy);
    await sleep(900);
    return true;
  };
  const r = (b) => (b ? `x ${b.x.toFixed(0)} y ${b.y.toFixed(0)} w ${b.width.toFixed(0)} h ${b.height.toFixed(0)}` : 'none');
  const b0 = await boxOf();
  const ok1 = await drag('1,0', 80, 40);
  const b1 = await boxOf();
  const ok2 = await drag('-1,-1', -40, -30);
  const b2 = await boxOf();
  console.log(`resize8  start ${r(b0)}`);
  console.log(`resize8  right side +80 (and 40 down): ${ok1 ? r(b1) : 'no handle'}`);
  console.log(`resize8  top-left corner -40,-30: ${ok2 ? r(b2) : 'no handle'}`);
  if (arg('shots')) await page.screenshot({ path: join(arg('shots'), 'resize8.png'), clip: { x: 0, y: 300, width: 820, height: 420 } });
}
// Not in the default run: --only selshots --shots <dir> lassoes some handwriting, enlarges the
// selection with its corner handle, then zooms in: the selected ink must stay as sharp as the rest.
if (ONLY.has('selshots') && arg('shots')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.locator('button[title^="Lasso"]').click();
  await sleep(300);
  const loop = Array.from({ length: 60 }, (_, i) => {
    const a = (i / 59) * Math.PI * 2;
    return [300 + Math.cos(a) * 120, 470 + Math.sin(a) * 45];
  });
  await mouse('mousePressed', loop[0][0], loop[0][1]);
  for (const [x, y] of loop.slice(1)) {
    await mouse('mouseMoved', x, y);
    await sleep(8);
  }
  await mouse('mouseReleased', loop[59][0], loop[59][1]);
  await sleep(800);
  const h = await page.locator('[data-resize="1,1"]').boundingBox();
  if (!h) console.log('selshots (no resize handle)');
  else {
    const hx = h.x + h.width / 2, hy = h.y + h.height / 2;
    await mouse('mousePressed', hx, hy);
    for (let i = 1; i <= 30; i++) {
      await mouse('mouseMoved', hx + i * 7, hy + i * 3);
      await sleep(10);
    }
    await mouse('mouseReleased', hx + 210, hy + 90);
    await sleep(1200);
    await page.screenshot({ path: join(arg('shots'), 'sel-100.png'), clip: { x: 0, y: 330, width: 820, height: 420 } });
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Control+Equal');
      await sleep(200);
    }
    await sleep(1500);
    const z = await page.evaluate(() => document.body.innerText.match(/(\d+)%/)?.[1]);
    await page.screenshot({ path: join(arg('shots'), 'sel-zoomed.png') });
    console.log(`selshots enlarged and zoomed to ${z}%`);
  }
}
// Not in the default run: --only stress zooms in and out and scrolls around 40 times, then reports
// canvases, canvas memory, JS heap and page errors: nothing may pile up.
if (ONLY.has('stress')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const snap = () => page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].filter((c) => c.width * c.height > 1);
    return { canvases: cs.length, mb: Math.round(cs.reduce((a, c) => a + c.width * c.height * 4, 0) / 1048576), heap: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576) };
  });
  const scroller = () => page.evaluate((f) => {
    const el = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 500 && getComputedStyle(d).overflow === 'auto');
    el.scrollTop = f * (el.scrollHeight - el.clientHeight);
    el.scrollLeft = (f * 7919 % 1) * (el.scrollWidth - el.clientWidth);
  }, Math.random());
  const before = await snap();
  for (let i = 0; i < 40; i++) {
    const steps = 2 + (i % 6);
    for (let k = 0; k < steps; k++) await page.keyboard.press('Control+Equal');
    await sleep(60 + (i % 3) * 120);
    await scroller();
    await sleep(40);
    await scroller();
    await sleep(150);
    for (let k = 0; k < steps; k++) await page.keyboard.press('Control+Minus');
    await sleep(60);
  }
  // Back where it started, so both snapshots see the same pages.
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 500 && getComputedStyle(d).overflow === 'auto');
    el.scrollTop = 0;
    el.scrollLeft = 0;
  });
  await sleep(2000);
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  await sleep(500);
  const after = await snap();
  console.log(`stress    before ${JSON.stringify(before)}  after ${JSON.stringify(after)}  page errors ${errors.length ? errors.join(' | ') : 'none'}`);
}
// Not in the default run: --only dragshots --shots <dir> zooms in, lassoes some handwriting and
// enlarges it with the corner handle: saved while the finger is still down and after it lifts.
if (ONLY.has('dragshots') && arg('shots')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Control+Equal');
    await sleep(150);
  }
  await sleep(1500);
  await page.locator('button[title^="Lasso"]').click();
  await sleep(300);
  const loop = Array.from({ length: 60 }, (_, i) => {
    const a = (i / 59) * Math.PI * 2;
    return [330 + Math.cos(a) * 150, 600 + Math.sin(a) * 60];
  });
  await mouse('mousePressed', loop[0][0], loop[0][1]);
  for (const [x, y] of loop.slice(1)) {
    await mouse('mouseMoved', x, y);
    await sleep(8);
  }
  await mouse('mouseReleased', loop[59][0], loop[59][1]);
  await sleep(800);
  const h = await page.locator('[data-resize="1,1"]').boundingBox();
  if (h) {
    const hx = h.x + h.width / 2, hy = h.y + h.height / 2;
    await mouse('mousePressed', hx, hy);
    for (let i = 1; i <= 20; i++) {
      await mouse('mouseMoved', hx + i * 6, hy + i * 3);
      await sleep(16);
    }
    await sleep(300);
    await page.screenshot({ path: join(arg('shots'), 'drag-down.png'), clip: { x: 160, y: 480, width: 500, height: 300 } });
    await mouse('mouseReleased', hx + 120, hy + 60);
    await sleep(800);
    await page.screenshot({ path: join(arg('shots'), 'drag-up.png'), clip: { x: 160, y: 480, width: 500, height: 300 } });
  }
  console.log(`dragshots zoom ${await page.evaluate(() => document.body.innerText.match(/(\d+)%/)?.[1])}%${h ? '' : ' (no handle)'}`);
}
// --only tapshots [--shots <dir>]: a selection held down (drawn by the GPU while held) and after it
// is let go (the page's ink), at 100% and zoomed in: the ink must not change size or place.
if (ONLY.has('tapshots')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  /** Bounding box of the dark ink (not the glow) in a screenshot of `clip`. */
  const inkBox = async (clip) => {
    const b64 = (await page.screenshot({ clip })).toString('base64');
    return page.evaluate(async (src) => {
      const im = new Image(); im.src = 'data:image/png;base64,' + src; await im.decode();
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const x = c.getContext('2d'); x.drawImage(im, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      // Ink coverage (darkness of the red channel: the glow is blue, the ink near black), its total and centre.
      let sum = 0, sx = 0, sy = 0;
      for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, 200 - d[i]) / 200; if (v > 0.05) { const px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width); sum += v; sx += v * px; sy += v * py; } }
      return { ink: Math.round(sum), cx: +(sx / sum).toFixed(2), cy: +(sy / sum).toFixed(2) };
    }, b64);
  };
  for (const steps of (arg("steps") ?? "0,4").split(",").map(Number)) {
    for (let i = 0; i < steps; i++) { await page.keyboard.press('Control+Equal'); await sleep(150); }
    await sleep(1500);
    await page.locator('button[title^="Lasso"]').click();
    await sleep(300);
    const loop = Array.from({ length: 60 }, (_, i) => { const a = (i / 59) * Math.PI * 2; return [330 + Math.cos(a) * 150, 600 + Math.sin(a) * 60]; });
    await mouse('mousePressed', loop[0][0], loop[0][1]);
    for (const [x, y] of loop.slice(1)) { await mouse('mouseMoved', x, y); await sleep(8); }
    await mouse('mouseReleased', loop[59][0], loop[59][1]);
    await sleep(800);
    const clip = { x: 120, y: 480, width: 420, height: 240 };
    const rest = await inkBox(clip);
    await mouse('mousePressed', 330, 600);
    await sleep(600);
    const held = await inkBox(clip);
    if (arg('shots')) await page.screenshot({ path: join(arg('shots'), `tap-held-${steps}.png`), clip });
    await mouse('mouseReleased', 330, 600);
    await sleep(800);
    const after = await inkBox(clip);
    if (arg('shots')) await page.screenshot({ path: join(arg('shots'), `tap-after-${steps}.png`), clip });
    const zoom = await page.evaluate(() => document.body.innerText.match(/(\d+)%/)?.[1]);
    console.log(`tapshots ${zoom}%  selected ${JSON.stringify(rest)}  held ${JSON.stringify(held)}  after ${JSON.stringify(after)}`);
    const geo = await page.evaluate(() => JSON.parse(localStorage.getItem('opennote_crashlog_v1') || '{}').current?.crumbs.filter((c) => c.kind === 'gl-geometry').slice(-1));
    console.log(`tapshots   crash log: ${JSON.stringify(geo)}`);
    await page.keyboard.press('Escape');
    await sleep(300);
  }
}
// Not in the default run: --only liveshots --shots <dir> writes a stroke zoomed in and saves it
// while the pen is down (the live ink) and after it lifts (the finished ink): they must look the same.
if (ONLY.has('liveshots') && arg('shots')) {
  await reopen();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Control+Equal');
    await sleep(150);
  }
  await sleep(1500);
  const z = await page.evaluate(() => document.body.innerText.match(/(\d+)%/)?.[1]);
  // A loop with samples about 6 screen px apart (a quick stroke at 120 Hz).
  const pts = Array.from({ length: 70 }, (_, i) => {
    const a = (i / 69) * Math.PI * 3.2;
    return [300 + Math.cos(a) * 140 + i * 2, 640 + Math.sin(a) * 90];
  });
  await mouse('mousePressed', pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) {
    await mouse('mouseMoved', x, y, 0.4 + 0.3 * Math.sin(x / 40));
    await sleep(8);
  }
  await sleep(300);
  await page.screenshot({ path: join(arg('shots'), 'live-down.png'), clip: { x: 120, y: 520, width: 480, height: 260 } });
  await mouse('mouseReleased', pts[pts.length - 1][0], pts[pts.length - 1][1]);
  await sleep(600);
  await page.screenshot({ path: join(arg('shots'), 'live-up.png'), clip: { x: 120, y: 520, width: 480, height: 260 } });
  console.log(`liveshots zoom ${z}%`);
}
// Not in the default run: --only pull checks that one finger pulling past the end adds a page.
if (ONLY.has('pull')) {
  await reopen();
  const count = () => page.evaluate(() => document.body.innerText.match(/\d+\s*\/\s*(\d+)/)?.[1]);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) => d.scrollHeight > d.clientHeight + 500 && getComputedStyle(d).overflow === 'auto');
    el.scrollTop = el.scrollHeight;
  });
  await sleep(500);
  const before = await count();
  await fingers([[410, 1000]], [[410, 600]], 600);
  await sleep(800);
  console.log(`pull     pages ${before} -> ${await count()}`);
}
if (ONLY.has('lasso')) {
  await reopen();
  await page.locator('button[title^="Lasso"]').click();
  await page.waitForTimeout(300);
  // A loop around a block of handwriting near the top of the first page.
  const loop = Array.from({ length: 60 }, (_, i) => {
    const a = (i / 59) * Math.PI * 2;
    return [410 + Math.cos(a) * 300, 520 + Math.sin(a) * 170];
  });
  await mouse('mousePressed', loop[0][0], loop[0][1]);
  for (const [x, y] of loop.slice(1)) {
    await mouse('mouseMoved', x, y);
    await sleep(8);
  }
  await mouse('mouseReleased', loop[59][0], loop[59][1]);
  await page.waitForTimeout(800);
  await report('lasso', async () => {
    // Drag the selection around and back (pen on the selection), twice.
    for (let r = 0; r < 2; r++) {
      await mouse('mousePressed', 410, 520);
      for (let i = 1; i <= 60; i++) {
        await mouse('mouseMoved', 410 + Math.sin(i / 10) * 150, 520 + i * 4);
        await sleep(8);
      }
      await mouse('mouseReleased', 410, 760);
      await sleep(900);
      await page.keyboard.press('Control+z');
      await sleep(600);
    }
  });
}
if (ONLY.has('pages')) {
  await reopen();
  await page.locator('button[title="Pages"]').click();
  await page.waitForTimeout(1500);
  const grip = page.locator('span[title="Drag to move"]').first();
  const box = await grip.boundingBox();
  if (!box) console.log('pages    (no page manager grip found)');
  else {
    const gx = box.x + box.width / 2, gy = box.y + box.height / 2;
    // The panel open, nothing touched: what it costs by itself.
    await report('pg idle', () => sleep(4000));

    await report('pages', async () => {
      for (let r = 0; r < 2; r++) {
        await fingers([[gx, gy]], [[gx + 20, gy + 700]], 1000, false);
        await sleep(400);
        await touch('touchEnd', []);
        await sleep(900);
      }
    });

  }
}
if (ONLY.has('pen') || ONLY.has('scroll')) await reopen();

// Pen: write a few lines of recorded strokes into the middle of the screen.
if (ONLY.has('pen')) {
await start();
const t0 = Date.now();
let wrote = 0;
await traced('pen', () => profiled('pen', async () => {
for (const s of recorded.slice(0, Number(arg('strokes', 40)))) {
  const xs = s.samples.map((p) => p[0]), ys = s.samples.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const ox = 120 + (wrote % 8) * 75, oy = 420 + Math.floor(wrote / 8) * 60;
  const k = Math.min(1, 40 / Math.max(1, Math.max(...ys) - minY));
  const p0 = s.samples[0];
  await mouse('mousePressed', ox + (p0[0] - minX) * k, oy + (p0[1] - minY) * k, p0[3] || 0.5);
  const begin = Date.now();
  for (const p of s.samples.slice(1)) {
    const wait = begin + p[2] - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await mouse('mouseMoved', ox + (p[0] - minX) * k, oy + (p[1] - minY) * k, p[3] || 0.5);
  }
  const pl = s.samples[s.samples.length - 1];
  await mouse('mouseReleased', ox + (pl[0] - minX) * k, oy + (pl[1] - minY) * k, 0);
  await new Promise((r) => setTimeout(r, 120));
  wrote++;
}
}));
const pen = await stop();
frameStats('pen', pen.frames);
console.log(`pen      input lag p50 ${f1(pct(pen.lags, 0.5))} p95 ${f1(pct(pen.lags, 0.95))} max ${f1(Math.max(...pen.lags))} ms (event to next frame), ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// Scroll: wheel scrolling down through the note and back, twice (first view of the pages, then
// with their ink already modelled).
await page.mouse.move(410, 600);
for (const pass of ONLY.has('scroll') ? ['scroll 1', 'scroll 2'] : []) {
  await start();
  await (pass === 'scroll 2' ? (f) => traced(pass, f) : (f) => f())(() => profiled(pass, async () => {
    for (let i = 0; i < 60; i++) {
      await page.mouse.wheel(0, i < 30 ? 120 : -120);
      await page.waitForTimeout(16);
      // --shots <dir>: screenshots at the deepest point and back at the top (ink must be shown).
      if (arg('shots') && pass === 'scroll 1' && i === 29) await page.waitForTimeout(400), await page.screenshot({ path: join(arg('shots'), 'deep.png') });
    }
    await page.waitForTimeout(500);
    if (arg('shots') && pass === 'scroll 1') await page.screenshot({ path: join(arg('shots'), 'top.png') });
  }));
  frameStats(pass, (await stop()).frames);
}

// With --native: the shell's native ink messages while writing (each stroke's "b" and its "e" by id).
if (process.argv.includes('--native') && ONLY.has('pen')) {
  const msgs = await page.evaluate(() => window.__inkMsgs ?? []);
  const begun = new Set(msgs.filter((m) => m.startsWith('b:')).map((m) => m.slice(2)));
  const ended = new Set(msgs.filter((m) => m.startsWith('e:')).map((m) => m.slice(2)));
  const open = [...begun].filter((id) => !ended.has(id));
  console.log(`nativeink strokes begun ${begun.size}, ended by id ${ended.size}, never ended: ${open.length ? open.join(' ') : 'none'}`);
}
await browser.close();
cleanup();
process.exit(0);
