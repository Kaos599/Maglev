// Ported from LavX/bazarr-provider-catalog, providers/yifysubtitles (MIT), https://github.com/LavX/bazarr-provider-catalog/tree/main/providers/yifysubtitles
// Movies only. The site is keyed by IMDb id: its own title search (/ajax/search/) turns a title into one.
import type { SubtitleCandidate, SubtitleContext, SubtitlePayload, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { ProviderError, httpText, parseJson } from '../../search/http.ts';
import { decodeEntities, stripTags } from '../../search/text.ts';
import { languageRank, normalizeLanguage } from '../languages.ts';
import { httpBytes, httpPage, toPayload } from '../http.ts';
import { absUrl, hasAllWords, isEpisodeQuery, looksHearingImpaired, tokens, withoutYear } from '../match.ts';

export const ID = 'yifysubtitles';

/** The site's language labels that differ from plain names. */
const LABELS: Record<string, string> = {
  'Brazilian Portuguese': 'pt-BR',
  'Brazillian Portuguese': 'pt-BR',
  'Chinese BG code': 'zh-CN',
  'Big 5 code': 'zh-TW',
  'Farsi/Persian': 'fa',
};

export interface YifyRow {
  id: string;
  language: string;
  releaseName: string;
  path: string;
  hearingImpaired: boolean;
  rating: number;
}

/** The subtitle rows of a movie page (/movie-imdb/<id>). Rows in a language we don't list are skipped. */
export function parseMovieRows(html: string): YifyRow[] {
  const out: YifyRow[] = [];
  for (const m of html.matchAll(/<tr\b[^>]*\bdata-id="(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const body = m[2];
    const label = /<span\b[^>]*class=['"][^'"]*sub-lang[^'"]*['"][^>]*>([\s\S]*?)<\/span>/i.exec(body);
    const link = /<a\b[^>]*href="(\/subtitles\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(body);
    if (!label || !link) continue;
    const name = stripTags(label[1]);
    const language = LABELS[name] ?? normalizeLanguage(name);
    if (!language) continue;
    // The release cell holds one or more names separated by <br>; the first is the one to show.
    const first = link[2]
      .replace(/<span\b[^>]*class=['"][^'"]*text-muted[^'"]*['"][^>]*>[\s\S]*?<\/span>/i, '')
      .split(/<br\s*\/?>/i)
      .map((s) => stripTags(s))
      .find((s) => s.length > 0);
    if (!first) continue;
    const rating = Number(/class="rating-cell"[^>]*>[\s\S]*?>\s*(-?\d+)\s*</i.exec(body)?.[1] ?? 0);
    out.push({
      id: m[1],
      language,
      releaseName: first,
      path: decodeEntities(link[1]),
      hearingImpaired: /hi-subtitle/i.test(body) || looksHearingImpaired(first),
      rating: Number.isFinite(rating) ? rating : 0,
    });
  }
  return out;
}

/** The IMDb id for the title from the /ajax/search/ answer: [{movie: "Inception 2010", imdb: "tt1375666"}]. */
export function pickImdb(json: unknown, title: string, year?: number): string | null {
  if (!Array.isArray(json)) return null;
  const wanted = tokens(title).join(' ');
  let loose: string | null = null;
  for (const it of json) {
    const movie = typeof it?.movie === 'string' ? it.movie : '';
    const imdb = typeof it?.imdb === 'string' && /^tt\d+$/.test(it.imdb) ? it.imdb : '';
    if (!movie || !imdb) continue;
    const m = /^(.*?)\s+((?:19|20)\d{2})$/.exec(movie.trim());
    const name = tokens(m ? m[1] : movie).join(' ');
    const y = m ? Number(m[2]) : undefined;
    if (name === wanted && (year === undefined || y === undefined || y === year)) return imdb;
    if (!loose && hasAllWords(title, m ? m[1] : movie) && (year === undefined || y === year)) loose = imdb;
  }
  return loose;
}

/** The zip link on a subtitle page. */
export function parseDownloadPath(html: string): string | null {
  const m = /<a\b[^>]*class=['"][^'"]*download-subtitle[^'"]*['"][^>]*>/i.exec(html);
  const href = m && /href=['"]([^'"]+)['"]/i.exec(m[0]);
  return href ? decodeEntities(href[1]) : null;
}

export const yifysubtitles: SubtitleProvider = {
  id: ID,
  name: 'YIFY Subtitles',
  homepage: 'https://yifysubtitles.ch',
  mirrors: ['https://yifysubtitles.ch'],
  languages: 'many',
  kinds: ['movie'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q: SubtitleQuery, ctx: SubtitleContext): Promise<SubtitleCandidate[]> {
    if (isEpisodeQuery(q) || !q.title.trim()) return [];
    const base = ctx.baseUrl;
    const title = withoutYear(q.title);
    const found = await httpText(`${base}/ajax/search/?mov=${encodeURIComponent(title)}`, { signal: ctx.signal, accept: 'application/json', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const imdb = pickImdb(parseJson(found), title, q.year);
    if (!imdb) return [];
    const html = await httpPage(`${base}/movie-imdb/${imdb}`, { signal: ctx.signal, referer: `${base}/` });
    const out: SubtitleCandidate[] = [];
    for (const r of parseMovieRows(html)) {
      if (languageRank(r.language, q.languages) === Infinity) continue;
      out.push({
        providerId: ID,
        id: r.path,
        language: r.language,
        releaseName: r.releaseName,
        hearingImpaired: r.hearingImpaired,
        matchedBy: 'title',
      });
    }
    return out;
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext): Promise<SubtitlePayload> {
    const page = absUrl(ctx.baseUrl, c.id);
    const html = await httpPage(page, { signal: ctx.signal, referer: `${ctx.baseUrl}/` });
    const path = parseDownloadPath(html);
    if (!path) throw new ProviderError('parse', 'Unexpected response');
    // The zip is only served with the subtitle page as referer.
    return toPayload((await httpBytes(absUrl(ctx.baseUrl, path), { signal: ctx.signal, referer: page })).bytes, c.language);
  },
};
