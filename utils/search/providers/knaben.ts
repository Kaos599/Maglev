import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, joinUrl, parseJson, ProviderError } from '../http.ts';
import { buildMagnet, infoHashFromMagnet, normalizeInfoHash } from '../magnet.ts';
import { toInt, toMs } from '../text.ts';

export const ID = 'knaben';

// Maglev category -> Knaben category ids. 'all' sends no filter.
const CATEGORY_IDS: Partial<Record<Category, number[]>> = {
  music: [1000000],
  tv: [2000000],
  movies: [3000000],
  apps: [4000000],
  adult: [5000000],
  anime: [6000000],
  games: [7000000],
  books: [9000000],
  other: [10000000],
};

function categoryFromIds(ids: unknown): Category | undefined {
  if (!Array.isArray(ids) || ids.length === 0) return undefined;
  const bucket = Math.floor(Number(ids[0]) / 1000000) * 1000000;
  for (const [cat, list] of Object.entries(CATEGORY_IDS)) if (list![0] === bucket) return cat as Category;
  return undefined;
}

export function parse(body: string, ctx: ParseContext): SearchResult[] {
  const json = parseJson(body);
  const hits = json?.hits;
  if (!Array.isArray(hits)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const h of hits) {
    const name = typeof h?.title === 'string' ? h.title : undefined;
    if (!name) continue;
    const hash = normalizeInfoHash(h.hash) ?? infoHashFromMagnet(h.magnetUrl);
    if (!hash) continue;
    const category = categoryFromIds(h.categoryId);
    if (ctx.hideAdult && category === 'adult') continue;
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: typeof h.magnetUrl === 'string' && h.magnetUrl.startsWith('magnet:') ? h.magnetUrl : buildMagnet(hash, name),
      sizeBytes: toInt(h.bytes),
      seeders: toInt(h.seeders),
      leechers: toInt(h.peers),
      publishedAt: toMs(h.date),
      category,
      detailUrl: typeof h.details === 'string' ? h.details : undefined,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const knaben: SearchProvider = {
  id: ID,
  name: 'Knaben',
  abbr: 'KN',
  homepage: 'https://knaben.org',
  mirrors: ['https://api.knaben.org'],
  categories: ['movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other', 'adult'],
  nsfw: false,
  enabledByDefault: true,
  method: 'json',
  canPage: true,
  async search(q, category, page, ctx) {
    const body: Record<string, unknown> = {
      query: q,
      search_field: 'title',
      order_by: 'seeders',
      order_direction: 'desc',
      size: Math.min(ctx.limit, 300),
      from: (page - 1) * ctx.limit,
      hide_unsafe: true,
      hide_xxx: ctx.hideAdult,
    };
    const ids = CATEGORY_IDS[category];
    if (ids) body.categories = ids;
    const text = await httpText(joinUrl(ctx.baseUrl, '/v1'), {
      signal: ctx.signal,
      accept: 'application/json',
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
