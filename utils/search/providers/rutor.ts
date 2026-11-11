// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/Rutor.kt
import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { infoHashFromMagnet } from '../magnet.ts';
import { decodeEntities, stripTags, toInt } from '../text.ts';
import { absUrl, cells, parseBinarySize, parseRuDate, tableRows } from './nicheText.ts';

export const ID = 'rutor';

// Maglev category -> Rutor category id (0 = all).
const CATEGORY_ID: Record<Category, number> = {
  all: 0, movies: 1, music: 2, other: 3, tv: 4, games: 8, apps: 9, anime: 10, books: 11, adult: 0,
};

/**
 * Scrape of the result table (Russian site, UTF-8). Each row has the magnet, so no detail fetch is needed.
 * The row has no category: a category search labels its rows, an "all" search leaves them unlabelled.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<table|<tr/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const row of tableRows(body)) {
    const magnetHref = /<a href="(magnet:\?[^"]+)"/i.exec(row)?.[1];
    const link = /<a href="(\/torrent\/\d+\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!magnetHref || !link) continue;
    const magnet = decodeEntities(magnetHref);
    const hash = infoHashFromMagnet(magnet);
    const name = stripTags(link[2]);
    if (!hash || !name || seen.has(hash)) continue;
    seen.add(hash);
    const tds = cells(row);
    // Columns: date, name, [comments], size, seeds/leeches.
    const stats = tds[tds.length - 1] ?? '';
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet,
      sizeBytes: parseBinarySize(stripTags(tds[tds.length - 2] ?? '')),
      seeders: toInt(stripTags(/<span class="green">([\s\S]*?)<\/span>/i.exec(stats)?.[1] ?? '')),
      leechers: toInt(stripTags(/<span class="red">([\s\S]*?)<\/span>/i.exec(stats)?.[1] ?? '')),
      publishedAt: parseRuDate(stripTags(tds[0] ?? '')),
      category: ctx.category !== 'all' ? ctx.category : undefined,
      detailUrl: absUrl(ctx.baseUrl, decodeEntities(link[1])),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export function searchUrl(base: string, q: string, category: Category, page: number): string {
  // /search/<page>/<category>/<match type>/<sort>/<text>; match type 010 = all words, sort 2 = seeders.
  return `${base.replace(/\/+$/, '')}/search/${Math.max(0, page - 1)}/${CATEGORY_ID[category] ?? 0}/010/2/${encodeURIComponent(q.trim())}`;
}

export const rutor: SearchProvider = {
  id: ID,
  name: 'Rutor',
  abbr: 'RU',
  homepage: 'https://rutor.info',
  mirrors: ['https://rutor.info', 'https://rutor.is'],
  categories: ['movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: true,
  async search(q, category, page, ctx) {
    const text = await httpText(searchUrl(ctx.baseUrl, q, category, page), { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
