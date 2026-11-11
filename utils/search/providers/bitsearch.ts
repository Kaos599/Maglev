import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, infoHashFromMagnet } from '../magnet.ts';
import { decodeEntities, parseSize, stripTags, toInt, toMs } from '../text.ts';

export const ID = 'bitsearch';

// BitSearch category label -> Maglev category (keyword match on its "Group/Sub" label).
function categoryFromLabel(label: string | undefined): Category | undefined {
  if (!label) return undefined;
  const l = label.toLowerCase();
  if (l.startsWith('video/movie') || l.includes('movie')) return 'movies';
  if (l.includes('tv') || l.includes('series')) return 'tv';
  if (l.includes('anime')) return 'anime';
  if (l.startsWith('audio') || l.includes('music')) return 'music';
  if (l.includes('software') || l.includes('app')) return 'apps';
  if (l.includes('game')) return 'games';
  if (l.includes('book')) return 'books';
  if (l.includes('adult') || l.includes('xxx')) return 'adult';
  return 'other';
}

/**
 * Fragile scrape. Each result card has an <h3> with the title link followed by a magnet anchor.
 * Anything that does not match is skipped; a page with no cards is an empty result.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<div|<table/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  const chunks = body.split(/(?=<h3[\s>])/i);
  for (const chunk of chunks) {
    const mag = /href="(magnet:[^"]+)"/i.exec(chunk);
    const titleM = /<h3[^>]*>\s*<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!mag || !titleM) continue;
    const magnet = decodeEntities(mag[1]);
    const hash = infoHashFromMagnet(magnet);
    const name = stripTags(titleM[2]);
    if (!hash || !name) continue;
    const meta = chunk.slice(0, mag.index);
    const catLabel = /<span>([A-Za-z]+\/[A-Za-z0-9 \-]+)<\/span>/.exec(meta)?.[1];
    const size = /fa-download"><\/i>\s*<span>([\d.,]+\s*[KMGT]i?B)<\/span>/i.exec(meta)?.[1];
    const date = /fa-calendar"><\/i>\s*<span>([^<]+)<\/span>/i.exec(meta)?.[1];
    const seeders = /<span class="font-medium">\s*([\d,]+)\s*<\/span>\s*<span>\s*seeders/i.exec(meta)?.[1];
    const leechers = /<span class="font-medium">\s*([\d,]+)\s*<\/span>\s*<span>\s*leechers/i.exec(meta)?.[1];
    const category = categoryFromLabel(catLabel);
    if (ctx.hideAdult && category === 'adult') continue;
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: magnet.startsWith('magnet:?') ? magnet : buildMagnet(hash, name),
      sizeBytes: parseSize(size),
      seeders: toInt(seeders?.replace(/,/g, '')),
      leechers: toInt(leechers?.replace(/,/g, '')),
      publishedAt: toMs(date?.trim()),
      category,
      detailUrl: titleM[1].startsWith('/') ? ctx.baseUrl.replace(/\/+$/, '') + titleM[1] : undefined,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const bitsearch: SearchProvider = {
  id: ID,
  name: 'BitSearch',
  abbr: 'BS',
  homepage: 'https://bitsearch.eu',
  mirrors: ['https://bitsearch.eu'],
  categories: ['movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: true,
  async search(q, category, page, ctx) {
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(q)}&sort=seeders&page=${page}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
