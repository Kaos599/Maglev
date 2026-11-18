/**
 * Does a subtitle for a language already sit next to the video? Pure: it works on file names the caller already has
 * (a torrent's file list), so it needs no storage access.
 *
 * Matches `<video name>.en.srt`, `<video name>.eng.ass`, `<video name>.English.vtt`, `<video name>.en.hi.srt`, and a
 * file that is only the language (`English.srt`, `2_English.srt`, `eng.srt`) in the video's own folder.
 */
import { baseLanguage, normalizeLanguage } from './languages.ts';
import { videoBaseName } from './naming.ts';
import { SUBTITLE_EXT } from './payload.ts';

const dirOf = (p: string): string => {
  const s = p.replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i).toLowerCase();
};
const nameOf = (p: string): string => p.replace(/\\/g, '/').replace(/^.*\//, '');

const SPLIT = /[.\-_ ()[\]]+/;

function sameLanguage(token: string, wanted: string): boolean {
  const code = normalizeLanguage(token);
  if (!code) return false;
  return code === wanted || code === baseLanguage(wanted);
}

/** True when `rest` (what follows the video's name, or the whole name) states `wanted`. `hi` only counts first: ".en.hi" is "hearing impaired". */
function statesLanguage(rest: string, wanted: string): boolean {
  const tokens = rest.split(SPLIT).filter(Boolean);
  if (sameLanguage(rest.replace(/^[.\-_ ]+/, ''), wanted)) return true;
  return tokens.some((t, i) => (/^(forced|sdh|cc)$/i.test(t) ? false : t.toLowerCase() === 'hi' && i > 0 ? false : /^\d+$/.test(t) ? false : sameLanguage(t, wanted)));
}

/**
 * `videoPath` is the video's path (or name) as listed in `files`; `files` are the paths of everything in the same
 * torrent or folder listing. Only subtitle files in the video's own folder count.
 */
export function hasExistingSubtitle(videoPath: string, language: string, files: readonly string[]): boolean {
  const wanted = normalizeLanguage(language);
  if (!wanted) return false;
  const dir = dirOf(videoPath);
  const base = videoBaseName(videoPath).toLowerCase();
  for (const f of files) {
    if (!SUBTITLE_EXT.test(f) || dirOf(f) !== dir) continue;
    const stem = nameOf(f).replace(SUBTITLE_EXT, '').toLowerCase();
    if (stem.startsWith(base) && stem.length > base.length && /^[.\-_ ]/.test(stem.slice(base.length))) {
      if (statesLanguage(stem.slice(base.length), wanted)) return true;
    } else if (!stem.startsWith(base) && statesLanguage(stem, wanted)) {
      // A bare language file ("English.srt", "2_English.srt") in the video's folder: every word of it is a language or a tag.
      const bare = stem.split(SPLIT).filter(Boolean).every((t) => /^(\d+|hi|sdh|cc|forced)$/.test(t) || normalizeLanguage(t) !== null);
      if (bare) return true;
    }
  }
  return false;
}
