#!/usr/bin/env node
// The "N of M sources" button under the result count must stay one line tall.
// PressableScale's inner view has flexGrow: 1. Inside the summaryText column (flex: 1 in a row, so its
// height is only bounded by the screen), Yoga let that inner view grow to the whole remaining height,
// the sources button filled the screen and the result list (flex: 1 below it) got 0 px: a blank Search
// tab after a search where a source failed (0.32). A row wrapper gives the button a content height.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app/(tabs)/search.tsx'), 'utf8');

let failed = 0;
const check = (name, cond) => { console[cond ? 'log' : 'error'](`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; };

const btn = src.indexOf('pressableRef={noteBtnRef}');
check('the sources button exists', btn > 0);
const open = src.lastIndexOf('<', src.lastIndexOf('<PressableScale', btn) - 1);
const wrapper = src.slice(open, src.lastIndexOf('<PressableScale', btn));
check('the sources button sits in a row wrapper so it cannot grow to the screen height', /<View style=\{styles\.noteRow\}>\s*$/.test(wrapper));
const style = /noteRow:\s*\{([^}]*)\}/.exec(src);
check('noteRow is a row', !!style && /flexDirection:\s*'row'/.test(style[1]));
check('noteRow does not grow or stretch', !!style && !/flex(Grow)?:\s*[1-9]/.test(style[1]) && !/height/i.test(style[1]));

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nsearch header height: all passed');
