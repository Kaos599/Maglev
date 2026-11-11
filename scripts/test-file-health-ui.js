#!/usr/bin/env node
// SM-32 file health banner machine, SM-33/SM-37 copy, magnet trackers, SM-35 pending need and one-tap decision.
// One assertion per row of the transition table, on {kind, effects}.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).
process.removeAllListeners('warning');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function main() {
  const m = await import('../components/detail/fileHealthMachine.ts');
  const { buildMagnet } = await import('../components/detail/magnet.ts');
  const adm = await import('../utils/admission.ts');

  const step = (state, event) => {
    const r = m.fileHealthStep(state, event);
    return { kind: r.state.kind, effects: r.effects, state: r.state };
  };
  const row = (name, state, event, kind, effects) => {
    const r = step(state, event);
    check(name, r.kind === kind && JSON.stringify(r.effects) === JSON.stringify(effects), JSON.stringify({ kind: r.kind, effects: r.effects }));
  };

  const idle = m.FILE_HEALTH_INITIAL;
  const missing = { kind: 'missing', indices: [2, 5] };
  const changed = { kind: 'changed', indices: [] };
  const picking = { kind: 'picking', indices: [2, 5], back: 'missing', action: 'folder' };
  const working = { kind: 'working', indices: [2, 5], back: 'missing', action: 'stop' };
  const workingChanged = { kind: 'working', indices: [], back: 'changed', action: 'recheck' };

  // SYNC
  row('idle + files_missing with files shows the banner', idle, { type: 'SYNC', health: 'files_missing', missing: [2, 5] }, 'missing', []);
  row('idle + files_missing with no file list yet stays idle', idle, { type: 'SYNC', health: 'files_missing', missing: [] }, 'idle', []);
  row('idle + files_changed shows the banner', idle, { type: 'SYNC', health: 'files_changed', missing: [] }, 'changed', []);
  row('missing + health cleared returns to idle', missing, { type: 'SYNC', health: null, missing: [] }, 'idle', []);
  row('changed + health cleared returns to idle', changed, { type: 'SYNC', health: null, missing: [] }, 'idle', []);
  row('missing + SYNC with more files updates the count', missing, { type: 'SYNC', health: 'files_missing', missing: [2, 5, 7] }, 'missing', []);
  check('missing + SYNC keeps the indices from the engine', step(missing, { type: 'SYNC', health: 'files_missing', missing: [2, 5, 7] }).state.indices.length === 3);
  row('working ignores SYNC', working, { type: 'SYNC', health: null, missing: [] }, 'working', []);
  row('picking ignores SYNC', picking, { type: 'SYNC', health: null, missing: [] }, 'picking', []);
  row('kept stays kept on files_changed', { kind: 'kept', indices: [] }, { type: 'SYNC', health: 'files_changed', missing: [] }, 'kept', []);
  row('kept + health cleared returns to idle', { kind: 'kept', indices: [] }, { type: 'SYNC', health: null, missing: [] }, 'idle', []);

  // Missing
  row('missing + STOP calls resolve stop with the indices', missing, { type: 'STOP' }, 'working', [
    { type: 'call', action: 'stop', indices: [2, 5], dir: '' },
  ]);
  row('missing + AGAIN calls resolve again with the indices', missing, { type: 'AGAIN' }, 'working', [
    { type: 'call', action: 'again', indices: [2, 5], dir: '' },
  ]);
  row('missing + PICK_FOLDER opens the picker', missing, { type: 'PICK_FOLDER' }, 'picking', [{ type: 'pickFolder' }]);
  row('missing + RECHECK is ignored', missing, { type: 'RECHECK' }, 'missing', []);

  // Picking
  row('picking + FOLDER_PICKED calls resolve folder with the path', picking, { type: 'FOLDER_PICKED', dir: '/storage/x' }, 'working', [
    { type: 'call', action: 'folder', indices: [2, 5], dir: '/storage/x' },
  ]);
  row('picking + FOLDER_CANCELLED returns to missing', picking, { type: 'FOLDER_CANCELLED' }, 'missing', []);
  row('picking + PICK_FAILED returns to missing with a message', picking, { type: 'PICK_FAILED' }, 'missing', [{ type: 'haptic', style: 'warning' }]);
  check('picking + PICK_FAILED stores the copy', step(picking, { type: 'PICK_FAILED' }).state.error === "Couldn't open the folder picker. Try again.");

  // Changed
  row('changed + RECHECK calls resolve recheck', changed, { type: 'RECHECK' }, 'working', [
    { type: 'call', action: 'recheck', indices: [], dir: '' },
  ]);
  row('changed + STOP_SHARING keeps it paused and hides the banner', changed, { type: 'STOP_SHARING' }, 'kept', []);
  row('changed + STOP is ignored', changed, { type: 'STOP' }, 'changed', []);

  // Working
  row('working + RESULT_OK clears to idle', working, { type: 'RESULT_OK' }, 'idle', [{ type: 'haptic', style: 'success' }]);
  row('working + RESULT_ERR returns to missing', working, { type: 'RESULT_ERR', code: 'FILES_MISSING', message: "Those files aren't in that folder." }, 'missing', [
    { type: 'haptic', style: 'warning' },
  ]);
  check(
    'working + RESULT_ERR FILES_MISSING keeps the native copy',
    step(working, { type: 'RESULT_ERR', code: 'FILES_MISSING', message: "Those files aren't in that folder." }).state.error === "Those files aren't in that folder.",
  );
  check('working + RESULT_ERR keeps the indices', step(working, { type: 'RESULT_ERR', code: 'X', message: 'm' }).state.indices.length === 2);
  row('working on changed + RESULT_ERR returns to changed', workingChanged, { type: 'RESULT_ERR', code: 'INVALID_STATE', message: '' }, 'changed', [
    { type: 'haptic', style: 'warning' },
  ]);
  check('INVALID_STATE copy', m.resolveErrorCopy('INVALID_STATE', '') === 'Wait until the move or check finishes.');
  row('working + STOP is ignored', working, { type: 'STOP' }, 'working', []);
  row('a failed missing state can retry', { kind: 'missing', indices: [2], error: 'x' }, { type: 'AGAIN' }, 'working', [
    { type: 'call', action: 'again', indices: [2], dir: '' },
  ]);

  // Banner copy (SM-32, SM-33, SM-37)
  const b2 = m.fileHealthBanner(missing);
  check('missing banner title (n files)', b2 && b2.title === '2 files were deleted outside Maglev.', b2 && b2.title);
  check('missing banner title (1 file)', m.fileHealthBanner({ kind: 'missing', indices: [1] }).title === '1 file was deleted outside Maglev.');
  check(
    'missing banner buttons',
    JSON.stringify(b2.buttons.map((b) => b.label)) === JSON.stringify(['Stop downloading them', 'Download again', 'Pick folder']),
  );
  const bc = m.fileHealthBanner(changed);
  check('changed banner title', bc.title === 'Files were changed after downloading. Recheck before sharing them?');
  check('changed banner buttons', JSON.stringify(bc.buttons.map((b) => b.label)) === JSON.stringify(['Recheck', 'Stop sharing']));
  check('banner stays while working', m.fileHealthBanner(working) !== null && m.fileHealthBanner(workingChanged) !== null);
  check('no banner when idle or kept', m.fileHealthBanner(idle) === null && m.fileHealthBanner({ kind: 'kept', indices: [] }) === null);

  const full = m.healthBannerFor('storage_full');
  check('storage_full copy and actions', full.title === 'Storage full.' && full.buttons.map((b) => b.label).join('|') === 'Free up space|Move');
  const gone = m.healthBannerFor('storage_unavailable');
  check('storage_unavailable copy and actions', gone.title === "The SD card isn't there." && gone.buttons.map((b) => b.label).join('|') === 'Move');
  const np = m.healthBannerFor('no_peers');
  check('no_peers copy and actions', np.title === 'No one is sharing this yet' && np.buttons.map((b) => b.label).join('|') === 'Keep trying|Remove');
  check('no banner for the file tags or null here', m.healthBannerFor('files_missing') === null && m.healthBannerFor(null) === null);

  // State labels
  const labels = {
    files_missing: 'Files missing',
    files_changed: 'Files changed',
    storage_full: 'Storage full',
    storage_unavailable: 'SD card removed',
    no_peers: 'No one sharing',
  };
  for (const [tag, label] of Object.entries(labels)) check(`label for ${tag}`, m.healthLabel(tag) === label, m.healthLabel(tag));
  check('no label for other tags', m.healthLabel('user') === undefined && m.healthLabel(null) === undefined);

  // SM-37
  check('elapsed seconds', m.formatElapsed(45) === '45s');
  check('elapsed minutes', m.formatElapsed(185) === '3m 05s', m.formatElapsed(185));
  check('elapsed hours', m.formatElapsed(3720) === '1h 02m', m.formatElapsed(3720));
  check('resolving line', m.resolvingLine(7, 12) === 'Looking for peers · 7 found · 12s');

  // Magnet (NATIVE_CONTRACT 21)
  const mag = buildMagnet('abc', 'My File', ['udp://t1.example:80/announce', 'http://t2.example/a?x=1&y=2', 'udp://t1.example:80/announce']);
  check('magnet has xt and dn', mag.startsWith('magnet:?xt=urn:btih:abc&dn=My%20File'), mag);
  check('magnet has one tr per distinct tracker, encoded', (mag.match(/&tr=/g) || []).length === 2 && mag.includes(`&tr=${encodeURIComponent('http://t2.example/a?x=1&y=2')}`), mag);
  check('magnet without trackers has no tr', !buildMagnet('abc', 'n').includes('tr='));

  // SM-35
  const GB = 1024 ** 3;
  check(
    'pendingNeed sums unfinished torrents',
    adm.pendingNeedOf([
      { finished: false, includedBytes: 10 * GB, downloadedBytes: 4 * GB },
      { finished: false, includedBytes: 2 * GB, downloadedBytes: 2 * GB },
      { finished: true, includedBytes: 50 * GB, downloadedBytes: 50 * GB },
      { finished: false, includedBytes: 1 * GB, downloadedBytes: 3 * GB },
    ]) === 6 * GB,
  );
  check('pendingNeed counts a torrent with unknown included bytes as 0', adm.pendingNeedOf([{ finished: false, downloadedBytes: 5 }]) === 0);
  check('one-tap Fits adds', adm.oneTapDecision('Fits') === 'add');
  check('one-tap Tight adds with a notice', adm.oneTapDecision('Tight') === 'addWithNotice');
  check('one-tap DoesntFit opens the file sheet', adm.oneTapDecision('DoesntFit') === 'openSheet');

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nfile-health-ui tests passed');
}
main();
