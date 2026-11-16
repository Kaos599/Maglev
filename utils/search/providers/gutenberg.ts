import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, joinUrl, ProviderError } from '../http.ts';
import { decodeEntities, extractBlocks, tagText } from '../text.ts';

export const ID = 'gutenberg';

/**
 * Project Gutenberg's official OPDS search feed. Public-domain books, so the result is a plain EPUB (SEARCH_CONTRACT
 * section 9): `directUrl` points at the EPUB3 with images, `magnet` is empty and `infoHash` is `gutenberg:<book id>`.
 * The search feed has no acquisition links, only the book id; the EPUB path is the one the book's own OPDS page lists.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<feed[\s>]/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const entry of extractBlocks(body, 'entry')) {
    const id = /<id>[^<]*\/ebooks\/(\d+)\.opds<\/id>/i.exec(entry)?.[1];
    const title = tagText(entry, 'title');
    if (!id || !title) continue; // "No records found", author or subject rows
    const author = tagText(entry, 'content');
    const base = ctx.baseUrl.replace(/\/+$/, '');
    out.push({
      providerId: ID,
      name: author ? `${decodeEntities(title)} - ${decodeEntities(author)}` : decodeEntities(title),
      infoHash: `${ID}:${id}`,
      magnet: '',
      directUrl: `${base}/ebooks/${id}.epub3.images`,
      category: 'books',
      detailUrl: `${base}/ebooks/${id}`,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const gutenberg: SearchProvider = {
  id: ID,
  name: 'Project Gutenberg',
  abbr: 'PG',
  homepage: 'https://www.gutenberg.org',
  mirrors: ['https://www.gutenberg.org'],
  categories: ['books'],
  nsfw: false,
  enabledByDefault: true,
  method: 'rss',
  canPage: false,
  async search(q, category, _page, ctx) {
    const term = q.replace(/\s+/g, ' ').trim();
    if (!term || (category !== 'all' && category !== 'books')) return [];
    const url = `${joinUrl(ctx.baseUrl, '/ebooks/search.opds/')}?query=${encodeURIComponent(term)}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/atom+xml, application/xml' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
