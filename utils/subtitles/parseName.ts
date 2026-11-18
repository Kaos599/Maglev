/**
 * Reading a video file name (docs/NATIVE_CONTRACT.md section 36.4). Pure.
 *   sure : S01E02, S01E02E03 (first episode), 1x02
 *   guess: anime absolute numbering, "[Group] Show - 047 [1080p]"
 *   none : anything else, and sample / trailer / extras / featurette files
 */

export interface ParsedName {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  absoluteEpisode?: number;
  episodeConfidence: 'sure' | 'guess' | 'none';
  /** A sample, trailer, extras or featurette file: no episode is read from it. */
  extra: boolean;
}

export interface ReleaseInfo {
  /** Lowercase scene group ("rarbg", "ntb"), or null. */
  group: string | null;
  /** 'webdl' | 'webrip' | 'bluray' | 'hdtv' | 'dvd', or null. */
  source: string | null;
  /** '480p' | '720p' | '1080p' | '2160p', or null. */
  resolution: string | null;
}

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|mts|wmv|flv|mpg|mpeg|mpe|3gp|ogv|divx|vob|srt|ass|ssa|vtt)$/i;
const EXTRA = /(?:^|[^a-z0-9])(sample|trailer|extras?|featurettes?)(?![a-z0-9])/i;
const TAGS =
  /(?:^|[^a-z0-9])(?:\d{3,4}x\d{3,4}|480p|576p|720p|1080p|1080i|2160p|4k|uhd|hdr10?|dv|bluray|blu-ray|bdrip|brrip|bdremux|remux|webrip|web-dl|webdl|web|hdtv|pdtv|dvdrip|dvd|hdrip|x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|aac|ac3|dts|ddp?\d?|atmos|proper|repack|extended|unrated|remastered|multi|dual|internal)(?![a-z0-9])/i;

/** The release tags the title stops at (`tidyTitle`); also where an episode title ends (NATIVE_CONTRACT 46.1). */
export const RELEASE_TAGS = TAGS;

/** The file name without folders and without a video or subtitle extension. */
export function stripName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '');
  return base.replace(VIDEO_EXT, '');
}

function tidyTitle(raw: string): string {
  let t = raw.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  const tag = TAGS.exec(t);
  if (tag) t = t.slice(0, tag.index);
  t = t.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.replace(/[\s-]+$/, '').replace(/^[\s-]+/, '').trim();
}

const SXXEYY = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?:(?:[ ._-]?e\d{1,3})|(?:-\d{1,3}))*(?![a-z0-9])/i;
const NXNN = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![a-z0-9])/i;
const YEAR = /(?:^|[\s.(\[_-])((?:19|20)\d{2})(?=$|[\s.)\]_-])/g;
const ANIME = /^(.*?)[\s._]+-[\s._]+(\d{1,4})(?:v\d)?(?=$|[\s._\[(])/;

export function parseName(fileName: string): ParsedName {
  const name = stripName(fileName);
  const extra = EXTRA.test(name);
  const out: ParsedName = { title: '', episodeConfidence: 'none', extra };

  // Anime releases lead with [Group]; take it off before reading the rest.
  const noGroup = name.replace(/^\s*\[[^\]]*\]\s*/, '');

  let episodeAt = -1;
  const sxe = SXXEYY.exec(noGroup);
  const nxn = sxe ? null : NXNN.exec(noGroup);
  if (sxe || nxn) {
    const m = (sxe ?? nxn)!;
    episodeAt = m.index + (/^[a-z0-9]/i.test(m[0]) ? 0 : 1);
    if (!extra) {
      out.season = Number(m[1]);
      out.episode = Number(m[2]);
      out.episodeConfidence = 'sure';
    }
  }

  // Year: the last plausible one in front of the first release tag that leaves some title before it, so
  // "2012.2009" is the film 2012 from 2009 and "Blade.Runner.2049.2017" is Blade Runner 2049 from 2017.
  const tagAt = TAGS.exec(noGroup)?.index ?? noGroup.length;
  const latest = new Date().getFullYear() + 1;
  let yearAt = -1;
  let year: number | undefined;
  YEAR.lastIndex = 0;
  for (let m = YEAR.exec(noGroup); m; m = YEAR.exec(noGroup)) {
    if (m.index >= tagAt && yearAt >= 0) break;
    const y = Number(m[1]);
    if (y > latest) continue;
    if (noGroup.slice(0, m.index).replace(/[\s.()\[\]_-]/g, '') === '') continue;
    if (m.index >= tagAt) continue;
    yearAt = m.index;
    year = y;
  }
  if (year !== undefined) out.year = year;

  const cut = [episodeAt, yearAt].filter((n) => n >= 0);
  if (cut.length) {
    out.title = tidyTitle(noGroup.slice(0, Math.min(...cut)));
    return out;
  }

  const anime = !extra ? ANIME.exec(noGroup) : null;
  if (anime) {
    const title = tidyTitle(anime[1]);
    if (title) {
      out.title = title;
      out.absoluteEpisode = Number(anime[2]);
      out.episodeConfidence = 'guess';
      return out;
    }
  }

  out.title = tidyTitle(noGroup);
  return out;
}

// ---------------------------------------------------------------- typed names (NATIVE_CONTRACT 42.3)

const SEASON_ONLY = /^(.*\S)[\s._-]+s(\d{1,2})$/i;

/**
 * Free text the user typed ("casino royale 2006", "severance s02e03", "Severance S02"). Reads it with `parseName`, and
 * adds the one shape a file name never has: a season with no episode. Only typed text goes through here, so what
 * `parseName` makes of real file names does not change.
 */
// NATIVE_CONTRACT 42.3
export function parseTyped(text: string): ParsedName {
  const t = text.trim();
  const p = parseName(t);
  if (p.season !== undefined || p.episode !== undefined || p.extra) return p;
  const m = SEASON_ONLY.exec(t);
  if (!m) return p;
  const base = parseName(m[1]);
  return base.title ? { ...base, season: Number(m[2]) } : p;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * A parsed name written as words. `typing` false is the plain read-out ("Casino Royale (2006)", "Severance S02E03");
 * true is the form to put in the field ("Casino Royale 2006"), which `parseTyped` reads back to the same result.
 */
// NATIVE_CONTRACT 42.3
export function parsedText(p: ParsedName, typing = false): string {
  const parts = [p.title];
  if (p.year !== undefined) parts.push(typing ? String(p.year) : `(${p.year})`);
  if (p.season !== undefined) parts.push(`S${pad2(p.season)}${p.episode !== undefined ? `E${pad2(p.episode)}` : ''}`);
  else if (p.absoluteEpisode !== undefined) parts.push(`- ${p.absoluteEpisode}`);
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- release info (for rank.ts and zip choice)

export const SOURCE_PATTERNS: [string, RegExp][] = [
  ['webdl', /(?:^|[^a-z0-9])web[ ._-]?dl(?![a-z0-9])/i],
  ['webrip', /(?:^|[^a-z0-9])web[ ._-]?rip(?![a-z0-9])/i],
  ['bluray', /(?:^|[^a-z0-9])(?:blu[ ._-]?ray|bdrip|brrip|bdremux|bd)(?![a-z0-9])/i],
  ['hdtv', /(?:^|[^a-z0-9])(?:hdtv|pdtv)(?![a-z0-9])/i],
  ['dvd', /(?:^|[^a-z0-9])dvd(?:rip)?(?![a-z0-9])/i],
];

/** Group, source and resolution of a release name (a file name, with or without extension). */
export function parseRelease(releaseName: string): ReleaseInfo {
  const name = stripName(releaseName).trim();
  let source: string | null = null;
  for (const [id, re] of SOURCE_PATTERNS) {
    if (re.test(name)) {
      source = id;
      break;
    }
  }
  if (!source && /(?:^|[^a-z0-9])web(?![a-z0-9])/i.test(name)) source = 'webdl';
  let resolution: string | null = null;
  const res = /(?:^|[^a-z0-9])(480|576|720|1080|2160)[pi](?![a-z0-9])/i.exec(name);
  if (res) resolution = `${res[1]}p`;
  else if (/(?:^|[^a-z0-9])(?:4k|uhd)(?![a-z0-9])/i.test(name)) resolution = '2160p';
  let group: string | null = null;
  const lead = /^\s*\[([^\]]+)\]/.exec(name);
  if (lead) group = lead[1];
  else {
    const tail = /-([A-Za-z0-9]{2,16})(?:\[[^\]]*\])?$/.exec(name);
    // "-WEB-DL" and "-AAC5" aren't groups.
    if (tail && !/^(?:dl|rip|ray|dts|aac\d*|dd\d*|ddp\d*|hd|x264|x265)$/i.test(tail[1]) && !/^\d+p$/i.test(tail[1])) group = tail[1];
  }
  return { group: group ? group.toLowerCase() : null, source, resolution };
}
