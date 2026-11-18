// Ported from LavX/bazarr-provider-catalog, providers/moviesubtitles (MIT), https://github.com/LavX/bazarr-provider-catalog/tree/main/providers/moviesubtitles
// Movies only. The search form answers with HTTP 500 and a real page, so it is read leniently.
import type { SubtitleCandidate, SubtitleContext, SubtitlePayload, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { stripTags, toInt } from '../../search/text.ts';
import { languageRank, normalizeLanguage } from '../languages.ts';
import { httpBytes, httpPageLoose, toPayload } from '../http.ts';
import { absUrl, hasAllWords, isEpisodeQuery, norm, withoutYear, yearOf } from '../match.ts';

export const ID = 'moviesubtitles';
const MAX_MOVIES = 2;

export interface MsMovie {
  id: string;
  title: string;
  year?: number;
}

/** The movies a search page lists. */
export function parseSearch(html: string): MsMovie[] {
  const out: MsMovie[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']\/movie-(\d+)\.html["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = stripTags(m[2]);
    if (!title || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], title, year: yearOf(title) });
  }
  return out;
}

export interface MsRow {
  id: string;
  language: string;
  releaseName: string;
  parts: number;
  downloads?: number;
}

/** The site's label ("english", "portugese(br)") as a language code; null for the ad link that shares the markup. */
export function labelLanguage(label: string): string | null {
  const t = label.toLowerCase().trim();
  if (/^portug(?:u)?ese\s*\(br\)$/.test(t)) return 'pt-BR';
  return normalizeLanguage(t.replace(/^portugese$/, 'portuguese'));
}

/** A value from the small table under each subtitle: <img alt="Rip" title="Rip"></td><td>TS</td>. */
function meta(chunk: string, label: string): string {
  const m = new RegExp(`alt=["']${label}["']\\s+title=["']${label}["'][^>]*>\\s*</td>\\s*<td\\b[^>]*>([\\s\\S]*?)</td>`, 'i').exec(chunk);
  return m ? stripTags(m[1]) : '';
}

/** The subtitles on a movie page. */
export function parseMovie(html: string): MsRow[] {
  const starts = Array.from(html.matchAll(/href=["']\/subtitle-(\d+)\.html["']\s+title=["']Download ([^"']+?) subtitles["']/gi));
  const out: MsRow[] = [];
  starts.forEach((m, i) => {
    const chunk = html.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : html.length);
    const language = labelLanguage(m[2]);
    if (!language) return;
    const b = /<b>([\s\S]*?)<\/b>/i.exec(chunk);
    // "Inception 2010 english subtitles (TS.IMAGiNE)" -> "Inception 2010 (TS.IMAGiNE)"
    const name = (b ? stripTags(b[1]) : '').replace(new RegExp(`\\s+${m[2].replace(/[()]/g, '\\$&')}\\s+subtitles`, 'i'), '').trim();
    if (!name) return;
    out.push({
      id: m[1],
      language,
      releaseName: name,
      parts: toInt(meta(chunk, 'parts')) ?? 1,
      downloads: toInt(meta(chunk, 'downloaded')),
    });
  });
  return out;
}

/** The movie pages to read, best first: exact title, then every title word, and the year when known. */
export function chooseMovies(q: SubtitleQuery, list: MsMovie[]): MsMovie[] {
  const want = norm(withoutYear(q.title));
  const scored: { m: MsMovie; score: number; at: number }[] = [];
  list.forEach((m, at) => {
    if (q.year !== undefined && m.year !== undefined && m.year !== q.year) return;
    const name = withoutYear(m.title);
    let score = 0;
    if (hasAllWords(q.title, name)) score = 80;
    if (norm(name) === want) score = 110;
    if (score === 0) return;
    if (q.year !== undefined && m.year === q.year) score += 10;
    scored.push({ m, score, at });
  });
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, MAX_MOVIES).map((x) => x.m);
}

export const moviesubtitles: SubtitleProvider = {
  id: ID,
  name: 'MovieSubtitles',
  homepage: 'https://www.moviesubtitles.org',
  mirrors: ['https://www.moviesubtitles.org'],
  languages: ['ar', 'de', 'el', 'en', 'fr', 'hu', 'it', 'pl', 'pt', 'ru', 'es', 'tr', 'uk'],
  kinds: ['movie'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q: SubtitleQuery, ctx: SubtitleContext): Promise<SubtitleCandidate[]> {
    if (isEpisodeQuery(q) || !q.title.trim()) return [];
    const base = ctx.baseUrl;
    const search = await httpPageLoose(`${base}/search.php`, { signal: ctx.signal, form: { q: withoutYear(q.title) } });
    const movies = chooseMovies(q, parseSearch(search));
    const pages = await Promise.all(movies.map((m) => httpPageLoose(`${base}/movie-${m.id}.html`, { signal: ctx.signal, referer: `${base}/search.php` })));
    const out: SubtitleCandidate[] = [];
    const seen = new Set<string>();
    for (const html of pages) {
      for (const r of parseMovie(html)) {
        // A subtitle split over several discs would save only one disc's part.
        if (r.parts > 1 || seen.has(r.id) || languageRank(r.language, q.languages) === Infinity) continue;
        seen.add(r.id);
        out.push({ providerId: ID, id: r.id, language: r.language, releaseName: r.releaseName, matchedBy: 'title', downloads: r.downloads });
      }
    }
    return out;
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext): Promise<SubtitlePayload> {
    const { bytes } = await httpBytes(absUrl(ctx.baseUrl, `/download-${encodeURIComponent(c.id)}.html`), { signal: ctx.signal, referer: absUrl(ctx.baseUrl, `/subtitle-${encodeURIComponent(c.id)}.html`) });
    return toPayload(bytes, c.language);
  },
};
