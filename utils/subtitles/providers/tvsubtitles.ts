// Ported from LavX/bazarr-provider-catalog, providers/tvsubtitles (MIT), https://github.com/LavX/bazarr-provider-catalog/tree/main/providers/tvsubtitles
// Episodes only. Search finds the show, the show's season page finds the episode, the episode page lists subtitles.
import type { SubtitleCandidate, SubtitleContext, SubtitlePayload, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { ProviderError } from '../../search/http.ts';
import { stripTags, toInt } from '../../search/text.ts';
import { languageRank, normalizeLanguage } from '../languages.ts';
import { httpBytes, httpPage, toPayload } from '../http.ts';
import { absUrl, hasAllWords, isEpisodeQuery, norm, safePath, withoutYear, yearOf } from '../match.ts';

export const ID = 'tvsubtitles';

export interface TvShow {
  id: string;
  title: string;
  year?: number;
}

/** The shows a search page lists ("Breaking Bad (2008-2013)"). */
export function parseShows(html: string): TvShow[] {
  const out: TvShow[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']\/?tvshow-(\d+)(?:-\d+)?\.html["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = stripTags(m[2]);
    if (!text || seen.has(m[1])) continue;
    seen.add(m[1]);
    const year = /\(((?:19|20)\d{2})/.exec(text);
    out.push({ id: m[1], title: text.replace(/\s*\((?:19|20)\d{2}[^)]*\)\s*$/, '').trim(), year: year ? Number(year[1]) : undefined });
  }
  return out;
}

/** The show: same name as asked (a "(US)" or "(UK)" tag counts as part of the name), then one that has all the words. */
export function pickShow(shows: TvShow[], title: string, year?: number): TvShow | null {
  const want = norm(withoutYear(title));
  const wantBare = norm(withoutYear(title).replace(/\s*\((?:us|uk)\)\s*$/i, ''));
  const yearOk = (s: TvShow) => year === undefined || s.year === undefined || s.year === year;
  const pools: ((s: TvShow) => boolean)[] = [
    (s) => norm(s.title) === want,
    (s) => norm(s.title.replace(/\s*\((?:us|uk)\)\s*$/i, '')) === wantBare,
    (s) => hasAllWords(title, s.title),
  ];
  for (const ok of pools) {
    const hit = shows.find((s) => ok(s) && yearOk(s));
    if (hit) return hit;
  }
  return null;
}

/** episode number -> episode page id, from a season page. */
export function parseEpisodes(html: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const n = /(\d+)x(\d+)/i.exec(stripTags(row[1]));
    const page = /episode-(\d+)\.html/i.exec(row[1]);
    if (n && page) out.set(Number(n[2]), page[1]);
  }
  return out;
}

export interface TvRow {
  id: string;
  language: string;
  releaseName: string;
  downloads?: number;
}

const FLAGS: Record<string, string> = { br: 'pt-BR', cn: 'zh', cz: 'cs', gr: 'el', jp: 'ja', ua: 'uk', se: 'sv', dk: 'da', kr: 'ko', il: 'he' };

/** The subtitles on an episode page, language from the flag (or the heading above the block). */
export function parseEpisode(html: string): TvRow[] {
  const out: TvRow[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']\/?subtitle-(\d+)\.html["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const chunk = m[2];
    if (!/subtitlen/.test(chunk)) continue;
    const flag = /flags\/([a-z]{2})\.(?:gif|png)/i.exec(chunk)?.[1].toLowerCase();
    let language: string | null = flag ? FLAGS[flag] ?? normalizeLanguage(flag) : null;
    if (!language) {
      const heads = Array.from(html.slice(0, m.index).matchAll(/<b>\s*([^<]+?)\s+subtitles\s*<\/b>/gi));
      const label = heads.length ? heads[heads.length - 1][1] : '';
      language = /\(br\)/i.test(label) ? 'pt-BR' : normalizeLanguage(label);
    }
    if (!language) continue;
    const h5 = /<h5\b[^>]*>([\s\S]*?)<\/h5>/i.exec(chunk);
    const name = h5 ? stripTags(h5[1]) : '';
    if (!name) continue;
    const dl = /<p\b[^>]*title=["']downloaded["'][^>]*>([\s\S]*?)<\/p>/i.exec(chunk);
    out.push({ id: m[1], language, releaseName: name, downloads: dl ? toInt(stripTags(dl[1])) : undefined });
  }
  return out;
}

/** The file the download page redirects to: it is split over `var s1 = '..'; var s2 = '..';` pieces. */
export function parseFilePath(html: string): string | null {
  const parts: [number, string][] = [];
  for (const m of html.matchAll(/var\s+s(\d+)\s*=\s*['"]([^'"]+)['"]/gi)) parts.push([Number(m[1]), m[2]]);
  if (parts.length === 0) return null;
  parts.sort((a, b) => a[0] - b[0]);
  return parts.map((p) => p[1]).join('');
}

export const tvsubtitles: SubtitleProvider = {
  id: ID,
  name: 'TVsubtitles.net',
  homepage: 'https://www.tvsubtitles.net',
  mirrors: ['https://www.tvsubtitles.net'],
  languages: ['ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'fi', 'fr', 'hu', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'pt-BR', 'ro', 'ru', 'es', 'sv', 'tr', 'uk', 'zh'],
  kinds: ['episode'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q: SubtitleQuery, ctx: SubtitleContext): Promise<SubtitleCandidate[]> {
    if (!isEpisodeQuery(q) || !q.title.trim()) return [];
    const base = ctx.baseUrl;
    const found = await httpPage(`${base}/search2.php`, { signal: ctx.signal, form: { qs: withoutYear(q.title) } });
    const show = pickShow(parseShows(found), q.title, q.year);
    if (!show) return [];
    // A season the show doesn't have is a 404: no subtitles, not a failure.
    const missing = (e: unknown) => e instanceof ProviderError && e.kind === 'http' && e.status === 404;
    let page: string;
    try {
      const season = await httpPage(`${base}/tvshow-${show.id}-${q.season}.html`, { signal: ctx.signal, referer: `${base}/` });
      const episodeId = parseEpisodes(season).get(q.episode);
      if (!episodeId) return [];
      page = await httpPage(`${base}/episode-${episodeId}.html`, { signal: ctx.signal, referer: `${base}/tvshow-${show.id}-${q.season}.html` });
    } catch (e) {
      if (missing(e)) return [];
      throw e;
    }
    const out: SubtitleCandidate[] = [];
    for (const r of parseEpisode(page)) {
      if (languageRank(r.language, q.languages) === Infinity) continue;
      out.push({ providerId: ID, id: r.id, language: r.language, releaseName: r.releaseName, matchedBy: 'title', downloads: r.downloads });
    }
    return out;
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext): Promise<SubtitlePayload> {
    const page = absUrl(ctx.baseUrl, `/download-${encodeURIComponent(c.id)}.html`);
    const html = await httpPage(page, { signal: ctx.signal, referer: absUrl(ctx.baseUrl, `/subtitle-${encodeURIComponent(c.id)}.html`) });
    const path = parseFilePath(html);
    if (!path) throw new ProviderError('parse', 'Unexpected response');
    return toPayload((await httpBytes(absUrl(ctx.baseUrl, safePath(path.replace(/^\/+/, ''))), { signal: ctx.signal, referer: page })).bytes, c.language);
  },
};
