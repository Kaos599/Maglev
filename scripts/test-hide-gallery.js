#!/usr/bin/env node
// Hide downloads from the gallery: setting round trip (persisted, pushed to Kotlin in the setGovernance payload,
// echoed by the mock) and the Kotlin .nomedia handling. Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const KT = 'modules/maglev-engine/android/src/main/java/com/maglev/engine/';

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function main() {
  const { DEFAULT_SETTINGS } = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  const { migrateSettings } = await import('../modules/maglev-engine/src/MaglevSettingsStore.ts');
  const { toGovernance, toNativeConfig } = await import('../modules/maglev-engine/src/toNativeConfig.ts');

  console.log('setting');
  check('default is off', DEFAULT_SETTINGS.storage.hideFromGallery === false);
  check('old payload migrates to off', migrateSettings({ settings: { storage: { addWithoutAsking: true } } }).storage.hideFromGallery === false);
  check('a stored true survives', migrateSettings({ settings: { storage: { hideFromGallery: true } } }).storage.hideFromGallery === true);
  const on = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  on.storage.hideFromGallery = true;
  check('pushed to Kotlin in the governance payload', toGovernance(on).hideFromGallery === true && toGovernance(DEFAULT_SETTINGS).hideFromGallery === false);
  check('not sent to Rust', !('hide_from_gallery' in toNativeConfig(on)));

  console.log('mock echo');
  const mock = read('modules/maglev-engine/src/MaglevMockEngine.ts');
  check('mock setGovernance keeps hideFromGallery', /hideFromGallery/.test(mock));

  console.log('Kotlin');
  const prefs = read(KT + 'MaglevEngineModule.kt');
  check('module saves it from setGovernance', /GalleryHide\.save\(/.test(prefs));
  const gh = read(KT + 'storage/GalleryHide.kt');
  check('writes an empty .nomedia', /\.nomedia/.test(gh) && /createNewFile\(\)/.test(gh));
  check('SAF tree: createFile when absent', /findFile\(NOMEDIA\)/.test(gh) && /createFile\(/.test(gh));
  check('remembers the ones it created', /KEY_CREATED/.test(gh));
  check('delete only when empty and ours', /length\(\) == 0L/.test(gh) && /delete\(\)/.test(gh));
  check('has a skip-scan query', /fun hidden\(/.test(gh));
  const host = read(KT + 'EngineHost.kt');
  check('scanPaths skips when hidden', /private fun scanPaths[\s\S]{0,400}GalleryHide\.hidden\(c\)/.test(host));
  check('torrent export scan skips when hidden', /GalleryHide\.hidden\(c\)[\s\S]{0,200}application\/x-bittorrent|if \(!GalleryHide\.hidden\(c\)\)[\s\S]{0,300}x-bittorrent/.test(host));
  check('checked at engine start', /startEngine[\s\S]{0,2500}GalleryHide\.apply\(/.test(host));
  check('checked when the folder changes', /GalleryHide\.apply\(/.test(read(KT + 'MaglevEngineModule.kt')) || /GalleryHide\.apply\(/.test(read(KT + 'storage/StorageManager.kt')));

  console.log('UI');
  const ui = read('app/settings/storage.tsx');
  check('row title', /Hide from gallery/.test(ui));
  check('subtitle', /Photos and video apps won't list Maglev's downloads\. Your files stay in the folder\./.test(ui));
  check('caption says only new files change', /new files/i.test(ui));
  check('toggle writes settings.storage.hideFromGallery', /hideFromGallery: v/.test(ui));
  {
    const dl = read('app/settings/downloads.tsx');
    check('clipboard setting under Adding downloads (Downloads page since 0.25)', /SectionHeader title="Adding downloads"/.test(dl) && /<ClipboardSetting \/>/.test(dl));
  }

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nhide-gallery: all checks passed');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
