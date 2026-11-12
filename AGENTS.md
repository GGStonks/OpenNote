# OpenNote: notes for agents

- The project's rules are in CLAUDE.md (named for Claude, binding for every agent): read it first.
- Releases: follow docs/releasing.md step by step, and only when the owner asks for one.
- The Rust port is written in /home/ds/AI/OpenNote-rs (its own AGENTS.md says how the work is shared);
  crates that build and pass their tests are brought into `crates/` here (docs/rust-status.md).
- More than one agent works in this folder. Do not commit, stash, reset or revert changes you did
  not make; if someone else's uncommitted work is in the way (the release bump refuses a tree with
  changes), stop and tell the owner.
