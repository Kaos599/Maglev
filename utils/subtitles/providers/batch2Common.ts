/**
 * Small helpers shared by the batch 2 subtitle sources (page scrapers). Pure text helpers, plus two thin fetchers:
 * `httpPage` for HTML (tolerates a site that answers 500 with a real page) and `httpBytes` for downloads.
 */
import { ProviderError, USER_AGENT, httpText } from '../../search/http.ts';
import { isCloudflareChallenge } from '../../search/challenge.ts';
import { archiveKind, decodeSubtitleText, detectFormat } from '../payload.ts';
import type { SubFormat, SubtitlePayload, SubtitleQuery } from '../types.ts';

// ---------------------------------------------------------------- text

/** Lowercase words with accents folded: "Amélie, 2001" gives ["amelie", "2001"]. */
export function tokens(s: string | undefined | null): string[] {
  if (!s) return [];
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export const norm = (s: string | undefined | null): string => tokens(s).join(' ');

/** True when every word of `wanted` is a word of `candidate`. */
export function hasAllWords(wanted: string, candidate: string): boolean {
  const w = tokens(wanted);
  if (w.length === 0) return false;
  const c = new Set(tokens(candidate));
  return w.every((t) => c.has(t));
}

export function isEpisodeQuery(q: SubtitleQuery): q is SubtitleQuery & { season: number; episode: number } {
  return q.season !== undefined && q.episode !== undefined;
}

/** The title with a trailing "(2010)" or "(US)" style tag removed. */
export function withoutYear(title: string): string {
  return title.replace(/\s*\((?:19|20)\d{2}(?:\s*-\s*(?:19|20)?\d{0,4})?\)\s*$/, '').trim();
}

export function yearOf(text: string): number | undefined {
  const m = /\(((?:19|20)\d{2})\)/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** Season and episode pairs a release name states: S01E02, 1x02. */
export function episodePairs(text: string): [number, number][] {
  const out: [number, number][] = [];
  const t = norm(text);
  for (const m of t.matchAll(/\bs0*(\d{1,2}) ?e0*(\d{1,3})\b/g)) out.push([Number(m[1]), Number(m[2])]);
  for (const m of t.matchAll(/\b0*(\d{1,2})x0*(\d{1,3})\b/g)) out.push([Number(m[1]), Number(m[2])]);
  return out;
}

export function hasEpisode(text: string, season: number, episode: number): boolean {
  return episodePairs(text).some(([s, e]) => s === season && e === episode);
}

/** "Complete season 3", "S03" with no episode, or "season 3". A pack the unzip step can pick the episode from. */
export function isSeasonPack(text: string, season: number): boolean {
  const t = norm(text);
  if (new RegExp(`\\bcomplete (?:season|series) 0*${season}\\b`).test(t)) return true;
  if (new RegExp(`\\bseason 0*${season}\\b`).test(t) && episodePairs(text).length === 0) return true;
  return new RegExp(`\\bs0*${season}\\b(?! ?e\\d)`).test(t);
}

export function looksHearingImpaired(text: string): boolean {
  const t = tokens(text);
  return t.includes('hi') || t.includes('sdh') || /\bhearing[\W_]+impaired\b/i.test(text);
}

/** Percent-encodes what a URL path can't hold (spaces, brackets, non-ASCII) and leaves existing %XX alone. */
export function safePath(path: string): string {
  return path.replace(/[^A-Za-z0-9\-_.~()%/]/gu, (c) => encodeURIComponent(c));
}

export function absUrl(base: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const root = base.replace(/\/+$/, '');
  if (href.startsWith('/')) return root + href;
  return `${root}/${href}`;
}

// ---------------------------------------------------------------- HTTP

const CHALLENGE_PAGE = /just a moment|challenge-platform|cf-chl|checking your browser|captcha/i;

export interface PageOptions {
  signal: AbortSignal;
  referer?: string;
  /** Form fields, sent as a POST. */
  form?: Record<string, string>;
}

/**
 * An HTML page. `httpText` is used for everything it can handle; a site that answers 500 with its real page (the
 * moviesubtitles search) goes through `httpPageLoose`.
 */
export async function httpPage(url: string, o: PageOptions): Promise<string> {
  const headers: Record<string, string> = {};
  if (o.referer) headers.Referer = o.referer;
  return httpText(url, {
    signal: o.signal,
    accept: 'text/html',
    headers,
    ...(o.form ? { method: 'POST' as const, body: formBody(o.form), contentType: 'application/x-www-form-urlencoded' } : {}),
  });
}

export function formBody(form: Record<string, string>): string {
  return Object.keys(form)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(form[k])}`)
    .join('&');
}

/** Like `httpPage`, but a 500 that carries a page is read as that page. */
export async function httpPageLoose(url: string, o: PageOptions): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: o.form ? 'POST' : 'GET',
      signal: o.signal,
      credentials: 'omit',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html',
        ...(o.referer ? { Referer: o.referer } : {}),
        ...(o.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: o.form ? formBody(o.form) : undefined,
    });
  } catch (e) {
    if (o.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (o.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  if (isCloudflareChallenge(res.status, res.headers, text)) throw new ProviderError('challenge', 'Needs a quick check', res.status);
  if (res.status === 429) throw new ProviderError('http', 'Too many requests', 429);
  if (res.status === 403) throw new ProviderError('blocked', 'Blocked by a bot check', 403);
  if (res.status === 500 && /<(html|body|table)/i.test(text)) return text;
  if (!res.ok) throw new ProviderError('http', `HTTP ${res.status}`, res.status);
  return text;
}

export interface BytesOptions {
  signal: AbortSignal;
  referer?: string;
}

/** A download. A 429 is a limit; an HTML answer in place of a file is a bot check or an error page. */
export async function httpBytes(url: string, o: BytesOptions): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: o.signal,
      credentials: 'omit',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...(o.referer ? { Referer: o.referer } : {}) },
    });
  } catch (e) {
    if (o.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  if (res.status === 429) throw new ProviderError('http', 'Too many requests', 429);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (o.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  const type = res.headers.get('content-type') ?? '';
  if (/html/i.test(type) || looksHtml(bytes)) {
    const head = latin1(bytes.subarray(0, 4096));
    if (isCloudflareChallenge(res.status, res.headers, head) || CHALLENGE_PAGE.test(head)) throw new ProviderError('challenge', 'Needs a quick check', res.status);
    if (res.status === 403) throw new ProviderError('blocked', 'Blocked by a bot check', 403);
    throw new ProviderError(res.status >= 500 ? 'http' : 'parse', res.status >= 500 ? 'Not answering right now' : 'Unexpected response', res.status >= 500 ? res.status : undefined);
  }
  if (res.status === 403) throw new ProviderError('blocked', 'Blocked by a bot check', 403);
  if (!res.ok) throw new ProviderError('http', `HTTP ${res.status}`, res.status);
  return bytes;
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function looksHtml(b: Uint8Array): boolean {
  const head = latin1(b.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<body');
}

// ---------------------------------------------------------------- payload

export const UNSUPPORTED_ARCHIVE = "This subtitle's file type isn't supported";

/** Downloaded bytes to a payload: a zip stays a zip, text is typed by its content, RAR and 7z are refused. */
export function toPayload(bytes: Uint8Array, language?: string): SubtitlePayload {
  if (bytes.length === 0) throw new ProviderError('parse', 'Empty file');
  const kind = archiveKind(bytes);
  if (kind === 'zip') return { kind: 'zip', bytes };
  if (kind === 'rar' || kind === '7z') throw new ProviderError('parse', UNSUPPORTED_ARCHIVE);
  const r = decodeSubtitleText(bytes, language);
  const format: SubFormat = r.ok ? detectFormat(r.text) : 'srt';
  return { kind: 'text', bytes, format };
}
