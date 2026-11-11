const assert = require('assert');
const { applyAbiSplits, applyArchitectures } = require('../plugins/withAbiSplits');

const sample = `apply plugin: "com.android.application"

android {
    compileSdk rootProject.ext.compileSdkVersion
    defaultConfig {
        versionCode 1
    }
}
`;
const once = applyAbiSplits(sample);
assert(/splits\s*\{\s*abi\s*\{/.test(once), 'splits block missing');
assert(once.includes('universalApk true'), 'universalApk missing');
for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64']) assert(once.includes(`"${abi}"`), abi);
assert(!/"x86"/.test(once), 'x86 must not be present');
assert(once.indexOf('splits {') < once.indexOf('defaultConfig'), 'splits inside android block');
assert(once.includes('androidComponents'), 'versionCode block missing');
assert.strictEqual(applyAbiSplits(once), once, 'not idempotent');
assert.throws(() => applyAbiSplits('plugins {}'), /android \{/);

const props = applyArchitectures([
  { type: 'property', key: 'reactNativeArchitectures', value: 'armeabi-v7a,arm64-v8a,x86,x86_64' },
  { type: 'property', key: 'newArchEnabled', value: 'true' },
]);
assert.strictEqual(props.filter((p) => p.key === 'reactNativeArchitectures').length, 1);
assert.strictEqual(props.find((p) => p.key === 'reactNativeArchitectures').value, 'armeabi-v7a,arm64-v8a,x86_64');
assert(props.some((p) => p.key === 'newArchEnabled'));
// MAGLEV_ABIS narrows the build (CI uses arm64 only on everyday pushes; releases build all).
const { resolveAbis } = require('../plugins/withAbiSplits');
assert.deepStrictEqual(resolveAbis(undefined), ['armeabi-v7a', 'arm64-v8a', 'x86_64']);
assert.deepStrictEqual(resolveAbis(''), ['armeabi-v7a', 'arm64-v8a', 'x86_64']);
assert.deepStrictEqual(resolveAbis(' arm64-v8a '), ['arm64-v8a']);
assert.deepStrictEqual(resolveAbis('x86_64,arm64-v8a'), ['x86_64', 'arm64-v8a']);
assert.throws(() => resolveAbis('x86'), /unknown ABI/);
const narrow = applyAbiSplits(sample, ['arm64-v8a']);
assert(narrow.includes('include "arm64-v8a"\n'), 'narrow include');
assert(!narrow.includes('"armeabi-v7a", '), 'narrow must not list other ABIs');
assert.strictEqual(
  applyArchitectures([], ['arm64-v8a']).find((p) => p.key === 'reactNativeArchitectures').value,
  'arm64-v8a',
);

console.log('test-abi-splits: all assertions passed');
