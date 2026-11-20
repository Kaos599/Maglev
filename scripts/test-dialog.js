#!/usr/bin/env node
// Source-level contract for components/ui/Dialog.tsx, the centred modal.
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}
console.log('Dialog');
const d = read('components/ui/Dialog.tsx');
check('is a transparent Modal over the status bar', /<Modal[^>]*\btransparent\b/.test(d) && /statusBarTranslucent/.test(d));
check('Back closes it (onRequestClose)', /onRequestClose=\{onClose\}/.test(d));
check('a backdrop tap closes it', /<Pressable[^>]*onPress=\{onClose\}/.test(d));
check('the backdrop uses the theme overlay token', /c\.overlay/.test(d));
check('respects reduce motion through useMotion (no scale)', /useMotion\(\)/.test(d) && /m\.disabled/.test(d) && /reduce \? \[\]/.test(d));
check('fades and scales from 0.94 over motion.duration.focus (180 ms)', /START_SCALE = 0\.94/.test(d) && /duration: motion\.duration\.focus/.test(d));
check('is modal to screen readers; the title is a header that takes focus', /accessibilityViewIsModal/.test(d) && /accessibilityRole="header"/.test(d) && /setAccessibilityFocus/.test(d));
check('takes visible, onClose, title, icon, children, actions, testID', ['visible', 'onClose', 'title', 'icon?', 'children?', 'actions?', 'testID?'].every((p) => d.includes(p)));
check('no hex colours and no system monospace', !/#[0-9a-fA-F]{3,8}\b/.test(d) && !/fontFamily:\s*'monospace'/.test(d));
check('takes a scripted intro on a shared clock, plus exitMs and onExited', /intro\?: DialogIntro/.test(d) && /clock: SharedValue<number>/.test(d) && /exitMs\?: number/.test(d) && /onExited\?: \(\) => void/.test(d));
check('with an intro the card and backdrop follow its clock; closing still fades and scales down over exitMs', /intro\.card\(intro\.clock\.value\)/.test(d) && /intro\.scrim\(intro\.clock\.value\)/.test(d) && /withTiming\(0, \{ duration: exitMs/.test(d));
check('onExited fires after the exit, and straight away with reduce motion', /exited\.current\?\.\(\)/.test(d) && /if \(m\.disabled\) \{\s*progress\.value = 0;\s*unmount\(\);/.test(d));
check('exports its width and gutter so a caller can size to the card', /export const DIALOG_MAX_WIDTH = 360/.test(d) && /export const DIALOG_GUTTER/.test(d));
check('exported from components/ui', /export \{ Dialog \} from '\.\/Dialog'/.test(read('components/ui/index.ts')));
console.log(failed ? `\n${failed} failed` : '\ndialog: all passed');
process.exit(failed ? 1 : 0);
