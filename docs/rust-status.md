# Rust port: where it stands

The plan is docs/rust-rewrite-roadmap.md. The port is written in the fork
(`GGStonks/OpenNote-rs`, `/home/ds/AI/OpenNote-rs`, mostly by Gemini) and brought here when its
crates build and pass their tests. The app does not use any of it yet: what ships is the
TypeScript app in `src/`.

`npm run test:rust` (`cargo test --workspace`) runs every crate's tests. The ones that read
`bench/recordings` (nib's golden test does not) need the recordings, which are not in git.

| Crate | Ports | Checked against the TypeScript app | Not yet |
|---|---|---|---|
| `nib` | the ink engine (`src/ink/engine`) | **exactly**: `bench/engine-golden.json` to 1e-4 px (finished line, `nibStroke`), live line hash for hash on every sample | the live-line check only warns on a mismatch |
| `model` | note types, packed points, sheets, migration, the `.opennote` codec | round trip of every recorded stroke and a backup, Rust against Rust | not read back by the TypeScript app, nor TypeScript files read by it |
| `ink` | densify, widths, smoothing, dashes, geometry, live stroke, precision eraser | the bench figures (accuracy, hooks, overshoot, lead end, wobble, widths) on the four October recordings match 2.9.3's | 2.9.4's smoothing (`smoothSigma`); point-for-point comparison with `npm run bench:rustref` |
| `shapes` | shape recognition, shape handles, selection, z-order | no: tests on made-up strokes | everything |
| `import` | text, LaTeX, Word (`.docx`), Notability's FlatBuffers reader | no: tests on made-up files (a mock `.docx`) | Notability `.note` / `.ntb` files; real documents |
| `store` | SQLite storage (notes, folders, tags, files, thumbnails, audio, backup) | no: Rust against Rust | reading the app's IndexedDB data (roadmap Phase 6) |

Left in the fork: the Phase 0 spikes (desktop programs, none run on a device yet; the roadmap's
gate needs the iPad and the tablet) and an empty `svg` crate.

Brought over on 2026-11-12 from the fork's working tree (its crates were not committed there yet);
the ink benches were limited to the four October recordings their expected figures were measured
on.
