// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/MegaPeer.kt
import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { decodeEntities, stripTags, toInt } from '../text.ts';
import { absUrl, cells, firstMagnet, parseBinarySize, parseRuDate, tableRows } from './nicheText.ts';

export const ID = 'megapeer';

// Maglev category -> MegaPeer category id (0 = all).
const CATEGORY_ID: Partial<Record<Category, number>> = {
  all: 0, apps: 29, books: 52, games: 28, movies: 80, music: 94, other: 59, tv: 6,
};

/**
 * Scrape of the `tr.table_fon` rows (Russian site, served as windows-1251: http.ts decodes it).
 * The list has no magnet: rows carry `detailUrl` and an empty `magnet` for `resolveMagnet`.
 * `infoHash` is a stand-in (`megapeer:<torrent id>`).
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<table|<tr/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const row of tableRows(body)) {
    if (!/class="table_fon"/i.test(row.slice(0, 40))) continue;
    const link = /<a href="(\/torrent\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue;
    const name = stripTags(link[3]);
    if (!name) continue;
    const tds = cells(row);
    const stats = tds[tds.length - 1] ?? '';
    const fonts = [...stats.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/gi)].map((m) => stripTags(m[1]));
    out.push({
      providerId: ID,
      name,
      infoHash: `${ID}:${link[2]}`,
      magnet: '',
      sizeBytes: parseBinarySize(stripTags(tds[tds.length - 2] ?? '')),
      seeders: toInt(fonts[0]),
      leechers: toInt(fonts[1]),
      publishedAt: parseRuDate(stripTags(tds[0] ?? '')),
      category: ctx.category !== 'all' ? ctx.category : undefined,
      detailUrl: absUrl(ctx.baseUrl, decodeEntities(link[1])),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export function searchUrl(base: string, q: string, category: Category): string {
  return `${base.replace(/\/+$/, '')}/browse.php?search=${encodeURIComponent(q.trim())}&age=&cat=${CATEGORY_ID[category] ?? 0}&stype=0&sort=0&ascdesc=0`;
}

export const megapeer: SearchProvider = {
  id: ID,
  name: 'MegaPeer',
  abbr: 'MP',
  homepage: 'https://megapeer.vip',
  mirrors: ['https://megapeer.vip'],
  categories: ['movies', 'tv', 'music', 'apps', 'games', 'books', 'other'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  async search(q, category, page, ctx) {
    if (page > 1) return [];
    const text = await httpText(searchUrl(ctx.baseUrl, q, category), { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    if (!result.detailUrl || !/^https?:\/\//i.test(result.detailUrl)) throw new ProviderError('parse', 'No page to read the magnet from');
    const found = firstMagnet(await httpText(result.detailUrl, { signal, accept: 'text/html' }));
    if (!found) throw new ProviderError('parse', 'No magnet link on the page');
    return found;
  },
};
