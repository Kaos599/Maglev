// Tests for scripts/bump-version.js (versions are <major>.<minor>, or <major>.<minor>.<patch> for a fix release).
const assert = require('assert');
const { parseVersion, bump, versionCode, releaseTag, checkTag } = require('./bump-version');

assert.deepStrictEqual(parseVersion('0.1'), { major: 0, minor: 1, patch: 0 });
assert.deepStrictEqual(parseVersion('2.15'), { major: 2, minor: 15, patch: 0 });
assert.deepStrictEqual(parseVersion('1.0.1'), { major: 1, minor: 0, patch: 1 });
assert.throws(() => parseVersion('0.1.0'), /not 0\.1\.0/);
assert.throws(() => parseVersion('1.0.100'), /patch/);
assert.throws(() => parseVersion('1.0.1.2'), /<major>\.<minor>/);
assert.throws(() => parseVersion('v0.1'), /<major>\.<minor>/);
assert.throws(() => parseVersion('1.100'), /minor/);

assert.strictEqual(bump('0.1', 'minor'), '0.2');
assert.strictEqual(bump('0.9', 'minor'), '0.10');
assert.strictEqual(bump('0.12', 'major'), '1.0');
assert.strictEqual(bump('1.0', 'patch'), '1.0.1');
assert.strictEqual(bump('1.0.1', 'patch'), '1.0.2');
assert.strictEqual(bump('1.0.1', 'minor'), '1.1');
assert.strictEqual(bump('1.0.1', 'major'), '2.0');
assert.throws(() => bump('1.0.99', 'patch'), /above 99/);
assert.throws(() => bump('0.1', 'huge'), /patch, minor or major/);

// Android versionCode must always grow: major*10000 + minor*100 + patch (ABI splits then multiply by 10).
assert.strictEqual(versionCode('0.1'), 100);
assert.strictEqual(versionCode('0.12'), 1200);
assert.strictEqual(versionCode('1.0'), 10000);
assert.strictEqual(versionCode(bump('1.0', 'minor')), 10100);
assert.strictEqual(versionCode(bump('1.0', 'major')), 20000);
assert.strictEqual(versionCode('1.0.1'), 10001);
assert.strictEqual(versionCode('1.0.2'), 10002);
assert(versionCode('1.0.99') < versionCode('1.1'));
assert(versionCode(bump('0.99', 'major')) > versionCode('0.99'));
assert.throws(() => bump('0.99', 'minor'), /above 99/);

assert.strictEqual(releaseTag('0.1'), 'v0.1');
assert.strictEqual(releaseTag('0.1', true), 'v0.1-beta');
assert.strictEqual(releaseTag('1.0', false), 'v1.0');
assert.strictEqual(checkTag('v0.1-beta', '0.1'), true);
assert.strictEqual(checkTag('v0.1', '0.1'), true);
assert.strictEqual(checkTag('v0.2-beta', '0.1'), false);
assert.strictEqual(checkTag('v0.1.0-beta', '0.1'), false);
assert.strictEqual(releaseTag('1.0.1'), 'v1.0.1');
assert.strictEqual(checkTag('v1.0.1', '1.0.1'), true);
assert.strictEqual(checkTag('v1.0', '1.0.1'), false);
assert.strictEqual(checkTag('v1.0.1', '1.0'), false);

console.log('test-version: all assertions passed');
