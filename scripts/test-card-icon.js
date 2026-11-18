#!/usr/bin/env node
// File-type icon on Transfers cards: which glyph, the UI-only setting, and the wiring. Needs Node 22.18+.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

(async () => {
  const { downloadCardGlyph: d, torrentCardGlyph: t } = await import('../utils/cardIcon.ts');
  console.log('[links and streams]');
  check('mp4 -> video', d('clip.mp4', false) === 'file-video');
  check('mp3 -> audio', d('a.MP3', false) === 'file-audio');
  check('zip -> archive', d('x.zip', false) === 'file-archive');
  check('unknown link -> file', d('download', false) === 'file');
  check('nameless stream -> video', d('Some title', true) === 'file-video');
  check('audio-named stream -> audio', d('track.m4a', true) === 'file-audio');

  console.log('[torrents]');
  check('largest file wins', t('Pack', [{ path: 'a.nfo', length: 10 }, { path: 'b.mkv', length: 9000 }, { path: 'c.jpg', length: 500 }]) === 'file-video');
  check('largest file of unknown kind falls back to name', t('Album.flac', [{ path: 'x.dat', length: 5 }]) === 'file-audio');
  check('empty list uses name extension', t('movie.mkv', []) === 'file-video');
  check('no files given uses name extension', t('setup.apk') === 'file-app');
  check('folder name looks like video', t('Show.S01.1080p.WEB-DL') === 'file-video');
  check('folder name looks like audio', t('Artist - Discography FLAC') === 'file-audio');
  check('folder name looks like book', t('Some Books epub') === 'file-doc');
  check('nothing to go on -> file', t('Random stuff') === 'file');

  console.log('[setting]');
  const types = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  const Store = await import('../modules/maglev-engine/src/MaglevSettingsStore.ts');
  const mig = (a) => Store.migrateSettings({ settings: { appearance: a } }).appearance.showFileIcons;
  check('default is on', types.DEFAULT_SETTINGS.appearance.showFileIcons === true);
  check('older payload gets on', mig({ mode: 'dim' }) === true);
  check('saved off survives', mig({ showFileIcons: false }) === false);
  check('non-boolean becomes on', mig({ showFileIcons: 'no' }) === true);
  check('UI only: toNativeConfig never reads it', !/showFileIcons/.test(read('modules/maglev-engine/src/toNativeConfig.ts')));
  const ui = read('app/settings/interface.tsx');
  check('Interface has the switch with the agreed copy', /Show file type icons in Transfers/.test(ui) && /Show an icon for the kind of file on each download\./.test(ui) && /showFileIcons/.test(ui));

  console.log('[wiring]');
  const card = read('components/TransferCard.tsx');
  const dl = read('components/transfers/DownloadCard.tsx');
  const screen = read('app/(tabs)/index.tsx');
  check('both cards use the pure choice', /torrentCardGlyph\(/.test(card) && /downloadCardGlyph\(/.test(dl));
  check('icon is decorative', /importantForAccessibility="no-hide-descendants"/.test(card) && /importantForAccessibility="no-hide-descendants"/.test(dl));
  check('memo comparators include the prop', /showFileIcon/.test(card.split('function sameCard')[1]) && /showFileIcon/.test(dl.split('function same(')[1]));
  check('screen passes the setting', (screen.match(/showFileIcon=\{showFileIcons\}/g) || []).length === 2);
  console.log('[biggest file from the engine, NATIVE_CONTRACT 38]');
  check('a torrent named without extension takes its biggest file', t('Big Buck Bunny', [{ path: 'Big Buck Bunny.mp4', length: 1 }]) === 'file-video');
  check('the card passes mainFile to the choice', /torrentCardGlyph\(t\.name, t\.mainFile/.test(card));
  check('the memo compares mainFile', /x\.mainFile === y\.mainFile/.test(card.split('function sameCard')[1]));
  const map = read('modules/maglev-engine/src/snapshotMapping.ts');
  check('the mapping carries main_file', /mainFile: s\.mainFile \?\? null/.test(map));
  const rs = read('native/maglev-core/src/types.rs') + read('native/maglev-core/src/engine.rs');
  check('Rust snapshot has main_file and sets it in every snapshot', /pub main_file: Option<String>/.test(rs) && (rs.match(/main_file: (main_file\(h\)|None),/g) || []).length === 3);
  check('no hex in the cards', !/#[0-9A-Fa-f]{6}\b/.test(card + dl));
  if (failed) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
  console.log('card icon: all passed');
})();
