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
assert(/enable !gradle\.startParameter\.taskNames\.any \{ it\.toLowerCase\(\)\.contains\("bundle"\) \}/.test(once), 'splits must be off for bundle tasks');
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

// One versionCode scheme for every output: base*10 + ABI digit (universal APK and the AAB behind the
// bundletool APK set use digit 0). Never lower than a shipped code: 0.17 shipped 17 (universal, APK set)
// and 171/173/174 (split APKs), and base*10 for the next release is always above all of those.
const { versionCodeFor, ABI_DIGITS } = require('../plugins/withAbiSplits');
assert.deepStrictEqual(ABI_DIGITS, { 'armeabi-v7a': 1, x86_64: 3, 'arm64-v8a': 4 });
assert.strictEqual(versionCodeFor(18, 'arm64-v8a'), 184);
assert.strictEqual(versionCodeFor(18, 'armeabi-v7a'), 181);
assert.strictEqual(versionCodeFor(18, 'x86_64'), 183);
assert.strictEqual(versionCodeFor(18, null), 180, 'universal APK and AAB use digit 0');
assert.strictEqual(versionCodeFor(18, undefined), 180);
const shipped017 = [17, 171, 173, 174];
for (const code of [null, 'arm64-v8a', 'armeabi-v7a', 'x86_64'].map((a) => versionCodeFor(18, a))) {
  assert(code > Math.max(...shipped017), `${code} must beat every shipped 0.17 code`);
}
assert(versionCodeFor(19, null) > versionCodeFor(18, 'arm64-v8a'), 'next release beats every ABI of the previous one');
// The Gradle block must apply the scheme to ALL outputs (no ABI-only guard), or the AAB keeps the plain base.
assert(!/abiFilter\s*!=\s*null/.test(once), 'versionCode must not be limited to ABI-filtered outputs');
assert(/base \* 10 \+ abiCodes\.get\(abiFilter\?\.identifier, 0\)/.test(once), 'versionCode must be base*10 + digit (0 without an ABI)');

console.log('test-abi-splits: all assertions passed');
