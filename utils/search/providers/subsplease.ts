import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, parseJson, ProviderError } from '../http.ts';
import { buildMagnet, infoHashFromMagnet } from '../magnet.ts';
import { toInt, toMs } from '../text.ts';

export const ID = 'subsplease';

function magnetParam(magnet: string, key: string): string | undefined {
  const m = new RegExp(`[?&]${key}=([^&]+)`).exec(magnet);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}

/**
 * The search API returns an object keyed by "Show - Episode", each with one download per
 * resolution. An empty search returns `[]`. It has no seeder counts.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  const json = parseJson(body);
  if (!json || typeof json !== 'object') throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const entry of Array.isArray(json) ? [] : Object.values<any>(json)) {
    if (!entry || !Array.isArray(entry.downloads)) continue;
    const published = toMs(entry.release_date);
    for (const d of entry.downloads) {
      const magnet = typeof d?.magnet === 'string' ? d.magnet : '';
      const hash = infoHashFromMagnet(magnet);
      if (!hash) continue;
      const name = magnetParam(magnet, 'dn') ?? `[SubsPlease] ${entry.show} - ${entry.episode} (${d.res}p)`;
      out.push({
        providerId: ID,
        name,
        infoHash: hash,
        magnet: buildMagnet(hash, name, ['http://nyaa.tracker.wf:7777/announce']),
        sizeBytes: toInt(magnetParam(magnet, 'xl')),
        publishedAt: published,
        category: 'anime',
        detailUrl: 'https://subsplease.org/shows/',
      });
      if (out.length >= ctx.limit) return out;
    }
  }
  return out;
}

export const subsplease: SearchProvider = {
  id: ID,
  name: 'SubsPlease',
  abbr: 'SP',
  homepage: 'https://subsplease.org',
  mirrors: ['https://subsplease.org'],
  categories: ['anime'],
  nsfw: false,
  enabledByDefault: false,
  method: 'json',
  canPage: false,
  async search(q, category, page, ctx) {
    if (page > 1) return [];
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/api/?f=search&tz=UTC&s=${encodeURIComponent(q)}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/json' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
