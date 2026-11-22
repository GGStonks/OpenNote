import { writeFileSync } from 'node:fs';
import { run as runInk } from './rustref/ink';
import { run as runShapes } from './rustref/shapes';
import { run as runSelection } from './rustref/selection';
import { run as runSmartpen } from './rustref/smartpen';
import { run as runSvg } from './rustref/svg';
import { run as runImport } from './rustref/import';
import { run as runViewport } from './rustref/viewport';

const args = process.argv.slice(2);
const out = args[0];
if (!out || out.startsWith('--')) {
  console.error('usage: npm run bench:rustref -- <out.json> [--per N] [--module ink|shapes|selection|smartpen|svg|import|viewport] [files…]');
  process.exit(1);
}

let per = 6;
let moduleName = 'ink';
const named: string[] = [];

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--per') {
    i++;
    if (i < args.length) per = Number(args[i]);
  } else if (arg === '--module') {
    i++;
    if (i < args.length) moduleName = args[i];
  } else if (!arg.startsWith('--')) {
    named.push(arg);
  }
}

const runners: Record<string, (opts: { per: number; files: string[]; out: string }) => unknown | Promise<unknown>> = {
  ink: runInk,
  shapes: runShapes,
  selection: runSelection,
  smartpen: runSmartpen,
  svg: runSvg,
  import: runImport,
  viewport: runViewport,
};

const runner = runners[moduleName];
if (!runner) {
  console.error(`Unknown module: ${moduleName}`);
  process.exit(1);
}

const result = await runner({ per, files: named, out });
const json = JSON.stringify(result);
writeFileSync(out, json);
const strokes = (result as { strokes?: unknown[] })?.strokes;
if (Array.isArray(strokes)) {
  const fileCount = named.length > 0 ? named.length : 6;
  console.log(`${strokes.length} strokes from ${fileCount} recordings -> ${out} (${(json.length / 1e6).toFixed(1)} MB)`);
} else {
  console.log(`wrote ${out} (${(json.length / 1e6).toFixed(1)} MB)`);
}
