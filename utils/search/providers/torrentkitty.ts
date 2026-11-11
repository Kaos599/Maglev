// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/TorrentKitty.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { infoHashFromMagnet } from '../magnet.ts';
import { decodeEntities, parseSize, stripTags, toMs } from '../text.ts';

export const ID = 'torrentkitty';

const cellOf = (row: string, cls: string) => new RegExp(`<td class="${cls}"[^>]*>([\\s\\S]*?)</td>`, 'i').exec(row)?.[1] ?? '';

/**
 * Fragile scrape of `table#archiveResult`. Each row has name / size / date cells and an action cell with
 * a Detail link and a magnet link. The "No result" row has an empty action cell, so it is skipped.
 * TorrentKitty's sizes are often tiny and wrong (they come from DHT metadata): treat them as a hint.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<div|<table/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  for (const row of body.split(/<tr[\s>]/i).slice(1)) {
    const mag = /href="(magnet:\?[^"]+)"/i.exec(row);
    if (!mag) continue;
    const magnet = decodeEntities(mag[1]);
    const hash = infoHashFromMagnet(magnet);
    const name = stripTags(cellOf(row, 'name'));
    if (!hash || !name) continue;
    const detail = /<a href="(\/information\/[^"]+)"/i.exec(row)?.[1];
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet,
      sizeBytes: parseSize(stripTags(cellOf(row, 'size'))),
      publishedAt: toMs(stripTags(cellOf(row, 'date'))),
      category: 'other',
      detailUrl: detail ? base + decodeEntities(detail) : undefined,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const torrentkitty: SearchProvider = {
  id: ID,
  name: 'TorrentKitty',
  abbr: 'TK',
  homepage: 'https://torrentkitty.tv',
  mirrors: ['https://torrentkitty.tv'],
  categories: ['other'],
  nsfw: false,
  unsafeReason: 'A search over the public DHT. Nobody checks what gets listed, so fake and harmful files turn up. Check the name and size before opening anything.',
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  async search(q, category, _page, ctx) {
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/search/${encodeURIComponent(q.trim())}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
