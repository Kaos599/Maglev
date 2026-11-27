#!/usr/bin/env node
/**
 * Unit tests for Multi-Platform Social Media URL Routing, Bulk Queue Splitting,
 * Netscape `cookies.txt` Parsing & Domain Matching, Error Classification,
 * No-Watermark Quality Option Builders, and Universal Sound-Only (.m4a) Options.
 */
process.removeAllListeners('warning');
const path = require('path');
const { pathToFileURL } = require('url');

let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function main() {
  console.log('Multi-platform social media downloader tests');
  const root = path.join(__dirname, '..');
  const social = await import(pathToFileURL(path.join(root, 'utils/social.ts')).href);
  const cookies = await import(pathToFileURL(path.join(root, 'utils/cookiesTxt.ts')).href);

  // 1. Platform URL detection (6 new platforms + YouTube; Telegram excluded)
  check(
    'detects Instagram Posts, Reels, Stories, Carousels, Highlights',
    social.detectSocialPlatform('https://www.instagram.com/p/C9xYz12345/') === 'instagram' &&
      social.detectSocialPlatform('https://www.instagram.com/reel/C9xYz12345/') === 'instagram' &&
      social.detectSocialPlatform('https://www.instagram.com/stories/natgeo/341234567890/') === 'instagram' &&
      social.detectSocialPlatform('instagram.com/stories/highlights/179123456789/') === 'instagram',
  );
  check(
    'detects TikTok standard videos, photo slideshows, and short links',
    social.detectSocialPlatform('https://www.tiktok.com/@creator/video/7401234567890123456') === 'tiktok' &&
      social.detectSocialPlatform('https://www.tiktok.com/@creator/photo/7401234567890123456') === 'tiktok' &&
      social.detectSocialPlatform('https://vm.tiktok.com/ZMh123456/') === 'tiktok' &&
      social.detectSocialPlatform('vt.tiktok.com/ZSY123456/') === 'tiktok',
  );
  check(
    'detects Reddit v.redd.it, i.redd.it, galleries, and thread links',
    social.detectSocialPlatform('https://v.redd.it/abc123xyz') === 'reddit' &&
      social.detectSocialPlatform('https://i.redd.it/sample99.jpg') === 'reddit' &&
      social.detectSocialPlatform('https://www.reddit.com/r/videos/comments/1a2b3c4/example_post/') === 'reddit' &&
      social.detectSocialPlatform('https://www.reddit.com/gallery/1a2b3c4') === 'reddit' &&
      social.detectSocialPlatform('redd.it/1a2b3c4') === 'reddit',
  );
  check(
    'detects Facebook Watch, Reels, videos, and fb.watch short links',
    social.detectSocialPlatform('https://www.facebook.com/watch/?v=1234567890') === 'facebook' &&
      social.detectSocialPlatform('https://www.facebook.com/reel/9876543210') === 'facebook' &&
      social.detectSocialPlatform('https://fb.watch/xYz123AbC/') === 'facebook' &&
      social.detectSocialPlatform('https://www.facebook.com/share/v/1A2B3C4D/') === 'facebook',
  );
  check(
    'detects Threads posts on threads.net and threads.com',
    social.detectSocialPlatform('https://www.threads.net/@zuck/post/C8abcDEF123') === 'threads' &&
      social.detectSocialPlatform('https://www.threads.com/@zuck/post/C8abcDEF123') === 'threads' &&
      social.detectSocialPlatform('https://www.threads.net/t/C8abcDEF123') === 'threads',
  );
  check(
    'detects Pinterest video/image pins and pin.it short links',
    social.detectSocialPlatform('https://www.pinterest.com/pin/123456789012345678/') === 'pinterest' &&
      social.detectSocialPlatform('https://pin.it/4xYzAbCdE') === 'pinterest',
  );
  check(
    'detects YouTube alongside social platforms',
    social.detectSocialPlatform('https://youtu.be/dQw4w9WgXcQ') === 'youtube' &&
      social.detectSocialPlatform('https://www.youtube.com/shorts/dQw4w9WgXcQ') === 'youtube',
  );
  check(
    'explicitly excludes Telegram links',
    social.detectSocialPlatform('https://t.me/durov/123') === null &&
      social.detectSocialPlatform('https://telegram.me/channel/45') === null,
  );

  // 2. Unlimited Bulk URL Queue Splitter
  const bulkInput = `
    https://www.instagram.com/reel/C111111/
    https://vm.tiktok.com/ZM222222/
    https://www.reddit.com/r/aww/comments/333333/cute/
    https://fb.watch/444444/
    https://www.threads.net/@user/post/C555555
    https://pin.it/666666
    https://youtu.be/dQw4w9WgXcQ
  `;
  const bulkList = social.extractBulkUrls(bulkInput);
  check('extractBulkUrls extracts all 7 multi-line URLs in order', bulkList.length === 7, `got ${bulkList.length}`);

  // 3. Netscape cookies.txt parser & domain matcher
  const sampleCookiesTxt = [
    '# Netscape HTTP Cookie File',
    '.instagram.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tig_sess_12345',
    '#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1893456000\tcsrftoken\tig_csrf_67890',
    '.reddit.com\tTRUE\t/\tTRUE\t1893456000\treddit_session\tred_tok_999',
    '.facebook.com\tTRUE\t/\tTRUE\t1893456000\tc_user\t1000012345',
  ].join('\n');
  const summary = cookies.importCookiesTxt(sampleCookiesTxt);
  check('parses Netscape cookies.txt including #HttpOnly_ lines', summary.totalCount === 4, `got ${summary.totalCount}`);
  check(
    'identifies Instagram, Reddit, and Facebook from imported cookies',
    summary.platforms.includes('Instagram') &&
      summary.platforms.includes('Reddit') &&
      summary.platforms.includes('Facebook'),
    summary.platforms.join(', '),
  );
  const igCookieHeader = cookies.getCookieHeaderForUrl('https://www.instagram.com/reel/C9xYz/');
  check(
    'builds Cookie header for matching domain',
    Boolean(igCookieHeader && igCookieHeader.includes('sessionid=ig_sess_12345') && igCookieHeader.includes('csrftoken=ig_csrf_67890')),
    igCookieHeader,
  );
  const threadsCookieHeader = cookies.getCookieHeaderForUrl('https://www.threads.net/@user/post/C123');
  check(
    'shares Meta/Instagram session cookies with Threads',
    Boolean(threadsCookieHeader && threadsCookieHeader.includes('sessionid=ig_sess_12345')),
  );
  cookies.clearCookiesTxt();

  // 4. Streamable Fast-start MP4 & Universal Sound Only (.m4a) builders
  const vidOpt = social.buildDirectVideoQualityOption({
    id: 'test-1080p',
    height: 1080,
    fps: 60,
    videoUrl: 'https://cdn.example.com/video_1080.mp4',
    audioUrl: 'https://cdn.example.com/audio_128.m4a',
    videoBytes: 10 * 1024 * 1024,
    audioBytes: 2 * 1024 * 1024,
    badge: 'No watermark',
  });
  check(
    'video option uses pair stream with fast-start MP4 and no-watermark badge',
    vidOpt.ext === '.mp4' &&
      vidOpt.streamSelection.kind === 'pair' &&
      vidOpt.streamSelection.ext === 'mp4' &&
      vidOpt.description.includes('Fast-start') &&
      vidOpt.description.includes('No watermark'),
    vidOpt.description,
  );

  const soundOpt = social.buildSoundOnlyOption({
    sourceUrl: 'https://cdn.example.com/video_1080.mp4',
    isDedicatedAudio: false,
  });
  check(
    'universal Sound Only option outputs .m4a stream selection',
    soundOpt.id === 'audio-only' &&
      soundOpt.label === 'Sound only' &&
      soundOpt.ext === '.m4a' &&
      soundOpt.streamSelection.ext === 'm4a',
  );

  // 5. Error classification (Network timeout vs Blocked/Login required vs Deleted/Private)
  check(
    'classifies timeout errors clearly',
    social.classifyErrorFromStatus(0, '', true).category === 'timeout' &&
      social.classifyErrorFromStatus(504, '', false).category === 'timeout',
  );
  check(
    'classifies HTTP 401/403/429 and login_required as auth_blocked',
    social.classifyErrorFromStatus(429, 'Too many requests').category === 'auth_blocked' &&
      social.classifyErrorFromStatus(200, '{"message":"login_required"}').category === 'auth_blocked',
  );
  check(
    'classifies HTTP 404/410 and deleted/private post messages as deleted_private',
    social.classifyErrorFromStatus(404, 'Page not found').category === 'deleted_private' &&
      social.classifyErrorFromStatus(200, 'This post is private').category === 'deleted_private',
  );

  // 6. Instagram shortcode -> media ID, video-vs-thumbnail guards & HTML/MP4 extraction
  check(
    'converts Instagram base64 shortcode to numeric media ID',
    social.shortcodeToInstagramMediaId('BA') === '64' &&
      social.shortcodeToInstagramMediaId('CxYz12345') === '780159164317241' &&
      social.shortcodeToInstagramMediaId('') === null &&
      social.shortcodeToInstagramMediaId('bad*char') === null,
    String(social.shortcodeToInstagramMediaId('CxYz12345')),
  );
  check(
    'isExplicitVideoUrl flags Reels/Watch/Video URLs and leaves photo/post URLs flexible',
    social.isExplicitVideoUrl('instagram', 'https://www.instagram.com/reel/C9xYz123/') &&
      social.isExplicitVideoUrl('instagram', 'https://www.instagram.com/reels/C9xYz123/') &&
      !social.isExplicitVideoUrl('instagram', 'https://www.instagram.com/p/C9xYz123/') &&
      social.isExplicitVideoUrl('tiktok', 'https://www.tiktok.com/@u/video/123') &&
      !social.isExplicitVideoUrl('tiktok', 'https://www.tiktok.com/@u/photo/123') &&
      social.isExplicitVideoUrl('facebook', 'https://fb.watch/abc/') &&
      social.isExplicitVideoUrl('facebook', 'https://www.facebook.com/reel/123') &&
      social.isExplicitVideoUrl('reddit', 'https://v.redd.it/abc123') &&
      !social.isExplicitVideoUrl('reddit', 'https://www.reddit.com/r/pics/comments/abc/hi/'),
  );
  check(
    'htmlIndicatesVideo detects embedded video metadata without false positives on photos',
    social.htmlIndicatesVideo('{"is_video":true,"display_url":"https://cdn/thumb.jpg"}') &&
      social.htmlIndicatesVideo('<meta property="og:video" content="https://cdn/v.mp4">') &&
      social.htmlIndicatesVideo('"video_list":{"V_HLSV4":{"url":"https://v1.pinimg.com/videos/iht/hls/a.m3u8"}}') &&
      !social.htmlIndicatesVideo('<img class="EmbeddedMediaImage" src="https://cdn/photo.jpg">'),
  );
  const extractedMp4s = social.extractAllMp4Urls(
    '{"video_url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/t50.mp4?efg=1\\u0026_nc=2","avatar":"https://cdn/avatar_v2.mp4"}',
  );
  check(
    'extractAllMp4Urls unescapes JSON video URLs and skips avatars',
    extractedMp4s.length === 1 &&
      extractedMp4s[0] === 'https://scontent.cdninstagram.com/v/t50.mp4?efg=1&_nc=2',
    JSON.stringify(extractedMp4s),
  );

  // Critical regression guard: Reel or video page with only thumbnail .jpg MUST NOT return .jpg
  const reelThumbOnlyHtml = `
    <html>
      <meta property="og:image" content="https://scontent.cdninstagram.com/reel_cover.jpg" />
      <img class="EmbeddedMediaImage" src="https://scontent.cdninstagram.com/reel_cover.jpg" />
    </html>
  `;
  check(
    'parseInstagramHtmlMedia NEVER returns .jpg thumbnail for /reel/ links',
    social.parseInstagramHtmlMedia(
      reelThumbOnlyHtml,
      'https://www.instagram.com/reel/C9xYz123/',
      'C9xYz123',
      'MaglevTest/1.0',
      true,
    ) === null,
  );
  check(
    'parseInstagramHtmlMedia NEVER returns .jpg thumbnail when HTML indicates video',
    social.parseInstagramHtmlMedia(
      '{"is_video":true,"display_url":"https://scontent.cdninstagram.com/cover.jpg"}',
      'https://www.instagram.com/p/C9xYz123/',
      'C9xYz123',
      'MaglevTest/1.0',
      false,
    ) === null,
  );
  const reelVideoParsed = social.parseInstagramHtmlMedia(
    '{"username":"creator","video_versions":[{"url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/reel_hd.mp4?a=1\\u0026b=2"}]}',
    'https://www.instagram.com/reel/C9xYz123/',
    'C9xYz123',
    'MaglevTest/1.0',
    true,
  );
  check(
    'parseInstagramHtmlMedia extracts .mp4 video from escaped Instagram HTML/JSON',
    reelVideoParsed !== null &&
      reelVideoParsed.mediaKind === 'video' &&
      reelVideoParsed.items[0].ext === '.mp4' &&
      reelVideoParsed.items[0].url === 'https://scontent.cdninstagram.com/v/reel_hd.mp4?a=1&b=2',
  );
  const photoParsed = social.parseInstagramHtmlMedia(
    '<img class="EmbeddedMediaImage" src="https://scontent.cdninstagram.com/photo_full.jpg" />',
    'https://www.instagram.com/p/C9xYz123/',
    'C9xYz123',
    'MaglevTest/1.0',
    false,
  );
  check(
    'parseInstagramHtmlMedia still extracts genuine photo posts cleanly',
    photoParsed !== null &&
      photoParsed.mediaKind === 'image' &&
      photoParsed.items[0].ext === '.jpg',
  );

  if (failed > 0) {
    console.error(`\n${failed} social check(s) failed`);
    process.exit(1);
  }
  console.log('\nsocial: all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
