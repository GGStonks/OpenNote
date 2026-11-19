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
