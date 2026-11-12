// Deterministic fake engine + fake search for the assistant eval. Every action is recorded, never real.
'use strict';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const hash = (c) => c.repeat(40);

const snap = (o) => ({
  id: 'x', name: 'x', state: 'PAUSED', pausedBy: 'user', finished: false, progressBytes: 0, totalBytes: 1 * GB, uploadedBytes: 0,
  downBps: 0, upBps: 0, peersLive: 0, peersSeen: 0, webSeeds: 0, etaSecs: -1, ratio: 0, seedingSecs: 0, addedAt: 1762900000,
  outputFolder: '/storage/emulated/0/Download/Maglev', error: null, downLimitBps: 0, upLimitBps: 0, moveProgress: null,
  health: null, includedBytes: 1 * GB, resolvingSecs: null, ...o,
});
const file = (index, path, length, o = {}) => ({
  index, path, length, progressBytes: 0, included: true, priority: 'normal', streamReadyBytes: 0, tailReady: false, ...o,
});

/** The four transfers from the user's phone. Sintel file indices: 0 video, 1..6 subtitles, 7 poster. */
function initialTransfers() {
  const sintelFiles = [
    file(0, 'Sintel/Sintel.mp4', 1_180 * MB, { progressBytes: 400 * MB }),
    file(1, 'Sintel/Subtitles/Sintel.en.srt', 120 * 1024),
    file(2, 'Sintel/Subtitles/Sintel.de.srt', 118 * 1024),
    file(3, 'Sintel/Subtitles/Sintel.es.srt', 119 * 1024),
    file(4, 'Sintel/Subtitles/Sintel.fr.srt', 121 * 1024),
    file(5, 'Sintel/Subtitles/Sintel.it.srt', 117 * 1024),
    file(6, 'Sintel/Subtitles/Sintel.nl.srt', 116 * 1024),
    file(7, 'Sintel/poster.jpg', 140 * 1024),
  ];
  const total = sintelFiles.reduce((n, f) => n + f.length, 0);
  const T = [
    { snap: snap({ id: 'eng-sintel', name: 'Sintel', totalBytes: total, includedBytes: total, progressBytes: 400 * MB }), files: sintelFiles },
    {
      snap: snap({
        id: 'eng-deb-amd64', name: 'debian-13.7.0-amd64-netinst.iso', state: 'DOWNLOADING', pausedBy: null, totalBytes: 754 * MB, includedBytes: 754 * MB,
        progressBytes: 0, peersLive: 0, peersSeen: 0, health: 'no_peers',
      }),
      files: [file(0, 'debian-13.7.0-amd64-netinst.iso', 754 * MB)],
    },
    {
      snap: snap({ id: 'eng-deb-arm64', name: 'debian-13.7.0-arm64-netinst.iso', totalBytes: 640 * MB, includedBytes: 640 * MB, progressBytes: 120 * MB }),
      files: [file(0, 'debian-13.7.0-arm64-netinst.iso', 640 * MB, { progressBytes: 120 * MB })],
    },
    {
      snap: snap({ id: 'eng-trailers', name: '1953_Movie_Trailers_Coming', totalBytes: 310 * MB, includedBytes: 310 * MB, progressBytes: 310 * MB, finished: true }),
      files: [file(0, '1953_Movie_Trailers_Coming/trailers.mp4', 310 * MB, { progressBytes: 310 * MB })],
    },
  ];
  return T;
}

/** A fresh world: engine deps (RunnerEngine) + action log. */
function createWorld(opts = {}) {
  const freeBytes = (opts.freeGB ?? 1.1) * GB;
  const transfers = initialTransfers();
  const actions = [];
  const log = (name, ...args) => actions.push({ name, args });
  /** infoHash -> {name, sizeBytes} of every search row shown, filled by the harness's search wrapper. */
  const knownResults = new Map();
  const find = (id) => transfers.find((t) => t.snap.id === id);
  const detailOf = (t) => ({ snapshot: t.snap, files: t.files, peers: [], trackers: [{ url: 'udp://tracker.example:6969', status: 'unknown', message: null }], pieceCount: 1000, pieceLength: 262144 });

  const engine = {
    async listTorrents() { return { ok: true, torrents: transfers.map((t) => t.snap), downloads: [] }; },
    async getDetail(id) { const t = find(id); return t ? { ok: true, ...detailOf(t) } : { ok: false, code: 'NOT_FOUND', message: 'nope' }; },
    async resolveMetadata(source, timeoutMs) {
      log('resolveMetadata', source.slice(0, 60), timeoutMs);
      const dn = /[?&]dn=([^&]+)/.exec(source);
      const name = dn ? decodeURIComponent(dn[1].replace(/\+/g, ' ')) : 'Some.Movie.2023.1080p.WEB-DL.x264-GRP';
      const infoHash = (/btih:([0-9a-fA-F]{40})/.exec(source) || [])[1] || hash('a');
      // Same size as the search row it came from, so the file list is plausible for the name.
      const known = knownResults.get(infoHash.toLowerCase());
      const size = known && known.sizeBytes ? known.sizeBytes : 800 * MB;
      const files = [{ index: 0, path: `${name}/${name}.mkv`, length: size }, { index: 1, path: `${name}/${name}.en.srt`, length: 90 * 1024 }];
      return { ok: true, infoHash, name, totalBytes: files.reduce((n, f) => n + f.length, 0), files };
    },
    async cancelResolve() { return { ok: true }; },
    async addTorrent(source, options) { log('addTorrent', source.slice(0, 60), options); return { ok: true, id: 'eng-new', infoHash: hash('f') }; },
    async setFilePriorities(id, entries) {
      log('setFilePriorities', id, entries);
      const t = find(id);
      if (t) for (const e of entries) { const f = t.files.find((x) => x.index === e.index); if (f) { f.priority = e.priority; f.included = e.priority !== 'skip'; } }
      return { ok: true };
    },
    async pause(id) { log('pause', id); const t = find(id); if (t) { t.snap.state = 'PAUSED'; t.snap.pausedBy = 'user'; } return { ok: true }; },
    async resume(id) { log('resume', id); const t = find(id); if (t) { t.snap.state = 'DOWNLOADING'; t.snap.pausedBy = null; } return { ok: true }; },
    async removeFiles(id, idx) { log('removeFiles', id, idx); return { ok: true, freedBytes: 0 }; },
    async delete(id, del) { log('delete', id, del); const i = transfers.findIndex((t) => t.snap.id === id); if (i >= 0) transfers.splice(i, 1); return { ok: true }; },
    async getFreeSpace() { return { ok: true, path: '/storage/emulated/0/Download/Maglev', freeBytes, totalBytes: 128 * GB, mode: 'direct' }; },
    async pauseDownload(id) { log('pauseDownload', id); return { ok: true }; },
    async resumeDownload(id) { log('resumeDownload', id); return { ok: true }; },
    async removeDownload(id, del) { log('removeDownload', id, del); return { ok: true }; },
  };
  return { engine, actions, transfers, knownResults, subtitleIndices: [1, 2, 3, 4, 5, 6] };
}

const DAY = 86400000;
/** Build search rows (the shape the real providers return) from {name, mb, seeders, ageDays?, category?}. */
function rows(list, defaults = {}) {
  const now = Date.now();
  return list.map((r, n) => {
    const h = hash(String.fromCharCode(97 + (n % 26))).slice(0, 38) + String(10 + n).slice(-2);
    const provider = r.provider || defaults.provider || 'knaben';
    return {
      providerId: provider, name: r.name, infoHash: h,
      magnet: `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(r.name)}`,
      sizeBytes: Math.round(r.mb * MB), seeders: r.seeders ?? 50, category: r.category || defaults.category || 'movies',
      sources: [provider], ...(r.ageDays === undefined ? {} : { publishedAt: now - r.ageDays * DAY }),
    };
  });
}

/** Normal recent movie releases, with upload dates. */
const movieRows = () => rows([
  { name: 'The.Last.Harbor.2025.1080p.WEB-DL.DDP5.1.H.264-FLUX', mb: 4300, seeders: 210, ageDays: 2 },
  { name: 'Night.Train.to.Lisbon.2025.1080p.WEBRip.x265-RARBG', mb: 2100, seeders: 160, ageDays: 4 },
  { name: 'Quiet.Orbit.2025.720p.WEB-DL.x264-NTb', mb: 1400, seeders: 95, ageDays: 6 },
  { name: 'Paper.Lanterns.2025.2160p.WEB-DL.DDP5.1.HDR.H.265-APEX', mb: 14500, seeders: 70, ageDays: 9 },
  { name: 'Glass.Orchard.2025.1080p.BluRay.x264-GECKOS', mb: 3600, seeders: 55, ageDays: 15 },
]);

/** Canned rows for --fake (no network). Goes through the real toolRunner and scorer like a live search. */
function fakeSearchRows(query) {
  const q = (query || 'movie').toLowerCase().trim();
  if (/^(latest |new |popular |best )?(movies?|films?)( .*)?$/.test(q)) return movieRows();
  const title = q.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/[^A-Za-z0-9]+/g, '.');
  return rows([
    { name: `${title}.2025.1080p.WEB-DL.DDP5.1.H.264-FLUX`, mb: 900, seeders: 120, ageDays: 3 },
    { name: `${title}.2025.720p.WEB-DL.x264-NTb`, mb: 600, seeders: 90, ageDays: 6 },
    { name: `${title}.2024.1080p.BluRay.x264-GECKOS`, mb: 840, seeders: 60, ageDays: 9 },
    { name: `${title}.2025.HDTS.x264-RARBG`, mb: 700, seeders: 30 },
  ]);
}

module.exports = { createWorld, fakeSearchRows, rows, movieRows, GB, MB };
