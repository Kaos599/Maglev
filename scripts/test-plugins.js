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
// --- backup rules (exclude session/ from Auto Backup) ---
{
  const { fullBackupXml, dataExtractionXml, applyBackupAttributes } = require('../plugins/withBackupRules');
  const full = fullBackupXml();
  assert(full.includes('<exclude domain="file" path="session/"/>'), 'full backup excludes session/');
  assert(full.includes('domain="external" path="Download/"'), 'full backup excludes staging/downloads');
  const ext = dataExtractionXml();
  const cloud = /<cloud-backup>([\s\S]*?)<\/cloud-backup>/.exec(ext)[1];
  const transfer = /<device-transfer>([\s\S]*?)<\/device-transfer>/.exec(ext)[1];
  for (const part of [cloud, transfer]) assert(part.includes('path="session/"'), 'data extraction excludes session/ in both sections');
  const app = applyBackupAttributes({ $: { 'android:allowBackup': 'true' } });
  assert.strictEqual(app.$['android:fullBackupContent'], '@xml/maglev_backup_rules');
  assert.strictEqual(app.$['android:dataExtractionRules'], '@xml/maglev_data_extraction_rules');
  assert.strictEqual(app.$['android:allowBackup'], 'true', 'unrelated attributes kept');
  assert.deepStrictEqual(applyBackupAttributes(app), app, 'attributes not idempotent');
}

// --- share intents (ACTION_SEND / SEND_MULTIPLE) ---
{
  const { applyMainActivity, KOTLIN } = require('../plugins/withShareIntents');
  const tpl =
    'package com.maglev\n\nimport android.os.Bundle\n\nclass MainActivity : ReactActivity() {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    setTheme(R.style.AppTheme);\n    super.onCreate(null)\n  }\n}\n';
  const out = applyMainActivity(tpl);
  assert(out.includes('import android.content.Intent'));
  assert(out.includes('override fun onNewIntent(intent: Intent) {\n    MaglevShareIntent.rewrite(intent)\n    super.onNewIntent(intent)'));
  assert(/onCreate\(savedInstanceState: Bundle\?\) \{\n    MaglevShareIntent\.rewrite\(intent\)\n    setTheme/.test(out), 'rewrite runs before super.onCreate');
  assert.strictEqual(applyMainActivity(out), out, 'MainActivity patch not idempotent');
  assert.throws(() => applyMainActivity('class X'), /onCreate not found/);
  assert(KOTLIN.includes('ACTION_SEND_MULTIPLE') && KOTLIN.includes('magnet:'));
  const fs = require('fs');
  const path = require('path');
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8')).expo;
  const filters = app.android.intentFilters;
  assert(filters.some((f) => f.action === 'SEND' && f.data.some((d) => d.mimeType === 'text/plain')), 'SEND text/plain filter');
  assert(filters.some((f) => f.action === 'SEND_MULTIPLE'), 'SEND_MULTIPLE filter');
  assert(app.plugins.includes('./plugins/withBackupRules.js') && app.plugins.includes('./plugins/withShareIntents.js'));
}
// --- cleartext for the home network (custom assistant provider) ---
{
  const { networkSecurityXml, applyNetworkSecurityConfig } = require('../plugins/withCleartextLan');
  const xml = networkSecurityXml();
  assert(xml.includes('<base-config cleartextTrafficPermitted="true">'), 'base config permits cleartext');
  assert(xml.includes('<certificates src="system"/>'), 'system trust anchors');
  assert(!xml.includes('src="user"'), 'no user CAs');
  const node = { $: { 'android:allowBackup': 'true', 'android:usesCleartextTraffic': 'false' } };
  assert.strictEqual(applyNetworkSecurityConfig(node), true);
  assert.strictEqual(node.$['android:networkSecurityConfig'], '@xml/maglev_network_security_config');
  assert.strictEqual(node.$['android:allowBackup'], 'true', 'unrelated attributes kept');
  assert.strictEqual(applyNetworkSecurityConfig(node), true, 'idempotent');
  const other = { $: { 'android:networkSecurityConfig': '@xml/other' } };
  assert.strictEqual(applyNetworkSecurityConfig(other), false, 'existing config is kept');
  assert.strictEqual(other.$['android:networkSecurityConfig'], '@xml/other');
  const app = require('../app.json').expo.android || require('../app.json').expo;
  assert((app.plugins || require('../app.json').expo.plugins).includes('./plugins/withCleartextLan.js'), 'registered');
}
console.log('test-plugins: all assertions passed');
