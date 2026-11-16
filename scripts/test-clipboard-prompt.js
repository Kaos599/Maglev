#!/usr/bin/env node
// Copied-link prompt: copy, Not now persists, toggle gates the clipboard read, http vs magnet routing.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}

(async () => {
  const copy = await import(path.join(root, 'constants/clipboardCopy.ts'));
  const prefs = await import(path.join(root, 'utils/prefs/clipboard.ts'));

  check('title', copy.clipboardCopy.title === 'Download the copied link?');
  check('buttons', copy.clipboardCopy.download === 'Download' && copy.clipboardCopy.notNow === 'Not now');
  check('setting title', copy.clipboardCopy.settingTitle === 'Offer to download copied links');
  check('setting subtitle', /when you open Maglev with a link copied/i.test(copy.clipboardCopy.settingSubtitle) && /Android shows a notice/.test(copy.clipboardCopy.settingSubtitle) && copy.clipboardCopy.settingSubtitle.length <= 90);

  const hash = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
  check('magnet without name never shows the hash', copy.clipboardLabel(hash) === 'Torrent from your clipboard');
  check('magnet dn name', copy.clipboardLabel(hash + '&dn=Big+Buck%20Bunny&tr=x') === 'Big Buck Bunny');
  check('http file name', copy.clipboardLabel('https://www.example.com/a/movie.mp4?x=1') === 'movie.mp4');
  check('http host when no file', copy.clipboardLabel('https://www.example.com/watch') === 'example.com');
  check('torrent link label', copy.clipboardLabel('https://example.com/x.torrent') === 'x.torrent');

  check('magnet routes to add-torrent', copy.clipboardRoute(hash).pathname === '/add-torrent' && copy.clipboardRoute(hash).params.source === hash);
  check('.torrent link routes to add-torrent', copy.clipboardRoute('https://e.com/a.torrent').pathname === '/add-torrent');
  const http = 'https://e.com/file.zip';
  check('http link routes to add-download', copy.clipboardRoute(http).pathname === '/add-download' && copy.clipboardRoute(http).params.url === http);

  check('catchCopiedLinks defaults on', prefs.getCatchCopiedLinks() === true);
  prefs.setCatchCopiedLinks(false);
  check('catchCopiedLinks persists off', prefs.getCatchCopiedLinks() === false);
  prefs.setCatchCopiedLinks(true);
  check('nothing dismissed at first', prefs.isDismissedClip(http) === false);
  prefs.dismissClip(http);
  check('dismissed text remembered', prefs.isDismissedClip(http) === true && prefs.isDismissedClip(' ' + http + ' ') === true);
  check('another text is not dismissed', prefs.isDismissedClip('https://e.com/other.zip') === false);
  const { kvGet } = await import(path.join(root, 'utils/prefs/kv.ts'));
  check('stored in kv (survives restart)', typeof kvGet(prefs.DISMISSED_CLIP_KEY) === 'string');

  const ctx = read('context/EngineContext.tsx');
  check('checkClipboard returns before reading when off', /checkClipboard = useCallback\(async \(\) => \{\s*\/\/ Off.*\n\s*if \(!getCatchCopiedLinks\(\)\) \{\s*setClipboardMagnet\(null\);\s*return;\s*\}\s*try \{\s*const content = await Clipboard/.test(ctx));

  const idx = read('app/(tabs)/index.tsx');
  check('index routes through clipboardRoute', /router\.push\(clipboardRoute\(clipboardMagnet\)\)/.test(idx));
  check('Not now saves the text', /dismissClip\(clipboardMagnet\)/.test(idx));
  check('dismissed clip is not new', /isDismissedClip\(clipboardMagnet\)/.test(idx));

  const chip = read('components/transfers/ClipboardChip.tsx');
  check('chip uses prompt copy and label', /clipboardCopy\.title/.test(chip) && /clipboardLabel\(/.test(chip));
  check('chip has both buttons', /clipboardCopy\.download/.test(chip) && /clipboardCopy\.notNow/.test(chip));

  const set = read('components/settings/ClipboardSetting.tsx');
  check('ClipboardSetting exported, no props', /export function ClipboardSetting\(\)/.test(set));
  check('setting uses ListRow + Toggle', /<ListRow/.test(set) && /<Toggle/.test(set));
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})();
