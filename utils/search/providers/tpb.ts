import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, joinUrl, parseJson, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { decodeEntities, toInt } from '../text.ts';

export const ID = 'tpb';

// Maglev category -> apibay `cat` code. 0 searches everything.
const TPB_CODES: Partial<Record<Category, number>> = {
  music: 100,
  movies: 200,
  tv: 200,
  apps: 300,
  games: 400,
  adult: 500,
  books: 601,
  other: 600,
};

function tpbCategory(code: number | undefined): Category | undefined {
  if (code == null) return undefined;
  const group = Math.floor(code / 100);
  if (group === 1) return 'music';
  if (group === 2) return code === 205 || code === 208 ? 'tv' : 'movies';
  if (group === 3) return 'apps';
  if (group === 4) return 'games';
  if (group === 5) return 'adult';
  if (code === 601) return 'books';
  return 'other';
}

export function parse(body: string, ctx: ParseContext): SearchResult[] {
  const rows = parseJson(body);
  if (!Array.isArray(rows)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const r of rows) {
    // The "No results returned" sentinel has id 0 and an all-zero hash.
    if (!r || String(r.id) === '0') continue;
    const hash = normalizeInfoHash(r.info_hash);
    if (!hash || typeof r.name !== 'string') continue;
    const name = decodeEntities(r.name);
    const category = tpbCategory(toInt(r.category));
    if (ctx.hideAdult && category === 'adult') continue;
    const added = toInt(r.added);
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name),
      sizeBytes: toInt(r.size),
      seeders: toInt(r.seeders),
      leechers: toInt(r.leechers),
      publishedAt: added ? added * 1000 : undefined,
      category,
      detailUrl: `https://thepiratebay.org/description.php?id=${r.id}`,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const tpb: SearchProvider = {
  id: ID,
  name: 'The Pirate Bay',
  abbr: 'PB',
  homepage: 'https://thepiratebay.org',
  mirrors: ['https://apibay.org'],
  categories: ['movies', 'tv', 'music', 'apps', 'games', 'books', 'other', 'adult'],
  nsfw: false,
  unsafeReason: 'Many fake or malware uploads. Check comments before downloading.',
  enabledByDefault: false,
  method: 'json',
  canPage: false,
  async search(q, category, page, ctx) {
    if (page > 1) return [];
    const cat = TPB_CODES[category] ?? 0;
    const url = `${joinUrl(ctx.baseUrl, '/q.php')}?q=${encodeURIComponent(q)}&cat=${cat}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/json' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
