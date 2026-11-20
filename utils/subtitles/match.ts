/**
 * Pure helpers shared by the subtitle sources: title and release matching, URL joining, small parsers.
 * No network here (see `http.ts`).
 */
import { ProviderError } from '../search/http.ts';
import { releaseSimilarity } from './payload.ts';
import type { SubtitleCandidate, SubtitleQuery } from './types.ts';

// ---------------------------------------------------------------- words and titles

/** Lowercase words with accents folded: "Amélie, 2001" gives ["amelie", "2001"]. */
export function tokens(s: string | undefined | null): string[] {
  if (!s) return [];
  let t = String(s);
  try {
    t = t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  } catch {
    // keep as is
  }
  return t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The words of `tokens` joined by single spaces. */
export function fold(s: string | undefined | null): string {
  return tokens(s).join(' ');
}

export const norm = fold;

/** True when every word of `wanted` is a word of `candidate`. */
export function hasAllWords(wanted: string | undefined | null, candidate: string | undefined | null): boolean {
  const w = tokens(wanted);
  if (w.length === 0) return false;
  const c = new Set(tokens(candidate));
  return w.every((t) => c.has(t));
}

/** Same rule as `hasAllWords`; the name the page-scraping sources use. */
export const titleMatches = hasAllWords;

/** Lowercase words and digits only (Latin, Cyrillic, Greek), for comparing titles word for word. */
export function words(s: string | undefined | null): string[] {
  return (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9Ѐ-ӿͰ-Ͽ]+/).filter(Boolean);
}

/** Two titles with the same words in the same order. */
export function sameTitle(a: string | undefined | null, b: string | undefined | null): boolean {
  const x = words(a);
  const y = words(b);
  return x.length > 0 && x.length === y.length && x.every((w, i) => w === y[i]);
}

const FOLD: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', ı: 'i' };

/** Lower case, accents folded, "&" as "and", everything but letters and digits turned into single spaces. */
export function normTitle(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[ßæœøđłı]/g, (c) => FOLD[c] ?? c)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const noThe = (s: string) => s.replace(/^the /, '');

/** True when two titles are the same after `normTitle` (a leading "The" doesn't count). */
export function sameTitleStrict(a: string, b: string): boolean {
  const x = noThe(normTitle(a));
  const y = noThe(normTitle(b));
  return x.length > 0 && x === y;
}

/** True when `title` equals the wanted title or one of its " / " or "(aka ...)" parts. */
export function titleMatchesAlias(wanted: string, title: string): boolean {
  if (sameTitleStrict(wanted, title)) return true;
  const parts = title.split(/\s+\/\s+|\s*\(aka\.?\s+|\s+aka\.?\s+/i).map((p) => p.replace(/\)\s*$/, ''));
  return parts.length > 1 && parts.some((p) => sameTitleStrict(wanted, p));
}

/** The title with a trailing "(2010)" or "(US)" style tag removed. */
export function withoutYear(title: string): string {
  return title.replace(/\s*\((?:19|20)\d{2}(?:\s*-\s*(?:19|20)?\d{0,4})?\)\s*$/, '').trim();
}

export function yearOf(text: string): number | undefined {
  const m = /\(((?:19|20)\d{2})\)/.exec(text);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------- episodes and releases

export function isEpisodeQuery(q: SubtitleQuery): q is SubtitleQuery & { season: number; episode: number } {
  return q.season !== undefined && q.episode !== undefined;
}

/** Season and episode when the file name is known to be an episode; the sources have no use for a guess. */
export function episodeOf(q: { season?: number; episode?: number }): { season: number; episode: number } | null {
  return q.season !== undefined && q.episode !== undefined ? { season: q.season, episode: q.episode } : null;
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

/** 'release' when the listed release name resembles the video's file name, otherwise 'title'. */
export function matchKind(q: Pick<SubtitleQuery, 'fileName'>, releaseName: string): SubtitleCandidate['matchedBy'] {
  return releaseName && releaseSimilarity(releaseName, q.fileName) >= 0.45 ? 'release' : 'title';
}

/**
 * Some listings put every release a file fits in one comment ("A.B.2019-X; A.B.2019.720p-Y si ..."). This picks the one
 * closest to the video's file name; with none close, the first, cut to a readable length.
 */
export function bestRelease(q: Pick<SubtitleQuery, 'fileName'>, text: string): { name: string; matchedBy: SubtitleCandidate['matchedBy'] } {
  const parts = text
    .split(/\||;|\s+si\s+|\s+(?=\S+\.\S+\.\S+\.\S+)/i)
    .map((p) => p.replace(/[\s.]+$/, '').trim())
    .filter((p) => p.length > 2);
  let best = '';
  let bestScore = -1;
  for (const p of parts) {
    const sc = releaseSimilarity(p, q.fileName);
    if (sc > bestScore) {
      best = p;
      bestScore = sc;
    }
  }
  if (!best) return { name: text.slice(0, 120).trim(), matchedBy: 'title' };
  return bestScore >= 0.45 ? { name: best, matchedBy: 'release' } : { name: (parts[0] ?? best).slice(0, 120), matchedBy: 'title' };
}

/** "2026-06-03" or "26.11.2009" to epoch milliseconds (UTC); undefined when it isn't a date. */
export function parseDate(s: string): number | undefined {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const dmy = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : dmy ? [+dmy[3], +dmy[2], +dmy[1]] : [0, 0, 0];
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return Date.UTC(y, m - 1, d);
}

// ---------------------------------------------------------------- URLs

export function stripSlash(base: string): string {
  return base.replace(/\/+$/, '');
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

/** `href` resolved against the page it was found on. Handles absolute, protocol-relative, root-relative and relative. */
export function resolveHref(pageUrl: string, href: string): string {
  const h = href.trim();
  if (/^https?:\/\//i.test(h)) return h;
  const m = /^(https?:\/\/[^/?#]+)([^?#]*)/i.exec(pageUrl);
  if (!m) return h;
  if (h.startsWith('//')) return `${/^https?:/i.exec(pageUrl)?.[0] ?? 'https:'}${h}`;
  if (h.startsWith('/')) return m[1] + h;
  const dir = m[2].replace(/[^/]*$/, '');
  const parts = (dir + h).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  }
  return m[1] + out.join('/').replace(/^\/*/, '/');
}

/** "https://host/a/b?x=1" -> "/a/b?x=1": what a candidate id keeps, so any mirror host can serve it. */
export function pathOf(url: string): string {
  const m = /^https?:\/\/[^/?#]+(.*)$/i.exec(url);
  return m ? m[1] || '/' : url;
}

export function joinBase(base: string, path: string): string {
  return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

/** A JSON array body as a list of loose objects; anything else (a page, an object) is an empty list. */
export function parseJsonList(body: string): any[] {
  try {
    const v = JSON.parse(body);
    return Array.isArray(v) ? v : [];
  } catch {
    if (/^\s*<(!doctype|html)/i.test(body)) throw new ProviderError('blocked', 'Blocked by a bot check');
    throw new ProviderError('parse', 'Unexpected response');
  }
}
