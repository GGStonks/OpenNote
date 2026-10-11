// Copies the TikZJax runtime (e-TeX compiled to WebAssembly + PGF/TikZ format dump)
// into public/tikzjax so it ships inside the app bundle and works fully offline.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@drgrice1', 'tikzjax', 'dist');
const dest = join(root, 'public', 'tikzjax');

if (!existsSync(src)) {
  console.error('[copy-tikzjax] @drgrice1/tikzjax is not installed; run npm install');
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const entry of ['run-tex.js', 'core.dump.gz', 'tex.wasm.gz', 'fonts.css', 'fonts', 'tex_files']) {
  cpSync(join(src, entry), join(dest, entry), { recursive: true });
}
// Some servers (Vite/sirv, some WebView asset servers) send *.gz with "Content-Encoding: gzip", so the
// browser has already inflated the bytes and TikZJax's own pako.Inflate fails. Patch the worker's
// loader to inflate only when the payload still starts with the gzip magic bytes (and to treat an
// SPA-fallback HTML page as a missing file).
const workerPath = join(dest, 'run-tex.js');
const original = readFileSync(workerPath, 'utf8');
const loader =
  'if(t.ok){const A=t.body.getReader(),e=new n.default.Inflate;for(;;){const{done:t,value:r}=await A.read();if(t)break;e.push(r)}if(A.releaseLock(),e.err)throw new Error(e.err);return e.result}';
const patched =
  'if(t.ok){const A=new Uint8Array(await t.arrayBuffer());if(!(A[0]===31&&A[1]===139)){if((t.headers.get("content-type")||"").includes("text/html"))throw new Error("missing");return A}const e=new n.default.Inflate;if(e.push(A,!0),e.err)throw new Error(e.err);return e.result}';
if (original.includes(loader)) {
  writeFileSync(workerPath, original.replace(loader, patched));
  console.log('[copy-tikzjax] patched run-tex.js gzip loader');
} else {
  console.warn('[copy-tikzjax] WARNING: run-tex.js loader not found; .gz assets must be served without Content-Encoding');
}
// When TeX asks for a file that is not in tex_files/, the worker falls back to fetch(<name>) relative
// to itself. Servers with an SPA fallback answer with index.html, which TeX then reads as LaTeX
// ("Missing \\begin{document}"). Everything available is in tex_files/, so treat it as missing.
const withFallback = readFileSync(workerPath, 'utf8');
const fallback = 'catch{try{const t=await fetch(A);if(!t.ok)throw new Error(`Unable to load ${A}.`);{const e=await t.text();s[A]=e}}catch{}}';
if (withFallback.includes(fallback)) {
  writeFileSync(workerPath, withFallback.replace(fallback, 'catch{}'));
  console.log('[copy-tikzjax] patched run-tex.js missing-file fallback');
} else {
  console.warn('[copy-tikzjax] WARNING: run-tex.js fetch fallback not found');
}
// Android's AAPT silently gunzips *.gz assets and strips the extension when packaging the APK, so the
// worker's requests for *.gz would 404 inside the app. Ship them as *.gzb and point the worker there.
const renameGz = (dir) => {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) renameGz(full);
    else if (name.name.endsWith('.gz')) renameSync(full, full + 'b');
  }
};
renameGz(dest);
let worker = readFileSync(workerPath, 'utf8');
for (const [from, to] of [
  ['tex_files/${A}.gz`', 'tex_files/${A}.gzb`'],
  ['"tex.wasm.gz"', '"tex.wasm.gzb"'],
  ['"core.dump.gz"', '"core.dump.gzb"'],
]) {
  if (!worker.includes(from)) console.warn(`[copy-tikzjax] WARNING: ${from} not found in run-tex.js`);
  worker = worker.replace(from, to);
}
writeFileSync(workerPath, worker);
console.log('[copy-tikzjax] renamed *.gz -> *.gzb (Android AAPT safe)');
console.log('[copy-tikzjax] copied TikZJax runtime to public/tikzjax');
