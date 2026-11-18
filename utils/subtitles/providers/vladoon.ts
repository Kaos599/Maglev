// Ported from LavX/bazarr-provider-catalog providers/vladoon (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/vladoon/provider.py
import type { SubtitleCandidate, SubtitleContext, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { httpText, parseJson, ProviderError } from '../../search/http.ts';
import { baseLanguage } from '../languages.ts';
import { httpBytes, toPayload } from '../http.ts';
import { episodeOf, sameTitle, stripSlash } from '../match.ts';

export const ID = 'vladoon';

const EPISODE_RE = /\bs0*(\d{1,2})e0*(\d{1,3})\b/i;
const ALT_EPISODE_RE = /\b0*(\d{1,2})x0*(\d{1,3})\b/i;

function episodeTuple(text: string): [number, number] | null {
  const m = EPISODE_RE.exec(text) ?? ALT_EPISODE_RE.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function releaseNames(item: any): string[] {
  const r = item?.release_names;
  if (typeof r === 'string') return r ? [r] : [];
  return Array.isArray(r) ? r.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0) : [];
}

/** The query text the site is asked for: the title, with S01E02 for an episode. */
export function searchQuery(q: SubtitleQuery): string | null {
  const title = q.title.trim();
  if (!title) return null;
  const ep = episodeOf(q);
  if (!ep) return title;
  return `${title} S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
}

export function searchUrl(base: string, q: SubtitleQuery): string | null {
  const text = searchQuery(q);
  return text ? `${stripSlash(base)}/subs/search-subtitles?q=${encodeURIComponent(text)}` : null;
}

/** A tv item covers the episode when it names it, one of its releases carries it, or it is a pack of that season. */
function coversEpisode(item: any, season: number, episode: number): boolean {
  if (item.season === season && item.episode === episode) return true;
  for (const r of releaseNames(item)) {
    const t = episodeTuple(r);
    if (t && t[0] === season && t[1] === episode) return true;
  }
  return item.episode_type === 'season' && item.season === season;
}

/** `{results: [...]}`. Items for other titles, years or episodes are dropped. */
export function parseSearch(body: string, q: SubtitleQuery): SubtitleCandidate[] {
  const j = parseJson(body);
  if (!j || typeof j !== 'object') throw new ProviderError('parse', 'Unexpected response');
  const list = j.results;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ProviderError('parse', 'Unexpected response');
  const ep = episodeOf(q);
  const out: SubtitleCandidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? '');
    if (!/^[1-9]\d*$/.test(id)) continue;
    if (!sameTitle(item.original_title, q.title) && !sameTitle(item.title, q.title)) continue;
    if (ep) {
      if (item.type && item.type !== 'tv') continue;
      if (!coversEpisode(item, ep.season, ep.episode)) continue;
    } else {
      if (item.type && item.type !== 'movie') continue;
      if (q.year !== undefined && typeof item.year === 'number' && item.year !== q.year) continue;
    }
    const names = releaseNames(item);
    const named =
      ep &&
      names.find((n) => {
        const t = episodeTuple(n);
        return t !== null && t[0] === ep.season && t[1] === ep.episode;
      });
    const release = named || names[0] || String(item.original_title ?? item.title ?? `Vladoon ${id}`);
    const c: SubtitleCandidate = { providerId: ID, id, language: 'bg', releaseName: release, matchedBy: 'title' };
    if (typeof item.downloads === 'number') c.downloads = item.downloads;
    const when = typeof item.upload_date === 'string' ? Date.parse(item.upload_date.replace(' ', 'T').replace(/(\.\d{3})\d+$/, '$1') + 'Z') : NaN;
    if (Number.isFinite(when)) c.uploadedAt = Math.floor(when / 1000);
    out.push(c);
  }
  return out;
}

export function downloadUrl(base: string, id: string): string | null {
  return /^[1-9]\d*$/.test(id) ? `${stripSlash(base)}/subs/download/${id}` : null;
}

export const vladoon: SubtitleProvider = {
  id: ID,
  name: 'Vladoon',
  homepage: 'https://vladoon.com/subs',
  mirrors: ['https://vladoon.com'],
  languages: ['bg'],
  kinds: ['movie', 'episode'],
  matches: ['name'],
  group: 'A',
  enabledByDefault: false,
  async search(q, ctx) {
    if (!q.languages.some((l) => baseLanguage(l) === 'bg')) return [];
    const url = searchUrl(ctx.baseUrl, q);
    if (!url) return [];
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/json', headers: { Referer: `${stripSlash(ctx.baseUrl)}/subs/` } });
    return parseSearch(text, q);
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext) {
    const url = downloadUrl(ctx.baseUrl, c.id);
    if (!url) throw new ProviderError('parse', 'Bad subtitle id');
    const { bytes } = await httpBytes(url, { signal: ctx.signal, accept: 'application/zip, */*', headers: { Referer: `${stripSlash(ctx.baseUrl)}/subs/` } });
    return toPayload(bytes, 'bg');
  },
};
