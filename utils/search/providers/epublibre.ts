// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/EpubLibre.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, parseJson, ProviderError } from '../http.ts';
import { stripTags } from '../text.ts';
import { firstMagnet } from './nicheText.ts';

export const ID = 'epublibre';

/**
 * EpubLibre answers a POST with JSON `{ contenido: "<html>" }`. The HTML holds one `div.span2` cover per
 * book; there is no magnet in it, so rows carry `detailUrl` and an empty `magnet` for `resolveMagnet`.
 * `infoHash` is a stand-in (`epublibre:<book id>`). Spanish-language books.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  const json = parseJson(body);
  const html = typeof json?.contenido === 'string' ? json.contenido : null;
  if (html === null) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const block of html.split(/<div class="span2\b/i).slice(1)) {
    const href = /<a id="stk" href="([^"]+)"/i.exec(block)?.[1];
    const name = /<div class="texto-portada">[\s\S]*?<h1>([\s\S]*?)<\/h1>/i.exec(block)?.[1];
    if (!href || !name) continue;
    const author = /<div class="texto-portada">\s*<h2>([\s\S]*?)<\/h2>/i.exec(block)?.[1];
    const title = stripTags(name);
    if (!title) continue;
    out.push({
      providerId: ID,
      name: author && stripTags(author) ? `${title} - ${stripTags(author)}` : title,
      infoHash: `${ID}:${href.replace(/\/+$/, '').split('/').pop()}`,
      magnet: '',
      category: 'books',
      detailUrl: href,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const epublibre: SearchProvider = {
  id: ID,
  name: 'EpubLibre',
  abbr: 'EL',
  homepage: 'https://epublibre.org',
  mirrors: ['https://epublibre.org'],
  categories: ['books'],
  nsfw: false,
  enabledByDefault: false,
  method: 'json',
  canPage: false,
  async search(q, category, page, ctx) {
    if (page > 1) return [];
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/catalogo/index/0/nuevo/todos/sin/todos/${encodeURIComponent(q.trim())}/ajax`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/json', method: 'POST', body: '', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    if (!result.detailUrl || !/^https?:\/\//i.test(result.detailUrl)) throw new ProviderError('parse', 'No page to read the magnet from');
    const found = firstMagnet(await httpText(result.detailUrl, { signal, accept: 'text/html' }));
    if (!found) throw new ProviderError('parse', 'No magnet link on the page');
    return found;
  },
};
