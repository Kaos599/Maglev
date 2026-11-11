// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/Btsow.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, parseJson, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { toInt } from '../text.ts';

export const ID = 'btsow';

/** Names carry <em> match markers and zero-width spaces. */
function cleanName(s: string): string {
  return s.replace(/<\/?em>/gi, '').replace(/[​-‍﻿]/g, '').trim();
}

/** Parses the JSON from POST /bts/data/api/search. A DHT index: every row has an info hash and no counts. */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  const json = parseJson(body);
  if (!json || typeof json !== 'object' || !Array.isArray(json.data)) throw new ProviderError('parse', 'Unexpected response');
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const out: SearchResult[] = [];
  for (const row of json.data) {
    const hash = normalizeInfoHash(typeof row?.hash === 'string' ? row.hash : undefined);
    const name = typeof row?.name === 'string' ? cleanName(row.name) : '';
    if (!hash || !name) continue;
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name),
      sizeBytes: toInt(row.size),
      category: 'other',
      detailUrl: `${base}/magnet/detail/${hash}`,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const btsow: SearchProvider = {
  id: ID,
  name: 'Btsow',
  abbr: 'BW',
  homepage: 'https://btsow.live',
  mirrors: ['https://btsow.live'],
  categories: ['other'],
  nsfw: false,
  unsafeReason: 'A search over the public DHT. Nobody checks what gets listed, so fake and harmful files turn up. Check the name and size before opening anything.',
  enabledByDefault: false,
  method: 'json',
  canPage: false,
  async search(q, category, _page, ctx) {
    const text = await httpText(`${ctx.baseUrl.replace(/\/+$/, '')}/bts/data/api/search`, {
      signal: ctx.signal,
      accept: 'application/json',
      method: 'POST',
      body: JSON.stringify([{ search: q.trim() }, ctx.limit, 1]),
      contentType: 'application/json',
    });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
