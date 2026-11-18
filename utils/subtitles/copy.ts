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
// NATIVE_CONTRACT 42.1
export const FILE_NOT_STARTED = 'When this file starts';
export const SHEET_TITLE = 'Subtitles';
export const DOWNLOAD_BUTTON = 'Download subtitle';
// NATIVE_CONTRACT 42.3
export const SEARCHING_FOR_LABEL = 'Searching for';
export const CHANGE_NAME_LABEL = 'Change the name to search for';
export const USE_FILE_NAME = 'Use file name';
export const TYPE_A_TITLE = 'Type a title';
export const SEARCH_BUTTON = 'Search';
// NATIVE_CONTRACT 42.5
export const NOTE_MATCHED_BY_NAME = 'Matched by name. Exact matching works once the file finishes.';
export const NOTE_MATCHED_BY_TYPED = 'Matched by the name you typed.';
export const OTHER_LANGUAGE_TAB = 'Other…';
export const HEARING_IMPAIRED_TAG = 'Hearing impaired';

export const NOTHING_FITS_TITLE = 'Nothing fits this file';
export const NOTHING_FITS_BODY = 'These are for other releases. Speech may be early or late; most players can shift subtitle timing.';

export const NAME_TAKEN_TITLE = 'A subtitle with this name already exists.';
export const NAME_TAKEN_ACTIONS = { replace: 'Replace', keepBoth: 'Keep both', cancel: 'Cancel' } as const;
export const KEEP_BOTH_NOTE = "Players may not load the second one automatically.";

/** 39.1 S8: copies .2 to .9 all exist. */
export const COPIES_FULL_TITLE = 'There are already 9 copies. Replace one or cancel.';
/** 39.1 S7: every row of this language already failed. */
export const NO_OTHER_ROWS = 'No other subtitles to try for this language.';
/** 39.1 S6: SAF (file picker) folders. Shown on the menu row and in Settings > Subtitles. */
export const SAF_UNAVAILABLE = 'Not available yet for folders picked with the file picker';

export const NOTICE_CONTINUE = 'Continue';
export const NOTICE_NOT_NOW = 'Not now';

/** Shown instead of "No English subtitles found." when a subtitle in that language already sits next to the video. */
export function alreadyHasCopy(language: string): string {
  return `This video already has ${languageName(language)} subtitles.`;
}

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
    case 'REPLACE_DENIED':
      // NATIVE_CONTRACT 39.1 S5
      return { message: 'That file belongs to another app. Save a second copy instead?', action: NAME_TAKEN_ACTIONS.keepBoth };
    case 'NAME_TAKEN':
      return { message: NAME_TAKEN_TITLE, action: NAME_TAKEN_ACTIONS.replace };
    case 'unsupported_archive':
    default:
      return { message: UNSUPPORTED_FILE, action: 'Pick another' };
  }
}

// ---------------------------------------------------------------- NATIVE_CONTRACT 44: the "Added" message and requests

/** 44.6. The switch's line in Settings > Subtitles. */
export const AUTO_NEW_VIDEOS_SUBTITLE = 'In your languages, while Maglev is open';

/** 44.7: results only in languages the user didn't pick. */
export const foundInOtherOnly = (language: string): string => `Found in ${languageName(language)} only`;

/** 44.8: what TalkBack says for the card icon, by state. */
export const CARD_ICON_WORDS = {
  getting: 'Getting subtitles',
  saved: 'Subtitles saved',
  'needs-look': 'Subtitles: pick one',
  none: 'No subtitles found',
} as const;

/** 44.7: requests wait for the one-time notice (36.10) because nothing may be sent before it. */
export const CONSENT_NOTICE_ACTION = NOTICE_CONTINUE;

// 44.9 The multi-video sheet.
export const multiTitle = (n: number): string => `Subtitles for ${n} videos`;
export const USES_YOUR_LANGUAGES = 'Uses your subtitle languages';
export const CHANGE_LANGUAGES = 'Change';
export const MULTI_BUTTON_NONE = 'Get subtitles';
export const multiButton = (k: number): string => (k <= 0 ? MULTI_BUTTON_NONE : `Get subtitles for ${k}`);
export const SKIP_LABEL = 'Skip';
/** Appended to a row whose title and detail match another row's. `time` is h:mm. */
export const addedAtSuffix = (time: string): string => ` \u00B7 added ${time}`;
export const nonVideoOne = (name: string): string => `${name} is music, so it gets no subtitles.`;
export const nonVideoMany = (k: number): string => `${k} other adds are not videos, so they get no subtitles.`;

/** 44.9 status mode: a phase in words. */
export const PHASE_WORDS = {
  queued: 'Waiting for the file',
  searching: 'Getting\u2026',
  saved: 'Saved',
  'needs-pick': 'Close match \u00B7 pick',
  none: 'None found \u00B7 edit name',
  'has-already': 'Already has subtitles',
  offline: "You're offline",
  limited: 'Source limit reached',
  skipped: 'Skipped',
} as const;

/** Summary line of status mode, e.g. "2 saved \u00B7 1 needs you". Empty when nothing to say. */
export function statusSummary(c: { saved: number; needsYou: number; waiting: number }): string {
  const parts: string[] = [];
  if (c.saved > 0) parts.push(`${c.saved} saved`);
  if (c.needsYou > 0) parts.push(`${c.needsYou} ${c.needsYou === 1 ? 'needs' : 'need'} you`);
  if (c.waiting > 0) parts.push(`${c.waiting} getting`);
  return parts.join(' \u00B7 ');
}
