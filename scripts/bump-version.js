#!/usr/bin/env node
/**
 * Maglev versions are <major>.<minor> for a feature release and <major>.<minor>.<patch> for a fix release
 * (1.0, 1.0.1, 1.0.2, 1.1). app.json holds the truth:
 *   expo.version              "1.0.1"   (a patch of 0 is never written: "1.1", not "1.1.0")
 *   expo.android.versionCode  major*10000 + minor*100 + patch  (1.0 = 10000, 1.0.1 = 10001, 1.1 = 10100)
 *                             ABI splits then use code*10 + abi digit (10000 -> 100000 universal, 100004 arm64)
 * package.json mirrors it as semver "<major>.<minor>.<patch>" because npm requires three parts.
 * Release tags were v0.x-beta during the beta; from 1.0 they are v<version>, for example v1.0 and v1.0.1.
 *
 * Usage:
 *   node scripts/bump-version.js patch     1.0 -> 1.0.1, 1.0.1 -> 1.0.2
 *   node scripts/bump-version.js minor     0.1 -> 0.2, 1.0.1 -> 1.1 (patch resets)
 *   node scripts/bump-version.js major     0.12 -> 1.0
 *   node scripts/bump-version.js set 0.1   write an exact version
 *   node scripts/bump-version.js check <tag>   exit 1 unless the tag matches app.json (used by the release workflow)
 */
const fs = require('fs');
const path = require('path');

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(v).trim());
  if (!m) throw new Error(`Version "${v}" must be <major>.<minor> or <major>.<minor>.<patch>, for example 1.0 or 1.0.1`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = m[3] === undefined ? 0 : Number(m[3]);
  if (minor > 99) throw new Error(`minor ${minor} is above 99; bump the major version instead`);
  if (patch > 99) throw new Error(`patch ${patch} is above 99; bump the minor version instead`);
  if (m[3] !== undefined && patch === 0) throw new Error(`Write ${major}.${minor}, not ${major}.${minor}.0`);
  return { major, minor, patch };
}

function format({ major, minor, patch }) {
  return patch > 0 ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
}

function bump(v, part) {
  const { major, minor, patch } = parseVersion(v);
  if (part === 'patch') {
    if (patch + 1 > 99) throw new Error(`patch ${patch + 1} is above 99; bump the minor version instead`);
    return format({ major, minor, patch: patch + 1 });
  }
  if (part === 'minor') {
    if (minor + 1 > 99) throw new Error(`minor ${minor + 1} is above 99; bump the major version instead`);
    return format({ major, minor: minor + 1, patch: 0 });
  }
  if (part === 'major') return format({ major: major + 1, minor: 0, patch: 0 });
  throw new Error(`Bump "${part}": use patch, minor or major`);
}

function versionCode(v) {
  const { major, minor, patch } = parseVersion(v);
  // Two decimal digits per part keep codes growing across patch, minor and major releases.
  return major * 10000 + minor * 100 + patch;
}

/** The three-part form npm needs in package.json. */
function semver(v) {
  const { major, minor, patch } = parseVersion(v);
  return `${major}.${minor}.${patch}`;
}

function releaseTag(v, beta = false) {
  parseVersion(v);
  return `v${v}${beta ? '-beta' : ''}`;
}

function checkTag(tag, v) {
  return tag === releaseTag(v, false) || tag === releaseTag(v, true);
}

function main(argv) {
  const root = path.join(__dirname, '..');
  const appPath = path.join(root, 'app.json');
  const pkgPath = path.join(root, 'package.json');
  const app = JSON.parse(fs.readFileSync(appPath, 'utf8'));
  const current = app.expo.version;
  const [cmd, arg] = argv;

  if (cmd === 'check') {
    if (!checkTag(arg, current)) {
      console.error(`Tag ${arg} does not match app.json version ${current} (expected ${releaseTag(current)})`);
      process.exit(1);
    }
    console.log(`Tag ${arg} matches version ${current}`);
    return;
  }

  let next;
  if (cmd === 'patch' || cmd === 'minor' || cmd === 'major') next = bump(current, cmd);
  else if (cmd === 'set') next = (parseVersion(arg), String(arg).trim());
  else {
    console.error('Usage: bump-version.js patch | minor | major | set <x.y[.z]> | check <tag>');
    process.exit(2);
  }

  app.expo.version = next;
  app.expo.android = { ...app.expo.android, versionCode: versionCode(next) };
  fs.writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n');

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = semver(next);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  console.log(`${current} -> ${next} (versionCode ${versionCode(next)}, tag ${releaseTag(next)})`);
}

module.exports = { parseVersion, format, semver, bump, versionCode, releaseTag, checkTag };
if (require.main === module) main(process.argv.slice(2));
