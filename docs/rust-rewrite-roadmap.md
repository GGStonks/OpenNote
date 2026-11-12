# OpenNote in Rust: feasibility and roadmap

Status: in progress since 2026-11-12, on the `opennote-rs` branch of `GGStonks/OpenNote`. In the
roadmap below, `[x]` is done and checked as stated; `[ ]` is not started, or written but not yet
verified as the item asks (the note says which). docs/rust-status.md has the crate-by-crate detail.

## Is it possible?

Yes. Everything OpenNote does has a workable Rust equivalent on iOS and Android. But OpenNote is a
React app running in a web view: about 28,000 lines of TypeScript, plus 3,100 lines of
Objective-C and Java in the shells. The browser does a large share of the work for free: layout,
text editing, keyboard and IME, accessibility, SVG, PDF rendering (pdf.js), LaTeX (KaTeX), TeX
for TikZ (TikZJax's tex.wasm), printing and IndexedDB. A full rewrite replaces those as well as
porting the 28,000 lines. That replacement is most of the cost and most of the risk.

| Part | Today | In Rust | Difficulty |
|---|---|---|---|
| Ink engine (Nib), width, smoothing, dashes, eraser | TS, `src/ink` | straight port, checked against the golden file and the recordings | low |
| Data model, `.opennote`, packed points | TS + IndexedDB | serde + SQLite (`rusqlite`), same `.opennote` format | low |
| Shapes, snapping, smart pen, selection, z-order | TS, `src/editor`, `src/services` | straight port | medium (large, but plain logic) |
| Notability `.note` / `.ntb`, Word `.docx` | TS + DOMParser | `zip`, `plist`, `quick-xml`, `flatbuffers` | low |
| Drawing the page (paper, ink, images, glow) | Canvas 2D + SVG + WebGL, three renderers kept in step | one GPU renderer: `wgpu` + `vello` or tessellated with `lyon` | medium |
| Pencil input | ObjC shell at 240 Hz → web page | Rust `UIView` (`objc2`) at 240 Hz, straight into the engine | medium |
| Pinch, scroll, zoom | web view + many workarounds | own transform, redrawn by the GPU every frame | medium |
| PDF pages | pdf.js | `hayro` (pure Rust) or PDFium (`pdfium-render`) | medium |
| PDF export and printing | WebKit print, calibration, pdf-lib joining | `krilla` writes the PDF, `lopdf` joins the original pages, native print of that file | medium (simpler than today) |
| Text boxes (rich text editing) | contenteditable | `parley` layout + own editor + native text input (`UITextInput`, Android `InputConnection`) | **high** |
| Formulas | KaTeX | Typst's math layout via `mitex` (LaTeX → Typst), or an embedded KaTeX port | **high** (layout must match stored notes) |
| TikZ on the device | TikZJax (TeX in WASM) | the same `tex.wasm` run by `wasmi` (no JIT on iOS) + a DVI → SVG converter in Rust | **high** (speed unknown) |
| Menus, popovers, library, settings | React + Tailwind | a Rust UI toolkit (see Phase 0) | medium, long |
| Accessibility (VoiceOver, TalkBack) | free in the web view | AccessKit where it reaches; gaps on iOS | **high** |
| Conversion server client | fetch + `serverHeaders` | `reqwest`; the same headers, key handling unchanged | low |

## What a native Rust app would gain

These are concrete to OpenNote. Most of the hard work in CLAUDE.md exists only because ink is drawn
inside a web view.

1. **Lower pen latency, one ink.** Today the stroke being written is drawn twice: by the iOS or
   Android shell on a native layer for low latency, and by the page. They have to be kept
   identical (`addCapsule` mirrored in ObjC and Java), handed over per stroke id with a 60 ms
   grace period, and the lead from line to pen is a protocol of its own (`l,id`). In Rust the
   Pencil samples go straight into the engine and onto the GPU layer in the same frame: one
   renderer, nothing to hand over.
2. **The display's real frame rate.** No WebKit "near 60 fps" cap, no 30 fps pages on the 120 Hz
   iPad Pro, no snapshot pinch in Low Power Mode. `CADisplayLink` asks for 120 Hz directly.
3. **One renderer instead of three.** Canvas 2D, SVG vector ink and WebGL pinch ink are each
   compared against the others today (`svgcompare`, `glcompare`, `liftshots`, `hlshots`). One
   GPU scene draws the page, the pinch, a dragged selection and the thumbnails, at the
   screen's resolution at every zoom. SharpInk tiles, page canvases aligned to device pixels and
   `ScreenScaled` layers all go.
4. **No WebKit memory and GPU-process limits.** No 5120x2880 canvas limit and no black canvases
   after a GPU-process crash.
5. **Printing and PDF export without calibration.** The PDF is written directly (vectors and
   text), the original pages joined under it, and that file is what gets printed.
   `printCalibration.ts`, the print-run batching and Android's printed-background check go.
6. **A faster engine and no garbage-collection pauses** while writing: probably several times
   faster again than 2.9.2's engine, and steady.
7. **Fewer platform quirks.** No Chrome 74 WebView on Android 10, no scrollbar gutter offset, no
   CSS safe-area emulation (insets and cutouts come straight from the system).
8. **Desktop for little extra:** the same code builds for Linux, Windows and macOS.

About 2,500 lines of TypeScript (`nativeInk`, `nativePencil`, `inkRecorder`, `glInk`,
`usePinchInk`, `vectorInk`, `nativePinch`, `printCalibration`, frame-rate probing, `cutout`,
tile work) and roughly 1,400 lines of the shells (ONInkView, ONPinchOverlay, the frame-rate
booster, OpenNoteInkPlugin) exist only to work around the web view.

## What it would cost

- **Size.** This is by far the largest piece of work in the repo's history: an estimated
  40,000–60,000 lines of Rust, months of focused work, not weeks.
- **Features the browser gives for free become ours:** rich-text editing (selection handles,
  copy and paste, IME, autocorrect, dictation, Apple Pencil Scribble in text boxes),
  accessibility, and right-to-left text.
- **Formulas may lay out slightly differently** from KaTeX. Stored notes keep their LaTeX, so
  this changes how they look, not what they contain.
- **Two apps during the transition.** Any feature added to the TypeScript app meanwhile has to
  be ported too. Feature work should be paused or kept small.
- **Slower iteration:** no hot reload, longer builds, and Rust cross-compiled for iOS from Linux.
- **The ink engine.** The Rust port first reproduces the TypeScript engine exactly (the golden
  file to 1e-4 px, and the recordings); improvements to it come after, measured as CLAUDE.md's
  "The ink engine" asks, never mixed into the port.

## Roadmap

Each phase ends at a gate: the checks named there pass before the next phase starts. The
TypeScript app stays the shipping app until Phase 6.

### Phase 0: decisions and spikes (go / no-go)

- [x] **Repository:** the `opennote-rs` branch of this repository, so it keeps the history, the
  recordings, the golden file and the benches. (The port started in a separate repository,
  `GGStonks/OpenNote-rs`; on 2026-11-12 everything in it was brought onto this branch and that
  repository was retired. Its AGENTS.md is docs/rust-agents.md.) The Cargo workspace is at the
  root next to `src/` (`crates/`, `spikes/`), and the TypeScript app stays runnable there as the
  reference until Phase 7. Same app ids (`com.opennote.app`), so the Rust app installs as an
  update. Crates that build and pass also go to `main`'s `crates/`.
- [x] **Toolchains:** `aarch64-apple-ios`, `aarch64-linux-android` and `armv7-linux-androideabi`
  are installed, with `cargo-ndk`. iOS links on Linux with the iPhoneOS 16.5 SDK and `ld64.lld`
  through `scripts/ios-linker.sh` (`.cargo/config.toml`). Verified 2026-11-12: `spike_a_ink`
  builds for `aarch64-apple-ios`, and with `ANDROID_NDK_HOME` set (cargo-ndk does not read
  `.cargo/config.toml`'s `[env]`) as `.so` for arm64-v8a and armeabi-v7a.
- [ ] **Rust inside the current app** (added 2026-11-12): before the Rust app exists, test builds
  of this branch (`X.Y.Z-rs`, GitHub prereleases) carry the crates into the TypeScript app, so
  Rust runs on the devices from now on. The ink engine stays TypeScript there: porting it into
  the app waits until the rest runs well.
- Spikes, each a small throwaway program on the real devices. `spikes/` has a program for each,
  but all of them run on the PC only, and A, B and F print fixed text (expected latencies, a risk
  list, a toolkit score table) rather than measuring anything:
  - [ ] **A. Ink:** a Rust `UIView` with 240 Hz Pencil samples, drawn by `wgpu` at 120 Hz on the iPad
    Pro and on the Android tablet. Measure pen-to-pixel latency against 2.9.3. Written so far: a
    sample ring buffer and its throughput on the PC; no view, no `wgpu`, no device.
  - [ ] **B. Text box:** rich text editing with `parley`, the keyboard, IME, dictation and Scribble on
    iOS (`UITextInput` through `objc2`), the keyboard and IME on Android. This is the riskiest
    spike. Written so far: one `parley` layout on the PC; no editing, no text input.
  - [ ] **C. Formulas:** lay out the LaTeX of every formula in the owner's notes with Typst's math
    (through `mitex`). Count failures and compare against KaTeX images. Written so far: LaTeX to
    Typst conversion with a pass count; no layout, no comparison with KaTeX.
  - [ ] **D. PDF:** render the sample PDFs with `hayro` and with PDFium. Compare fidelity, speed and
    app size. Written so far: `hayro` parses and renders a PDF on the PC, with timings; PDFium
    not tried, nothing compared.
  - [ ] **E. TikZ:** run TikZJax's `tex.wasm` in `wasmi` on the iPad and time a typical picture.
    Falling back to the conversion server is acceptable. Written so far: `tex.wasm` loads and
    validates in `wasmi` on the PC; no picture is typeset.
  - [ ] **F. UI toolkit:** the editor's top bar, a popover and the library grid, on iOS, Android and
    desktop, with a `wgpu` canvas embedded. Candidates: Slint, Dioxus Native (Blitz), Makepad.
    Criteria: iOS and Android support, IME, accessibility, embedding our own GPU canvas, and
    licence. Written so far: a scored table of toolkits; no UI built.
- [ ] **Gate:** spikes A, B and F work on the devices; C, D and E have
  a chosen route. If B or F fails, stop here: that is the cheap point to decide against.
  Not met: no spike has run on a device.

### Phase 1: the core, no UI

Crates, in `crates/` (`cargo test --workspace` passes):

- [x] `nib`: the ink engine, exact (see the gate).
- [x] `ink`: densify, width, smoothing, spline, dashes, geometry, live stroke, precision eraser.
  Not yet: 2.9.4's smoothing width that follows the sample spacing (`smoothSigma`).
- [x] `model`: the types in `types.ts`, sheets, migrations, packed points, the `.opennote` codec.
- [x] `store`: SQLite (notes, folders, tags, files, thumbnails, audio, backup).
- [ ] `shapes`: recognition (lines, arrows, polygons and regular polygons, ellipses, circles,
  parabolas), shape edit, selection and z-order are written. Not yet: the smart pen.
- [ ] `import`: text, LaTeX, Word (`.docx`), Notability `.note` (zip and plist) and `.ntb`
  (FlatBuffers) are written. Tests use made-up inputs only (text, LaTeX, a made-up `.docx`, the
  FlatBuffers reader); `.note` has no test, and none runs on the sample notes and documents.
  Not yet: pictures.
- [x] `svg`: export of strokes, fills, dashes, text and image blocks, pages.

- [ ] **Differential testing:** a Node script in the repo runs the TypeScript code on a corpus (the
  recordings, the sample notes, the `.docx` and `.note` files) and writes its outputs as JSON;
  `cargo test` compares the Rust results with them. Done for the ink pipeline on the
  recordings (`npm run bench:rustref`); the Rust test reading it (`crates/ink/tests/reference.rs`)
  is not written, and no other module has a reference yet.
- **Gate:**
  - [x] `engine-golden.json` matches to 1e-4 px (`crates/nib/tests/golden.rs`: finished line,
    `nibStroke`, and the live line hash for hash, all asserted).
  - [ ] `bench:look`, `bench:hooks`, `bench:overshoot` and `bench:leadend` give the same numbers on
    the recordings. The Rust figures match 2.9.3's on the four October recordings
    (`crates/ink/tests/benches.rs`); 2.9.4's smoothing is not ported yet.
  - [ ] The storage round-trip test passes. Rust's own round trip passes (the recordings, packed
    and unpacked, exactly); not yet run on data written by the TypeScript app.
  - [ ] A backup written by 2.9.x reads back identically, and the other way round.

### Phase 2: one renderer

- [x] Paper patterns and colours, every stroke kind (fountain, ballpoint, highlighter multiplied
  under the ink, dashes, fills and holes, arrows), z-order, the selection glow. Thumbnails come
  from the same renderer, offscreen. (`crates/renderer`: an SDF capsule rasterizer on the CPU
  into an image; no GPU, no `wgpu` yet.)
- [ ] Pictures.
- [ ] **Gate:** pixel comparisons against the TypeScript app's screenshots (from `bench:ui`) for every
  stroke kind and zoom, within the tolerance `glcompare` uses now. Not met: the tests check that
  every `glcompare` stroke kind draws ink, not what it looks like next to the TypeScript app.

### Phase 3: writing on the devices

Not started.

- iOS app in Rust (`objc2`): 240 Hz coalesced Pencil samples, lift handling, palm rejection,
  double tap, haptics.
- Android: a thin Java activity (some Android APIs need it), with `MotionEvent` history passed to
  Rust over JNI.
- The editor: scroll, momentum, pinch, fit to width, the pen, highlighter, eraser (stroke and
  precision) and lasso (move, resize, rotate, end handles), hold-to-snap, undo, autosave.
- **Gate:** an internal build that writes and edits real notes; latency at or below spike A's; the
  existing pen benches pass on input recorded on the devices.

### Phase 4: blocks

Not started.

- Text boxes on the Phase 0 B design: lists, checkboxes, styles, padding, background.
- Formulas, including `colorByInk` on the new layout.
- TikZ, pictures, PDF pages (lazy, sharp at any zoom), Insert PDF.
- The conversion server client, using the same headers as `serverHeaders`.
- **Gate:** the owner's notes open and look right, page by page, against 2.9.x's PDF exports.

### Phase 5: the rest of the app

Not started.

- Library: folders, tags, search, sort and filter, thumbnails.
- Page manager, bookmarks, paper picker, settings, themes, recordings.
- Export (PDF, SVG, `.opennote`), print, Save to… and Share.
- Imports: "Import file…", iOS "Open in", Android "open with".
- Safe areas and cutouts, the Android back button, launch screens, the crash log and diagnostics.
- **Gate:** a parity checklist built from README.md and CLAUDE.md, every item ticked or
  consciously dropped with the owner's agreement.

### Phase 6: migration and beta

Not started.

- On first start, the Rust app reads the old app's IndexedDB once, through a hidden web view at
  the old origin (`opennote://app` on iOS, Capacitor's origin on Android), and copies everything
  into SQLite.
- The last TypeScript release also writes a full backup into the app's folder, as a fallback.
- Beta builds next to 2.9.x, released as 3.0.0 once the owner has used it daily without
  regressions.
- **Gate:** no lost notes in the migration test (a library of over 3,000 strokes per note, PDFs,
  recordings, folders, tags).

### Phase 7: retire the TypeScript app

Not started.

- Remove `src/`, the Capacitor projects and the web benches. Keep the golden file and the
  recordings.
- Update CLAUDE.md: the engine is the Rust `nib` crate, with the same golden test and benches.

## How I would work through it

- One phase at a time, each crate with its tests before anything depends on it. Commits and
  releases only when you ask, as now.
- The existing benches stay the definition of right: nothing is "done" until it matches the
  TypeScript app's numbers or images, or you have accepted the difference.
- Every gate is reported with its results, and you decide whether to go on.

## The alternative worth weighing

The biggest gains above (latency, frame rate, one renderer, memory, printing) come from drawing
the page natively, not from the language. A Rust core with a native Rust canvas could keep the
web view for the menus and dialogs. That is a hybrid with its own compositing problems (the
native ink overlay is already one), so this roadmap goes for the full rewrite you asked for.
Phase 0 is the point to change course cheaply if spike B or F shows the full rewrite is too
costly.
