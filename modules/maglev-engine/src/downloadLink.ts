/**
 * Pure helpers for links that start a download (NATIVE_CONTRACT 17). Shared by the add screen, the share
 * handler and the simulator, so all three accept and refuse the same text. The engine repeats the check:
 * only `http` and `https` start a download (SM-30, the first two rows).
 */

export type UrlCheck = { ok: true; url: string; display: string } | { ok: false; code: 'INVALID_SOURCE' };

const HTTP_URL = /^(https?):\/\/([^\s/?#]+)([^\s?#]*)(\?[^\s#]*)?(#\S*)?$/i;

function hostOf(authority: string): string {
  return authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
}

/** `scheme://host[:port]/path` without user name, password, query or fragment. Safe to show. */
export function displayUrl(url: string): string {
  const m = HTTP_URL.exec(url.trim());
  if (!m) return '';
  return `${m[1].toLowerCase()}://${hostOf(m[2])}${m[3] || '/'}`;
}

/** Accepts one http or https link with a host. Anything else is INVALID_SOURCE. */
export function parseDownloadUrl(raw: string): UrlCheck {
  const url = (raw ?? '').trim();
  const m = HTTP_URL.exec(url);
  if (!m) return { ok: false, code: 'INVALID_SOURCE' };
  const host = hostOf(m[2]);
  if (!host || host.startsWith(':')) return { ok: false, code: 'INVALID_SOURCE' };
  return { ok: true, url, display: displayUrl(url) };
}

/** True when the link points at a .torrent file. Those go through the torrent flow, not the download flow. */
export function isTorrentUrl(url: string): boolean {
  return /\.torrent$/i.test(url.trim().split(/[?#]/)[0]);
}

/** A link the download flow handles: http(s) and not a .torrent file. */
export function isDownloadLink(text: string): boolean {
  const t = (text ?? '').trim();
  return parseDownloadUrl(t).ok && !isTorrentUrl(t);
}

/** The first http(s) link inside shared text ("Look at this https://x.test/a.zip"). Trailing punctuation is dropped. */
export function extractHttpUrl(text: string): string | null {
  const m = /https?:\/\/[^\s"'<>]+/i.exec(text ?? '');
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?)\]}]+$/, '');
  return parseDownloadUrl(url).ok ? url : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A magnet or a link to a .torrent file. Those belong to the Add torrent screen, not the download screen. */
export function isTorrentSource(text: string): boolean {
  const t = (text ?? '').trim();
  if (/^magnet:/i.test(t)) return true;
  return parseDownloadUrl(t).ok && isTorrentUrl(t);
}

/**
 * What pasted or typed text means: a magnet stays whole, otherwise the first web link inside it
 * ("Get it here https://x/a.zip" gives "https://x/a.zip"), otherwise the trimmed text unchanged.
 */
export function normalizeIncoming(text: string): string {
  const t = (text ?? '').trim();
  if (/^magnet:/i.test(t)) return t;
  return extractHttpUrl(t) ?? t;
}

function decodeKey(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/**
 * Removes every `from` query parameter (compared after decoding, so `%66rom=share` goes too) from a route
 * or URL. The share handler is the only code that may add `from=share`; anything arriving from outside
 * (a `maglev://` link) passes through this first, so it cannot claim to be a share.
 */
export function stripShareMarker(path: string): string {
  const s = path ?? '';
  const q = s.indexOf('?');
  if (q < 0) return s;
  const hashAt = s.indexOf('#', q);
  const query = s.slice(q + 1, hashAt < 0 ? undefined : hashAt);
  const tail = hashAt < 0 ? '' : s.slice(hashAt);
  const kept = query.split('&').filter((p) => p !== '' && decodeKey(p.split('=')[0]).trim().toLowerCase() !== 'from');
  return s.slice(0, q) + (kept.length ? `?${kept.join('&')}` : '') + tail;
}

/** The route the share handler uses for a shared web link. Only this route carries the share marker. */
export function sharedDownloadRoute(url: string): string {
  return `/add-download?url=${encodeURIComponent(url)}&from=share`;
}

/** True only when the screen was opened by the share handler with a link. */
export function isShareOpen(params: { url?: unknown; from?: unknown }): boolean {
  return params.from === 'share' && typeof params.url === 'string' && params.url.trim().length > 0;
}

/** Makes a name safe as a single file name. Same rules as the engine's sanitiser, for display and the simulator. */
export function sanitizeFileName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = last
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '_')
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
    .replace(/^[ .]+|[ .]+$/g, '');
  return cleaned || 'download';
}

/** The file name a link suggests: its last path segment. */
export function nameFromUrl(url: string): string {
  const m = HTTP_URL.exec(url.trim());
  if (!m) return 'download';
  const seg = m[3].split('/').filter(Boolean).pop();
  return seg ? sanitizeFileName(safeDecode(seg)) : 'download';
}
