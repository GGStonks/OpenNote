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
  return {
    id: 'doc_bench', title: 'Bench note', createdAt: now, updatedAt: now, paperStyle: 'ruled', paperColor: 'white', schemaVersion: 3,
    pages: [{ id: 'page_bench', pageNumber: 1, strokes, latexBlocks: [], textBlocks: [], imageBlocks: [] }],
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

const browser = await chromium.launch({ executablePath, headless: !HEADED, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
// --dpr: the screen's density (2 = iPad; Android tablets are often 2.6-3.5).
const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: Number(arg('dpr', 2)), hasTouch: true });
// --native: as in the apps, a native ink bridge is present (a stand-in that only takes the messages),
// so the page leaves the live stroke to it (nativeInk.ts).
if (process.argv.includes('--native')) await ctx.addInitScript(() => { window.OpenNoteInk = { post() {} }; });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
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

await browser.close();
cleanup();
process.exit(0);
