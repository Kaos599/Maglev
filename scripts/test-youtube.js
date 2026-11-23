#!/usr/bin/env node
// YouTube link extraction, full-quality adaptive pairing, audio selection, and duration formatting tests.
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
  const yt = await import('../utils/youtube.ts');

  console.log('youtube urls');
  const valid = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=42', 'dQw4w9WgXcQ'],
    ['https://youtube.com/shorts/abcDEF_1234', 'abcDEF_1234'],
    ['https://m.youtube.com/live/xyz-9876543?feature=share', 'xyz-9876543'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD1', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ];
  for (const [url, id] of valid) {
    check(`extracts ${id} from ${url}`, yt.extractYouTubeId(url) === id && yt.isYouTubeUrl(url));
  }
  for (const bad of [
    '',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/channel/UC123',
    'https://www.youtube.com/watch?v=short',
    'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
  ]) {
    check(`rejects ${bad || '(empty)'}`, yt.extractYouTubeId(bad) === null && !yt.isYouTubeUrl(bad));
  }

  console.log('duration');
  check('formats 65s as 1:05', yt.formatYouTubeDuration(65) === '1:05');
  check('formats 3661s as 1:01:01', yt.formatYouTubeDuration(3661) === '1:01:01');
  check('formats 0s as empty', yt.formatYouTubeDuration(0) === '');

  console.log('qualities & original audio selection');
  const player = {
    videoDetails: { videoId: 'pnlQMuiWUoE', title: 'Test Short', lengthSeconds: '46' },
    streamingData: {
      adaptiveFormats: [
        // Auto-dubbed Arabic comes first; original English is audioIsDefault: true
        { itag: 140, url: 'https://cdn.example/ar.m4a', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, contentLength: '650000', audioTrack: { id: 'ar.10', audioIsDefault: false, isAutoDubbed: true } },
        { itag: 140, url: 'https://cdn.example/en.m4a', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 129000, contentLength: '652000', audioTrack: { id: 'en-US.4', audioIsDefault: true, isAutoDubbed: false } },
        // Full vertical Shorts ladder (width x height swapped)
        { itag: 401, url: 'https://cdn.example/2160.mp4', mimeType: 'video/mp4; codecs="av01.0.13M.08"', width: 2160, height: 3840, fps: 60, qualityLabel: '2160p60', contentLength: '26000000' },
        { itag: 299, url: 'https://cdn.example/1080avc.mp4', mimeType: 'video/mp4; codecs="avc1.64002A"', width: 1080, height: 1920, fps: 60, qualityLabel: '1080p60', contentLength: '9800000' },
        { itag: 399, url: 'https://cdn.example/1080av01.mp4', mimeType: 'video/mp4; codecs="av01.0.09M.08"', width: 1080, height: 1920, fps: 60, qualityLabel: '1080p60', contentLength: '4900000' },
        { itag: 298, url: 'https://cdn.example/720.mp4', mimeType: 'video/mp4; codecs="avc1.640020"', width: 720, height: 1280, fps: 60, qualityLabel: '720p60', contentLength: '5400000' },
        { itag: 135, url: 'https://cdn.example/480.mp4', mimeType: 'video/mp4; codecs="avc1.4D401F"', width: 480, height: 854, fps: 30, qualityLabel: '480p', contentLength: '2100000' },
      ],
    },
  };

  const qualities = yt.buildYouTubeQualities(player, null, 'TestUA');
  check('has 5 options (2160p60, 1080p60, 720p60, 480p, Audio only)', qualities.length === 5, String(qualities.length));
  check('2160p60 first (AV1)', qualities[0]?.label === '2160p60' && qualities[0]?.height === 2160 && qualities[0]?.streamSelection.kind === 'pair');
  check('1080p60 prefers avc1 over av01', qualities[1]?.label === '1080p60' && qualities[1]?.url === 'https://cdn.example/1080avc.mp4');
  check('pairs video with original (non-dubbed) audio', qualities[1]?.streamSelection.audioUrl === 'https://cdn.example/en.m4a');
  check('720p60 present', qualities[2]?.label === '720p60' && qualities[2]?.height === 720);
  check('480p present', qualities[3]?.label === '480p' && qualities[3]?.height === 480);
  check('Audio only uses original m4a pair single-track', qualities[4]?.label === 'Audio only' && qualities[4]?.ext === '.m4a' && qualities[4]?.streamSelection.videoUrl === 'https://cdn.example/en.m4a' && !qualities[4]?.streamSelection.audioUrl);
  check('default quality is 1080p60 (highest <= 1080p)', yt.defaultYouTubeQuality(qualities)?.id === qualities[1]?.id);

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nyoutube tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
