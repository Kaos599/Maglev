#!/usr/bin/env node
// Owner-approved UI edge cases: Undo window and Android's accessibility timeout, Settings search leaving, "already has
// subtitles", the highlight dialog's height, plain launches, closing mid-entrance, light theme and reduce motion.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

(async () => {
  console.log('UI edge cases');

  console.log('[7 undo window]');
  const U = await import('../utils/undoWindow.ts');
  check('base is 5000', U.UNDO_BASE_MS === 5000);
  check('never shorter than 5 s', U.undoWindowMs(2000) === 5000 && U.undoWindowMs(0) === 5000 && U.undoWindowMs(-1) === 5000);
  check('a longer accessibility timeout wins', U.undoWindowMs(12000) === 12000);
  check('missing or unreadable values give the base', U.undoWindowMs(null) === 5000 && U.undoWindowMs(undefined) === 5000 && U.undoWindowMs(NaN) === 5000 && U.undoWindowMs(Infinity) === 5000);
  const rn = read('node_modules/react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo.js');
  check('RN has getRecommendedTimeoutMillis (Android, async)', /getRecommendedTimeoutMillis\(originalTimeout: number\): Promise<number>/.test(rn));
  const ctx = read('context/EngineContext.tsx');
  check('the Undo timer uses the recommended window, read on Android and refreshed on return',
    /getRecommendedTimeoutMillis\(UNDO_WINDOW_MS\)/.test(ctx) && /undoWindowMs\(ms, UNDO_WINDOW_MS\)/.test(ctx) && /setTimeout\(flushRemoval, undoMs\.current\)/.test(ctx) && /Platform\.OS !== 'android'/.test(ctx));

  console.log('[8 settings search leaves clean]');
  const tab = read('app/(tabs)/settings.tsx');
  const search = read('components/settings/SettingsSearch.tsx');
  check('opening a result dismisses the keyboard before navigating', /Keyboard\.dismiss\(\);\s*router\.push/.test(search));
  check('coming back clears the field and dismisses the keyboard (useFocusEffect)', /useFocusEffect\(\s*useCallback\(\(\) => \{\s*setQuery\(''\);\s*Keyboard\.dismiss\(\);/.test(tab));

  console.log('[9 already has subtitles]');
  const E = await import('../utils/subtitles/existing.ts');
  const C = await import('../utils/subtitles/copy.ts');
  const files = ['Big Buck Bunny.mkv', 'Big Buck Bunny.en.srt', 'Big Buck Bunny.fr.hi.ass', 'Big Buck Bunny.eng.vtt', 'Other/Clip.de.srt'];
  const has = (v, l, f) => E.hasExistingSubtitle(v, l, f);
  check('.en.srt matches English', has('Big Buck Bunny.mkv', 'en', files));
  check('.eng.vtt form matches', has('Big Buck Bunny.mkv', 'en', ['Big Buck Bunny.eng.vtt']));
  check('.ass and a hearing-impaired tag match', has('Big Buck Bunny.mkv', 'fr', files));
  check('a language name in the file name matches', has('Big Buck Bunny.mkv', 'en', ['Big Buck Bunny.English.srt']));
  check('another language does not match', !has('Big Buck Bunny.mkv', 'de', files));
  check('".hi" is a tag, not Hindi', !has('Big Buck Bunny.mkv', 'hi', files));
  check('a subtitle of another video does not match', !has('a/M.mkv', 'en', ['a/Other.en.srt']) && !has('a/M.mkv', 'en', ['a/M2.en.srt']));
  check('a subtitle in another folder does not match', !has('a/M.mkv', 'en', ['b/M.en.srt']) && !has('a/M.mkv', 'en', ['b/English.srt']));
  check('English.srt in the same folder matches (also numbered)', has('a/M.mkv', 'en', ['a/English.srt']) && has('a/M.mkv', 'en', ['a/2_English.srt']));
  check('a non-subtitle file never matches', !has('a/M.mkv', 'en', ['a/M.en.txt', 'a/M.en.mkv']));
  check('an unknown language never matches', !has('a/M.mkv', 'zzzz', ['a/M.zzzz.srt']));
  check('case and Windows separators do not matter', has('A\\M.MKV', 'en', ['a\\m.EN.SRT']));
  check('the message uses the language helper', C.alreadyHasCopy('en') === 'This video already has English subtitles.' && C.alreadyHasCopy('de') === 'This video already has German subtitles.');
  const sheet = read('components/subtitles/SubtitleSheet.tsx');
  check('the sheet says it instead of "No English subtitles found." when a file exists', /hasExistingSubtitle\(target\.existing\.videoPath, state\.language, target\.existing\.files\) \? alreadyHasCopy\(state\.language\) : errorCopy\('nothing'/.test(sheet));
  const F = await import('../components/subtitles/flow.ts');
  const vid = { path: 'M/M.mkv', length: 10, progressBytes: 10, index: 0 };
  const tt = F.torrentTarget('abc', '/storage/x', vid, [vid, { path: 'M/M.en.srt' }]);
  check('a torrent target carries the video path and file list', tt && tt.existing && tt.existing.videoPath === 'M/M.mkv' && tt.existing.files.length === 2);
  check('without a file list nothing is carried', !F.torrentTarget('abc', '/storage/x', vid).existing);

  console.log('[11 dialog scrolls]');
  const L = await import('../utils/dialogLayout.ts');
  check('max height is window less insets and margins', L.dialogMaxHeight(640, 24, 24, 16) === 640 - 48 - 32);
  check('never below the floor', L.dialogMaxHeight(300, 40, 40, 16) === 240 && L.dialogMaxHeight(NaN, 0, 0, 0) === 240);
  const dialog = read('components/ui/Dialog.tsx');
  check('the card is capped and the title, content and actions scroll under the hero',
    /\{ maxHeight \}/.test(dialog) && /dialogMaxHeight\(windowHeight, insets\.top, insets\.bottom, spacing\.lg\)/.test(dialog) && /\{hero\}\s*<ScrollView/.test(dialog) && /flexShrink: 1/.test(dialog));

  console.log('[12 plain launch]');
  const H = await import('../utils/highlights.ts');
  const notPlain = ['magnet:?xt=urn:btih:abc', 'content://x/y.torrent', 'file:///sdcard/a.torrent', 'https://example.com/v', 'maglev://torrent/dl_ab12', 'maglev://settings/updates', 'maglev://share?u=x', 'maglev://add-torrent?source=x', 'maglev://from/tile', 'maglev://from/notification', 'maglev://search?q=x', ' maglev://browser?url=x '];
  check('notification taps with a link, shares, magnets, files and deep links are not plain', notPlain.every((u) => !H.isPlainLaunch(u)), notPlain.filter((u) => H.isPlainLaunch(u)).join(','));
  check('a launcher start is plain', [null, undefined, '', '  ', 'maglev://', 'maglev:///', 'MAGLEV://'].every((u) => H.isPlainLaunch(u)));
  const ni = read('app/+native-intent.tsx');
  const rx = /\.test\(appPath\(raw\)/.exec(ni) ? new RegExp('^\\/?from\\/(tile|notification)\\/?$', 'i') : null;
  check('the tile and notification markers open Transfers (native intent maps them to "/")', !!rx && /from\\\/\(tile\|notification\)/.test(ni) && /return '\/';/.test(ni.slice(ni.indexOf('from\\/(tile|notification)'))) && ['/from/tile', '/from/notification'].every((p) => rx.test(p)));
  const sh = read('components/HighlightSheet.tsx');
  check('a link that arrives while running also blocks it', /addEventListener\('url', \(\) => setPlain\(false\)\)/.test(sh));

  console.log('[13 closing mid-entrance]');
  const ent = read('components/highlight/useEntrance.ts');
  check('useEntrance takes the open flag and cancels the pending haptic when it closes', /useEntrance\(open: boolean = true\)/.test(ent) && /if \(!open\) cancelAnimation\(gate\)/.test(ent));
  check('the impact callback is guarded by the live flag', /if \(live\.current\) haptic\('done'\)/.test(ent));
  check('unmounting cancels the pending haptic too', /live\.current = false;\s*cancelAnimation\(gate\)/.test(ent));
  check('the dialog passes its open state', /useEntrance\(open\)/.test(sh));
  check('closing drops a pending accessibility focus', /closing: no accessibility focus after it/.test(dialog));

  console.log('[14 light theme and reduce motion]');
  const T = await import('../constants/theme.ts');
  const bad = [];
  for (const mode of ['oled', 'dim', 'light']) {
    for (const accent of Object.keys(T.accents)) {
      const c = T.buildColors(mode, accent);
      const a = T.contrast(c.onAccent, c.accent);
      const b = T.contrast(c.accentText, c.surface);
      if (a < 4.5) bad.push(`${mode}/${accent} NEW text on fill ${a.toFixed(2)}`);
      if (b < 4.5) bad.push(`${mode}/${accent} version text on plate ${b.toFixed(2)}`);
    }
  }
  check('badge text is at least 4.5:1 on the lime fill and on the surface plate, every mode and accent', bad.length === 0, bad.join('; '));
  const st = read('components/highlight/Station.tsx');
  check('the badge text and plates come from tokens', /color: colors\.onAccent/.test(st) && /color: colors\.accentText/.test(st) && /Cross color=\{colors\.surface\}/.test(st) && !/#[0-9a-fA-F]{3,8}\b/.test(st));
  const mk = read('components/brand/MaglevMark.tsx');
  check('the train is mono from tokens on light', /\{ body: colors\.text, lines: colors\.textMuted \}/.test(mk));
  const TL = await import('../components/highlight/timeline.ts');
  const TM = (await import('../components/highlight/timing.ts')).HIGHLIGHT_MOTION;
  const B = await import('../components/highlight/burst.ts');
  const end = TM.totalMs;
  const parts = B.burstLayout(TM.burstCount, TM.burstSizes, TM.burstWaves);
  check('the last frame has no burst, dust or flash, and the badge, card and text in place',
    parts.every((p) => TL.burstAt(end, p).opacity === 0) && TM.dust.every(([, dx, dy]) => TL.dustAt(end, dx, dy).opacity === 0) && TL.flashAt(end).opacity === 0 &&
      TL.stampAt(end).opacity === 1 && TL.cardAt(end).opacity === 1 && TL.scrimAt(end) === 1 && TL.riseAt(end, 5).opacity === 1 && TL.lastEnd() <= end);
  check('reduce motion jumps to the last frame and schedules no haptic', /if \(m\.disabled\) \{\s*clock\.value = M\.totalMs;\s*return;\s*\}/.test(ent));

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall passed');
})();
