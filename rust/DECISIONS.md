# Decisions for the Rust port

The source of truth for the port's decisions; `MAP.md` has the plan and its state. A changed
decision gets a new ADR that supersedes the old one.

## ADR-001: Finish the hybrid, not a pure Rust UI
Status: accepted (2026-11-19)
Context: docs/rust-native-canvas.md (owner, 2026-11-13) chose a native Rust canvas under the web
view; a pure Rust UI is roadmap Phases 0-7 (40-60k lines, no device spike run). `rust-anything
analyze --whole-app` keeps the ~19k lines of UI in TypeScript and cannot record a mobile UI.
Decision: "Fully rustify" means the native canvas finished (N3-N7 of rust-native-canvas.md): Rust
draws everything on the page; the web view keeps menus, dialogs, library and settings.
Consequences: proof is the repo's own references (`bench:rustref`, golden file, benches,
`bench:ui`), not `app record` / `app replay`. A pure Rust UI is a later decision.

## ADR-002: Rebuild the canvas from the TypeScript page
Status: accepted (2026-11-19)
Context: the owner finds the canvas a mess. `crates/canvas` holds a second engine no shell calls
(`tools/`, `ffi_bridge.rs`, `canvas_core.rs`, `vector_renderer.rs`, `geometry_engine.rs`,
`spatial_index.rs`: its own lasso, eraser and snapping, unlike the app's), and the host is a raw
pointer shared by the UI thread, the render thread and the page's bridge. The Android build crashes
when the page moves (owner, rs.27; no crash report reached the PC).
Decision: the canvas is rebuilt on the TypeScript page's structure (CanvasPage.tsx: paper, PDF,
layers in z-order from zorder.ts, blocks, selection, live ink; glInk.ts's passes), the parallel
engine deleted, one owner of the GPU objects, no host pointers in the shells, wgpu errors recorded
and never panicking.
Consequences: interactive tools stay in the page (TypeScript) until the canvas owns input; the
shapes crate is the only Rust port of selection and snapping.

## ADR-003: Official releases from opennote-rs
Status: accepted (2026-11-19)
Context: the owner wants official releases from this branch from now on; docs/releasing.md
allowed only prereleases from it.
Decision: releases are made from `opennote-rs` (the worktree `/home/ds/AI/OpenNote-worktrees/rs`)
as ordinary `X.Y.Z` releases following docs/releasing.md; `main` is not touched. Versions go on
from 2.9.4 (`Z` raised, `Y` only when the owner says).
Consequences: every release reaches everyone through the updater, so the native canvas stays an
opt-in (Settings > Diagnostics) until it is complete and the owner has confirmed it on a device.

## ADR-004: Who writes the code
Status: accepted (2026-11-19)
Context: the owner allows Gemini, Claude or the local model.
Decision: Claude subagents for the canvas (threading, FFI, GPU), Gemini / the local model through
/cgl for mechanical work when it pays. Claude plans, reviews and releases.
Consequences: every step is reviewed and its checks run before a commit.

## ADR-005: The first official release keeps the branch's ink
Status: accepted (2026-11-19)
Context: against 2.9.4 on the 308 recorded strokes, the branch's ink (engine and pipeline changes
of 2.9.4-rs.7 to rs.12) has hooks 6 -> 0 and the engine's end at lift median 1.26 -> 0.14, p90
5.53 -> 0.61 page px, for wobble 39.6 -> 41.4 mrad/px^2, width roughness 32.87 -> 34.68,
accuracy median 0.26 -> 0.28 px, raw points past 0.5 px 32 -> 40; the end while writing and live =
finished unchanged.
Decision: the owner chose to release that ink as it is.
Consequences: the Rust crates stay checked against this ink; the next engine change is compared
with these numbers.

## ADR-006: Rust owns scroll and zoom when the canvas draws the note
Status: accepted (2026-11-19)
Context: on the iPad Pro (120 Hz) the native canvas moves at 60 fps: it is placed by the page's
`canvasFrame` messages, sent on the page's frames, which WebKit gives at 60. In rs.21-25 the shells
ran their own pinch and pan beside the page's (no zoom limits, own momentum): the ink parted from
the page's text and jumped back (docs/rust-native-canvas.md N3). The owner asked for N5, fully in
Rust.
Decision: a Rust viewport (port of useViewport.ts's gestures: pan, pinch about the fingers,
momentum, zoom limits, fit to width and its snap) is the only camera while the native canvas draws
the note. The shells hand it two-finger touches; the canvas's render thread advances it and draws
at the display's rate; the page mirrors the camera on its own frames and sends its own camera
changes (fit to width, restored views, going to a page) and its layout to Rust. One-finger touches
and the pen stay the page's. Notes the canvas does not draw keep the page's gestures.
The rate is the best each device offers, never a fixed one (owner, 2026-11-19): iOS asks
CADisplayLink for `UIScreen.maximumFramesPerSecond`, Android for the display mode with the highest
refresh rate at its resolution (`Surface.setFrameRate`, `preferredDisplayModeId`); the system may
lower it (Low Power Mode, heat). Motion uses elapsed time, never frame counts.
Consequences: the page's DOM content (text, formulas, selection) follows the ink at the page's
rate during a gesture, at most one page frame behind; it is measured, not hidden. Both shells use
the same Rust gestures.

## ADR-007: The TypeScript page's smoothness, held on notes of thousands of pages
Status: accepted (2026-11-20)
Context: on the owner's iPad Pro M4 the TypeScript page runs at 120 Hz (WebKit's cap lifted) and
pinches at p50 8 / p95 10 ms; 2.9.6's Rust canvas ticked at 69-85 fps (p50 16.6 ms) with ink
drifting from the page's text. The owner: "the objective is using Rust to have the same
performance, but be able to also hold it under much heavier loads, for example 1000s of pages
long notes".
Decision: the bar is the TypeScript page's frame timing and feel on a small note, held unchanged
on a note of thousands of pages. Rust owns the camera and the frame timing (a design led by the
page's frames is ruled out: their cost grows with the note). Every per-frame cost is bounded by
what is on screen, never by the note's length: the canvas culls to the pages in view, keeps GPU
memory for pages near the view only (an LRU by bytes), and gets pages from the page lazily as
they come near; the page keeps only the sheets near the view in its DOM and mirrors the camera at
a cost independent of the note's size. Opening a note costs the pages in view, not all of them.
Consequences: benches gain a note of 2,000+ pages (recorded handwriting repeated, text boxes and
formulas on some pages): frame timing during pan / pinch / fling, memory and open time, with the
canvas off and on, against the same numbers on a small note.

## ADR-008: The canvas draws the camera the page's DOM shows; fingers by their own time
Status: accepted (2026-11-20)
Context: 2.9.6 on the owner's iPad Pro M4: ink slid against the page's text, formulas and
selection while moving and met them again at rest, and the content left the fingers. The bench
(`--native --only cameracoherence`, iPad sizes) found: the canvas drew the newest camera while the
DOM showed the camera pushed one or two page frames earlier (40-70 device px apart on a pan,
180-290 on a fling, p95); fingers were stamped when the main thread delivered them, so the camera
juddered by a whole sample (second difference p95 20 device px on a constant-speed pan); the
display link asked a 60-120 range and Metal had two drawables (the canvas ticked at 69-85 fps).
Ink and paper were always one transform (0.00 px). The page's DOM cannot be moved natively on
Android (one WebView) and text cannot be rasterised on iOS (WebKit taints a canvas that draws HTML
through SVG), so the canvas cannot draw the DOM's content yet (C4).
Decision: the shells hand every finger sample with its own timestamp (coalesced / historical
included) on the clock the display link uses (`clock_ms`: CLOCK_UPTIME_RAW / CLOCK_MONOTONIC); the
render thread advances the camera to each frame's presentation time, the fingers resampled 8 ms
before it (interpolated, else extrapolated up to two sampling intervals, held when they stop).
The page reports the camera it put on its DOM (`viewportShown`, its seq); the canvas places
everything (papers and the scene, one f64 transform from the camera and the layout, never the
page's last frame shifted) at that camera, from a history of the last 64 ticks. Rust keeps the
frame timing (ADR-007): the canvas draws the camera as far back as the DOM trails it (measured
each time the DOM shows a new camera, smoothed: it moves as evenly as the camera, not in the steps
the reports arrive in); a DOM that stops reporting (a long page frame) is not waited for, the
canvas goes on and the trail rises gradually when the DOM comes back (capped at six page frames). The iOS display link asks 80-120 Hz
while the camera moves, Metal gets three drawables; pushes to the page are one at a time.
Consequences: the ink trails the newest camera by the DOM's latency (the same as the TypeScript
page's own gestures), and moves at the page's rate (120 on the owner's iPad; 60 where WebKit keeps
its cap). When C4 draws text boxes, formulas and the selection, the canvas can draw the newest
camera again. The ported pinch drops the movement not yet scrolled when it engages (as useViewport
does): the content leaves the fingers by 1-3 px on long pinches; changing it changes the page's
own gesture (the owner's call).

## ADR-009: The sheet is the native canvas's unit; memory budgets from the device
Status: accepted (2026-11-20, the owner accepted the draw order below)
Context: ADR-007 asks every cost per frame and on open to be bounded by what is on screen. 2.9.7
sent a note's ink as one scene (all sheets) and drew all of it every frame (a 2,000-page note:
621,194 capsules per frame), rebuilt and sent the whole surface's stroke list at every lift, placed
every sheet's paper per tick, and kept every sheet in the page's DOM.
Decision: each sheet's ink is a scene of its own (`surface:sheet`, strokes owned by the sheet that
holds the middle of their height, as sheets.ts `ownership`); the frame lists the sheets compactly
once per layout; the canvas draws the placements meeting the view (a box tree, O(found x log n)),
keeps scenes on the GPU near the view (an LRU by bytes) and on the CPU within a budget, names the
near sheets it lacks (`missing`) and the ones it let go (`dropped`); the page streams the sheets
near the view, nearest first, one at a time, and keeps only those sheets in its DOM. Budgets come
from the device's memory (GPU a 48th, 32-256 MB; Rust twice that), not from the note.
Consequences: strokes of two sheets that overlap (one reaching past its sheet) are drawn sheet by
sheet: a highlighter of the later sheet now lies over ink of the earlier one where before all
highlighters went under all ink (one scene). Pages far away cost a re-send (and their strokes'
drawn lines rebuilt) when they come back after being dropped. The page's own path (canvas off) is
unchanged and remains O(note) (a 2,000-page note: open 212 s, frames 0.3-1.4 s on the PC).
