#!/usr/bin/env node
// SM-27 Remove files machine (NATIVE_CONTRACT 14). One assertion per row of the transition table, on {kind, effects}.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).
process.removeAllListeners('warning');

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function main() {
  const m = await import('../components/detail/removeFilesMachine.ts');
  const idle = m.REMOVE_FILES_INITIAL;
  const confirming = { kind: 'confirming', indices: [1, 2], bytes: 1024 };
  const removing = { kind: 'removing', indices: [1, 2], bytes: 1024 };
  const failedState = { kind: 'failed', indices: [1, 2], bytes: 1024, error: 'x' };
  const done = { kind: 'done', indices: [], bytes: 0, freed: 1 };
  const req = (indices, allIncludedCount = 5) => ({ type: 'REQUEST', indices, bytes: 1024, allIncludedCount });
  // Compare only {kind, effects}, as the spec's tests require.
  const snap = (state, event) => {
    const r = m.removeFilesStep(state, event);
    return JSON.stringify({ kind: r.state.kind, effects: r.effects });
  };
  const expectStep = (name, state, event, kind, effects) =>
    check(name, snap(state, event) === JSON.stringify({ kind, effects }), snap(state, event));

  expectStep('idle + REQUEST with no indices stays idle', idle, req([]), 'idle', []);
  expectStep('idle + REQUEST of all included files is refused', idle, req([1, 2, 3], 3), 'idle', [
    { type: 'notice', text: 'Keep at least one file.', tone: 'danger' },
    { type: 'haptic', style: 'warning' },
  ]);
  expectStep('idle + REQUEST opens the confirm sheet', idle, req([1, 2]), 'confirming', [{ type: 'openSheet' }]);

  // A skipped file that still holds bytes on disk is removable; one with nothing on disk gets a notice.
  const files = [
    { index: 0, progressBytes: 100, priority: 'normal' },
    { index: 1, progressBytes: 100, priority: 'normal' },
    { index: 2, progressBytes: 0, onDiskBytes: 5535040, priority: 'skip' }, // preallocated .ogg
    { index: 3, progressBytes: 0, onDiskBytes: 0, priority: 'skip' },
  ];
  const skippedWithData = m.buildRemoveRequest(files, [2]);
  check('skipped file with bytes on disk is requested', skippedWithData.indices.join() === '2' && skippedWithData.bytes === 5535040);
  expectStep('idle + REQUEST for a preallocated skipped file opens the sheet', idle, skippedWithData, 'confirming', [{ type: 'openSheet' }]);
  const skippedEmpty = m.buildRemoveRequest(files, [3]);
  check('skipped file with nothing on disk is dropped', skippedEmpty.indices.length === 0 && skippedEmpty.requested === 1);
  expectStep('idle + REQUEST with only empty skipped files shows a notice', idle, skippedEmpty, 'idle', [
    { type: 'notice', text: m.NOTHING_TO_REMOVE, tone: 'info' },
  ]);
  const mixed = m.buildRemoveRequest(files, [0, 2, 3]);
  check('mixed pick keeps the included file and the skipped one with data', mixed.indices.join() === '0,2' && mixed.includedCount === 1);
  expectStep('skipped files do not count toward keeping one file', idle, m.buildRemoveRequest(files, [0, 1, 2]), 'idle', [
    { type: 'notice', text: 'Keep at least one file.', tone: 'danger' },
    { type: 'haptic', style: 'warning' },
  ]);
  expectStep('removing a skipped file plus one of two included files is fine', idle, m.buildRemoveRequest(files, [0, 2]), 'confirming', [
    { type: 'openSheet' },
  ]);

  expectStep('confirming + CANCEL closes to idle', confirming, { type: 'CANCEL' }, 'idle', [{ type: 'closeSheet' }]);
  expectStep('confirming + CONFIRM calls removeFiles', confirming, { type: 'CONFIRM' }, 'removing', [
    { type: 'call', fn: 'removeFiles', indices: [1, 2] },
  ]);

  expectStep('removing + CANCEL is ignored', removing, { type: 'CANCEL' }, 'removing', []);
  expectStep('removing + RESULT_OK shows the freed notice', removing, { type: 'RESULT_OK', freedBytes: 1.2 * 1024 ** 3 }, 'done', [
    { type: 'closeSheet' },
    { type: 'clearSelection' },
    { type: 'notice', text: 'Freed 1.2 GB.', tone: 'info' },
    { type: 'haptic', style: 'success' },
  ]);
  expectStep('removing + RESULT_ERR shows the failed state', removing, { type: 'RESULT_ERR', code: 'INVALID_STATE', message: 'busy' }, 'failed', [
    { type: 'haptic', style: 'warning' },
  ]);
  check(
    'removing + RESULT_ERR INVALID_STATE stores the mapped copy',
    m.removeFilesStep(removing, { type: 'RESULT_ERR', code: 'INVALID_STATE', message: 'busy' }).state.error ===
      'Wait until the move or check finishes.',
  );

  expectStep('failed + CONFIRM calls removeFiles again', failedState, { type: 'CONFIRM' }, 'removing', [
    { type: 'call', fn: 'removeFiles', indices: [1, 2] },
  ]);
  expectStep('failed + CANCEL closes to idle', failedState, { type: 'CANCEL' }, 'idle', [{ type: 'closeSheet' }]);

  expectStep('done + NOTICE_SHOWN returns to idle', done, { type: 'NOTICE_SHOWN' }, 'idle', []);

  check('IO_ERROR copy', m.removeErrorCopy('IO_ERROR', 'x') === "Couldn't delete the files. Check the folder still exists.");
  check('NOT_FOUND copy', m.removeErrorCopy('NOT_FOUND', 'x') === 'This torrent is gone.');
  check('other codes show the native message', m.removeErrorCopy('UNSUPPORTED', 'Native text') === 'Native text');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
