/**
 * UI performance on a slow device, in headless Chromium (Playwright's build).
 *
 * Seeds a note of real handwriting (bench/recordings) over several pages, opens it on an iPad Air
 * sized screen (820x1180 @2x) with the CPU slowed down (default 4x, a mid-range tablet), then:
 *
 *   pen     replays recorded pen strokes as real input (CDP pen events, 240 Hz like the Pencil)
 *           on the page in view, and reports frame times and input lag: from a pen event to the
 *           frame that showed it
 *   scroll  scrolls through the note, and reports frame times
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
const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true });
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

// Frame clock and input lag, measured in the page.
await page.evaluate(() => {
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
  window.addEventListener('pointermove', (e) => w.__bench.on && e.pointerType === 'pen' && w.__bench.moves.push(e.timeStamp), true);
});
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
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
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
const start = () => page.evaluate(() => Object.assign(window.__bench, { frames: [], moves: [], lags: [], on: true }));
const stop = () => page.evaluate(() => { window.__bench.on = false; return { frames: window.__bench.frames, lags: window.__bench.lags }; });

const mouse = (type, x, y, force = 0.5) =>
  cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force });

console.log(`CPU ${CPU}x slower, ${PAGES} pages, ${recorded.length} recorded strokes`);

// Pen: write a few lines of recorded strokes into the middle of the screen.
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

// Scroll: wheel scrolling down through the note and back, twice (first view of the pages, then
// with their ink already modelled).
await page.mouse.move(410, 600);
for (const pass of ['scroll 1', 'scroll 2']) {
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
