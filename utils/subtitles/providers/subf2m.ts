// Ported from LavX/bazarr-provider-catalog, providers/subf2m (MIT), https://github.com/LavX/bazarr-provider-catalog/tree/main/providers/subf2m
// Search finds the title's page (a series has one page per season); /<title>/<language> lists its subtitles;
// the subtitle's own page holds the zip link.
import type { SubtitleCandidate, SubtitleContext, SubtitlePayload, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { ProviderError } from '../../search/http.ts';
import { decodeEntities, stripTags } from '../../search/text.ts';
import { baseLanguage, languageRank } from '../languages.ts';
import { httpBytes, httpPage, toPayload } from '../http.ts';
import { absUrl, hasAllWords, hasEpisode, isEpisodeQuery, isSeasonPack, looksHearingImpaired, norm, withoutYear, yearOf } from '../match.ts';

export const ID = 'subf2m';
/** Language pages read per search, and title pages: each language page is about 150 KB. */
const MAX_LANGUAGES = 3;
const MAX_TITLES = 2;

/** App language code -> the site's language folder. */
const PATH: Record<string, string> = {
  en: 'english', ar: 'arabic', bn: 'bengali', 'pt-BR': 'brazillian-portuguese', bg: 'bulgarian', my: 'burmese',
  'zh-CN': 'chinese-bg-code', zh: 'chinese-bg-code', hr: 'croatian', cs: 'czech', da: 'danish', nl: 'dutch', et: 'estonian',
  fi: 'finnish', fr: 'french', de: 'german', el: 'greek', he: 'hebrew', hu: 'hungarian', is: 'icelandic', id: 'indonesian',
  it: 'italian', ja: 'japanese', ko: 'korean', lt: 'lithuanian', mk: 'macedonian', ms: 'malay', ml: 'malayalam',
  mn: 'mongolian', no: 'norwegian', pl: 'polish', pt: 'portuguese', ro: 'romanian', ru: 'russian', sr: 'serbian',
  si: 'sinhala', es: 'spanish', sv: 'swedish', th: 'thai', tr: 'turkish', uk: 'ukranian', ur: 'urdu', vi: 'vietnamese',
  fa: 'farsi_persian',
};
/** Folder -> code the candidates carry. The Chinese folder is the GB (simplified) one. */
const CODE: Record<string, string> = Object.fromEntries(Object.entries(PATH).map(([c, p]) => [p, c]));
CODE['chinese-bg-code'] = 'zh-CN';

const SEASON_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];

export interface F2mTitle {
  path: string;
  title: string;
  year?: number;
  season?: number;
}

/** "Breaking Bad - Fifth Season" or "Show - Season 2" gives 5 / 2. */
export function seasonOfTitle(title: string): number | undefined {
  const t = norm(withoutYear(title));
  const w = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth) (?:season|series)\b/.exec(t);
  if (w) return SEASON_WORDS.indexOf(w[1]) + 1;
  const n = /\b(?:season|series) (\d{1,2})\b/.exec(t);
  return n ? Number(n[1]) : undefined;
}

function seriesName(title: string): string {
  return withoutYear(title).replace(/\s*[-(]\s*(?:\w+\s+)?(?:season|series)\s*\d*\)?\s*$/i, '').trim();
}

/** The titles a search page lists. */
export function parseSearch(html: string): F2mTitle[] {
  const out: F2mTitle[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<div\b[^>]*class=['"][^'"]*\btitle\b[^'"]*['"][^>]*>\s*<a\b[^>]*href=['"](\/subtitles\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi)) {
    const path = decodeEntities(m[1]);
    if (seen.has(path)) continue;
    seen.add(path);
    const title = stripTags(m[2]);
    out.push({ path, title, year: yearOf(title), season: seasonOfTitle(title) });
  }
  return out;
}

/** The title pages to read, best first. */
export function chooseTitles(q: SubtitleQuery, list: F2mTitle[]): F2mTitle[] {
  const episode = isEpisodeQuery(q);
  const want = norm(withoutYear(q.title));
  const scored: { t: F2mTitle; score: number; at: number }[] = [];
  list.forEach((t, at) => {
    if (q.year !== undefined && t.year !== undefined && t.year !== q.year && !episode) return;
    const name = episode ? seriesName(t.title) : withoutYear(t.title);
    if (!hasAllWords(q.title, name)) return;
    let score = 40;
    if (norm(name) === want) score += 60;
    if (q.year !== undefined && t.year === q.year) score += 30;
    if (isEpisodeQuery(q)) {
      // A series has a page per season: take the wanted season's.
      if (t.season !== undefined && t.season !== q.season) return;
      if (t.season === q.season) score += 35;
    }
    scored.push({ t, score, at });
  });
  const ranked = scored.sort((a, b) => b.score - a.score || a.at - b.at);
  // Pages named exactly as asked beat "Inception - The Cobol Job": when any exist, the others are left out.
  const exact = ranked.filter((x) => x.score >= 100);
  return (exact.length > 0 ? exact : ranked.slice(0, 1)).slice(0, MAX_TITLES).map((x) => x.t);
}

export interface F2mRow {
  id: string;
  path: string;
  releaseName: string;
  /** Every release line of the row, for matching. */
  allNames: string;
  comment: string;
  hearingImpaired: boolean;
}

/** The subtitles on a language page. A row names its releases (one or more lines) and carries a download link. */
export function parseLanguagePage(html: string): F2mRow[] {
  const out: F2mRow[] = [];
  const starts = Array.from(html.matchAll(/<li\b[^>]*class=['"][^'"]*\bitem\b[^'"]*['"][^>]*>/gi));
  starts.forEach((m, i) => {
    const item = html.slice(m.index! + m[0].length, i + 1 < starts.length ? starts[i + 1].index! : html.length);
    const names: string[] = [];
    const list = /<ul\b[^>]*class=['"][^'"]*\bscrolllist\b[^'"]*['"][^>]*>([\s\S]*?)<\/ul>/i.exec(item);
    if (list) for (const li of list[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const t = stripTags(li[1]);
      if (t) names.push(t);
    }
    const comment = stripTags(/<div\b[^>]*class=['"][^'"]*\bcomment-col\b[^'"]*['"][^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(item)?.[1] ?? '');
    const link = /<a\b(?=[^>]*class=['"][^'"]*\bdownload\b)(?=[^>]*href=['"]([^'"]+)['"])[^>]*>/i.exec(item);
    if (names.length === 0 || !link) return;
    const path = decodeEntities(link[1]);
    out.push({
      id: path.replace(/\/+$/, '').split('/').pop() ?? path,
      path,
      releaseName: names[0],
      allNames: names.join(' '),
      comment,
      hearingImpaired: looksHearingImpaired(names.join(' ')),
    });
  });
  return out;
}

/** True when a row is for the episode asked (or a season pack the unzip step can pick it from). */
export function rowFitsEpisode(row: F2mRow, season: number, episode: number): boolean {
  return hasEpisode(row.allNames, season, episode) || isSeasonPack(row.allNames, season);
}

/** The "Download" button's address on a subtitle page. */
export function parseDownloadPath(html: string): string | null {
  const m = /<a\b(?=[^>]*id=['"]downloadButton['"])(?=[^>]*href=['"]([^'"]+)['"])[^>]*>/i.exec(html);
  return m ? decodeEntities(m[1]) : null;
}

export function languageFolders(languages: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const l of languages) {
    const p = PATH[l] ?? PATH[baseLanguage(l)];
    if (p) seen.add(p);
    if (seen.size >= MAX_LANGUAGES) break;
  }
  return Array.from(seen);
}

export const subf2m: SubtitleProvider = {
  id: ID,
  name: 'Subf2m',
  homepage: 'https://subf2m.co',
  mirrors: ['https://subf2m.co'],
  languages: 'many',
  kinds: ['movie', 'episode'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: true,
  async search(q: SubtitleQuery, ctx: SubtitleContext): Promise<SubtitleCandidate[]> {
    const base = ctx.baseUrl;
    const folders = languageFolders(q.languages);
    if (folders.length === 0 || !q.title.trim()) return [];
    const searchUrl = `${base}/subtitles/searchbytitle?query=${encodeURIComponent(withoutYear(q.title))}&l=`;
    const titles = chooseTitles(q, parseSearch(await httpPage(searchUrl, { signal: ctx.signal })));
    const jobs: { title: F2mTitle; folder: string }[] = [];
    for (const title of titles) for (const folder of folders) jobs.push({ title, folder });
    const pages = await Promise.all(
      jobs.map(async (j) => {
        try {
          return { ...j, rows: parseLanguagePage(await httpPage(`${base}${j.title.path}/${j.folder}`, { signal: ctx.signal, referer: searchUrl })) };
        } catch (e) {
          // A language the title has no page for is a 404 or 403, not a failure of the source.
          if (e instanceof ProviderError && (e.status === 404 || e.kind === 'blocked')) return { ...j, rows: [] as F2mRow[] };
          throw e;
        }
      }),
    );
    const out: SubtitleCandidate[] = [];
    const seen = new Set<string>();
    for (const { folder, rows } of pages) {
      const language = CODE[folder];
      if (!language || languageRank(language, q.languages) === Infinity) continue;
      for (const r of rows) {
        if (isEpisodeQuery(q) && !rowFitsEpisode(r, q.season, q.episode)) continue;
        if (seen.has(r.path)) continue;
        seen.add(r.path);
        out.push({ providerId: ID, id: r.path, language, releaseName: r.releaseName, hearingImpaired: r.hearingImpaired, matchedBy: 'title' });
      }
    }
    return out;
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext): Promise<SubtitlePayload> {
    const page = absUrl(ctx.baseUrl, c.id);
    const path = parseDownloadPath(await httpPage(page, { signal: ctx.signal, referer: ctx.baseUrl }));
    if (!path) throw new ProviderError('parse', 'Unexpected response');
    return toPayload((await httpBytes(absUrl(ctx.baseUrl, path), { signal: ctx.signal, referer: page })).bytes, c.language);
  },
};
