// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/FileMood.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { decodeEntities, parseSize, stripTags, toInt } from '../text.ts';

export const ID = 'filemood';

const cellOf = (row: string, cls: string) => new RegExp(`<td class="${cls}"[^>]*>([\\s\\S]*?)</td>`, 'i').exec(row)?.[1] ?? '';

/**
 * Fragile scrape. Result rows are the `<tr>`s with a `dn-title` cell. The info hash is the last
 * dash-separated part of the detail link ("name-<hash>.html"), so no detail fetch is needed.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<div|<table/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  for (const row of body.split(/<tr[\s>]/i).slice(1)) {
    const titleCell = cellOf(row, 'dn-title');
    const href = /<a [^>]*href="([^"]+\.html)"/i.exec(row)?.[1];
    if (!titleCell || !href) continue;
    const hash = normalizeInfoHash(/-([0-9a-fA-F]{40})\.html$/.exec(href)?.[1]);
    const name = stripTags(titleCell.replace(/<\/?(?:span|mark|b|em|strong)\b[^>]*>/gi, '')); // inline highlight tags must not add spaces
    if (!hash || !name) continue;
    const [seeds, peers] = stripTags(cellOf(row, 'dn-status')).split('/');
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name),
      sizeBytes: parseSize(stripTags(cellOf(row, 'dn-size'))),
      seeders: toInt(seeds?.trim()),
      leechers: toInt(peers?.trim()),
      category: 'other',
      detailUrl: href.startsWith('/') ? base + decodeEntities(href) : decodeEntities(href),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const filemood: SearchProvider = {
  id: ID,
  name: 'FileMood',
  abbr: 'FM',
  homepage: 'https://filemood.com',
  mirrors: ['https://filemood.com'],
  categories: ['other'],
  nsfw: false,
  unsafeReason: 'A search over the public DHT. Nobody checks what gets listed, so fake and harmful files turn up. Check the name and size before opening anything.',
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  async search(q, category, _page, ctx) {
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/result?q=${encodeURIComponent(q.trim())}+in%3Atitle`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
