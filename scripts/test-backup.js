#!/usr/bin/env node
// Backup and restore (docs/contracts-0.19/backup.md). Pure modules under utils/backup run directly.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).
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
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

async function main() {
  const F = await import('../utils/backup/format.ts');
  const M = await import('../utils/backup/migrate.ts');
  const E = await import('../utils/backup/export.ts');
  const I = await import('../utils/backup/import.ts');
  const { DEFAULT_SETTINGS } = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  const { parseMagnet } = await import('../modules/maglev-engine/src/magnet.ts');

  const H1 = 'a'.repeat(40);
  const H2 = 'b'.repeat(40);
  const H3 = 'c'.repeat(40);
  const FOLDER = '/storage/emulated/0/Download/Maglev';
  const snap = (id, over = {}) => ({
    id, name: `Name ${id.slice(0, 2)}`, state: 'DOWNLOADING', pausedBy: null, finished: false, progressBytes: 0, totalBytes: 0,
    uploadedBytes: 0, downBps: 0, upBps: 0, peersLive: 0, peersSeen: 0, webSeeds: 0, etaSecs: -1, ratio: 0, seedingSecs: 0,
    addedAt: 1000, outputFolder: FOLDER, error: null, downLimitBps: 0, upLimitBps: 0,
    moveProgress: null, health: null, includedBytes: 0, resolvingSecs: null, ...over,
  });
  const dl = (url, over = {}) => ({
    id: 'd1', urlDisplay: url, name: 'file.zip', state: 'downloading', pausedBy: null, size: 1, downloaded: 0, downBps: 0, eta: -1,
    segmentsActive: 1, resumable: true, folder: FOLDER, addedAt: 2000, error: null, ...over,
  });

  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.network.proxy = { ...settings.network.proxy, enabled: true, host: 'h', port: 1, username: 'bob', password: 'hunter2' };
  settings.downloadFolder = { uri: 'content://tree/x', displayName: 'X', mode: 'direct' };
  settings.storage.customSafUri = 'content://tree/x';

  const prefs = {
    'maglev.search.prefs.v2': {
      enabled: ['piratebay', 'torznab:abc'], torznab: [{ id: 'abc', name: 'Mine', url: 'https://t.example/api?apikey=SECRET1&t=search', categories: [] }],
      recents: ['private query'], clearances: [{ host: 'x' }],
    },
    'maglev.feeds.list.v1': [{ id: 'f1', name: 'Feed', url: 'https://feed.example/rss?passkey=SECRET2&x=1' }],
    'maglev.assistant.prefs.v1': { presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'm', keyRef: 'assistant.openrouter', tokensUsed: { input: 5, output: 6 }, enabled: true, apiKey: 'sk-LEAK' },
    'maglev.schedule.v1': { enabled: true, rules: [] },
    'maglev.tabs.prefs.v1': { order: ['index'], hidden: [] },
  };
  const deps = {
    appVersion: '0.19', now: () => 1763000000000, settings, readPref: (k) => prefs[k],
    torrents: [snap(H1, { pausedBy: 'user', state: 'PAUSED' }), snap(H2), snap(H3, { pausedBy: 'wifi_only', state: 'PAUSED' })],
    downloads: [dl('https://host.example/a/file.zip'), dl('https://host.example/b.zip', { state: 'needs_link' }), dl('ftp://x/y', {})],
    torrentData: async (id) => (id === H1
      ? { trackers: ['udp://t.example:80/announce', 'https://t2.example/announce?x=1'], files: [{ index: 0, included: true }, { index: 1, included: false }, { index: 2, included: true }] }
      : id === H2 ? { trackers: [], files: [{ index: 0, included: true }] } : null),
  };

  // ---- Round trip ---------------------------------------------------------------------------
  const backup = await E.buildBackup(deps);
  const text = E.serializeBackup(backup);
  const parsed = M.parseBackup(text);
  check('round trip: parse ok', parsed.ok === true);
  const b = parsed.backup;
  check('envelope: format and version', b.format === 'maglev-backup' && b.v === 1 && b.app === '0.19' && b.created === 1763000000000);
  check('round trip: three torrents', b.torrents.length === 3);
  check('round trip: skipped needs_link and non-http downloads', b.downloads.length === 1 && b.downloads[0].url === 'https://host.example/a/file.zip');
  const t1 = b.torrents.find((t) => t.infoHash === H1);
  const m1 = parseMagnet(t1.magnet);
  check('magnet carries hash, name and trackers', m1 && m1.infoHash === H1 && m1.name === t1.name && m1.trackers.length === 2 && m1.trackers[1] === 'https://t2.example/announce?x=1');
  check('selected files are the included indices', JSON.stringify(t1.onlyFiles) === '[0,2]');
  check('all files included means null', b.torrents.find((t) => t.infoHash === H2).onlyFiles === null);
  check('user pause is kept, rule pause is not', t1.paused === true && b.torrents.find((t) => t.infoHash === H3).paused === false);
  check('torrent without detail still exports a magnet', parseMagnet(b.torrents.find((t) => t.infoHash === H3).magnet)?.infoHash === H3);
  check('folder and added date kept', t1.folder === FOLDER && t1.addedAt === 1000);
  const dlp = (state, pausedBy) => E.downloadToBackup({ id: 'd9', urlDisplay: 'https://a.example/f.zip', name: 'f.zip', state, pausedBy, size: 1, downloaded: 0, downBps: 0, eta: -1, segmentsActive: 0, resumable: true, folder: '/x', addedAt: 1, error: null });
  check('link download: user pause is kept, rule pauses (storage_full, wifi_only) export as not paused', dlp('paused', 'user').paused === true && dlp('paused', 'storage_full').paused === false && dlp('paused', 'wifi_only').paused === false && dlp('paused', null).paused === true && dlp('downloading', null).paused === false);
  check('torrentData failure does not stop the export', (await E.buildBackup({ ...deps, torrentData: async () => { throw new Error('x'); } })).torrents.length === 3);
  check('file name', E.backupFileName(Date.UTC(2026, 10, 13)) === 'maglev-2026-11-13.maglev-backup.json');

  // ---- Secrets ------------------------------------------------------------------------------
  const keyLike = (obj, trail = '') => {
    const hits = [];
    if (Array.isArray(obj)) obj.forEach((v, i) => hits.push(...keyLike(v, `${trail}[${i}]`)));
    else if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (F.isSecretName(k)) hits.push(`${trail}.${k}`);
        hits.push(...keyLike(v, `${trail}.${k}`));
      }
    }
    return hits;
  };
  check('no field named like a key or token anywhere', keyLike(JSON.parse(text)).length === 0, keyLike(JSON.parse(text)).join(', '));
  for (const leak of ['SECRET1', 'SECRET2', 'sk-LEAK', 'hunter2', 'bob', 'assistant.openrouter', 'private query']) {
    check(`file never contains "${leak}"`, !text.includes(leak));
  }
  check('torznab URL keeps its non-secret query', text.includes('t.example/api?t=search'));
  check('assistant prefs keep provider choice', b.prefs['maglev.assistant.prefs.v1'].model === 'm' && b.prefs['maglev.assistant.prefs.v1'].enabled === true);
  check('device-bound settings are out of the file', b.settings.downloadFolder === null && b.settings.storage.customSafUri === undefined);
  check('scrubUrl drops credentials and secret params', F.scrubUrl('https://u:p@h.example/x?token=1&a=2') === 'https://h.example/x?a=2');

  // ---- Version and shape --------------------------------------------------------------------
  const future = M.parseBackup(JSON.stringify({ format: 'maglev-backup', v: 2 }));
  check('future version is refused with a plain message', !future.ok && future.reason === 'too_new' && /newer Maglev/.test(future.message));
  for (const [name, input] of [['not JSON', 'nope{'], ['wrong format', '{"format":"x","v":1}'], ['no version', '{"format":"maglev-backup"}'], ['v0', '{"format":"maglev-backup","v":0}'], ['an array', '[]'], ['null', 'null']]) {
    const r = M.parseBackup(input);
    check(`refuses ${name}`, !r.ok && r.reason === 'not_backup' && r.message === "That isn't a Maglev backup.");
  }
  const sparse = M.parseBackup(JSON.stringify({ format: 'maglev-backup', v: 1, torrents: [{ infoHash: 'zz' }, null, 5, { infoHash: H1.toUpperCase(), name: 'N', onlyFiles: [2, 'x', -1, 2, 0] }], downloads: [{ url: 'file:///x' }, { url: 'https://a.example/f' }] }));
  check('bad entries are dropped, good ones normalised', sparse.ok && sparse.backup.torrents.length === 1 && sparse.backup.torrents[0].infoHash === H1 && JSON.stringify(sparse.backup.torrents[0].onlyFiles) === '[0,2]' && sparse.backup.downloads.length === 1);
  check('missing parts are empty, not errors', sparse.ok && sparse.backup.settings === null && Object.keys(sparse.backup.prefs).length === 0);

  // ---- Settings go through the store's migrate ----------------------------------------------
  const old = M.parseBackup(JSON.stringify({ format: 'maglev-backup', v: 1, settings: { version: 1, settings: { appearance: { fontStyle: 'bogus' }, bandwidth: { maxActiveDownloads: 'many' } } } }));
  check('old or broken settings are migrated to the current schema', old.ok && old.backup.settings.appearance.fontStyle === 'clean' && old.backup.settings.bandwidth.maxActiveDownloads === DEFAULT_SETTINGS.bandwidth.maxActiveDownloads && old.backup.settings.power && old.backup.settings.network.proxy);
  const merged = F.mergeDeviceBound(b.settings, settings);
  check("import keeps this phone's folder and proxy login", merged.downloadFolder.uri === 'content://tree/x' && merged.network.proxy.password === 'hunter2' && merged.storage.customSafUri === 'content://tree/x');
  check('import does not change onboarding state', F.mergeDeviceBound({ ...b.settings, onboarded: true }, { ...settings, onboarded: false }).onboarded === false);

  // ---- Preview ------------------------------------------------------------------------------
  const p = F.previewCounts(b);
  check('preview counts', p.torrents === 3 && p.downloads === 1 && p.hasSettings && p.searchSources === 2 && p.feeds === 1 && p.hasSchedule && p.hasAssistant);
  check('preview sentence', F.previewSentence(p) === 'This backup has 3 torrents, 1 download, your settings, 2 search sources and 1 feed.', F.previewSentence(p));
  check('preview sentence for the spec example', F.previewSentence({ torrents: 12, downloads: 3, hasSettings: true, searchSources: 28, feeds: 0 }) === 'This backup has 12 torrents, 3 downloads, your settings and 28 search sources.');
  check('empty backup says so', F.previewSentence({ torrents: 0, downloads: 0, hasSettings: false, searchSources: 0, feeds: 0 }) === 'This backup is empty.');

  // ---- Restore: duplicates, folders, paused, parts -------------------------------------------
  const calls = [];
  const engine = {
    addTorrent: async (src, o) => { calls.push(['addTorrent', src, o]); const h = parseMagnet(src).infoHash; return { ok: true, id: h, infoHash: h }; },
    addDownload: async (url, o) => { calls.push(['addDownload', url, o]); return { ok: true, id: `dl-${calls.length}` }; },
    recheck: async (id) => { calls.push(['recheck', id]); return { ok: true }; },
    resume: async (id) => { calls.push(['resume', id]); return { ok: true }; },
    resumeDownload: async (id) => { calls.push(['resumeDownload', id]); return { ok: true }; },
  };
  const applied = { settings: null, prefs: [] };
  const mk = (over = {}) => ({
    engine, folderExists: (f) => f === FOLDER, existingHashes: new Set([H2]), existingUrls: ['https://HOST.example/a/file.zip/'],
    currentSettings: settings, applySettings: (s) => { applied.settings = s; }, applyPref: (k) => { applied.prefs.push(k); }, ...over,
  });
  const all = new Set(F.BACKUP_PARTS);
  const bk = {
    ...b,
    torrents: b.torrents.map((t) => (t.infoHash === H3 ? { ...t, folder: '/sdcard/Gone' } : t)),
    downloads: [...b.downloads, { url: 'https://other.example/z', name: 'z', folder: '/sdcard/Gone', paused: false, state: 'downloading', addedAt: 1 }],
  };
  const r = await I.restoreBackup(bk, all, mk());
  check('duplicate torrent (same info hash) is skipped', r.torrentsAdded === 2 && r.torrentsSkipped === 1 && !calls.some((c) => c[0] === 'addTorrent' && parseMagnet(c[1]).infoHash === H2));
  check('duplicate download (same URL, any case or slash) is skipped', r.downloadsAdded === 1 && r.downloadsSkipped === 1);
  check('everything is added paused', calls.filter((c) => c[0] === 'addTorrent' || c[0] === 'addDownload').every((c) => c[2].paused === true));
  check('selected files travel with the torrent', JSON.stringify(calls.find((c) => c[0] === 'addTorrent' && c[1].includes(H1))[2].onlyFiles) === '[0,2]');
  const goneT = calls.find((c) => c[0] === 'addTorrent' && c[1].includes(H3));
  check('missing folder falls back to the default', goneT[2].outputFolder === null);
  check('existing folder is used', calls.find((c) => c[0] === 'addTorrent' && c[1].includes(H1))[2].outputFolder === FOLDER);
  check('folder fallback is counted for the note', r.defaultFolderCount === 2, String(r.defaultFolderCount));
  check('added torrents are rechecked', calls.filter((c) => c[0] === 'recheck').length === 2);
  check('settings and prefs applied', r.settingsApplied && applied.settings.downloadFolder.uri === 'content://tree/x' && applied.prefs.includes('maglev.search.prefs.v2') && applied.prefs.includes('maglev.tabs.prefs.v1'));
  const started = await I.startAdded(r, engine);
  check('Start all resumes only what was added', started === 3 && calls.filter((c) => c[0] === 'resume').map((c) => c[1]).sort().join() === [H1, H3].sort().join());

  calls.length = 0; applied.prefs.length = 0; applied.settings = null;
  const r2 = await I.restoreBackup(bk, new Set(['torrents']), mk());
  check('unticked parts are not touched', !r2.settingsApplied && applied.prefs.length === 0 && r2.downloadsAdded === 0 && !calls.some((c) => c[0] === 'addDownload'));
  const r3 = await I.restoreBackup(bk, new Set(['settings']), mk());
  check('settings only: no torrents added', r3.torrentsAdded === 0 && r3.settingsApplied);
  const r4 = await I.restoreBackup(bk, new Set(['torrents']), mk({ engine: { ...engine, addTorrent: async () => ({ ok: false, code: 'DUPLICATE', message: '' }) } }));
  check('engine DUPLICATE counts as skipped', r4.torrentsSkipped === 3 && r4.torrentsAdded === 0 && r4.torrentsFailed === 0);
  const r5 = await I.restoreBackup(bk, new Set(['torrents']), mk({ engine: { ...engine, addTorrent: async () => { throw new Error('boom'); } } }));
  check('a failing add is counted, not thrown', r5.torrentsFailed === 2);
  check('urlKey ignores case and trailing slash', I.urlKey('https://A.example/x/') === I.urlKey('https://a.example/x'));

  // ---- Wiring -------------------------------------------------------------------------------
  const screen = read('app/settings/backup.tsx');
  check('screen reads copy from constants/copy.ts', /backupCopy/.test(screen));
  check('screen has no raw colours', !/#[0-9a-fA-F]{3,8}\b/.test(screen));
  check('copy says secrets are never saved', /never saved/.test(read('constants/copy.ts')));
  if (require('./lib/privateDocs').readPrivateDoc('contracts-0.19/backup.md') !== null) check('contract doc exists', true);

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nbackup: all checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
