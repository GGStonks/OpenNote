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
- Pinch: the shell applies the gesture to the scene on every touch event it sees (before the web
  view), the page's `useViewport` keeps the gesture's logic and commits as now; scroll likewise
  from the page's scroll events in N3, from the shell's own gesture in N5.
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
