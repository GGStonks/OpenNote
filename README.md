# OpenNote

<div align="center">
  <h3>An offline-first, Notability-style notebook for iPad, iPhone and Android</h3>
  <p><b>Pressure-sensitive Apple Pencil / S-Pen ink • Handwriting → LaTeX and TikZ with your own Qwen3-VL • Real TeX rendering of TikZ on device</b></p>
</div>

---

## Features

**Note taking (Notability-style)**
- Library with subjects, search (titles, typed text, LaTeX source), live ink thumbnails, rename / move / duplicate / delete, backup & import.
- **One continuous vertical canvas** per note, as wide as the screen in any orientation, with blank / ruled / grid / dot paper in white, cream, yellow or dark. A hairline marks every US Letter page (816×1056 pt @96 dpi); ink and shapes cross it freely, and a new blank page appears as you write. PDF export cuts the canvas into pages at those lines.
- The page always fills the width of the screen and only scrolls up and down (two fingers, or one finger when "pencil only" is on, with momentum); it never slides sideways or zooms out of place.
- Two-finger tap = undo, three-finger tap = redo (Notability gestures; can be turned off in Settings).
- Text boxes, images, add / duplicate / delete pages, undo/redo (whole gestures are one step), keyboard shortcuts (1–6 tools, ⌘Z / ⌘⇧Z).
- Audio recordings per note (record, list, play, delete).

**Pencil & ink**
- **Handwriting engine (Nib, OpenNote's own, `src/ink/nib.ts`)**: every Pencil sample is smoothed with the samples on *both* sides of it (a speed-adaptive local quadratic fit, zero phase), so the line has none of the lag distortion of causal filters: corners stay sharp and small loops keep their size. Slow writing is smoothed over up to ±70 ms to remove digitiser jitter, fast writing over ~±1.6 px to keep detail, and the window never reaches round a corner. Anchors are joined with centripetal Catmull-Rom curves. Settled ink never moves; the last few milliseconds are a provisional tail redrawn every frame, extended by Nib's own prediction (constant acceleration over 9 ms, stopped where the pen would come to rest, only at writing speed), so the ink reaches the nib. Pressure is smoothed the same way; strokes land at full width (the Pencil under-reads force on its first samples) and keep their body width as the pen eases off. The lift-off flick is trimmed; the fountain pen's width spans 0.72×–1.3× of nominal and is rendered as the exact union of pressure-sized capsules. Measured with `npm run bench:pen` (synthetic handwriting with ground truth, 240 Hz samples with noise, 120 Hz frames) against the v1.7 spring engine: shape error 0.09 px vs 0.21 px (worst 0.40 vs 0.79), on-screen lag behind the nib 2.0 px vs 5.3 px, full-width starts. Highlighter drawn behind ink, custom colours.
- **240 Hz Apple Pencil capture on iPad**: WKWebView only delivers pointer events once per display frame (60/120 Hz) and has no `getCoalescedEvents`, so the iOS shell reads the Pencil natively (a passive gesture recognizer, `coalescedTouchesForTouch:` + `predictedTouchesForTouch:`) and streams every sample — precise location, force, altitude, azimuth and its own timestamp — to the ink engine (no platform prediction: Nib predicts the pen itself). Strokes end on the Pencil's real lift-off samples, and a force-less sample is treated as lift-off instead of being drawn at medium pressure. Android (Chromium) already gets every sample through coalesced pointer events.
- Per-point pressure, timestamps, altitude and azimuth are stored — the same per-point channels Notability's `InkObjectEncoder` serialises.
- Palm rejection: in "pencil only" mode fingers navigate; a pencil touching down cancels a palm stroke in progress.
- Coalesced + predicted pointer events for low-latency ink; Apple Pencil double-tap toggles the eraser (iOS shell).
- Stroke eraser and precision (partial) eraser that splits strokes.
- **Smart pen (PDEDraw engine)**: smooth centripetal Catmull-Rom curves that close themselves when you end near the start ("potatoes", with a snap dot and haptic tick), lines with 15° angle lock, rectangles, ellipses from the centre with circle lock, points. Everything snaps to the key points, edges and crossings of existing shapes (curves and ellipses included) and, on grid / dot paper, to the paper's lattice. Lines, rectangles and ellipses show their live size (cm, angle) next to the pen. Closed shapes take a fill (solid, //// or \\\\ hatching, crosshatch, or a hole that cuts through fills); open lines/curves can get an arrowhead. Fill and arrowheads can also be applied to a lasso selection.
- **Reshape shapes after drawing**: lasso a single shape to get handles: vertices of lines and polygons, corners of rectangles (right angles kept, also when rotated), centre and axes of ellipses and circles, the shaft of snapped arrows, and up to 12 handles on smart curves that bend the curve smoothly. Handles snap like the pen; each drag is one undo step.
- **Draw-and-hold shape snapping (Notability style)**: hold the pen still and the stroke becomes a line, arrow, circle, ellipse, triangle, rectangle, polygon or polyline; keep the pen down and move it to size the shape (line end follows the pen with axis lock, circles/ellipses grow from the centre with independent axes, rectangles keep right angles, polygons scale and rotate).
- Lasso: tap a stroke to select it or circle anything; selected ink glows; move / resize on a GPU layer, recolour, dashed/dotted, duplicate, delete, snap shapes.

**LaTeX / TikZ**
- Lasso handwriting → **LaTeX** (math), **Notes** (text + inline/display math) or **TikZ** (diagrams), transcribed by your Qwen3-VL server. Results are reviewed/edited in a live-preview sheet, then inserted or used to *replace* the ink; converted math is sized like the handwriting.
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
    Toolbar.tsx, LibraryView.tsx, LatexModal.tsx, ExportModal.tsx, SettingsModal.tsx, AudioRecorder.tsx
  editor/                     continuous surface + page bands (surface.ts), selection maths, scrolling and tap gestures,
                              smart pen (smartPen.ts), shape handles and snap-and-size (shapeEdit.ts)
  ink/inkEngine.ts            handwriting spline engine (sampling, smoothing, pressure width)
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
scripts/                      copy-tikzjax.mjs, build-ios.sh
android/, ios/                Capacitor projects
```

## License

OpenNote's own code: MIT. The bundled TikZ engine (`@drgrice1/tikzjax`, copied into `public/tikzjax` at build time) is **GPL-3.0-or-later**; distributing builds that include it must respect its license. KaTeX is MIT.
