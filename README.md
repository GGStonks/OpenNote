# OpenNote

<div align="center">
  <h3>An offline-first, Notability-style notebook for iPad, iPhone and Android</h3>
  <p><b>Pressure-sensitive Apple Pencil / S-Pen ink • Handwriting → LaTeX and TikZ with your own Qwen3-VL • Real TeX rendering of TikZ on device</b></p>
</div>

---

## Features

**Note taking (Notability-style)**
- Library with subjects, search (titles, typed text, LaTeX source), thumbnails of the first page (ink, images, math, TikZ, text), rename / move / duplicate / delete, backup & import. Android's cloud auto-backup is off (it restored stale notes on reinstall): use Backup to keep or move notes.
- **One continuous canvas cut into pages**: ink, shapes, lasso and eraser cross page lines freely, and as soon as you write on the last page a blank one follows it. Each page has its own paper: pattern (blank, ruled, narrow ruled, squared, graph, dotted), colour (white, cream, yellow, ochre, blue, green, pink, grey, dark), orientation (portrait / landscape) and size (Letter, Legal, A3, A4, A5, B5); narrower pages are centred on the canvas. The toolbar's Paper menu sets the note's paper, used by new pages and every page without paper of its own. Page operations move what sits on a page (an item belongs to the page holding its middle). PDF export cuts the canvas at the page lines, each page at its own size.
- **Zoom** from 50 % to 500 %: pinch with two fingers (about the point between them), ctrl + wheel / trackpad pinch, or ⌘+ / ⌘− / ⌘0. The note opens fitted to the width; the button in the bottom-right corner fits the width, and when already fitted fits the whole page. Above 250 % ink is drawn as vectors, sharp at any zoom. Scrolling with two fingers (or one finger when "pencil only" is on, or the hand tool) has momentum and goes sideways when zoomed in.
- **Pull up to add a page**: drag (or scroll) past the end of the last page; an indicator fills up and a new page is added when it is full.
- **Page manager** (sidebar button next to the back button): live thumbnails of every page (ink crossing a page line shows on both); tap to go to a page, "Select" (or ctrl / ⌘ / shift-click) for several; drag a page by its grip (or with the mouse) to reorder; paper, duplicate, copy, cut, paste (into any note) and delete for the selected pages.
- Two-finger tap = undo, three-finger tap = redo (Notability gestures; can be turned off in Settings).
- Colour picker for pen, Draw tool and highlighter: presets, full spectrum + hex, and favourite colours (kept on the device).
- Text boxes (kept when you tap elsewhere; removed only if empty), images, add / duplicate / delete pages, undo/redo (whole gestures are one step), keyboard shortcuts (1–6 tools, ⌘Z / ⌘⇧Z).
- Audio recordings per note (record, list, play, delete).

**Pencil & ink**
- **Handwriting engine (Nib, OpenNote's own, `src/ink/nib.ts`)**: every Pencil sample is smoothed with the samples on *both* sides of it (a speed-adaptive local quadratic fit, zero phase), so the line has none of the lag distortion of causal filters: corners stay sharp and small loops keep their size. The window spans about ±5 px of line (14–70 ms) and fades out smoothly in time and distance, and the curve is that fit evaluated continuously (no spline kinks at the samples). Settled ink never moves; near the pen the ink blends from the raw Pencil position into its final shape. There is no prediction: the ink never runs past where the pen is. The live stroke is painted as one fill (settled ink and the settling end together) in the region that changed, so it looks exactly like the finished stroke. **The ink stops where the pencil lifts:** samples without force (the pen in the air) are never ink, and trailing samples whose force fades under half the stroke's median are held back while drawing and dropped at the end. Strokes land at full width (the Pencil under-reads force on its first samples) and keep their body width as the pen eases off; the fountain pen's width spans 0.72×–1.3× of nominal and is rendered as the exact union of pressure-sized capsules. Tuned on real Pencil recordings (`npm run bench:replay`, Settings → Diagnostics → Record pen strokes) and synthetic handwriting with ground truth (`npm run bench:pen`). Highlighter drawn behind ink, custom colours.
- **240 Hz Apple Pencil capture on iPad**: WKWebView only delivers pointer events once per display frame (60/120 Hz) and has no `getCoalescedEvents`, so the iOS shell reads the Pencil natively (a passive gesture recognizer, `coalescedTouchesForTouch:` + `predictedTouchesForTouch:`) and streams every sample — precise location, force, altitude, azimuth and its own timestamp — to the ink engine (no platform prediction: Nib predicts the pen itself). Strokes end on the Pencil's real lift-off samples, and a force-less sample is treated as lift-off instead of being drawn at medium pressure. Android (Chromium) gets every sample through coalesced pointer events, each with its own timestamp; samples whose timestamps arrive bunched together (some WebViews) are spread over the time since the previous sample before they reach the ink engine, so the same engine draws the same ink on both platforms.
- Per-point pressure, timestamps, altitude and azimuth are stored — the same per-point channels Notability's `InkObjectEncoder` serialises.
- Palm rejection: in "pencil only" mode fingers navigate; a pencil touching down cancels a palm stroke in progress.
- Coalesced + predicted pointer events for low-latency ink; Apple Pencil double-tap toggles the eraser (iOS shell).
- Stroke eraser and precision (partial) eraser that splits strokes; the pieces keep the exact ink (width, pressure) up to the cut.
- Immersive fullscreen on Android and iOS (no status / navigation bar).
- **Smart pen**: the smart curve is drawn by the same ink engine as the pen (Nib), at uniform width — smooth, never snapped sample by sample. Its ends snap to nearby shape points; coming back to the start (or a little past it) **closes it automatically** (snap dot and haptic tick), cut where it meets its start. **Retracing:** where the smart curve runs along the outline of an existing shape (within 8 px, for 20 px or more), it lies exactly on that outline, easing on and off it. Also lines with 15° angle lock, rectangles, ellipses from the centre with circle lock, points; lines, rectangles and ellipses snap to the key points, edges and crossings of existing shapes and, on grid / dot paper, to the paper's lattice, and show their live size (cm, angle). The Draw tool has its own colour (shown next to its icon), independent of the pen. Snapping also takes the curve's own line (its corners, then its nearest point), and after snapping to a vertex the edges at that vertex are ignored within 40 px, so leaving a vertex along an edge does not stick to it. Lines show their tilt from the horizontal. Closed shapes take a fill (solid, //// or \\\\ hatching, crosshatch, or a hole that cuts through fills); open lines/curves can get an arrowhead. Fill and arrowheads can also be applied to a lasso selection.
- **Reshape shapes after drawing**: lasso a single shape to get handles: vertices of lines and polygons, corners of rectangles (right angles kept, also when rotated), centre and axes of ellipses and circles, the shaft of snapped arrows, and up to 12 handles on smart curves that bend the curve smoothly. Handles snap like the pen; each drag is one undo step.
- **Draw-and-hold shape snapping (Notability style)**, with the pen and with the Draw tool's smart curve: hold the pen still and the stroke becomes a line, arrow, circle, ellipse, triangle, rectangle, polygon or polyline; keep the pen down and move it to size the shape (line end follows the pen with axis lock, circles/ellipses grow from the centre with independent axes, rectangles keep right angles, polygons scale and rotate).
- Lasso: tap a stroke to select it, or draw a lasso: anything it touches is selected (a lasso crossing one end of a stroke, a corner of an image or a piece of a LaTeX block is enough). Selected ink glows; move / resize / **rotate** on a GPU layer (the rotate handle shows the angle and snaps every 15°; every item remembers its rotation from its original orientation, shown when it is selected again, with a reset to 0°), recolour, dashed/dotted, duplicate, delete, snap shapes.
- **Cut / Copy / Paste**: Copy keeps the selection without placing anything, Cut also removes it; Paste (lasso tool, the ⋯ menu, ⌘V) puts it where you are looking, on any page of any note, as often as you like.
- Two fingers on a selection scroll the page: a drag that had started is dropped and the selection stays where it was.

**LaTeX / TikZ**
- Lasso handwriting → **LaTeX** (math), **Notes** (text + inline/display math) or **TikZ** (diagrams), transcribed by your Qwen3-VL server. Results are reviewed/edited in a live-preview sheet, then inserted or used to *replace* the ink; converted math is sized like the handwriting. **Colours are kept**: the exact HEX colours of the selected ink go into the prompt and each symbol comes back as `\textcolor{#RRGGBB}{…}` in the colour it was written in (only those codes are accepted; the main ink colour needs no markup). `.tex` export writes them for xcolor.
- "Page → LaTeX" transcribes a whole page.
- Math rendered with bundled KaTeX (works offline); tolerant of `$$…$$`, `\[…\]`, `align*`, `<think>` blocks, markdown fences, full documents.
- **TikZ rendered by real TeX** (e-TeX + PGF/TikZ compiled to WebAssembly, from TikZJax) inside the app, offline: libraries such as `arrows.meta`, `positioning`, `calc`, `shapes`, `automata`, plus `pgfplots` and `tikz-cd`. A supervised worker restarts after bad input so one broken diagram cannot block the others; an instant built-in preview is shown while TeX runs.
- "Vector": exact TikZ of the selected ink, offline: shapes become TikZ primitives, smart-pen curves the very Bézier segments that are drawn, handwriting the modelled line the ink engine draws, fitted with cubic Béziers (no polygons). Fills, hatching, dashes and arrows are kept; text boxes and LaTeX blocks in the selection become `\node`s at their position and size. The code compiles both in the app and in standard LaTeX.

**Export**: PDF (system print → Save as PDF / Save to Files, vector ink), SVG, `.tex` (compilable, optionally with remaining ink as TikZ), Markdown, `.opennote` (full-fidelity JSON).

---

## Qwen3-VL server

OpenNote talks to any OpenAI-compatible chat-completions endpoint with vision (llama.cpp `llama-server`, the switchboard on port 9191, …).

1. Open **Settings** and enter the server, e.g. `http://192.168.1.26:9191` or your Tailscale address `http://100.77.212.97:9191` (`/v1/chat/completions` is added automatically). On a phone, `localhost` is the phone itself.
2. Tap **Test connection** — it lists the server's models.
3. Model name: `qwen3-vl`. Timeout defaults to 180 s because a cold model start can take a while.

Requests are sent through the native networking stack (CapacitorHttp on Android, `NSURLSession` in the iOS shell), so plain-http LAN servers work from inside the app (no mixed-content / CORS blocking). In a desktop browser the dev server proxies `/v1` to `127.0.0.1:9191`.

---

## Building

```bash
npm install
npm run build          # copies + patches the TikZ engine into public/tikzjax, type-checks, builds dist/
npm run dev            # http://localhost:5173 (proxy /v1 -> 127.0.0.1:9191)
```

### Android (APK)

```bash
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug     # android/app/build/outputs/apk/debug/app-debug.apk
```

### iPhone / iPad (IPA, built on Linux)

`ios-native/OpenNoteShell.m` is a small native WKWebView host (custom-scheme asset server, native HTTP, share sheet, printing, Pencil double-tap, JS dialogs, microphone). It compiles with `clang` + `ld64.lld` against an iPhoneOS SDK (e.g. `iPhoneOS16.5.sdk` from [theos/sdks](https://github.com/theos/sdks)):

```bash
npm run build
IOS_SDK=/path/to/iPhoneOS16.5.sdk scripts/build-ios.sh releases/OpenNote.ipa
```

The IPA is unsigned: install it with Sideloadly, AltStore/SideStore or sign it with your own certificate. Requires iOS 15+.

### iPhone / iPad via Xcode (alternative)

`ios/App` is a standard Capacitor project: `npm run build && npx cap sync ios && npx cap open ios`, select your team, run.

---

## Repository layout

```
src/
  App.tsx                     library <-> editor, settings, backup/import
  components/
    Editor.tsx                viewport, selection actions, VLM flows, pages, print
    CanvasPage.tsx            ink input (pen/highlighter/eraser/lasso/text), blocks, paper
    Blocks.tsx                LaTeX / TikZ / text / image blocks
    PageManager.tsx, PaperPicker.tsx  page sidebar (thumbnails, reorder, page clipboard), paper picker
    Toolbar.tsx, LibraryView.tsx, LatexModal.tsx, ExportModal.tsx, SettingsModal.tsx, AudioRecorder.tsx
  editor/                     page paper (pageSetup.ts), the canvas and its pages: layout, page operations, page clipboard, migration (sheets.ts), selection maths, zoom / scrolling / pull and tap gestures,
                              smart pen (smartPen.ts), shape handles and snap-and-size (shapeEdit.ts)
  ink/engine/                 the ink engine (Nib), self-contained: no imports from the rest of the app
    nib.ts                    handwriting model: zero-phase smoothing, lift-off, pressure
    liveStroke.ts             the stroke being written, painted incrementally on a canvas
    geometry.ts               point types, pressure width, capsule paths (canvas and SVG)
  ink/nativePencil.ts         240 Hz Apple Pencil samples from the iOS shell
  ink/penRecorder.ts          pen recording (Settings > Diagnostics) for the benchmarks
  ink/strokeRenderer.ts       Path2D cache, SVG export, partial eraser
  services/
    vlmService.ts             Qwen3-VL client + prompts
    latexRender.ts            output cleaning, text/math segmentation, KaTeX
    tikzEngine.ts             TeX (WebAssembly) TikZ compiler driver
    tikzService.ts            instant TikZ preview interpreter
    shapeRecognition.ts       shape snapping, ink -> TikZ
    rasterize.ts              ink -> image for the VLM
  state/useNoteEditor.ts      undo/redo, gesture transactions, autosave
  storage/db.ts               IndexedDB (notes, subjects, audio), migration, backup
  platform.ts                 native HTTP / share / print bridges
ios-native/                   native iOS shell + Info.plist
bench/                        pen benchmarks: pen.ts (synthetic, ground truth), replay.ts (real recordings),
                              springEngine.ts (the v1.7 engine, as the baseline)
scripts/                      copy-tikzjax.mjs, build-ios.sh
android/, ios/                Capacitor projects
```

## License

OpenNote's own code: MIT. The bundled TikZ engine (`@drgrice1/tikzjax`, copied into `public/tikzjax` at build time) is **GPL-3.0-or-later**; distributing builds that include it must respect its license. KaTeX is MIT.
