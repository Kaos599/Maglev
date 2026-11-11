// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/OxTorrent.kt
import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { decodeEntities, stripTags, toInt } from '../text.ts';
import { absUrl, cells, firstMagnet, parseBinarySize, tableRows } from './nicheText.ts';

export const ID = 'oxtorrent';

// Maglev category -> OxTorrent category slug.
const SLUG: Partial<Record<Category, string>> = {
  apps: 'logiciels',
  books: 'ebook',
  games: 'jeux-pc',
  movies: 'films',
  music: 'musique',
  tv: 'series',
};

// The icon class on each row ("Logiciels", "Ebook"...) -> Maglev category.
const BY_ICON: Record<string, Category> = {
  ebook: 'books',
  films: 'movies',
  'jeux-consoles': 'games',
  'jeux-pc': 'games',
  logiciels: 'apps',
  musique: 'music',
  series: 'tv',
};

/**
 * Scrape of the result table (French site). The list has no magnet: rows carry `detailUrl` and an empty
 * `magnet` for `resolveMagnet`. `infoHash` is a stand-in (`oxtorrent:<torrent id>`).
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<table|<tr/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const row of tableRows(body)) {
    const link = /<a href="(\/torrent\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue;
    const name = stripTags(link[3]);
    if (!name) continue;
    const tds = cells(row);
    const icon = /<i class="([^"]*)"><\/i>/i.exec(row)?.[1]?.trim().toLowerCase() ?? '';
    out.push({
      providerId: ID,
      name,
      infoHash: `${ID}:${link[2]}`,
      magnet: '',
      sizeBytes: parseBinarySize(stripTags(tds[1] ?? '')),
      seeders: toInt(stripTags(tds[2] ?? '')),
      leechers: toInt(stripTags(tds[3] ?? '')),
      category: BY_ICON[icon] ?? (ctx.category !== 'all' ? ctx.category : 'other'),
      detailUrl: absUrl(ctx.baseUrl, decodeEntities(link[1])),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export function searchUrl(base: string, q: string, category: Category): string {
  const slug = SLUG[category];
  return `${base.replace(/\/+$/, '')}/recherche${slug ? `/${slug}` : ''}/${encodeURIComponent(q.trim())}`;
}

export const oxtorrent: SearchProvider = {
  id: ID,
  name: 'OxTorrent',
  abbr: 'OX',
  homepage: 'https://oxtorrent.co',
  mirrors: ['https://oxtorrent.co'],
  categories: ['movies', 'tv', 'music', 'apps', 'games', 'books'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  cloudflare: { solverUrl: 'https://oxtorrent.co/' },
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
