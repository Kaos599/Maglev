#!/usr/bin/env node
// Video sites (docs/NATIVE_CONTRACT.md section 48, prototype): host detection, the quality list built from saved
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

  // ---- X: plain MP4 files that already have sound
  const x = V.buildVideoSiteInfo(fixture('x'));
  check('x: two single files, tallest first', x.options.map((o) => `${o.height}:${o.id}`).join() === '360:http-832,180:http-256', x.options.map((o) => o.id));
  check('x: no second file', x.options.every((o) => o.audio === null));
  check('x: size is an estimate only (no exact size to range on)', x.options[0].video.size === null && x.options[0].estBytes === 11572912);
  check('x: HLS formats are skipped, no Audio only', !x.options.some((o) => o.id.startsWith('hls') || o.label.startsWith('Audio')));
  check('x: label', x.options[0].label === '360p · about 11.0 MB', x.options[0].label);

  // ---- Instagram: formats 0/1/2 are plain files; the dash-*v video-only ones have no audio partner and are skipped
  const ig = V.buildVideoSiteInfo(fixture('instagram'));
  check('instagram: one single-file option (no height known)', ig.options.length === 1 && ig.options[0].audio === null && ig.options[0].height === null, ig.options.map((o) => o.id));
  check('instagram: the best (last) plain file wins', ig.options[0].id === '2', ig.options[0].id);
  check('instagram: dash video-only files are never offered', !ig.options.some((o) => o.id.startsWith('dash')));
  check('instagram: label without a size', ig.options[0].label === 'Video');

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
  check('base name falls back to Video', V.suggestedBaseName({ ...ig, title: '' }, ig.options[0]) === 'Video');
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
  for (const code of Object.keys(M).filter((c) => c !== 'SITE_NO_VIDEO')) check(`kotlin has ${code}`, kt.includes(`"${code}"`));
  for (const code of ['SITE_NOT_SUPPORTED', 'SITE_NEEDS_LOGIN', 'SITE_FAILED', 'VIDEO_SITES_UNAVAILABLE']) {
    check(`kotlin message for ${code} matches the app copy`, kt.includes(JSON.stringify(M[code]).slice(1, -1)));
  }
  check('kotlin runs yt-dlp with --dump-single-json and --no-playlist', kt.includes('--dump-single-json') && kt.includes('--no-playlist'));
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
  const share = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/share/QuickShareActivity.kt');
  check('shared video-site page goes straight to the add sheet', /WEB_PAGE && isVideoSite\(host\(cls\.source\)\)\)[\s\S]{0,120}maglev:\/\/add-download\?url=/.test(share));
  check('share host list matches the app list', ['youtube.com', 'youtu.be', 'x.com', 'twitter.com', 'instagram.com', 'reddit.com', 'vimeo.com', 'tiktok.com'].every((h) => share.includes(`"${h}"`)));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nvideo sites: all checks passed');
})();
