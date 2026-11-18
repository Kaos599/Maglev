// Ported from LavX/bazarr-provider-catalog, providers/subsunacs (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/subsunacs/provider.py
// Bulgarian and English subtitles from subsunacs.net. Group B page scraper.
// Changes from the reference: the search lists one candidate per listing (no page fetch per row); the download page is
// read when the user picks one, and the file inside it that best matches the release name is saved. The site serves its
// pages as windows-1251 without saying so, so they are decoded here.
import { decodeEntities, stripTags } from '../../search/text.ts';
import { decodeWindows1251 } from '../../search/charset.ts';
import { ProviderError } from '../../search/http.ts';
import { archiveKind, decodeUtf8Strict, releaseSimilarity } from '../payload.ts';
import { normalizeLanguage } from '../languages.ts';
import type { SubFormat, SubtitleCandidate, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { UNSUPPORTED_TYPE, formatFromName, httpBytes, toPayload } from '../http.ts';
import { bestRelease, parseDate, titleMatchesAlias } from '../match.ts';

export const ID = 'subsunacs';

export interface UnacsRow {
  /** The listing's path, for example /subtitles/Fight_Club-55064/ ; the candidate id. */
  path: string;
  language: 'bg' | 'en';
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  /** What the uploader wrote under "Инфо", usually the release name. */
  info: string;
  /** The site's format label (SRT, SUB, ...). */
  format: string;
  downloads: number;
  uploadedAt?: number;
}

/** Page bytes to text: windows-1251 unless the page is valid UTF-8. */
export function decodePage(bytes: Uint8Array): string {
  return decodeUtf8Strict(bytes) ?? decodeWindows1251(bytes);
}

function splitEpisode(text: string): { title: string; season?: number; episode?: number } {
  const m = /^(.+?)\s*(?:-|:)?\s+(\d{1,2})x(\d{1,3})$/i.exec(text.trim());
  return m ? { title: m[1].trim(), season: +m[2], episode: +m[3] } : { title: text.trim() };
}

/** Result rows of a search page (already decoded). */
export function parseRows(html: string): UnacsRow[] {
  if (!/<html|<body|<table/i.test(html)) throw new ProviderError('parse', 'Unexpected response');
  const out: UnacsRow[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<tr\b[^>]*\bonmouseover=['"][^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = m[1];
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    const a = /<td class="tdMovie"><a\b[^>]*href=['"]([^'"]*\/subtitles\/[^'"]+)['"]([^>]*)>([\s\S]*?)<\/a>([\s\S]*?)<\/td>/i.exec(row);
    if (!a || cells.length < 7) continue;
    const path = decodeEntities(a[1]).replace(/!$/, '');
    if (seen.has(path)) continue;
    seen.add(path);
    const tip = decodeEntities(/\btitle=['"]([^'"]*)['"]/i.exec(a[2])?.[1] ?? '');
    const info = stripTags(tip.replace(/<br\s*\/?>/gi, ' | ').replace(/<img\b[^>]*>/gi, ''));
    const after = a[4];
    const year = /\((\d{4})\)/.exec(stripTags(after))?.[1];
    out.push({
      path,
      language: /<span\b[^>]*smSilver[^>]*>\s*English/i.test(after) ? 'en' : 'bg',
      ...splitEpisode(stripTags(a[3])),
      year: year ? +year : undefined,
      info: (/(?:Инфо|Info):\s*\|?\s*(.*)$/.exec(info)?.[1] ?? '').replace(/^\|\s*/, '').trim(),
      format: /(?:Формат|Format):\s*([A-Za-z0-9]+)/.exec(info)?.[1] ?? '',
      downloads: Number(stripTags(cells[6]).replace(/\D/g, '')) || 0,
      uploadedAt: parseDate(/(?:Дата|Date):\s*([\d.]+)/.exec(info)?.[1] ?? ''),
    });
  }
  return out;
}

/** File links on a download page (`/getentry.php?id=..&ei=..`) that are subtitles, not the site's note. */
export function parseEntries(html: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=['"]([^'"]*getentry\.php[^'"]*)['"][^>]*>([\s\S]*?)<\/a>/gi)) {
    const name = stripTags(m[2]);
    if (/\.(srt|ass|ssa|vtt)$/i.test(name)) out.push({ name, url: decodeEntities(m[1]) });
  }
  return out;
}

/** The entry that best matches the release name; the first when none stands out. */
export function pickEntry(entries: { name: string; url: string }[], releaseName: string): { name: string; url: string } | undefined {
  let best: { name: string; url: string } | undefined;
  let bestScore = -1;
  for (const e of entries) {
    const s = releaseSimilarity(e.name, releaseName);
    if (s > bestScore) {
      best = e;
      bestScore = s;
    }
  }
  return best;
}

export function toCandidates(rows: UnacsRow[], q: SubtitleQuery): SubtitleCandidate[] {
  const wanted = new Set(q.languages.map((l) => normalizeLanguage(l)));
  const episodic = q.season !== undefined && q.episodeConfidence !== 'none';
  const out: SubtitleCandidate[] = [];
  for (const r of rows) {
    if (!wanted.has(r.language)) continue;
    if (/^(sub|idx|smi)$/i.test(r.format)) continue;
    if (!titleMatchesAlias(q.title, r.title)) continue;
    if (episodic) {
      if (r.season !== q.season || r.episode !== q.episode) continue;
    } else {
      if (r.season !== undefined) continue;
      if (q.year !== undefined && r.year !== undefined && r.year !== q.year) continue;
    }
    const rel = r.info ? bestRelease(q, r.info) : { name: `${r.title}${r.year ? ` (${r.year})` : ''}`, matchedBy: 'title' as const };
    out.push({
      providerId: ID,
      id: r.path,
      language: r.language,
      releaseName: rel.name,
      format: /^(srt|ass|ssa|vtt)$/i.test(r.format) ? (r.format.toLowerCase() as SubFormat) : undefined,
      matchedBy: rel.matchedBy,
      downloads: r.downloads,
      uploadedAt: r.uploadedAt,
    });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The site's search words: the title, and for an episode "Title 05 01". */
export function searchWords(q: SubtitleQuery): string {
  const episodic = q.season !== undefined && q.episode !== undefined && q.episodeConfidence !== 'none';
  return episodic ? `${q.title.trim()} ${pad(q.season as number)} ${pad(q.episode as number)}` : q.title.trim();
}

export function searchBody(words: string, siteLang: 0 | 1, year?: number): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
  // "action" is the site's Cyrillic button label ("Търси"); the form is not read without it.
  return `m=${enc(words)}&l=${siteLang}&c=&y=${year ?? ''}&action=+++${enc('Търси')}+++&a=&d=&u=&g=&t=&imdbcheck=1`;
}

export function absUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export const subsunacs: SubtitleProvider = {
  id: ID,
  name: 'Subsunacs',
  homepage: 'https://subsunacs.net',
  mirrors: ['https://subsunacs.net'],
  languages: ['bg', 'en'],
  kinds: ['movie', 'episode'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q, ctx) {
    const langs = new Set(q.languages.map((l) => normalizeLanguage(l)));
    const out: SubtitleCandidate[] = [];
    const base = ctx.baseUrl.replace(/\/+$/, '');
    const episodic = q.season !== undefined && q.episodeConfidence !== 'none';
    for (const [code, siteLang] of [['bg', 0], ['en', 1]] as const) {
      if (!langs.has(code)) continue;
      const { bytes } = await httpBytes(`${base}/search.php`, {
        signal: ctx.signal,
        accept: 'text/html',
        method: 'POST',
        body: searchBody(searchWords(q), siteLang, episodic ? undefined : q.year),
        contentType: 'application/x-www-form-urlencoded',
        headers: { Referer: `${base}/index.php` },
      });
      out.push(...toCandidates(parseRows(decodePage(bytes)), q).filter((c) => c.language === code));
    }
    return out;
  },
  async download(c, ctx) {
    const base = ctx.baseUrl.replace(/\/+$/, '');
    const page = absUrl(base, `${c.id.replace(/\/*$/, '/')}!`);
    const first = await httpBytes(page, { signal: ctx.signal, accept: '*/*', headers: { Referer: `${base}/search.php` } });
    if (archiveKind(first.bytes) || !/html/i.test(first.contentType)) return toPayload(first.bytes, { language: c.language, requireCues: true });
    const entry = pickEntry(parseEntries(decodePage(first.bytes)), c.releaseName);
    if (!entry) throw new ProviderError('parse', UNSUPPORTED_TYPE);
    const file = await httpBytes(absUrl(base, entry.url), { signal: ctx.signal, accept: '*/*', headers: { Referer: page } });
    return toPayload(file.bytes, { language: c.language, nameHint: formatFromName(entry.name) ? entry.name : '', requireCues: true });
  },
};
