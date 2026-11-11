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
console.log('test-abi-splits: all assertions passed');
