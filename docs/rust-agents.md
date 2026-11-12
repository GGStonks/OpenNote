# Rust port: how the work is shared

_Moved from `GGStonks/OpenNote-rs` (its AGENTS.md) on 2026-11-12, when that repository was deleted: the
port now lives on this branch (`opennote-rs` of `GGStonks/OpenNote`). "This repo" below means this branch,
"OpenNote main" the `main` branch. Item 1 of "Next" (merging main) was done by the branch's first commit._

Two agents work on this port. Read this before anything else, then CLAUDE.md and
docs/rust-rewrite-roadmap.md.

- **Gemini** does the steady work: porting the TypeScript modules that are plain logic to Rust,
  writing their reference tests, keeping the workspace building, merging new OpenNote releases.
- **Claude** (working in /home/ds/AI/OpenNote) does the hard parts: the Phase 0 spikes on the
  iPad and the Android tablet, the GPU renderer, rich-text editing and platform text input, ink
  engine improvements, and reviewing the port.

When a task needs a device, a UI decision or a judgement about how the ink should look, do not
guess: add it to `docs/for-claude.md` (what, where, why it is blocked) and carry on with the next
item.

## What "done" means

1. **A port is done when it reproduces the TypeScript app's own output.** A Rust test that checks
   Rust against itself (a bench rewritten in Rust and its numbers printed) proves nothing about the
   port. Compare with references written by the TypeScript code (`npm run bench:rustref`, below).
2. **A mismatch fails the test.** Never only print a warning. `crates/nib/tests/golden.rs` counts
   live-line hash mismatches as `WARN` and passes anyway: make them fail, as `final` and
   `nibStroke` already do.
3. **Every commit builds and passes:** `cargo test --workspace` before each commit. Never commit a
   crate that does not compile (`crates/ink` once had no `lib.rs` and broke the whole workspace).
4. **Commit messages say what was verified and what was not.** The Phase 0 spikes ran on a desktop
   only; the roadmap's gate is "work on the devices". Do not call a phase complete when its gate
   is not met. Write the true state in `docs/status.md` (one line per roadmap item: done and
   verified how / partial / not started) and keep it current.
5. CLAUDE.md's rules apply here too: never regenerate `bench/engine-golden.json` to make a test
   pass; nothing about how conversion-server keys work goes in this public repo.

## Next, in this order

1. **Merge OpenNote main** (2.9.4, the reference generator, the release tooling, and a copy of
   your crates). OpenNote's main now carries `crates/` (nib, model, ink, shapes, import, store, as
   they were in your working tree on 2026-11-12; what each is checked against:
   `docs/rust-status.md`). First commit your own `crates/` (untracked files block the merge), then
   `git fetch upstream && git merge upstream/main`. Conflicts:
   - `crates/…`: keep yours where you changed a file since, except `crates/ink/tests/benches.rs`:
     keep main's filter to the four October recordings (`pen-202610*`, the 292 strokes its expected
     figures were measured on; a later recording broke four tests);
   - `Cargo.toml`: keep yours (it also lists the spikes);
   - `CLAUDE.md` (both sides rewrote the engine section): take OpenNote's
     (`git checkout --theirs CLAUDE.md`), it holds the owner's current rule.

   From then on, crates that build and pass reach OpenNote's main the same way; keep
   `docs/rust-status.md` true there and here. 2.9.4 changed the
   smoothing: its width now follows the sample spacing (`smoothSigma` in
   `src/ink/strokeRenderer.ts`). Port that to `crates/ink/src/smoothing.rs`.
2. **Make the golden test fail on a live-line mismatch** (rule 2).
3. **Write the ink reference test.** `npm run bench:rustref -- bench/rust-ref/ink.json` writes
   36 recorded strokes through every stage of the TypeScript ink pipeline; the field list is in
   the header of `bench/rustRef.ts`. Add `crates/ink/tests/reference.rs` that reads the file and
   compares, stroke by stroke: densified points, engine points, modelled line, widths, drawn
   geometry (points, widths, width), the live line at both recorded samples, the dash runs of
   all four line styles, and the eraser pieces (solid and dashed, with `dashOffset`). Tolerance
   1e-4 page px for positions and widths (the file keeps 9 significant digits). Report every
   differing stage by name and stroke id, then fail. Fix the port until it passes; do not loosen
   the tolerance. Known suspect: `WIDTH_BEHIND` in `ink_width.rs` is declared as `3 * PRESSURE_SIGMA`
   (6) but is `max(6, DIR_PX + 3 * DIR_SIGMA)` = 10.5 in `inkWidth.ts`.
4. **Then the rest of Phase 1, one module at a time:** shape recognition, smart pen, shape edit,
   selection, z-order, the importers (`.docx`, Notability `.note` / `.ntb`), SVG export. For each,
   first extend `bench/rustRef.ts` with that module's outputs on real inputs (recordings, the
   sample notes and documents), then port, then test against it. One module per commit.
5. Leave the Phase 0 device spikes (A, B, F on the iPad and the tablet) to Claude: list in
   `docs/for-claude.md` what the desktop versions found, so the device runs start from there.

## Releases

Gemini may release the OpenNote app when the owner asks for one: from /home/ds/AI/OpenNote (not
from this repo), following /home/ds/AI/OpenNote/docs/releasing.md exactly (bump script, notes for
users, commit and push, the release script, the verify script). This repo has no release of its
own until the Rust app runs on a device.
