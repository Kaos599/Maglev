import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, parseJson, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { toInt } from '../text.ts';

export const ID = 'eztv';

const IMDB_SUGGEST = 'https://v2.sg.media-imdb.com/suggestion';

/**
 * EZTV's API has no text search; it lists releases by IMDb id. So a search is two requests:
 * 1) the public IMDb suggestion endpoint turns the query into a series id, 2) EZTV lists that series.
 * The query text is therefore also sent to IMDb (no cookies, no personal data).
 */
export function parseImdbSuggestion(body: string): string | null {
  const json = parseJson(body);
  const rows = json?.d;
  if (!Array.isArray(rows)) throw new ProviderError('parse', 'Unexpected response');
  for (const r of rows) {
    if (!r || typeof r.id !== 'string') continue;
    if ((r.qid === 'tvSeries' || r.qid === 'tvMiniSeries') && /^tt\d+$/.test(r.id)) return r.id.slice(2);
  }
  return null;
}

function releaseName(t: any): string | undefined {
  const dn = /[?&]dn=([^&]+)/.exec(String(t.magnet_url ?? ''))?.[1];
  if (dn) {
    try {
      const clean = decodeURIComponent(dn).replace(/\[ez[^\]]*\]\s*$/i, '').trim();
      if (clean) return clean;
    } catch {
      // fall through to the title
    }
  }
  const title = typeof t.title === 'string' ? t.title.replace(/\s+EZTV$/i, '').trim() : '';
  return title || undefined;
}

export function parse(body: string, ctx: ParseContext): SearchResult[] {
  const json = parseJson(body);
  if (!json || typeof json !== 'object' || (json.torrents !== undefined && !Array.isArray(json.torrents))) {
    throw new ProviderError('parse', 'Unexpected response');
  }
  const out: SearchResult[] = [];
  for (const t of json.torrents ?? []) {
    const hash = normalizeInfoHash(t?.hash);
    const name = t ? releaseName(t) : undefined;
    if (!hash || !name) continue;
    const date = toInt(t.date_released_unix);
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name),
      sizeBytes: toInt(t.size_bytes),
      seeders: toInt(t.seeds),
      leechers: toInt(t.peers),
      publishedAt: date ? date * 1000 : undefined,
      category: 'tv',
      detailUrl: typeof t.episode_url === 'string' ? t.episode_url : undefined,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const eztv: SearchProvider = {
  id: ID,
  name: 'EZTV',
  abbr: 'EZ',
  homepage: 'https://eztvx.to',
  mirrors: ['https://eztvx.to', 'https://eztv.wf', 'https://eztv.tf'],
  categories: ['tv'],
  nsfw: false,
  enabledByDefault: false,
  method: 'json',
  canPage: true,
  async search(q, category, page, ctx) {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const first = /^[a-z0-9]/.test(term) ? term[0] : 'x';
    const suggest = await httpText(`${IMDB_SUGGEST}/${first}/${encodeURIComponent(term)}.json`, {
      signal: ctx.signal,
      accept: 'application/json',
    });
    const imdb = parseImdbSuggestion(suggest);
    if (!imdb) return [];
    const limit = Math.min(Math.max(ctx.limit, 1), 100);
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/api/get-torrents?imdb_id=${imdb}&limit=${limit}&page=${page}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/json' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
