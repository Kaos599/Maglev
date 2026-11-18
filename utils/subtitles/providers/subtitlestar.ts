// Ported from LavX/bazarr-provider-catalog (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/subtitlestar/provider.py
import { ProviderError } from '../../search/http.ts';
import { decodeEntities, stripTags } from '../../search/text.ts';
import { baseLanguage } from '../languages.ts';
import type { SubtitleCandidate, SubtitleContext, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { httpBytes, httpPageBytes, toPayload } from '../http.ts';
import { joinBase, resolveHref, titleMatches, tokens } from '../match.ts';

export const ID = 'subtitlestar';

export interface Post {
  url: string;
  title: string;
}

export interface Detail {
  title: string;
  imdbId?: string;
  year?: number;
  /** Absolute https URLs of the zips and subtitle files (trailers and RAR/7z left out). */
  links: string[];
}

const DL_HOST = /^https:\/\/dl2?\.subtitlestar\.com\/dlsub\//i;

/** Result list: `<h2><a title="..." href="https://subtitlestar.com/...">`. Old pages may use an image alt instead. */
export function parseSearch(body: string): Post[] {
  const out: Post[] = [];
  const seen = new Set<string>();
  const add = (url: string, title: string) => {
    const u = decodeEntities(url);
    if (!/^https:\/\/subtitlestar\.com\//i.test(u) || seen.has(u) || !title) return;
    seen.add(u);
    out.push({ url: u, title });
  };
  for (const m of body.matchAll(/<h2\b[^>]*>\s*<a\b[^>]*>/gi)) {
    const href = /href=["']([^"']+)["']/i.exec(m[0])?.[1];
    const title = /title=["']([^"']*)["']/i.exec(m[0])?.[1];
    if (href && title) add(href, decodeEntities(title).trim());
  }
  for (const m of body.matchAll(/<a\b[^>]*href=["'](https:\/\/subtitlestar\.com\/persian-subtitles-[^"']+)["'][^>]*>\s*<h2\b[^>]*>([^<]+)<\/h2>/gi)) add(m[1], stripTags(m[2]));
  return out;
}

export function parseDetail(body: string): Detail | null {
  if (!body) return null;
  const title = stripTags(/<title>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '').replace(/\s*-\s*[^-]*$/, '');
  const imdbId = /imdb\.com\/title\/(tt\d+)/i.exec(body)?.[1];
  const y = /icon-years[^>]*>[\s\S]*?<a[^>]*>(\d{4})<\/a>/i.exec(body)?.[1];
  const links: string[] = [];
  for (const m of body.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    const url = decodeEntities(m[1]);
    const lower = url.toLowerCase();
    if (!DL_HOST.test(url) || lower.includes('trailer')) continue;
    if (!/\.(zip|srt|ass|ssa|vtt)(\?|$)/.test(lower)) continue;
    if (!links.includes(url)) links.push(url);
  }
  return { title, imdbId, year: y ? parseInt(y, 10) : undefined, links };
}

/** Season and episode in a file name: `...-All-S01E08.zip` is one episode, `...-All-S01.zip` the season. */
export function linkEpisode(url: string): { season?: number; episode?: number } {
  const file = decodeURIComponent(url.replace(/[?#].*$/, '').replace(/^.*\//, ''));
  const m = /(?:^|[^a-z0-9])s0*(\d{1,2})(?:[\s._-]*e0*(\d{1,3}))?(?![0-9])/i.exec(file);
  return m ? { season: parseInt(m[1], 10), ...(m[2] ? { episode: parseInt(m[2], 10) } : {}) } : {};
}

/** The queries to try, in order. */
export function queriesFor(q: Pick<SubtitleQuery, 'title' | 'year' | 'season' | 'episode' | 'episodeConfidence'>): string[] {
  const title = q.title.trim();
  if (!title) return [];
  if (q.episodeConfidence === 'sure' && q.season !== undefined) return [title];
  const out: string[] = [];
  if (q.year) out.push(`${title} ${q.year}`);
  out.push(title);
  if (title.includes(':')) {
    const short = title.split(':')[0].trim();
    if (short) out.push(q.year ? `${short} ${q.year}` : short);
  }
  return out;
}

/** Does this search result fit the wanted title (and year, when it names one)? */
export function postFits(post: Post, q: Pick<SubtitleQuery, 'title' | 'year' | 'season' | 'episodeConfidence'>): boolean {
  if (!titleMatches(q.title, post.title)) return false;
  const episode = q.episodeConfidence === 'sure' && q.season !== undefined;
  if (episode || !q.year) return true;
  const own = new Set(tokens(q.title));
  const years = tokens(post.title).filter((t) => /^(19|20)\d{2}$/.test(t) && !own.has(t));
  return years.length === 0 || years.includes(String(q.year));
}

export function candidatesFor(detail: Detail, q: Pick<SubtitleQuery, 'season' | 'episode' | 'episodeConfidence'>): SubtitleCandidate[] {
  const wantEpisode = q.episodeConfidence === 'sure' && q.season !== undefined && q.episode !== undefined;
  const out: SubtitleCandidate[] = [];
  for (const url of detail.links) {
    const file = decodeURIComponent(url.replace(/[?#].*$/, '').replace(/^.*\//, ''));
    const se = linkEpisode(url);
    if (wantEpisode) {
      if (se.season !== q.season) continue;
      if (se.episode !== undefined && se.episode !== q.episode) continue;
    } else if (se.season !== undefined) {
      continue;
    }
    const ext = /\.([a-z]{3})$/i.exec(file)?.[1].toLowerCase();
    out.push({
      providerId: ID,
      id: url,
      language: 'fa',
      releaseName: file.replace(/\.(zip|srt|ass|ssa|vtt)$/i, ''),
      matchedBy: 'title',
      ...(ext === 'srt' || ext === 'ass' || ext === 'ssa' || ext === 'vtt' ? { format: ext } : {}),
    });
  }
  return out;
}

export const subtitlestar: SubtitleProvider = {
  id: ID,
  name: 'SubtitleStar',
  homepage: 'https://subtitlestar.com',
  mirrors: ['https://subtitlestar.com'],
  languages: ['fa'],
  kinds: ['movie', 'episode'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q, ctx) {
    if (!q.languages.some((l) => baseLanguage(l) === 'fa')) return [];
    const seenPages = new Set<string>();
    for (const query of queriesFor(q)) {
      const url = `${joinBase(ctx.baseUrl, '/')}?s=${encodeURIComponent(query)}&post_type=post`;
      const posts = parseSearch(await httpPageBytes(url, { signal: ctx.signal, accept: 'text/html' })).filter((p) => postFits(p, q)).slice(0, 3);
      const out: SubtitleCandidate[] = [];
      for (const p of posts) {
        if (seenPages.has(p.url)) continue;
        seenPages.add(p.url);
        const detail = parseDetail(await httpPageBytes(p.url, { signal: ctx.signal, accept: 'text/html', referer: url }));
        if (detail) out.push(...candidatesFor(detail, q));
      }
      if (out.length) return out;
    }
    return [];
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext) {
    if (!DL_HOST.test(c.id)) throw new ProviderError('parse', 'Unexpected response');
    const res = await httpBytes(c.id, { signal: ctx.signal, referer: joinBase(ctx.baseUrl, '/') });
    return toPayload(res.bytes);
  },
};
