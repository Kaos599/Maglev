#!/usr/bin/env node
// Quick share (docs/contracts-0.19/quick-share.md): plugin manifest output, the setting round trip, link classification
// (shared fixture with the Kotlin test) and the native wiring. Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const ENGINE_KT = 'modules/maglev-engine/android/src/main/java/com/maglev/engine/';

async function main() {
  // --- classification: fixture shared with ShareClassifyTest.kt ---
  console.log('classification');
  const { classifyShare } = await import('../modules/maglev-engine/src/shareClassify.ts');
  const vectors = JSON.parse(read('modules/maglev-engine/src/shareClassify.fixture.json'));
  check('fixture has the five kinds', ['magnet', 'torrent_file', 'file_link', 'web_page', 'none'].every((k) => vectors.some((v) => v.kind === k)));
  for (const v of vectors) {
    const got = classifyShare(v.text, v.mime);
    let ok = true;
    try {
      assert.deepStrictEqual({ kind: got.kind, source: got.source, name: got.name, infoHash: got.infoHash }, { kind: v.kind, source: v.source, name: v.name, infoHash: v.infoHash });
    } catch (e) {
      ok = false;
    }
    check(`classify: ${v.label}`, ok, JSON.stringify(got));
  }
  const kt = read(ENGINE_KT + 'share/ShareClassify.kt');
  check('Kotlin classifier exists with the same entry point', /object ShareClassify/.test(kt) && /fun classify\(text: String\?, mime: String\?\)/.test(kt));
  const ktTest = read('modules/maglev-engine/android/src/test/java/com/maglev/engine/share/ShareClassifyTest.kt');
  check('Kotlin test reads the shared fixture', /shareClassify\.fixture\.json/.test(ktTest));

  // --- the setting round trip (AGENTS.md rule 6) ---
  console.log('setting: add without asking');
  const { DEFAULT_SETTINGS } = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  const { migrateSettings, MaglevSettingsStore } = await import('../modules/maglev-engine/src/MaglevSettingsStore.ts');
  const { toGovernance } = await import('../modules/maglev-engine/src/toNativeConfig.ts');
  check('default is off', DEFAULT_SETTINGS.storage.addWithoutAsking === false);
  check('governance carries it (off)', toGovernance(DEFAULT_SETTINGS).quickAdd === false);
  const on = migrateSettings({ version: 3, settings: { storage: { addWithoutAsking: true }, appearance: { mode: 'light' } } });
  check('migrate keeps a stored true', on.storage.addWithoutAsking === true);
  check('migrate fills an old payload with false', migrateSettings({ version: 2, settings: { storage: {} } }).storage.addWithoutAsking === false);
  check('migrate ignores a wrong type', migrateSettings({ settings: { storage: { addWithoutAsking: 'yes' } } }).storage.addWithoutAsking === false);
  check('governance carries it (on) and the appearance mode', toGovernance(on).quickAdd === true && toGovernance(on).appearanceMode === 'light');
  const store = MaglevSettingsStore.getInstance();
  store.updateSettings({ storage: { ...store.getSettings().storage, addWithoutAsking: true } });
  check('store update sticks', store.getSettings().storage.addWithoutAsking === true && toGovernance(store.getSettings()).quickAdd === true);
  store.resetToDefaults();
  const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
  check('GovernanceConfig types the new fields', /quickAdd\??: boolean/.test(types) && /appearanceMode\??: /.test(types));
  const module_ = read(ENGINE_KT + 'MaglevEngineModule.kt');
  check('setGovernance saves quick share prefs', /QuickSharePrefs\.save\(/.test(module_));
  const prefs = read(ENGINE_KT + 'share/QuickSharePrefs.kt');
  check('Kotlin reads add_without_asking, default false', /add_without_asking/.test(prefs) && /getBoolean\(KEY_ADD_WITHOUT_ASKING, false\)/.test(prefs));
  check('prefs read the keys JS sends', /"quickAdd"/.test(prefs) && /"appearanceMode"/.test(prefs));
  const storage = read('app/settings/storage.tsx');
  check('Storage screen has the toggle', /addWithoutAsking/.test(storage) && /<Toggle/.test(storage));
  const copy = read('constants/copy.ts');
  const m = /\/\/ region quick share[\s\S]*?\/\/ endregion quick share/.exec(copy);
  check('copy block is marked', !!m);
  check('copy has the card strings', m && /No link in what you shared/.test(m[0]) && /This is a web page, not a file/.test(m[0]) && /Added to Maglev/.test(m[0]));
  const text = read(ENGINE_KT + 'share/QuickShareText.kt');
  const plain = m ? m[0].slice(m[0].indexOf('gettingDetails')) : '';
  const strings = [...plain.matchAll(/'([^'\n]{6,})'|"([^"\n]{6,})"/g)].map((x) => x[1] || x[2]).filter((s) => /^[A-Z]/.test(s));
  const missing = strings.filter((s) => !text.includes(s));
  check('every plain copy string is mirrored in Kotlin', strings.length > 8 && missing.length === 0, missing.join(' | '));

  // --- plugin output ---
  console.log('plugin manifest');
  const plugin = require('../plugins/withShareIntents.js');
  check('plugin exports applyQuickShareManifest', typeof plugin.applyQuickShareManifest === 'function');
  const ACT = 'com.maglev.engine.share.QuickShareActivity';
  const fromAppJson = JSON.parse(read('app.json')).expo.android.intentFilters;
  const asXml = (f) => ({
    action: [{ $: { 'android:name': `android.intent.action.${f.action}` } }],
    category: f.category.map((c) => ({ $: { 'android:name': `android.intent.category.${c}` } })),
    data: f.data.map((d) => ({ $: Object.fromEntries(Object.entries(d).map(([k, v]) => [`android:${k}`, v])) })),
  });
  const mainFilters = [
    ...fromAppJson.map(asXml),
    { action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }], category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }], data: [{ $: { 'android:scheme': 'maglev' } }] },
  ];
  const manifest = () => ({
    manifest: {
      application: [{ activity: [{ $: { 'android:name': '.MainActivity' }, 'intent-filter': JSON.parse(JSON.stringify(mainFilters)) }] }],
    },
  });
  const run = (mf) => plugin.applyQuickShareManifest(mf);
  const out = run(manifest());
  const acts = out.manifest.application[0].activity;
  const quick = acts.find((a) => a.$['android:name'] === ACT);
  const main = acts.find((a) => a.$['android:name'] === '.MainActivity');
  check('activity declared', !!quick);
  check('activity is exported, off the recents list, own affinity', quick && quick.$['android:exported'] === 'true' && quick.$['android:excludeFromRecents'] === 'true' && quick.$['android:taskAffinity'] === '');
  check('activity uses the translucent theme', quick && quick.$['android:theme'] === '@style/MaglevQuickShare');
  const flat = (a) => (a['intent-filter'] || []).map((f) => ({
    actions: (f.action || []).map((x) => x.$['android:name'].split('.').pop()),
    cats: (f.category || []).map((x) => x.$['android:name'].split('.').pop()),
    data: (f.data || []).map((x) => x.$),
  }));
  const qf = flat(quick);
  const hasAction = (n) => qf.some((f) => f.actions.includes(n));
  check('quick share gets SEND text/plain', qf.some((f) => f.actions.includes('SEND') && f.data.some((d) => d['android:mimeType'] === 'text/plain')));
  check('quick share gets SEND_MULTIPLE', hasAction('SEND_MULTIPLE'));
  check('quick share gets the magnet filter', qf.some((f) => f.actions.includes('VIEW') && f.data.some((d) => d['android:scheme'] === 'magnet')));
  check('quick share gets the torrent file filter', qf.some((f) => f.actions.includes('VIEW') && f.data.some((d) => d['android:pathPattern'] === '.*\\.torrent')));
  const web = qf.filter((f) => f.data.some((d) => d['android:scheme'] === 'http' || d['android:scheme'] === 'https'));
  check('one http(s) filter for other browsers', web.length === 1);
  const w = web[0] || { data: [], cats: [] };
  const mimes = w.data.map((d) => d['android:mimeType']).filter(Boolean);
  check('http(s) filter has both schemes', w.data.some((d) => d['android:scheme'] === 'http') && w.data.some((d) => d['android:scheme'] === 'https'));
  check('http(s) filter lists the types', ['application/octet-stream', 'application/zip', 'application/x-7z-compressed', 'application/x-iso9660-image', 'application/x-bittorrent', 'video/*', 'audio/*'].every((t) => mimes.includes(t)), mimes.join(','));
  check('no APK type', !mimes.some((t) => /android\.package-archive/.test(t)));
  check('http(s) filter is not BROWSABLE', !w.cats.includes('BROWSABLE') && w.cats.includes('DEFAULT'));
  const allHttp = qf.concat(flat(main)).filter((f) => f.data.some((d) => /^https?$/.test(d['android:scheme'] || '')));
  check('no bare http(s) filter anywhere: every one has a mime type', allHttp.length > 0 && allHttp.every((f) => f.data.some((d) => d['android:mimeType'])));
  check('no filter at all with http(s) and a path or host only', allHttp.every((f) => f.data.every((d) => !d['android:host'] && !d['android:pathPattern'])));
  const mf = flat(main);
  check('MainActivity lost SEND, SEND_MULTIPLE, magnet and torrent filters', mf.every((f) => !f.actions.some((a) => /^SEND/.test(a)) && !f.data.some((d) => d['android:scheme'] === 'magnet' || /torrent/.test(d['android:mimeType'] || '') || /torrent/.test(d['android:pathPattern'] || ''))));
  check('MainActivity keeps its own scheme filter', mf.some((f) => f.data.some((d) => d['android:scheme'] === 'maglev')));
  const twice = run(out);
  check('plugin is idempotent', twice.manifest.application[0].activity.filter((a) => a.$['android:name'] === ACT).length === 1 && flat(twice.manifest.application[0].activity.find((a) => a.$['android:name'] === ACT)).length === qf.length);
  assert.throws(() => run({ manifest: { application: [{ activity: [] }] } }), /MainActivity/);

  console.log('native wiring');
  const styles = read('modules/maglev-engine/android/src/main/res/values/quick_share.xml');
  check('theme resource', /name="MaglevQuickShare"/.test(styles) && /windowIsTranslucent/.test(styles));
  const act = read(ENGINE_KT + 'share/QuickShareActivity.kt');
  check('activity finishes without starting MainActivity for the card', !/startActivity[\s\S]{0,40}MainActivity\.class/.test(act));
  check('activity adds through EngineHost add paths', /EngineHost\.addTorrent|QuickShareAdd\.add/.test(act + read(ENGINE_KT + 'share/QuickShareAdd.kt')));
  const add = read(ENGINE_KT + 'share/QuickShareAdd.kt');
  check('add path reuses addTorrent and addDownload', /EngineHost\.addTorrent\(/.test(add) && /EngineHost\.addDownload\(/.test(add));
  check('add path starts the engine and the service', /EngineHost\.ensureStarted\(\)/.test(add) && /BackgroundStart\.start\(/.test(add));
  check('EngineHost exposes ensureStarted', /fun ensureStarted\(/.test(read(ENGINE_KT + 'EngineHost.kt')));
  check('routes: browser prefill and free space', /maglev:\/\/browser\?url=/.test(act) && /maglev:\/\/free-space/.test(act));
  check('Toast text', /Added to Maglev/.test(text));
  check('no Compose in the share code', !/androidx\.compose/.test(act + read(ENGINE_KT + 'share/QuickShareCard.kt')));
  check('no system monospace', !/Typeface\.MONOSPACE|"monospace"/.test(read(ENGINE_KT + 'share/QuickShareCard.kt')));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nquick share checks passed');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
