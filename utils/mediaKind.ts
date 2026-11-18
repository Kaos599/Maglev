/**
 * Is a Search result a video? (docs/NATIVE_CONTRACT.md section 44.2.) Pure: no React, no IO.
 *
 * The category decides when there is one: Movies, TV and Anime are video; Music, Apps, Games, Books, Other and Adult
 * never are. With no category (or "all"), the name decides: a film reads as a title plus a year, a show as an
 * episode or a season. Whether a torrent has a video file is checked later, once its file list is known.
 */
import { mediaKind } from './search/mediaType.ts';
import { parseName, parseTyped } from './subtitles/parseName.ts';

const VIDEO_CATEGORIES: ReadonlySet<string> = new Set(['movies', 'tv', 'anime']);
const NOT_VIDEO_CATEGORIES: ReadonlySet<string> = new Set(['music', 'apps', 'games', 'books', 'other', 'adult', 'porn']);

/** True when the name reads as a film (title and year) or as an episode or season. */
export function nameReadsAsVideo(name: string): boolean {
  const p = parseName(name);
  if (p.extra || !p.title) return false;
  if (p.season !== undefined || p.episode !== undefined) return true;
  if (p.absoluteEpisode !== undefined) return true;
  if (p.year !== undefined) return true;
  // "Severance S02": a season with no episode is not in a file name, but it can be in a release title.
  return parseTyped(name).season !== undefined;
}

export function isVideoResult(r: { category?: string; name: string }): boolean {
  const c = r.category?.toLowerCase();
  if (c && VIDEO_CATEGORIES.has(c)) return true;
  if (c && NOT_VIDEO_CATEGORIES.has(c)) return false;
  const name = r.name ?? '';
  // "Artist Album 2014 FLAC" has a year but is not a film: a name that plainly says music, a book, an app or a game is not video.
  const kind = mediaKind({ name });
  if (kind !== 'video' && kind !== 'unknown') return false;
  return nameReadsAsVideo(name);
}
