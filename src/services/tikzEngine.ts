import { cleanModelOutput } from './latexRender';
import { compileTikzToSvg } from './tikzService';

/**
 * Real TikZ rendering with TikZJax's TeX engine (e-TeX compiled to WebAssembly + the PGF/TikZ format), bundled
 * in public/tikzjax so it works offline on iOS/Android. Its worker (run-tex.js) is driven directly by
 * TexWorker below; the DVI is converted to SVG inside the worker (dvi2html).
 */

export interface PreparedTikz {
  picture: string;
  libraries: string[];
  packages: Record<string, string>;
}

const AVAILABLE_PACKAGES = new Set([
  'amsmath', 'amssymb', 'amsfonts', 'amsbsy', 'amsgen', 'amsopn', 'amstext', 'array', 'etoolbox', 'pgfplots',
  'tikz-3dplot', 'tikz-cd', 'xparse', 'hf-tikz',
]);

const IMPLIED_LIBRARIES: [RegExp, string][] = [
  [/\b(Stealth|Latex|Triangle|Kite|Circle\[|Bar\[|Straight Barb|Classical TikZ Rightarrow|Computer Modern Rightarrow)\b|-\{|\{[A-Z][a-z]+\}-|>=\{?[A-Z]/, 'arrows.meta'],
  [/\$\s*\(|\bcalc\b/, 'calc'],
  [/\b(above|below|left|right)\s*=\s*[^,\]]*of\b|\b(above|below|left|right)\s+of\b/, 'positioning'],
  [/\b(ellipse|diamond|trapezium|regular polygon|star|cylinder|isosceles triangle|kite|dart|semicircle|signal)\b(?=[\],\s])/, 'shapes.geometric'],
  [/\b(rectangle split|circle split|ellipse split)\b/, 'shapes.multipart'],
  [/\b(decorate|decoration)\b/, 'decorations.pathmorphing,decorations.markings,decorations.pathreplacing'],
  [/\bpattern\s*=/, 'patterns'],
  [/\b(fit\s*=)/, 'fit'],
  [/\bintersections?\b|name path/, 'intersections'],
  [/\bbackground\b|on background layer/, 'backgrounds'],
  [/\bmatrix\s+of\b|\\matrix/, 'matrix'],
  [/\bangle\s*=\s*\w+--\w+--\w+|pic\s*\[[^\]]*\]\s*\{\s*(right\s+)?angle/, 'angles,quotes'],
  [/\bbend (left|right)|\bloop\b|automaton|state\b/, 'automata'],
  [/\bthrough\b/, 'through'],
];

/** Extracts a compilable tikzpicture (+ needed libraries/packages) from arbitrary VLM/user text. */
export function prepareTikz(src: string): PreparedTikz {
  const raw = src;
  const libs = new Set<string>();
  const packages: Record<string, string> = {};
  for (const m of raw.matchAll(/\\usetikzlibrary\{([^}]*)\}/g)) m[1].split(',').map((l) => l.trim()).filter(Boolean).forEach((l) => libs.add(l));
  for (const m of raw.matchAll(/\\usepackage(?:\[([^\]]*)\])?\{([^}]*)\}/g)) {
    for (const p of m[2].split(',').map((x) => x.trim())) if (AVAILABLE_PACKAGES.has(p)) packages[p] = m[1] ?? '';
  }
  let body = cleanModelOutput(raw);
  const start = body.indexOf('\\begin{tikzpicture}');
  const endTag = '\\end{tikzpicture}';
  const end = body.lastIndexOf(endTag);
  let picture: string;
  if (start >= 0 && end > start) picture = body.slice(start, end + endTag.length);
  else if (start >= 0) picture = body.slice(start) + '\n' + endTag; // truncated model output
  else if (/\\(draw|fill|node|path|filldraw)\b/.test(body)) picture = `\\begin{tikzpicture}\n${body}\n${endTag}`;
  else picture = body;
  picture = picture.replace(/\\usetikzlibrary\{[^}]*\}/g, '').replace(/\\tikzset\{\s*\}/g, '');
  if (/\\begin\{(axis|semilogxaxis|semilogyaxis|loglogaxis|polaraxis)\}/.test(picture)) {
    packages.pgfplots ??= '';
  }
  if (/\\begin\{tikzcd\}/.test(picture)) packages['tikz-cd'] ??= '';
  for (const [re, lib] of IMPLIED_LIBRARIES) if (re.test(picture)) lib.split(',').forEach((l) => libs.add(l));
  return { picture: picture.trim(), libraries: [...libs], packages };
}

/**
 * Supervised TeX worker.
 *
 * TikZJax's own loader (tikzjax.js) keeps one worker forever; a single bad input (an empty picture,
 * some TeX errors) leaves e-TeX waiting for terminal input and every later compile hangs behind it.
 * We talk to its worker (run-tex.js, threads.js protocol) directly instead, with a timeout per job;
 * a stuck or failed worker is terminated and a fresh one is started for the next job.
 */
class TexWorker {
  private worker: Worker;
  private nextUid = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private initResolve!: () => void;
  readonly ready: Promise<void>;
  dead = false;

  constructor(private base: string) {
    this.worker = new Worker(base + 'run-tex.js');
    const inited = new Promise<void>((resolve) => (this.initResolve = resolve));
    this.worker.onmessage = (e: MessageEvent) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.failAll(new Error(e.message || 'TeX worker crashed'));
    this.ready = inited.then(() => this.call('load', [base.replace(/\/$/, '')], 60000));
  }

  private onMessage(msg: any) {
    if (typeof msg === 'string') return; // TeX console output
    if (msg?.type === 'init') return this.initResolve();
    const job = this.pending.get(msg?.uid);
    if (!job) return;
    if (msg.type === 'result' && msg.complete) {
      this.pending.delete(msg.uid);
      job.resolve(msg.payload);
    } else if (msg.type === 'error') {
      this.pending.delete(msg.uid);
      job.reject(new Error(msg.error?.message ?? 'TeX error'));
    }
  }

  private failAll(err: Error) {
    this.dead = true;
    this.pending.forEach((j) => j.reject(err));
    this.pending.clear();
  }

  call(method: string, args: unknown[], timeoutMs: number): Promise<any> {
    const uid = this.nextUid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.terminate();
        reject(new Error('TikZ compilation timed out (TeX stopped responding)'));
      }, timeoutMs);
      this.pending.set(uid, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.worker.postMessage({ type: 'run', uid, method, args });
    });
  }

  terminate() {
    this.worker.terminate();
    this.failAll(new Error('TeX worker restarted'));
  }
}

let worker: TexWorker | null = null;
let fontsLoaded = false;

function assetBase(): string {
  return new URL('tikzjax/', document.baseURI).href;
}

function getWorker(): TexWorker {
  if (!fontsLoaded) {
    fontsLoaded = true;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = assetBase() + 'fonts.css';
    document.head.appendChild(link);
  }
  if (!worker || worker.dead) worker = new TexWorker(assetBase());
  return worker;
}

let queue: Promise<unknown> = Promise.resolve();
const memoryCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

async function compileOnce(prep: PreparedTikz, timeoutMs: number): Promise<string> {
  if (!/\\begin\{tikzpicture\}[\s\S]*\\end\{tikzpicture\}/.test(prep.picture) && !/\\begin\{tikzcd\}/.test(prep.picture)) {
    throw new Error('No \\begin{tikzpicture} … \\end{tikzpicture} found');
  }
  const w = getWorker();
  try {
    await w.ready;
  } catch (err) {
    w.terminate();
    throw err;
  }
  const dataset: Record<string, string> = {
    addToPreamble: '\\nonstopmode' + (prep.packages.pgfplots !== undefined ? '\\pgfplotsset{compat=1.18}' : ''),
  };
  if (prep.libraries.length) dataset.tikzLibraries = prep.libraries.join(',');
  if (Object.keys(prep.packages).length) dataset.texPackages = JSON.stringify(prep.packages);
  let html: string;
  try {
    html = await w.call('texify', [prep.picture, dataset], timeoutMs);
  } catch (err) {
    // A failed run can leave the worker's virtual filesystem dirty: always start fresh.
    w.terminate();
    throw err instanceof Error && /restarted/.test(err.message) ? new Error('TeX could not compile this TikZ code') : err;
  }
  if (!html || !html.includes('<svg')) throw new Error('TeX produced no drawing');
  // Make pgf ids unique per picture (several diagrams share one document).
  const salt = Math.random().toString(36).slice(2, 8);
  html = html.replace(/\b(id="|url\(#|href="#)pgf/g, `$1pgf${salt}`);
  return html.slice(html.indexOf('<svg'));
}

/** Post-processes TikZJax SVG so it scales inside a block and follows the ink colour. */
function normaliseSvg(svg: string): string {
  return svg
    .replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
      const a = attrs.replace(/\s(width|height)="[^"]*"/g, '');
      const w = /width="([\d.]+)pt"/.exec(attrs)?.[1];
      const h = /height="([\d.]+)pt"/.exec(attrs)?.[1];
      const size = w && h ? ` width="${(parseFloat(w) * 1.333).toFixed(2)}" height="${(parseFloat(h) * 1.333).toFixed(2)}"` : '';
      return `<svg${a}${size} style="overflow:visible">`;
    });
}

/** Compiles TikZ with the real TeX engine (serialised; results cached per source). */
export function renderTikzWithTeX(src: string, timeoutMs = 25000): Promise<string> {
  const prep = prepareTikz(src);
  const key = JSON.stringify(prep);
  const cached = memoryCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = queue.then(async () => {
    const svg = normaliseSvg(await compileOnce(prep, timeoutMs));
    memoryCache.set(key, svg);
    return svg;
  });
  inflight.set(key, job);
  job.finally(() => inflight.delete(key)).catch(() => undefined);
  queue = job.catch(() => undefined);
  return job;
}

/** Instant approximate preview (no TeX). */
export function renderTikzPreview(src: string): { svg: string; warnings: string[] } {
  return compileTikzToSvg(prepareTikz(src).picture);
}
