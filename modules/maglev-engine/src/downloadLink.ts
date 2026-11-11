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
