import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, infoHashFromMagnet } from '../magnet.ts';
import { decodeEntities, stripTags, toInt } from '../text.ts';

export const ID = 'animetosho';

/** "05/05/2026 20:50" (day first, treated as UTC) -> epoch ms. */
function parseSubmitted(s: string | undefined): number | undefined {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(s ?? '');
  if (!m) return undefined;
  return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0));
}

/**
 * Scrape of the search page. Each result is a `home_list_entry` block with the title link,
 * a size in a tooltip, a magnet link and "Seeders: n / Leechers: n". Entries that do not match are skipped.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<div/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  const entries = body.split(/(?=<div class="home_list_entry[ "])/).slice(1);
  for (const e of entries) {
    const title = /<div class="link"><a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(e);
    const mag = /href="(magnet:[^"]+)"/.exec(e);
    if (!title || !mag) continue;
    const magnet = decodeEntities(mag[1]);
    const hash = infoHashFromMagnet(magnet);
    const name = decodeEntities(stripTags(title[2]));
    if (!hash || !name) continue;
    const size = /Total file size: ([\d,]+) bytes/.exec(e)?.[1];
    const seeds = /Seeders: (\d+) \/ Leechers: (\d+)/.exec(e);
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name, ['http://nyaa.tracker.wf:7777/announce']),
      sizeBytes: toInt(size?.replace(/,/g, '')),
      seeders: toInt(seeds?.[1]),
      leechers: toInt(seeds?.[2]),
      publishedAt: parseSubmitted(/Date\/time submitted: ([^"]+)"/.exec(e)?.[1]),
      category: 'anime',
      detailUrl: title[1].startsWith('http') ? title[1] : undefined,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const animetosho: SearchProvider = {
  id: ID,
  name: 'AnimeTosho',
  abbr: 'AT',
  homepage: 'https://animetosho.org',
  mirrors: ['https://animetosho.org'],
  categories: ['anime'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: true,
  async search(q, category, page, ctx) {
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(q)}&page=${page}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
