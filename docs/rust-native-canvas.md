# The native canvas: the page drawn by Rust on the GPU

Status: in progress since 2026-11-13, on the `opennote-rs` branch. Decisions taken by the owner on
2026-11-13, in this order of priority:

1. **Smoothness first**: pinch and scroll at the display's rate on long notes, no redraw stalls.
   Pen latency and memory follow from the same change and are measured alongside.
2. **A fully native canvas**: everything on the page (paper, PDF pages, pictures, ink, text boxes,
   formulas, TikZ) drawn by the shell; the web view keeps the menus, dialogs, library and settings.
3. **Rust is the ink engine of record**: `crates/nib` + `crates/ink`. The TypeScript engine stays
   as the browser's engine at 2.9.4 quality and is no longer improved; the golden file and the
   benches move to Rust before the first engine change (docs/rust-rewrite-roadmap.md, Phase 6 of
   the old plan folds into this).
4. **The native page is the first checkpoint**: an `-rs` build the owner tests before the next step.

Each step below ships as its own `X.Y.Z-rs.N` prerelease, measured on the PC as stated and on the
devices by the owner (Diagnostics and the crash report carry the numbers). A step that makes
anything worse than 2.9.4 on the owner's devices is fixed before the next starts.

## Why this gives smoothness

Today the page's ink is drawn by WebKit (vector SVG per page, canvases and tiles as the fallback,
WebGL while pinching, three renderers kept in step: CLAUDE.md "Useful commands"). Every zoom
re-rasterises layers in WebKit's own process at its own cadence (30 fps in Low Power Mode, 60 fps
capped otherwise, a frame or two behind the fingers), and long notes hit its canvas memory
limits. A native canvas draws the whole visible page from its vectors on every display frame
(120 Hz on an iPad Pro), from the touch events the shell already sees before the web view, with
no hand-off and no re-rasterisation. The existing pieces it builds on:

- `crates/renderer`: the page's ink as render ops (capsule chains per stroke, fills, arrows,
  highlighters, glow), checked against the app's canvas to within 1 px (docs/rust-status.md).
- `src/ink/glInk.ts`: the page's WebGL ink, whose passes the native canvas mirrors exactly:
  opaque strokes of one colour in a row are one coverage pass (max blend) composited once, so
  overlapping capsules never darken; a see-through stroke alone; fills by even-odd stencil; holes
  erase; hatches are capsules under the stencil.
- `crates/native`: the shells' Rust library and the binary bridge (`rustCore.ts`), and the live
  ink the shells already compute in Rust (`live.rs`).
- `ONPinchOverlay` / `nativePinch.ts`: the shells already receive the pinch (`b` / `m` / `e`) and
  the page's transform; the native canvas takes that protocol over.

## Steps

### N1. `crates/canvas`: the page scene on the GPU (wgpu), tested on the PC

- `Scene::build(layers)` from the page's z-layers (strokes only in N1): the same ops as glInk.
- `GpuCanvas::draw(target, size, scene, transform)`: coverage texture (R8, max blend) +
  compose, stencil fills, hatch, hole, arrows, see-through strokes; scissor per op.
- `render_offscreen` for tests and `opennote_canvas_cli` for the PC harness.
- Paper: the background colour in N1; the patterns (ruled, grid, graph, dots) ported from
  `paper.rs` to WGSL in N2.
- **Acceptance**: on the 36 reference strokes (fountain, ballpoint, highlighter, dashed), the GPU
  image against the CPU renderer and against the app's canvas (`bench:ui`'s page): every inked
  pixel within 1 px of the other's, total ink darkness within 2%, at 1x and 4x. Builds for
  `aarch64-apple-ios` (Metal) and Android (Vulkan / GLES).

### N2. The shells host the canvas under a transparent web view

State (2.9.4-rs.19): an opt-in test, Settings > Diagnostics > "Native canvas" (next start; iOS
`OpenNoteNativeCanvas`, Android SharedPreferences `opennote_native_canvas`). The shells host the
canvas (iOS CAMetalLayer, Android SurfaceView through ANativeWindow) under a see-through web
view; the page keeps every touch and all logic, sends its strokes (`canvasScene`) and, every
animation frame it changed, where they are (`canvasFrame`: from the page's own box, so scroll,
zoom and pinch are followed, device px; each sheet's paper as its own placement) and hides only
its committed ink. Notes with PDF pages or pictures keep the page's drawing (they would cover the
native ink until N4). rs.18 had made this the default with the page's touches handed to a Rust
view that ignored the pen, a frame that ignored scrolling and pixel density, every sheet
repeating all the ink, and Android drawing offscreen: rs.19 fixed those and made it opt-in.
rs.20: one decision for the whole note (rustCore `nativeCanvasFor`, used by App, Editor and
CanvasPage). In rs.19 a note with a picture or a PDF page kept the page's drawing but still got a
see-through desk over a canvas nobody drew: black. Whenever no note is drawn natively the canvas
shows the desk. The canvas reports its GPU, frames and errors (`canvasStats`; Diagnostics under
its switch, `canvas-status` in the crash report); `crates/native/tests/canvas_frame.rs` draws the
page's own frame messages through the bridge.

- iOS: a `CAMetalLayer` view under the `WKWebView` (`opaque = NO`, clear background);
  Android: a `SurfaceView` under the `WebView` (transparent). wgpu surfaces from both.
- The page sends the open note's strokes once (the binary bridge, from the packed arrays) and
  each change (append, erase, move) as a delta; the shell keeps the scene.
- The page sends its transform (`CONTENT_PLACED`, scroll, zoom); the shell draws the page there,
  and hides nothing yet: the page's own ink stays on top until N3 proves the two identical
  (`inkplace`-style check: the same page point at the same device pixel at every zoom).
- Paper patterns in WGSL; the paper colour from the note.
- **Acceptance**: `bench:ui --native --only canvasplace` (new): shell transform = page's at 100,
  195, 500%, 0.00 device px. On the device: the crash log's `canvas` entries (frame gaps while
  drawing). Nothing visible changes for the owner in this build except Diagnostics.

### N3. The native canvas is the page's ink; pinch and scroll follow the fingers

- The page stops drawing ink (vector SVG, canvases, SharpInk, WebGL pinch ink) when the shell
  has the canvas; its live ink (`live.rs`) draws straight into the same canvas at the end of
  each frame (no separate `ONInkView` layer).
- Pinch and scroll: the canvas is placed by the page's frames only (`canvasFrame`, every
  animation frame it changed, from the page's own box), drawn on the display's next refresh.
  rs.21-25 also moved it from the shells' own pinch and pan recognisers, which ignored the page's
  frames meanwhile: the ink parted from the page's text, selection and live ink while the fingers
  moved (no zoom limits, its own momentum) and jumped back after; nothing on the page read the
  shells' camera. Removed in rs.26. Since N5 (below) Rust leads two-finger gestures and the page
  follows its camera: still one camera, never the two each running their own.
- Memory: no page canvases, no tiles; the scene's GPU buffers are the only ink memory.
- **Acceptance**: `--only pinch`, `zpinch`, `longpinch`, `hlshots`, `zorder` keep their checks
  with the native canvas (a stand-in shell on the PC renders through `opennote_canvas_cli`);
  on the iPad Pro: 120 fps pinch and scroll in the crash log, Low Power Mode included (no
  snapshot pinch any more); `bench:ui --only canvasmem` shows no ink canvases.

### N4. Pictures and PDF pages

- Pictures: decoded by the shell (UIImage / BitmapFactory), uploaded as textures, drawn in
  z-order with crop, flip, rotation (ImageBlock).
- PDF pages: rendered by the platform (PDFKit on iOS, PdfRenderer on Android) into textures at
  the zoom in view, as `PdfBackground` does today, under the ink.
- **Acceptance**: `pdfimport`, `pdfthumb` shots match the web view's; the owner's PDF notes
  open and look the same page by page.

### N5. Text boxes, formulas, TikZ; the shell owns scroll

- Text boxes and formulas are laid out by the web view as today (rich text, KaTeX), rendered
  off screen to bitmaps at the zoom in view and drawn by the canvas in z-order; editing a text
  box shows the web element over the canvas at the box's place, and the bitmap is refreshed on
  blur. TikZ SVGs likewise. Native text layout (parley) is deferred: KaTeX fidelity and the
  rich-text editor are kept.
- Scroll and momentum move to the shell (a native scroll view driving the scene); the page's
  `useViewport` becomes a mirror (fit to width, saved views, pull gestures).
- State (ADR-006, the camera): `crates/viewport` ports useViewport.ts's two-finger gesture (pan,
  pinch about the fingers with REBASE_RATIO commits, momentum at UIScrollView's 0.998 per ms, the
  pull past the last page, fit to width and its FIT_SNAP) and the page's views, constant for
  constant (`src/editor/viewportMath.ts` is the arithmetic both run, compared to 1e-9). The page
  scrolls two fingers in its own code on iOS and Android alike (it cancels the web view's scrolling
  at the second finger; one finger alone scrolls natively, the page's), so that is what the port
  reproduces; there is no rubber band but the pull. crates/native `viewport_service.rs` owns it
  beside the scenes: the shells hand it every finger that starts over the note (iOS `ONWindow
  sendEvent:`, Android `MainActivity.dispatchTouchEvent`, before the web view, which still gets
  them); the render thread advances it each display frame and places the page's last frame at
  its camera (the frame carries where the page's surface was, `surface`; `FrameSpec::moved`), so
  ink follows the fingers at the display's best rate with no page round trip; after each tick the
  shell pushes the camera to the page (`window.__opennoteCamera`, at most once per page frame),
  whose `useViewport` mirrors it on its own frames (committed zoom and scroll, the rest as one
  measured transform on the content) and sends its layout and its own views (`viewportLayout`,
  `viewportSet`). Each gesture's tick intervals go to the crash report (`pinch`, `gl: 'rust'`,
  `fps` against the display's `hz`) and to `canvasStats.viewport`. Checks:
  `bench:ui --native --only rustcamera` (the page's own gestures and the Rust camera on the same
  finger paths; the DOM against the camera at rest and while moving), `crates/viewport/tests`,
  `crates/native/tests/viewport_canvas.rs`.
- Selection frame, lasso, eraser circle, glow: drawn by the canvas.
- **Acceptance**: the parity list of CLAUDE.md's rendering checks (`selshots`, `dragshots`,
  `tapshots`, `latexshift`, `boxes`, `resize8`) on the native canvas; the owner's notes open
  and look right against their 2.9.x PDF exports.

### N6. Rust as the engine of record; feel

- `npm run test:engine` compares the TypeScript engine with a golden file written by Rust;
  `bench:look`, `hooks`, `overshoot`, `leadend`, `pen` ported to Rust (crates/ink/tests/benches.rs
  grows into them) and run on the recordings before and after every engine change, numbers in
  the commit message, as CLAUDE.md asks.
- Then the feel: the Pencil's predicted touches drawn as the provisional tail, the settling of
  the end at the lift, pressure response; each measured on the device (pen-to-ink latency from
  the display link, recorded strokes).
- **Acceptance**: the owner's judgement on the device, with the numbers.

### N7. Retire the web page's rendering

- Remove the vector ink, page canvases, SharpInk, WebGL pinch ink, `ONInkView` / `InkOverlay`,
  the snapshot pinch; CLAUDE.md rewritten for the native canvas.

## Rules while this runs

- Every step keeps `npm run build`, `cargo test --workspace` and the existing `bench:ui`
  scenarios green; a scenario replaced by a native one is replaced in the same commit.
- The TypeScript engine (`src/ink/engine/**`) is not edited; the Rust crates are.
- Heavy steps (Chromium benches, Gradle, Rust builds) run one at a time with at least 4 GB free
  (`free -m`), from the working copy on disk (`/home/ds/AI/OpenNote-worktrees/rs`), never from
  `/tmp` (tmpfs: the first attempt filled the RAM).
- With the native canvas on, the web view stays see-through for the whole run, whatever the theme:
  the theme's colour goes behind the canvas (iOS `applyLaunchColor`, Android
  `OpenNoteLaunchPlugin.webViewBackground`). Until 2.9.4-rs.25 the theme sent at every start
  painted the web view over the canvas: a black screen in a dark theme, every stroke gone at lift.
  `--only nativecanvas [--zsteps N]` (`BENCH_THEME=dark`) checks what the user sees (the page over
  the canvas, and a stroke written and lifted); the shells' views are not part of it.
- One owner of the canvas (C1, rust/DECISIONS.md ADR-002): crates/native `canvas_service.rs`. The
  GPU objects (`HOST`: the host, its layer or window) are locked only by the render thread for a
  draw and by the surface's lifecycle (`opennote_canvas_attach_layer` / `_resize` / `_detach`,
  Android `canvasSurfaceCreated` / `Changed` / `Destroyed`); what the page sends (`PAGE`: each
  page's scene, the last frame) has a lock of its own that the bridge holds only to swap a value
  in, and the draw takes what changed at its start. The bridge never waits for a draw (a draw
  waits for the surface's next image), and builds each scene on its own thread first. The shells
  hold no host pointer: until rs.27 they held raw `CanvasHost` pointers, shared through an
  `AtomicPtr` by the UI thread, the render thread and the bridge. Detach is synchronous: when it
  returns no draw uses the layer or window, and Android's `ANativeWindow` reference is released
  after the host. `crates/native/tests/canvas_stress.rs` runs the three threads at once.
- Errors never panic. wgpu's default handler panics on any validation error, and a panic inside a
  render pass (its drop panics again while unwinding) aborts the app past every `catch_unwind`:
  each device gets its own handler (crates/canvas `GpuHealth`), which records the error for
  `canvasStats` (Diagnostics, the crash report's `canvas-status`: `errors`, `error`,
  `failedFrames`, `skippedFrames`, `skippedPages`, `lost`, `backend`, `fallback`). Before any GPU
  call: a placement whose transform is not finite or is degenerate is skipped, a paper that is not
  a finite positive box dropped; every texture is sized from its target, never from the zoom,
  within `max_texture_dimension_2d`; no buffer is empty or above `max_buffer_size`; scissors are
  clamped to the pass's own target. The device asks for the adapter's own limits, never wgpu's
  defaults; format, alpha and present mode come from the surface's capabilities. A surface image
  that is outdated or lost reconfigures and skips the frame, a late one skips it. A lost device,
  or a panic caught anyway, drops the host, made again from the same layer or window at a later
  tick. Android: a Vulkan driver that fails to make a device, loses it, or reports errors in its
  first frames is replaced by GLES for the rest of the run (Mali). A driver's segfault ends the
  process past all of that: a run with the canvas on that ended abnormally (Android's exit
  record) makes OpenNoteRustPlugin start every later run on GLES (`canvasPreferGl`, preference
  `gl`), until the canvas is switched in Diagnostics. The release profile keeps
  `panic = unwind`, and every C and JNI entry point wraps `catch_unwind`.
- Scenes are sent by difference (rs.26): each stroke object has a key (rustCore.ts `sceneKey`), its
  style and points go once, then the key alone; Rust keeps each stroke's ops (crates/native
  `SCENE_OPS`, the costly part: its drawn line) and assembles the scene from them
  (`Scene::from_ops`, the same as `Scene::build`). A key the canvas does not hold is answered
  `missing` and the page sends them all. A host made later (Android's surface, back from the
  background; a host made again after its device was lost) is given every scene and the last
  frame at its first draw (`canvas_service` keeps them). The shell's live
  copy of a stroke is cleared only once the canvas has its scene (CanvasPage `finishStroke`).
  `crates/native/tests/canvas_cache.rs`; `--only nativecanvas` checks the lift sends one stroke.
- One camera (ADR-006): while Rust owns a note's camera (`nativeViewportFor`: the canvas draws it
  and the shell says `nativeViewport`), the page never scrolls or zooms the note itself. Its views
  go to Rust (`viewportSet`: fit to width, fit page, saved views, zoom, the wheel, going to a page),
  its own scroll (one finger natively, the wheel, the keyboard) is reported to Rust, and it mirrors
  the camera Rust publishes. A change to useViewport's gestures is made in `crates/viewport` too,
  and the constants live in viewportMath.ts (`npm run bench:rustref -- bench/rust-ref/viewport.json
  --module viewport`). The display's rate is asked for, never assumed: iOS the display link's
  `preferredFrameRateRange` up to `maximumFramesPerSecond`, Android the display mode of the same
  size with the highest rate and `Surface.setFrameRate`; momentum and animations use elapsed time.
- Over the native canvas the page draws no ink of its own, also while pinching (no WebGL pinch ink:
  usePinchInk is off) and in Low Power Mode (no shell snapshot pinch: it covered the canvas).
- The canvas is drawn on a thread of its own in both shells (iOS `ONStartCanvasThread`, a display
  link on its own run loop; Android's "opennote-canvas" HandlerThread with its own Choreographer),
  through `opennote_canvas_draw_active` (`canvasDrawActive` on Android). Never on the main / UI
  thread: drawing waits for the surface's next image, and there that wait held the touches and
  the web view's frames to 60 fps on a 120 Hz iPad (rs.18-26).
- The paper is the page's CSS paper (`paperBackground`) in page px, scaled with the zoom, each
  pixel covered by its share of a line (`fs_paper`); `compare.rs` checks it against the CSS rules
  sampled 8 x 8 per pixel at 1x-23.7x, deep inside a page larger than the screen. The CPU painter
  (`renderer::paper`, thumbnails) is not the reference: its lines are 1 device px at rounded places.
