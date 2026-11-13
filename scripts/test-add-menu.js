#!/usr/bin/env node
/** Add menu sheet and add-download rename (static checks). */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
let sheet = '';
try { sheet = read('components', 'add', 'AddMenuSheet.tsx'); } catch { /* red */ }
const dl = read('app', 'add-download.tsx');

check('AddMenuSheet exports AddMenuSheet and AddMenuSheetProps', /export function AddMenuSheet\b/.test(sheet) && /export interface AddMenuSheetProps/.test(sheet));
for (const p of ['visible', 'onClose', 'clipboard\\?', 'onPaste', 'onType', 'onOpenFile', 'onSearch', 'onBrowse']) {
  check(`prop ${p.replace('\\', '')}`, new RegExp(`\\b${p}:`).test(sheet));
}
check('five rows in order', (() => {
  const t = ['Paste link', 'Type a link', 'Open a .torrent file', 'Find on Search', 'Open the browser'].map((s) => sheet.indexOf(s));
  return t.every((i) => i >= 0) && t.every((v, i) => i === 0 || v > t[i - 1]);
})());
check('rows use ListRow', (sheet.match(/<ListRow/g) || []).length === 5 || /ROWS|rows\.map/.test(sheet));
check('browser row uses the network icon', /icon[:=]\s*['"{]*\s*['"]network['"]/.test(sheet));
check('search row uses the search icon', /['"]search['"]/.test(sheet));
check('paste is disabled with "Copy a link first"', /Copy a link first/.test(read('constants', 'copy.ts')) && /addMenu\.copyFirst/.test(sheet) && /disabled=/.test(sheet));
check('no hex colours', !/#[0-9a-fA-F]{6}\b/.test(sheet));
check('add-download has an editable file name', /accessibilityLabel="File name"/.test(dl) && /name:\s*newName|name: renamed|\.\.\.\(renamed/.test(dl));
check('rename rejects slashes and empty', /[\\/].*test\(|\[\\\/\\\\\]/.test(dl) && /nameError|nameInvalid/.test(dl));
process.exit(failed ? 1 : 0);
