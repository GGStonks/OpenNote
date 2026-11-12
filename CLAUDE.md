# OpenNote — notes for Claude

## The ink engine

`src/ink/engine/` (Nib: `nib.ts`, `liveStroke.ts`, `geometry.ts`, `index.ts`) is the handwriting
model. The owner wants it as good as possible: it is changed whenever a change makes the ink
measurably better. Tag `nib-engine-v1` is the original (OpenNote 1.8.5), the baseline to compare
with. Changes so far: 2.9.2 `polyFit0` solves in preallocated buffers with plain products (5.7x
faster, output within 3e-11 px of Nib v1).

- An engine change shows its gain on the owner's recordings and loses nothing elsewhere: run
  `bench:look` (accuracy, wobble, end while writing, live = finished point for point), `bench:hooks`,
  `bench:overshoot`, `bench:leadend` and `bench:pen` (synthetic strokes with ground truth) before and
  after, and put the numbers in the commit message. A trade (better here, worse there) is the owner's
  call: show it and ask.
- `npm run test:engine` compares the engine's output (live, finished, nibStroke) on fixed strokes with
  `bench/engine-golden.json` to 1e-4 px, and `npm run build` runs it first: no engine change reaches a
  build by accident. After a deliberate change that passed the benches, regenerate the reference
  (`npm run test:engine -- --update`) in the same commit as the change; never to make a difference
  nobody can explain go away.
- `.claude/settings.json` allows agent edits to `src/ink/engine/**` and the reference; to let
  Claude work on the engine the owner moves those entries from `deny` to `ask` (each edit then waits
  for the owner's confirmation).
- The live stroke must stay the finished stroke (`bench:look` live = finished), and the engine
  self-contained (nothing in it imports the app). Features that need ink (shape tools, retracing,
  Android, …) use it through `src/ink/engine/index.ts` (`NibModeler`, `nibStroke`, `LiveStroke`,
  geometry helpers).
- The engine must behave the same on iPad (iOS shell 240 Hz samples, `src/ink/nativePencil.ts`) and
  Android (Chromium coalesced pointer events): platform differences are handled in the input layer
  (`src/components/CanvasPage.tsx`), never inside the engine.

## Rust in the app (opennote-rs branch)

The branch's builds (`X.Y.Z-rs`, GitHub prereleases only) carry the Rust library `crates/native`
into the app: the iOS shell links it statically (`scripts/build-ios.sh`, `rust` command of the
`opennote` handler), Android loads `libopennote_native.so` (`OpenNoteRustPlugin`, built into the
git-ignored jniLibs by `scripts/build-rust.sh`: run it before an Android build, or the plugin
reports the library missing and the page stays on TypeScript). One framed call for both
(crates/native/src/lib.rs), `src/services/rustCore.ts` the page's side, binary both ways: iOS
POSTs to `opennote://app/__rust/<method>` (ONSchemeHandler), Android posts array buffers to
`OpenNoteRustPort` (addWebMessageListener). Base64 through the message bridge is only the fallback
(old WebViews, a failed POST): on a Galaxy Tab A8 it spent ~1.5 s moving a 54,000-point request,
more than Rust's own work (1.7 s, against TypeScript's 3.1 s on the main thread). Rust compiled to
WebAssembly was measured too: barely faster than TypeScript in V8 (2.2 against 2.4 µs per point;
native 1.1), its `exp`/`atan2` are software there. The logs say which route (`via`). Rust computes every stroke's
drawn line (`strokeGeometry`'s cache, `prepareGeometry`) before the GPU ink is prepared
(usePinchInk) and before a thumbnail is drawn (thumbCache), off the main thread; the live line
while writing stays TypeScript. That line must be TypeScript's point for point:
`crates/ink/tests/reference.rs` against `npm run bench:rustref -- bench/rust-ref/ink.json` (every
kind of stroke), and Rust ports `Math.hypot` as `js_hypot` (libm's last bit flipped a smoothing
window). Settings > Diagnostics: "Rust ink preparation" (off: TypeScript, localStorage
`opennote_rust`) and "Rust check" (the largest note both ways: same lines, times; `rust-check` in
the crash report, each preparation `rust-geometry`). `npm run bench:ui -- --only rustcore` (alone:
a stand-in iOS shell answering with the real library, binary; `BENCH_RUST_VIA=base64` the fallback), `crates/native/tests/jni/run.sh` (the JNI
entry point from a JVM). On 2026-11-12 the headless emulator (`on20x9`, swiftshader or guest GPU)
crashed as this build started (qemu itself, exit 139): the Android side is checked from the JVM.

## Native live ink

In the apps, the stroke being written is also drawn natively above the web view (lower pen latency):
`src/ink/nativeInk.ts` sends LiveStroke's points to `ios-native/OpenNoteShell.m` (`ONInkView`) and
`android/.../OpenNoteInkPlugin.java`. Each stroke has an id: the shells keep a finished stroke on
screen (also while the next is written) until its own `e,id`, plus ~60 ms, as the page's copy
reaches the screen after the page's frame (clearing earlier made ink blink at 60 fps).
`npm run bench:ui -- --native --only pen` checks every stroke is ended by id.
While the pen is down the shells also draw a lead, from the modelled line's end to the stylus's
newest sample while it presses (> 2% force; dropped on a move without force). The engine's
finished line ends short of it (median 1.4, p90 6 page px on real recordings, `npm run
bench:leadend`), so dropping the lead at lift pulled the ink's end back, several screen px zoomed
in. Now the shells keep it until the page's `f,id,…`: the page tracks the same lead
(`nativePencil.lead`) and the finished stroke runs straight on to it (`Stroke.penEnd`: its last
point is that sample, not modelled; `penEnd()` / `strokeGeometry` in strokeRenderer.ts, after the
smoothing). Never drop the pen end or the lead at the lift to stop an "overshoot": the stroke then
stops short of the pen (`npm run bench:leadend`: median 1.3, p90 5.5, max 21 page px), as a
2.9.4-rs commit did. At the lift the page sends the stroke it saves (`f,id,x,y,r,…`:
`strokeGeometry`, pen end included) and the shells show exactly that in place of their live line,
whose end was the engine's provisional tail: the end used to jump, zoomed in, when the page's copy
took over a few frames later (`l,id[,x,y]` is still understood, from older pages).
`--native --only leadend` checks the message and the stored stroke; `--native --only inkplace` that
the shell and the page put the same page point at the same screen point at every zoom.
On the opennote-rs branch the shells compute the pen's line themselves, in Rust, from their own
samples (`r` instead of `b` + `u`: crates/native/src/live.rs, `ONInkView` / `InkOverlay`): the line
reaches the pen on every touch event (iOS 240 Hz) instead of a page frame later, behind a shorter
lead. The page sends `r` once per stroke made of shell samples (`d.nativeSeen`) when the shell has
`rustInk` (iOS `OpenNoteNative.rustInk`, Android `OpenNoteInk.rustInk()`): the canvas's rect, page
size, nativePencil's clock offset and the stroke's first sample's time, as exact numbers; the shell
feeds Rust the very numbers it sends the page (formatted, parsed back) and repeats the page's
arithmetic (`toPoint`, `ingestSamples`), so its line is the page's (`--native --only rustlive`: the
`u` line and the Rust line on the same samples, 1,011 points, equal to u's 0.01 rounding). Finger
strokes, dashes and shapes keep `b` / `u` / `d`. `crates/native/tests/live.rs` (the session against
the reference's live lines), `tests/jni/run.sh` (the Android entry points).
Shapes being drawn (Draw tool, snapped strokes) are sent whole on every event (`d` messages,
`src/ink/inkRecorder.ts`); `npm run bench:ui -- --native --only shapepen` measures the page's side.
The Draw tool's free curve is densified like the pen, and when the pen lifts the shell is sent the
finished curve (the spline) before it clears: shown with the page's for two frames, the live line
doubled the curve where they differed. `--only curveshots --shots <dir> [--native [--late] | --web]`
(fast curves with simulated shell Pencil samples, or web events only).
Both shells mirror the engine's capsule geometry (`addCapsule`);
if the engine's look ever differed from them, the fix belongs in the shells, never in the engine.

## Frame rate

Never assume 60 fps. `src/services/frameRate.ts` measures the rate the page actually gets (the
highest run of frames seen, after start-up and on each return to the screen); work done a slice per
frame (tile painting, GPU ink preparation) is sized from `frameRate.frameMs`, and animations use
elapsed time. iOS: the shell lifts WebKit's "near 60 fps" cap where the display is faster than
60 Hz (`OpenNotePageRate` "auto"); if the page then measures under 50 fps (outside Low Power Mode)
it is recorded and the next start keeps the cap. Settings > Diagnostics > Page frame rate overrides.

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

## PDF and Notability import

"Import file…" (hold the library's + button; the file input has no `accept` list: Android and iOS
pickers greyed out .note / .opennote files) imports PDFs, Word documents, Notability notes,
.opennote, pictures and text (App.tsx `importExternal`).

- iOS: OpenNote is offered for these files by other apps ("Open in…", the share sheet's apps,
  Files): Info.plist `CFBundleDocumentTypes` (PDF, Word, pictures, text, Notability as an imported
  type `com.opennote.notability-note`, .opennote as OpenNote's own `com.opennote.note`). The shell
  (`application:openURL:options:` → `receiveFile`) copies the file (security-scoped, coordinated)
  into tmp/inbox/<id>/ and serves it at opennote://app/__inbox/…; the page asks for them at start
  and on `opennote:openFiles` (platform.ts `listenForOpenedFiles`, bridge `pendingFiles` /
  `inboxDone`) and imports them as notes. Not on Android yet.
- Word (`src/import/docx.ts`, .docx; .doc / .rtf / .odt / .pages are refused with how to convert):
  a rich text box per paragraph on pages of the document's size and margins, laid out from the top
  margin down as Word does (spacing before / after, line spacing, page breaks), styles resolved
  through docDefaults, paragraph and character styles (headings), lists from numbering.xml,
  pictures in the flow, tables as a box per cell with ruled lines. Heights are measured as drawn
  (`import/measureText.ts`, off screen): no box overlaps another. Headers, footers, footnotes,
  comments, text boxes, charts and equations are named as left out.
  `npm run bench:ui -- --only docximport --docx <file> --shots <dir>` (pages, boxes, overlaps).

- PDFs (`src/import/pdf.ts`): the file is kept once in IndexedDB `files` (db.ts `putFile`, with a
  protected PDF's password), and each page becomes a page of its own size (PageSheet `width` /
  `height`, which take the place of size and orientation) showing that PDF page (PageSheet `pdf`).
  `src/services/pdf.ts` draws it with pdf.js (legacy build, data in public/pdfjs from
  scripts/copy-pdfjs.mjs) from its vectors: `PdfBackground` in each page's paper draws the page at
  the fit-width zoom near the view, the part in view at the zoom once zooming rests (opaque on the
  paper: see-through, the stretched page showed through as a halo), and a preview (thumbs store,
  `pdfa|file|page`, see-through so the page's own paper shows under it) for thumbnails. Thumbnails
  (NoteThumb.tsx) draw everything the editor does: keep them in step with Blocks.tsx (e.g. a
  formula's `stretchX`). Imported notes are named after the file. Files nobody refers to go when a note is deleted (`collectUnusedFiles`); backups
  and .opennote exports carry them (`files`). The PDF export prints such pages bare and lays the
  original PDF page under them (pdfExport.ts `joinPdfPages`, pdf-lib): text stays text, on Android
  and iOS, for the export and Print… (which prints that PDF: `printPdfDocument`). iOS prints the
  layout with WebKit's print formatter into a PDF (shell `pdfPage`); a calibration print per page
  size (printCalibration.ts, two pages with marks) measures how it placed the page and the joiner
  draws pages through the inverse (`fix`); an unusable print (cut off, wrong page count, native
  error) throws PrintUnusable and the print dialog is used for the session (`pdfPrintingFailed`).
  Encrypted or damaged PDFs pdf-lib cannot read are copied plain by pdf.js (`plainPdfCopy`:
  extractPages with a blank second document, else pdf.js keeps the encryption). A web view that
  prints its own colour behind a bare page gets `on-print-white` and is multiplied; the PDF is a
  picture only when even that is coloured, or for the print dialog fallback. Pages of
  one size in a row are printed in one native call (Editor `PRINT_RUN`, page by page again when the
  print has another page count) and split here: a print per page made long notes slow. The print
  layout's named `@page` rules must have CSS-identifier names (`printPageName`): imported sizes have
  decimals, and a dotted name dropped the rule, so the page printed at Letter size and was fitted
  into its own (the ink came out smaller and lower than the PDF on A4 pages). Android's
  web view prints its own background colour behind the page; the plugin's `transparent` flag clears
  it for bare pages, and Editor.exportPdf still checks each printed page (pdf.ts
  `printedBackground`): a white page goes over the original with Multiply (isolated transparency
  group, or the page's own graphics state undoes the blend mode), a coloured one is printed again
  with its paper and no underlay. The editor's "…" menu has Insert PDF: the PDF's pages go after the
  current page (sheets.ts `insertSheets`; later pages move down with their content).
  `npm run bench:ui -- --only pdfimport --shots <dir>` (import, zoom, export joining, thumbnails),
  `--only pdfexport --shots <dir>` (the export of an A4 note: how far each drawn cross lies from
  its target dot, with `BENCH_PRINT_BG=white|#1c1c1e` for an opaque
  printed page (`…!` even over the page's white), `BENCH_PRINT_DISTORT=1` (a printer that scales
  and moves pages, as iOS's may: calibration), `BENCH_ENCRYPT=1` (an encrypted PDF),
  `BENCH_EXPORT=printpdf` (Print…), `BENCH_EXPORT=print` (the browser's print dialog); it prints
  the fonts and images in the file: images mean a PDF page went in as a picture),
  `--only pdfinsert --shots <dir>`,
  `--only pdfthumb --shots <dir>` (a PDF page's paper colour on its library card).
- Text boxes are rich text (`src/editor/richText.ts`): one HTML for the page, the editor (a
  contenteditable holding exactly that HTML, written once per editing session and read back on
  every change: React must not re-render its content), thumbnails and the SVG export
  (RICH_TEXT_CSS goes into the SVG). Paragraphs carry list kind / level / checked / number / align
  (`TextBlock.paras`, one per line of `text`), words their overrides (`spans`: weight, slant, lines,
  colour, typeface, size); the box has `background`, `radius`, `padding` (its x/y/width are the
  outside). The editor handles Enter / Backspace / Tab / paste itself (beforeinput); the formatting
  bar reaches it through `editor/textEditing.ts`. Checkboxes are ticked by a tap with any writing
  tool (CanvasPage `toggleCheck`). Typefaces: `TEXT_FONTS` (system font stacks, nothing bundled;
  `fontFromName` maps PostScript names for the importers). `--only richtext`.
- Pages can be bookmarked (PageSheet `bookmarked`: a ribbon on the page, the … menu, the Pages
  panel's filter and button; imported from Notability).
- The colour pickers' eyedropper (`services/eyedropper.ts`, Editor `colourAt`): the next tap on
  the page gives the colour of the ink, text, formula, picture pixel, PDF pixel or paper there.
- Notability `.ntb` (Notability 16's files; `src/import/ntb.ts` with `flatbuffer.ts`): a FlatBuffers
  log of records, positions per page; specified at the end of `docs/notability-note-format.md`
  (keep in step). Shares the .note importer's stroke builder (`strokeFromLine`) and text layout
  (`layOut`). Check: `--only nbcompare --notes <file.ntb>` against the file's `thumbnail.png`.
- Notability (`src/import/notability.ts` with `zip.ts`, `plist.ts`, `images.ts`): what it reads is
  specified in `docs/notability-note-format.md`; keep the two in step. Each curve is a chain of cubic
  Béziers with one fractional width per segment end; drawn width = curveswidth x fractional width;
  imported ink is ordinary strokes with `modeled: 'proportional'` (exact at any zoom). Shapes,
  partly erased shapes (path data), ink groups, pictures (crop, flip, rotation), text boxes (styled
  words as TextBlock `spans`, `align`, `lineHeight`), stickies and box colours (SVG image blocks),
  formulas, PDF pages, paper and recordings come through. Never name the app's internal code here.
  Checks: `bench/notabilityImport.ts` (Node: structure and widths against the file, see its header)
  and `npm run bench:ui -- --only nbcompare --shots <dir> --notes a.note,b.note` (each page beside
  the note's own PDF export when `<note>.pdf` lies next to it). Real sample notes with Notability's
  exports: github.com/samuelsadok/notesconverter `samples/notability`.

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
  `--only glwrite`: pinches right after writing must be drawn by the GPU (new strokes are appended to
  its buffer, not rebuilt). Each pinch's crash-log entry says who drew it (`gl`: gpu / preparing /
  no-webgl / shell). `BENCH_NO_GL=1` (localStorage `opennote_gl` = 'off') compares with the bitmaps;
  `--cpu 8` emulates a weak Android tablet.
- LaTeX blocks are laid out once at `MATH_LAYOUT` (5x) their page size and scaled to the zoom inside
  their layer (Blocks.tsx): laid out per zoom, font metric rounding moved long blocks as the zoom
  changed. `--latex --only latexshift` (with `BENCH_LATEX_BIG=1` for a long text block) must show
  the same numbers at every zoom.
- Library: stored strokes keep their points packed until read (db.ts `unpackStroke`, ranges from
  `storage/packedPoints.ts`), notes are read with a cursor (one per task), and card thumbnails show
  their ink from stored images (`services/thumbCache.ts`, IndexedDB `thumbs`), drawn in the
  background when missing or out of date. `--only library`: main-thread blocking on the home screen.
- Selections and text boxes resize with eight handles (`RESIZE_HANDLES` in Blocks.tsx): corners keep
  the aspect ratio, sides stretch one way (ink and pictures stretch, LaTeX stretches via
  `stretchX`, a text box rewraps; its font scales only at a corner). `--only resize8`, `--only boxes`.
- A long pinch commits its zoom on the way (`REBASE_RATIO` in useViewport.ts, a synchronous commit):
  everything is redrawn sharp while the fingers are down; `--latex --only longpinch --shots <dir>`.
  Never re-run the gesture effect mid-pinch (its clean-up ends the pinch): callbacks it reads go
  through refs, and the editor's scroll ref callback is stable.
- Fit to width fits the page on screen (Editor's `curSheet`), `FIT_MARGIN` px from the edges, and refits as
  pages of another width scroll in; a pinch ending within `FIT_SNAP` of that zoom snaps to it.
  `--only fitwidth` (portrait and landscape pages, pinch snap).
- Paper colour is a named colour or any `#RRGGBB` (`paperHex` / `paperIsDark` in CanvasPage.tsx), and
  `patternColor` (note or page) colours the pattern; both use ColorPicker in PaperPicker. `--only papershots --shots <dir>`.
- Angles are shown counterclockwise in [0°, 360°): selection rotation (`shownDeg`, stored rotations stay
  clockwise) and the straight line's direction (smartPenMeasure).
- A formula's colours come from the ink, not the model (`src/services/colorByInk.ts`): the model's colour
  markup is dropped, the formula laid out by KaTeX glyph by glyph, aligned with the ink symbols in reading
  order (rank-aware DTW), and each symbol takes its ink's colour (bars and radicals: their containers').
  Falls back to the model's colours (`enforceColors`) for notes with text or if anything fails.
  `--only inkcolors` (handwriting simulated from the layout with drifted spacing).
- The selection frame is an SVG rectangle of constant screen width with the handles on its edge (a CSS
  border scaled with the zoom was thick and pixel-snapped in page space, the handles off its middle).
- `--only tapshots [--steps 0,4,7]`: a held selection (GPU ink) against the page's ink at several zooms;
  each GPU drag / pinch logs `gl-geometry` (canvas, buffer, scale) to the crash report.
- Android's web view gives the scroll view real 8 px scrollbars (the styled `::-webkit-scrollbar` in
  index.css), headless Chromium overlay ones: there the scroll view's box is 8 px larger than its
  clientWidth / clientHeight. Anything drawn over it is sized and placed from its own box (the GPU
  canvases drew for the scroll view's box into a canvas of its client size: ink 0.6% smaller while
  dragged or pinched). `BENCH_GUTTER=1` (tapshots) reproduces the scrollbars.
- Translucent ink (highlighters, fills) shows anything drawn twice, which opaque ink hides. The page
  canvases are clipped out from under visible sharp tiles (`clipPages` in SharpInk: the flash at the
  end of a bitmap zoom); the live highlighter is a SmoothLiveStroke painted opaque on a see-through,
  multiplying live canvas (`liveLook`: no leftovers, under the ink as when finished), densified like
  the pen. The GPU draws a pinch's ink layer by layer (zorder.ts), as the page. `--only hlshots
  --shots <dir> [--sparse]` (live / after / zoomed, and the layers shown each frame of a pinch;
  `BENCH_NO_GL=1` for the bitmap pinch), `--only zorder` (a fill over earlier ink while pinching).
- A dragged selection is drawn by the GPU (`useDragInk`), glow included (GlInk `draw(tf, glow)`).
- After a zoom the content is placed exactly: positions from getBoundingClientRect, and the scroll
  rounding absorbed by a sub-pixel CSS `translate` on the content (only under 1 px).
- Hold to snap: the pen must be held still `PEN_HOLD_MS` (1 s; the Draw tool `SHAPE_HOLD_MS`, 0.45 s)
  and its snapped shape keeps the handwriting's median drawn width (`snapWidth`): resting the pen
  half a second at the end of a fraction bar snapped it to a thinner line that jumped. `--only penhold`.
  The highlighter, eraser and lasso snap too (armHoldToSnap): the eraser then puts back what its
  drawn line erased and erases along the shape (`eraseAlongSnapped`, again as the pen sizes it), the
  lasso selects with the shape. A closed polygon drawn nearly regular becomes the regular one
  (shapeRecognition.ts `regularPolygon`: equilateral triangle, square, regular pentagon…; a square
  keeps its sides equal while sized, SnapAdjust `regular`). An open line bending one way that fits a
  parabola (any axis) snaps to one (`detectParabola`, kept as a 'curve' through 9 of its points),
  unless a few straight sides fit it better (a wide V). One setting for all tools (Settings > Pencil
  & input); the tool popovers have no checkbox of their own. `--only toolhold`.
- Each note's view (the content point at the screen's corner, zoom, fit) is kept in localStorage
  (`opennote_note_views_v1`, Editor `saveNoteView`; on scroll, on leaving, when the app is hidden)
  and given back when the note is opened again (useViewport `viewState` / `restoreView`; a width
  fit is refitted). `--only resume`.
- Menus, popovers and pop-ups are kept on the screen on every device (`src/components/onScreen.tsx`:
  `OnScreen` / `useOnScreen`): after layout each is measured against the visible screen less the safe
  area, shortened by its button (it scrolls) or else moved in, again on any resize. New floating
  panels use it too. `--only popups` opens each one on phones (portrait, landscape, 320 px) and a
  tablet: all must be wholly on screen and closable by their own button (the + menu once hung below
  a phone's screen; the pen popover, moved up, covered its own button with the phone sideways).
- The editor's top bar fits any width by construction: after layout, if the left group (title,
  undo, redo) is covered, Paper, Export and Settings move into the "…" menu one at a time, then the
  title may shrink away (`useHeaderFold` in Toolbar.tsx, again on every resize); the tool shelf's
  buttons shrink down to 280 px screens. `--only header` checks 280-1920 px wide screens for
  overlapping or cut buttons (on a 360 px phone undo and redo slid under record and paper).
- Launch screens follow the UI theme: the app sends it at start and on change (`setLaunchTheme`,
  platform.ts) to `OpenNoteLaunchPlugin` (Android: SharedPreferences, `setSplashScreenTheme` with
  the `Launch.<Theme>` styles from Android 13, the app's night mode on Android 12, window and WebView
  colour in MainActivity) and to the iOS shell (`OpenNoteLaunchColor`, window and web view colour).
  A failed call logs `launch-theme-failed` to the crash report. Before Android 12 a launch preview
  can only have its one manifest colour, so there is none: the launch theme is see-through
  (`windowIsTranslucent` + `windowDisablePreview`, values/ only; ColorOS drew the preview even with
  it disabled), MainActivity's window is the theme's colour with the logo as a centred view (at the
  middle of the screen; as the window background it moved with the bars) over a see-through WebView
  until the page's first frame, which draws the same vector logo at the same place (index.html, then
  App's loading screen, 128 px), then the activity is made opaque (`becomeOpaque`). The launcher
  icon is vector too (`ic_launcher_gradient` + `ic_launcher_mark`). The mark (`launch_icon.xml`, from
  public/favicon.svg) is centred at its own size on every screen shape: the old full-screen
  splash.png was stretched on 20:9 phones.
- The safe area is `--sa-top/right/bottom/left` (index.css), never `env(safe-area-inset-*)`: iOS
  fills them from env(), the Android shell from system bars that stay shown (MainActivity
  `keepClearOfSystemBars`; Android's WebView gives no env() values). A camera cutout is not a band
  kept free: Android reports one as a whole strip (a waterdrop notch: the status bar's height across
  the width), which left empty bands above the top bars and beside them sideways. The shell sends
  the cutout's outline (`window.OpenNoteCutout`, CSS px) and `src/services/cutout.ts` moves only a
  control it would cover, in parts marked `data-cutout-clear` (top bars, brand row, sidebar, pages
  panel, corner buttons): a margin within its row (never overflowing the row, off the bar or onto
  another control), more padding in a row of a list, a cut-off text (the note's title, "All notes")
  giving up room, and as the last resort a `data-cutout-bar` going down by the cutout's own depth.
  New edge UI gets `data-cutout-clear` (text in it that must stay visible: `data-cutout-item`).
  `--only cutout [--shots <dir>]` (waterdrop notch, wide notch, corner hole, sideways). Before
  Android 11 the compat full-screen call adds LAYOUT_STABLE (insets keep the hidden bars):
  MainActivity clears it. Capacitor's SystemBars must keep `insetsHandling: 'disable'` (capacitor.config.ts): on WebViews without
  safe-area support it padded the window by the cutout and bars, and repainted it with the static
  theme's colour (grey bands on 20:9 phones, a light start before an OLED app); MainActivity
  re-applies the theme's colour after it. An emulator (`~/.android/avd/on20x9`, Pixel 7, API 35,
  headless) shows the launch and insets; driving the WebView: `adb forward` its
  `webview_devtools_remote_<pid>` and raw CDP (Playwright cannot attach). Headless qemu crashes on
  any display change (rotation, cutout overlays on API 35). Android 10 (the owner's Oppo A53s):
  AVD `a53s` (720x1600, API 29, the "tall" cutout overlay); its WebView is Chrome 74, so test with
  `npx vite build --target chrome74` + `npx cap sync android` + assembleDebug (never release that).
- The device's back (Android button or gesture) goes back one step: whatever can be closed
  registers with `useBack(active, close)` (src/services/backStack.ts) while shown, MainActivity
  asks `window.OpenNoteBack()`, which closes the newest (menus, popovers, dialogs, sheets, the pages
  panel, the selection, then the note as its back button), and moves the app to the background
  only when nothing was open. New closable UI must call useBack. `--only back`.
- SVG export (`src/services/svgExport.ts`, `layerSvg` / `svgHead`): the note's pages (ExportModal)
  and a selection (the selection bar's "Export as SVG", `SelectionExportModal`: only the selected
  items, framed by the selection, no paper) are written by the same code, and vectors stay vectors:
  strokes are paths, TikZ its own SVG (its own size attributes replaced, repeated they made invalid
  XML), text boxes and formulas XHTML in foreignObjects (serialized with XMLSerializer in the XHTML
  namespace, so the file is well-formed XML), styled by RICH_TEXT_CSS and KaTeX's style sheet with
  its woff2 fonts inside (only when a formula is in it), pictures as images. `--only selsvg --latex
  --shots <dir>` (well-formed, counts of paths / text / images, rendered on its own; the whole note too).
- Exports go through `exportFile` (platform.ts): the system save dialog (iOS Files picker,
  Android `OpenNoteSavePlugin`), with a confirmation of where, or with `mode` 'share' the share
  sheet. In the apps (`exportOffersBoth`: iOS and Android) every export offers both, "Save to…" and
  "Share" (ExportModal's `Format`, Settings' backup buttons); there is no setting for it any more.
  Android: never put file contents in a plugin call that starts an activity. Capacitor saves that
  call's data in the activity's saved state when the app goes to the background (over ~1 MB:
  TransactionTooLargeException, app killed, the chosen file left 0 B). The file is staged in chunks
  first (`stage`), and `save` carries only its id. Exports log `export` / `export-saved` to the crash report.
- Zoomed in, memory must follow the screen, not the zoom: page canvases stay
  at the fit-width zoom and SharpInk's tiles (no canvas where there is no ink) draw the rest.
- Finished ink is drawn as vectors by default (`src/ink/vectorInk.ts`, Settings > Pencil & input >
  Vector ink): each page's strokes are an SVG (`VectorInk` in CanvasPage, one memoized element per
  stroke from `strokeSvgParts`, in drawStrokes' order), painted by WebKit at the screen's resolution
  at every zoom, so no SharpInk. The bitmaps below (page canvases, SharpInk) are the fallback (setting
  off, `BENCH_VECTOR=off`) and for layers with a "hole" fill. The user saw the bitmap ink go soft at
  lift even when it was 1:1. `--only svgcompare` (SVG against the canvas, every kind of stroke).
  Each page's SVG is laid out at its size on screen (zoom x page, `layoutZoom`) and scaled back by
  1/zoom as a layer of its own (Blocks.tsx `ScreenScaled`, as formulas): WebKit rasterises a layer
  inside the CSS-scaled page at its laid-out size and stretches it, so the 2.4.11-2.8.1 SVG, laid
  out at page size, was a bitmap magnified by the zoom on the iPad (pixelated zoomed in). Headless
  Chromium re-rasterises and never shows it: `--only liftshots` prints each page's `vector ink on
  screen` scale, which must be 1.0000 at every zoom (the old layout measured 3.81 at 381%); the
  crash log's `ink-grid` carries the same (`vectorScale`) from the device.
- Visible ink is never resampled: the page canvases are drawn at exactly the zoom fitting the width
  uses (`fitZoom` in CanvasPage = useViewport's `FIT_MARGIN` formula, `canvasRatio(..., exact)`), and
  SharpInk takes over as soon as the zoom is above it. Rounded to a quarter, an 816 px note view
  (iPad Pro 13" with a panel open) fit at 1.02 over canvases drawn for 1.00: every finished stroke
  was stretched 2%, soft next to the shell's native live ink (crisp while writing, blurry at lift);
  shrinking softens too. `--only liftshots [--native] [--width N] [--shots <dir>]`: the frames after
  a lift (sharpness, movement) and each page canvas's scale and device-pixel offset (`1.0000x off 0,0`
  is 1:1); the same goes to the crash report after a native stroke (`ink-grid`, every 10 s at most).
  `--zsteps a,b` picks the zooms, `--scroll N` other pages. Page tops sit at zoom x page height, a
  fraction of a device px (2.4.7 at 126%, the iPad Pro's full width: 0.16-0.39 px off, every finished
  stroke resampled): each page canvas nudges itself onto whole device px (`align` in InkTile, under
  half a px, again after each zoom: useViewport's `CONTENT_PLACED` event), as SharpInk's tiles do
  with their origin.
  Zoomed in over empty paper there are no tiles and the page canvases are hidden: SharpInk must
  still paint a new stroke there (it once returned early without tiles: the stroke stayed invisible
  after the shell's line cleared; `--native --blank --only liftshots`).
- Fountain-pen width (`src/ink/inkWidth.ts`, outside the engine): pressure 0.61x-1.55x, calibrated
  on the owner's recordings so everyday writing keeps its weight (the engine's `pressureWidth` is
  only its own painter's), from the force averaged along the line (`PRESSURE_SIGMA`, 2 px).
  2.9.0 also narrowed fast strokes (speed over a few px): the Pencil's timing jitter made the width
  twitch (roughness 1.8x 2.8.2's) and the line's end near the pen wriggle as it settled (the user's
  "serpent"); 2.9.1 removed it: roughness a quarter of 2.8.2's, the end settling no more than 2.8.2's.
  2.9.3 adds the nib (the owner found the ink "rigid", a felt tip): an elliptical nib (`NIB_RATIO`
  1.9, edge `NIB_ANGLE` 28° as a right hand holds it) makes downstrokes full and joining strokes
  fine; scaled by the direction mix of real writing (`WRITING_DIRECTIONS`) so the weight stays
  within 1%. The direction is causal (the line behind the point only): measured on both sides, the
  end of the line changed width while writing (the serpent again). The widths are drawn as
  inkWidth.ts makes them: `smoothLine` moves points but no longer averages widths (averaged again,
  the settled end changed width once more). A point's width depends on `WIDTH_AHEAD` of line after
  it (`SMOOTH_SETTLE` covers 3 sigma + it, so the live line's final part, and the native ink, which
  draws its widths, is the finished stroke exactly) and `WIDTH_BEHIND` before it (the context a run
  of the line needs, smoothLiveStroke); widths are computed on the whole modelled line, then thinned.
  The last `SMOOTH_SETTLE` of a line stays as modelled, live and finished: smoothing it (with a
  narrowing window, or a local linear fit) turned curled ends into hooks or made the end swing.
  Stronger `SMOOTH_SIGMA` costs accuracy for little smoothness. The smoothing is as wide as the
  samples are apart there (`smoothSigma`: the line's speed x the Pencil's 4.17 ms, 1.25x, between
  0.25 and `SMOOTH_SIGMA` page px): it only rounds the engine's corners at the samples. At one
  width for all, ink written zoomed in lost the hand's detail, and the line jumped to its smoothed
  place as each point settled: the user's "serpent" in the last 1-2.5 cm at 350-500% (5 device px,
  now 1.3; measure with a recording's own zoom, its samples carry it). `npm run bench:look`: accuracy,
  wobble, width range, nervousness (width roughness: counts the nib's thick and thin too), ripple
  (width jitter within 3 px only), the end moving while writing and live = finished (both point
  for point: matched by place, a letter crossing itself paired different passes), on the
  recordings; `npm run bench:hooks` for the ends. Thumbnails carry the look (`thumbCache`
  `INK_LOOK`): bump it when the ink's look changes.
- Line styles (`LineStyle`: solid, dashed, long dashes, dotted, dash-dot) for the pen (tool option
  `penLineStyle`), the Draw tool and the selection bar (`components/LineStyles.tsx`). One pattern
  (`dashPattern` in strokeRenderer.ts, TikZ too) and one walker (`dashRuns`: the line's runs, cut at
  the pattern's ends) for canvas, SVG, GPU and live ink: dashed handwriting keeps the fountain pen's
  width in its dashes, its dots 1.25x the ink there; stroked lines (shapes, highlighters) keep the
  canvas's dashes (dots a 0.1 px dash, so the GPU matches the canvas). Dashed pen strokes are drawn
  live whole each frame (SmoothLiveStroke `paintDashes`; the shells get them as a drawing, `d`
  messages: no lead). Precision-eraser pieces carry their place in the pattern (`dashOffset`).
  `--only svgcompare` / `glcompare` include pen dashes and dots.
- Selected alone, a handwritten stroke (pen, highlighter, open) has a handle at each end of its
  drawn line (shapeEdit.ts role 'end'): dragging one moves that end, the stroke turned and scaled
  about the other end (its width kept), snapping to other shapes as shape handles do. `--only
  endhandles`.
- `npm run bench:pen` — synthetic pen benchmark; `npm run bench:replay -- bench/recordings/<file>.json` — real recordings (Settings → Diagnostics → Record pen strokes → Send to PC)
- `npm run bench:overshoot` — real recordings through the whole pen pipeline (densify, engine, smoothing): how far the ink strays from the pen's path, and corners after the pen rests
- `npm run bench:hooks` — real recordings: a stroke's end turning back where the pen did not. The points given to the engine (strokeRenderer.ts `enginePoints`) leave out a pressured stroke's trailing samples without force (the Pencil in the air after its lift) and a finger / mouse stroke's lift sample when it turns back (Android reports it ~25 ms late, a few px back along the path): both made a hook at the end of quick strokes
- `npm run test:rust` — the Rust port's crates (`crates/`; what each is checked
  against: docs/rust-status.md). Not part of `npm run build`: the app does not use them yet.
- `npm run bench:rustref -- <out.json> [--per N]` — reference outputs of the ink pipeline on the
  recordings (densify, enginePoints, nibStroke, inkWidths, strokeGeometry, live line, dash runs,
  precision eraser) for the Rust port (branch `opennote-rs`): its
  tests compare with these, not with themselves. Exported helpers it reads (`enginePoints`, `inkRuns`)
  stay exported.
- `/home/ds/AI/OpenNote_release.sh` — builds APK + IPA, tags and publishes the GitHub release
  (procedure for every agent: docs/releasing.md; `node scripts/release.mjs bump|verify X.Y.Z` writes the
  version everywhere and checks the published release)
