import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, joinUrl, parseJson, ProviderError } from '../http.ts';
import { decodeEntities } from '../text.ts';

export const ID = 'librivox';

/**
 * LibriVox's JSON API. Free public-domain audiobooks. The API gives a ZIP of MP3s (`url_zip_file`) and no info hash,
 * so every result is a direct file (SEARCH_CONTRACT section 9): `magnet` empty, `infoHash` `librivox:<book id>`.
 * Books without a zip yet (still being recorded) are skipped. A search with no hits answers HTTP 404: see search().
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  const json = parseJson(body);
  if (json && typeof json === 'object' && !Array.isArray(json.books) && typeof json.error === 'string') return [];
  const books = json?.books;
  if (!Array.isArray(books)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const b of books) {
    const id = typeof b?.id === 'string' || typeof b?.id === 'number' ? String(b.id) : '';
    const zip = typeof b?.url_zip_file === 'string' ? b.url_zip_file.trim().replace(/ /g, '%20') : '';
    const title = typeof b?.title === 'string' ? decodeEntities(b.title).trim() : '';
    if (!id || !title || !/^https:\/\//i.test(zip)) continue;
    const a = Array.isArray(b.authors) ? b.authors[0] : undefined;
    const author = a ? [a.first_name, a.last_name].filter((s: unknown) => typeof s === 'string' && s).join(' ') : '';
    out.push({
      providerId: ID,
      name: `${title}${author ? ` - ${author}` : ''} (audiobook)`,
      infoHash: `${ID}:${id}`,
      magnet: '',
      directUrl: zip,
      category: 'books',
      detailUrl: typeof b.url_librivox === 'string' && /^https:\/\//i.test(b.url_librivox) ? b.url_librivox : undefined,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const librivox: SearchProvider = {
  id: ID,
  name: 'LibriVox',
  abbr: 'LV',
  homepage: 'https://librivox.org',
  mirrors: ['https://librivox.org'],
  categories: ['books'],
  nsfw: false,
  enabledByDefault: true,
  method: 'json',
  canPage: false,
  async search(q, category, _page, ctx) {
    const term = q.replace(/\s+/g, ' ').trim();
    if (!term || (category !== 'all' && category !== 'books')) return [];
    const pctx = { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit };
    const call = async (field: 'title' | 'author', value: string): Promise<SearchResult[]> => {
      const url = `${joinUrl(ctx.baseUrl, '/api/feed/audiobooks')}?${field}=${encodeURIComponent(value)}&format=json&limit=${ctx.limit}`;
      try {
        return parse(await httpText(url, { signal: ctx.signal, accept: 'application/json' }), pctx);
      } catch (e) {
        // No hits is a 404, not a failure.
        if (e instanceof ProviderError && e.kind === 'http' && e.status === 404) return [];
        throw e;
      }
    };
    // The author field matches a last name, so it gets the last word of the query.
    const lastWord = term.split(' ').pop() ?? term;
    const [byTitle, byAuthor] = await Promise.all([call('title', term), call('author', lastWord).catch(() => [] as SearchResult[])]);
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    for (const r of [...byTitle, ...byAuthor]) {
      if (seen.has(r.infoHash)) continue;
      seen.add(r.infoHash);
      out.push(r);
      if (out.length >= ctx.limit) break;
    }
    return out;
  },
};
