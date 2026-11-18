// Ported from LavX/bazarr-provider-catalog (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/subclub/provider.py
import { decodeEntities, stripTags } from '../../search/text.ts';
import { baseLanguage } from '../languages.ts';
import type { SubFormat, SubtitleCandidate, SubtitleContext, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { httpBytes, httpPageBytes, toPayload } from '../http.ts';
import { joinBase, pathOf, resolveHref, titleMatches } from '../match.ts';

export const ID = 'subclub';

export interface Hit {
  archiveId: string;
  title: string;
  year: number;
  season?: number;
  episode?: number;
  imdbId?: string;
  downloads?: number;
  rating?: number;
}

export interface ArchiveFile {
  filename: string;
  /** Site-root path, "/down.php?id=10100&filename=..." */
  path: string;
}

/** Result rows are the outer `<tr class="alt1">` rows; the cells inside hold smaller tables of their own. */
export function parseSearch(body: string): Hit[] {
  const starts = [...body.matchAll(/<tr\b[^>]*class=['"][^'"]*\balt\d?\b[^'"]*['"][^>]*>/gi)];
  const hits: Hit[] = [];
  starts.forEach((s, i) => {
    const from = s.index ?? 0;
    const to = Math.min(i + 1 < starts.length ? (starts[i + 1].index ?? body.length) : body.length, from + 12000);
    const row = body.slice(from, to);
    let archiveId = '';
    let titleText = '';
    for (const a of row.matchAll(/<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = decodeEntities(a[1]);
      const id = /down\.php\?id=(\d+)/i.exec(href)?.[1];
      if (!id || href.includes('filename=')) continue;
      archiveId = id;
      titleText = stripTags(a[2]);
      break;
    }
    const t = /^(.+?)\s*\((\d{4})\)(?:\s*\[(\d+)x(\d+)\])?\s*$/i.exec(titleText);
    if (!archiveId || !t) return;
    const nums = [...row.matchAll(/<td>\s*(\d+)\s*<\/td>/g)];
    const rating = /<span\b[^>]*title=['"]Hindajaid:[^'"]*['"][^>]*>([\s\S]*?)<\/span>/i.exec(row)?.[1];
    hits.push({
      archiveId,
      title: t[1].trim(),
      year: parseInt(t[2], 10),
      ...(t[3] ? { season: parseInt(t[3], 10), episode: parseInt(t[4], 10) } : {}),
      ...(/tt\d+/i.exec(row) ? { imdbId: /tt\d+/i.exec(row)![0] } : {}),
      ...(nums[0] ? { downloads: parseInt(nums[0][1], 10) } : {}),
      ...(rating && Number.isFinite(parseFloat(stripTags(rating))) ? { rating: parseFloat(stripTags(rating)) } : {}),
    });
  });
  return hits.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
}

/** The "archive contents" list: one link per subtitle file, each a download of that single file. */
export function parseArchiveList(body: string, baseUrl: string): ArchiveFile[] {
  const out: ArchiveFile[] = [];
  for (const m of body.matchAll(/<a\b[^>]*href=['"]([^'"]*down\.php\?id=\d+[^'"]*filename=[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi)) {
    const filename = stripTags(m[2]);
    if (!/\.(srt|ass|ssa|vtt|sub)$/i.test(filename)) continue;
    out.push({ filename, path: pathOf(resolveHref(`${baseUrl.replace(/\/+$/, '')}/x/`, decodeEntities(m[1]))) });
  }
  return out;
}

export function hitFits(hit: Hit, q: Pick<SubtitleQuery, 'title' | 'year' | 'season' | 'episode' | 'episodeConfidence'>): boolean {
  const episode = q.episodeConfidence === 'sure' && q.season !== undefined && q.episode !== undefined;
  if (episode) return hit.season === q.season && hit.episode === q.episode && titleMatches(q.title, hit.title);
  if (hit.season !== undefined || hit.episode !== undefined) return false;
  if (q.year && hit.year !== q.year) return false;
  return titleMatches(q.title, hit.title);
}

export function candidatesFor(hit: Hit, files: ArchiveFile[]): SubtitleCandidate[] {
  // A listing that is empty means we can't see inside; offer the whole archive (it fails cleanly if it is a RAR).
  const list = files.length ? files : [{ filename: `subclub-${hit.archiveId}`, path: `/down.php?id=${hit.archiveId}` }];
  return list.map((f) => {
    const ext = /\.([a-z]{3})$/i.exec(f.filename)?.[1].toLowerCase();
    const format = (['srt', 'ass', 'ssa', 'vtt'] as SubFormat[]).find((k) => k === ext);
    return {
      providerId: ID,
      id: f.path,
      language: 'et',
      releaseName: f.filename.replace(/\.(srt|ass|ssa|vtt|sub)$/i, ''),
      matchedBy: 'title' as const,
      ...(format ? { format } : {}),
      ...(hit.downloads !== undefined ? { downloads: hit.downloads } : {}),
    };
  });
}

export const subclub: SubtitleProvider = {
  id: ID,
  name: 'Subclub',
  homepage: 'https://www.subclub.eu',
  mirrors: ['https://www.subclub.eu'],
  languages: ['et'],
  kinds: ['movie', 'episode'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q, ctx) {
    if (!q.languages.some((l) => baseLanguage(l) === 'et')) return [];
    const title = q.title.trim();
    if (!title) return [];
    const url = `${joinBase(ctx.baseUrl, '/jutud.php')}?otsing=${encodeURIComponent(title)}`;
    const hits = parseSearch(await httpPageBytes(url, { signal: ctx.signal, accept: 'text/html' })).filter((h) => hitFits(h, q)).slice(0, 5);
    const out: SubtitleCandidate[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      const list = parseArchiveList(await httpPageBytes(`${joinBase(ctx.baseUrl, '/subtitles_archivecontent.php')}?id=${h.archiveId}`, { signal: ctx.signal, accept: 'text/html', referer: url }), ctx.baseUrl);
      for (const c of candidatesFor(h, list)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
      }
    }
    return out;
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext) {
    const res = await httpBytes(joinBase(ctx.baseUrl, c.id), { signal: ctx.signal, referer: joinBase(ctx.baseUrl, '/') });
    return toPayload(res.bytes);
  },
};
