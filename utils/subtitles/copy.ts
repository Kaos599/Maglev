/**
 * Plain-English subtitle copy, in one place (docs/NATIVE_CONTRACT.md section 36.10). Each error has one sentence and
 * one action. Pure.
 */
import { languageName } from './languages.ts';
import type { SubtitleErrorCode } from './payload.ts';

export interface ErrorCopy {
  message: string;
  action: string;
}

export const SETTINGS_TITLE = 'Subtitles';
export const SETTINGS_SWITCH_SUBTITLE = 'Show Find subtitles on videos';
export const HEARING_OPTIONS = { both: 'Show both', prefer: 'Prefer', avoid: 'Avoid' } as const;
export const PRIVACY_LINE =
  "Looking up subtitles sends the video's file name and a fingerprint of the file to the source you use. Nothing is sent until you tap Find subtitles.";
export const TURNED_OFF_BY_MAGLEV = 'Turned off by Maglev';

export const FIND_SUBTITLES = 'Find subtitles…';
export const FILE_NOT_FINISHED = 'When this file finishes';
export const SHEET_TITLE = 'Subtitles';
export const DOWNLOAD_BUTTON = 'Download subtitle';
export const OTHER_LANGUAGE_TAB = 'Other…';
export const HEARING_IMPAIRED_TAG = 'Hearing impaired';

export const NOTHING_FITS_TITLE = 'Nothing fits this file';
export const NOTHING_FITS_BODY = 'These are for other releases. Speech may be early or late; most players can shift subtitle timing.';

export const NAME_TAKEN_TITLE = 'A subtitle with this name already exists.';
export const NAME_TAKEN_ACTIONS = { replace: 'Replace', keepBoth: 'Keep both', cancel: 'Cancel' } as const;
export const KEEP_BOTH_NOTE = "Players may not load the second one automatically.";

export const NOTICE_CONTINUE = 'Continue';
export const NOTICE_NOT_NOW = 'Not now';

/** One-time notice before the first lookup. `names` are the sources that are on. */
export function privacyNotice(names: readonly string[]): string {
  return `Finding subtitles sends this video's file name and a fingerprint of the file to the sources you have on (${names.join(', ')}). They can see what you're watching.`;
}

export const AMBIGUOUS_PACK = "This file has subtitles for several episodes and Maglev can't tell which one is yours.";
export const UNREADABLE_TEXT = "Maglev can't read this subtitle's text.";
export const UNSUPPORTED_FILE = "This subtitle's file type isn't supported.";

export function groupFoundLine(count: number): string {
  return count === 1 ? '1 subtitle' : `${count} subtitles`;
}

export interface CopyArgs {
  /** The source's display name. */
  source?: string;
  /** A language code; shown by its English name. */
  language?: string;
}

/** The sentence and the action for an error code (36.10). */
export function errorCopy(code: SubtitleErrorCode, a: CopyArgs = {}): ErrorCopy {
  const source = a.source ?? 'This source';
  switch (code) {
    case 'offline':
      return { message: "You're offline.", action: 'Retry' };
    case 'timeout':
    case 'error':
    case 'challenge':
      return { message: `${source} isn't responding.`, action: 'Try again' };
    case 'limit':
      return { message: `${source} says you've reached today's limit.`, action: 'Use another source' };
    case 'nothing':
      return { message: a.language ? `No ${languageName(a.language)} subtitles found.` : 'No subtitles found.', action: 'Other language' };
    case 'missing':
      return { message: "The video isn't there any more.", action: 'Close' };
    case 'CANT_WRITE':
      return { message: "Maglev can't write to this folder.", action: 'Open folder' };
    case 'NO_SPACE':
      return { message: 'Not enough space.', action: 'Close' };
    case 'VERIFY_FAILED':
      return { message: "The subtitle didn't save correctly.", action: 'Try again' };
    case 'unreadable_text':
      return { message: UNREADABLE_TEXT, action: 'Pick another' };
    case 'ambiguous_pack':
      return { message: AMBIGUOUS_PACK, action: 'Pick another' };
    case 'NAME_TAKEN':
      return { message: NAME_TAKEN_TITLE, action: NAME_TAKEN_ACTIONS.replace };
    case 'unsupported_archive':
    default:
      return { message: UNSUPPORTED_FILE, action: 'Pick another' };
  }
}
