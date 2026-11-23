/**
 * YouTube link detection, InnerTube player extraction, and quality selection.
 * Pure TypeScript (no react-native imports) so it can be unit-tested directly with Node.
 */
import type {
  EngineResult,
  StreamProbe,
  StreamSelection,
  StreamVariant,
} from '../modules/maglev-engine/src/MaglevEngine.types.ts';
import { formatBytes } from '../constants/format.ts';
import { buildSelection, defaultAudio, qualityName } from '../components/browser/streamChoice.ts';

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/** Extracts the 11-character YouTube video ID from any standard YouTube URL, or null. */
export function extractYouTubeId(raw: string): string | null {
  const input = (raw ?? '').trim();
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
  kind: 'direct' | 'hls' | 'audio';
  url: string;
  userAgent?: string;
  streamSelection?: StreamSelection;
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

const INNERTUBE_CLIENTS: readonly InnerTubeClient[] = [
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

/**
 * Builds deduplicated, sorted quality options from a YouTube player response
 * plus an optional HLS StreamProbe. Direct MP4s are preferred over HLS at the same
 * resolution because multi-part HTTP downloads are faster and support pause/resume.
 */
export function buildYouTubeQualities(
  player: YouTubePlayerResponse,
  hlsProbe: StreamProbe | null,
  userAgent: string,
): YouTubeQualityOption[] {
  const durationSecs = Number(player.videoDetails?.lengthSeconds ?? 0) || 0;
  const hlsUrl = player.streamingData?.hlsManifestUrl ?? '';
  const byHeight = new Map<number, YouTubeQualityOption>();
  const extraVideo: YouTubeQualityOption[] = [];

  // 1. Direct muxed formats (video + audio in one file, supports 8-part fast download).
  for (const f of player.streamingData?.formats ?? []) {
    if (!f.url) continue;
    const height = typeof f.height === 'number' && f.height > 0 ? f.height : null;
    const ext = extFromMime(f.mimeType, '.mp4');
    const bytes = parseBytes(f.contentLength) ?? estimateBytes(f.bitrate, durationSecs);
    const label = f.qualityLabel?.trim() || (height ? `${height}p` : 'Standard');
    const sizePart = bytes ? formatBytes(bytes) : 'Fast direct';
    const fpsPart = f.fps && f.fps > 30 ? ` · ${f.fps}fps` : '';
    const opt: YouTubeQualityOption = {
      id: `yt-direct-${f.itag ?? label}`,
      label,
      description: `${ext.slice(1).toUpperCase()}${fpsPart} · ${sizePart}`,
      ext,
      height,
      estBytes: bytes,
      kind: 'direct',
      url: f.url,
      userAgent,
      icon: 'file',
    };
    if (height != null) {
      const prev = byHeight.get(height);
      if (!prev || (bytes ?? 0) > (prev.estBytes ?? 0)) byHeight.set(height, opt);
    } else {
      extraVideo.push(opt);
    }
  }

  // 2. HLS variants (covers 1080p, 1440p, 2160p, 480p, etc. via native StreamMuxer).
  if (hlsProbe && hlsUrl) {
    const audioId = defaultAudio(hlsProbe.audioTracks);
    const seenHlsHeights = new Set<number>();
    const variants: StreamVariant[] = hlsProbe.variants;
    for (const v of variants) {
      if (v.height == null || v.height <= 0) continue;
      if (byHeight.has(v.height) || seenHlsHeights.has(v.height)) continue;
      seenHlsHeights.add(v.height);
      const label = qualityName(v, variants);
      const bytes = v.estBytes && v.estBytes > 0 ? v.estBytes : null;
      const desc = bytes ? `MP4 · about ${formatBytes(bytes)}` : `MP4 · ${(v.bandwidth / 1_000_000).toFixed(1)} Mbps`;
      byHeight.set(v.height, {
        id: `yt-hls-${v.id}`,
        label,
        description: desc,
        ext: '.mp4',
        height: v.height,
        estBytes: bytes,
        kind: 'hls',
        url: hlsUrl,
        userAgent,
        streamSelection: buildSelection(hlsProbe.kind, hlsProbe, v, audioId),
        icon: 'file',
      });
    }
  }

  const videoOptions = [...byHeight.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  const result: YouTubeQualityOption[] = [...videoOptions, ...extraVideo];

  // 3. Best audio-only stream (M4A preferred, fast direct download).
  const audioFormats = (player.streamingData?.adaptiveFormats ?? []).filter(
    (f) => !!f.url && (f.mimeType ?? '').toLowerCase().startsWith('audio/'),
  );
  if (audioFormats.length > 0) {
    audioFormats.sort((a, b) => {
      const aM4a = (a.mimeType ?? '').toLowerCase().includes('audio/mp4') ? 1 : 0;
      const bM4a = (b.mimeType ?? '').toLowerCase().includes('audio/mp4') ? 1 : 0;
      if (aM4a !== bM4a) return bM4a - aM4a;
      return (b.bitrate ?? 0) - (a.bitrate ?? 0);
    });
    const bestAudio = audioFormats[0];
    const ext = extFromMime(bestAudio.mimeType, '.m4a');
    const bytes = parseBytes(bestAudio.contentLength) ?? estimateBytes(bestAudio.bitrate, durationSecs);
    const kbps = bestAudio.bitrate ? `${Math.round(bestAudio.bitrate / 1000)} kbps` : '';
    const descParts = [ext.slice(1).toUpperCase(), kbps, bytes ? formatBytes(bytes) : ''].filter(Boolean);
    result.push({
      id: `yt-audio-${bestAudio.itag ?? 'best'}`,
      label: 'Audio only',
      description: descParts.join(' · '),
      ext,
      height: null,
      estBytes: bytes,
      kind: 'audio',
      url: bestAudio.url!,
      userAgent,
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
 * Fetches YouTube video metadata and downloadable qualities via InnerTube.
 * Pass `probeStream` from EngineContext so HD HLS qualities can also be offered.
 */
export async function probeYouTube(
  rawUrl: string,
  probeStream?: ProbeStreamFn,
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

      const hasDirect = (data.streamingData?.formats ?? []).some((f) => !!f.url);
      const hasAudio = (data.streamingData?.adaptiveFormats ?? []).some((f) => !!f.url);
      const hlsUrl = data.streamingData?.hlsManifestUrl;
      if (!hasDirect && !hasAudio && !hlsUrl) {
        lastReason = 'No downloadable streams found for this video.';
        continue;
      }

      let hlsProbe: StreamProbe | null = null;
      if (hlsUrl && probeStream) {
        const sp = await probeStream(hlsUrl, { headers: { 'User-Agent': client.userAgent } });
        if (sp.ok) hlsProbe = sp;
      }

      const qualities = buildYouTubeQualities(data, hlsProbe, client.userAgent);
      if (qualities.length === 0) {
        lastReason = 'No downloadable qualities found for this video.';
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
