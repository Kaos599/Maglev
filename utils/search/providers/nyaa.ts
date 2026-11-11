import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { extractBlocks, parseSize, tagText, toInt, toMs } from '../text.ts';

export const ID = 'nyaa';

// Maglev category -> Nyaa `c` code. 'all' and 'other' search everything.
const NYAA_CODES: Partial<Record<Category, string>> = {
  anime: '1_0',
  music: '2_0',
  books: '3_0',
  apps: '6_0',
  games: '6_2',
};

function nyaaCategory(id: string | undefined): Category | undefined {
  if (!id) return undefined;
  if (id.startsWith('1_')) return 'anime';
  if (id.startsWith('2_')) return 'music';
  if (id.startsWith('3_')) return 'books';
  if (id === '6_2') return 'games';
  if (id.startsWith('6_')) return 'apps';
  return 'other';
}

/** Shared RSS parser for Nyaa and Sukebei (same feed format). */
export function parseNyaaRss(providerId: string, body: string, ctx: ParseContext, forceCategory?: Category): SearchResult[] {
  if (!/<rss[\s>]/i.test(body) && !/<channel[\s>]/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const item of extractBlocks(body, 'item')) {
    const name = tagText(item, 'title');
    const hash = normalizeInfoHash(tagText(item, 'nyaa:infoHash'));
    if (!name || !hash) continue;
    out.push({
      providerId,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name, ['http://nyaa.tracker.wf:7777/announce']),
      sizeBytes: parseSize(tagText(item, 'nyaa:size')),
      seeders: toInt(tagText(item, 'nyaa:seeders')),
      leechers: toInt(tagText(item, 'nyaa:leechers')),
      publishedAt: toMs(tagText(item, 'pubDate')),
      category: forceCategory ?? nyaaCategory(tagText(item, 'nyaa:categoryId')),
      detailUrl: tagText(item, 'guid'),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const parse = (body: string, ctx: ParseContext) => parseNyaaRss(ID, body, ctx);

export const nyaa: SearchProvider = {
  id: ID,
  name: 'Nyaa',
  abbr: 'NY',
  homepage: 'https://nyaa.si',
  mirrors: ['https://nyaa.si', 'https://nyaa.iss.ink'],
  categories: ['anime', 'music', 'books', 'apps', 'games', 'other'],
  nsfw: false,
  enabledByDefault: true,
  method: 'rss',
  canPage: true,
  async search(q, category, page, ctx) {
    const code = NYAA_CODES[category] ?? '0_0';
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/?page=rss&f=0&c=${code}&q=${encodeURIComponent(q)}&p=${page}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/rss+xml, application/xml, text/xml' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
