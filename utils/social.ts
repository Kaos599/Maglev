/**
 * Multi-platform Social Media & Video URL Router, Anti-Block Fetcher, Bulk Queue
 * Splitter, and Metadata/Stream Extractors (Instagram, TikTok, Reddit, Facebook,
 * Threads, Pinterest + YouTube).
 *
 * Pure TypeScript (no react-native imports) so it can be unit-tested directly in Node.
 */

import type {
  StreamProbe,
  StreamSelection,
  StreamSubtitle,
} from '../modules/maglev-engine/src/MaglevEngine.types.ts';
import { formatBytes } from '../constants/format.ts';
import { getCookieHeaderForUrl, getHostCookiesForUrl } from './cookiesTxt.ts';
import {
  isYouTubeUrl,
  normalizeYouTubeUrl,
  probeYouTube,
  type ProbeStreamFn,
  type YouTubeQualityOption,
} from './youtube.ts';

export type SocialPlatform =
  | 'youtube'
  | 'instagram'
  | 'tiktok'
  | 'reddit'
  | 'facebook'
  | 'threads'
  | 'pinterest';

export type SocialErrorCategory =
  | 'timeout'
  | 'auth_blocked'
  | 'deleted_private'
  | 'generic';

export interface SocialMediaItem {
  id: string;
  index: number;
  kind: 'video' | 'image';
  title: string;
  ext: string;
  url: string;
  width?: number;
  height?: number;
  /** Available quality choices when `kind === 'video'`, or single Original Image option when `kind === 'image'`. */
  qualities: YouTubeQualityOption[];
}

export interface SocialProbeResult {
  ok: true;
  platform: SocialPlatform;
  platformLabel: string;
  postId: string;
  title: string;
  author: string;
  durationSecs: number;
  mediaKind: 'video' | 'image' | 'carousel';
  noWatermark: boolean;
  streamableFastStart: boolean;
  subtitles: StreamSubtitle[];
  /** Primary quality list (including Best/4K, 1080p, 720p, 480p, 360p, and Sound Only `.m4a` for videos). */
  qualities: YouTubeQualityOption[];
  /** Individual items for carousels/galleries/slideshows (length >= 1). */
  items: SocialMediaItem[];
  /** Request headers (User-Agent, Referer, Origin, Cookie, Cookies) to pass to Rust `startDownload`. */
  headers: {
    userAgent?: string;
    referer?: string;
    origin?: string;
    cookie?: string;
    cookies?: { host: string; cookie: string }[];
  };
}

export interface SocialProbeError {
  ok: false;
  platform: SocialPlatform | null;
  category: SocialErrorCategory;
  title: string;
  message: string;
}

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  reddit: 'Reddit',
  facebook: 'Facebook',
  threads: 'Threads',
  pinterest: 'Pinterest',
};

const USER_AGENTS = {
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  desktopSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  mobileIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  mobileAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Mobile Safari/537.36',
  instagramApp:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 356.0.0.35.91 (iPhone16,2; iOS 18_1; en_US; en; scale=3.00; 1290x2796; 658319210)',
  redditClient:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
};

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9',
  'en-GB,en-US;q=0.9,en;q=0.8',
  'en-US,en;q=0.9,ms;q=0.8',
];

let uaRotationCounter = 0;

function nextAcceptLanguage(): string {
  const idx = uaRotationCounter++ % ACCEPT_LANGUAGES.length;
  return ACCEPT_LANGUAGES[idx];
}

function nextDesktopUserAgent(): string {
  return uaRotationCounter % 2 === 0
    ? USER_AGENTS.desktopChrome
    : USER_AGENTS.desktopSafari;
}

/**
 * Prepends `https://` to bare social media or YouTube links.
 */
export function normalizeSocialUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return trimmed;
  if (
    /^(?:www\.|m\.|vm\.|vt\.|v\.|i\.|old\.|new\.|dd)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com|instagram\.com|ddinstagram\.com|tiktok\.com|reddit\.com|redd\.it|facebook\.com|fb\.watch|fb\.com|threads\.net|threads\.com|pinterest\.[a-z.]+|pin\.it)\//i.test(
      trimmed,
    )
  ) {
    return `https://${trimmed}`;
  }
  return normalizeYouTubeUrl(trimmed);
}

/**
 * Classifies a URL into one of the supported platforms (Telegram is explicitly excluded).
 */
export function detectSocialPlatform(raw: string): SocialPlatform | null {
  const normalized = normalizeSocialUrl(raw);
  if (!normalized) return null;
  if (isYouTubeUrl(normalized)) return 'youtube';

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname;

  // Explicitly exclude Telegram
  if (
    host === 't.me' ||
    host === 'telegram.me' ||
    host === 'telegram.org' ||
    host.endsWith('.t.me') ||
    host.endsWith('.telegram.org')
  ) {
    return null;
  }

  // Instagram: Posts (/p/), Reels (/reel/, /reels/), TV (/tv/), Stories (/stories/), Highlights (/stories/highlights/), Share (/share/)
  if (
    host === 'instagram.com' ||
    host === 'm.instagram.com' ||
    host === 'ddinstagram.com' ||
    host === 'vxinstagram.com'
  ) {
    if (
      /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+/i.test(path) ||
      /^\/stories\/(?:highlights\/)?[A-Za-z0-9._-]+/i.test(path) ||
      /^\/share\/(?:p|reel|reels)\/[A-Za-z0-9_-]+/i.test(path)
    ) {
      return 'instagram';
    }
  }

  // TikTok: Standard video (/video/), photo slideshow (/photo/), short links (vm.tiktok.com, vt.tiktok.com, tiktok.com/t/)
  if (
    host === 'tiktok.com' ||
    host === 'm.tiktok.com' ||
    host === 'vm.tiktok.com' ||
    host === 'vt.tiktok.com'
  ) {
    if (
      host === 'vm.tiktok.com' ||
      host === 'vt.tiktok.com' ||
      /^\/@[^/]+\/(?:video|photo)\/\d+/i.test(path) ||
      /^\/t\/[A-Za-z0-9_-]+/i.test(path) ||
      /^\/v\/\d+/i.test(path)
    ) {
      return 'tiktok';
    }
  }

  // Reddit: v.redd.it, i.redd.it, redd.it/<id>, reddit.com/r/.../comments/..., reddit.com/gallery/..., reddit.com/r/.../s/...
  if (
    host === 'reddit.com' ||
    host === 'old.reddit.com' ||
    host === 'new.reddit.com' ||
    host === 'np.reddit.com' ||
    host === 'm.reddit.com' ||
    host === 'redd.it' ||
    host === 'v.redd.it' ||
    host === 'i.redd.it'
  ) {
    if (
      host === 'v.redd.it' ||
      host === 'i.redd.it' ||
      (host === 'redd.it' && /^\/[A-Za-z0-9]+/.test(path)) ||
      /\/comments\/[A-Za-z0-9]+/i.test(path) ||
      /^\/gallery\/[A-Za-z0-9]+/i.test(path) ||
      /\/r\/[^/]+\/s\/[A-Za-z0-9]+/i.test(path)
    ) {
      return 'reddit';
    }
  }

  // Facebook: facebook.com/watch, facebook.com/reel, facebook.com/share, facebook.com/.../videos/..., fb.watch/...
  if (
    host === 'facebook.com' ||
    host === 'm.facebook.com' ||
    host === 'web.facebook.com' ||
    host === 'fb.watch' ||
    host === 'fb.com'
  ) {
    if (
      host === 'fb.watch' ||
      /^\/watch\/?(?:\?|$)/i.test(path + url.search) ||
      /^\/watch\/?\?v=/i.test(path + url.search) ||
      /^\/reel\/[A-Za-z0-9_-]+/i.test(path) ||
      /^\/share\/(?:v|r|p)\/[A-Za-z0-9_-]+/i.test(path) ||
      /\/videos\/(?:[^/]+\/)?\d+/i.test(path) ||
      /\/posts\/[A-Za-z0-9_-]+/i.test(path) ||
      /^\/photo(?:\.php|\/)/i.test(path) ||
      /^\/permalink\.php/i.test(path) ||
      /^\/story\.php/i.test(path)
    ) {
      return 'facebook';
    }
  }

  // Threads: threads.net/@user/post/CODE, threads.com/@user/post/CODE, threads.net/t/CODE
  if (
    host === 'threads.net' ||
    host === 'threads.com'
  ) {
    if (
      /^\/@[^/]+\/post\/[A-Za-z0-9_-]+/i.test(path) ||
      /^\/t\/[A-Za-z0-9_-]+/i.test(path)
    ) {
      return 'threads';
    }
  }

  // Pinterest: pinterest.com/pin/..., pin.it/...
  if (
    host === 'pin.it' ||
    host === 'pinterest.com' ||
    /^pinterest\.[a-z.]+$/i.test(host) ||
    /^[a-z]{2}\.pinterest\.com$/i.test(host)
  ) {
    if (host === 'pin.it' || /^\/pin\/[A-Za-z0-9_-]+/i.test(path)) {
      return 'pinterest';
    }
  }

  return null;
}

/** True when `raw` is a supported YouTube or social media link (IG, TikTok, Reddit, FB, Threads, Pinterest). */
export function isSocialOrYouTubeUrl(raw: string): boolean {
  return detectSocialPlatform(raw) !== null;
}

/**
 * Extracts all valid HTTP(S) or bare social/YouTube URLs from single-line or bulk multi-line text.
 * Preserves input order and deduplicates identical URLs with zero artificial queue cap.
 */
export function extractBulkUrls(rawText: string): string[] {
  const text = (rawText ?? '').trim();
  if (!text) return [];
  const tokens = text
    .split(/[\r\n\t\s,]+/)
    .map((t) => t.trim().replace(/^[<"'(]+|[>"'),.;]+$/g, ''))
    .filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();

  for (const tok of tokens) {
    const norm = normalizeSocialUrl(tok);
    if (!norm) continue;
    try {
      const u = new URL(norm);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      if (!u.hostname || !u.hostname.includes('.')) continue;
      if (!seen.has(u.toString())) {
        seen.add(u.toString());
        out.push(norm);
      }
    } catch {
      // Ignore non-URL words in pasted text
    }
  }
  return out;
}

// ---- Resilient Anti-Block HTTP Client (Header Rotation, Cookies.txt, Anti-429 Backoff) ----

interface ResilientFetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  userAgent?: string;
  referer?: string;
}

interface ResilientFetchResult {
  ok: boolean;
  status: number;
  url: string;
  text: string;
  category: SocialErrorCategory;
  errorReason?: string;
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function classifyErrorFromStatus(
  status: number,
  bodySnippet = '',
  isTimeout = false,
): { category: SocialErrorCategory; title: string; message: string } {
  if (isTimeout || status === 0 || status === 408 || status === 504) {
    return {
      category: 'timeout',
      title: 'Network timeout (retrying)',
      message:
        'Connection timed out or dropped while reaching the server. Check your connection or tap Try again.',
    };
  }
  const lower = bodySnippet.toLowerCase();
  if (
    status === 404 ||
    status === 410 ||
    lower.includes('page not found') ||
    lower.includes('content isn\'t available') ||
    lower.includes('video is unavailable') ||
    lower.includes('post is private') ||
    lower.includes('private account') ||
    lower.includes('has been removed') ||
    lower.includes('was deleted')
  ) {
    return {
      category: 'deleted_private',
      title: 'Deleted or private post',
      message:
        'This post was deleted, expired, or belongs to a private account. If you follow this private account, import your cookies.txt and try again.',
    };
  }
  if (
    status === 401 ||
    status === 403 ||
    status === 429 ||
    lower.includes('login_required') ||
    lower.includes('checkpoint_required') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('not logged in')
  ) {
    return {
      category: 'auth_blocked',
      title: 'Blocked or login required (update cookies)',
      message:
        'The platform rate-limited this request or requires a logged-in session. Import a fresh cookies.txt file to continue.',
    };
  }
  return {
    category: 'generic',
    title: 'Media unavailable',
    message: `The platform returned HTTP ${status}. Import cookies.txt or try again.`,
  };
}

async function fetchWithResilience(
  targetUrl: string,
  opts: ResilientFetchOptions = {},
): Promise<ResilientFetchResult> {
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let lastStatus = 0;
  let lastText = '';
  let timedOut = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      return {
        ok: false,
        status: 0,
        url: targetUrl,
        text: '',
        category: 'generic',
        errorReason: 'Cancelled.',
      };
    }

    if (attempt > 0) {
      const jitter = 150 + Math.floor(Math.random() * 250);
      const backoff = Math.min(8_000, 600 * Math.pow(2, attempt - 1)) + jitter;
      await sleepMs(backoff, opts.signal);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const ua = opts.userAgent ?? nextDesktopUserAgent();
    const cookieHeader = getCookieHeaderForUrl(targetUrl);
    const headers: Record<string, string> = {
      'User-Agent': ua,
      'Accept-Language': nextAcceptLanguage(),
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
      ...(opts.referer ? { Referer: opts.referer } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(opts.headers ?? {}),
    };

    try {
      const res = await fetch(targetUrl, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body,
        redirect: 'follow',
        signal: controller.signal,
      });
      lastStatus = res.status;
      const finalUrl = res.url || targetUrl;
      const text = await res.text();
      lastText = text;
      timedOut = false;

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const ra = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
        if (Number.isFinite(ra) && ra > 0 && ra <= 15 && attempt < maxRetries) {
          await sleepMs(ra * 1000, opts.signal);
        }
        if (attempt < maxRetries) {
          continue;
        }
      }

      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          url: finalUrl,
          text,
          category: 'generic',
        };
      }

      const classified = classifyErrorFromStatus(res.status, text.slice(0, 1500), false);
      return {
        ok: false,
        status: res.status,
        url: finalUrl,
        text,
        category: classified.category,
        errorReason: classified.message,
      };
    } catch (err) {
      timedOut = err instanceof Error && err.name === 'AbortError';
      if (attempt < maxRetries && !opts.signal?.aborted) {
        continue;
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  const classified = classifyErrorFromStatus(lastStatus, lastText.slice(0, 1500), timedOut);
  return {
    ok: false,
    status: lastStatus,
    url: targetUrl,
    text: lastText,
    category: classified.category,
    errorReason: classified.message,
  };
}

// ---- Quality Option & Sound-Only Builders ----

export function buildDirectVideoQualityOption(params: {
  id: string;
  height: number | null;
  fps?: number;
  videoUrl: string;
  audioUrl?: string;
  videoBytes?: number | null;
  audioBytes?: number | null;
  durationSecs?: number;
  labelOverride?: string;
  badge?: string;
  userAgent?: string;
}): YouTubeQualityOption {
  const height = params.height;
  const tag =
    height != null
      ? height >= 4320
        ? '8K'
        : height >= 2160
          ? '4K'
          : height >= 1440
            ? '2K'
            : height >= 1080
              ? 'Full HD'
              : height >= 720
                ? 'HD'
                : ''
      : '';
  const fpsSuffix = params.fps && params.fps > 30 ? ` ${params.fps}fps` : '';
  const baseLabel =
    params.labelOverride ??
    (height ? `${height}p${fpsSuffix}${tag ? ` (${tag})` : ''}` : 'Best quality');

  const totalBytes =
    params.videoBytes && params.videoBytes > 0
      ? params.videoBytes + (params.audioBytes ?? 0)
      : null;

  const descParts = ['MP4 (Fast-start)'];
  if (params.badge) descParts.push(params.badge);
  if (totalBytes) descParts.push(`~${formatBytes(totalBytes)}`);

  const streamSelection: StreamSelection = {
    kind: 'pair',
    variantId: params.id,
    videoUrl: params.videoUrl,
    ...(params.audioUrl ? { audioUrl: params.audioUrl } : {}),
    ...(params.videoBytes && params.videoBytes > 0
      ? { videoBytes: params.videoBytes }
      : {}),
    ...(params.audioBytes && params.audioBytes > 0
      ? { audioBytes: params.audioBytes }
      : {}),
    ...(height ? { height } : {}),
    ext: 'mp4',
  };

  return {
    id: params.id,
    label: baseLabel,
    description: descParts.join(' · '),
    ext: '.mp4',
    height,
    estBytes: totalBytes,
    kind: 'pair',
    icon: 'file',
    url: params.videoUrl,
    streamSelection,
    userAgent: params.userAgent,
  };
}

/**
 * Builds the universal "Sound Only" (`.m4a` high-bitrate audio extraction) option.
 * If `dedicatedAudioUrl` is available (e.g. YouTube, Reddit DASH audio, Facebook DASH audio,
 * TikTok original audio), downloads the direct audio stream. Otherwise passes the muxed `.mp4`
 * stream with `ext: 'm4a'` so Rust `mp4_mux::extract_audio_only_m4a` strips the video track
 * and writes a clean fast-start `.m4a` audio file on disk.
 */
export function buildSoundOnlyOption(params: {
  sourceUrl: string;
  audioBytes?: number | null;
  bitrateKbps?: number;
  isDedicatedAudio?: boolean;
  userAgent?: string;
}): YouTubeQualityOption {
  const kbps = params.bitrateKbps ?? 192;
  const bytesPart =
    params.audioBytes && params.audioBytes > 0
      ? ` · ~${formatBytes(params.audioBytes)}`
      : '';
  const modeLabel = params.isDedicatedAudio
    ? `M4A · ${kbps} kbps${bytesPart}`
    : `M4A audio track · ${kbps} kbps${bytesPart}`;

  return {
    id: 'audio-only',
    label: 'Sound only',
    description: modeLabel,
    ext: '.m4a',
    height: null,
    estBytes: params.audioBytes ?? null,
    kind: 'audio',
    icon: 'play',
    url: params.sourceUrl,
    streamSelection: {
      kind: 'pair',
      variantId: 'audio-only',
      videoUrl: params.sourceUrl,
      ...(params.audioBytes && params.audioBytes > 0
        ? { videoBytes: params.audioBytes }
        : {}),
      ext: 'm4a',
    },
    userAgent: params.userAgent,
  };
}

export function buildOriginalImageOption(params: {
  id: string;
  imageUrl: string;
  width?: number;
  height?: number;
  ext?: string;
  userAgent?: string;
}): YouTubeQualityOption {
  const ext = params.ext ?? guessImageExtension(params.imageUrl);
  const dim =
    params.width && params.height ? `${params.width}×${params.height} · ` : '';
  const upperExt = ext.replace(/^\./, '').toUpperCase();
  return {
    id: params.id,
    label: params.height ? `Original image (${params.height}p)` : 'Original high-res image',
    description: `${dim}${upperExt} · Full resolution`,
    ext,
    height: params.height ?? null,
    estBytes: null,
    kind: 'direct',
    icon: 'file',
    url: params.imageUrl,
    streamSelection: {
      kind: 'pair',
      variantId: params.id,
      videoUrl: params.imageUrl,
      ext: ext.replace(/^\./, ''),
    },
    userAgent: params.userAgent,
  };
}

function guessImageExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.png')) return '.png';
    if (pathname.endsWith('.webp')) return '.webp';
    if (pathname.endsWith('.gif')) return '.gif';
  } catch {
    // default to .jpg
  }
  return '.jpg';
}

function decodeHtmlEntities(input: string): string {
  return (input ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u0026/g, '&')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/');
}

function buildPlatformHeaders(
  platform: SocialPlatform,
  pageUrl: string,
  userAgent: string,
  extraMediaUrls: string[] = [],
) {
  let origin = '';
  let referer = pageUrl;
  try {
    const u = new URL(pageUrl);
    origin = `${u.protocol}//${u.host}`;
  } catch {
    // ignore
  }
  if (platform === 'tiktok') {
    referer = 'https://www.tiktok.com/';
    origin = 'https://www.tiktok.com';
  } else if (platform === 'instagram') {
    referer = 'https://www.instagram.com/';
    origin = 'https://www.instagram.com';
  } else if (platform === 'reddit') {
    referer = 'https://www.reddit.com/';
    origin = 'https://www.reddit.com';
  } else if (platform === 'facebook') {
    referer = 'https://www.facebook.com/';
    origin = 'https://www.facebook.com';
  } else if (platform === 'threads') {
    referer = 'https://www.threads.net/';
    origin = 'https://www.threads.net';
  } else if (platform === 'pinterest') {
    referer = 'https://www.pinterest.com/';
    origin = 'https://www.pinterest.com';
  }

  const cookie = getCookieHeaderForUrl(pageUrl);
  const cookies = getHostCookiesForUrl(pageUrl, referer, ...extraMediaUrls);

  return {
    userAgent,
    referer,
    origin,
    ...(cookie ? { cookie } : {}),
    ...(cookies.length > 0 ? { cookies } : {}),
  };
}

// ============================================================================
// 1. TIKTOK EXTRACTOR (No Watermark HD Video + Photo Slideshows + Sound Only)
// ============================================================================

async function probeTikTok(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<SocialProbeResult | SocialProbeError> {
  const ua = USER_AGENTS.desktopChrome;

  // Source 1: TikWM API (`hd=1` returns unwatermarked `hdplay` 1080p, `play` 720p, `music`, and `images[]` slideshows)
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(rawUrl)}&hd=1`;
  const apiRes = await fetchWithResilience(apiUrl, {
    signal,
    userAgent: ua,
    referer: 'https://www.tikwm.com/',
    timeoutMs: 15_000,
    maxRetries: 2,
  });

  if (apiRes.ok && apiRes.text) {
    try {
      const parsed = JSON.parse(apiRes.text);
      if (parsed && parsed.code === 0 && parsed.data) {
        const d = parsed.data;
        const postId = String(d.id || Date.now());
        const author = String(
          d.author?.nickname || d.author?.unique_id || 'TikTok',
        ).trim();
        const rawTitle = String(d.title || `tiktok_${postId}`).trim();
        const title = rawTitle.slice(0, 110) || `tiktok_${postId}`;
        const durationSecs = Number(d.duration || 0) || 0;
        const resolveTikwmUrl = (u?: string) => {
          if (!u) return '';
          if (u.startsWith('http://') || u.startsWith('https://')) return u;
          return `https://www.tikwm.com${u.startsWith('/') ? '' : '/'}${u}`;
        };

        // Check if this is a TikTok Photo Slideshow (`/photo/...` or `images` array)
        if (Array.isArray(d.images) && d.images.length > 0) {
          const items: SocialMediaItem[] = d.images.map(
            (imgUrl: string, idx: number) => {
              const cleanUrl = resolveTikwmUrl(imgUrl);
              const ext = guessImageExtension(cleanUrl);
              const opt = buildOriginalImageOption({
                id: `slide-${idx + 1}`,
                imageUrl: cleanUrl,
                ext,
                userAgent: ua,
              });
              return {
                id: `slide-${idx + 1}`,
                index: idx,
                kind: 'image',
                title: `${title} (${idx + 1})`,
                ext,
                url: cleanUrl,
                qualities: [opt],
              };
            },
          );

          const musicUrl = resolveTikwmUrl(d.music || d.music_info?.play);
          const qualities: YouTubeQualityOption[] = [...items[0].qualities];
          if (musicUrl) {
            qualities.push(
              buildSoundOnlyOption({
                sourceUrl: musicUrl,
                isDedicatedAudio: true,
                userAgent: ua,
              }),
            );
          }

          return {
            ok: true,
            platform: 'tiktok',
            platformLabel: PLATFORM_LABELS.tiktok,
            postId,
            title,
            author,
            durationSecs,
            mediaKind: items.length > 1 ? 'carousel' : 'image',
            noWatermark: true,
            streamableFastStart: true,
            subtitles: [],
            qualities,
            items,
            headers: {
              ...buildPlatformHeaders(
                'tiktok',
                rawUrl,
                ua,
                items.map((i) => i.url),
              ),
              ...(items[0]?.url.includes('tikwm.com')
                ? { referer: 'https://www.tikwm.com/', origin: 'https://www.tikwm.com' }
                : {}),
            },
          };
        }

        // Video TikTok post — strictly unwatermarked streams (`hdplay` and `play`, NEVER `wmplay`)
        const hdUrl = resolveTikwmUrl(d.hdplay);
        const sdUrl = resolveTikwmUrl(d.play);
        const musicUrl = resolveTikwmUrl(d.music || d.music_info?.play);
        const hdBytes = Number(d.hd_size || 0) || null;
        const sdBytes = Number(d.size || 0) || null;

        const qualities: YouTubeQualityOption[] = [];
        if (hdUrl) {
          qualities.push(
            buildDirectVideoQualityOption({
              id: 'tiktok-hd-1080p',
              height: 1080,
              videoUrl: hdUrl,
              videoBytes: hdBytes,
              durationSecs,
              badge: 'No watermark',
              userAgent: ua,
            }),
          );
        }
        if (sdUrl && sdUrl !== hdUrl) {
          qualities.push(
            buildDirectVideoQualityOption({
              id: 'tiktok-sd-720p',
              height: hdUrl ? 720 : 1080,
              videoUrl: sdUrl,
              videoBytes: sdBytes,
              durationSecs,
              badge: 'No watermark',
              userAgent: ua,
            }),
          );
        }

        const primaryVideoUrl = hdUrl || sdUrl;
        if (primaryVideoUrl) {
          qualities.push(
            buildSoundOnlyOption({
              sourceUrl: musicUrl || primaryVideoUrl,
              isDedicatedAudio: Boolean(musicUrl),
              userAgent: ua,
            }),
          );

          const item: SocialMediaItem = {
            id: postId,
            index: 0,
            kind: 'video',
            title,
            ext: '.mp4',
            url: primaryVideoUrl,
            qualities,
          };

          return {
            ok: true,
            platform: 'tiktok',
            platformLabel: PLATFORM_LABELS.tiktok,
            postId,
            title,
            author,
            durationSecs,
            mediaKind: 'video',
            noWatermark: true,
            streamableFastStart: true,
            subtitles: [],
            qualities,
            items: [item],
            headers: {
              ...buildPlatformHeaders('tiktok', rawUrl, ua, [
                primaryVideoUrl,
                musicUrl,
              ]),
              ...(primaryVideoUrl.includes('tikwm.com')
                ? { referer: 'https://www.tikwm.com/', origin: 'https://www.tikwm.com' }
                : {}),
            },
          };
        }
      }
    } catch {
      // Fall through to direct TikTok web rehydration extractor
    }
  }

  // Source 2: Direct TikTok Web Page `__UNIVERSAL_DATA_FOR_REHYDRATION__`
  const pageRes = await fetchWithResilience(rawUrl, {
    signal,
    userAgent: ua,
    referer: 'https://www.tiktok.com/',
  });
  if (!pageRes.ok) {
    const err = classifyErrorFromStatus(pageRes.status, pageRes.text);
    return {
      ok: false,
      platform: 'tiktok',
      category: pageRes.category,
      title: err.title,
      message: pageRes.errorReason || err.message,
    };
  }

  const rehydrationMatch = pageRes.text.match(
    /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (rehydrationMatch) {
    try {
      const json = JSON.parse(rehydrationMatch[1]);
      const itemStruct =
        json?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
      if (itemStruct) {
        const postId = String(itemStruct.id || Date.now());
        const author = String(
          itemStruct.author?.nickname || itemStruct.author?.uniqueId || 'TikTok',
        ).trim();
        const title =
          String(itemStruct.desc || `tiktok_${postId}`)
            .trim()
            .slice(0, 110) || `tiktok_${postId}`;
        const durationSecs = Number(itemStruct.video?.duration || 0) || 0;

        // Check photo post
        const imageList = itemStruct.imagePost?.images;
        if (Array.isArray(imageList) && imageList.length > 0) {
          const items: SocialMediaItem[] = [];
          imageList.forEach((imgObj: any, idx: number) => {
            const u = imgObj?.imageURL?.urlList?.[0];
            if (!u) return;
            const opt = buildOriginalImageOption({
              id: `slide-${idx + 1}`,
              imageUrl: u,
              width: imgObj?.imageWidth,
              height: imgObj?.imageHeight,
              userAgent: ua,
            });
            items.push({
              id: `slide-${idx + 1}`,
              index: idx,
              kind: 'image',
              title: `${title} (${idx + 1})`,
              ext: opt.ext,
              url: u,
              qualities: [opt],
            });
          });
          if (items.length > 0) {
            return {
              ok: true,
              platform: 'tiktok',
              platformLabel: PLATFORM_LABELS.tiktok,
              postId,
              title,
              author,
              durationSecs,
              mediaKind: items.length > 1 ? 'carousel' : 'image',
              noWatermark: true,
              streamableFastStart: true,
              subtitles: [],
              qualities: items[0].qualities,
              items,
              headers: buildPlatformHeaders(
                'tiktok',
                pageRes.url,
                ua,
                items.map((i) => i.url),
              ),
            };
          }
        }

        // Extract unwatermarked bitrate ladder from `video.bitrateInfo` or `video.playAddr`
        const qualities: YouTubeQualityOption[] = [];
        const seenHeights = new Set<number>();
        const bitrateInfo = Array.isArray(itemStruct.video?.bitrateInfo)
          ? itemStruct.video.bitrateInfo
          : [];
        for (const b of bitrateInfo) {
          const u = b?.PlayAddr?.UrlList?.[0];
          const h = Math.min(
            Number(b?.PlayAddr?.Height || 0),
            Number(b?.PlayAddr?.Width || 0),
          ) || Number(itemStruct.video?.height || 1080);
          const bytes = Number(b?.PlayAddr?.DataSize || 0) || null;
          if (u && !seenHeights.has(h)) {
            seenHeights.add(h);
            qualities.push(
              buildDirectVideoQualityOption({
                id: `tiktok-${h}p`,
                height: h,
                videoUrl: u,
                videoBytes: bytes,
                durationSecs,
                badge: 'No watermark',
                userAgent: ua,
              }),
            );
          }
        }
        if (qualities.length === 0 && itemStruct.video?.playAddr) {
          qualities.push(
            buildDirectVideoQualityOption({
              id: 'tiktok-play',
              height: Number(itemStruct.video?.height || 1080),
              videoUrl: itemStruct.video.playAddr,
              durationSecs,
              badge: 'No watermark',
              userAgent: ua,
            }),
          );
        }

        if (qualities.length > 0) {
          qualities.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
          const musicUrl = itemStruct.music?.playUrl || qualities[0].url;
          qualities.push(
            buildSoundOnlyOption({
              sourceUrl: musicUrl,
              isDedicatedAudio: Boolean(itemStruct.music?.playUrl),
              userAgent: ua,
            }),
          );

          return {
            ok: true,
            platform: 'tiktok',
            platformLabel: PLATFORM_LABELS.tiktok,
            postId,
            title,
            author,
            durationSecs,
            mediaKind: 'video',
            noWatermark: true,
            streamableFastStart: true,
            subtitles: [],
            qualities,
            items: [
              {
                id: postId,
                index: 0,
                kind: 'video',
                title,
                ext: '.mp4',
                url: qualities[0].url,
                qualities,
              },
            ],
            headers: buildPlatformHeaders('tiktok', pageRes.url, ua, [
              qualities[0].url,
            ]),
          };
        }
      }
    } catch {
      // Fall through
    }
  }

  return {
    ok: false,
    platform: 'tiktok',
    category: 'auth_blocked',
    title: 'Blocked or login required (update cookies)',
    message:
      'TikTok blocked anonymous extraction for this link. Import cookies.txt or try again.',
  };
}

// ============================================================================
// 2. INSTAGRAM EXTRACTOR (Posts, Reels, Stories, Carousels, Highlights)
// ============================================================================

function extractInstagramShortcode(rawUrl: string): {
  kind: 'post' | 'story';
  shortcode: string;
  storyUser?: string;
} | null {
  try {
    const u = new URL(normalizeSocialUrl(rawUrl));
    const mPost = u.pathname.match(
      /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i,
    );
    if (mPost) return { kind: 'post', shortcode: mPost[1] };
    const mStory = u.pathname.match(
      /\/stories\/([^/]+)\/(\d+)/i,
    );
    if (mStory) {
      return { kind: 'story', storyUser: mStory[1], shortcode: mStory[2] };
    }
  } catch {
    // ignore
  }
  return null;
}

function parseInstagramMediaNode(
  node: any,
  index: number,
  fallbackTitle: string,
  ua: string,
): SocialMediaItem | null {
  if (!node || typeof node !== 'object') return null;

  // Video versions ladder (Reels / video posts / video slides)
  const videoVersions: any[] = Array.isArray(node.video_versions)
    ? node.video_versions
    : [];
  const directVideoUrl =
    typeof node.video_url === 'string' ? decodeHtmlEntities(node.video_url) : '';

  if (videoVersions.length > 0 || directVideoUrl) {
    const qualities: YouTubeQualityOption[] = [];
    const seenHeights = new Set<number>();

    const sorted = [...videoVersions].sort(
      (a, b) =>
        Number(b.height || 0) * Number(b.width || 0) -
        Number(a.height || 0) * Number(a.width || 0),
    );
    for (const v of sorted) {
      const vUrl = typeof v.url === 'string' ? decodeHtmlEntities(v.url) : '';
      if (!vUrl) continue;
      const h =
        Math.min(Number(v.width || 0), Number(v.height || 0)) ||
        Number(v.height || 1080);
      if (seenHeights.has(h) && qualities.length > 0) continue;
      seenHeights.add(h);
      qualities.push(
        buildDirectVideoQualityOption({
          id: `ig-${index}-${h}p`,
          height: h,
          videoUrl: vUrl,
          badge: 'No watermark',
          userAgent: ua,
        }),
      );
    }

    if (qualities.length === 0 && directVideoUrl) {
      const h =
        Math.min(
          Number(node.dimensions?.width || 0),
          Number(node.dimensions?.height || 0),
        ) || 1080;
      qualities.push(
        buildDirectVideoQualityOption({
          id: `ig-${index}-${h}p`,
          height: h,
          videoUrl: directVideoUrl,
          badge: 'No watermark',
          userAgent: ua,
        }),
      );
    }

    if (qualities.length > 0) {
      // Universal Sound Only option (Rust demuxes audio track from MP4 into fast-start .m4a)
      qualities.push(
        buildSoundOnlyOption({
          sourceUrl: qualities[0].url,
          isDedicatedAudio: false,
          userAgent: ua,
        }),
      );
      return {
        id: String(node.id || node.pk || `ig-video-${index + 1}`),
        index,
        kind: 'video',
        title: index > 0 ? `${fallbackTitle} (${index + 1})` : fallbackTitle,
        ext: '.mp4',
        url: qualities[0].url,
        qualities,
      };
    }
  }

  // Image candidates (Single image or carousel photo slide)
  const candidates: any[] =
    node.image_versions2?.candidates ||
    node.display_resources ||
    [];
  let bestImgUrl =
    typeof node.display_url === 'string'
      ? decodeHtmlEntities(node.display_url)
      : '';
  let bestW = Number(node.dimensions?.width || 0) || undefined;
  let bestH = Number(node.dimensions?.height || 0) || undefined;

  if (Array.isArray(candidates) && candidates.length > 0) {
    const sortedImg = [...candidates].sort(
      (a, b) =>
        Number(b.width || b.config_width || 0) *
          Number(b.height || b.config_height || 0) -
        Number(a.width || a.config_width || 0) *
          Number(a.height || a.config_height || 0),
    );
    const top = sortedImg[0];
    const u = top?.url || top?.src;
    if (typeof u === 'string' && u) {
      bestImgUrl = decodeHtmlEntities(u);
      bestW = Number(top.width || top.config_width || 0) || bestW;
      bestH = Number(top.height || top.config_height || 0) || bestH;
    }
  }

  if (bestImgUrl) {
    const opt = buildOriginalImageOption({
      id: `ig-img-${index + 1}`,
      imageUrl: bestImgUrl,
      width: bestW,
      height: bestH,
      userAgent: ua,
    });
    return {
      id: String(node.id || node.pk || `ig-img-${index + 1}`),
      index,
      kind: 'image',
      title: index > 0 ? `${fallbackTitle} (${index + 1})` : fallbackTitle,
      ext: opt.ext,
      url: bestImgUrl,
      width: bestW,
      height: bestH,
      qualities: [opt],
    };
  }

  return null;
}

async function probeInstagram(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<SocialProbeResult | SocialProbeError> {
  const parsed = extractInstagramShortcode(rawUrl);
  const shortcode = parsed?.shortcode || '';
  const ua = USER_AGENTS.instagramApp;

  if (!shortcode) {
    return {
      ok: false,
      platform: 'instagram',
      category: 'generic',
      title: 'Unsupported Instagram link',
      message:
        'Paste a link to an Instagram Post, Reel, Story, or Carousel.',
    };
  }

  // Source 1: Instagram GraphQL / Web Info API (works best with cookies.txt or anonymous)
  const graphqlBody = new URLSearchParams({
    variables: JSON.stringify({ shortcode }),
    doc_id: '8845758582119845',
  }).toString();

  const gqlRes = await fetchWithResilience(
    'https://www.instagram.com/graphql/query',
    {
      method: 'POST',
      signal,
      userAgent: USER_AGENTS.desktopChrome,
      referer: `https://www.instagram.com/p/${shortcode}/`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-IG-App-ID': '936619743392459',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: graphqlBody,
      maxRetries: 1,
    },
  );

  const tryBuildFromIgNode = (mediaNode: any): SocialProbeResult | null => {
    if (!mediaNode || typeof mediaNode !== 'object') return null;
    const author = String(
      mediaNode.owner?.username ||
        mediaNode.user?.username ||
        'Instagram',
    ).trim();
    const rawCaption =
      mediaNode.caption?.text ||
      mediaNode.edge_media_to_caption?.edges?.[0]?.node?.text ||
      '';
    const title =
      String(rawCaption || `instagram_${shortcode}`)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100) || `instagram_${shortcode}`;
    const durationSecs = Number(mediaNode.video_duration || 0) || 0;

    const children: any[] =
      mediaNode.carousel_media ||
      mediaNode.edge_sidecar_to_children?.edges?.map((e: any) => e?.node) ||
      [];

    const items: SocialMediaItem[] = [];
    if (Array.isArray(children) && children.length > 0) {
      children.forEach((child, idx) => {
        const parsedItem = parseInstagramMediaNode(child, idx, title, ua);
        if (parsedItem) items.push(parsedItem);
      });
    } else {
      const single = parseInstagramMediaNode(mediaNode, 0, title, ua);
      if (single) items.push(single);
    }

    if (items.length === 0) return null;
    const mediaKind =
      items.length > 1
        ? 'carousel'
        : items[0].kind === 'video'
          ? 'video'
          : 'image';

    return {
      ok: true,
      platform: 'instagram',
      platformLabel: PLATFORM_LABELS.instagram,
      postId: shortcode,
      title,
      author,
      durationSecs,
      mediaKind,
      noWatermark: true,
      streamableFastStart: true,
      subtitles: [],
      qualities: items[0].qualities,
      items,
      headers: buildPlatformHeaders(
        'instagram',
        rawUrl,
        ua,
        items.map((i) => i.url),
      ),
    };
  };

  if (gqlRes.ok && gqlRes.text) {
    try {
      const data = JSON.parse(gqlRes.text);
      const media =
        data?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0] ||
        data?.data?.shortcode_media;
      const built = tryBuildFromIgNode(media);
      if (built) return built;
    } catch {
      // Fall through to Source 2
    }
  }

  // Source 2: Instagram `/p/<shortcode>/embed/captioned/` & `/reel/<shortcode>/embed/captioned/` (cookie-less)
  for (const embedPath of [
    `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
    `https://www.instagram.com/reel/${shortcode}/embed/captioned/`,
  ]) {
    const embedRes = await fetchWithResilience(embedPath, {
      signal,
      userAgent: USER_AGENTS.desktopChrome,
      referer: 'https://www.instagram.com/',
      maxRetries: 1,
    });
    if (embedRes.ok && embedRes.text) {
      // Check embedded `contextJSON` / `shortcode_media` / `EmbeddedMediaImage`
      const vUrlMatch = embedRes.text.match(/"video_url"\s*:\s*"([^"]+)"/);
      const dUrlMatch = embedRes.text.match(/"display_url"\s*:\s*"([^"]+)"/);
      const imgTagMatch = embedRes.text.match(
        /<img[^>]+class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]+src=["']([^"']+)["']/i,
      );
      const userMatch = embedRes.text.match(/"username"\s*:\s*"([^"]+)"/);
      if (vUrlMatch || dUrlMatch || imgTagMatch) {
        const vUrl = vUrlMatch ? unescapeJsonString(vUrlMatch[1]) : '';
        const dUrl = dUrlMatch
          ? unescapeJsonString(dUrlMatch[1])
          : imgTagMatch
            ? decodeHtmlEntities(imgTagMatch[1])
            : '';
        const author = userMatch ? userMatch[1] : 'Instagram';
        const title = `instagram_${shortcode}`;
        const built = tryBuildFromIgNode({
          id: shortcode,
          owner: { username: author },
          ...(vUrl ? { video_url: vUrl } : {}),
          ...(dUrl ? { display_url: dUrl } : {}),
        });
        if (built) return built;
      }
    }
  }

  // Source 3: Multi-source cookie-less fallback via OpenGraph preview mirrors & bot User-Agent
  const igFallbacks: { url: string; ua: string }[] = [
    { url: `https://www.instagram.com/p/${shortcode}/`, ua: 'WhatsApp/2.23.20.0' },
    { url: `https://www.ddinstagram.com/p/${shortcode}`, ua: 'TelegramBot (like TwitterBot)' },
    { url: `https://www.vxinstagram.com/p/${shortcode}`, ua: 'TelegramBot (like TwitterBot)' },
    { url: `https://www.eeinstagram.com/p/${shortcode}`, ua: 'TelegramBot (like TwitterBot)' },
  ];
  for (const fb of igFallbacks) {
    const mirrorRes = await fetchWithResilience(fb.url, {
      signal,
      userAgent: fb.ua,
      maxRetries: 0,
      timeoutMs: 8_000,
    });
    if (mirrorRes.ok && mirrorRes.text) {
      const ogVideo =
        mirrorRes.text.match(
          /<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
        )?.[1] ||
        mirrorRes.text.match(
          /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::secure_url)?["']/i,
        )?.[1];
      const ogImage =
        mirrorRes.text.match(
          /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
        )?.[1];
      const ogDesc =
        mirrorRes.text.match(
          /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
        )?.[1];
      if (ogVideo || ogImage) {
        const cleanVideo = ogVideo ? decodeHtmlEntities(ogVideo) : '';
        const cleanImage = ogImage ? decodeHtmlEntities(ogImage) : '';
        const title =
          (ogDesc ? decodeHtmlEntities(ogDesc).slice(0, 100) : '') ||
          `instagram_${shortcode}`;
        const built = tryBuildFromIgNode({
          id: shortcode,
          caption: { text: title },
          ...(cleanVideo ? { video_url: cleanVideo } : {}),
          ...(cleanImage ? { display_url: cleanImage } : {}),
        });
        if (built) return built;
      }
    }
  }

  return {
    ok: false,
    platform: 'instagram',
    category: 'auth_blocked',
    title: 'Post unavailable',
    message:
      'Could not extract media from this Instagram link. It may be private or temporarily rate-limited.',
  };
}

// ============================================================================
// 3. REDDIT EXTRACTOR (`v.redd.it` DASH Video+Audio Muxing, `i.redd.it`, Galleries)
// ============================================================================

async function probeReddit(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<SocialProbeResult | SocialProbeError> {
  const ua = USER_AGENTS.redditClient;
  let targetUrl = normalizeSocialUrl(rawUrl);

  // Direct `i.redd.it/<file>.(jpg|png|webp|gif)` image link
  try {
    const u = new URL(targetUrl);
    if (
      u.hostname.toLowerCase() === 'i.redd.it' &&
      /\.(?:jpe?g|png|webp|gif)$/i.test(u.pathname)
    ) {
      const filename = u.pathname.split('/').pop() || 'reddit_image.jpg';
      const baseTitle = filename.replace(/\.[a-z0-9]+$/i, '');
      const opt = buildOriginalImageOption({
        id: 'reddit-direct-img',
        imageUrl: targetUrl,
        userAgent: ua,
      });
      return {
        ok: true,
        platform: 'reddit',
        platformLabel: PLATFORM_LABELS.reddit,
        postId: baseTitle,
        title: baseTitle,
        author: 'Reddit',
        durationSecs: 0,
        mediaKind: 'image',
        noWatermark: true,
        streamableFastStart: true,
        subtitles: [],
        qualities: [opt],
        items: [
          {
            id: baseTitle,
            index: 0,
            kind: 'image',
            title: baseTitle,
            ext: opt.ext,
            url: targetUrl,
            qualities: [opt],
          },
        ],
        headers: buildPlatformHeaders('reddit', targetUrl, ua, [targetUrl]),
      };
    }

    // Direct `v.redd.it/<id>` link -> build DASH video + audio ladder directly if thread redirect isn't followed
    if (u.hostname.toLowerCase() === 'v.redd.it') {
      const vidId = u.pathname.split('/').filter(Boolean)[0];
      if (vidId && !u.pathname.includes('DASH_')) {
        // Resolve redirect to the Reddit thread first if possible
        const redir = await fetchWithResilience(targetUrl, {
          signal,
          userAgent: ua,
          maxRetries: 1,
        });
        if (redir.url && redir.url.includes('/comments/')) {
          targetUrl = redir.url;
        } else {
          return buildVRedditDirectProbe(vidId, `reddit_${vidId}`, 'Reddit', 0, ua);
        }
      }
    }
  } catch {
    // continue
  }

  // Resolve short share links (`/r/.../s/...` or `redd.it/...`)
  if (/\/s\/[A-Za-z0-9]+/i.test(targetUrl) || /:\/\/redd\.it\//i.test(targetUrl)) {
    const resolved = await fetchWithResilience(targetUrl, {
      signal,
      userAgent: ua,
      maxRetries: 1,
    });
    if (resolved.url) targetUrl = resolved.url;
  }

  // Normalize thread URL to `.json?raw_json=1`
  let jsonUrls: string[] = [];
  try {
    const u = new URL(targetUrl);
    const cleanPath = u.pathname.replace(/\/+$/, '').replace(/\.json$/i, '');
    jsonUrls = [
      `https://www.reddit.com${cleanPath}.json?raw_json=1`,
      `https://old.reddit.com${cleanPath}.json?raw_json=1`,
    ];
  } catch {
    return {
      ok: false,
      platform: 'reddit',
      category: 'generic',
      title: 'Invalid Reddit link',
      message: 'Check the Reddit link and try again.',
    };
  }

  let postData: any = null;
  let lastFail: ResilientFetchResult | null = null;
  for (const jUrl of jsonUrls) {
    const res = await fetchWithResilience(jUrl, {
      signal,
      userAgent: ua,
      headers: { Accept: 'application/json' },
    });
    lastFail = res;
    if (res.ok && res.text) {
      try {
        const parsed = JSON.parse(res.text);
        const listing = Array.isArray(parsed) ? parsed[0] : parsed;
        const rawPost = listing?.data?.children?.[0]?.data;
        if (rawPost) {
          postData =
            rawPost.crosspost_parent_list?.[0] &&
            !rawPost.secure_media &&
            !rawPost.gallery_data
              ? rawPost.crosspost_parent_list[0]
              : rawPost;
          break;
        }
      } catch {
        // try next endpoint
      }
    }
  }

  if (!postData) {
    // Cookie-less fallback via rxddit / vxreddit when Reddit blocks `.json` with 403
    try {
      const u = new URL(targetUrl);
      const cleanPath = u.pathname.replace(/\/+$/, '');
      for (const mirrorHost of ['www.rxddit.com', 'vxreddit.com']) {
        const mRes = await fetchWithResilience(`https://${mirrorHost}${cleanPath}`, {
          signal,
          userAgent: 'TelegramBot (like TwitterBot)',
          maxRetries: 0,
          timeoutMs: 8_000,
        });
        if (mRes.ok && mRes.text) {
          const ogVid = mRes.text.match(
            /<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
          )?.[1];
          const ogImg = mRes.text.match(
            /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
          )?.[1];
          const ogTitle = mRes.text.match(
            /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
          )?.[1];
          const rTitle = ogTitle ? decodeHtmlEntities(ogTitle).slice(0, 100) : 'reddit_media';
          if (ogVid) {
            const cleanV = decodeHtmlEntities(ogVid);
            const vMatch = cleanV.match(/v\.redd\.it\/([^/]+)/i);
            if (vMatch) {
              return buildVRedditDirectProbe(vMatch[1], rTitle, 'Reddit', 0, ua);
            }
            const opt = buildDirectVideoQualityOption({
              id: 'reddit-mirror-vid',
              height: 720,
              videoUrl: cleanV,
              badge: 'No watermark',
              userAgent: ua,
            });
            const aOpt = buildSoundOnlyOption({ sourceUrl: cleanV, userAgent: ua });
            return {
              ok: true,
              platform: 'reddit',
              platformLabel: PLATFORM_LABELS.reddit,
              postId: 'reddit',
              title: rTitle,
              author: 'Reddit',
              durationSecs: 0,
              mediaKind: 'video',
              noWatermark: true,
              streamableFastStart: true,
              subtitles: [],
              qualities: [opt, aOpt],
              items: [{ id: 'reddit', index: 0, kind: 'video', title: rTitle, ext: '.mp4', url: cleanV, qualities: [opt, aOpt] }],
              headers: buildPlatformHeaders('reddit', targetUrl, ua, [cleanV]),
            };
          }
          if (ogImg) {
            const cleanI = decodeHtmlEntities(ogImg);
            const opt = buildOriginalImageOption({ id: 'reddit-mirror-img', imageUrl: cleanI, userAgent: ua });
            return {
              ok: true,
              platform: 'reddit',
              platformLabel: PLATFORM_LABELS.reddit,
              postId: 'reddit',
              title: rTitle,
              author: 'Reddit',
              durationSecs: 0,
              mediaKind: 'image',
              noWatermark: true,
              streamableFastStart: true,
              subtitles: [],
              qualities: [opt],
              items: [{ id: 'reddit', index: 0, kind: 'image', title: rTitle, ext: opt.ext, url: cleanI, qualities: [opt] }],
              headers: buildPlatformHeaders('reddit', targetUrl, ua, [cleanI]),
            };
          }
        }
      }
    } catch {
      // fall through
    }
    const err = classifyErrorFromStatus(
      lastFail?.status ?? 403,
      lastFail?.text ?? '',
    );
    return {
      ok: false,
      platform: 'reddit',
      category: lastFail?.category ?? 'auth_blocked',
      title: err.title,
      message: lastFail?.errorReason || err.message,
    };
  }

  const postId = String(postData.id || Date.now());
  const title =
    String(postData.title || `reddit_${postId}`)
      .trim()
      .slice(0, 110) || `reddit_${postId}`;
  const author = String(
    postData.author ? `u/${postData.author}` : postData.subreddit_name_prefixed || 'Reddit',
  );

  // Case A: Reddit Video (`v.redd.it` with separate DASH video + audio tracks muxed into fast-start .mp4)
  const rv =
    postData.secure_media?.reddit_video ||
    postData.media?.reddit_video ||
    postData.preview?.reddit_video_preview;
  if (rv && typeof rv.fallback_url === 'string') {
    const fallbackUrl = decodeHtmlEntities(rv.fallback_url).split('?')[0];
    const baseMatch = fallbackUrl.match(/^(https?:\/\/v\.redd\.it\/[^/]+)\//i);
    const maxHeight = Number(rv.height || 1080) || 1080;
    const durationSecs = Number(rv.duration || 0) || 0;
    const hasAudio = rv.is_gif !== true;

    if (baseMatch) {
      return buildVRedditDirectProbe(
        baseMatch[1].split('/').pop() || postId,
        title,
        author,
        durationSecs,
        ua,
        maxHeight,
        hasAudio,
        fallbackUrl,
      );
    }
  }

  // Case B: Reddit Gallery (`gallery_data` + `media_metadata`)
  if (postData.gallery_data?.items && postData.media_metadata) {
    const galleryItems: any[] = postData.gallery_data.items;
    const metaMap = postData.media_metadata;
    const items: SocialMediaItem[] = [];

    galleryItems.forEach((g, idx) => {
      const mediaId = g?.media_id;
      const m = mediaId ? metaMap[mediaId] : null;
      if (!m) return;
      const rawImgUrl = m.s?.u || m.s?.gif || m.s?.mp4;
      if (typeof rawImgUrl !== 'string' || !rawImgUrl) return;
      const cleanUrl = decodeHtmlEntities(rawImgUrl);
      const isMp4 = Boolean(m.s?.mp4 && !m.s?.u);
      if (isMp4) {
        const vOpt = buildDirectVideoQualityOption({
          id: `reddit-gal-${idx + 1}`,
          height: Number(m.s?.y || 720),
          videoUrl: cleanUrl,
          userAgent: ua,
        });
        items.push({
          id: String(mediaId),
          index: idx,
          kind: 'video',
          title: `${title} (${idx + 1})`,
          ext: '.mp4',
          url: cleanUrl,
          qualities: [vOpt],
        });
      } else {
        const ext = m.m === 'image/png' ? '.png' : m.m === 'image/gif' ? '.gif' : '.jpg';
        const opt = buildOriginalImageOption({
          id: `reddit-gal-${idx + 1}`,
          imageUrl: cleanUrl,
          width: Number(m.s?.x || 0) || undefined,
          height: Number(m.s?.y || 0) || undefined,
          ext,
          userAgent: ua,
        });
        items.push({
          id: String(mediaId),
          index: idx,
          kind: 'image',
          title: `${title} (${idx + 1})`,
          ext,
          url: cleanUrl,
          width: Number(m.s?.x || 0) || undefined,
          height: Number(m.s?.y || 0) || undefined,
          qualities: [opt],
        });
      }
    });

    if (items.length > 0) {
      return {
        ok: true,
        platform: 'reddit',
        platformLabel: PLATFORM_LABELS.reddit,
        postId,
        title,
        author,
        durationSecs: 0,
        mediaKind: items.length > 1 ? 'carousel' : items[0].kind,
        noWatermark: true,
        streamableFastStart: true,
        subtitles: [],
        qualities: items[0].qualities,
        items,
        headers: buildPlatformHeaders(
          'reddit',
          rawUrl,
          ua,
          items.map((i) => i.url),
        ),
      };
    }
  }

  // Case C: Single Reddit Image (`url_overridden_by_dest` or `preview.images[0].source`)
  const directDest = String(postData.url_overridden_by_dest || postData.url || '');
  const previewSrc = postData.preview?.images?.[0]?.source;
  const imgUrl =
    /\.(?:jpe?g|png|webp|gif)(?:\?|$)/i.test(directDest)
      ? decodeHtmlEntities(directDest)
      : typeof previewSrc?.url === 'string'
        ? decodeHtmlEntities(previewSrc.url)
        : '';

  if (imgUrl) {
    const opt = buildOriginalImageOption({
      id: `reddit-img-${postId}`,
      imageUrl: imgUrl,
      width: Number(previewSrc?.width || 0) || undefined,
      height: Number(previewSrc?.height || 0) || undefined,
      userAgent: ua,
    });
    return {
      ok: true,
      platform: 'reddit',
      platformLabel: PLATFORM_LABELS.reddit,
      postId,
      title,
      author,
      durationSecs: 0,
      mediaKind: 'image',
      noWatermark: true,
      streamableFastStart: true,
      subtitles: [],
      qualities: [opt],
      items: [
        {
          id: postId,
          index: 0,
          kind: 'image',
          title,
          ext: opt.ext,
          url: imgUrl,
          qualities: [opt],
        },
      ],
      headers: buildPlatformHeaders('reddit', rawUrl, ua, [imgUrl]),
    };
  }

  return {
    ok: false,
    platform: 'reddit',
    category: 'generic',
    title: 'No downloadable media found',
    message: 'This Reddit thread does not contain a video, image, or gallery.',
  };
}

function buildVRedditDirectProbe(
  vidId: string,
  title: string,
  author: string,
  durationSecs: number,
  ua: string,
  maxHeight = 1080,
  hasAudio = true,
  fallbackUrl?: string,
): SocialProbeResult {
  const baseUrl = `https://v.redd.it/${vidId}`;
  const audioUrl = hasAudio ? `${baseUrl}/DASH_AUDIO_128.mp4` : undefined;
  const ladder = [1080, 720, 480, 360, 240].filter((h) => h <= maxHeight);
  if (ladder.length === 0) ladder.push(maxHeight);

  const qualities: YouTubeQualityOption[] = ladder.map((h, idx) => {
    const vUrl =
      idx === 0 && fallbackUrl ? fallbackUrl : `${baseUrl}/DASH_${h}.mp4`;
    return buildDirectVideoQualityOption({
      id: `reddit-${h}p`,
      height: h,
      videoUrl: vUrl,
      audioUrl,
      durationSecs,
      badge: 'No watermark',
      userAgent: ua,
    });
  });

  if (audioUrl) {
    qualities.push(
      buildSoundOnlyOption({
        sourceUrl: audioUrl,
        bitrateKbps: 128,
        isDedicatedAudio: true,
        userAgent: ua,
      }),
    );
  }

  return {
    ok: true,
    platform: 'reddit',
    platformLabel: PLATFORM_LABELS.reddit,
    postId: vidId,
    title,
    author,
    durationSecs,
    mediaKind: 'video',
    noWatermark: true,
    streamableFastStart: true,
    subtitles: [],
    qualities,
    items: [
      {
        id: vidId,
        index: 0,
        kind: 'video',
        title,
        ext: '.mp4',
        url: qualities[0].url,
        qualities,
      },
    ],
    headers: buildPlatformHeaders('reddit', baseUrl, ua, [
      qualities[0].url,
      audioUrl || '',
    ]),
  };
}

// ============================================================================
// 4. FACEBOOK EXTRACTOR (Reels, Watch, Public/Private Video & Photo Posts)
// ============================================================================

function unescapeJsonString(raw: string): string {
  try {
    return decodeHtmlEntities(JSON.parse(`"${raw.replace(/"/g, '\\"')}"`));
  } catch {
    return decodeHtmlEntities(raw);
  }
}

async function probeFacebook(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<SocialProbeResult | SocialProbeError> {
  const ua = USER_AGENTS.desktopSafari;
  // Query both Facebook's public embed plugin (works cookie-less for public Watch/Reels/Videos)
  // and the direct page (with bot/Safari headers) in parallel.
  const pluginUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(rawUrl)}&show_text=0`;
  const [res, pluginRes, botRes] = await Promise.all([
    fetchWithResilience(rawUrl, {
      signal,
      userAgent: ua,
      referer: 'https://www.facebook.com/',
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
      },
      maxRetries: 1,
    }),
    fetchWithResilience(pluginUrl, {
      signal,
      userAgent: USER_AGENTS.desktopChrome,
      referer: 'https://www.facebook.com/',
      maxRetries: 1,
    }),
    fetchWithResilience(rawUrl, {
      signal,
      userAgent: 'facebookexternalhit/1.1',
      maxRetries: 0,
      timeoutMs: 10_000,
    }),
  ]);

  const html = `${pluginRes.text || ''}\n${res.text || ''}\n${botRes.text || ''}`;
  if (!html.trim()) {
    const err = classifyErrorFromStatus(res.status, res.text);
    return {
      ok: false,
      platform: 'facebook',
      category: res.category,
      title: err.title,
      message: res.errorReason || err.message,
    };
  }
  const postIdMatch =
    res.url.match(/(?:\/videos\/|\/reel\/|\/posts\/|v=)(\d+|[A-Za-z0-9_-]+)/i) ||
    rawUrl.match(/\/([A-Za-z0-9_-]+)\/?$/);
  const postId = postIdMatch?.[1] || String(Date.now());

  const titleMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const rawTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : '';
  const title =
    rawTitle.replace(/\s*\|\s*Facebook$/i, '').slice(0, 100) ||
    `facebook_${postId}`;

  const hdMatch =
    html.match(/"browser_native_hd_url"\s*:\s*"([^"]+)"/) ||
    html.match(/"playable_url_quality_hd"\s*:\s*"([^"]+)"/) ||
    html.match(/"hd_src(?:_no_ratelimit)?"\s*:\s*"([^"]+)"/);
  const sdMatch =
    html.match(/"browser_native_sd_url"\s*:\s*"([^"]+)"/) ||
    html.match(/"playable_url"\s*:\s*"([^"]+)"/) ||
    html.match(/"sd_src(?:_no_ratelimit)?"\s*:\s*"([^"]+)"/);
  const ogVideoMatch = html.match(
    /<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
  );

  const hdUrl = hdMatch ? unescapeJsonString(hdMatch[1]) : '';
  const sdUrl = sdMatch
    ? unescapeJsonString(sdMatch[1])
    : ogVideoMatch
      ? decodeHtmlEntities(ogVideoMatch[1])
      : '';

  const qualities: YouTubeQualityOption[] = [];
  if (hdUrl) {
    qualities.push(
      buildDirectVideoQualityOption({
        id: 'fb-hd-1080p',
        height: 1080,
        videoUrl: hdUrl,
        badge: 'HD · No watermark',
        userAgent: ua,
      }),
    );
  }
  if (sdUrl && sdUrl !== hdUrl) {
    qualities.push(
      buildDirectVideoQualityOption({
        id: 'fb-sd-480p',
        height: hdUrl ? 480 : 720,
        videoUrl: sdUrl,
        badge: 'SD · No watermark',
        userAgent: ua,
      }),
    );
  }

  if (qualities.length > 0) {
    const primaryUrl = qualities[0].url;
    qualities.push(
      buildSoundOnlyOption({
        sourceUrl: primaryUrl,
        isDedicatedAudio: false,
        userAgent: ua,
      }),
    );
    return {
      ok: true,
      platform: 'facebook',
      platformLabel: PLATFORM_LABELS.facebook,
      postId,
      title,
      author: 'Facebook',
      durationSecs: 0,
      mediaKind: 'video',
      noWatermark: true,
      streamableFastStart: true,
      subtitles: [],
      qualities,
      items: [
        {
          id: postId,
          index: 0,
          kind: 'video',
          title,
          ext: '.mp4',
          url: primaryUrl,
          qualities,
        },
      ],
      headers: buildPlatformHeaders('facebook', res.url, ua, [primaryUrl]),
    };
  }

  // Shared Photo fallback (`og:image`)
  const ogImgMatch = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  );
  if (ogImgMatch && !html.includes('login_form')) {
    const imgUrl = decodeHtmlEntities(ogImgMatch[1]);
    const opt = buildOriginalImageOption({
      id: `fb-img-${postId}`,
      imageUrl: imgUrl,
      userAgent: ua,
    });
    return {
      ok: true,
      platform: 'facebook',
      platformLabel: PLATFORM_LABELS.facebook,
      postId,
      title,
      author: 'Facebook',
      durationSecs: 0,
      mediaKind: 'image',
      noWatermark: true,
      streamableFastStart: true,
      subtitles: [],
      qualities: [opt],
      items: [
        {
          id: postId,
          index: 0,
          kind: 'image',
          title,
          ext: opt.ext,
          url: imgUrl,
          qualities: [opt],
        },
      ],
      headers: buildPlatformHeaders('facebook', res.url, ua, [imgUrl]),
    };
  }

  return {
    ok: false,
    platform: 'facebook',
    category: 'auth_blocked',
    title: 'Blocked or login required (update cookies)',
    message:
      'Facebook requires an authenticated session for this post. Import your cookies.txt file to download it.',
  };
}

// ============================================================================
// 5. THREADS EXTRACTOR (Video, Image, Carousel Posts)
// ============================================================================

async function probeThreads(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<SocialProbeResult | SocialProbeError> {
  const ua = USER_AGENTS.desktopChrome;
  const codeMatch = rawUrl.match(/\/(?:post|t)\/([A-Za-z0-9_-]+)/i);
  const shortcode = codeMatch?.[1] || String(Date.now());

  // Fetch `/t/<code>/embed` + WhatsApp/Telegram preview bot UA in parallel (works cookie-less)
  const embedUrl = `https://www.threads.net/t/${shortcode}/embed`;
  const [res, botRes] = await Promise.all([
    fetchWithResilience(embedUrl, {
      signal,
      userAgent: ua,
      referer: 'https://www.threads.net/',
      maxRetries: 1,
    }),
    fetchWithResilience(rawUrl, {
      signal,
      userAgent: 'WhatsApp/2.23.20.0',
      maxRetries: 0,
      timeoutMs: 10_000,
    }),
  ]);

  const html = res.ok && res.text ? res.text : '';
  const botHtml = botRes.ok && botRes.text ? botRes.text : '';
  const mainRes =
    !html.includes('.mp4') && !botHtml.includes('og:video') && !botHtml.includes('og:image')
      ? await fetchWithResilience(rawUrl, {
          signal,
          userAgent: ua,
          referer: 'https://www.threads.net/',
          maxRetries: 1,
        })
      : res;

  const combined = `${html}\n${botHtml}\n${mainRes.text || ''}`;

  const userMatch =
    combined.match(/"username"\s*:\s*"([^"]+)"/) ||
    rawUrl.match(/\/@([A-Za-z0-9._]+)/);
  const author = userMatch ? `@${userMatch[1].replace(/^@/, '')}` : 'Threads';

  const titleMatch = combined.match(
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
  );
  const title =
    (titleMatch ? decodeHtmlEntities(titleMatch[1]).trim().slice(0, 100) : '') ||
    `threads_${shortcode}`;

  // Extract video URLs (from `video_versions` JSON or `<video src="...">`)
  const videoUrls: string[] = [];
  const seenV = new Set<string>();
  for (const m of combined.matchAll(/"video_versions"\s*:\s*\[([\s\S]*?)\]/g)) {
    for (const uMatch of m[1].matchAll(/"url"\s*:\s*"([^"]+)"/g)) {
      const clean = unescapeJsonString(uMatch[1]);
      if (clean.startsWith('http') && !seenV.has(clean)) {
        seenV.add(clean);
        videoUrls.push(clean);
      }
    }
  }
  for (const m of combined.matchAll(/<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/gi)) {
    const clean = decodeHtmlEntities(m[1]);
    if (clean.startsWith('http') && !seenV.has(clean)) {
      seenV.add(clean);
      videoUrls.push(clean);
    }
  }
  const ogVid = combined.match(
    /<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
  );
  if (ogVid) {
    const clean = decodeHtmlEntities(ogVid[1]);
    if (clean.startsWith('http') && !seenV.has(clean)) {
      seenV.add(clean);
      videoUrls.push(clean);
    }
  }

  // Extract high-res image URLs
  const imageUrls: string[] = [];
  const seenI = new Set<string>();
  for (const m of combined.matchAll(/<img[^>]+class=["'][^"']*SingleMediaImage[^"']*["'][^>]+src=["']([^"']+)["']/gi)) {
    const clean = decodeHtmlEntities(m[1]);
    if (clean.startsWith('http') && !seenI.has(clean)) {
      seenI.add(clean);
      imageUrls.push(clean);
    }
  }
  if (videoUrls.length === 0 && imageUrls.length === 0) {
    const ogImg = combined.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    );
    if (ogImg) {
      const clean = decodeHtmlEntities(ogImg[1]);
      if (clean.startsWith('http') && !clean.includes(' threads_logo')) {
        imageUrls.push(clean);
      }
    }
  }

  if (videoUrls.length > 0) {
    const items: SocialMediaItem[] = videoUrls.map((vUrl, idx) => {
      const vOpt = buildDirectVideoQualityOption({
        id: `threads-vid-${idx + 1}`,
        height: 1080,
        videoUrl: vUrl,
        badge: 'No watermark',
        userAgent: ua,
      });
      const aOpt = buildSoundOnlyOption({
        sourceUrl: vUrl,
        isDedicatedAudio: false,
        userAgent: ua,
      });
      return {
        id: `threads-vid-${idx + 1}`,
        index: idx,
        kind: 'video',
        title: videoUrls.length > 1 ? `${title} (${idx + 1})` : title,
        ext: '.mp4',
        url: vUrl,
        qualities: [vOpt, aOpt],
      };
    });

    return {
      ok: true,
      platform: 'threads',
      platformLabel: PLATFORM_LABELS.threads,
      postId: shortcode,
      title,
      author,
      durationSecs: 0,
      mediaKind: items.length > 1 ? 'carousel' : 'video',
      noWatermark: true,
      streamableFastStart: true,
      subtitles: [],
      qualities: items[0].qualities,
      items,
      headers: buildPlatformHeaders('threads', rawUrl, ua, videoUrls),
    };
  }

  if (imageUrls.length > 0) {
    const items: SocialMediaItem[] = imageUrls.map((iUrl, idx) => {
      const opt = buildOriginalImageOption({
        id: `threads-img-${idx + 1}`,
        imageUrl: iUrl,
        userAgent: ua,
      });
      return {
        id: `threads-img-${idx + 1}`,
        index: idx,
        kind: 'image',
        title: imageUrls.length > 1 ? `${title} (${idx + 1})` : title,
        ext: opt.ext,
        url: iUrl,
        qualities: [opt],
      };
    });

    return {
      ok: true,
      platform: 'threads',
      platformLabel: PLATFORM_LABELS.threads,
      postId: shortcode,
      title,
      author,
      durationSecs: 0,
      mediaKind: items.length > 1 ? 'carousel' : 'image',
      noWatermark: true,
      streamableFastStart: true,
      subtitles: [],
      qualities: items[0].qualities,
      items,
      headers: buildPlatformHeaders('threads', rawUrl, ua, imageUrls),
    };
  }

  return {
    ok: false,
    platform: 'threads',
    category: 'auth_blocked',
    title: 'Blocked or login required (update cookies)',
    message:
      'Threads blocked anonymous access to this post. Import your Meta/Instagram cookies.txt to download it.',
  };
}

// ============================================================================
// 6. PINTEREST EXTRACTOR (Video Pins & Original High-Res Image Pins)
// ============================================================================

async function probePinterest(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<SocialProbeResult | SocialProbeError> {
  const ua = USER_AGENTS.desktopChrome;
  const res = await fetchWithResilience(rawUrl, {
    signal,
    userAgent: ua,
    referer: 'https://www.pinterest.com/',
  });

  if (!res.ok || !res.text) {
    const err = classifyErrorFromStatus(res.status, res.text);
    return {
      ok: false,
      platform: 'pinterest',
      category: res.category,
      title: err.title,
      message: res.errorReason || err.message,
    };
  }

  const html = res.text;
  const pinIdMatch =
    res.url.match(/\/pin\/(?:[^/]*--)?(\d+)/i) ||
    rawUrl.match(/\/pin\/(\d+)/i);
  const postId = pinIdMatch?.[1] || String(Date.now());

  const titleMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title =
    (titleMatch
      ? decodeHtmlEntities(titleMatch[1])
          .replace(/\s*\|\s*Pinterest$/i, '')
          .trim()
          .slice(0, 100)
      : '') || `pinterest_${postId}`;

  // Extract direct `.mp4` streams from Pinterest `video_list` (`V_1080P`, `V_720P`, `V_EXP7`, etc.)
  const mp4Candidates: { url: string; height: number }[] = [];
  const seenMp4 = new Set<string>();
  for (const m of html.matchAll(
    /https:\/\/v1\.pinimg\.com\/videos\/[^\s"'\\]+\.mp4/gi,
  )) {
    const u = unescapeJsonString(m[0]);
    if (!seenMp4.has(u)) {
      seenMp4.add(u);
      const h = u.includes('1080p')
        ? 1080
        : u.includes('720p')
          ? 720
          : u.includes('480p')
            ? 480
            : 720;
      mp4Candidates.push({ url: u, height: h });
    }
  }

  if (mp4Candidates.length > 0) {
    mp4Candidates.sort((a, b) => b.height - a.height);
    const qualities: YouTubeQualityOption[] = mp4Candidates.map((c, idx) =>
      buildDirectVideoQualityOption({
        id: `pin-vid-${c.height}p-${idx}`,
        height: c.height,
        videoUrl: c.url,
        badge: 'No watermark',
        userAgent: ua,
      }),
    );
    qualities.push(
      buildSoundOnlyOption({
        sourceUrl: mp4Candidates[0].url,
        isDedicatedAudio: false,
        userAgent: ua,
      }),
    );

    return {
      ok: true,
      platform: 'pinterest',
      platformLabel: PLATFORM_LABELS.pinterest,
      postId,
      title,
      author: 'Pinterest',
      durationSecs: 0,
      mediaKind: 'video',
      noWatermark: true,
      streamableFastStart: true,
      subtitles: [],
      qualities,
      items: [
        {
          id: postId,
          index: 0,
          kind: 'video',
          title,
          ext: '.mp4',
          url: mp4Candidates[0].url,
          qualities,
        },
      ],
      headers: buildPlatformHeaders(
        'pinterest',
        res.url,
        ua,
        mp4Candidates.map((c) => c.url),
      ),
    };
  }

  // Extract highest-resolution original image (`i.pinimg.com/originals/...`)
  const origMatches = [
    ...html.matchAll(
      /https:\/\/i\.pinimg\.com\/originals\/[^\s"'\\]+\.(?:jpg|jpeg|png|webp|gif)/gi,
    ),
  ].map((m) => unescapeJsonString(m[0]));

  const ogImgMatch = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  );
  let bestImg = origMatches[0] || '';
  if (!bestImg && ogImgMatch) {
    // Upgrade `/736x/` or `/564x/` thumbnail URL to `/originals/`
    bestImg = decodeHtmlEntities(ogImgMatch[1]).replace(
      /\/(?:236x|474x|564x|736x)\//,
      '/originals/',
    );
  }

  if (bestImg) {
    const uniqueImgs = [...new Set([bestImg, ...origMatches])].slice(0, 12);
    const items: SocialMediaItem[] = uniqueImgs.map((u, idx) => {
      const opt = buildOriginalImageOption({
        id: `pin-img-${idx + 1}`,
        imageUrl: u,
        userAgent: ua,
      });
      return {
        id: `pin-img-${idx + 1}`,
        index: idx,
        kind: 'image',
        title: uniqueImgs.length > 1 ? `${title} (${idx + 1})` : title,
        ext: opt.ext,
        url: u,
        qualities: [opt],
      };
    });

    return {
      ok: true,
      platform: 'pinterest',
      platformLabel: PLATFORM_LABELS.pinterest,
      postId,
      title,
      author: 'Pinterest',
      durationSecs: 0,
      mediaKind: 'image',
      noWatermark: true,
      streamableFastStart: true,
      subtitles: [],
      qualities: items[0].qualities,
      items,
      headers: buildPlatformHeaders('pinterest', res.url, ua, [bestImg]),
    };
  }

  return {
    ok: false,
    platform: 'pinterest',
    category: 'deleted_private',
    title: 'Deleted or private post',
    message: 'Could not find a downloadable video or image on this Pinterest pin.',
  };
}

// ============================================================================
// UNIFIED MULTI-PLATFORM ROUTER & PROBE ENTRYPOINT
// ============================================================================

/**
 * Probes any supported Social Media or YouTube URL and returns the full quality ladder
 * (Best/4K, 1080p, 720p, 480p, 360p, Sound Only `.m4a`, or Original High-Res Image(s) / Carousels).
 */
export async function probeSocialMedia(
  rawUrl: string,
  probeStream?: ProbeStreamFn,
  signal?: AbortSignal,
): Promise<SocialProbeResult | SocialProbeError> {
  const normalized = normalizeSocialUrl(rawUrl);
  const platform = detectSocialPlatform(normalized);

  if (!platform) {
    return {
      ok: false,
      platform: null,
      category: 'generic',
      title: 'Unsupported link',
      message:
        'Paste a link from YouTube, Instagram, TikTok, Reddit, Facebook, Threads, Pinterest, or a direct file/torrent link.',
    };
  }

  if (platform === 'youtube') {
    const yt = await probeYouTube(normalized, probeStream, signal);
    if (!yt.ok) {
      const classified = classifyErrorFromStatus(403, yt.message, yt.message.includes('too long'));
      return {
        ok: false,
        platform: 'youtube',
        category: classified.category,
        title: classified.title,
        message: yt.message,
      };
    }

    // Relabel 'Audio only' as 'Sound only' / keep full compatibility
    const qualities = yt.qualities;
    const primaryUrl = qualities[0]?.url || normalized;
    const ua = qualities[0]?.userAgent || USER_AGENTS.mobileIos;

    return {
      ok: true,
      platform: 'youtube',
      platformLabel: PLATFORM_LABELS.youtube,
      postId: yt.videoId,
      title: yt.title,
      author: yt.author,
      durationSecs: yt.durationSecs,
      mediaKind: 'video',
      noWatermark: true,
      streamableFastStart: true,
      subtitles: yt.subtitles,
      qualities,
      items: [
        {
          id: yt.videoId,
          index: 0,
          kind: 'video',
          title: yt.title,
          ext: qualities[0]?.ext || '.mp4',
          url: primaryUrl,
          qualities,
        },
      ],
      headers: buildPlatformHeaders('youtube', normalized, ua, [primaryUrl]),
    };
  }

  switch (platform) {
    case 'tiktok':
      return probeTikTok(normalized, signal);
    case 'instagram':
      return probeInstagram(normalized, signal);
    case 'reddit':
      return probeReddit(normalized, signal);
    case 'facebook':
      return probeFacebook(normalized, signal);
    case 'threads':
      return probeThreads(normalized, signal);
    case 'pinterest':
      return probePinterest(normalized, signal);
  }
}
