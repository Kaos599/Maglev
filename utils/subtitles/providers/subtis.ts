// Ported from LavX/bazarr-provider-catalog providers/subtis (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/subtis/provider.py
import type { SubtitleCandidate, SubtitleContext, SubtitleProvider, SubtitleQuery, SubFormat } from '../types.ts';
import { httpText, parseJson, ProviderError } from '../../search/http.ts';
import { baseLanguage } from '../languages.ts';
import { httpBytes, toPayload } from '../http.ts';
import { stripSlash } from '../match.ts';

export const ID = 'subtis';

export type SubtisMethod = 'hash' | 'bytes' | 'name' | 'alternative';

const FORMATS = new Set(['srt', 'ass', 'ssa', 'vtt']);

function formatOf(name: string): SubFormat | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ext && FORMATS.has(ext) ? (ext as SubFormat) : undefined;
}

/**
 * One answer of /v1/subtitle/find/file/... or /v1/subtitle/file/alternative/...: `{subtitle, title, ...}`.
 * `hash` and `bytes` mean the file matched; `name` is the exact file name; `alternative` is a fuzzy guess.
 */
export function parseFind(body: string, method: SubtisMethod): SubtitleCandidate | null {
  const j = parseJson(body);
  const sub = j && typeof j === 'object' ? j.subtitle : null;
  if (!sub || typeof sub !== 'object' || sub.id === undefined || sub.id === null) return null;
  const id = String(sub.id);
  if (!/^\d+$/.test(id)) return null;
  const fileName = String(sub.subtitle_file_name ?? '');
  const release = String(sub.title_file_name ?? '') || fileName || String(j.title?.title_name ?? '') || `Subtis ${id}`;
  const c: SubtitleCandidate = {
    providerId: ID,
    id,
    language: 'es',
    releaseName: method === 'alternative' ? `${release} [fuzzy match]` : release,
    matchedBy: method === 'hash' ? 'hash' : method === 'alternative' ? 'title' : 'release',
  };
  const format = formatOf(fileName);
  if (format) c.format = format;
  if (typeof sub.queried_times === 'number') c.downloads = sub.queried_times;
  return c;
}

export function findUrl(base: string, method: SubtisMethod, q: SubtitleQuery): string | null {
  const b = `${stripSlash(base)}/v1/subtitle`;
  if (method === 'hash') return q.hash ? `${b}/find/file/hash/${encodeURIComponent(q.hash)}` : null;
  if (method === 'bytes') return q.videoBytes > 0 ? `${b}/find/file/bytes/${Math.floor(q.videoBytes)}` : null;
  const name = encodeURIComponent(q.fileName);
  return method === 'name' ? `${b}/find/file/name/${name}` : `${b}/file/alternative/${name}`;
}

export function downloadUrl(base: string, id: string): string {
  return `${stripSlash(base)}/v1/subtitle/link/${encodeURIComponent(id)}`;
}

export const subtis: SubtitleProvider = {
  id: ID,
  name: 'Subtis',
  homepage: 'https://subtis.io',
  mirrors: ['https://api.subt.is'],
  languages: ['es'],
  kinds: ['movie'],
  matches: ['hash', 'name'],
  group: 'A',
  enabledByDefault: false,
  async search(q: SubtitleQuery, ctx: SubtitleContext): Promise<SubtitleCandidate[]> {
    if (!q.languages.some((l) => baseLanguage(l) === 'es')) return [];
    // Movies only: the API knows films by file name, size and hash.
    if (q.season !== undefined || q.episode !== undefined) return [];
    const order: SubtisMethod[] = ['hash', 'bytes', 'name', 'alternative'];
    for (const method of order) {
      const url = findUrl(ctx.baseUrl, method, q);
      if (!url) continue;
      let text: string;
      try {
        text = await httpText(url, { signal: ctx.signal, accept: 'application/json' });
      } catch (e) {
        if (e instanceof ProviderError && e.kind === 'http' && e.status === 404) continue;
        throw e;
      }
      const c = parseFind(text, method);
      if (c) return [c];
    }
    return [];
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext) {
    const { bytes } = await httpBytes(downloadUrl(ctx.baseUrl, c.id), { signal: ctx.signal });
    return toPayload(bytes, 'es');
  },
};
