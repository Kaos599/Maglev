// Ported from LavX/bazarr-provider-catalog, providers/subtitlecat (MIT), https://github.com/LavX/bazarr-provider-catalog/tree/main/providers/subtitlecat
// A search lists releases; each release page lists one download per language. Most languages are machine
// translations of the original, which the page's "-orig" file name tells apart.
import type { SubtitleCandidate, SubtitleContext, SubtitlePayload, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { decodeEntities, stripTags, toInt } from '../../search/text.ts';
import { languageRank, normalizeLanguage } from '../languages.ts';
import { httpBytes, httpPage, toPayload } from '../http.ts';
import { absUrl, hasAllWords, hasEpisode, isEpisodeQuery, isSeasonPack, safePath, tokens, withoutYear } from '../match.ts';

export const ID = 'subtitlecat';
/** Release pages fetched per search: each one is a few hundred KB. */
const MAX_PAGES = 3;

export interface CatRelease {
  path: string;
  title: string;
  downloads?: number;
}

/** The release rows of a search page. */
export function parseSearch(html: string): CatRelease[] {
  const out: CatRelease[] = [];
  const seen = new Set<string>();
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const a = /<a\b[^>]*href="(\/?subs\/(\d+)\/[^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/i.exec(row[1]);
    if (!a || seen.has(a[2])) continue;
    const title = stripTags(a[3]);
    if (!title) continue;
    seen.add(a[2]);
    const dl = /Downloads<\/span><span class="sub-table__metric-value">\s*([\d,]+)/i.exec(row[1]);
    out.push({ path: '/' + decodeEntities(a[1]).replace(/^\/+/, ''), title, downloads: dl ? toInt(dl[1].replace(/,/g, '')) : undefined });
  }
  return out;
}

export interface CatDownload {
  language: string;
  path: string;
  /** False for a language other than the original: the site translated it by machine. */
  original: boolean;
}

/** The languages a release page can download now (a "Translate" button has no file yet). */
export function parseDetail(html: string): CatDownload[] {
  // "<name>-<code>-orig.srt" or "<name>.<Language>-orig.srt": the original's language.
  const orig = /(?:^|[/_.\-'])([a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?)-orig\.srt/.exec(html)?.[1];
  const source = orig ? normalizeLanguage(orig) : null;
  const best = new Map<string, CatDownload>();
  for (const m of html.matchAll(/<a[^>]+id="download_([a-z]{2,3}(?:-[a-z0-9]{2,4})?)"[^>]+href="(\/?subs\/\d+\/[^"]+\.srt)"/gi)) {
    const language = normalizeLanguage(m[1]);
    if (!language) continue;
    const path = '/' + safePath(decodeEntities(m[2]).replace(/^\/+/, ''));
    const next: CatDownload = { language, path, original: source === null ? true : language === source };
    const had = best.get(language);
    // An exact code ("pt") wins over a regional one that normalised to the same language.
    if (!had || !m[1].includes('-')) best.set(language, next);
  }
  return Array.from(best.values());
}

export function queriesFor(q: SubtitleQuery): string[] {
  const title = withoutYear(q.title);
  if (!title) return [];
  if (isEpisodeQuery(q)) return [`${title} S${String(q.season).padStart(2, '0')}E${String(q.episode).padStart(2, '0')}`, title];
  return q.year ? [`${title} ${q.year}`, title] : [title];
}

/** Which listed releases are worth a page fetch: the title words (and the episode) must be in the release name. */
export function chooseReleases(q: SubtitleQuery, list: CatRelease[]): CatRelease[] {
  const title = withoutYear(q.title);
  const keep = list.filter((r) => {
    if (!hasAllWords(title, r.title)) return false;
    if (isEpisodeQuery(q)) return hasEpisode(r.title, q.season, q.episode) || isSeasonPack(r.title, q.season);
    return true;
  });
  const yearOk = (r: CatRelease) => (q.year && tokens(r.title).includes(String(q.year)) ? 0 : 1);
  return keep.map((r, i) => ({ r, i })).sort((a, b) => yearOk(a.r) - yearOk(b.r) || a.i - b.i).map((x) => x.r).slice(0, MAX_PAGES);
}

export const subtitlecat: SubtitleProvider = {
  id: ID,
  name: 'Subtitle Cat',
  homepage: 'https://www.subtitlecat.com',
  mirrors: ['https://www.subtitlecat.com'],
  languages: 'many',
  kinds: ['movie', 'episode'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q: SubtitleQuery, ctx: SubtitleContext): Promise<SubtitleCandidate[]> {
    const base = ctx.baseUrl;
    let chosen: CatRelease[] = [];
    for (const query of queriesFor(q)) {
      const html = await httpPage(`${base}/index.php?search=${encodeURIComponent(query)}`, { signal: ctx.signal });
      chosen = chooseReleases(q, parseSearch(html));
      if (chosen.length > 0) break;
    }
    const pages = await Promise.all(
      chosen.map(async (r) => {
        try {
          return { r, list: parseDetail(await httpPage(absUrl(base, safePath(r.path)), { signal: ctx.signal, referer: base })) };
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          return { r, list: [] as CatDownload[] }; // one page failing must not lose the rest
        }
      }),
    );
    const out: SubtitleCandidate[] = [];
    for (const { r, list } of pages) {
      for (const d of list) {
        if (languageRank(d.language, q.languages) === Infinity) continue;
        out.push({
          providerId: ID,
          id: d.path,
          language: d.language,
          releaseName: d.original ? r.title : `${r.title} (machine translated)`,
          format: 'srt',
          matchedBy: 'title',
          downloads: r.downloads,
        });
      }
    }
    return out;
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext): Promise<SubtitlePayload> {
    return toPayload((await httpBytes(absUrl(ctx.baseUrl, c.id), { signal: ctx.signal, referer: ctx.baseUrl })).bytes, c.language);
  },
};
