const assert = require('assert');
const { applySizeProperties, applyKeepRules } = require('../plugins/withSizeReduction');

const props = applySizeProperties([
  { type: 'property', key: 'expo.useLegacyPackaging', value: 'false' },
  { type: 'property', key: 'newArchEnabled', value: 'true' },
]);
const get = (k) => props.filter((p) => p.key === k);
assert.strictEqual(get('expo.useLegacyPackaging').length, 1);
assert.strictEqual(get('expo.useLegacyPackaging')[0].value, 'true');
assert.strictEqual(get('android.enableMinifyInReleaseBuilds')[0].value, 'true');
assert.strictEqual(get('android.enableShrinkResourcesInReleaseBuilds')[0].value, 'true');
assert(get('newArchEnabled').length === 1, 'unrelated props kept');
assert.deepStrictEqual(applySizeProperties(props), props, 'props not idempotent');

const rules = applyKeepRules('# existing\n-keep class a.B');
assert(rules.includes('-keep class com.maglev.engine.** { *; }'));
assert(rules.includes('native <methods>'));
assert(rules.startsWith('# existing\n'));
assert.strictEqual(applyKeepRules(rules), rules, 'rules not idempotent');
assert(applyKeepRules('').includes('com.maglev.engine'));
console.log('test-plugins: all assertions passed');
