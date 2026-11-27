#!/usr/bin/env node
// Video sites (prototype): host detection, the quality list built from saved
// yt-dlp output (YouTube pair, X single file, Instagram single file), error copy, the `parts` options shape, and
// source checks of the Kotlin, Rust and screen wiring. Pure; no network. Needs Node 22.18+ (type stripping).
//   node scripts/test-video-sites.js
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ''}`);
  }
}
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const fixture = (n) => JSON.parse(read(`scripts/fixtures/video-sites/${n}.json`));

(async () => {
  const V = await import('../utils/videoSites.ts');

  // ---- host detection
  for (const u of [
    'https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc', 'https://m.youtube.com/watch?v=abc', 'https://x.com/a/status/1',
    'https://twitter.com/a/status/1', 'https://www.instagram.com/reel/abc/', 'https://old.reddit.com/r/a/comments/1', 'https://vimeo.com/1',
    'https://www.tiktok.com/@a/video/1', 'HTTPS://YouTube.com/watch?v=1',
  ]) check(`video site: ${u}`, V.isVideoSiteUrl(u));
  for (const u of [
    'https://example.com/file.zip', 'https://notyoutube.com/x', 'https://youtube.com.evil.test/x', 'https://evil.test/?u=https://youtube.com/x',
    'https://user@evil.test/youtube.com', 'ftp://youtube.com/x', 'not a link', '',
  ]) check(`not a video site: ${u}`, !V.isVideoSiteUrl(u));

  // ---- YouTube: video-only avc1 MP4 + the best m4a, one option per height
  const yt = V.buildVideoSiteInfo(fixture('youtube'));
  check('youtube: title and duration', yt.title.startsWith('Big Buck Bunny') && yt.durationSec === 635 && yt.site === 'Youtube');
  const ytVideo = yt.options.filter((o) => o.audio);
  check('youtube: six heights, tallest first', ytVideo.map((o) => o.height).join() === '1080,720,480,360,240,144', ytVideo.map((o) => o.height));
  check('youtube: avc1 only (no 1440p or 2160p, which have no avc1)', !yt.options.some((o) => (o.height ?? 0) > 1080));
  const top = ytVideo[0];
  check('youtube: 1080p is the avc1 file 299 with audio 140', top.id === '299+140', top.id);
  check('youtube: both parts are plain https files', top.video.url.startsWith('https://') && top.audio.url.startsWith('https://') && top.video.url !== top.audio.url);
  check('youtube: exact sizes are kept for the engine', top.video.size === 257619653 && top.audio.size === 10271496, [top.video.size, top.audio.size]);
  check('youtube: estimate is video + audio', top.estBytes === 257619653 + 10271496);
  check('youtube: label has the height and an approximate size', top.label === '1080p · about 255 MB', top.label);
  check('youtube: video-only formats come with an mp4 name', top.ext === 'mp4');
  check('youtube: never picks the dynamic-range-compressed audio', !yt.options.some((o) => (o.audio?.url ?? '').includes('140-drc')));
  const aud = yt.options[yt.options.length - 1];
  check('youtube: last option is Audio only (m4a)', aud.id === 'audio-140' && aud.ext === 'm4a' && aud.audio === null && aud.height === null);
  check('youtube: Audio only label', aud.label === 'Audio only · about 9.8 MB', aud.label);
  check('youtube: playlists and storyboards are never offered', yt.options.every((o) => /^https:\/\//.test(o.video.url) && !/sb\d|233|234|m3u8/.test(o.id)));
  check('youtube: at most six qualities plus audio', yt.options.length === 7);

  // ---- YouTube with 5.1 surround audio (258) + muxed 360p (18): prefers stereo (140) so sizes stay monotonic (#217)
  const ytSurround = V.buildVideoSiteInfo({
    title: 'Big Buck Bunny', id: 'bbb', duration: 635, extractor_key: 'Youtube',
    formats: [
      { format_id: '140', url: 'https://a.test/140.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', audio_channels: 2, abr: 129, tbr: 129, filesize: 10271496, protocol: 'https' },
      { format_id: '258', url: 'https://a.test/258.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', audio_channels: 6, abr: 388, tbr: 388, filesize: 30767611, protocol: 'https' },
      { format_id: '160', url: 'https://a.test/160.mp4', ext: 'mp4', vcodec: 'avc1.4D400C', acodec: 'none', height: 144, width: 256, tbr: 55, filesize: 4323893, protocol: 'https' },
      { format_id: '133', url: 'https://a.test/133.mp4', ext: 'mp4', vcodec: 'avc1.4D4015', acodec: 'none', height: 240, width: 426, tbr: 118, filesize: 9323483, protocol: 'https' },
      { format_id: '18', url: 'https://a.test/18.mp4', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, width: 640, tbr: 360, filesize: null, filesize_approx: 28526904, protocol: 'https' },
      { format_id: '135', url: 'https://a.test/135.mp4', ext: 'mp4', vcodec: 'avc1.4D401F', acodec: 'none', height: 480, width: 854, tbr: 356, filesize: 28207144, protocol: 'https' },
    ],
  });
  check('youtube surround: picks stereo 140 over 6ch 258', ytSurround.options.filter((o) => o.audio).every((o) => o.id.endsWith('+140')), ytSurround.options.map((o) => o.id));
  const surroundSizes = ytSurround.options.map((o) => o.estBytes);
  check('youtube surround: sizes decrease monotonically', surroundSizes.every((s, i) => s !== null && (i === 0 || surroundSizes[i - 1] >= s)), surroundSizes);

  // ---- X: plain MP4 files that already have sound
  const x = V.buildVideoSiteInfo(fixture('x'));
  check('x: two single files, tallest first', x.options.map((o) => `${o.height}:${o.id}`).join() === '360:http-832,180:http-256', x.options.map((o) => o.id));
  check('x: no second file', x.options.every((o) => o.audio === null));
  check('x: size is an estimate only (no exact size to range on), from the playlist average bitrate', x.options[0].video.size === null && x.options[0].estBytes === 4843570);
  check('x: HLS formats are skipped, no Audio only', !x.options.some((o) => o.id.startsWith('hls') || o.label.startsWith('Audio')));
  check('x: label', x.options[0].label === '360p · about 4.6 MB', x.options[0].label);

  // ---- Instagram: formats 0/1/2 are plain files; the dash-*v video-only ones have no audio partner and are skipped
  const ig = V.buildVideoSiteInfo(fixture('instagram'));
  check('instagram: one single-file option (no height known)', ig.options.length === 1 && ig.options[0].audio === null && ig.options[0].height === null, ig.options.map((o) => o.id));
  check('instagram: the best (last) plain file wins', ig.options[0].id === '2', ig.options[0].id);
  check('instagram: dash video-only files are never offered', !ig.options.some((o) => o.id.startsWith('dash')));
  check('instagram: label shows a dash when the size is unknown', ig.options[0].label === 'Video · —', ig.options[0].label);

  // ---- odd input
  const empty = V.buildVideoSiteInfo({});
  check('empty page gives no options and no throw', empty.options.length === 0 && empty.title === '');
  check('junk input gives no options', V.buildVideoSiteInfo(null).options.length === 0 && V.buildVideoSiteInfo('x').options.length === 0);
  const noAudio = V.buildVideoSiteInfo({ formats: fixture('youtube').formats.filter((f) => f.vcodec !== 'none') });
  check('video-only formats with no audio partner give nothing', noAudio.options.length === 0);
  const http = V.buildVideoSiteInfo({ formats: [{ format_id: 'a', url: 'http://a.test/a.mp4', ext: 'mp4', protocol: 'https', height: 360 }] });
  check('a plain http address is not offered', http.options.length === 0);

  // ---- names, headers, `parts` options
  check('base name has the height', V.suggestedBaseName(yt, top) === `${yt.title} 1080p`);
  check('base name without a height is the title', V.suggestedBaseName(yt, aud) === yt.title);
  check('base name falls back to the site and id, then Video', V.suggestedBaseName({ ...ig, title: '', id: 'abc' }, ig.options[0]) === 'Instagram abc' && V.suggestedBaseName({ ...ig, title: '', id: '', site: '' }, ig.options[0]) === 'Video');
  const hdr = V.engineHeaders({ url: 'https://a.test', size: null, headers: { 'user-agent': 'UA', Referer: 'https://r.test', Accept: 'x', 'Sec-Fetch-Mode': 'navigate' } });
  check('only the headers the engine understands are sent', JSON.stringify(hdr) === JSON.stringify({ 'User-Agent': 'UA', Referer: 'https://r.test' }), hdr);
  const parts = V.partsOption(top);
  check('parts: video and audio links with exact sizes', parts && parts.video.url === top.video.url && parts.audio.url === top.audio.url && parts.video.size === 257619653 && parts.audio.size === 10271496);
  check('parts: a single file has none', V.partsOption(x.options[0]) === null && V.partsOption(aud) === null);
  const noSize = V.partsOption({ ...top, video: { ...top.video, size: null }, audio: { ...top.audio, size: null } });
  check('parts: no size key when the size is unknown', noSize && !('size' in noSize.video) && !('size' in noSize.audio));

  // ---- error copy
  const M = V.VIDEO_SITE_MESSAGES;
  check('login error asks to sign in and offers the browser', /signed-in/.test(M.SITE_NEEDS_LOGIN) && V.errorOffersBrowser('SITE_NEEDS_LOGIN'));
  check('unsupported site offers the browser', V.errorOffersBrowser('SITE_NOT_SUPPORTED') && /Open it in the browser/.test(M.SITE_NOT_SUPPORTED));
  check('a failed read offers Try again, not the browser', !V.errorOffersBrowser('SITE_FAILED') && M.SITE_FAILED === "Couldn't read this video. Try again.");
  check('a native message wins, a missing one falls back', V.videoSiteErrorMessage('SITE_FAILED', 'Custom') === 'Custom' && V.videoSiteErrorMessage('SITE_NEEDS_LOGIN', '') === M.SITE_NEEDS_LOGIN && V.videoSiteErrorMessage('???') === M.SITE_FAILED);
  check('no jargon in any message', Object.values(M).every((m) => !/yt-dlp|python|codec|format|extractor|ffmpeg/i.test(m)));

  // ---- wiring (source checks)
  const kt = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/videosites/VideoSites.kt');
  for (const code of Object.keys(M).filter((c) => c !== 'SITE_NO_FORMAT')) check(`kotlin has ${code}`, kt.includes(`"${code}"`));
  for (const code of ['SITE_NOT_SUPPORTED', 'SITE_NEEDS_LOGIN', 'SITE_NO_VIDEO', 'SITE_FAILED', 'VIDEO_SITES_UNAVAILABLE']) {
    check(`kotlin message for ${code} matches the app copy`, kt.includes(JSON.stringify(M[code]).slice(1, -1)));
  }
  check('kotlin runs yt-dlp with --dump-single-json and --no-playlist', kt.includes('--dump-single-json') && kt.includes('--no-playlist'));
  check('kotlin validates URL before running yt-dlp', /Regex\("\^https\?:\/\/"/.test(kt) && kt.includes('isWhitespace()') && kt.includes('host.isNullOrBlank()') && !kt.includes('addOption("--")'));
  check('kotlin picks first carousel entry with formats', /for \(i in 0 until entries\.length\(\)\)[\s\S]{0,200}optJSONArray\("formats"\)/.test(kt));
  const mod = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt');
  check('module exposes videoSitesResolve and videoSitesVersion', mod.includes('AsyncFunction("videoSitesResolve")') && mod.includes('AsyncFunction("videoSitesVersion")'));
  check('module resolves off the main thread', /private fun videoSitesResolve[\s\S]*?EngineHost\.ioScope\.launch/.test(mod));
  const gradle = read('modules/maglev-engine/android/build.gradle');
  check('library module only: no ffmpeg, no aria2c', /youtubedl-android:library:\d/.test(gradle) && !/youtubedl-android:(ffmpeg|aria2c)/.test(gradle));
  const rsOpts = read('native/maglev-core/src/http_dl/driver.rs');
  check('rust: parts option, mutually exclusive with stream', /pub parts: Option<PartsSpec>/.test(rsOpts) && /opts\.stream\.is_some\(\)/.test(rsOpts));
  const rsStream = read('native/maglev-core/src/http_dl/stream/mod.rs');
  check('rust: parts become a video track and an audio track (mux_needed)', /pub fn parts_resolved/.test(rsStream) && /TrackRole::Video/.test(rsStream) && /fn parts_options_parse/.test(rsStream));
  const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
  check('bridge: both calls, none through the engine restart rule', /public videoSitesResolve/.test(bridge) && /public async videoSitesVersion/.test(bridge) && !/this\.route\('videoSites/.test(bridge));
  const mock = read('modules/maglev-engine/src/MaglevMockEngine.ts');
  check('mock engine never invents video qualities', /videoSitesResolve[\s\S]{0,200}VIDEO_SITES_UNAVAILABLE/.test(mock));
  const screen = read('app/add-download.tsx');
  check('screen reads video pages and shows the reading state', screen.includes('videoSitesResolve') && screen.includes('Reading the video…') && screen.includes('isVideoSiteUrl'));
  check('screen: Open in browser for login and unsupported errors', screen.includes('errorOffersBrowser') && screen.includes("label: 'Open in browser'"));
  check('screen: never says yt-dlp', !/yt-dlp|ytdlp/i.test(screen));
  const mh = await import('../utils/browser/mediaHit.ts');
  const ytHit = { kind: 'video', url: null, unusable: 'blob', videoClass: 'blob', poster: null, linkHref: null, alt: '', pageUrl: 'https://m.youtube.com/watch?v=jNQXAC9IVRw' };
  const ytMenu = mh.buildMediaMenu(ytHit);
  check('long-press on a YouTube video offers Download this video for the page, no dead-end note', ytMenu.note === null && ytMenu.items[0]?.id === 'download-page-video' && ytMenu.items[0]?.url === ytHit.pageUrl);
  const otherMenu = mh.buildMediaMenu({ ...ytHit, pageUrl: 'https://example.com/v' });
  check('other blob videos keep the files-found note', otherMenu.note === mh.mediaMenuCopy.videoBlob && !otherMenu.items.some((i) => i.id === 'download-page-video'));
  check('browser sends the page to the add sheet', /onDownloadPage=\{\(u\) => router\.push\(\{ pathname: '\/add-download', params: \{ url: u \} \}\)\}/.test(read('app/browser.tsx')));
  const share = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/share/QuickShareActivity.kt');
  check('shared video-site page goes straight to the add sheet', /WEB_PAGE && isVideoSite\(host\(cls\.source\)\)\)[\s\S]{0,400}maglev:\/\/add-download\?url=/.test(share));
  check('share host list matches the app list', ['youtube.com', 'youtu.be', 'x.com', 'twitter.com', 'instagram.com', 'reddit.com', 'vimeo.com', 'tiktok.com'].every((h) => share.includes(`"${h}"`)));
  // On a phone, R8 stripped commons-compress's reflectively registered zip classes and
  // init failed with "class X is not a concrete class" ("Video sites aren't available in this build").
  const rules = read('modules/maglev-engine/android/consumer-rules.pro');
  check('R8 keeps the yt-dlp library and the commons-compress zip classes it registers by reflection',
    rules.includes('-keep class com.yausername.** { *; }') && rules.includes('-keep class org.apache.commons.compress.archivers.zip.** { *; }'));

  // ---- fresh links for a refused download (yt-dlp update, same quality again)
  const R = await import('../utils/videoSiteRefresh.ts');
  check('quality: "Title 1080p.mp4" is 1080', JSON.stringify(R.qualityOfName('Big Buck Bunny 1080p.mp4')) === JSON.stringify({ height: 1080, audioOnly: false }));
  check('quality: deduplicated "Title 1080p (2).mp4" is 1080', JSON.stringify(R.qualityOfName('Title 1080p (2).mp4')) === JSON.stringify({ height: 1080, audioOnly: false }));
  check('quality: a name with no height has none', R.qualityOfName('Clip.mp4').height === null && !R.qualityOfName('Clip.mp4').audioOnly);
  check('quality: .m4a is audio only', R.qualityOfName('Song.m4a').audioOnly === true && R.qualityOfName('Song.m4a').height === null);
  check('quality: a 4-digit height in the title is not taken from the middle', R.qualityOfName('Top 720p Moments 480p.mp4').height === 480);
  check('pick: same height from a fresh page', R.pickSameOption(yt, `${yt.title} 720p.mp4`)?.height === 720);
  check('pick: audio only gets the audio option', R.pickSameOption(yt, `${yt.title}.m4a`)?.id === 'audio-140');
  check('pick: a height the page no longer has gives null', R.pickSameOption(yt, 'X 2160p.mp4') === null);
  check('pick: no height (Instagram) takes the only plain video', R.pickSameOption(ig, 'Reel.mp4')?.id === '2');
  check('pick: no height on a page of many qualities gives null', R.pickSameOption(yt, 'Clip.mp4') === null);
  const dl = (o) => ({ id: 'd1', state: 'needs_link', name: 'A 1080p.mp4', pageUrl: 'https://www.youtube.com/watch?v=1', error: { code: 'LINK_REFUSED' }, ...o });
  const t0 = 1_000_000_000;
  check('refresh: a refused YouTube download with no try yet', R.shouldRefresh(dl({}), undefined, t0));
  check('refresh: an expired link too', R.shouldRefresh(dl({ error: { code: 'LINK_EXPIRED' } }), undefined, t0));
  check('refresh: not within the hour', !R.shouldRefresh(dl({}), t0 - 30 * 60_000, t0) && R.shouldRefresh(dl({}), t0 - 61 * 60_000, t0));
  check('refresh: not for sign-in, other states, other sites or no page', !R.shouldRefresh(dl({ error: { code: 'AUTH_REQUIRED' } }), undefined, t0)
    && !R.shouldRefresh(dl({ state: 'error' }), undefined, t0) && !R.shouldRefresh(dl({ pageUrl: 'https://example.com/a' }), undefined, t0) && !R.shouldRefresh(dl({ pageUrl: null }), undefined, t0));
  const DC = await import('../utils/downloadCopy.ts');
  check('card: says Video sites need an update for a refused video-site download', DC.downloadStatus(dl({})).lead === 'Video sites need an update');
  check('card: the button is Update, then Paste new link', DC.downloadActions(dl({})).map((a) => a.label).join() === 'Update,Paste new link');
  check('card: other sites keep Paste new link', DC.downloadActions(dl({ pageUrl: 'https://example.com/a' })).map((a) => a.label).join() === 'Paste new link');

  // ---- yt-dlp stays current
  check('kotlin updates yt-dlp from the stable channel', /updateYoutubeDL\(context, YoutubeDL\.UpdateChannel\.STABLE\)/.test(kt));
  const resolveBody = kt.slice(kt.indexOf('fun resolve'), kt.indexOf('fun classify'));
  check('kotlin: resolve never updates or waits on an update', !/update|autoUpdate/i.test(resolveBody.replace(/\/\/.*$/gm, '')) && !kt.includes('shouldAutoUpdate'));
  check('kotlin: one update at a time', /synchronized\(updateLock\)/.test(kt) && kt.includes('last_check_ms'));
  const upd = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/videosites/VideoSitesUpdater.kt');
  check('kotlin: daily unique periodic work, unmetered unless mobile data is allowed, cancelled when off',
    /PeriodicWorkRequest\.Builder\(VideoSitesUpdateWorker::class\.java, 1, TimeUnit\.DAYS\)/.test(upd) && upd.includes('ExistingPeriodicWorkPolicy.KEEP') && /if \(mobileData\) NetworkType\.CONNECTED else NetworkType\.UNMETERED/.test(upd) && upd.includes('cancelUniqueWork(UNIQUE_PERIODIC)'));
  check('module exposes videoSitesStatus and videoSitesConfigure', mod.includes('AsyncFunction("videoSitesStatus")') && mod.includes('AsyncFunction("videoSitesConfigure")') && /public async videoSitesConfigure/.test(bridge));
  check('module exposes videoSitesUpdate off the main thread', /AsyncFunction\("videoSitesUpdate"\)[\s\S]*?EngineHost\.ioScope\.launch/.test(mod) && mod.includes('VideoSites.versionLabel'));
  check('bridge and mock expose videoSitesUpdate', /public async videoSitesUpdate/.test(bridge) && /videoSitesUpdate\(\)[\s\S]{0,200}status: 'current'/.test(mock) && read('modules/maglev-engine/src/MaglevEngine.types.ts').includes('videoSitesUpdate()'));
  check('refreshDownloadUrl passes options through', /refreshDownloadUrl = useCallback\(\(id: string, url: string, options: DownloadOptions = \{\}\) => maglevEngine\.refreshDownloadUrl\(id, url, options\)/.test(read('context/EngineContext.tsx')));
  const hook = read('components/transfers/useVideoSiteRefresh.ts');
  check('hook: read the page, same quality, new links with parts; update only when asked', hook.includes('if (updateFirst) await maglevEngine.videoSitesUpdate()') && hook.includes('pickSameOption') && hook.includes('partsOption(option)') && hook.includes('refreshDownloadUrl(d.id'));
  check('hook is mounted once, in the root layout', read('app/_layout.tsx').includes('useVideoSiteRefresh()') && !read('app/(tabs)/_layout.tsx').includes('useVideoSiteRefresh'));
  const dset = read('app/settings/downloads.tsx');
  const uset = read('app/settings/updates.tsx');
  const idx = read('utils/settingsIndex.ts');
  check('settings: Video sites moved from Downloads to Updates, after Lists', !dset.includes('Video sites') && !dset.includes('VideoSitesRow')
    && uset.indexOf('<SectionHeader title="Lists" />') < uset.indexOf('<VideoSitesSection />') && uset.includes('title="Video site reader"') && uset.includes('Keep video sites working') && uset.includes('Update on mobile data') && uset.includes('videoSitesUpdate()'));
  check('settings: prefs default on / off and reach native', /videoSitesAuto: true, videoSitesMobile: false/.test(read('utils/prefs/update.ts')) && hook.includes('videoSitesConfigure(videoSitesAuto, videoSitesMobile)'));
  check('settings rows are searchable', ['video-sites-auto', 'video-sites-mobile', 'video-sites-reader'].every((id) => idx.includes(`"${id}"`)));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nvideo sites: all checks passed');
})();
