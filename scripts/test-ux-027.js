#!/usr/bin/env node
// 0.27 UX fixes (source checks):
//  1. Add torrent hands a plain web link to Add a link; that screen runs "Get info" once by itself.
//     An empty Add a link, or any link from another caller, still waits for a tap.
//  2. Sheet avoids the on-screen keyboard itself on Android (edge-to-edge no longer resizes the window).
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

const torrent = read('app/add-torrent.tsx');
const dl = read('app/add-download.tsx');
const sheet = read('components/ui/Sheet.tsx');

// 1. hand-off
check('Add torrent marks its hand-off with from: add-torrent',
  /pathname: '\/add-download', params: \{ url: input, from: 'add-torrent' \}/.test(torrent));
check('Add a link recognises the hand-off marker', /params\.from === 'add-torrent'/.test(dl));
const eff = dl.slice(dl.indexOf('const lastIncoming'), dl.indexOf('// Free space refreshes'));
check('hand-off runs submit() (same code path as the button)', /handoff[\s\S]*void submit\(clean\)/.test(eff));
check('hand-off needs a valid download link', /isDownloadLink\(clean\)/.test(eff));
check('auto-run is guarded to once per link (lastIncoming)', /incoming === lastIncoming\.current\) return/.test(eff));
check('an empty Add a link does not submit (returns when no incoming link)', /if \(!incoming \|\| /.test(eff));
check('plain url/source (search, clipboard chip) still only fills the field',
  /setText\(clean\);\s*\}, \[params\.url/.test(eff));
check('search direct-add stays manual (no from marker)', !/params: \{ source: r\.directUrl, from/.test(read('utils/search/aggregate.ts')));

// 2. Sheet keyboard
check('Sheet keeps KeyboardAvoidingView for iOS only', /behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/.test(sheet));
check('Sheet measures how much the keyboard covers it (shared useKeyboardInset)', /useKeyboardInset\(\)/.test(sheet) && /ref=\{kbRef\}/.test(sheet));
check('Sheet pads by the inset on Android only', /Platform\.OS === 'android' \? inset : 0/.test(sheet) && /paddingBottom: kb/.test(sheet));
check('no keyboard, no jump: the inset is 0 until the keyboard shows', /useState\(0\)/.test(read('components/assistant/useKeyboardInset.ts')));

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nux-027 ok');
