import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, joinUrl, parseJson, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { toInt, toMs } from '../text.ts';

export const ID = 'archive';

// Maglev category -> Internet Archive mediatype list. 'all' has no mediatype filter.
const MEDIA_TYPES: Partial<Record<Category, string[]>> = {
  movies: ['movies'],
  music: ['audio'],
  books: ['texts'],
  apps: ['software'],
  other: ['data', 'image', 'education'],
};

function categoryFromMediaType(t: unknown): Category {
  switch (t) {
    case 'movies':
      return 'movies';
    case 'audio':
    case 'etree':
      return 'music';
    case 'texts':
      return 'books';
    case 'software':
      return 'apps';
    default:
      return 'other';
  }
}

const first = (v: unknown): string | undefined => (Array.isArray(v) ? first(v[0]) : typeof v === 'string' ? v : undefined);

export function parse(body: string, ctx: ParseContext): SearchResult[] {
  const json = parseJson(body);
  const docs = json?.response?.docs;
  if (!Array.isArray(docs)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const d of docs) {
    const hash = normalizeInfoHash(first(d?.btih));
    const id = first(d?.identifier);
    if (!hash || !id) continue; // no torrent for this item
    const name = first(d.title) ?? id;
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name, ['http://bt1.archive.org:6969/announce', 'http://bt2.archive.org:6969/announce']),
      sizeBytes: toInt(d.item_size),
      publishedAt: toMs(first(d.publicdate)),
      category: categoryFromMediaType(first(d.mediatype)),
      detailUrl: `${ctx.baseUrl.replace(/\/+$/, '')}/details/${id}`,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

// Lucene special characters are dropped from the user's query.
const clean = (q: string) => q.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, ' ').replace(/\s+/g, ' ').trim();

export const archive: SearchProvider = {
  id: ID,
  name: 'Internet Archive',
  abbr: 'IA',
  homepage: 'https://archive.org',
  mirrors: ['https://archive.org'],
  categories: ['movies', 'music', 'books', 'apps', 'other'],
  nsfw: false,
  enabledByDefault: true,
  method: 'json',
  canPage: true,
  async search(q, category, page, ctx) {
    const term = clean(q);
    if (!term) return [];
    let query = `title:(${term}) AND btih:*`;
    const types = MEDIA_TYPES[category];
    if (types) query += ` AND mediatype:(${types.join(' OR ')})`;
    const url =
      `${joinUrl(ctx.baseUrl, '/advancedsearch.php')}?q=${encodeURIComponent(query)}` +
      `&fl[]=title&fl[]=item_size&fl[]=publicdate&fl[]=mediatype&fl[]=identifier&fl[]=btih` +
      `&rows=${ctx.limit}&page=${page}&output=json`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/json' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
