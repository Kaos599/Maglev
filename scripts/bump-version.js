#!/usr/bin/env node
/**
 * Maglev versions are <major>.<minor> (user decision 2026-11-11). app.json holds the truth:
 *   expo.version              "0.1"
 *   expo.android.versionCode  major*1000 + minor  (ABI splits then use code*10 + abi digit)
 * package.json mirrors it as semver "<major>.<minor>.0" because npm requires three parts.
 * Release tags are v<major>.<minor>-beta while in beta, v<major>.<minor> after.
 *
 * Usage:
 *   node scripts/bump-version.js minor     0.1 -> 0.2
 *   node scripts/bump-version.js major     0.12 -> 1.0
 *   node scripts/bump-version.js set 0.1   write an exact version
 *   node scripts/bump-version.js check <tag>   exit 1 unless the tag matches app.json (used by the release workflow)
 */
const fs = require('fs');
const path = require('path');

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) throw new Error(`Version "${v}" must be <major>.<minor>, for example 0.1`);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (minor > 999) throw new Error(`minor ${minor} is above 999; bump the major version instead`);
  return { major, minor };
}

function bump(v, part) {
  const { major, minor } = parseVersion(v);
  if (part === 'minor') {
    if (minor + 1 > 999) throw new Error(`minor ${minor + 1} is above 999; bump the major version instead`);
    return `${major}.${minor + 1}`;
  }
  if (part === 'major') return `${major + 1}.0`;
  throw new Error(`Bump "${part}": use minor or major`);
}

function versionCode(v) {
  const { major, minor } = parseVersion(v);
  return major * 1000 + minor;
}

function releaseTag(v, beta = true) {
  parseVersion(v);
  return `v${v}${beta ? '-beta' : ''}`;
}

function checkTag(tag, v) {
  return tag === releaseTag(v, true) || tag === releaseTag(v, false);
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
      console.error(`Tag ${arg} does not match app.json version ${current} (expected ${releaseTag(current)} or ${releaseTag(current, false)})`);
      process.exit(1);
    }
    console.log(`Tag ${arg} matches version ${current}`);
    return;
  }

  let next;
  if (cmd === 'minor' || cmd === 'major') next = bump(current, cmd);
  else if (cmd === 'set') next = (parseVersion(arg), String(arg).trim());
  else {
    console.error('Usage: bump-version.js minor | major | set <x.y> | check <tag>');
    process.exit(2);
  }

  app.expo.version = next;
  app.expo.android = { ...app.expo.android, versionCode: versionCode(next) };
  fs.writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n');

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = `${next}.0`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  console.log(`${current} -> ${next} (versionCode ${versionCode(next)}, tag ${releaseTag(next)})`);
}

module.exports = { parseVersion, bump, versionCode, releaseTag, checkTag };
if (require.main === module) main(process.argv.slice(2));
