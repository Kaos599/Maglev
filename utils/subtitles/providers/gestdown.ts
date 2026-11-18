// Ported from LavX/bazarr-provider-catalog providers/gestdown (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/gestdown/provider.py
// Gestdown has a show search by name (/shows/search/<name>), so no TVDB id is needed.
import type { SubtitleCandidate, SubtitleContext, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { httpText, parseJson, ProviderError } from '../../search/http.ts';
import { baseLanguage } from '../languages.ts';
import { httpBytes, toPayload } from '../http.ts';
import { episodeOf, sameTitle, stripSlash } from '../match.ts';

export const ID = 'gestdown';

/** Maglev language code -> Gestdown's language name (Addic7ed labels). */
const NAMES: Record<string, string> = {
  ar: 'Arabic', az: 'Azerbaijani', bn: 'Bengali', bs: 'Bosnian', bg: 'Bulgarian', ca: 'Català', cs: 'Czech', da: 'Danish',
  de: 'German', el: 'Greek', en: 'English', eu: 'Euskera', fa: 'Persian', fi: 'Finnish', fr: 'French', gl: 'Galego',
  he: 'Hebrew', hr: 'Croatian', hu: 'Hungarian', hy: 'Armenian', id: 'Indonesian', it: 'Italian', ja: 'Japanese',
  ko: 'Korean', mk: 'Macedonian', ms: 'Malay', nl: 'Dutch', no: 'Norwegian', pl: 'Polish', pt: 'Portuguese',
  'pt-BR': 'Portuguese (Brazilian)', ro: 'Romanian', ru: 'Russian', sk: 'Slovak', sl: 'Slovenian', es: 'Spanish',
  sq: 'Albanian', sr: 'Serbian', sv: 'Swedish', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese',
  'zh-CN': 'Chinese (Simplified)',
};
const CODE_OF = new Map(Object.entries(NAMES).map(([code, name]) => [name, code]));
const LANGUAGES = Object.keys(NAMES);

/** The Gestdown name for a requested language, or null when the site doesn't have it. */
export function gestdownLanguage(code: string): string | null {
  if (NAMES[code]) return NAMES[code];
  if (code === 'zh' || code === 'zh-CN') return NAMES['zh-CN'];
  if (code === 'zh-TW') return null;
  return NAMES[baseLanguage(code)] ?? null;
}

export interface Show {
  id: string;
  name: string;
}

/** `{shows: [{id, name, tvDbId, ...}]}` from /shows/search/<name>. */
export function parseShows(body: string): Show[] {
  const j = parseJson(body);
  const list = j && typeof j === 'object' ? j.shows : null;
  if (!Array.isArray(list)) return [];
  const out: Show[] = [];
  for (const s of list) {
    if (s && typeof s === 'object' && s.id && typeof s.name === 'string') out.push({ id: String(s.id), name: s.name });
  }
  return out;
}

/** Shows whose name is the title; when none is, a lone result of the name search is taken. */
export function pickShows(shows: Show[], title: string): Show[] {
  const exact = shows.filter((s) => sameTitle(s.name, title));
  if (exact.length > 0) return exact;
  return shows.length === 1 ? shows : [];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `{matchingSubtitles: [...]}` from /subtitles/get/<show>/<season>/<episode>/<language>. Unfinished ones are dropped. */
export function parseSubtitles(body: string, show: string, season: number, episode: number): SubtitleCandidate[] {
  const j = parseJson(body);
  const list = j && typeof j === 'object' ? j.matchingSubtitles : null;
  if (!Array.isArray(list)) return [];
  const out: SubtitleCandidate[] = [];
  const seen = new Set<string>();
  for (const it of list) {
    if (!it || typeof it !== 'object' || !it.completed) continue;
    const id = String(it.subtitleId ?? '');
    if (!/^[A-Za-z0-9]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const version = String(it.version ?? '').split(',').map((v) => v.trim()).filter(Boolean).join(' ');
    const lang = CODE_OF.get(String(it.language ?? ''));
    if (!lang) continue;
    const c: SubtitleCandidate = {
      providerId: ID,
      id,
      language: lang,
      releaseName: `${show} S${pad(season)}E${pad(episode)}${version ? ` ${version}` : ''}`,
      hearingImpaired: !!it.hearingImpaired,
      format: 'srt',
      matchedBy: 'title',
    };
    if (typeof it.downloadCount === 'number') c.downloads = it.downloadCount;
    const when = typeof it.discovered === 'string' ? Date.parse(it.discovered) : NaN;
    if (Number.isFinite(when)) c.uploadedAt = Math.floor(when / 1000);
    out.push(c);
  }
  return out;
}

export function showsUrl(base: string, title: string): string {
  return `${stripSlash(base)}/shows/search/${encodeURIComponent(title.trim())}`;
}

export function subtitlesUrl(base: string, showId: string, season: number, episode: number, language: string): string {
  return `${stripSlash(base)}/subtitles/get/${encodeURIComponent(showId)}/${season}/${episode}/${encodeURIComponent(language)}`;
}

export function downloadUrl(base: string, id: string): string | null {
  return /^[A-Za-z0-9]+$/.test(id) ? `${stripSlash(base)}/subtitles/download/${id}` : null;
}

/** 404 (nothing there) and 423 (Gestdown is still fetching that show) both mean "no results yet". */
function soft(e: unknown): boolean {
  return e instanceof ProviderError && e.kind === 'http' && (e.status === 404 || e.status === 423);
}

export const gestdown: SubtitleProvider = {
  id: ID,
  name: 'Gestdown',
  homepage: 'https://gestdown.info',
  mirrors: ['https://api.gestdown.info'],
  languages: LANGUAGES,
  kinds: ['episode'],
  matches: ['name'],
  group: 'A',
  enabledByDefault: true,
  async search(q: SubtitleQuery, ctx: SubtitleContext) {
    const ep = episodeOf(q);
    if (!ep || !q.title.trim()) return [];
    const wanted: string[] = [];
    for (const l of q.languages) {
      const name = gestdownLanguage(l);
      if (name && !wanted.includes(name)) wanted.push(name);
    }
    if (wanted.length === 0) return [];
    let shows: Show[];
    try {
      shows = pickShows(parseShows(await httpText(showsUrl(ctx.baseUrl, q.title), { signal: ctx.signal, accept: 'application/json' })), q.title);
    } catch (e) {
      if (soft(e)) return [];
      throw e;
    }
    const out: SubtitleCandidate[] = [];
    const seen = new Set<string>();
    for (const show of shows) {
      for (const name of wanted) {
        let text: string;
        try {
          text = await httpText(subtitlesUrl(ctx.baseUrl, show.id, ep.season, ep.episode, name), { signal: ctx.signal, accept: 'application/json' });
        } catch (e) {
          if (soft(e)) continue;
          throw e;
        }
        for (const c of parseSubtitles(text, show.name, ep.season, ep.episode)) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          out.push(c);
        }
      }
    }
    return out;
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext) {
    const url = downloadUrl(ctx.baseUrl, c.id);
    if (!url) throw new ProviderError('parse', 'Bad subtitle id');
    const { bytes } = await httpBytes(url, { signal: ctx.signal });
    return toPayload(bytes, c.language);
  },
};
