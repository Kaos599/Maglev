#!/usr/bin/env node
// 0.19: Play while downloading and low-storage protection (docs/contracts-0.19/play-and-storage.md).
// Needs Node 22.18+ (runs the TypeScript source directly).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function main() {
  const { pickPlayFile, playVisible, cardCanPlay, playPlan } = await import('../components/detail/play.ts');
  const { reserveBytes, nextBlocked, buildFinishedRows, selectedBytes } = await import('../components/transfers/freeSpace.ts');
  const copy = await import('../constants/copy.ts');

  const f = (index, p, length, included = true) => ({ index, path: p, length, included });

  // Which file Play picks.
  check('largest video wins', pickPlayFile([f(0, 'a/small.mp4', 10), f(1, 'a/big.mkv', 500), f(2, 'a/x.iso', 9000)])?.index === 1);
  check('a video beats a larger audio file', pickPlayFile([f(0, 'a.flac', 900), f(1, 'b.mp4', 5)])?.index === 1);
  check('audio is picked when there is no video', pickPlayFile([f(0, 'a.mp3', 5), f(1, 'b.flac', 50), f(2, 'c.txt', 999)])?.index === 1);
  check('skipped files are ignored', pickPlayFile([f(0, 'big.mkv', 900, false), f(1, 'small.mp4', 10)])?.index === 1);
  check('nothing playable gives null', pickPlayFile([f(0, 'a.zip', 5), f(1, 'b.pdf', 6)]) === null);
  check('empty gives null', pickPlayFile([]) === null);
  check('ties go to the lower index', pickPlayFile([f(3, 'a.mp4', 10), f(1, 'b.mp4', 10)])?.index === 1);
  check('zero length is ignored', pickPlayFile([f(0, 'a.mp4', 0)]) === null);

  // When Play shows.
  const file = f(0, 'a.mkv', 10);
  for (const state of ['DOWNLOADING', 'PAUSED', 'COMPLETED', 'SEEDING'])
    check(`Play shows while ${state}`, playVisible({ state, pausedBy: state === 'PAUSED' ? 'user' : null, health: null }, file));
  for (const state of ['ERROR', 'MOVING', 'INITIALIZING', 'CHECKING', 'QUEUED'])
    check(`Play hidden while ${state}`, !playVisible({ state, pausedBy: null, health: null }, file));
  check('Play hidden with no playable file', !playVisible({ state: 'DOWNLOADING', pausedBy: null, health: null }, null));
  check('Play hidden when files are missing', !playVisible({ state: 'PAUSED', pausedBy: 'files_missing', health: 'files_missing' }, file));
  check('Play shows when paused for storage', playVisible({ state: 'PAUSED', pausedBy: 'storage_full', health: null }, file));
  check('card shows Play for a single video torrent', cardCanPlay({ name: 'Movie.2024.mkv', state: 'DOWNLOADING', pausedBy: null, health: null }));
  check('card shows Play for audio', cardCanPlay({ name: 'album.flac', state: 'COMPLETED', pausedBy: null, health: null }));
  check('card hides Play for a folder name', !cardCanPlay({ name: 'Season 1', state: 'DOWNLOADING', pausedBy: null, health: null }));
  check('card hides Play for a zip', !cardCanPlay({ name: 'files.zip', state: 'DOWNLOADING', pausedBy: null, health: null }));

  // What pressing Play does.
  const half = { index: 0, path: 'a.mkv', length: 100, progressBytes: 40 };
  const whole = { index: 0, path: 'a.mkv', length: 100, progressBytes: 100 };
  check('a finished file opens', playPlan(whole, { state: 'DOWNLOADING', pausedBy: null }).kind === 'open');
  check('a finished file opens even when paused by a rule', playPlan(whole, { state: 'PAUSED', pausedBy: 'storage_full' }).kind === 'open');
  const live = playPlan(half, { state: 'DOWNLOADING', pausedBy: null });
  check('a half file streams without resuming', live.kind === 'stream' && live.resumeFirst === false);
  const user = playPlan(half, { state: 'PAUSED', pausedBy: 'user' });
  check('a user-paused torrent resumes first', user.kind === 'stream' && user.resumeFirst === true);
  check('a rule-paused torrent is not resumed by Play', playPlan(half, { state: 'PAUSED', pausedBy: 'wifi_only' }).kind === 'blocked');

  const sp = playPlan(half, { state: 'PAUSED', pausedBy: 'storage_full' });
  check('a storage-paused torrent is blocked with a storage reason', sp.kind === 'blocked' && sp.reason === 'storageFull', JSON.stringify(sp));
  check('storage-blocked Play message points to freeing space', /free up space/i.test(copy.playCopy.storageFull ?? '') && !/resume/i.test(copy.playCopy.storageFull ?? ''));
  const pa = fs.readFileSync(path.join(root, 'components/detail/playActions.ts'), 'utf8');
  check('playActions uses the storage message for a storage block', /storageFull/.test(pa));

  // Card status for "Storage full": same for a torrent and a link download.
  const model = await import('../components/transfers/model.ts');
  const dcopy = await import('../utils/downloadCopy.ts');
  const tor = { id: 'aa', name: 'x', state: 'PAUSED', pausedBy: 'storage_full', totalSizeBytes: 100, includedBytes: 100, downloadedBytes: 40, progressPercent: 40, etaSeconds: -1 };
  const ts = model.torrentStatus(tor, '—');
  const dl = { id: 'dl:1', name: 'f.pdf', urlDisplay: 'https://a.example/f.pdf', state: 'paused', pausedBy: 'storage_full', size: 13000, downloaded: 5000, downBps: 0, eta: -1, error: null };
  const ds = dcopy.downloadStatus(dl);
  check('torrent Storage full: muted, sub-line Free up space', ts.lead === 'Storage full' && ts.tone === 'muted' && ts.sub === 'Free up space', JSON.stringify(ts));
  check('download Storage full: muted, sub-line Free up space', ds.text === 'Storage full' && ds.tone === 'muted' && ds.sub === 'Free up space', JSON.stringify(ds));
  const da = dcopy.downloadActions(dl)[0];
  const ta = model.torrentCardAction(tor);
  check('download Storage full action is Free up space, like the torrent', da && da.kind === 'freeSpace' && da.label === 'Free up space' && ta.kind === 'freeSpace' && da.icon === ta.icon, JSON.stringify(da));
  check('freeSpace routes to /free-space', dcopy.actionRoute('freeSpace') === '/free-space');

  // Screen-reader progress for a link download uses the known size.
  const fmt = (await import('../constants/format.ts')).formatBytes;
  const fin = { ...dl, state: 'finished', pausedBy: null, downloaded: 13000 };
  check('finished download label names its size, not "size unknown"', dcopy.downloadProgressLabel(fin).includes(fmt(13000)) && !/unknown/i.test(dcopy.downloadProgressLabel(fin)), dcopy.downloadProgressLabel(fin));
  const finNoSize = { ...fin, size: null };
  check('finished download with only downloaded bytes uses them', !/unknown/i.test(dcopy.downloadProgressLabel(finNoSize)) && dcopy.downloadProgressLabel(finNoSize).includes(fmt(13000)), dcopy.downloadProgressLabel(finNoSize));

  // Reserve math and the shared vectors.
  const vectors = JSON.parse(fs.readFileSync(path.join(root, 'scripts/fixtures/storage-reserve-vectors.json'), 'utf8'));
  let vectorsOk = vectors.length >= 10;
  for (const v of vectors) {
    if (reserveBytes(v.total) !== v.reserve || nextBlocked(v.blocked, v.free, v.total) !== v.expectBlocked) {
      vectorsOk = false;
      console.error(`    vector failed: ${v.name}`);
    }
  }
  check('TypeScript reserve math matches the shared vectors', vectorsOk);

  // Free space list ordering.
  const torrents = [
    { id: 't1', name: 'Small', state: 'COMPLETED', finished: true, includedBytes: 100, totalSizeBytes: 100, downloadedBytes: 100, progressPercent: 100 },
    { id: 't2', name: 'Huge', state: 'SEEDING', finished: true, includedBytes: 9000, totalSizeBytes: 9000, downloadedBytes: 9000, progressPercent: 100 },
    { id: 't3', name: 'Busy', state: 'DOWNLOADING', finished: false, includedBytes: 99999, totalSizeBytes: 99999, downloadedBytes: 5, progressPercent: 0 },
    { id: 't4', name: 'Unknown', state: 'COMPLETED', finished: true, includedBytes: 0, totalSizeBytes: 0, downloadedBytes: 0, progressPercent: 100 },
  ];
  const downloads = [
    { id: 'dl_a', name: 'Link big', state: 'finished', size: 5000, downloaded: 5000, pausedBy: null },
    { id: 'dl_b', name: 'Link running', state: 'downloading', size: 70000, downloaded: 1, pausedBy: null },
    { id: 'dl_c', name: 'Link none', state: 'finished', size: null, downloaded: 0, pausedBy: null },
  ];
  const rows = buildFinishedRows(torrents, downloads);
  check('only finished items are listed', rows.every((r) => r.id !== 't3' && r.id !== 'dl_b') && rows.length === 5, rows.map((r) => r.id).join());
  check('largest first, then unknown sizes last', rows.map((r) => r.id).join() === 't2,dl_a,t1,dl_c,t4' || rows.map((r) => r.id).join() === 't2,dl_a,t1,t4,dl_c', rows.map((r) => r.id).join());
  check('unknown size is null, never 0', rows.filter((r) => r.id === 't4' || r.id === 'dl_c').every((r) => r.size === null));
  check('rows carry the kind', rows.find((r) => r.id === 'dl_a')?.kind === 'download' && rows.find((r) => r.id === 't2')?.kind === 'torrent');
  check('selected bytes add known sizes only', selectedBytes(rows, new Set(['t2', 'dl_c', 'dl_a'])) === 14000);

  // Copy strings.
  check('paused title matches the notification', copy.storageCopy.pausedTitle === 'Paused: phone storage is almost full');
  check('free up space action', copy.storageCopy.freeUp === 'Free up space' && copy.storageCopy.removeAction === 'Remove and delete files');
  check('play label', copy.playCopy.label === 'Play');
  const kt = fs.readFileSync(path.join(root, 'modules/maglev-engine/android/src/main/java/com/maglev/engine/service/StorageGuard.kt'), 'utf8');
  check('Kotlin notification copy equals the app copy', kt.includes(`"${copy.storageCopy.pausedTitle}"`) && kt.includes(`"${copy.storageCopy.freeUp}"`));
  const noBang = Object.values({ ...copy.storageCopy, ...copy.playCopy }).filter((v) => typeof v === 'string').every((s) => !/!|please|successfully/i.test(s));
  check('copy has no banned words', noBang);

  // The route exists and uses the shared pieces.
  const screen = path.join(root, 'app/free-space.tsx');
  check('route app/free-space.tsx exists', fs.existsSync(screen));
  const src = fs.existsSync(screen) ? fs.readFileSync(screen, 'utf8') : '';
  check('screen reuses DeleteSheet and real free space', /DeleteSheet/.test(src) && /getFreeSpace/.test(src) && /buildFinishedRows/.test(src));
  check('screen has no hex colours', !/#[0-9a-fA-F]{6}\b/.test(src));

  // Rust and Kotlin pieces exist.
  const rs = fs.readFileSync(path.join(root, 'native/maglev-core/src/storage_guard.rs'), 'utf8');
  check('Rust reserve constants', /500 \* 1024 \* 1024/.test(rs) && /200 \* 1024 \* 1024/.test(rs) && /RESERVE_DIVISOR: u64 = 50/.test(rs));
  check('lib.rs declares storage_guard', /pub mod storage_guard;/.test(fs.readFileSync(path.join(root, 'native/maglev-core/src/lib.rs'), 'utf8')));

  // Wiring.
  const card = fs.readFileSync(path.join(root, 'components/TransferCard.tsx'), 'utf8');
  check('transfer card has a Play button', /cardCanPlay/.test(card) && /onPlay/.test(card));
  const detail = fs.readFileSync(path.join(root, 'app/torrent/[id].tsx'), 'utf8');
  check('detail screen has Play', /pickPlayFile/.test(detail) && /playCopy/.test(detail));

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll play and storage checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
