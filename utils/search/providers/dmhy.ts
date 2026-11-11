// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/Dmhy.kt
import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, infoHashFromMagnet } from '../magnet.ts';
import { decodeEntities, parseSize, stripTags, toInt } from '../text.ts';
import { parseCstDate } from './mikan.ts';

export const ID = 'dmhy';

// Maglev category -> Dmhy `sort_id`. 'all' searches everything.
const SORT_IDS: Partial<Record<Category, string>> = { anime: '2', books: '3', games: '9', music: '4', tv: '6', other: '1' };

/** Site sort id (the `sort-N` class) -> Maglev category, as TorrentSearch maps it. */
export function categoryFromSortId(id: string | undefined): Category {
  switch (id) {
    case '2':
    case '7':
    case '31':
      return 'anime';
    case '3':
      return 'books';
    case '41':
    case '42':
    case '6':
      return 'tv';
    case '4':
    case '43':
    case '44':
    case '15':
      return 'music';
    case '9':
    case '17':
    case '18':
    case '19':
    case '20':
    case '21':
      return 'games';
    default:
      return 'other';
  }
}

/** Scrape of `table#topic_list`. Magnets carry a base32 info hash. Dates are China time. */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<table|<div/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const out: SearchResult[] = [];
  const start = body.indexOf('id="topic_list"');
  if (start < 0) return out;
  for (const row of body.slice(start).split(/<tr[\s>]/i).slice(1)) {
    const mag = /href="(magnet:\?xt=[^"]+)"/i.exec(row);
    const title = [...row.matchAll(/<a href="(\/topics\/view\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].pop();
    const hash = infoHashFromMagnet(mag ? decodeEntities(mag[1]) : undefined);
    const name = title ? stripTags(title[2]) : '';
    if (!title || !hash || !name) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name, ['http://nyaa.tracker.wf:7777/announce']),
      sizeBytes: parseSize(cells[4]),
      seeders: toInt(cells[5]),
      leechers: toInt(cells[6]),
      publishedAt: parseCstDate(cells[0]),
      category: categoryFromSortId(/class="sort-(\d+)"/.exec(row)?.[1]),
      detailUrl: base + decodeEntities(title[1]),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const dmhy: SearchProvider = {
  id: ID,
  name: 'Dmhy',
  abbr: 'DM',
  homepage: 'https://share.dmhy.org',
  mirrors: ['https://share.dmhy.org'],
  categories: ['anime', 'books', 'games', 'music', 'tv', 'other'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: true,
  async search(q, category, page, ctx) {
    const base = ctx.baseUrl.replace(/\/+$/, '');
    const path = page > 1 ? `/topics/list/page/${page}` : '/topics/list';
    const url = `${base}${path}?keyword=${encodeURIComponent(q)}&sort_id=${SORT_IDS[category] ?? '0'}&team_id=0&order=date-desc`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
