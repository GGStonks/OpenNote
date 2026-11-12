#!/usr/bin/env node
// Release helper for any agent or person releasing OpenNote (procedure: docs/releasing.md).
//
//   node scripts/release.mjs bump <X.Y.Z>     check the repo is ready, then write the version
//                                             everywhere it lives (package.json, package-lock.json,
//                                             Android versionName and versionCode + 1, iOS shell)
//   node scripts/release.mjs verify <X.Y.Z>   after /home/ds/AI/OpenNote_release.sh: the tag, the
//                                             pushed commit, the GitHub release's files and the
//                                             IPA's version
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'GGStonks/OpenNote';
const sh = (cmd, args, quiet = false) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'] }).trim();
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};
const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const FILES = {
  pkg: 'package.json',
  lock: 'package-lock.json',
  gradle: 'android/app/build.gradle',
  shell: 'ios-native/OpenNoteShell.m',
};
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const write = (f, s) => writeFileSync(join(ROOT, f), s);

function current() {
  const pkg = JSON.parse(read(FILES.pkg)).version;
  const gradle = read(FILES.gradle);
  const name = gradle.match(/versionName "([^"]+)"/)?.[1];
  const code = Number(gradle.match(/versionCode (\d+)/)?.[1]);
  const shell = read(FILES.shell).match(/kVersion = @"([^"]+)"/)?.[1];
  const lock = JSON.parse(read(FILES.lock));
  return { pkg, name, code, shell, lock: [lock.version, lock.packages?.['']?.version] };
}

function bump(version) {
  const want = parse(version);
  if (!want) fail(`"${version}" is not X.Y.Z`);
  const now = current();
  const all = [now.pkg, now.name, now.shell, ...now.lock];
  if (new Set(all).size !== 1) fail(`the version differs between files before the bump: ${JSON.stringify(now)}`);
  if (!(newer(want, parse(now.pkg)) > 0)) fail(`${version} is not newer than ${now.pkg}`);

  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') fail(`on branch ${branch}: releases are made from main`);
  // Tracked changes would go into the build but not into the tagged commit.
  const dirty = sh('git', ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) fail(`uncommitted changes:\n${dirty}\ncommit them (or leave them out) first`);
  // Untracked files under the app's folders would be built in too.
  const stray = sh('git', ['status', '--porcelain', '--', 'src', 'public', 'ios-native', 'android/app/src', 'index.html'])
    .split('\n').filter((l) => l.startsWith('??'));
  if (stray.length) fail(`untracked files the build would include:\n${stray.join('\n')}`);
  sh('git', ['fetch', '-q', 'origin', 'main']);
  if (sh('git', ['rev-list', '--count', 'HEAD..origin/main']) !== '0') fail('origin/main has commits this checkout lacks: pull first');
  const tag = `v${version}`;
  if (sh('git', ['tag', '-l', tag])) fail(`tag ${tag} exists already`);
  if (sh('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) fail(`tag ${tag} exists on GitHub already`);

  write(FILES.pkg, read(FILES.pkg).replace(/("version": ")[^"]+(")/, `$1${version}$2`));
  // The lock's own version: the top-level one and the root package's (the first two occurrences).
  let k = 0;
  write(FILES.lock, read(FILES.lock).replace(/("version": ")[^"]+(")/g, (m, a, b) => (k++ < 2 ? `${a}${version}${b}` : m)));
  write(FILES.gradle, read(FILES.gradle)
    .replace(/versionName "[^"]+"/, `versionName "${version}"`)
    .replace(/versionCode \d+/, `versionCode ${now.code + 1}`));
  write(FILES.shell, read(FILES.shell).replace(/kVersion = @"[^"]+"/, `kVersion = @"${version}"`));

  const after = current();
  if (new Set([after.pkg, after.name, after.shell, ...after.lock]).size !== 1 || after.pkg !== version || after.code !== now.code + 1)
    fail(`the bump did not land everywhere: ${JSON.stringify(after)}`);
  console.log(`${now.pkg} -> ${version} (Android versionCode ${now.code} -> ${after.code}) in ${Object.values(FILES).join(', ')}`);
  console.log('Next: write the notes, commit "' + version + ': <what changed>", git push origin main, then run the release script (docs/releasing.md).');
}

function verify(version) {
  if (!parse(version)) fail(`"${version}" is not X.Y.Z`);
  const tag = `v${version}`;
  const problems = [];
  const now = current();
  if (now.pkg !== version) problems.push(`package.json is ${now.pkg}`);
  let tagged = '';
  try { tagged = sh('git', ['rev-parse', `${tag}^{}`], true); } catch { problems.push(`no tag ${tag}`); }
  const head = sh('git', ['rev-parse', 'HEAD']);
  if (tagged && tagged !== head) problems.push(`${tag} is ${tagged.slice(0, 7)}, HEAD is ${head.slice(0, 7)}`);
  sh('git', ['fetch', '-q', 'origin', 'main']);
  if (tagged) {
    try { sh('git', ['merge-base', '--is-ancestor', tagged, 'origin/main'], true); } catch { problems.push(`${tag} is not on origin/main: git push origin main`); }
  }
  const dirty = sh('git', ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) problems.push(`the working tree has changes the release did not include:\n${dirty}`);
  let assets = [];
  try {
    assets = JSON.parse(sh('gh', ['release', 'view', tag, '-R', REPO, '--json', 'assets,isDraft,name'], true));
    if (assets.isDraft) problems.push('the release is a draft');
    for (const name of ['OpenNote.apk', 'OpenNote.ipa']) {
      const a = assets.assets.find((x) => x.name === name);
      if (!a) problems.push(`${name} is not on the release`);
      else if (a.size < 1e6) problems.push(`${name} is only ${a.size} bytes`);
    }
  } catch { problems.push(`no GitHub release ${tag} (gh release view failed)`); }
  const ipa = join(ROOT, 'releases', tag, 'OpenNote.ipa');
  if (!existsSync(ipa)) problems.push(`${ipa} is missing`);
  else {
    const plist = execFileSync('unzip', ['-p', ipa, 'Payload/*.app/Info.plist'], { encoding: 'latin1' });
    const v = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (v !== version) problems.push(`the IPA says ${v ?? 'no version'}`);
  }
  if (problems.length) fail(`${tag} is not right:\n- ${problems.join('\n- ')}`);
  console.log(`${tag} ok: tag on HEAD and on origin/main, APK and IPA on https://github.com/${REPO}/releases/tag/${tag}, IPA version ${version}`);
}

const [cmd, version] = process.argv.slice(2);
if (cmd === 'bump') bump(version);
else if (cmd === 'verify') verify(version);
else fail('usage: node scripts/release.mjs bump|verify <X.Y.Z>');
