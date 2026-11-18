// Ported from LavX/bazarr-provider-catalog providers/regielive (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/regielive/provider.py
import type { SubtitleCandidate, SubtitleContext, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { httpText, parseJson, ProviderError } from '../../search/http.ts';
import { baseLanguage } from '../languages.ts';
import { httpBytes, toPayload } from '../http.ts';
import { stripSlash } from '../match.ts';

export const ID = 'regielive';

/** The fixed key RegieLive's Bazarr endpoint expects (the same constant Bazarr ships). It is not an account. */
const API_HEADER = 'API-BAZARR-YTZ-SL';
const DOWNLOAD_ORIGIN = 'https://subtitrari.regielive.ro';
const MAX_RESULTS = 20;

/** `descarca-<show>-<subtitle>.zip`, the only shape the site hands out. */
const FILE_RE = /\/(descarca-\d+-\d+\.zip)$/;

/** The search API answers `{rezultate: {<show id>: {film, subtitrari: {<id>: {titlu, rating:{nota}, url}}}}}`. */
export function parseSearch(body: string): SubtitleCandidate[] {
  const j = parseJson(body);
  const groups = j && typeof j === 'object' ? j.rezultate : null;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return [];
  const rows: { c: SubtitleCandidate; rating: number }[] = [];
  const seen = new Set<string>();
  for (const group of Object.values(groups) as any[]) {
    const subs = group && typeof group === 'object' ? group.subtitrari : null;
    if (!subs || typeof subs !== 'object') continue;
    for (const [subId, item] of Object.entries(subs) as [string, any][]) {
      if (!item || typeof item !== 'object' || seen.has(subId)) continue;
      const title = String(item.titlu ?? '').trim();
      const file = FILE_RE.exec(String(item.url ?? ''))?.[1];
      if (!title || !file) continue;
      seen.add(subId);
      const rating = Number(item.rating?.nota);
      rows.push({
        rating: Number.isFinite(rating) ? rating : 0,
        c: { providerId: ID, id: file, language: 'ro', releaseName: title, matchedBy: 'title' },
      });
    }
  }
  rows.sort((a, b) => b.rating - a.rating || a.c.releaseName.localeCompare(b.c.releaseName));
  return rows.slice(0, MAX_RESULTS).map((r) => r.c);
}

export function searchUrl(base: string, q: SubtitleQuery): string | null {
  const title = q.title.trim();
  if (!title) return null;
  const p = new URLSearchParams({ nume: title });
  if (q.season !== undefined && q.episode !== undefined) {
    p.set('sezon', String(q.season));
    p.set('episod', String(q.episode));
  }
  if (q.year !== undefined) p.set('an', String(q.year));
  return `${stripSlash(base)}/bazarr/search.php?${p.toString()}`;
}

export function downloadUrl(id: string): string | null {
  return /^descarca-\d+-\d+\.zip$/.test(id) ? `${DOWNLOAD_ORIGIN}/${id}` : null;
}

export const regielive: SubtitleProvider = {
  id: ID,
  name: 'RegieLive',
  homepage: 'https://subtitrari.regielive.ro',
  mirrors: ['https://api.regielive.ro'],
  languages: ['ro'],
  kinds: ['movie', 'episode'],
  matches: ['name'],
  group: 'A',
  enabledByDefault: false,
  async search(q, ctx) {
    if (!q.languages.some((l) => baseLanguage(l) === 'ro')) return [];
    const url = searchUrl(ctx.baseUrl, q);
    if (!url) return [];
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/json', headers: { 'RL-API': API_HEADER } });
    return parseSearch(text);
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext) {
    const url = downloadUrl(c.id);
    if (!url) throw new ProviderError('parse', 'Bad subtitle id');
    const { bytes } = await httpBytes(url, { signal: ctx.signal });
    // The site answers a failed download with the text "500".
    if (bytes.length < 16) throw new ProviderError('http', 'Not answering right now', 500);
    return toPayload(bytes, 'ro');
  },
};
