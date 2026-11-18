// Ported from LavX/bazarr-provider-catalog (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/subtitulamostv/provider.py
import { decodeEntities, stripTags } from '../../search/text.ts';
import { baseLanguage, normalizeLanguage } from '../languages.ts';
import type { SubtitleCandidate, SubtitleContext, SubtitleProvider } from '../types.ts';
import { httpBytes, httpPageBytes, toPayload } from '../http.ts';
import { fold, joinBase, parseJsonList, pathOf, resolveHref } from '../match.ts';

export const ID = 'subtitulamostv';

export interface Show {
  id: string;
  name: string;
}

export interface Choice {
  href: string;
  selected: boolean;
  number: number;
}

export interface Version {
  /** ISO 639-1 / regional tag as in 36.2. */
  language: string;
  releaseName: string;
  /** Site-root path, "/subtitles/1004/download". */
  path: string;
}

/** The site's own language labels. */
const SITE_LANGUAGES: Record<string, string> = {
  'espanol': 'es',
  'espanol espana': 'es',
  'espanol latinoamerica': 'es-419',
  'catala': 'ca',
  'english': 'en',
  'english us': 'en',
  'english uk': 'en',
  'galego': 'gl',
  'portuguese': 'pt',
  'brazilian': 'pt-BR',
};

export function siteLanguage(label: string): string | null {
  return SITE_LANGUAGES[fold(label)] ?? null;
}

const normShow = (s: string) => fold(s.replace(/\s+\(\d{4}\)$/, ''));

/** `[{"show_id":11,"show_name":"The Strain"}, ...]`. */
export function parseShows(body: string): Show[] {
  const list = parseJsonList(body);
  const out: Show[] = [];
  for (const it of list) {
    const id = it && it.show_id != null ? String(it.show_id).trim() : '';
    const name = it && typeof it.show_name === 'string' ? it.show_name.trim() : '';
    if (id && name) out.push({ id, name });
  }
  return out;
}

/** The site's search matches loosely ("The Wire" finds "The Strain"); only an exact show name counts. */
export function exactShows(shows: Show[], wanted: string): Show[] {
  const w = normShow(wanted);
  return shows.filter((s) => normShow(s.name) === w);
}

/** Season or episode links: `<div id="season-choices"><a href="/episodes/61/..." class="choice selected">4</a>`. */
export function parseChoices(body: string, containerId: string): Choice[] {
  const start = body.indexOf(`id="${containerId}"`);
  if (start < 0) return [];
  const end = body.indexOf('</div>', start);
  const box = body.slice(start, end < 0 ? undefined : end);
  const out: Choice[] = [];
  for (const m of box.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /href=["']([^"']*)["']/i.exec(m[1])?.[1] ?? '';
    const num = /\d+/.exec(stripTags(m[2]));
    if (!num) continue;
    out.push({ href: decodeEntities(href), selected: /\bselected\b/.test(/class=["']([^"']*)["']/i.exec(m[1])?.[1] ?? ''), number: parseInt(num[0], 10) });
  }
  return out;
}

/** Versions on an episode page, grouped by language block. A version with an unavailable download is skipped. */
export function parseVersions(body: string, pageUrl: string): Version[] {
  const out: Version[] = [];
  const blocks = body.split(/class="language-container/).slice(1);
  for (const block of blocks) {
    const label = /class="[^"]*\blanguage-name\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const language = label ? siteLanguage(stripTags(label[1])) : null;
    if (!language) continue;
    for (const v of block.split(/class="version-container/).slice(1)) {
      let release = '';
      for (const p of v.matchAll(/<(p|span|div)\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/gi)) {
        const cls = p[2].split(/\s+/);
        if (cls.includes('text') && cls.includes('spaced')) {
          release = stripTags(p[3]);
          break;
        }
      }
      const dl = /<a\b[^>]*href="([^"]*)"[^>]*>\s*<div class="download-button([^"]*)"/i.exec(v);
      if (!dl || /\bunavailable\b/.test(dl[2])) continue;
      out.push({ language, releaseName: release, path: pathOf(resolveHref(pageUrl, decodeEntities(dl[1]))) });
    }
  }
  return out;
}

const wantsLanguage = (language: string, wanted: readonly string[]): boolean =>
  wanted.some((w) => (normalizeLanguage(w) ?? w) === language || baseLanguage(w) === baseLanguage(language));

export function candidatesFor(versions: Version[], wanted: readonly string[]): SubtitleCandidate[] {
  const seen = new Set<string>();
  const out: SubtitleCandidate[] = [];
  for (const v of versions) {
    if (!wantsLanguage(v.language, wanted) || seen.has(v.path)) continue;
    seen.add(v.path);
    out.push({ providerId: ID, id: v.path, language: v.language, releaseName: v.releaseName || 'subtitulamos.tv', format: 'srt', matchedBy: 'title' });
  }
  return out;
}

export const subtitulamostv: SubtitleProvider = {
  id: ID,
  name: 'Subtitulamos.tv',
  homepage: 'https://www.subtitulamos.tv',
  mirrors: ['https://www.subtitulamos.tv'],
  languages: ['es', 'es-419', 'ca', 'en', 'gl', 'pt', 'pt-BR'],
  kinds: ['episode'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q, ctx) {
    if (q.episodeConfidence !== 'sure' || q.season === undefined || q.episode === undefined) return [];
    if (!q.languages.some((l) => ['es', 'ca', 'en', 'gl', 'pt'].includes(baseLanguage(l)))) return [];
    const series = q.title.trim();
    if (!series) return [];
    const get = (url: string, referer?: string) => httpPageBytes(url, { signal: ctx.signal, accept: 'text/html', referer });
    const queries = q.year ? [`${series} (${q.year})`, series] : [series];
    for (const query of queries) {
      const shows = exactShows(parseShows(await httpPageBytes(`${joinBase(ctx.baseUrl, '/search/query')}?q=${encodeURIComponent(query)}`, { signal: ctx.signal, accept: 'application/json', referer: joinBase(ctx.baseUrl, '/') })), query);
      for (const show of shows) {
        let pageUrl = joinBase(ctx.baseUrl, `/shows/${show.id}`);
        let page = await get(pageUrl, joinBase(ctx.baseUrl, '/'));
        const season = parseChoices(page, 'season-choices').find((c) => c.number === q.season);
        if (!season) continue;
        if (!season.selected && season.href) {
          pageUrl = resolveHref(joinBase(ctx.baseUrl, '/'), season.href);
          page = await get(pageUrl, joinBase(ctx.baseUrl, '/'));
        }
        const ep = parseChoices(page, 'episode-choices').find((c) => c.number === q.episode);
        if (!ep) continue;
        if (ep.href && !ep.selected) {
          const epUrl = resolveHref(joinBase(ctx.baseUrl, '/'), ep.href);
          page = await get(epUrl, pageUrl);
          pageUrl = epUrl;
        } else if (ep.href) {
          pageUrl = resolveHref(joinBase(ctx.baseUrl, '/'), ep.href);
        }
        const found = candidatesFor(parseVersions(page, pageUrl), q.languages);
        if (found.length) return found;
      }
    }
    return [];
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext) {
    const res = await httpBytes(joinBase(ctx.baseUrl, c.id), { signal: ctx.signal, referer: joinBase(ctx.baseUrl, '/') });
    return toPayload(res.bytes);
  },
};
