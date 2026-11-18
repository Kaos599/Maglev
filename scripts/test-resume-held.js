#!/usr/bin/env node
// NATIVE_CONTRACT 47: a finished torrent never reads 99%, "Done · {reason}" on the card, Resume is not offered for a
// torrent held by a file health tag (card, swipe, menu, selection, Resume all, Kotlin), and a refused resume explains itself.
// Needs Node 22.18+.
process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

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

const GB = 1024 * 1024 * 1024;
const row = (o = {}) => ({
  id: 'a', name: 'Season', state: 'PAUSED', pausedBy: 'files_changed', health: 'files_changed', finished: true,
  downloadSpeedBytes: 0, uploadSpeedBytes: 0, downloadedBytes: 24 * GB, totalSizeBytes: 24 * GB, includedBytes: 0,
  progressPercent: 99.6, etaSeconds: -1, error: null, ...o,
});

(async () => {
  const model = await import('../components/transfers/model.ts');
  const rules = await import('../components/transfers/resumeRules.ts');
  const { swipePlan } = await import('../components/transfers/swipe.ts');

  console.log('[47.3 card lines]');
  let s = model.torrentStatus(row(), '—');
  check('finished + files_changed: "Done · Files changed", no percent, size on the right', s.lead === 'Done · Files changed' && !s.pct && s.value === '24.0 GB' && s.slot === 'size', JSON.stringify(s));
  s = model.torrentStatus(row({ pausedBy: 'files_missing', health: 'files_missing' }), '—');
  check('finished + files_missing: "Done · Files missing"', s.lead === 'Done · Files missing' && !s.pct, JSON.stringify(s));
  s = model.torrentStatus(row({ pausedBy: 'user', health: null }), '—');
  check('finished + user pause: "Done · Paused"', s.lead === 'Done · Paused' && !s.pct, JSON.stringify(s));
  s = model.torrentStatus(row({ finished: false, pausedBy: 'user', health: null }), '—');
  check('finished by bytes alone (no flag) is still Done', s.lead === 'Done · Paused' && !s.pct, JSON.stringify(s));
  s = model.torrentStatus(row({ finished: false, pausedBy: 'user', health: null, downloadedBytes: 12 * GB }), '—');
  check('unfinished paused keeps the percent', s.lead === 'Paused' && s.pct === '50%', JSON.stringify(s));
  s = model.torrentStatus(row({ finished: false, pausedBy: 'user', health: null, downloadedBytes: 24 * GB - 1 }), '—');
  check('unfinished never reads above 99', s.pct === '99%', JSON.stringify(s));
  check('seed lines are unchanged', model.torrentStatus(row({ pausedBy: 'seed_limit', health: null }), '—').lead.startsWith('Done'));
  check('storage_full is not turned into Done', model.torrentStatus(row({ pausedBy: 'storage_full', health: 'storage_full', finished: false, downloadedBytes: 12 * GB }), '—').pct === '50%');

  console.log('[47.4 no Resume for a held torrent]');
  check('card: files_changed has no button', model.torrentCardAction(row()) === null);
  check('card: files_missing has no button', model.torrentCardAction(row({ pausedBy: 'files_missing', health: 'files_missing' })) === null);
  check('card: user pause over a files_changed tag has no button', model.torrentCardAction(row({ pausedBy: 'user' })) === null);
  check('card: a plain user pause still resumes', model.torrentCardAction(row({ pausedBy: 'user', health: null }))?.kind === 'resume');
  check('swipe: no right swipe for a held torrent', swipePlan({ action: model.torrentCardAction(row({ pausedBy: 'user' })), busy: false, selectionMode: false, enabled: true }).right === null);
  check('isHeldByFiles', model.isHeldByFiles(row()) && model.isHeldByFiles({ pausedBy: 'files_missing' }) && !model.isHeldByFiles({ pausedBy: 'user', health: 'storage_full' }) && !model.isHeldByFiles({}));

  const list = [row({ id: 'h1' }), row({ id: 'h2', pausedBy: 'user' }), row({ id: 'u', pausedBy: 'user', health: null }), row({ id: 'n', pausedBy: null, health: null }), row({ id: 'w', pausedBy: 'wifi_only', health: null }), row({ id: 'd', state: 'DOWNLOADING', pausedBy: null, health: null }), row({ id: 'p', pausedBy: 'user', health: null })];
  check('Resume all and bulk Resume skip held torrents', rules.resumableIds(list, (id) => id === 'p').join() === 'u,n', rules.resumableIds(list).join());

  console.log('[47.4 the refused resume]');
  const refused = { ok: false, code: 'UNSUPPORTED', message: 'Files were changed after downloading. Recheck them first.' };
  let n = rules.resumeFailureNotice(refused, row(), 'Season');
  check('held + UNSUPPORTED: the engine message and an Open action', n.message === refused.message && n.openTorrent && rules.OPEN_TORRENT_LABEL === 'Open', JSON.stringify(n));
  n = rules.resumeFailureNotice({ ...refused, message: 'Some files are missing. Choose what to do with them first.', code: 'FILES_MISSING' }, row({ pausedBy: 'files_missing', health: 'files_missing' }), 'Season');
  check('held by files_missing: the engine message and Open', /missing/.test(n.message) && n.openTorrent);
  n = rules.resumeFailureNotice(refused, row({ pausedBy: 'user', health: null }), 'Season');
  check('UNSUPPORTED without a file hold keeps the generic text', n.message === "Couldn't resume Season. Try again." && !n.openTorrent, JSON.stringify(n));
  n = rules.resumeFailureNotice({ ok: false, code: 'INTERNAL', message: 'boom' }, row(), 'Season');
  check('another failure keeps the generic text', n.message === "Couldn't resume Season. Try again." && !n.openTorrent);
  n = rules.resumeFailureNotice(refused, undefined, 'Season');
  check('an unknown torrent keeps the generic text', !n.openTorrent);

  console.log('[wiring]');
  const ctx = read('context/EngineContext.tsx');
  check('resume toast reads resumeFailureNotice and opens the torrent page', /resumeFailureNotice\(/.test(ctx) && /actionLabel: OPEN_TORRENT_LABEL/.test(ctx) && /pathname: '\/torrent\/\[id\]'/.test(ctx));
  check('resumeAll uses resumableIds', /resumableIds\(liveRef\.current\.torrents/.test(ctx));
  check('selection mode skips held torrents', /isHeldByFiles\(t\)/.test(read('app/(tabs)/index.tsx')) && /skipTorrent/.test(read('app/(tabs)/index.tsx')));
  const more = read('components/detail/TorrentMoreSheet.tsx');
  check('the ⋮ menu hides Resume when held', /heldByFiles && !running \? null/.test(more));
  check('the detail page passes the hold to the menu and hides the header Resume', /heldByFiles=\{heldByFiles\}/.test(read('app/torrent/[id].tsx')) && /MOVING' \|\| heldByFiles \? null/.test(read('app/torrent/[id].tsx')));
  const kt = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/EngineHost.kt');
  const ra = kt.slice(kt.indexOf('fun resumeAll()'), kt.indexOf('fun resumeAll()') + 1200);
  check('Kotlin resumeAll (app and notification) skips file-health holds', /heldByFiles/.test(ra) && /files_changed/.test(ra) && /files_missing/.test(ra) && /!heldByFiles/.test(ra));

  console.log('[47.1 / 47.2 Rust source]');
  const fh = read('native/maglev-core/src/file_health.rs');
  const eng = read('native/maglev-core/src/engine.rs');
  check('classify_file compares size only', /Some\(s\) if finished && s\.size != now\.size => FileState::Changed/.test(fh));
  check('judge_files refreshes the snapshot mtimes', /refresh_mtimes\(&probes, stats\.finished, snap\)/.test(eng));
  check('recheck_async settles before the planner: waits for the check, snapshots, clears', /settle_after_check\(id, hash\)/.test(eng) && /wait_until_initialized/.test(eng) && /settle_recheck\(m, finished\)/.test(eng));
  check('Rust unit tests for 47.1 and 47.2 exist', /fn mtime_only_change_is_not_changed_and_refreshes_the_snapshot/.test(fh) && /fn size_change_is_changed_and_is_not_refreshed/.test(fh) && /fn missing_file_is_missing_not_refreshed/.test(fh) && /fn recheck_with_good_pieces_clears_the_tag_and_asks_for_a_snapshot/.test(fh));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log('all passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
