# Releasing OpenNote

For any agent (Claude, Gemini) or person who makes a release. A release publishes to everyone
who installs OpenNote: make one only when the owner asks for it, from this repository
(`/home/ds/AI/OpenNote`, GitHub `GGStonks/OpenNote`), from `main`. A build of the `opennote-rs`
branch (`X.Y.Z-rs`) is released only as a GitHub prerelease, never marked latest: the app's
updater reads the latest release and skips prereleases, so it reaches nobody by itself.

## Steps

1. **Start clean.** On `main`, everything that should ship committed, `git pull`. Run
   `npm run build`: it fails on any type error, engine change or storage regression. When the
   release changes ink or rendering, also run the benches CLAUDE.md names for it, and compare
   with the last release.
2. **Pick the version.** `X.Y.Z`: raise `Z` for a usual release, `Y` only when the owner says so.
3. **Bump it:** `node scripts/release.mjs bump X.Y.Z`. It refuses when the tree has uncommitted
   changes, when untracked files would be built in, when GitHub has commits you lack, or when the
   tag exists; then it writes the version into `package.json`, `package-lock.json`,
   `android/app/build.gradle` (and `versionCode` + 1) and `ios-native/OpenNoteShell.m`. Never
   edit those by hand.
4. **Write the notes** to `releases/vX.Y.Z/notes.md` (git-ignored). They are for the people
   using the app, not for developers:
   - a `## ` headline saying what the release brings, in a few words;
   - one bullet per change a user notices: **the change in bold**, then a sentence or two in plain
     words on what is different for them. No file names, function names or bench numbers; a
     before/after figure only when it means something to a user ("a quarter as much");
   - nothing about the conversion server's keys or internals.
   See the notes of v2.9.3 and v2.9.4 (`gh release view vX.Y.Z -R GGStonks/OpenNote`).
5. **Commit and push:** `git commit -am "X.Y.Z: <what changed, in a few words>"` with a body
   listing the changes and their measurements for developers (as the commits of 2.9.2-2.9.4),
   ending with the agent's `Co-Authored-By:` line; then `git push origin main`.
6. **Build and publish:**

   ```sh
   cd /home/ds/AI && printf 'X.Y.Z\n\n\n' | RELEASE_NOTES_FILE=/home/ds/AI/OpenNote/releases/vX.Y.Z/notes.md \
     ./OpenNote_release.sh > /home/ds/AI/OpenNote/releases/vX.Y.Z/release.log 2>&1
   ```

   It builds (again running the engine and storage tests), syncs Capacitor, builds the APK and
   the IPA, tags `vX.Y.Z`, pushes the tag and uploads both files. It takes a few minutes. Its
   exit code must be 0; on failure read the end of `release.log` and fix the cause. Never pass
   the GitHub token anywhere or print it.
7. **Verify:** `node scripts/release.mjs verify X.Y.Z` (the tag on HEAD and on origin/main, both
   files on the release, the IPA's version). Report the release URL to the owner, with what was
   and was not tested on a device.

## Never

- Release with a failing build or test, or with `--force` / a re-run of an existing version: the
  script moves an existing tag. A broken release is fixed by the next version.
- Regenerate `bench/engine-golden.json`, change the release script, or skip the bump script to
  get a release through.
