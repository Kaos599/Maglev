import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { decodeEntities, parseSize, stripTags, toInt, toMs } from '../text.ts';

export const ID = 'linuxtracker';

/** Table scrape. The info hash is in the row's link: /torrents/<hash>/. */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<table|<tr/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  const rows = body.split(/(?=<tr[\s>])/i);
  for (const row of rows) {
    const link = /<a[^>]*class="torrent-name"[^>]*href="\/torrents\/([0-9a-fA-F]{40})\/?"[^>]*>([\s\S]*?)<\/a>/i.exec(row)
      ?? /<a[^>]*href="\/torrents\/([0-9a-fA-F]{40})\/?"[^>]*class="torrent-name"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue;
    const hash = normalizeInfoHash(link[1]);
    const name = decodeEntities(stripTags(link[2]));
    if (!hash || !name) continue;
    const date = /<td class="muted-cell">([^<]+)<\/td>/.exec(row)?.[1];
    const size = /<td class="numeric muted-cell">([^<]+)<\/td>/.exec(row)?.[1];
    const seeds = /class="numeric seeds[^"]*">\s*<strong>(\d+)/.exec(row)?.[1];
    const leech = /class="numeric leeches[^"]*">\s*<strong>(\d+)/.exec(row)?.[1];
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name),
      sizeBytes: parseSize(size?.trim()),
      seeders: toInt(seeds),
      leechers: toInt(leech),
      publishedAt: toMs(date?.trim()),
      category: 'apps',
      detailUrl: `${ctx.baseUrl.replace(/\/+$/, '')}/torrents/${hash}/`,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const linuxtracker: SearchProvider = {
  id: ID,
  name: 'LinuxTracker',
  abbr: 'LT',
  homepage: 'https://linuxtracker.org',
  mirrors: ['https://linuxtracker.org'],
  categories: ['apps'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  async search(q, category, page, ctx) {
    if (page > 1) return [];
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/torrents/?q=${encodeURIComponent(q)}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
