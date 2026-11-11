import type { ParseContext, SearchProvider } from '../types.ts';
import { httpText } from '../http.ts';
import { parseNyaaRss } from './nyaa.ts';

export const ID = 'sukebei';

export const parse = (body: string, ctx: ParseContext) => parseNyaaRss(ID, body, ctx, 'adult');

export const sukebei: SearchProvider = {
  id: ID,
  name: 'Sukebei',
  abbr: 'SK',
  homepage: 'https://sukebei.nyaa.si',
  mirrors: ['https://sukebei.nyaa.si'],
  categories: ['adult'],
  nsfw: true,
  enabledByDefault: false,
  method: 'rss',
  canPage: true,
  async search(q, category, page, ctx) {
    if (ctx.hideAdult) return [];
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/?page=rss&f=0&c=0_0&q=${encodeURIComponent(q)}&p=${page}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/rss+xml, application/xml, text/xml' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
