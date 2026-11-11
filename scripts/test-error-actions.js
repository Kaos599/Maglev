#!/usr/bin/env node
// Error banner mapping must match SM-36 rows exactly (docs/STATE_MACHINES_AND_SCREENS.md).
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function main() {
  const { actionsFor } = await import('../components/detail/errorActions.ts');
  const none = {};

  const rows = [
    ['DISK_FULL', none, { message: 'Storage full.', primary: 'freeSpace', secondary: 'move' }],
    ['PERMISSION', none, { message: "Maglev can't write to this folder.", primary: 'pickFolder' }],
    ['FILES_MISSING', none, { message: 'Some files are missing.', primary: 'filesMissing' }],
    ['storage_unavailable', { pausedBy: 'storage_unavailable' }, { message: "The SD card isn't there.", primary: 'none', secondary: 'move' }],
    ['NETWORK', none, { message: "Can't reach anyone right now.", primary: 'retry' }],
    ['TRACKER', none, { message: "Can't reach anyone right now.", primary: 'retry' }],
    ['INTERNAL', none, { message: 'Something went wrong.', primary: 'retry', secondary: 'recheck' }],
    ['SOMETHING_NEW', none, { message: 'Something went wrong.', primary: 'retry', secondary: 'recheck' }],
  ];

  for (const [code, ctx, expected] of rows) {
    const got = actionsFor(code, ctx);
    check(`${code} maps to its SM-36 row`, same(got, expected), JSON.stringify(got));
  }

  check('unknown code uses INTERNAL row', same(actionsFor('???', none), actionsFor('INTERNAL', none)));

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nerror-actions tests passed');
}
main();
