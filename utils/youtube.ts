/**
 * YouTube link detection, InnerTube player extraction, and full-quality selection.
 * Uses chunked 8x parallel `pair` streams (Video + Audio muxed natively via StreamMuxer)
 * so every quality (144p up to 2160p 4K + Audio only) downloads at full network speed.
 * Pure TypeScript (no react-native imports) so it can be unit-tested directly with Node.
 */
import type {
  EngineResult,
  StreamProbe,
  StreamSelection,
} from '../modules/maglev-engine/src/MaglevEngine.types.ts';
import { formatBytes } from '../constants/format.ts';

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/** Normalizes bare YouTube links (e.g. "youtube.com/watch?v=...") to https://... */
export function normalizeYouTubeUrl(raw: string): string {
  const input = (raw ?? '').trim();
  if (!input) return input;
  if (/^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(input)) {
    return `https://${input}`;
  }
  return input;
}

/** Extracts the 11-character YouTube video ID from any standard YouTube URL, or null. */
export function extractYouTubeId(raw: string): string | null {
  const input = normalizeYouTubeUrl(raw);
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const seg = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return YT_ID_RE.test(seg) ? seg : null;
  }

  if (!YT_HOSTS.has(host)) return null;

  const v = url.searchParams.get('v');
  if (v && YT_ID_RE.test(v)) return v;

  if (url.pathname === '/attribution_link') {
    const u = url.searchParams.get('u');
    if (u) {
      const nested = extractYouTubeId(`https://www.youtube.com${u.startsWith('/') ? u : `/${u}`}`);
      if (nested) return nested;
    }
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed' || parts[0] === 'v')) {
    return YT_ID_RE.test(parts[1]) ? parts[1] : null;
  }

  return null;
}

/** True when `raw` is a supported YouTube video, Shorts, Live, or Music link. */
export function isYouTubeUrl(raw: string): boolean {
  return extractYouTubeId(raw) !== null;
}

export interface YouTubeAudioTrackMeta {
  displayName?: string;
  id?: string;
  audioIsDefault?: boolean;
  isAutoDubbed?: boolean;
}

export interface YouTubeRawFormat {
  itag?: number;
  url?: string;
  mimeType?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  fps?: number;
  contentLength?: string;
  qualityLabel?: string;
  audioQuality?: string;
  audioTrack?: YouTubeAudioTrackMeta;
}

export interface YouTubePlayerResponse {
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
    isLiveContent?: boolean;
  };
  streamingData?: {
    hlsManifestUrl?: string;
    formats?: YouTubeRawFormat[];
    adaptiveFormats?: YouTubeRawFormat[];
  };
}

export interface YouTubeQualityOption {
  id: string;
  label: string;
  description: string;
  ext: string;
  height: number | null;
  estBytes: number | null;
  kind: 'pair' | 'direct' | 'audio';
  url: string;
  userAgent?: string;
  streamSelection: StreamSelection;
  icon: 'play' | 'file';
}

export interface YouTubeProbeResult {
  ok: true;
  videoId: string;
  title: string;
  author: string;
  durationSecs: number;
  qualities: YouTubeQualityOption[];
}

export interface YouTubeProbeError {
  ok: false;
  message: string;
}

interface InnerTubeClient {
  name: string;
  userAgent: string;
  context: Record<string, unknown>;
}

// ANDROID first: returns full adaptiveFormats (144p..2160p + original M4A audio) for both
// regular videos and Shorts, and supports fast parallel &range= downloads at full network speed.
const INNERTUBE_CLIENTS: readonly InnerTubeClient[] = [
  {
    name: 'ANDROID',
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        androidSdkVersion: 34,
        osName: 'Android',
        osVersion: '14',
        hl: 'en',
        gl: 'US',
      },
    },
  },
  {
    name: 'ANDROID_VR',
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    context: {
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.60.19',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        androidSdkVersion: 32,
        osName: 'Android',
        osVersion: '12L',
        hl: 'en',
        gl: 'US',
      },
    },
  },
  {
    name: 'IOS',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_1 like Mac OS X;)',
    context: {
      client: {
        clientName: 'IOS',
        clientVersion: '20.10.4',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '18.3.1',
        hl: 'en',
        gl: 'US',
      },
    },
  },
  {
    name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    userAgent: 'Mozilla/5.0 (compatible; Maglev/1.0)',
    context: {
      client: {
        clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
        clientVersion: '2.0',
        hl: 'en',
        gl: 'US',
      },
      thirdParty: {
        embedUrl: 'https://www.youtube.com/',
      },
    },
  },
];

function parseBytes(raw?: string): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function estimateBytes(bitrate: number | undefined, durationSecs: number): number | null {
  if (!bitrate || bitrate <= 0 || !durationSecs || durationSecs <= 0) return null;
  return Math.round((bitrate / 8) * durationSecs);
}

function extFromMime(mime?: string, fallback = '.mp4'): string {
  const lower = (mime ?? '').toLowerCase();
  if (lower.includes('audio/mp4') || lower.includes('mp4a')) return '.m4a';
  if (lower.includes('audio/webm')) return '.webm';
  if (lower.includes('video/webm')) return '.webm';
  if (lower.includes('video/mp4')) return '.mp4';
  return fallback;
}

/** Formats seconds into m:ss or h:mm:ss for display. */
export function formatYouTubeDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(rem).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Picks the original/default M4A audio track (never an auto-dubbed track when default exists). */
export function pickDefaultAudio(adaptive: readonly YouTubeRawFormat[]): YouTubeRawFormat | null {
  const audios = adaptive.filter((f) => !!f.url && (f.mimeType ?? '').toLowerCase().startsWith('audio/'));
  if (audios.length === 0) return null;

  const score = (f: YouTubeRawFormat): number => {
    const mime = (f.mimeType ?? '').toLowerCase();
    const isM4a = mime.includes('audio/mp4') || mime.includes('mp4a') ? 1_000_000 : 0;
    const isDefault = f.audioTrack?.audioIsDefault ? 500_000 : 0;
    const notDubbed = f.audioTrack?.isAutoDubbed ? 0 : 250_000;
    const noTrackMeta = !f.audioTrack ? 200_000 : 0;
    const bitrate = Math.min(f.bitrate ?? 0, 199_999);
    return isM4a + isDefault + notDubbed + noTrackMeta + bitrate;
  };

  return [...audios].sort((a, b) => score(b) - score(a))[0] ?? null;
}

function qualityResolution(f: YouTubeRawFormat): number | null {
  if (typeof f.height === 'number' && f.height > 0 && typeof f.width === 'number' && f.width > 0) {
    // Shorts are vertical (e.g. 1080x1920): the standard quality tier is min(width, height).
    return Math.min(f.width, f.height);
  }
  if (typeof f.height === 'number' && f.height > 0) return f.height;
  return null;
}

/**
 * Builds deduplicated, highest-first quality options from a YouTube player response.
 * Every option uses Rust's `pair` stream engine (8x parallel `&range=` chunks + zero-re-encode MP4 muxing)
 * so all qualities (4K/2K/1080p/720p/480p/360p/240p/144p + Audio only) download at full network speed.
 */
export function buildYouTubeQualities(
  player: YouTubePlayerResponse,
  _hlsProbe: StreamProbe | null,
  userAgent: string,
): YouTubeQualityOption[] {
  const durationSecs = Number(player.videoDetails?.lengthSeconds ?? 0) || 0;
  const adaptive = player.streamingData?.adaptiveFormats ?? [];
  const formats = player.streamingData?.formats ?? [];

  const bestAudio = pickDefaultAudio(adaptive);
  const audioBytes = bestAudio
    ? (parseBytes(bestAudio.contentLength) ?? estimateBytes(bestAudio.bitrate, durationSecs) ?? 0)
    : 0;
  const isM4aAudio = !!bestAudio && (bestAudio.mimeType ?? '').toLowerCase().includes('audio/mp4');

  // 1. Adaptive MP4 video tracks paired with original M4A audio (full quality ladder: 144p..2160p).
  // Prefer H.264 (avc1) for universal Android MediaMuxer/player compatibility; allow AV1 (av01) for 1440p/2160p.
  const byTier = new Map<number, { format: YouTubeRawFormat; isAvc: boolean; fps: number; bytes: number }>();
  if (bestAudio && isM4aAudio) {
    for (const f of adaptive) {
      if (!f.url) continue;
      const mime = (f.mimeType ?? '').toLowerCase();
      if (!mime.startsWith('video/mp4')) continue;
      const isAvc = mime.includes('avc1');
      const isAv01 = mime.includes('av01');
      if (!isAvc && !isAv01) continue;
      const tier = qualityResolution(f);
      if (!tier) continue;
      const bytes = parseBytes(f.contentLength) ?? estimateBytes(f.bitrate, durationSecs) ?? 0;
      const fps = f.fps ?? 30;
      const prev = byTier.get(tier);
      if (!prev) {
        byTier.set(tier, { format: f, isAvc, fps, bytes });
      } else if (isAvc && !prev.isAvc) {
        // Always prefer H.264 over AV1 at the same resolution for instant playback everywhere.
        byTier.set(tier, { format: f, isAvc, fps, bytes });
      } else if (isAvc === prev.isAvc && (fps > prev.fps || (fps === prev.fps && (f.bitrate ?? 0) > (prev.format.bitrate ?? 0)))) {
        byTier.set(tier, { format: f, isAvc, fps, bytes });
      }
    }
  }

  const videoOptions: YouTubeQualityOption[] = [];
  for (const [tier, entry] of [...byTier.entries()].sort((a, b) => b[0] - a[0])) {
    const f = entry.format;
    const totalBytes = entry.bytes > 0 ? entry.bytes + audioBytes : null;
    const label = f.qualityLabel?.trim() || `${tier}p${entry.fps > 30 ? entry.fps : ''}`;
    const codecTag = entry.isAvc ? 'MP4' : 'MP4 · AV1';
    const sizePart = totalBytes ? formatBytes(totalBytes) : 'HD';
    const variantId = `yt-${f.itag ?? tier}`;
    videoOptions.push({
      id: variantId,
      label,
      description: `${codecTag} · ${sizePart}`,
      ext: '.mp4',
      height: tier,
      estBytes: totalBytes,
      kind: 'pair',
      url: f.url!,
      userAgent,
      streamSelection: {
        kind: 'pair',
        variantId,
        audioId: String(bestAudio!.itag ?? 'audio'),
        videoUrl: f.url!,
        audioUrl: bestAudio!.url!,
        videoBytes: entry.bytes,
        audioBytes,
        height: tier,
        ext: 'mp4',
      },
      icon: 'file',
    });
  }

  // 2. Fallback: direct muxed formats if adaptive pairing produced no video tracks.
  if (videoOptions.length === 0) {
    for (const f of formats) {
      if (!f.url) continue;
      const tier = qualityResolution(f);
      const ext = extFromMime(f.mimeType, '.mp4');
      const bytes = parseBytes(f.contentLength) ?? estimateBytes(f.bitrate, durationSecs) ?? 0;
      const label = f.qualityLabel?.trim() || (tier ? `${tier}p` : 'Standard');
      const variantId = `yt-direct-${f.itag ?? label}`;
      videoOptions.push({
        id: variantId,
        label,
        description: `${ext.slice(1).toUpperCase()} · ${bytes > 0 ? formatBytes(bytes) : 'Direct'}`,
        ext,
        height: tier,
        estBytes: bytes > 0 ? bytes : null,
        kind: 'direct',
        url: f.url,
        userAgent,
        streamSelection: {
          kind: 'pair',
          variantId,
          videoUrl: f.url,
          videoBytes: bytes,
          height: tier,
          ext: ext.slice(1),
        },
        icon: 'file',
      });
    }
    videoOptions.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  }

  const result: YouTubeQualityOption[] = [...videoOptions];

  // 3. Audio only (original/default M4A or WebM, downloaded via fast chunked pair single-track).
  if (bestAudio) {
    const ext = extFromMime(bestAudio.mimeType, '.m4a');
    const kbps = bestAudio.bitrate ? `${Math.round(bestAudio.bitrate / 1000)} kbps` : '';
    const descParts = [ext.slice(1).toUpperCase(), kbps, audioBytes > 0 ? formatBytes(audioBytes) : ''].filter(Boolean);
    const variantId = `yt-audio-${bestAudio.itag ?? 'best'}`;
    result.push({
      id: variantId,
      label: 'Audio only',
      description: descParts.join(' · '),
      ext,
      height: null,
      estBytes: audioBytes > 0 ? audioBytes : null,
      kind: 'audio',
      url: bestAudio.url!,
      userAgent,
      streamSelection: {
        kind: 'pair',
        variantId,
        videoUrl: bestAudio.url!,
        videoBytes: audioBytes,
        height: null,
        ext: ext.slice(1),
      },
      icon: 'play',
    });
  }

  return result;
}

/** Picks the best default quality: highest video up to 1080p, or first available option. */
export function defaultYouTubeQuality(options: readonly YouTubeQualityOption[]): YouTubeQualityOption | null {
  if (options.length === 0) return null;
  const video = options.filter((o) => o.kind !== 'audio');
  const capped = video.find((o) => o.height != null && o.height <= 1080);
  return capped ?? video[0] ?? options[0];
}

export type ProbeStreamFn = (
  url: string,
  options?: { headers?: { 'User-Agent'?: string } },
) => Promise<EngineResult<StreamProbe>>;

/**
 * Fetches YouTube video metadata and full downloadable quality ladder via InnerTube.
 */
export async function probeYouTube(
  rawUrl: string,
  _probeStream?: ProbeStreamFn,
  signal?: AbortSignal,
): Promise<YouTubeProbeResult | YouTubeProbeError> {
  const videoId = extractYouTubeId(rawUrl);
  if (!videoId) {
    return { ok: false, message: "That doesn't look like a YouTube video link." };
  }

  let lastReason = "Couldn't load this YouTube video. Try again.";

  for (const client of INNERTUBE_CLIENTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });

      let res: Response;
      try {
        res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': client.userAgent,
          },
          body: JSON.stringify({
            videoId,
            context: client.context,
            contentCheckOk: true,
            racyCheckOk: true,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }

      if (signal?.aborted) {
        return { ok: false, message: 'Cancelled.' };
      }

      if (!res.ok) {
        lastReason = `YouTube returned HTTP ${res.status}.`;
        continue;
      }

      const data = (await res.json()) as YouTubePlayerResponse;
      const status = data.playabilityStatus?.status;
      if (status && status !== 'OK') {
        lastReason = data.playabilityStatus?.reason || 'This video is unavailable.';
        continue;
      }

      const qualities = buildYouTubeQualities(data, null, client.userAgent);
      if (qualities.length === 0) {
        lastReason = 'No downloadable qualities found for this video.';
        continue;
      }

      // If this client only gave audio-only (no video), try the next client before settling.
      const hasVideo = qualities.some((q) => q.kind !== 'audio');
      if (!hasVideo && client !== INNERTUBE_CLIENTS[INNERTUBE_CLIENTS.length - 1]) {
        continue;
      }

      return {
        ok: true,
        videoId,
        title: (data.videoDetails?.title || `youtube_${videoId}`).trim(),
        author: (data.videoDetails?.author || '').trim(),
        durationSecs: Number(data.videoDetails?.lengthSeconds ?? 0) || 0,
        qualities,
      };
    } catch (err) {
      if (signal?.aborted) {
        return { ok: false, message: 'Cancelled.' };
      }
      lastReason = err instanceof Error && err.name === 'AbortError'
        ? 'YouTube took too long to respond. Try again.'
        : "Couldn't reach YouTube. Check your connection and try again.";
    }
  }

  return { ok: false, message: lastReason };
}
