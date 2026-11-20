#!/usr/bin/env node
// Transfers screens read only the engine slices they show, so a notice, clipboard or storage change
// does not re-render them. Source-level checks, plain node.

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

const files = [
  'app/(tabs)/index.tsx',
  'app/torrent/[id].tsx',
  'app/download/[id].tsx',
  'components/TransferCard.tsx',
];
for (const f of files) check(`${f} does not call useMaglevEngine()`, !/useMaglevEngine\s*\(/.test(read(f)));

const transfersDir = path.join(root, 'components/transfers');
for (const f of fs.readdirSync(transfersDir)) {
  if (f === 'lowSpace.ts' || !/\.tsx?$/.test(f)) continue;
  check(`components/transfers/${f} does not call useMaglevEngine()`, !/useMaglevEngine\s*\(/.test(read(`components/transfers/${f}`)));
}

const tab = read('app/(tabs)/index.tsx');
check('Transfers renderItem is wrapped in useCallback', /const renderItem\s*=\s*useCallback\(/.test(tab));
check('Transfers renderTorrent is wrapped in useCallback', /const renderTorrent\s*=\s*useCallback\(/.test(tab));
check('torrent detail uses useEngineActions', /useEngineActions\(\)/.test(read('app/torrent/[id].tsx')));

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall transfers-hooks checks passed');
