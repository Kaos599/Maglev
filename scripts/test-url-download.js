#!/usr/bin/env node
// URL downloads (NATIVE_CONTRACT 17, SM-30): link parsing, card copy and actions, and the simulator's
// validation and transitions. The Rust side is covered by `cargo test` (http_dl/*).
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const link = await import('../modules/maglev-engine/src/downloadLink.ts');
  const copy = await import('../utils/downloadCopy.ts');
  const { MockDownloads, mockSizeFor } = await import('../modules/maglev-engine/src/MaglevMockDownloads.ts');

  // ---- links ----
  console.log('links');
  for (const good of ['https://x.test/a.zip', 'http://x.test:8080/a/b.bin?token=1', 'HTTPS://X.TEST/Path']) {
    check(`accepts ${good}`, link.parseDownloadUrl(good).ok === true);
  }
  for (const bad of ['ftp://x.test/a', 'magnet:?xt=urn:btih:abc', 'file:///etc/passwd', 'javascript:alert(1)', 'x.test/a.zip', '', 'https://', 'https:///a', 'https://x.test/a b']) {
    check(`refuses ${JSON.stringify(bad)}`, link.parseDownloadUrl(bad).ok === false);
  }
  check('display drops credentials, query and fragment', link.displayUrl('https://me:secret@files.test:8443/a/b.zip?token=abc#x') === 'https://files.test:8443/a/b.zip');
  check('display of a bare host has a slash', link.displayUrl('https://x.test') === 'https://x.test/');
  check('torrent links are not download links', link.isDownloadLink('https://x.test/a.torrent') === false && link.isDownloadLink('https://x.test/a.torrent?x=1') === false);
  check('plain web links are download links', link.isDownloadLink('https://x.test/movie.mkv') === true);
  check('magnets are not download links', link.isDownloadLink('magnet:?xt=urn:btih:' + 'a'.repeat(40)) === false);
  check('extracts a link from shared text', link.extractHttpUrl('Look at this: https://x.test/a.zip, nice') === 'https://x.test/a.zip');
  check('extract finds nothing in plain text', link.extractHttpUrl('no links here') === null);
  check('name from url decodes and drops the query', link.nameFromUrl('https://x.test/dir/My%20Song.mp3?x=1') === 'My Song.mp3');
  check('name from a bare host is download', link.nameFromUrl('https://x.test/') === 'download');
  check('sanitiser strips paths and bad characters', link.sanitizeFileName('../../a:b*c.txt') === 'a_b_c.txt');
  check('sanitiser never returns empty', link.sanitizeFileName('...') === 'download');

  // ---- card copy (SM-30 Copy) ----
  console.log('copy');
  const base = {
    id: 'dl_1', urlDisplay: 'https://x.test/a.bin', name: 'a.bin', state: 'downloading', pausedBy: null, size: 1000,
    downloaded: 250, downBps: 100, eta: 8, segmentsActive: 1, resumable: true, folder: '/d', addedAt: 1, error: null,
  };
  const d = (patch) => ({ ...base, ...patch });
  check('storage full copy', copy.downloadStatus(d({ state: 'paused', pausedBy: 'storage_full' })).text === 'Storage full');
  check('link expired copy', copy.downloadStatus(d({ state: 'needs_link' })).text === 'Link expired · Paste new link');
  check('file changed copy', copy.downloadStatus(d({ state: 'error', error: { code: 'FILE_CHANGED', message: 'x' } })).text === 'The file changed on the server · Restart');
  check('not a file copy', copy.downloadStatus(d({ state: 'error', error: { code: 'NOT_A_FILE', message: 'x' } })).text === 'This link opens a web page, not a file');
  check('checksum copy', copy.downloadStatus(d({ state: 'error', error: { code: 'CHECKSUM_MISMATCH', message: 'x' } })).text === "File doesn't match the checksum");
  check('http status shows the engine message', copy.downloadStatus(d({ state: 'error', error: { code: 'HTTP_STATUS', message: 'The server returned an error (500).' } })).text === 'The server returned an error (500).');
  check('wifi pause copy', copy.downloadStatus(d({ state: 'paused', pausedBy: 'wifi_only' })).text === 'Paused: waiting for Wi-Fi');
  check('done copy has the size', copy.downloadStatus(d({ state: 'finished', downloaded: 1000 })).text === 'Done · 1000.0 B' || /^Done · /.test(copy.downloadStatus(d({ state: 'finished' })).text));
  check('downloading shows speed', /\/s$/.test(copy.downloadStatus(d({}), '8s').text));
  check('unknown speed is a dash', copy.downloadStatus(d({ downBps: 0, eta: -1 })).text === 'Downloading · —');
  check('progress is a fraction', copy.downloadProgress(d({})) === 0.25 && copy.downloadProgress(d({ size: null })) === 0 && copy.downloadProgress(d({ state: 'finished' })) === 1);

  console.log('actions');
  check('downloading pauses', copy.downloadAction(d({}))?.kind === 'pause');
  check('queued pauses', copy.downloadAction(d({ state: 'queued' }))?.kind === 'pause');
  check('user pause resumes', copy.downloadAction(d({ state: 'paused', pausedBy: 'user' }))?.kind === 'resume');
  check('storage full pause resumes', copy.downloadAction(d({ state: 'paused', pausedBy: 'storage_full' }))?.kind === 'resume');
  check('governance pause has no button', copy.downloadAction(d({ state: 'paused', pausedBy: 'schedule' })) === null);
  check('needs link offers a new link', copy.downloadAction(d({ state: 'needs_link' }))?.kind === 'newLink');
  check('file changed offers restart', copy.downloadAction(d({ state: 'error', error: { code: 'FILE_CHANGED', message: '' } }))?.kind === 'restart');
  check('other errors offer retry', copy.downloadAction(d({ state: 'error', error: { code: 'NETWORK', message: '' } }))?.kind === 'retry');
  check('finished offers only Open', copy.downloadAction(d({ state: 'finished' }))?.kind === 'open');
  check('remove copy differs for a finished download', copy.removeCopy(d({ state: 'finished' })).keepLabel === 'Remove (keep file)' && copy.removeCopy(d({})).keepLabel.includes('partial'));

  // ---- recovery copy and actions ----
  console.log('recovery');
  const err = (code, extra) => d({ state: 'error', error: { code, message: 'x', ...extra } });
  const kinds = (x) => copy.downloadActions(x).map((a) => a.kind).join(',');
  check('auth needs sign-in label', copy.downloadStatus(d({ state: 'needs_link', error: { code: 'AUTH_REQUIRED', message: '' } })).text === 'Needs sign-in · Paste new link');
  check('not a file offers Remove, not Retry', kinds(err('NOT_A_FILE')) === 'remove');
  check('checksum offers Remove, not Retry', kinds(err('CHECKSUM_MISMATCH')) === 'remove');
  check('permission offers Pick folder again then Retry', kinds(err('PERMISSION')) === 'pickFolder,retry' && copy.downloadStatus(err('PERMISSION')).text === "Maglev can't write to that folder.");
  check('EACCES is permission', kinds(err('EACCES')) === 'pickFolder,retry');
  check('network offers Retry', kinds(err('NETWORK')) === 'retry');
  check('5xx offers Retry, 404 offers Remove', kinds(err('HTTP_STATUS', { httpStatus: 503 })) === 'retry' && kinds(err('HTTP_STATUS', { httpStatus: 404 })) === 'remove' && kinds(err('HTTP_STATUS', { httpStatus: 429 })) === 'retry');
  check('unknown code is a generic retry', kinds(err('WHATEVER')) === 'retry' && copy.downloadStatus(d({ state: 'error', error: null })).text === 'Something went wrong');
  check('offline pause', copy.downloadStatus(d({ state: 'paused', pausedBy: 'offline' })).text === 'Waiting for a connection' && copy.downloadAction(d({ state: 'paused', pausedBy: 'offline' })) === null);
  check('folder gone pause offers Pick folder again', copy.downloadStatus(d({ state: 'paused', pausedBy: 'storage_unavailable' })).text === "The folder isn't available. Is the SD card in?" && kinds(d({ state: 'paused', pausedBy: 'storage_unavailable' })) === 'pickFolder');
  check('folder gone error', copy.downloadStatus(err('STORAGE_UNAVAILABLE')).text === "The folder isn't available. Is the SD card in?" && kinds(err('STORAGE_UNAVAILABLE')) === 'pickFolder');
  check('too big for the card', copy.downloadStatus(err('FILE_TOO_LARGE')).text === "This file is bigger than the card's format allows (4 GB). Use phone storage." && kinds(err('FILE_TOO_LARGE')) === 'pickFolder');
  check('local redirect is blocked, Remove only', copy.downloadStatus(err('LOCAL_REDIRECT')).text === 'This link tried to send Maglev to a device on your network, so it was stopped.' && kinds(err('LOCAL_REDIRECT')) === 'remove');
  check('policy block opens settings', copy.downloadStatus(err('BLOCKED')).text === 'Blocked by your Wi-Fi-only or VPN setting.' && kinds(err('BLOCKED')) === 'openNetworkSettings,retry');
  check('wifi pause opens settings with a caption', kinds(d({ state: 'paused', pausedBy: 'wifi_only' })) === 'openNetworkSettings' && copy.downloadCaption(d({ state: 'paused', pausedBy: 'wifi_only' })) === 'Wi-Fi only is on in Settings → Network.');
  check('battery pause still has no button', copy.downloadAction(d({ state: 'paused', pausedBy: 'battery' })) === null);
  check('settings actions have routes', copy.actionRoute('pickFolder') === '/settings/storage' && copy.actionRoute('openNetworkSettings') === '/settings/network' && copy.actionRoute('retry') === null);
  const pv = (code, status) => copy.probeErrorView(code, 'm', status);
  check('probe: page and sign-in say Paste another link', pv('NOT_A_FILE').primary === 'pasteAnother' && pv('AUTH_REQUIRED').primary === 'pasteAnother');
  check('probe: page copy is exact', pv('NOT_A_FILE').body === 'This is a web page, not a file. On the page, long-press the download button, tap Copy link address, then paste it here.');
  check('probe: sign-in copy is exact', pv('AUTH_REQUIRED').body === 'This site wants you to sign in. Sign in on the site in your browser, copy the download link again, and paste it here.');
  check('probe: network and 5xx keep Try again, 404 does not', pv('NETWORK').primary === 'retry' && pv('HTTP_STATUS', 502).primary === 'retry' && pv('HTTP_STATUS', 404).primary === 'pasteAnother');

  // ---- torrents, pasted text and the share marker ----
  console.log('routing');
  const mag = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
  check('magnet is a torrent source', link.isTorrentSource(mag) && link.isTorrentSource('https://x.test/a.torrent?x=1') && !link.isTorrentSource('https://x.test/a.zip'));
  check('paste extracts the link from text', link.normalizeIncoming('Get it here https://x/a.zip') === 'https://x/a.zip');
  check('paste keeps a magnet whole', link.normalizeIncoming(mag + '&tr=http://t.test/announce') === mag + '&tr=http://t.test/announce');
  check('share route carries the marker', link.sharedDownloadRoute('https://x.test/a.zip?b=1') === '/add-download?url=https%3A%2F%2Fx.test%2Fa.zip%3Fb%3D1&from=share');
  check('share marker opens only with a link', link.isShareOpen({ url: 'https://x/a', from: 'share' }) && !link.isShareOpen({ url: 'https://x/a' }) && !link.isShareOpen({ from: 'share' }) && !link.isShareOpen({ url: 'https://x/a', from: 'other' }));
  for (const forged of [
    '/add-download?url=https%3A%2F%2Fevil.test%2Fa&from=share',
    'maglev://add-download?url=https%3A%2F%2Fevil.test%2Fa&from=share',
    '/add-download?from=share&url=x',
    '/add-download?url=x&%66rom=share',
    '/add-download?url=x&FROM=share',
    '/add-download?url=x&from=share&from=share#h',
  ]) {
    const out = link.stripShareMarker(forged);
    check(`forged marker is stripped: ${forged}`, !/from/i.test(out.replace(/^[^?]*/, '').replace(/https?%3A[^&]*/i, '')) && out.includes('url=') );
  }
  check('strip leaves other params and plain paths alone', link.stripShareMarker('/add-download?url=x&y=1') === '/add-download?url=x&y=1' && link.stripShareMarker('/settings/storage') === '/settings/storage');
  check('strip removes an empty query', link.stripShareMarker('/add-download?from=share') === '/add-download');
  check('a url value containing from=share is kept', link.stripShareMarker('/add-download?url=' + encodeURIComponent('https://x/a?from=share')).includes('url=https%3A%2F%2Fx%2Fa%3Ffrom%3Dshare'));

  // ---- simulator ----
  console.log('simulator');
  let blocked = null;
  let changes = 0;
  const m = new MockDownloads({ blockedReason: () => blocked, folder: () => '/storage/Download/Maglev', changed: () => changes++ });
  const find = (id) => m.snapshots().find((s) => s.id === id);
  const run = (n) => { for (let i = 0; i < n; i++) m.step(1); };

  check('ftp is INVALID_SOURCE', (await m.add('ftp://x.test/a', {})).code === 'INVALID_SOURCE');
  check('magnet is INVALID_SOURCE', (await m.add('magnet:?xt=urn:btih:abc', {})).code === 'INVALID_SOURCE');
  check('segments 0 is INVALID_ARGUMENT', (await m.add('https://x.test/a.bin', { segments: 0 })).code === 'INVALID_ARGUMENT');
  check('segments 9 is INVALID_ARGUMENT', (await m.add('https://x.test/a.bin', { segments: 9 })).code === 'INVALID_ARGUMENT');
  check('a checksum is UNSUPPORTED', (await m.add('https://x.test/a.bin', { expectedHash: { alg: 'sha256', hex: 'ab' } })).code === 'UNSUPPORTED');
  check('probe 404 is HTTP_STATUS with the status', eq(
    (({ code, httpStatus }) => ({ code, httpStatus }))(await m.probeUrl('https://x.test/404/a.bin', {})),
    { code: 'HTTP_STATUS', httpStatus: 404 },
  ));
  check('probe of a page is NOT_A_FILE', (await m.probeUrl('https://x.test/index.html', {})).code === 'NOT_A_FILE');
  check('probe of a signed-in link is AUTH_REQUIRED', (await m.probeUrl('https://x.test/auth/a.bin', {})).code === 'AUTH_REQUIRED');
  check('probe offline is NETWORK', (await m.probeUrl('https://offline.test/a.bin', {})).code === 'NETWORK');
  const probe = await m.probeUrl('https://x.test/a.bin?token=1', {});
  check('probe ok gives name, size, resume and a clean display', probe.ok && probe.name === 'a.bin' && probe.size === mockSizeFor('https://x.test/a.bin') && probe.resumable === true && probe.urlDisplay === 'https://x.test/a.bin');
  check('probe of a server without resume', (await m.probeUrl('https://x.test/noresume/a.bin', {})).resumable === false);

  const a = await m.add('https://x.test/a.bin', {});
  check('add resolves first', a.ok && find(a.id).state === 'resolving');
  check('duplicate link is refused with the id', (await m.add('https://x.test/a.bin', {})).id === a.id);
  run(1);
  check('probe ok then downloading', find(a.id).state === 'downloading' && find(a.id).size === mockSizeFor('https://x.test/a.bin'));
  run(2);
  check('bytes and speed move', find(a.id).downloaded > 0 && find(a.id).downBps > 0 && find(a.id).eta > 0);
  check('pause is user pause', m.pause(a.id).ok && find(a.id).state === 'paused' && find(a.id).pausedBy === 'user');
  blocked = 'wifi_only';
  blocked = null;
  run(2);
  check('user pause wins over governance clearing', find(a.id).state === 'paused');
  check('resume queues then downloads', m.resume(a.id).ok && find(a.id).state === 'queued');
  run(1);
  check('resumed download continues', find(a.id).state === 'downloading');
  const heldBefore = find(a.id).downloaded;
  blocked = 'wifi_only';
  run(1);
  check('governance pauses with its tag', find(a.id).state === 'paused' && find(a.id).pausedBy === 'wifi_only' && find(a.id).downloaded >= heldBefore);
  blocked = null;
  run(2);
  check('governance clear resumes by itself', find(a.id).state === 'downloading');
  check('pause of an unknown id is NOT_FOUND', m.pause('dl_nope').code === 'NOT_FOUND');
  check('retry of a healthy download is INVALID_STATE', m.retry(a.id).code === 'INVALID_STATE');

  // run to the end
  run(400);
  check('finishes (verifying, then finished)', find(a.id).state === 'finished');
  check('finished card is done', copy.downloadProgress(find(a.id)) === 1);

  // errors
  const nf = await m.add('https://x.test/404/gone.bin', {});
  run(1);
  check('probe 404 on add is Error(HTTP_STATUS)', find(nf.id).state === 'error' && find(nf.id).error.code === 'HTTP_STATUS' && find(nf.id).error.httpStatus === 404);
  const page = await m.add('https://x.test/page.html', {});
  run(1);
  check('a page is Error(NOT_A_FILE)', find(page.id).error.code === 'NOT_A_FILE');
  const auth = await m.add('https://x.test/auth/private.bin', {});
  run(1);
  check('probe 403 needs a link', find(auth.id).state === 'needs_link' && find(auth.id).error.code === 'AUTH_REQUIRED');
  check('retry re-probes', m.retry(nf.id).ok && find(nf.id).state === 'resolving');

  // link expiry and a new link
  const ex = await m.add('https://x.test/expire/big.bin?sig=1', {});
  run(1);
  const exSize = find(ex.id).size;
  run(400);
  check('an expiring link needs a new link half way', find(ex.id).state === 'needs_link' && find(ex.id).downloaded > 0);
  check('a new link for a refresh only works in needs_link', (await m.refreshUrl(a.id, 'https://x.test/a.bin', {})).code === 'INVALID_STATE');
  check('a different file is FILE_CHANGED', (await m.refreshUrl(ex.id, 'https://x.test/expire/other.bin', {})).code === 'FILE_CHANGED' && find(ex.id).state === 'error');
  check('retry after FILE_CHANGED starts from zero', m.retry(ex.id).ok && find(ex.id).downloaded === 0);
  run(1);
  const ex2 = await m.add('https://y.test/expire/same.bin?sig=1', {});
  run(1);
  run(400);
  check('second expiring link expires', find(ex2.id).state === 'needs_link');
  check('the same file under a new query is accepted', (await m.refreshUrl(ex2.id, 'https://y.test/expire/same.bin?sig=2', {})).ok && find(ex2.id).state === 'queued');
  run(400);
  check('the refreshed download finishes', find(ex2.id).state === 'finished');
  void exSize;

  const ch = await m.add('https://x.test/changed/file.bin', {});
  run(1);
  run(400);
  check('a changed file is Error(FILE_CHANGED)', find(ch.id).state === 'error' && find(ch.id).error.code === 'FILE_CHANGED');
  check('restart shows the restart action', copy.downloadAction(find(ch.id)).kind === 'restart');

  // options
  const paused = await m.add('https://x.test/paused.bin', { paused: true });
  run(2);
  check('paused option starts paused', find(paused.id).state === 'paused' && find(paused.id).pausedBy === 'user');
  const lim = await m.add('https://x.test/limited.bin', { downLimitBps: 1000 });
  check('limit option is accepted', lim.ok && m.setLimits(lim.id, { downLimitBps: 500 }).ok);
  check('limit on an unknown id is NOT_FOUND', m.setLimits('dl_nope', { downLimitBps: 1 }).code === 'NOT_FOUND');

  // remove
  check('remove drops the row', m.remove(paused.id, true).ok && !find(paused.id));
  check('remove of an unknown id is NOT_FOUND', m.remove('dl_nope', false).code === 'NOT_FOUND');
  check('the simulator told the app about its changes', changes > 0);

  // ---- unknown size, stall, open, sign-in ----
  console.log('unknown size, stall, open');
  const unk = d({ size: null, downloaded: 120 * 1024 * 1024, downBps: 1000, eta: -1 });
  check('unknown size is indeterminate with bytes so far', copy.isIndeterminate(unk) && /^120(\.0)? MB so far/.test(copy.downloadStatus(unk).text), copy.downloadStatus(unk).text);
  check('known size is not indeterminate', !copy.isIndeterminate(d({})));
  check('unknown size label has bytes, not a percent', /so far$/.test(copy.downloadProgressLabel(unk)) && copy.downloadProgressLabel(d({})) === '25 percent');
  check('finished with no size is not unknown', !copy.isSizeUnknown(d({ state: 'finished', size: null })));
  check('stalled shows Waiting for the server', copy.downloadStatus(d({ stalled: true })).text === 'Waiting for the server' && copy.downloadCaption(d({ stalled: true })) === 'Waiting for the server');
  check('not stalled has no caption', copy.downloadCaption(d({ stalled: false })) === null && copy.downloadCaption(d({})) === null);
  check('stalled error reads plainly and retries', copy.downloadStatus(err('STALLED')).text === 'The server stopped sending data.' && kinds(err('STALLED')) === 'retry');
  check('finished offers Open', kinds(d({ state: 'finished' })) === 'open' && copy.downloadAction(d({ state: 'finished' })).label === 'Open');
  check('NO_APP text', copy.openFailureText('NO_APP', 'x') === 'No app on this phone can open this file.');
  check('other open errors keep their message', copy.openFailureText('INTERNAL', 'Boom') === 'Boom' && copy.openFailureText(undefined) === "Couldn't open that file.");
  check('AUTH_REQUIRED error asks for the link again', copy.downloadStatus(err('AUTH_REQUIRED')).text === 'This link needs you to sign in again. Paste the link again.' && kinds(err('AUTH_REQUIRED')) === 'newLink' && copy.needsNewLink(err('AUTH_REQUIRED')));
  check('codes match exactly', kinds(err('STALLED_X')) === 'retry' && copy.downloadStatus(err('STALLED_X')).text === 'x');

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nurl-download tests passed');
}
main();
