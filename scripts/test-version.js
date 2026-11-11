// Tests for scripts/bump-version.js (versions are <major>.<minor>, user decision 2026-11-11).
const assert = require('assert');
const { parseVersion, bump, versionCode, releaseTag, checkTag } = require('./bump-version');

assert.deepStrictEqual(parseVersion('0.1'), { major: 0, minor: 1 });
assert.deepStrictEqual(parseVersion('2.15'), { major: 2, minor: 15 });
assert.throws(() => parseVersion('0.1.0'), /<major>\.<minor>/);
assert.throws(() => parseVersion('v0.1'), /<major>\.<minor>/);
assert.throws(() => parseVersion('1.1000'), /minor/);

assert.strictEqual(bump('0.1', 'minor'), '0.2');
assert.strictEqual(bump('0.9', 'minor'), '0.10');
assert.strictEqual(bump('0.12', 'major'), '1.0');
assert.throws(() => bump('0.1', 'patch'), /minor or major/);

// Android versionCode must always grow: major*1000 + minor (ABI splits then multiply by 10).
assert.strictEqual(versionCode('0.1'), 1);
assert.strictEqual(versionCode('0.12'), 12);
assert.strictEqual(versionCode('1.0'), 1000);
assert(versionCode(bump('0.999', 'major')) > versionCode('0.999'));
assert.throws(() => bump('0.999', 'minor'), /above 999/);

assert.strictEqual(releaseTag('0.1'), 'v0.1-beta');
assert.strictEqual(releaseTag('1.0', false), 'v1.0');
assert.strictEqual(checkTag('v0.1-beta', '0.1'), true);
assert.strictEqual(checkTag('v0.1', '0.1'), true);
assert.strictEqual(checkTag('v0.2-beta', '0.1'), false);
assert.strictEqual(checkTag('v0.1.0-beta', '0.1'), false);

console.log('test-version: all assertions passed');
