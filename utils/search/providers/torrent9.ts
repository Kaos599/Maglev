// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/Torrent9.kt
import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { decodeEntities, stripTags, toInt } from '../text.ts';
import { absUrl, cells, firstMagnet, parseBinarySize, parseDmy, tableRows } from './nicheText.ts';

export const ID = 'torrent9';

// Maglev category -> Torrent9 category slug.
const SLUG: Partial<Record<Category, string>> = {
  apps: 'logiciels',
  books: 'ebook',
  games: 'jeux-pc',
  movies: 'films',
  music: 'musique',
  tv: 'series',
};

// Font Awesome icon on each row -> Maglev category (as TorrentSearch maps it).
const BY_ICON: Record<string, Category> = {
  'fa-desktop': 'tv',
  'fa-video-camera': 'movies',
  'fa-music': 'music',
  'fa-book': 'books',
  'fa-laptop': 'apps',
  'fa-gamepad': 'games',
};

/**
 * Scrape of the result table (French site). The list has no magnet: rows carry `detailUrl` and an empty
 * `magnet` for `resolveMagnet`. `infoHash` is a stand-in (`torrent9:<torrent id>`). Sizes read "49.1Mo".
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<table|<tr/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const row of tableRows(body)) {
    const link = /<a [^>]*href="(\/torrent\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue;
    const name = stripTags(link[3]);
    if (!name) continue;
    const tds = cells(row);
    const icon = /<i class="fa (fa-[a-z-]+)"/i.exec(row)?.[1] ?? '';
    out.push({
      providerId: ID,
      name,
      infoHash: `${ID}:${link[2]}`,
      magnet: '',
      sizeBytes: parseBinarySize(stripTags(tds[2] ?? '')),
      seeders: toInt(stripTags(/<span class="seed_ok">([\s\S]*?)(?:<img|<\/span>)/i.exec(tds[3] ?? '')?.[1] ?? '')),
      leechers: toInt(stripTags((tds[4] ?? '').replace(/<img[^>]*>/gi, ''))),
      publishedAt: parseDmy(stripTags(tds[1] ?? '')),
      category: BY_ICON[icon] ?? 'other',
      detailUrl: absUrl(ctx.baseUrl, decodeEntities(link[1])),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export function searchUrl(base: string, q: string, category: Category): string {
  const slug = SLUG[category];
  return `${base.replace(/\/+$/, '')}/search_torrent${slug ? `/${slug}` : ''}/${encodeURIComponent(q.trim())}.html`;
}

export const torrent9: SearchProvider = {
  id: ID,
  name: 'Torrent9',
  abbr: 'T9',
  homepage: 'https://www6.torrent9.to',
  mirrors: ['https://www6.torrent9.to'],
  categories: ['movies', 'tv', 'music', 'apps', 'games', 'books'],
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
