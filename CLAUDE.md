# OpenNote — notes for Claude

## The ink engine is frozen

`src/ink/engine/` (Nib v1: `nib.ts`, `liveStroke.ts`, `geometry.ts`, `index.ts`) is final. The owner
has said it must never be changed again. Tag: `nib-engine-v1`.

- Do not edit anything in `src/ink/engine/`, not its `NIB` parameters, not "small" tweaks, not
  refactors. If a task seems to need an engine change, say so and ask; do not do it.
- New features that need ink (shape tools, retracing, Android, …) use the engine through
  `src/ink/engine/index.ts` (`NibModeler`, `nibStroke`, `LiveStroke`, geometry helpers), outside the folder.
- `npm run test:engine` compares the engine's output (live, finished, nibStroke) on fixed strokes with
  `bench/engine-golden.json` to 1e-4 px. `npm run build` runs it first, so a changed engine cannot be
  built or released. Never regenerate the reference (`--update`) to make a change pass.
- The engine must behave the same on iPad (iOS shell 240 Hz samples, `src/ink/nativePencil.ts`) and
  Android (Chromium coalesced pointer events): platform differences are handled in the input layer
  (`src/components/CanvasPage.tsx`), never inside the engine.

## Native live ink

In the apps, the stroke being written is also drawn natively above the web view (lower pen latency):
`src/ink/nativeInk.ts` sends LiveStroke's points to `ios-native/OpenNoteShell.m` (`ONInkView`) and
`android/.../OpenNoteInkPlugin.java`. Both shells mirror the engine's capsule geometry (`addCapsule`);
if the engine's look ever differed from them, the fix belongs in the shells, never in the engine.

## Conversion server access

The conversion server requires a per-device API key. The server side is private and lives outside
this public repo: never add anything here about how keys are generated, stored, checked or
metered, or about the server's internals. Every request the app sends to the server must use
`serverHeaders(settings)` (`src/services/serverAuth.ts`).

## Notability import

`src/import/notability.ts` (with `zip.ts`, `plist.ts`) turns a Notability `.note` (ZIP with a keyed-archive
`Session.plist`) into a note. The format was taken from Notability 16.12.5's GLInkKit
(`InkObjectEncoder batchDecode`): each curve is a chain of cubic Béziers with one fractional width per
segment end; drawn width = curveswidth x fractional width. Imported ink becomes ordinary strokes with
`modeled: 'proportional'` (each point's pressure = its width / the widest), so it is editable and exact
at any zoom. `bench/notabilityImport.ts` checks widths against the file (see its header for the command).

## Useful commands

- `npm run build` — engine test, storage round-trip test, type-check, production build
- `npm run bench:ui` — slow-device UI benchmark in headless Chromium (CPU 4x slower, 8-page note of
  recorded handwriting): frame times and input lag while writing and scrolling; `--profile` / `--trace`
  show where the time goes. Run it before and after changes to rendering, saving or the canvas tiles.
  Extra scenarios: `--only canvasmem` (canvas backing memory per zoom; keep every canvas under
  WebKit's GPU limit, 5120x2880 px), `--only selshots --shots <dir>` (an enlarged selection, zoomed in).
- `npm run bench:pen` — synthetic pen benchmark; `npm run bench:replay -- bench/recordings/<file>.json` — real recordings (Settings → Diagnostics → Record pen strokes → Send to PC)
- `npm run bench:overshoot` — real recordings through the whole pen pipeline (densify, engine, smoothing): how far the ink strays from the pen's path, and corners after the pen rests
- `/home/ds/AI/OpenNote_release.sh` — builds APK + IPA, tags and publishes the GitHub release
