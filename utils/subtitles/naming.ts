/**
 * Subtitle file names (docs/NATIVE_CONTRACT.md section 36.8). Pure.
 *   <video base name>.<lang>[.hi].<ext>, next to the video.
 *   "Keep both" when that name exists: <base>.<lang>.2.<ext> (hearing impaired: <base>.<lang>.hi.2.<ext>).
 */
import { normalizeLanguage } from './languages.ts';
import { SubtitleError } from './payload.ts';
import type { SubFormat } from './types.ts';

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|mts|wmv|flv|mpg|mpeg|mpe|3gp|ogv|divx|vob)$/i;

/** A file name is at most 255 UTF-8 bytes; the temporary file next to it adds ".<name>.maglev-tmp" (12 bytes). */
const NAME_LIMIT = 255;
const TEMP_OVERHEAD = 12;

function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** The longest start of [text] (cut between characters, never inside one) that fits [maxBytes] UTF-8 bytes. */
function trimToBytes(text: string, maxBytes: number): string {
  let out = '';
  let n = 0;
  for (const ch of text) {
    const w = utf8Length(ch);
    if (n + w > maxBytes) break;
    out += ch;
    n += w;
  }
  return out;
}

/**
 * The video's name with no folders and no video extension, and no characters a file name can't hold. When
 * [reserveBytes] (the ".<lang>.ext" ending to come) is given, the base is shortened on a character boundary so the
 * final name plus the temporary-file overhead stays within 255 UTF-8 bytes.
 */
// NATIVE_CONTRACT 39.1 S4
export function videoBaseName(videoPathOrName: string, reserveBytes = 0): string {
  let name = videoPathOrName.replace(/[?#].*$/, '');
  try {
    if (/^content:/i.test(name)) name = decodeURIComponent(name);
  } catch {
    // keep the raw text
  }
  name = name.replace(/^.*[\\/:]/, '').replace(VIDEO_EXT, '');
  const clean = name.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, '_').trim();
  const trimmed = trimToBytes(clean, Math.max(1, NAME_LIMIT - TEMP_OVERHEAD - reserveBytes)).trim();
  return trimmed || 'subtitle';
}

export interface NameOptions {
  hearingImpaired?: boolean;
  /** Use the keep-both name: the number is added before the extension. */
  keepBoth?: boolean;
  /** The keep-both number (2 by default; 3 when `.2` is taken too). */
  copy?: number;
}

/** The subtitle file name for a video. `language` is normalised; one we don't know is written as given. */
export function subtitleFileName(videoPathOrName: string, language: string, format: SubFormat, opts: NameOptions = {}): string {
  const lang = (normalizeLanguage(language) ?? language.trim().replace(/[^A-Za-z0-9-]+/g, '')) || 'und';
  const tail: string[] = [lang];
  if (opts.hearingImpaired) tail.push('hi');
  if (opts.keepBoth) tail.push(String(Math.max(2, Math.floor(opts.copy ?? 2))));
  const ending = `.${tail.join('.')}.${format}`;
  // The ending is kept whole; the video's base gives way.
  return `${videoBaseName(videoPathOrName, utf8Length(ending))}${ending}`;
}

export type SaveChoice = 'normal' | 'replace' | 'keep-both';

export interface SaveDeps {
  /** Native `saveSubtitle(videoPathOrUri, fileName, base64, replace)`. */
  save(videoPathOrUri: string, fileName: string, base64: string, replace: boolean): Promise<{ path: string }>;
}

export type SaveOutcome =
  | { status: 'saved'; path: string; fileName: string }
  | { status: 'name-taken'; fileName: string }
  /** Copies .2 to .9 all exist (39.1 S8): Keep both has nothing left to offer. */
  | { status: 'copies-full'; fileName: string };

function codeOf(e: unknown): string {
  const o = e as { code?: unknown; message?: unknown } | null;
  if (o && typeof o.code === 'string') return o.code;
  const m = typeof o?.message === 'string' ? /\b(NAME_TAKEN|REPLACE_DENIED|CANT_WRITE|NO_SPACE|VERIFY_FAILED|NOT_FOUND)\b/.exec(o.message) : null;
  return m ? m[1] : '';
}

/**
 * Saves next to the video. With 'normal' a taken name comes back as `name-taken` (the sheet then asks Replace /
 * Keep both / Cancel and calls again with 'replace' or 'keep-both'). 'keep-both' tries `.2`, then `.3`, ... up to 9.
 * Other native errors become SubtitleError with the native code.
 */
export async function saveWithChoice(
  deps: SaveDeps,
  args: { video: string; language: string; format: SubFormat; hearingImpaired?: boolean; base64: string; choice?: SaveChoice },
): Promise<SaveOutcome> {
  const choice = args.choice ?? 'normal';
  const nameOpts = { hearingImpaired: args.hearingImpaired };
  const attempt = async (fileName: string, replace: boolean) => {
    try {
      return { path: (await deps.save(args.video, fileName, args.base64, replace)).path };
    } catch (e) {
      const code = codeOf(e);
      if (code === 'NAME_TAKEN') return null;
      // NATIVE_CONTRACT 39.1 S5: the old file can't be replaced; the sheet offers a second copy.
      if (code === 'REPLACE_DENIED') throw new SubtitleError('REPLACE_DENIED');
      if (code === 'CANT_WRITE' || code === 'NO_SPACE' || code === 'VERIFY_FAILED') throw new SubtitleError(code);
      if (code === 'NOT_FOUND') throw new SubtitleError('missing');
      throw new SubtitleError('CANT_WRITE');
    }
  };
  if (choice === 'keep-both') {
    for (let n = 2; n <= 9; n++) {
      const fileName = subtitleFileName(args.video, args.language, args.format, { ...nameOpts, keepBoth: true, copy: n });
      const r = await attempt(fileName, false);
      if (r) return { status: 'saved', path: r.path, fileName };
    }
    // NATIVE_CONTRACT 39.1 S8: a distinct result, so the sheet never asks the same question again.
    return { status: 'copies-full', fileName: subtitleFileName(args.video, args.language, args.format, { ...nameOpts, keepBoth: true, copy: 9 }) };
  }
  const fileName = subtitleFileName(args.video, args.language, args.format, nameOpts);
  const r = await attempt(fileName, choice === 'replace');
  return r ? { status: 'saved', path: r.path, fileName } : { status: 'name-taken', fileName };
}
