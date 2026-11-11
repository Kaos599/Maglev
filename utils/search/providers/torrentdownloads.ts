// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/TorrentDownloads.kt
import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { infoHashFromMagnet } from '../magnet.ts';
import { decodeEntities, parseSize, stripTags, toInt } from '../text.ts';

export const ID = 'torrentdownloads';

// Maglev category -> the site's `s_cat` value (0 = all). "Other" also covers anything unmapped.
const CAT_ID: Partial<Record<Category, number>> = {
  all: 0,
  anime: 1,
  books: 2,
  games: 3,
  movies: 4,
  music: 5,
  apps: 7,
  tv: 8,
  other: 9,
};

// Row icon "menu_icon<N>.png" -> Maglev category.
const ICON: Record<string, Category> = { '1': 'anime', '2': 'books', '3': 'games', '4': 'movies', '5': 'music', '7': 'apps', '8': 'tv', '9': 'other' };

/**
 * Fragile scrape. The results are the `grey_bar3` rows of the last `inner_container`; each has the name
 * link, then spans for health, leechers, seeders and size. Rows whose link is not a `/torrent/<id>/...`
 * page (header, sponsored "fast search" rows) are skipped. The list has no magnet and no info hash: each
 * row carries a `detailUrl` and an empty `magnet`; `resolveMagnet` reads the detail page when the user
 * adds it. `infoHash` is a stand-in key (`torrentdownloads:<torrent id>`) until then.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<div|<table/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const at = body.lastIndexOf('class="inner_container"');
  if (at < 0) return out;
  for (const row of body.slice(at).split(/<div class="grey_bar3/i).slice(1)) {
    const link = /<p>\s*(?:<img[^>]*?menu_icon(\d+)\.png[^>]*>)?\s*<a\s+href="(\/torrent\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue;
    const name = stripTags(link[4]);
    if (!name) continue;
    const spans = [...row.slice(row.indexOf('</p>')).matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => stripTags(m[1]));
    // spans: health (no text), leechers, seeders, size
    const category = (link[1] ? ICON[link[1]] : undefined) ?? (ctx.category !== 'all' ? ctx.category : undefined);
    out.push({
      providerId: ID,
      name,
      infoHash: `${ID}:${link[3]}`,
      magnet: '',
      sizeBytes: parseSize(spans[3]),
      seeders: toInt(spans[2]?.replace(/,/g, '')),
      leechers: toInt(spans[1]?.replace(/,/g, '')),
      category,
      detailUrl: base + decodeEntities(link[2]),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/** The magnet link on a detail page. */
export function parseMagnet(body: string): { magnet: string; infoHash: string } {
  const m = /href="(magnet:\?[^"]+)"/i.exec(body);
  const magnet = m ? decodeEntities(m[1]) : '';
  const hash = infoHashFromMagnet(magnet);
  if (!hash) throw new ProviderError('parse', 'No magnet link on the page');
  return { magnet, infoHash: hash };
}

export function searchUrl(base: string, q: string, category: Category): string {
  const b = base.replace(/\/+$/, '');
  return `${b}/search/?s_cat=${CAT_ID[category] ?? 0}&search=${encodeURIComponent(q.trim())}`;
}

export const torrentdownloads: SearchProvider = {
  id: ID,
  name: 'TorrentDownloads',
  abbr: 'TL',
  homepage: 'https://torrentdownloads.pro',
  mirrors: ['https://torrentdownloads.pro', 'https://www.torrentdownloads.pro'],
  categories: ['movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  cloudflare: { solverUrl: 'https://torrentdownloads.pro/' },
  async search(q, category, _page, ctx) {
    const text = await httpText(searchUrl(ctx.baseUrl, q, category), { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    if (!result.detailUrl || !/^https?:\/\//i.test(result.detailUrl)) throw new ProviderError('parse', 'No page to read the magnet from');
    return parseMagnet(await httpText(result.detailUrl, { signal, accept: 'text/html' }));
  },
};
