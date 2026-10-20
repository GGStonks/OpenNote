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
`android/.../OpenNoteInkPlugin.java`. Each stroke has an id: the shells keep a finished stroke on
screen (also while the next is written) until its own `e,id`, plus ~60 ms, as the page's copy
reaches the screen after the page's frame (clearing earlier made ink blink at 60 fps).
`npm run bench:ui -- --native --only pen` checks every stroke is ended by id.
Both shells mirror the engine's capsule geometry (`addCapsule`);
if the engine's look ever differed from them, the fix belongs in the shells, never in the engine.

## Native pinch (iOS)

On a 120 Hz iPad Pro every page drew at 30 fps, even an idle one (Settings > Diagnostics >
Frame-rate test), while native scrolling was unaffected. The suspected cause is the shell lifting
WebKit's "near 60 fps" page rendering (WebKit then labels refreshes 120/s and serves the page every
other one); since 2.3.9 that is opt-in (Diagnostics toggle, next start). WebKit also forces 30 fps in
Low Power Mode / under heat. A pinch is drawn by the page (60 fps since 2.3.9), and in Low Power
Mode (`shellDrawsPinch` in useViewport.ts) the iOS shell shows a snapshot of the canvas area and
scales it on every finger event (`src/editor/nativePinch.ts` → `ONPinchOverlay` in
`ios-native/OpenNoteShell.m`), as native scroll views zoom. The snapshot, on the desk's colour,
is the only picture: the page stays still under it (scaling it too showed it out of step at the
edges). The page keeps the gesture logic, draws the new zoom when the fingers lift, then tells the
shell where the content really landed (the snapshot glides there and goes). `npm run bench:ui -- --only nativepinch` (alone) checks the
messages and that the snapshot's last position matches the drawn page.

## Conversion server access

The conversion server requires a per-device API key. The server side is private and lives outside
this public repo: never add anything here about how keys are generated, stored, checked or
metered, or about the server's internals. Every request the app sends to the server must use
`serverHeaders(settings)` (`src/services/serverAuth.ts`).

## Notability import

`src/import/notability.ts` (with `zip.ts`, `plist.ts`) turns a Notability `.note` (ZIP with a keyed-archive
`Session.plist`) into a note. What it reads is specified in `docs/notability-note-format.md`; keep the
two in step. Each curve is a chain of cubic Béziers with one fractional width per segment end; drawn
width = curveswidth x fractional width. Imported ink becomes ordinary strokes with
`modeled: 'proportional'` (each point's pressure = its width / the widest), so it is editable and exact
at any zoom. `bench/notabilityImport.ts` checks widths against the file (see its header for the command).

## Crashes on the iPad

WebKit can end the web view without an error the page sees (content process: the shell reloads;
GPU process: canvases go black). `src/services/crashLog.ts` keeps a rolling log (zoom, canvases,
events) and keeps an abnormal end as a report: Settings > Diagnostics > Crash report > Send to PC
(saved on the PC in `/home/ds/AI/opennote_diagnostics/`). Ask for one before guessing at a crash.
Every pinch is logged there too (`kind: 'pinch'`: frame gaps while the fingers zoom, `redrawMs` after
they lift): ask for a report before guessing at pinch lag on a device (headless Chromium does not
show the iPad's compositing cost).

## Useful commands

- `npm run build` — engine test, storage round-trip test, type-check, production build
- `npm run bench:ui` — slow-device UI benchmark in headless Chromium (CPU 4x slower, 8-page note of
  recorded handwriting): frame times and input lag while writing and scrolling; `--profile` / `--trace`
  show where the time goes. Run it before and after changes to rendering, saving or the canvas tiles.
  Extra scenarios: `--only canvasmem` (canvas backing memory per zoom; keep every canvas under
  WebKit's GPU limit, 5120x2880 px), `--only stress` (40 zoom/scroll rounds: nothing may pile up),
  and with `--shots <dir>`: `selshots` (an enlarged selection, zoomed in), `dragshots` (resizing a
  selection, zoomed in), `liveshots` (a stroke while the pen is down and after: they must match).
  `--only zpinch` (pinching from an already zoomed-in page: frames, and the ink canvases on screen mid-pinch).
  `--latex` adds a LaTeX block (two ink layers, as after a conversion); `--landscape` an iPad
  held sideways (the page fits at about 140%).
- While two fingers zoom, the ink is drawn by the GPU from its vectors on every frame
  (`src/ink/glInk.ts`, `src/editor/usePinchInk.ts`; geometry: `strokeGlGeometry` in strokeRenderer.ts,
  which must follow build()/paintInk()), the page's ink hidden; after the pinch it hands back once
  the sharp tiles in view are painted. `--only glcompare` compares the GPU and canvas ink for
  every kind of stroke; keep it close when changing either. Headless Chromium draws WebGL in
  software (far slower than any GPU): for GPU timings run the bench on this PC's integrated AMD GPU
  (tablet-class): `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/radeon_icd.json BENCH_GPU=1
  BENCH_GPU_ARGS="--use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE --disable-vulkan-surface"`.
  `--only glwarm`: how soon after opening the GPU ink is ready (a pinch before that uses the bitmaps).
- Zoomed in, memory must follow the screen, not the zoom: page canvases stay
  at the fit-width zoom and SharpInk's tiles (no canvas where there is no ink) draw the rest.
- `npm run bench:pen` — synthetic pen benchmark; `npm run bench:replay -- bench/recordings/<file>.json` — real recordings (Settings → Diagnostics → Record pen strokes → Send to PC)
- `npm run bench:overshoot` — real recordings through the whole pen pipeline (densify, engine, smoothing): how far the ink strays from the pen's path, and corners after the pen rests
- `/home/ds/AI/OpenNote_release.sh` — builds APK + IPA, tags and publishes the GitHub release
