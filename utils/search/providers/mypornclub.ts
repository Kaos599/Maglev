// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/MyPornClub.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { infoHashFromMagnet } from '../magnet.ts';
import { parseRelative } from '../dates.ts';
import { decodeEntities, parseSize, stripTags, toInt } from '../text.ts';

export const ID = 'mypornclub';

/** The title span holds hash tags and a "NEW" badge as child elements and may carry literal `\n` / `\'` escapes. */
function cleanTitle(inner: string): string {
  const own = inner.replace(/<i\b[\s\S]*?<\/i>/gi, ' ').replace(/<b\b[\s\S]*?<\/b>/gi, ' ');
  let t = stripTags(own);
  const nl = t.indexOf('\\n');
  if (nl >= 0) t = t.slice(0, nl);
  return t.replace(/\\'/g, "'").replace(/\\/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Fragile scrape of the result list. The list has no magnet and no info hash: each row carries a
 * `detailUrl` and an empty `magnet`; `resolveMagnet` reads the detail page when the user adds it.
 * `infoHash` is a stand-in key (`mypornclub:<id>`) until then. Every row is adult content.
 */
export function parse(body: string, ctx: ParseContext, now = Date.now()): SearchResult[] {
  if (!/<html|<body|<div/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  if (ctx.hideAdult) return [];
  const out: SearchResult[] = [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  for (const row of body.split(/<div class='torrent_element'>/i).slice(1)) {
    // Titles in the link's attributes can contain ">", so read the id and the title span directly.
    const id = /data-alphaid='([A-Za-z0-9]+)'/i.exec(row)?.[1];
    const title = /<span class='torrent_element_text_span'>([\s\S]*?)<\/span>/i.exec(row)?.[1];
    if (!id || title == null) continue;
    const name = cleanTitle(title);
    if (!name) continue;
    const info = row.slice(row.indexOf("class='torrent_element_info'"));
    const added = /\[added\]:<\/span><span class='teiv'>([\s\S]*?)<\/span>/i.exec(info)?.[1];
    const size = /\[size\]:<\/span><span class='teiv'>([\s\S]*?)<\/span>/i.exec(info)?.[1];
    const seeders = /teiv_seeders'>\s*([\d,]+)/i.exec(info)?.[1];
    const leechers = /teiv_leechers'>\s*([\d,]+)/i.exec(info)?.[1];
    out.push({
      providerId: ID,
      name,
      infoHash: `${ID}:${id}`,
      magnet: '',
      sizeBytes: parseSize(size ? stripTags(size) : undefined),
      seeders: toInt(seeders?.replace(/,/g, '')),
      leechers: toInt(leechers?.replace(/,/g, '')),
      // The age sits in a link whose title attribute can contain ">", so take the text before the closing </a>.
      publishedAt: parseRelative(added == null ? undefined : (/([^<>]*)<\/a>\s*$/.exec(added)?.[1] ?? stripTags(added)), now),
      category: 'adult',
      detailUrl: `${base}/t/${id}`,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/** The magnet link on a detail page (single-quoted href on the "md_btn" button). */
export function parseMagnet(body: string): { magnet: string; infoHash: string } {
  const m = /href=['"](magnet:\?[^'"]+)['"]/i.exec(body);
  const magnet = m ? decodeEntities(m[1]) : '';
  const hash = infoHashFromMagnet(magnet);
  if (!hash) throw new ProviderError('parse', 'No magnet link on the page');
  return { magnet, infoHash: hash };
}

export function searchUrl(base: string, q: string, page: number): string {
  const b = base.replace(/\/+$/, '');
  const term = encodeURIComponent(q.trim().replace(/\s+/g, '-'));
  return `${b}/s/${term}/seeders${page > 1 ? `/${page}` : ''}`;
}

export const mypornclub: SearchProvider = {
  id: ID,
  name: 'MyPornClub',
  abbr: 'MP',
  homepage: 'https://myporn.club',
  mirrors: ['https://myporn.club'],
  categories: ['adult'],
  nsfw: true,
  enabledByDefault: false,
  method: 'html',
  canPage: true,
  async search(q, category, page, ctx) {
    if (ctx.hideAdult) return [];
    const text = await httpText(searchUrl(ctx.baseUrl, q, page), { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    if (!result.detailUrl || !/^https?:\/\//i.test(result.detailUrl)) throw new ProviderError('parse', 'No page to read the magnet from');
    return parseMagnet(await httpText(result.detailUrl, { signal, accept: 'text/html' }));
  },
};
