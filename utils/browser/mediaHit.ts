/**
 * A long press on an image or a video in a page: parse what the page script sent, classify it, and build the
 * menu as data. Pure: no React, no native modules, no URL global (Hermes' URL is partial), so
 * scripts/test-media-hit.js runs it directly.
 *
 * The page script is utils/browser/mediaHitScript.ts. Everything it sends is untrusted: every field is checked here.
 */
import { streamKindOfLink } from '../../components/browser/streamChoice.ts';

export type MediaKind = 'image' | 'video';
/** direct: a plain http(s) file. hls / dash: a manifest, handed to the stream path. blob: MediaSource or a blob: address. data: inline. none: no address at all. */
export type VideoClass = 'direct' | 'hls' | 'dash' | 'blob' | 'data' | 'none';

export interface MediaHit {
  kind: MediaKind;
  /** Absolute http(s) address, or null when the page gave none we can use. */
  url: string | null;
  /** What the raw address was when it is not usable: blob, data, or none. Null when `url` is set. */
  unusable: 'blob' | 'data' | 'none' | null;
  /** Videos only. */
  videoClass: VideoClass | null;
  /** Absolute http(s) poster address of a video. */
  poster: string | null;
  /** Absolute http(s) address of the link the element sits in, or a magnet: address. */
  linkHref: string | null;
  alt: string;
  pageUrl: string;
}

export type MenuItemId =
  | 'save-image'
  | 'download-video'
  | 'download-stream'
  | 'save-poster'
  | 'open-tab'
  | 'copy'
  | 'share'
  | 'show-found'
  | 'link-options';

export interface MenuItem {
  id: MenuItemId;
  title: string;
  icon: 'download' | 'plus' | 'copy' | 'share' | 'folder' | 'link' | 'stream';
  /** The address the row acts on. Null for show-found and link-options. */
  url: string | null;
}

export interface MediaMenu {
  /** One quiet line under the rows when something cannot be saved, or null. */
  note: string | null;
  items: MenuItem[];
}

export const mediaMenuCopy = {
  saveImage: 'Save image',
  openImageNewTab: 'Open image in new tab',
  copyImageAddress: 'Copy image address',
  shareImageLink: 'Share image link',
  downloadVideo: 'Download video',
  downloadStream: 'Download stream',
  savePoster: 'Save preview image',
  openVideoNewTab: 'Open video in new tab',
  copyVideoAddress: 'Copy video address',
  showFound: 'Show files found on this page',
  linkOptions: 'Link options',
  imageInline: "This image is part of the page, so Maglev can't save it from here.",
  videoBlob: "This video plays in a way Maglev can't save directly. Try the files found on this page.",
  videoInline: "This video is part of the page, so Maglev can't save it from here.",
  videoNone: 'This video has no address Maglev can save.',
} as const;

const MAX_URL = 4096;
const MAX_TEXT = 300;

/** Splits "scheme://authority/path?query#frag". Null when it is not an absolute hierarchical address. */
function split(u: string) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(u);
  return m ? { scheme: m[1].toLowerCase(), auth: m[2], path: m[3] || '/', query: m[4] ?? '', frag: m[5] ?? '' } : null;
}

function normalizePath(path: string): string {
  const out: string[] = [];
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const last = i === parts.length - 1;
    if (p === '..') {
      if (out.length > 1) out.pop();
      if (last) out.push('');
    } else if (p === '.') {
      if (last) out.push('');
    } else out.push(p);
  }
  const joined = out.join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/**
 * Resolves `ref` against the page address. Returns an absolute http(s) address, or null for anything else
 * (blob:, data:, javascript:, file:, empty, junk). Fragments are dropped.
 */
export function resolveHttpUrl(ref: unknown, pageUrl: string): string | null {
  if (typeof ref !== 'string') return null;
  const r = ref.trim();
  if (!r || r.length > MAX_URL || /[\u0000-\u001f\u007f\s]/.test(r)) return null;
  const abs = split(r);
  if (abs) {
    if (abs.scheme !== 'http' && abs.scheme !== 'https') return null;
    return `${abs.scheme}://${abs.auth}${normalizePath(abs.path)}${abs.query}`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(r)) return null; // blob:, data:, javascript:, mailto: ...
  const base = split(pageUrl);
  if (!base || (base.scheme !== 'http' && base.scheme !== 'https')) return null;
  const origin = `${base.scheme}://${base.auth}`;
  if (r.startsWith('//')) return resolveHttpUrl(`${base.scheme}:${r}`, pageUrl);
  if (r.startsWith('#')) return `${origin}${base.path}${base.query}`;
  if (r.startsWith('?')) return `${origin}${base.path}${r.replace(/#.*$/, '')}`;
  const noFrag = r.replace(/#.*$/, '');
  if (noFrag.startsWith('/')) return `${origin}${normalizePath(noFrag.split('?')[0])}${noFrag.includes('?') ? `?${noFrag.split('?').slice(1).join('?')}` : ''}`;
  const [p, ...q] = noFrag.split('?');
  const dir = base.path.slice(0, base.path.lastIndexOf('/') + 1);
  return `${origin}${normalizePath(dir + p)}${q.length ? `?${q.join('?')}` : ''}`;
}

/** The first non-http raw address kind, for choosing what to tell the user. */
function unusableKind(raw: unknown): 'blob' | 'data' | 'none' {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s.startsWith('blob:')) return 'blob';
  if (s.startsWith('data:')) return 'data';
  return 'none';
}

/** Magnet addresses are allowed on the link only. */
function resolveLink(ref: unknown, pageUrl: string): string | null {
  if (typeof ref === 'string' && /^magnet:\?/i.test(ref.trim()) && ref.length <= MAX_URL) return ref.trim();
  return resolveHttpUrl(ref, pageUrl);
}

const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT) : '');

/** "hls", "dash", "direct" for an http(s) address, by its path. */
export function classifyVideoUrl(url: string): 'direct' | 'hls' | 'dash' {
  return streamKindOfLink(url) ?? 'direct';
}

/**
 * Parses what the page script posted: a JSON string or an object `{type:'maglev-media-hit', kind, src, poster?,
 * linkHref?, alt?, pageUrl}`. Returns null for anything else, for a kind of `link` (the native link menu owns
 * those) and for a payload with no media at all.
 */
export function parseMediaHit(raw: unknown): MediaHit | null {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > 32768) return null;
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object') return null;
  const p = o as Record<string, unknown>;
  if (p.type !== 'maglev-media-hit') return null;
  if (p.kind !== 'image' && p.kind !== 'video') return null;
  const pageUrl = typeof p.pageUrl === 'string' && split(p.pageUrl) ? p.pageUrl : '';
  const url = resolveHttpUrl(p.src, pageUrl);
  const poster = resolveHttpUrl(p.poster, pageUrl);
  const linkHref = resolveLink(p.linkHref, pageUrl);
  if (!url && !poster && p.src == null) return null;
  const unusable = url ? null : unusableKind(p.src);
  let videoClass: VideoClass | null = null;
  if (p.kind === 'video') videoClass = url ? classifyVideoUrl(url) : unusable === 'blob' ? 'blob' : unusable === 'data' ? 'data' : 'none';
  return { kind: p.kind, url, unusable, videoClass, poster: p.kind === 'video' ? poster : null, linkHref, alt: text(p.alt), pageUrl };
}

/** The menu for a hit. Image and video rows first, then "Link options" when the element sits in a link. */
export function buildMediaMenu(hit: MediaHit): MediaMenu {
  const C = mediaMenuCopy;
  const items: MenuItem[] = [];
  let note: string | null = null;
  if (hit.kind === 'image') {
    if (hit.url) {
      items.push(
        { id: 'save-image', title: C.saveImage, icon: 'download', url: hit.url },
        { id: 'open-tab', title: C.openImageNewTab, icon: 'plus', url: hit.url },
        { id: 'copy', title: C.copyImageAddress, icon: 'copy', url: hit.url },
        { id: 'share', title: C.shareImageLink, icon: 'share', url: hit.url },
      );
    } else note = C.imageInline;
  } else {
    const cls = hit.videoClass;
    if (hit.url && cls === 'direct') items.push({ id: 'download-video', title: C.downloadVideo, icon: 'download', url: hit.url });
    else if (hit.url && (cls === 'hls' || cls === 'dash')) items.push({ id: 'download-stream', title: C.downloadVideo, icon: 'stream', url: hit.url });
    else {
      if (hit.poster) items.push({ id: 'save-poster', title: C.savePoster, icon: 'download', url: hit.poster });
      note = cls === 'blob' ? C.videoBlob : cls === 'data' ? C.videoInline : C.videoNone;
      items.push({ id: 'show-found', title: C.showFound, icon: 'folder', url: null });
    }
    if (hit.url) {
      items.push(
        { id: 'open-tab', title: C.openVideoNewTab, icon: 'plus', url: hit.url },
        { id: 'copy', title: C.copyVideoAddress, icon: 'copy', url: hit.url },
      );
    }
  }
  if (hit.linkHref) items.push({ id: 'link-options', title: C.linkOptions, icon: 'link', url: hit.linkHref });
  return { note, items };
}

/** True when the menu has anything to show (a row or a note). */
export function hasMenu(m: MediaMenu): boolean {
  return m.items.length > 0 || m.note != null;
}
