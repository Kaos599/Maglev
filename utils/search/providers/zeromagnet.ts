// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/ZeroMagnet.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { infoHashFromMagnet } from '../magnet.ts';
import { decodeEntities, parseSize, stripTags, toMs } from '../text.ts';

export const ID = 'zeromagnet';

/**
 * Fragile scrape of `table.file-list`. The list has no magnet and no info hash: each row carries a
 * `detailUrl` and an empty `magnet`; `resolveMagnet` reads the detail page when the user adds it.
 * `infoHash` is a stand-in key (`zeromagnet:<page id>`) until then, so rows never merge with other sources.
 * Every result is adult.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<div|<table/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  if (ctx.hideAdult) return [];
  const out: SearchResult[] = [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  for (const row of body.split(/<tr[\s>]/i).slice(1)) {
    const link = /<td class="result-title"[^>]*>\s*<a href="(\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue;
    const name = stripTags(link[2].replace(/<\/?(?:span|mark|b|em|strong)\b[^>]*>/gi, '')); // inline highlight tags must not add spaces
    const id = decodeEntities(link[1]).replace(/^\/+/, '');
    if (!name || !id) continue;
    const meta = /<td class="result-meta"[^>]*>([\s\S]*?)<\/td>/i.exec(row)?.[1] ?? '';
    const size = /<div>\s*([^<]*?)\s*<\/div>/i.exec(meta)?.[1];
    const date = /<div class="result-date">\s*([^<]*?)\s*<\/div>/i.exec(meta)?.[1];
    out.push({
      providerId: ID,
      name,
      infoHash: `${ID}:${id}`,
      magnet: '',
      sizeBytes: parseSize(size),
      publishedAt: toMs(date),
      category: 'adult',
      detailUrl: `${base}/${id}`,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/** The magnet link on a detail page: an `<input id="input-magnet" value="magnet:...">`. */
export function parseMagnet(body: string): { magnet: string; infoHash: string } {
  const tag = /<input\b[^>]*\bid="input-magnet"[^>]*>/i.exec(body)?.[0];
  const value = tag ? /\bvalue="([^"]*)"/i.exec(tag)?.[1] : undefined;
  const magnet = value ? decodeEntities(value) : '';
  const hash = infoHashFromMagnet(magnet);
  if (!hash) throw new ProviderError('parse', 'No magnet link on the page');
  return { magnet, infoHash: hash };
}

export const zeromagnet: SearchProvider = {
  id: ID,
  name: '0Magnet',
  abbr: '0M',
  homepage: 'https://9mag.net',
  mirrors: ['https://9mag.net'],
  categories: ['adult'],
  nsfw: true,
  unsafeReason: 'A search over the public DHT. Nobody checks what gets listed, so fake and harmful files turn up. Check the name and size before opening anything.',
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  async search(q, category, _page, ctx) {
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(q.trim())}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    if (!result.detailUrl || !/^https?:\/\//i.test(result.detailUrl)) throw new ProviderError('parse', 'No page to read the magnet from');
    return parseMagnet(await httpText(result.detailUrl, { signal, accept: 'text/html' }));
  },
};
