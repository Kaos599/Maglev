#!/usr/bin/env node
// YouTube link extraction, quality selection, and duration formatting tests.
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

  console.log('qualities');
  const player = {
    videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Test Video', lengthSeconds: '120' },
    streamingData: {
      hlsManifestUrl: 'https://manifest.example/index.m3u8',
      formats: [
        { itag: 18, url: 'https://cdn.example/360.mp4', mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', height: 360, qualityLabel: '360p', contentLength: '10485760' },
        { itag: 22, url: 'https://cdn.example/720.mp4', mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"', height: 720, qualityLabel: '720p', contentLength: '31457280' },
      ],
      adaptiveFormats: [
        { itag: 140, url: 'https://cdn.example/audio.m4a', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, contentLength: '1920000' },
        { itag: 251, url: 'https://cdn.example/audio.webm', mimeType: 'audio/webm; codecs="opus"', bitrate: 160000, contentLength: '2400000' },
      ],
    },
  };
  const hlsProbe = {
    kind: 'hls',
    title: 'Test Video',
    durationSec: 120,
    variants: [
      { id: 'v1080', height: 1080, width: 1920, bandwidth: 4_000_000, codecs: 'avc1.640028', estBytes: 60_000_000, audio: 'separate' },
      { id: 'v720', height: 720, width: 1280, bandwidth: 2_000_000, codecs: 'avc1.4d401f', estBytes: 30_000_000, audio: 'separate' },
      { id: 'v480', height: 480, width: 854, bandwidth: 1_000_000, codecs: 'avc1.4d401e', estBytes: 15_000_000, audio: 'separate' },
    ],
    audioTracks: [{ id: 'a0', lang: 'en', name: 'English', bandwidth: 128000 }],
  };

  const qualities = yt.buildYouTubeQualities(player, hlsProbe, 'TestUA');
  check('has 5 options (1080p, 720p, 480p, 360p, Audio only)', qualities.length === 5, String(qualities.length));
  check('sorted 1080p first', qualities[0]?.label === '1080p' && qualities[0]?.kind === 'hls');
  check('prefers direct 720p over HLS 720p', qualities[1]?.label === '720p' && qualities[1]?.kind === 'direct');
  check('includes 480p from HLS', qualities[2]?.label === '480p' && qualities[2]?.kind === 'hls');
  check('includes 360p direct', qualities[3]?.label === '360p' && qualities[3]?.kind === 'direct');
  check('prefers M4A for Audio only', qualities[4]?.label === 'Audio only' && qualities[4]?.ext === '.m4a');
  check('default quality is 1080p', yt.defaultYouTubeQuality(qualities)?.id === qualities[0]?.id);

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
