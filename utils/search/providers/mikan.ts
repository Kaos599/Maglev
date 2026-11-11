// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/Mikan.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, infoHashFromMagnet } from '../magnet.ts';
import { decodeEntities, parseSize, stripTags } from '../text.ts';

export const ID = 'mikan';

/** "2026/10/17 23:42" in China time (UTC+8) -> epoch ms. */
export function parseCstDate(s: string | undefined): number | undefined {
  const m = /(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/.exec(s ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]) : undefined;
}

/** Scrape of `tr.js-search-results-row`: name link, copy-magnet link (`data-clipboard-text`), size, date. */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<table|<div/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const out: SearchResult[] = [];
  for (const row of body.split(/<tr class="js-search-results-row"/i).slice(1)) {
    const end = row.indexOf('</tr>');
    const r = end < 0 ? row : row.slice(0, end);
    const link = /<a href="(\/Home\/Episode\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(r);
    const clip = /data-clipboard-text="([^"]+)"/i.exec(r);
    const hash = infoHashFromMagnet(clip ? decodeEntities(clip[1]) : undefined);
    const name = link ? stripTags(link[2]) : '';
    if (!link || !hash || !name) continue;
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name, ['http://nyaa.tracker.wf:7777/announce']),
      sizeBytes: parseSize(cells[2]),
      publishedAt: parseCstDate(cells[3]),
      category: 'anime',
      detailUrl: base + decodeEntities(link[1]),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const mikan: SearchProvider = {
  id: ID,
  name: 'Mikan',
  abbr: 'MK',
  homepage: 'https://mikanani.me',
  mirrors: ['https://mikanani.me'],
  categories: ['anime'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  async search(q, category, page, ctx) {
    if (page > 1) return [];
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/Home/Search?searchstr=${encodeURIComponent(q)}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
