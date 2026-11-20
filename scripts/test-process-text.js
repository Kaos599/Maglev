// "Download with Maglev" in the text-selection menu (ACTION_PROCESS_TEXT) and the Home clipboard chip using the quick share card.
// https://developer.android.com/reference/android/content/Intent#ACTION_PROCESS_TEXT
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

(async () => {
  const plugin = require('../plugins/withShareIntents.js');
  const ACT = 'com.maglev.engine.share.QuickShareActivity';
  const manifest = {
    manifest: { application: [{ activity: [{ $: { 'android:name': '.MainActivity' }, 'intent-filter': [] }] }] },
  };
  const out = plugin.applyQuickShareManifest(manifest);
  const find = (m) => m.manifest.application[0].activity.find((a) => a.$['android:name'] === ACT);
  const quick = find(out);
  assert(quick, 'quick share activity declared');
  assert.strictEqual(quick.$['android:theme'], '@style/MaglevQuickShare', 'theme kept');
  assert.strictEqual(quick.$['android:excludeFromRecents'], 'true', 'recents setting kept');
  const pt = quick['intent-filter'].filter((f) => f.action.some((a) => a.$['android:name'] === 'android.intent.action.PROCESS_TEXT'));
  assert.strictEqual(pt.length, 1, 'one PROCESS_TEXT filter');
  assert.strictEqual(pt[0].$['android:label'], 'Download with Maglev', 'filter label');
  assert.strictEqual(plugin.PROCESS_TEXT_LABEL, 'Download with Maglev');
  assert(pt[0].category.some((c) => c.$['android:name'] === 'android.intent.category.DEFAULT'), 'DEFAULT category');
  assert(pt[0].data.some((d) => d.$['android:mimeType'] === 'text/plain'), 'text/plain');
  assert.strictEqual(quick['intent-filter'].filter((f) => f.$ && f.$['android:label']).length, 1, 'only the PROCESS_TEXT filter is labelled');
  const again = find(plugin.applyQuickShareManifest(JSON.parse(JSON.stringify(out))));
  assert.strictEqual(again['intent-filter'].length, quick['intent-filter'].length, 'idempotent');

  const kt = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/share/QuickShareActivity.kt');
  assert(/Intent\.ACTION_PROCESS_TEXT\s*->\s*i\.getCharSequenceExtra\(Intent\.EXTRA_PROCESS_TEXT\)/.test(kt), 'reads EXTRA_PROCESS_TEXT');
  assert(!/setResult|EXTRA_PROCESS_TEXT_READONLY/.test(kt), 'never returns text');
  assert(/original\.action == Intent\.ACTION_PROCESS_TEXT && link != null/.test(kt), 'Open in Maglev hands over the found link');

  const mod = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/share/MaglevQuickShareModule.kt');
  assert(/Name\("MaglevQuickShare"\)/.test(mod) && /QuickShareActivity::class\.java/.test(mod) && /ACTION_SEND/.test(mod), 'launcher module');
  assert(JSON.parse(read('modules/maglev-engine/expo-module.config.json')).android.modules.includes('com.maglev.engine.share.MaglevQuickShareModule'), 'module registered');
  assert(/MaglevQuickShare/.test(read('modules/maglev-engine/src/MaglevQuickShare.ts')), 'TS wrapper');
  assert(/MaglevQuickShare/.test(read('modules/maglev-engine/src/index.ts')), 'TS export');

  const home = read('app/(tabs)/index.tsx');
  assert(/clipboardUsesCard\(clipboardMagnet\) && openQuickShare\(clipboardMagnet\)/.test(home), 'chip opens the card for file links');
  assert(/router\.push\(clipboardRoute\(clipboardMagnet\)\)/.test(home), 'magnets and fallback keep the route');
  const copy = await import(path.join(root, 'constants/clipboardCopy.ts'));
  const got = ['https://a.com/f.zip', 'magnet:?xt=urn:btih:abc', 'https://a.com/x.torrent', 'hello'].map(copy.clipboardUsesCard);
  assert.deepStrictEqual(got, [true, false, false, false], 'only plain http(s) links use the card');
  console.log('process-text OK');
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
