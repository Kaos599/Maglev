#!/usr/bin/env node
// Subtitle sources, batch 3 (anime): parse functions on saved real responses. Never touches the network.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}
const fx = (id, f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'subtitles', id, f));
const fxt = (id, f) => fx(id, f).toString('utf8');
const q = (o) => ({ fileName: 'x.mkv', videoBytes: 1, title: 'Cowboy Bebop', episodeConfidence: 'none', languages: ['en'], ...o });

(async () => {
  const kk = await import('../utils/subtitles/providers/kitsunekko.ts');
  const b3 = await import('../utils/subtitles/providers/batch3.ts');
  const reg = await import('../utils/subtitles/providers/index.ts');

  // kitsunekko
  const idx = kk.parseIndex(fxt('kitsunekko', 'index_en.html'));
  check('kitsunekko index lists folders with decoded paths', idx.length === 5 && idx.some((d) => d.title === 'Cowboy Bebop' && d.path === 'subtitles/Cowboy Bebop/'), JSON.stringify(idx.slice(0, 2)));
  const jdx = kk.parseIndex(fxt('kitsunekko', 'index_ja.html'));
  check('kitsunekko japanese index keeps the japanese/ root', jdx.some((d) => d.path === 'subtitles/japanese/Cowboy Bebop/'));
  check('folder ranking: all title words, closest first', kk.rankDirectories('Cowboy Bebop', idx).map((d) => d.title).join() === 'Cowboy Bebop');
  check('folder ranking: a two-word folder inside a longer title fits', kk.directoryScore('Cowboy Bebop The Movie', 'Cowboy Bebop') > 0 && kk.directoryScore('Bebop', 'Cowboy Bebop') > 0 && kk.directoryScore('Death Note', 'Cowboy Bebop') === 0);
  check('folder ranking: a one-word folder fits only when it holds every title word', kk.directoryScore('Big Frieren Show', 'Frieren') === 0 && kk.directoryScore('Frieren Season 2', 'Frieren') === 0 && kk.directoryScore('Frieren', 'Frieren Beyond Journeys End') === 1 + 1 / 4);
  check('kitsunekko index without the listing table is a parse error', (() => { try { kk.parseIndex('<html>nope</html>'); return false; } catch (e) { return e.kind === 'parse'; } })());

  const files = kk.parseDirectory(fxt('kitsunekko', 'dir_cowboy_bebop.html'));
  check('kitsunekko folder: srt, ass and zip rows', files.length === 9 && files.filter((f) => f.ext === 'zip').length === 6 && files[0].ext === 'srt', `${files.length}`);
  check('kitsunekko folder: size and date', files[0].bytes === 92118 && files[0].uploadedAt === Date.UTC(2023, 11, 30, 11, 45, 9), JSON.stringify(files[0]));
  check('kitsunekko folder: path from the link, name from the bold text', files[1].path === 'subtitles/Cowboy Bebop/Cowboy Bebop - Knockin on Heavens Door_track4.ass' && files[1].name === 'Cowboy Bebop - Knockin on Heavens Door track4.ass');
  check('kitsunekko folder with only 7z packs gives nothing', kk.parseDirectory(fxt('kitsunekko', 'dir_frieren_7z_only.html')).length === 0);
  check('PM times convert', kk.parseSiteDate('Jul 18 2024 07:00:18 PM') === Date.UTC(2024, 6, 18, 19, 0, 18) && kk.parseSiteDate('Jan 01 2020 12:30:00 AM') === Date.UTC(2020, 0, 1, 0, 30, 0));

  const cands = kk.candidatesFrom(files, 'en', q({}));
  check('candidates carry provider, language, release name, format and match type', cands.length === 9 && cands[0].providerId === 'kitsunekko' && cands[0].language === 'en' && cands[0].format === 'srt' && cands[0].matchedBy === 'title' && cands[0].releaseName.endsWith('.srt'));
  check('a zip has no format yet', cands.find((c) => c.releaseName === 'Cowboy Bebop.zip').format === undefined);
  check('episode filter drops a file that names another episode', kk.fitsEpisode('Show - 05.srt', { episode: 5, episodeConfidence: 'sure' }) && !kk.fitsEpisode('Show S01E06.srt', { season: 1, episode: 5, episodeConfidence: 'sure' }) && kk.fitsEpisode('Show.zip', { episode: 5, episodeConfidence: 'sure' }) && kk.fitsEpisode('Show S01E06.srt', { episode: 5, episodeConfidence: 'none' }));
  const ep = kk.candidatesFrom([{ name: 'Show - 04.srt', path: 'a', ext: 'srt' }, { name: 'Show - 05.srt', path: 'b', ext: 'srt' }, { name: 'Show pack.zip', path: 'c', ext: 'zip' }], 'en', q({ title: 'Show', episode: 5, episodeConfidence: 'sure' }));
  check('episode search keeps the match first and drops the other episode', ep.map((c) => c.id).join() === 'b,c');

  check('urls: encoded index, folder and file', kk.indexUrl('https://kitsunekko.net/', 'ja') === 'https://kitsunekko.net/dirlist.php?dir=subtitles%2Fjapanese%2F' && kk.indexUrl('https://kitsunekko.net', 'fr') === null && kk.directoryUrl('https://kitsunekko.net', 'subtitles/Cowboy Bebop/') === 'https://kitsunekko.net/dirlist.php?dir=subtitles%2FCowboy%20Bebop%2F' && kk.fileUrl('https://kitsunekko.net', 'subtitles/Cowboy Bebop/Session #0.ass') === 'https://kitsunekko.net/subtitles/Cowboy%20Bebop/Session%20%230.ass');

  const srt = new Uint8Array(fx('kitsunekko', 'download.srt'));
  const p = kk.toPayload(srt, { language: 'en' });
  check('a plain subtitle is text with its format read from the content', p.kind === 'text' && p.format === 'srt' && p.bytes.length === srt.length);
  check('an ASS body is read as ass', kk.toPayload(Uint8Array.from(Buffer.from('[Script Info]\nTitle: x\n')), { language: 'ja' }).format === 'ass');
  check('a zip is a zip', kk.toPayload(Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0])).kind === 'zip');
  const refuses = (b) => { try { kk.toPayload(b); return null; } catch (e) { return `${e.kind}:${e.message}`; } };
  check('rar and 7z are refused in plain words', refuses(Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0])) === "parse:This subtitle's file type isn't supported" && refuses(Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) === "parse:This subtitle's file type isn't supported");
  check('an HTML page where a file should be is refused', refuses(Uint8Array.from(Buffer.from('<!DOCTYPE html><html>'))) === 'parse:Unexpected response' && refuses(new Uint8Array(0)) === 'parse:Empty subtitle');

  // The provider and the registry.
  const prov = b3.BATCH_3.find((x) => x.id === 'kitsunekko');
  check('kitsunekko declares group B, https mirrors, en and ja, no default', prov && prov.group === 'B' && prov.enabledByDefault === false && prov.mirrors.every((m) => m.startsWith('https://')) && prov.languages.join() === 'en,ja' && prov.matches.join() === 'name');
  check('batch 3 ids are unique and in the registry', new Set(b3.BATCH_3.map((x) => x.id)).size === b3.BATCH_3.length && b3.BATCH_3.every((x) => reg.SUBTITLE_PROVIDERS.includes(x)));
  check('search for a language it lacks makes no request', (await prov.search(q({ languages: ['fr'] }), { signal: new AbortController().signal, baseUrl: 'https://invalid.invalid' })).length === 0);

  console.log(failed ? `\n${failed} failed` : '\nsubtitles batch 3: all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
