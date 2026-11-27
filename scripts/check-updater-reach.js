#!/usr/bin/env node
/**
 * Release guard: would apps on the previous release see this one in their in-app updater?
 *
 * Version 1.0 only reads tags shaped v<major>.<minor>, so a v1.0.1 release would never be offered to it. To keep that
 * from happening again, this script loads the updater code exactly as the previous release shipped it (its
 * utils/update/check.ts at the newest earlier v* tag), hands it a release for the new tag with the APK names the
 * release workflow publishes, and checks that it offers the release to a phone of every ABI.
 *
 * Apps up to 1.0 read only GitHub's latest release, and they never learn to read a patch tag. So a fix release
 * (v1.1.1) is published without the latest mark, and the latest release is always a v<major>.<minor> tag those apps
 * can read. When the new tag will be the latest, the script also checks it against every earlier updater that reads
 * only the latest release, back to the first one (0.23).
 *
 * Usage:
 *   node scripts/check-updater-reach.js <newTag>      for example v1.1
 *   ALLOW_UNREACHABLE=1 node scripts/check-updater-reach.js <newTag>   release anyway, with a warning
 *   node scripts/check-updater-reach.js make-latest <newTag>   prints true or false for the release's latest mark
 *
 * Needs the git tags (in CI, checkout with fetch-depth 0) and the `typescript` package.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const vm = require('node:vm');

const CHECK_FILE = 'utils/update/check.ts';
/** Same digits and APK names as the release workflow and the ABI split plugin (versionCode % 10). */
const ABIS = [
  { abi: 'arm64-v8a', digit: 4 },
  { abi: 'armeabi-v7a', digit: 1 },
  { abi: 'x86_64', digit: 3 },
  { abi: 'universal', digit: 0 },
];

/** Release tags only: v1.0, v1.0.1. Beta tags such as v0.19-beta were never offered by the updater. */
function parseReleaseTag(tag) {
  const m = /^v(\d+)\.(\d+)(?:\.(\d+))?$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), m[3] === undefined ? 0 : Number(m[3])] : null;
}

/** Only a v<major>.<minor> tag becomes the latest release; a tag with a patch number never does. */
function isLatestTag(tag) {
  return /^v\d+\.\d+$/.test(tag);
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

/** Release tags below `newTag`, oldest first. */
function earlierTags(newTag) {
  const want = parseReleaseTag(newTag);
  return git(['tag', '--list', 'v*'])
    .split('\n')
    .map((tag) => ({ tag: tag.trim(), v: parseReleaseTag(tag.trim()) }))
    .filter((t) => t.v && compare(t.v, want) < 0)
    .sort((a, b) => compare(a.v, b.v))
    .map((t) => t.tag);
}

function hasFile(tag, file) {
  try {
    git(['cat-file', '-e', `${tag}:${file}`]);
    return true;
  } catch {
    return false;
  }
}

function loadTs() {
  try {
    return require('typescript');
  } catch {
    throw new Error('the typescript package is not installed (npm install, or set NODE_PATH to a folder that has it)');
  }
}

/**
 * Runs a .ts file from a tag in a fresh VM context and returns its exports. Relative imports load from the same tag;
 * package imports get an empty object, because the update check is meant to be pure and the guard only needs its
 * parsing functions. node:vm is not a security boundary, but the code comes from our own signed-off tag.
 */
function loadFromTag(ts, tag, file, cache = new Map()) {
  if (cache.has(file)) return cache.get(file).exports;
  const source = git(['show', `${tag}:${file}`]);
  const js = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  cache.set(file, module);
  const requireFromTag = (spec) => {
    if (!spec.startsWith('.')) return {};
    const base = path.posix.join(path.posix.dirname(file), spec);
    for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
      if (hasFile(tag, candidate)) return loadFromTag(ts, tag, candidate, cache);
    }
    throw new Error(`${file} imports ${spec}, which ${tag} doesn't have`);
  };
  const context = vm.createContext({ module, exports: module.exports, require: requireFromTag, console, setTimeout, clearTimeout, AbortController, URL });
  new vm.Script(js, { filename: `${tag}:${file}` }).runInContext(context, { timeout: 5000 });
  return module.exports;
}

function installedVersionCode(tag, version) {
  try {
    const app = JSON.parse(git(['show', `${tag}:app.json`]));
    const code = (app.expo || app).android.versionCode;
    if (Number.isInteger(code) && code > 0) return code;
  } catch {
    // Fall through to the formula bump-version.js writes.
  }
  const [major, minor, patch] = parseReleaseTag(`v${version}`);
  return major * 10000 + minor * 100 + patch;
}

function fakeRelease(tag) {
  return {
    tag_name: tag,
    html_url: `https://github.com/Kaos599/Maglev/releases/tag/${tag}`,
    body: '',
    draft: false,
    prerelease: false,
    assets: ABIS.map(({ abi }) => ({
      name: `Maglev-${tag}-${abi}.apk`,
      browser_download_url: `https://github.com/Kaos599/Maglev/releases/download/${tag}/Maglev-${tag}-${abi}.apk`,
      digest: `sha256:${'0'.repeat(64)}`,
      size: 1,
    })),
  };
}

/** Why apps on `prev` would not be offered `newTag`, or null when they would be. */
function reasonUnreachable(old, prev, newTag) {
  if (typeof old.parseRelease !== 'function') return `its ${CHECK_FILE} has no parseRelease to check against`;
  if (typeof old.parseTag === 'function' && old.parseTag(newTag) === null) {
    return `its updater can't read the tag ${newTag}`;
  }
  const version = prev.slice(1);
  if (typeof old.isNewer === 'function' && !old.isNewer(newTag, version)) {
    return `its updater doesn't count ${newTag} as newer than ${version}`;
  }
  const code = installedVersionCode(prev, version);
  const release = fakeRelease(newTag);
  for (const { abi, digit } of ABIS) {
    const installed = { version, versionCode: code * 10 + digit };
    // From 1.1 on the app scans a list of releases; older apps read one release.
    const info = typeof old.pickRelease === 'function' ? old.pickRelease([release], installed) : old.parseRelease(release, installed);
    if (!info || info.tag !== newTag) return `its updater offers no ${abi} APK for ${newTag}`;
  }
  return null;
}

function main() {
  if (process.argv[2] === 'make-latest') {
    const tag = process.argv[3];
    if (!tag || !parseReleaseTag(tag)) {
      console.error(`Usage: node scripts/check-updater-reach.js make-latest <tag> (got "${tag ?? ''}")`);
      process.exit(1);
    }
    console.log(isLatestTag(tag) ? 'true' : 'false');
    return;
  }

  const newTag = process.argv[2];
  if (!newTag || !parseReleaseTag(newTag)) {
    console.error(`Usage: node scripts/check-updater-reach.js <tag>, where the tag is v<major>.<minor> or v<major>.<minor>.<patch> (got "${newTag ?? ''}")`);
    process.exit(1);
  }
  // A shallow clone has no earlier tags, which would look like a first release and pass without checking anything.
  if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    console.error('::error::This clone is shallow, so the earlier release tags are missing. Check out with fetch-depth: 0.');
    process.exit(1);
  }
  const earlier = earlierTags(newTag);
  if (earlier.length === 0) {
    console.log(`No release tag before ${newTag}, so no installed app to check.`);
    return;
  }

  let ts;
  const load = (tag) => {
    ts = ts || loadTs();
    return loadFromTag(ts, tag, CHECK_FILE);
  };
  const failures = [];
  const passes = [];

  // 1. Apps on the release just before this one.
  const prev = earlier[earlier.length - 1];
  try {
    const reason = reasonUnreachable(load(prev), prev, newTag);
    if (reason) failures.push(`Apps on ${prev} won't see ${newTag} in their updater: ${reason}.`);
    else passes.push(`Apps on ${prev} will see ${newTag} in their updater (checked ${ABIS.map((a) => a.abi).join(', ')}).`);
  } catch (e) {
    failures.push(`Apps on ${prev} won't see ${newTag} in their updater: the guard couldn't load its updater (${e && e.message ? e.message : e}).`);
  }

  // 2. The latest release is all that older apps ever read, so a new latest must be one they can install.
  if (isLatestTag(newTag)) {
    const latestOnly = [];
    for (const tag of earlier) {
      if (!hasFile(tag, CHECK_FILE)) continue;
      try {
        const old = load(tag);
        if (typeof old.pickRelease === 'function') continue;
        latestOnly.push(tag);
        // Already checked above; listed here only so the summary names the whole range.
        if (tag === prev) continue;
        const reason = reasonUnreachable(old, tag, newTag);
        if (reason) failures.push(`Apps on ${tag} won't see ${newTag} in their updater: they read only the latest release, and ${reason}.`);
      } catch (e) {
        failures.push(`Apps on ${tag} won't see ${newTag} in their updater: the guard couldn't load its updater (${e && e.message ? e.message : e}).`);
      }
    }
    if (latestOnly.length > 0) {
      passes.push(`${newTag} will be the latest release. Apps on ${latestOnly[0]} to ${latestOnly[latestOnly.length - 1]} read only the latest release; checked ${latestOnly.length} of those versions.`);
    }
  } else {
    passes.push(`${newTag} has a patch number, so it's published without the latest mark. Apps that read only the latest release keep seeing the last <major>.<minor> release.`);
  }

  if (failures.length === 0) {
    for (const line of passes) console.log(line);
    return;
  }
  const allow = process.env.ALLOW_UNREACHABLE;
  if (allow === '1' || allow === 'true') {
    const bar = '!'.repeat(78);
    for (const message of failures) console.log(`::warning::${message} Released anyway because ALLOW_UNREACHABLE is set.`);
    console.log(`${bar}\n!! RELEASING ANYWAY.\n${failures.map((m) => `!! ${m}`).join('\n')}\n!! Those apps have to update by hand or wait for a release they can read.\n${bar}`);
    return;
  }
  for (const message of failures) console.error(`::error::${message}`);
  console.error(`${failures.join('\n')}\nPick a tag those versions understand, or run the release workflow by hand with "allow_unreachable" set if this is on purpose.`);
  process.exit(1);
}

main();
