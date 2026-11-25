// Video sites (docs/NATIVE_CONTRACT.md section 48, prototype). Pure helpers: which links are video pages, and the
// quality list built from the format list the native side reads from the page. Plain node can import this file.
import { formatBytes } from '../constants/format.ts';

/** Hosts whose links are video pages, not files. A subdomain counts (m.youtube.com, www.instagram.com). */
export const VIDEO_SITE_HOSTS: readonly string[] = [
  'youtube.com', 'youtu.be', 'x.com', 'twitter.com', 'instagram.com', 'reddit.com', 'vimeo.com', 'tiktok.com',
];

/** Most heights offered. */
export const MAX_QUALITIES = 6;

export function videoSiteHost(url: string): string | null {
  const m = /^https?:\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]+)/i.exec((url ?? '').trim());
  const host = m ? m[1].toLowerCase() : '';
  if (!host) return null;
  const hit = VIDEO_SITE_HOSTS.find((h) => host === h || host.endsWith(`.${h}`));
  return hit ?? null;
}

export function isVideoSiteUrl(url: string): boolean {
  return videoSiteHost(url) !== null;
}

/** One file to fetch. `size` is set only when the site states it exactly (it lets the engine fetch in ranged chunks). */
export interface VideoSitePart {
  url: string;
  headers: Record<string, string>;
  size: number | null;
}

export interface VideoSiteOption {
  id: string;
  /** "1080p · about 240 MB", "Audio only · 8 MB". */
  label: string;
  height: number | null;
  ext: string;
  estBytes: number | null;
  video: VideoSitePart;
  /** Set when the video file has no sound: the engine fetches both and joins them. */
  audio: VideoSitePart | null;
}

export interface VideoSiteInfo {
  title: string;
  thumbnail: string | null;
  durationSec: number | null;
  site: string;
  options: VideoSiteOption[];
}

export type VideoSiteErrorCode = 'SITE_NOT_SUPPORTED' | 'SITE_NEEDS_LOGIN' | 'SITE_FAILED' | 'SITE_NO_VIDEO' | 'VIDEO_SITES_UNAVAILABLE';

/** Plain-English messages. The native side sends the same ones; these cover a missing or unknown message. */
export const VIDEO_SITE_MESSAGES: Record<VideoSiteErrorCode, string> = {
  SITE_NOT_SUPPORTED: "Maglev can't read this site. Open it in the browser to find the video.",
  SITE_NEEDS_LOGIN: 'This site only shows the video to signed-in people. Open it in the browser, sign in and play it.',
  SITE_FAILED: "Couldn't read this video. Try again.",
  SITE_NO_VIDEO: "Maglev can't find a video it can save on this page. Open it in the browser to find the video.",
  VIDEO_SITES_UNAVAILABLE: "Video sites aren't available in this build.",
};

/** These two send the person to the browser instead of offering a retry. */
export function errorOffersBrowser(code: string | undefined): boolean {
  return code === 'SITE_NOT_SUPPORTED' || code === 'SITE_NEEDS_LOGIN' || code === 'SITE_NO_VIDEO';
}

export function videoSiteErrorMessage(code: string | undefined, message?: string | null): string {
  if (message && message.trim()) return message;
  return VIDEO_SITE_MESSAGES[(code ?? '') as VideoSiteErrorCode] ?? VIDEO_SITE_MESSAGES.SITE_FAILED;
}

interface RawFormat {
  format_id?: string;
  url?: string;
  ext?: string;
  vcodec?: string | null;
  acodec?: string | null;
  height?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  tbr?: number | null;
  abr?: number | null;
  protocol?: string;
  http_headers?: Record<string, string>;
}

interface Cand {
  fmt: RawFormat;
  index: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** Plain files only: a playlist (m3u8, DASH manifest) or a storyboard is not one. */
function isFile(f: RawFormat): boolean {
  return typeof f.url === 'string' && /^https:\/\//i.test(f.url) && f.protocol === 'https';
}

type Kind = 'audio' | 'video' | 'single';

/**
 * `vcodec: none` is audio only. A real video codec with `acodec: none` is video only. Anything else is one file with
 * sound (X reports neither codec; Instagram's plain files report a missing video codec and `acodec: none`).
 */
function kindOf(f: RawFormat): Kind {
  if (f.vcodec === 'none') return 'audio';
  if (f.acodec === 'none' && typeof f.vcodec === 'string' && f.vcodec !== '') return 'video';
  return 'single';
}

const quality = (c: Cand): number => num(c.fmt.tbr) ?? num(c.fmt.abr) ?? 0;

/** Highest bitrate wins; on a tie the later format wins (yt-dlp lists worst first). */
function best(list: Cand[]): Cand | null {
  let top: Cand | null = null;
  for (const c of list) {
    if (!top || quality(c) > quality(top) || (quality(c) === quality(top) && c.index > top.index)) top = c;
  }
  return top;
}

function part(f: RawFormat): VideoSitePart {
  return { url: f.url as string, headers: { ...(f.http_headers ?? {}) }, size: num(f.filesize) };
}

function sizeOf(f: RawFormat): number | null {
  return num(f.filesize) ?? num(f.filesize_approx);
}

/**
 * X lists each plain mp4 with a bitrate that is the peak the encoder was allowed (the 270p file says 288 kbps), so
 * yt-dlp's size from it is about twice the real file. The playlist version of the same picture reports the average
 * bitrate, which matches the real file within a few percent. Used only when both the playlist bitrate and the
 * duration are known; otherwise the size stays unknown.
 */
function xSizeOf(f: RawFormat, formats: RawFormat[], durationSec: number | null): number | null {
  const exact = num(f.filesize);
  if (exact) return exact;
  const h = num(f.height);
  if (!h || !durationSec) return null;
  const hls = formats.find((x) => num(x.height) === h && x.vcodec !== 'none' && x.protocol === 'm3u8_native' && num(x.tbr));
  const kbps = hls ? num(hls.tbr) : null;
  return kbps ? Math.round((kbps * 1000 * durationSec) / 8) : null;
}

function labelFor(prefix: string, est: number | null): string {
  return est ? `${prefix} · about ${formatBytes(est)}` : prefix;
}

/** The quality list for a page, from the trimmed format list. Never invents a size. */
export function buildVideoSiteInfo(raw: unknown): VideoSiteInfo {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawFormats: RawFormat[] = Array.isArray(r.formats) ? (r.formats as RawFormat[]) : [];
  const isX = r.extractor_key === 'Twitter';
  const all: Cand[] = (Array.isArray(r.formats) ? (r.formats as RawFormat[]) : [])
    .map((fmt, index) => ({ fmt, index }))
    .filter((c) => c.fmt && isFile(c.fmt));

  const audio = best(all.filter((c) => kindOf(c.fmt) === 'audio' && (c.fmt.ext === 'm4a' || /^mp4a/.test(c.fmt.acodec ?? '')) && !/-drc$/.test(c.fmt.format_id ?? '')));
  const videos = all.filter((c) => kindOf(c.fmt) === 'video' && c.fmt.ext === 'mp4' && /^avc[13]/.test(c.fmt.vcodec ?? '') && num(c.fmt.height));
  const singles = all.filter((c) => kindOf(c.fmt) === 'single' && (c.fmt.ext === 'mp4' || c.fmt.ext === 'm4v'));

  const heights = new Set<number | null>();
  for (const c of singles) heights.add(num(c.fmt.height));
  if (audio) for (const c of videos) heights.add(num(c.fmt.height));
  const ordered = [...heights].sort((a, b) => (b ?? -1) - (a ?? -1)).slice(0, MAX_QUALITIES);

  const options: VideoSiteOption[] = [];
  for (const h of ordered) {
    const single = best(singles.filter((c) => num(c.fmt.height) === h));
    const video = single ? null : best(videos.filter((c) => num(c.fmt.height) === h));
    const prefix = h ? `${h}p` : 'Video';
    if (single) {
      const est = isX ? xSizeOf(single.fmt, rawFormats, num(r.duration)) : sizeOf(single.fmt);
      options.push({
        id: String(single.fmt.format_id ?? `single-${single.index}`),
        label: labelFor(prefix, est),
        height: h,
        ext: single.fmt.ext ?? 'mp4',
        estBytes: est,
        video: part(single.fmt),
        audio: null,
      });
    } else if (video && audio) {
      const v = sizeOf(video.fmt);
      const a = sizeOf(audio.fmt);
      const est = v !== null && a !== null ? v + a : null;
      options.push({
        id: `${video.fmt.format_id ?? video.index}+${audio.fmt.format_id ?? audio.index}`,
        label: labelFor(prefix, est),
        height: h,
        ext: 'mp4',
        estBytes: est,
        video: part(video.fmt),
        audio: part(audio.fmt),
      });
    }
  }
  if (audio) {
    const est = sizeOf(audio.fmt);
    options.push({
      id: `audio-${audio.fmt.format_id ?? audio.index}`,
      label: labelFor('Audio only', est),
      height: null,
      ext: 'm4a',
      estBytes: est,
      video: part(audio.fmt),
      audio: null,
    });
  }

  const title = typeof r.title === 'string' ? r.title.trim() : '';
  return {
    title,
    thumbnail: typeof r.thumbnail === 'string' && r.thumbnail ? r.thumbnail : null,
    durationSec: num(r.duration),
    site: typeof r.extractor_key === 'string' ? r.extractor_key : '',
    options,
  };
}

/** The file name without its extension: the title, then the height when there is one ("Title 1080p"). */
export function suggestedBaseName(info: VideoSiteInfo, option: VideoSiteOption): string {
  const base = info.title || 'Video';
  return option.height ? `${base} ${option.height}p` : base;
}

/** The headers the engine understands, taken from a part's own (the engine sends one set for both files). */
export function engineHeaders(p: VideoSitePart): { Cookie?: string; Referer?: string; 'User-Agent'?: string; Origin?: string } {
  const out: { Cookie?: string; Referer?: string; 'User-Agent'?: string; Origin?: string } = {};
  for (const [k, v] of Object.entries(p.headers)) {
    const key = k.toLowerCase();
    if (key === 'cookie') out.Cookie = v;
    else if (key === 'referer') out.Referer = v;
    else if (key === 'user-agent') out['User-Agent'] = v;
    else if (key === 'origin') out.Origin = v;
  }
  return out;
}

/** `options.parts` of `addDownload` (section 48.2), or null for a single file. */
export function partsOption(option: VideoSiteOption): { video: { url: string; size?: number }; audio: { url: string; size?: number } } | null {
  if (!option.audio) return null;
  const side = (p: VideoSitePart) => (p.size ? { url: p.url, size: p.size } : { url: p.url });
  return { video: side(option.video), audio: side(option.audio) };
}
