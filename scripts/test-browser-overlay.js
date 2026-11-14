#!/usr/bin/env node
// Static checks: the browser's controls float over the page, and the download sheets are floating cards.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const styleBlock = (src, key) => {
  const m = src.match(new RegExp(`\\n    ${key}: \\{[\\s\\S]*?\\n    \\},?\\n|\\n    ${key}: \\{[^\\n]*\\},?\\n`));
  return m ? m[0] : '';
};
const HEX = /#[0-9a-fA-F]{3,8}\b/;

const scr = read('app/browser.tsx');
console.log('overlay');
check('no full-width footer bar is left', !/styles\.footer\b/.test(scr) && !/\n    footer: \{/.test(scr));
const overlay = styleBlock(scr, 'overlay');
check('the controls row is absolutely positioned', /position: 'absolute'/.test(overlay) && /bottom: spacing\.md/.test(overlay) && /right: spacing\.md/.test(overlay));
check('the overlay lets touches through to the page', /styles\.overlay\} pointerEvents="box-none"/.test(scr));
check('the overlay sits inside the body, above the web view', scr.indexOf('<TabWebView') < scr.indexOf('styles.overlay}') && scr.indexOf('styles.overlay}') < scr.indexOf('<FoundTray'));
check('Files label and accessibility label are unchanged', /label=\{`Files · \$\{found\.length\}`\}/.test(scr) && /accessibilityLabel=\{`Files, \$\{found\.length\} found`\}/.test(scr));
check('the blocked count is not an overlay pill', !/blockedPill/.test(scr));
check('the blocked count shows in the This page menu, on the ads row', /subtitle=\{allowedHere \? [^}]*blocked > 0 \? `\$\{blocked\} blocked on this page`/.test(scr));
check('the downloading chip keeps its accessibility label', /foundTray\.downloadingLabel\(activeLabel\(active\)\)/.test(scr));
const pills = ['overlay', 'activeChip'].map((k) => styleBlock(scr, k)).join('');
check('the pills have a card background and a hairline border', /backgroundColor: c\.surface/.test(styleBlock(scr, 'activeChip')) && /borderWidth: 1/.test(pills));
check('no hex colour in the overlay styles', pills.length > 0 && !HEX.test(pills));
check('no shadows on the pills', !/shadow|elevation/.test(pills));

console.log('floating sheets');
const fl = read('components/browser/FloatingSheet.tsx');
check('FloatingSheet takes the same props as Sheet', ['visible', 'onClose', 'title', 'subtitle', 'children', 'testID'].every((p) => new RegExp(`\\b${p}\\??:`).test(fl.split('export function FloatingSheet')[0])));
check('FloatingSheet is inset 16 px and sits above the bottom inset', /paddingHorizontal: spacing\.lg/.test(fl) && /marginBottom: Math\.max\(insets\.bottom, spacing\.lg\)/.test(fl));
check('FloatingSheet closes from the scrim and from Back', /onPress=\{onClose\}/.test(fl) && /accessibilityLabel="Close"/.test(fl) && /onRequestClose=\{onClose\}/.test(fl));
check('FloatingSheet follows its content height and moves TalkBack focus', !/\n\s+height: /.test(fl) && /setAccessibilityFocus/.test(fl) && /accessibilityViewIsModal/.test(fl));
check('FloatingSheet honours reduce motion', /m\.disabled/.test(fl));
check('FloatingSheet has no hex colour and no shadow', !HEX.test(fl) && !/shadow|elevation/.test(fl));
check('the quiet note row uses a PixelIcon and has no tinted fill', /<PixelIcon name="about"/.test(fl) && !/alpha\(/.test(fl));
check('Sheet itself is untouched in kind: still exports Sheet', /export function Sheet\b/.test(read('components/ui/Sheet.tsx')));

for (const f of ['FoundDownload', 'StreamSheet', 'BatchSheet']) {
  const src = read(`components/browser/${f}.tsx`);
  check(`${f} uses FloatingSheet`, /<FloatingSheet visible/.test(src) && /from '\.\/FloatingSheet'/.test(src));
  check(`${f} no longer uses the bottom Sheet`, !/<Sheet\b/.test(src) && !/\bSheet \}|, Sheet\b/.test(src.replace(/FloatingSheet/g, '')));
  check(`${f} has no tone="info" banner`, !/tone="info"/.test(src));
  check(`${f} keeps its warning/danger banners`, /tone="danger"/.test(src));
  check(`${f} has no hex colour`, !HEX.test(src));
}


console.log('notices');
const host = fs.readFileSync(path.join(root, 'components/ui/NoticeHost.tsx'), 'utf8');
const banner = fs.readFileSync(path.join(root, 'components/ui/Banner.tsx'), 'utf8');
check('notices use the neutral card tone, not the cyan info tint', /tone="neutral"/.test(host) && !/tone="info"/.test(host));
check('the neutral tone is a solid card (surface + border)', /tone === 'neutral' \? \{ backgroundColor: colors\.surface, borderColor: colors\.border \}/.test(banner));
for (const f of ['FoundDownload', 'StreamSheet']) {
  const src = fs.readFileSync(path.join(root, `components/browser/${f}.tsx`), 'utf8');
  const i = src.indexOf('notices.browser.addedToTransfers');
  const before = src.slice(Math.max(0, i - 260), i);
  check(`${f}: "Added to Transfers." is raised after the sheet closes`, i > 0 && /afterSheetCloses\(\(\) => showNotice\(\{ message: notices\.browser\.addedToTransfers/.test(src) && /onClose|onStarted/.test(before));
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall ok');
