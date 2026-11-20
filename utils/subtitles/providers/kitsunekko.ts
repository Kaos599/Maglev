// Ported from LavX/bazarr-provider-catalog, providers/kitsunekko (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/kitsunekko/provider.py
import { httpText, ProviderError } from '../../search/http.ts';
import { httpBytes } from '../http.ts';
import { decodeEntities, stripTags } from '../../search/text.ts';
import { archiveKind, decodeSubtitleText, detectFormat } from '../payload.ts';
import type { SubFormat, SubtitleCandidate, SubtitleContext, SubtitlePayload, SubtitleProvider, SubtitleQuery } from '../types.ts';

export const ID = 'kitsunekko';

/** Language to the folder that lists its series. English is the site's root, Japanese has its own folder. */
const ROOTS: Record<string, string> = { en: 'subtitles/', ja: 'subtitles/japanese/' };
const MAX_DIRS = 5;
const MAX_RESULTS = 60;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface KkDirectory {
  title: string;
  /** The folder as the site writes it in `dir=`, for example `subtitles/Cowboy Bebop/`. */
  path: string;
}
export interface KkFile {
  name: string;
  /** Site path without a leading slash, for example `subtitles/Cowboy Bebop/Cowboy Bebop.zip`. */
  path: string;
  ext: 'srt' | 'ass' | 'ssa' | 'vtt' | 'zip';
  bytes?: number;
  uploadedAt?: number;
}

/** The folders of a language index. Each row is a `dirlist.php?dir=...` link with the series name in bold. */
export function parseIndex(body: string): KkDirectory[] {
  if (!/id="flisttable"/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: KkDirectory[] = [];
  const re = /<a\b[^>]*href=["']([^"']*dirlist\.php\?dir=[^"']+)["'][^>]*>\s*<strong>([\s\S]*?)<\/strong>/gi;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const dir = /[?&]dir=([^&"']+)/.exec(decodeEntities(m[1]))?.[1];
    const title = stripTags(m[2]);
    if (!dir || !title) continue;
    let path: string;
    try {
      path = decodeURIComponent(dir.replace(/\+/g, ' '));
    } catch {
      continue;
    }
    out.push({ title, path });
  }
  return out;
}

/** "Dec 30 2023 11:45:09 AM" (the site's tooltip) to epoch ms, read as UTC. */
export function parseSiteDate(s: string | undefined): number | undefined {
  const m = /([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?/i.exec(s ?? '');
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return undefined;
  let hour = parseInt(m[4], 10) % 12;
  if (/pm/i.test(m[7] ?? '')) hour += 12;
  return Date.UTC(parseInt(m[3], 10), month, parseInt(m[2], 10), hour, parseInt(m[5], 10), parseInt(m[6], 10));
}

/**
 * The files in one folder. Only plain subtitles and zip archives are kept: the site also holds .rar and .7z packs,
 * which Maglev can't open, so those rows never become candidates.
 */
export function parseDirectory(body: string): KkFile[] {
  if (!/id="flisttable"/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: KkFile[] = [];
  for (const row of body.split(/<tr[\s>]/i).slice(1)) {
    const link = /<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*<strong>([\s\S]*?)<\/strong>/i.exec(row);
    if (!link) continue;
    const path = decodeEntities(link[1]).replace(/^\/+/, '');
    const name = stripTags(link[2]);
    const ext = /\.(srt|ass|ssa|vtt|zip)$/i.exec(path)?.[1].toLowerCase() as KkFile['ext'] | undefined;
    if (!ext || !name || /dirlist\.php/i.test(path)) continue;
    const size = /class=["']tdleft["'][^>]*title=["'](\d+)["']/i.exec(row)?.[1];
    const date = /class=["']tdright["'][^>]*title=["']([^"']+)["']/i.exec(row)?.[1];
    out.push({ name, path, ext, bytes: size ? parseInt(size, 10) : undefined, uploadedAt: parseSiteDate(date) });
  }
  return out;
}

function tokens(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * How well a folder name fits the title, 0 for none. Every title word in the folder name counts (the Python rule);
 * so does a folder whose name, of two words or more, is wholly inside the title ("Cowboy Bebop" for a film called
 * "Cowboy Bebop The Movie"). A closer length scores higher.
 */
export function directoryScore(title: string, dirTitle: string): number {
  const want = tokens(title);
  const have = tokens(dirTitle);
  if (want.length === 0 || have.length === 0) return 0;
  const wantSet = new Set(want);
  const haveSet = new Set(have);
  const allWantInHave = want.every((t) => haveSet.has(t));
  const allHaveInWant = have.length >= 2 && have.every((t) => wantSet.has(t));
  if (!allWantInHave && !allHaveInWant) return 0;
  return 1 + Math.min(want.length, have.length) / Math.max(want.length, have.length);
}

/** Folders to open, best first. */
export function rankDirectories(title: string, dirs: KkDirectory[], max = MAX_DIRS): KkDirectory[] {
  return dirs
    .map((d) => ({ d, s: directoryScore(title, d.title) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.d);
}

/** The season and episode a file name states, when it states one: S01E02, "ep02", "E02", " - 02". */
function episodeMarker(name: string): { season?: number; episode: number } | null {
  const se = /\bs0*(\d{1,2})\s*e0*(\d{1,4})\b/i.exec(name);
  if (se) return { season: parseInt(se[1], 10), episode: parseInt(se[2], 10) };
  const ep = /(?:\bep(?:isode)?[ ._-]?|\be)0*(\d{1,4})\b/i.exec(name) ?? /\s-\s0*(\d{1,4})(?!\d)/.exec(name);
  return ep ? { episode: parseInt(ep[1], 10) } : null;
}

/** False only when the file names an episode and it isn't the wanted one. Packs and unnumbered files stay. */
export function fitsEpisode(name: string, q: Pick<SubtitleQuery, 'season' | 'episode' | 'absoluteEpisode' | 'episodeConfidence'>): boolean {
  if (q.episodeConfidence === 'none' || (q.episode === undefined && q.absoluteEpisode === undefined)) return true;
  const mark = episodeMarker(name);
  if (!mark) return true;
  if (mark.season !== undefined && q.season !== undefined && mark.season !== q.season) return false;
  return mark.episode === q.episode || mark.episode === q.absoluteEpisode;
}

function subtitleFormat(ext: KkFile['ext']): SubFormat | undefined {
  return ext === 'zip' ? undefined : ext;
}

/** Candidates for one language from the files of the folders that fit. Episode matches come first. */
export function candidatesFrom(files: KkFile[], language: string, q: SubtitleQuery): SubtitleCandidate[] {
  const seen = new Set<string>();
  const out: SubtitleCandidate[] = [];
  for (const f of files) {
    if (seen.has(f.path) || !fitsEpisode(f.name, q)) continue;
    seen.add(f.path);
    out.push({
      providerId: ID,
      id: f.path,
      language,
      releaseName: f.name,
      format: subtitleFormat(f.ext),
      matchedBy: 'title',
      uploadedAt: f.uploadedAt,
    });
  }
  const exact = (c: SubtitleCandidate) => {
    const m = episodeMarker(c.releaseName);
    return m !== null && (m.episode === q.episode || m.episode === q.absoluteEpisode) ? 0 : 1;
  };
  return out.sort((a, b) => exact(a) - exact(b));
}

export function indexUrl(base: string, language: string): string | null {
  const root = ROOTS[language];
  return root ? `${base.replace(/\/+$/, '')}/dirlist.php?dir=${encodeURIComponent(root)}` : null;
}

export function directoryUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/dirlist.php?dir=${encodeURIComponent(path)}`;
}

export function fileUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * What a downloaded body is. A zip goes back as a zip (the member is chosen later), a plain subtitle as text with its
 * format read from the content. RAR and 7z are refused, and so is a page of HTML where a file should be.
 */
export function toPayload(bytes: Uint8Array, hint?: { language?: string; format?: SubFormat }): SubtitlePayload {
  if (bytes.length === 0) throw new ProviderError('parse', 'Empty subtitle');
  const kind = archiveKind(bytes);
  if (kind === 'zip') return { kind: 'zip', bytes };
  if (kind) throw new ProviderError('parse', "This subtitle's file type isn't supported");
  const head = String.fromCharCode(...bytes.subarray(0, 64)).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) throw new ProviderError('parse', 'Unexpected response');
  const decoded = decodeSubtitleText(bytes, hint?.language);
  return { kind: 'text', bytes, format: decoded.ok ? detectFormat(decoded.text) : (hint?.format ?? 'srt') };
}

async function fetchBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  try {
    return (await httpBytes(url, { signal })).bytes;
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404) throw new ProviderError('http', 'The file is gone', 404);
    throw e;
  }
}

async function searchLanguage(language: string, q: SubtitleQuery, ctx: SubtitleContext): Promise<SubtitleCandidate[]> {
  const url = indexUrl(ctx.baseUrl, language);
  if (!url) return [];
  const dirs = rankDirectories(q.title, parseIndex(await httpText(url, { signal: ctx.signal, accept: 'text/html' })));
  const listings = await Promise.all(
    dirs.map(async (d) => {
      try {
        return parseDirectory(await httpText(directoryUrl(ctx.baseUrl, d.path), { signal: ctx.signal, accept: 'text/html' }));
      } catch (e) {
        // One folder that fails shouldn't hide the others, unless the whole run was cancelled.
        if (ctx.signal.aborted) throw e;
        return [] as KkFile[];
      }
    }),
  );
  return candidatesFrom(listings.flat(), language, q);
}

export const kitsunekko: SubtitleProvider = {
  id: ID,
  name: 'Kitsunekko',
  homepage: 'https://kitsunekko.net',
  mirrors: ['https://kitsunekko.net'],
  languages: ['en', 'ja'],
  kinds: ['movie', 'episode'],
  matches: ['name'],
  group: 'B',
  focus: 'anime',
  enabledByDefault: false,
  async search(q, ctx) {
    const wanted = Array.from(new Set(q.languages.map((l) => l.split('-')[0]))).filter((l) => ROOTS[l]);
    if (wanted.length === 0 || !q.title.trim()) return [];
    const all: SubtitleCandidate[] = [];
    for (const language of wanted) all.push(...(await searchLanguage(language, q, ctx)));
    return all.slice(0, MAX_RESULTS);
  },
  async download(c, ctx) {
    const bytes = await fetchBytes(fileUrl(ctx.baseUrl, c.id), ctx.signal);
    return toPayload(bytes, { language: c.language, format: c.format });
  },
};
