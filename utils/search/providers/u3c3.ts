import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, infoHashFromMagnet } from '../magnet.ts';
import { decodeEntities, parseSize, stripTags } from '../text.ts';

export const ID = 'u3c3';

/** "2026-11-16 10:53:23" (the site shows China time) -> epoch ms. */
function parseDate(s: string | undefined): number | undefined {
  const m = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] ?? 0)) : undefined;
}

/**
 * Scrape of the result table. Real rows link their title to `/view?id=...` and carry a magnet in the third cell.
 * The first rows are pinned ads (title links to another site, size 999GB, date in 2099): a row is kept only
 * when its title points at `/view`. Every row is adult content.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<table|<tr/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  if (ctx.hideAdult) return [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const row of body.split(/<tr\b[^>]*>/i).slice(1)) {
    const cells = row.split(/<td\b[^>]*>/i).slice(1);
    if (cells.length < 5) continue;
    const link = /<a\s+[^>]*href="(\/view\?id=[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(cells[1]);
    if (!link) continue; // ad row or header
    const magnet = /href="(magnet:\?[^"]+)"/i.exec(cells[2])?.[1];
    const hash = infoHashFromMagnet(magnet ? decodeEntities(magnet) : undefined);
    const name = decodeEntities(stripTags(link[2]));
    if (!hash || !name || seen.has(hash)) continue;
    seen.add(hash);
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name),
      sizeBytes: parseSize(stripTags(cells[3])),
      publishedAt: parseDate(stripTags(cells[4])),
      category: 'adult',
      detailUrl: base + decodeEntities(link[1]),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/**
 * The search form's `search2` value. The site rotates it, and a stale one makes it ignore the query, so it is read
 * from the home page's search script. A commented-out line (`//var nmefafej = ...`) is skipped.
 */
export function parseToken(body: string): string {
  const m = /^[ \t]*var\s+nmefafej\s*=\s*"([A-Za-z0-9]+)"/m.exec(body);
  if (!m) throw new ProviderError('parse', 'Search token not found');
  return m[1];
}

export const u3c3: SearchProvider = {
  id: ID,
  name: 'U3C3',
  abbr: 'U3',
  homepage: 'https://u3c3.com',
  mirrors: ['https://u3c3.com'],
  categories: ['adult'],
  nsfw: true,
  enabledByDefault: false,
  method: 'html',
  canPage: true,
  async search(q, category, page, ctx) {
    if (ctx.hideAdult) return [];
    const base = ctx.baseUrl.replace(/\/+$/, '');
    const home = await httpText(`${base}/`, { signal: ctx.signal, accept: 'text/html' });
    const token = parseToken(home);
    const url = `${base}/?${page > 1 ? `p=${page}&` : ''}search2=${token}&search=${encodeURIComponent(q.trim())}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
