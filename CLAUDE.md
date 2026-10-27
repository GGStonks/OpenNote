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
While the pen is down the shells also draw a lead, from the modelled line's end to the stylus's
newest sample while it presses (> 2% force; dropped on a move without force). The engine's
finished line ends short of it (median 1.4, p90 6 page px on real recordings, `npm run
bench:leadend`), so dropping the lead at lift pulled the ink's end back, several screen px zoomed
in. Now the shells keep it until the page's `l,id[,x,y]`: the page tracks the same lead
(`nativePencil.lead`) and the finished stroke runs straight on to it (`Stroke.penEnd`: its last
point is that sample, not modelled; `penEnd()` / `strokeGeometry` in strokeRenderer.ts, after the
smoothing). `--native --only leadend` checks the message and the stored stroke.
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
  A failed call logs `launch-theme-failed` to the crash report. The mark (`launch_icon.xml`, from
  public/favicon.svg) is centred at its own size on every screen shape: the old full-screen
  splash.png was stretched on 20:9 phones.
- The safe area is `--sa-top/right/bottom/left` (index.css), never `env(safe-area-inset-*)`: iOS
  fills them from env(), the Android shell sets them from its insets (cutout, bars that stay shown;
  MainActivity `keepClearOfSystemBars`), as Android's WebView gives no env() values. The app draws on
  the whole screen; bars pad their controls by these and `#root` keeps the sides free. Capacitor's
  SystemBars must keep `insetsHandling: 'disable'` (capacitor.config.ts): on WebViews without
  safe-area support it padded the window by the cutout and bars, and repainted it with the static
  theme's colour (grey bands on 20:9 phones, a light start before an OLED app); MainActivity
  re-applies the theme's colour after it. An emulator (`~/.android/avd/on20x9`, Pixel 7, API 35,
  headless) shows the launch and insets; driving the WebView: `adb forward` its
  `webview_devtools_remote_<pid>` and raw CDP (Playwright cannot attach). Headless qemu crashes on
  any display change (rotation, cutout overlays).
- The device's back (Android button or gesture) goes back one step: whatever can be closed
  registers with `useBack(active, close)` (src/services/backStack.ts) while shown, MainActivity
  asks `window.OpenNoteBack()`, which closes the newest (menus, popovers, dialogs, sheets, the pages
  panel, the selection, then the note as its back button), and moves the app to the background
  only when nothing was open. New closable UI must call useBack. `--only back`.
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
- `npm run bench:pen` — synthetic pen benchmark; `npm run bench:replay -- bench/recordings/<file>.json` — real recordings (Settings → Diagnostics → Record pen strokes → Send to PC)
- `npm run bench:overshoot` — real recordings through the whole pen pipeline (densify, engine, smoothing): how far the ink strays from the pen's path, and corners after the pen rests
- `/home/ds/AI/OpenNote_release.sh` — builds APK + IPA, tags and publishes the GitHub release
