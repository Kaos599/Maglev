/**
 * Subtitle flow helpers (docs/NATIVE_CONTRACT.md 36.5, 36.7, 36.8, 36.10). Pure: no React, no react-native, so Node
 * tests run them with fakes. The sheet's UI and the cards only call these.
 */
import { fileKind } from '../../utils/fileKind.ts';
import { pickMainFile, type MainFileCandidate } from '../../utils/mainFile.ts';
import { languageName } from '../../utils/subtitles/languages.ts';
import { CARD_ICON_WORDS, errorCopy, FILE_NOT_STARTED, SAF_UNAVAILABLE, type ErrorCopy } from '../../utils/subtitles/copy.ts';
import { SubtitleError, type SubtitleErrorCode } from '../../utils/subtitles/payload.ts';
import { downloadAndPrepare, failureCode, type PreparedSubtitle, type SubtitleSourceStatus } from '../../utils/subtitles/search.ts';
import { saveWithChoice, type SaveChoice } from '../../utils/subtitles/naming.ts';
import { textToBase64 } from '../../utils/subtitles/payload.ts';
import type { SubtitleCandidate, SubtitleProvider, SubtitleQuery } from '../../utils/subtitles/types.ts';
import { stateVisible, type SubtitleCardState, type SubtitleState } from '../../utils/subtitles/prefs.ts';

// ---------------------------------------------------------------- a file to path or URI (36.6)

/**
 * The location the native subtitle calls accept: an absolute POSIX path built from the item's output folder and the
 * file's path inside it (the form the default folder and a "direct" custom folder give). A `content://` folder, an
 * empty one or a relative one can't be turned into a document URI here, so it gives null and the entry stays hidden.
 */
export function videoLocation(folder: string | null | undefined, relativePath: string): string | null {
  let base = (folder ?? '').trim();
  if (/^file:\/\//i.test(base)) base = base.replace(/^file:\/\//i, '');
  if (!base.startsWith('/')) return null;
  const rel = relativePath.replace(/^\/+/, '');
  if (!rel) return null;
  return `${base.replace(/\/+$/, '')}/${rel}`;
}

/** The last part of a path, no folders. */
export function baseName(path: string): string {
  return path.replace(/[?#].*$/, '').replace(/^.*[\\/]/, '');
}

// ---------------------------------------------------------------- entry points (36.10)

/** 'unavailable': a folder picked with the file picker (content://), where Find subtitles doesn't work yet (39.1 S6). */
export type EntryMode = 'hidden' | 'disabled' | 'enabled' | 'unavailable';

/** The line under a row that isn't enabled; undefined when there is nothing to say. */
export function entrySubtitle(mode: EntryMode | undefined): string | undefined {
  return mode === 'disabled' ? DISABLED_ENTRY_SUBTITLE : mode === 'unavailable' ? SAF_UNAVAILABLE : undefined;
}

const isSafFolder = (folder: string | null | undefined): boolean => /^content:\/\//i.test((folder ?? '').trim());

/**
 * A row that would show stays visible when its folder was picked with the file picker, but disabled with the
 * reason, never silently missing. Hidden stays hidden. Any other folder we can't turn into a path stays hidden.
 */
// NATIVE_CONTRACT 39.1 S6
function withLocation(mode: EntryMode, folder: string | null | undefined, relativePath: string): EntryMode {
  if (mode === 'hidden' || videoLocation(folder, relativePath) !== null) return mode;
  return isSafFolder(folder) ? 'unavailable' : 'hidden';
}

export interface EntryInput {
  /** `subtitles.enabled`. */
  master: boolean;
  /** How many sources are on (after the signed list). */
  sourcesOn: number;
  /** The file is a video. */
  isVideo: boolean;
  /** Some of the file is on disk (NATIVE_CONTRACT 42.1). */
  started: boolean;
  /** A stream (HLS/DASH) that is still joining its parts. */
  joining?: boolean;
}

/** Hidden when off, no source is on, not a video, or still joining. Nothing on disk yet shows disabled. */
// NATIVE_CONTRACT 42.1
function entryMode(i: EntryInput): EntryMode {
  if (!i.master || i.sourcesOn < 1 || !i.isVideo || i.joining) return 'hidden';
  return i.started ? 'enabled' : 'disabled';
}

/** The subtitle under a disabled entry row. */
export const DISABLED_ENTRY_SUBTITLE = FILE_NOT_STARTED;

export interface FileLike extends MainFileCandidate {
  progressBytes: number;
}

export const fileComplete = (f: { length: number; progressBytes: number }): boolean => f.length > 0 && f.progressBytes >= f.length;

/** Any of the file is on disk (NATIVE_CONTRACT 42.1). */
export const fileStarted = (f: { progressBytes: number }): boolean => f.progressBytes > 0;

/** One row of Detail → Files. */
export function fileEntryMode(f: FileLike, g: { master: boolean; sourcesOn: number; folder: string | null | undefined }): EntryMode {
  return withLocation(entryMode({ master: g.master, sourcesOn: g.sourcesOn, isVideo: fileKind(f.path) === 'video', started: fileStarted(f) }), g.folder, f.path);
}

/** Torrent-level entry (Torrent options): exactly one included video, with some of it on disk (42.1). */
export function torrentEntryMode(
  t: { finished?: boolean; folder: string | null | undefined },
  files: readonly FileLike[],
  g: { master: boolean; sourcesOn: number },
): { mode: EntryMode; file: FileLike | null } {
  const videos = pickMainFile(files).videos as FileLike[];
  if (videos.length !== 1) return { mode: 'hidden', file: null };
  const file = videos[0];
  // NATIVE_CONTRACT 42.1: the single included video has bytes on disk (a finished torrent has them too).
  const mode = withLocation(entryMode({ master: g.master, sourcesOn: g.sourcesOn, isVideo: true, started: fileStarted(file) }), t.folder, file.path);
  return mode === 'hidden' ? { mode, file: null } : { mode, file };
}

/** A link-download card: a video by its name with some of it on disk, not a stream still being joined (42.1). */
export function downloadEntryMode(
  d: { state: string; name: string; folder: string; downloaded?: number; muxNeeded?: boolean },
  g: { master: boolean; sourcesOn: number },
): EntryMode {
  return withLocation(
    entryMode({
      master: g.master,
      sourcesOn: g.sourcesOn,
      isVideo: fileKind(d.name) === 'video',
      // NATIVE_CONTRACT 42.1
      started: d.state === 'finished' || (d.downloaded ?? 0) > 0,
      joining: d.state === 'verifying' || !!d.muxNeeded,
    }),
    d.folder,
    d.name,
  );
}

// ---------------------------------------------------------------- the target the sheet works on

export interface SubtitleTarget {
  /** Path the native calls use. Also the key of `subtitles.state`. */
  videoPath: string;
  /** Video file name, no folders. */
  fileName: string;
  videoBytes: number;
  /** Only a complete file is fingerprinted. */
  complete: boolean;
  /** Card key: `t:<id>` or `d:<id>`. The state is kept under it too, so a card finds it without the file list. */
  ownerKey: string;
  /** For "This video already has English subtitles": the video's path and every file path of its torrent. Not set for link downloads (no listing). */
  existing?: { videoPath: string; files: readonly string[] };
}

export function torrentTarget(id: string, folder: string | null | undefined, file: FileLike, allFiles?: readonly { path: string }[]): SubtitleTarget | null {
  const videoPath = videoLocation(folder, file.path);
  if (!videoPath) return null;
  const t: SubtitleTarget = { videoPath, fileName: baseName(file.path), videoBytes: file.length, complete: fileComplete(file), ownerKey: `t:${id.toLowerCase()}` };
  if (allFiles) t.existing = { videoPath: file.path, files: allFiles.map((f) => f.path) };
  return t;
}

export function downloadTarget(d: { id: string; name: string; folder: string; size: number | null; downloaded: number; state: string }): SubtitleTarget | null {
  const videoPath = videoLocation(d.folder, d.name);
  if (!videoPath) return null;
  return { videoPath, fileName: baseName(d.name), videoBytes: d.size ?? d.downloaded, complete: d.state === 'finished', ownerKey: `d:${d.id}` };
}

// ---------------------------------------------------------------- hash (36.6)

export interface HashDeps {
  subtitleHash(pathOrUri: string): Promise<{ hash: string; bytes: number }>;
}

/**
 * The fingerprint of a finished file. An unfinished file is never read. FILE_TOO_SMALL and every other error give
 * no hash: the search still runs, by name. NOT_FOUND is the one that matters: the video is gone.
 */
export async function hashIfComplete(
  t: Pick<SubtitleTarget, 'videoPath' | 'complete' | 'videoBytes'>,
  deps: HashDeps,
): Promise<{ hash?: string; videoBytes: number; missing: boolean }> {
  if (!t.complete) return { videoBytes: t.videoBytes, missing: false };
  try {
    const r = await deps.subtitleHash(t.videoPath);
    return /^[0-9a-f]{16}$/.test(r.hash) ? { hash: r.hash, videoBytes: r.bytes || t.videoBytes, missing: false } : { videoBytes: t.videoBytes, missing: false };
  } catch (e) {
    return { videoBytes: t.videoBytes, missing: errorCodeOf(e) === 'NOT_FOUND' };
  }
}

function errorCodeOf(e: unknown): string {
  const o = e as { code?: unknown; message?: unknown } | null;
  if (o && typeof o.code === 'string') return o.code;
  const m = typeof o?.message === 'string' ? /\b(NAME_TAKEN|REPLACE_DENIED|CANT_WRITE|NO_SPACE|VERIFY_FAILED|NOT_FOUND|FILE_TOO_SMALL|ARCHIVE_UNSAFE|IO)\b/.exec(o.message) : null;
  return m ? m[1] : '';
}

// ---------------------------------------------------------------- errors (36.10)

export type ErrorActionKind = 'keep-both' | 'retry' | 'other-language' | 'close' | 'open-folder' | 'pick-another' | 'other-source';

export interface FlowError {
  code: SubtitleErrorCode;
  message: string;
  action: string;
  actionKind: ErrorActionKind;
}

const ACTION_KIND: Partial<Record<SubtitleErrorCode, ErrorActionKind>> = {
  offline: 'retry',
  timeout: 'retry',
  error: 'retry',
  challenge: 'retry',
  limit: 'other-source',
  nothing: 'other-language',
  missing: 'close',
  CANT_WRITE: 'open-folder',
  NO_SPACE: 'close',
  VERIFY_FAILED: 'retry',
  REPLACE_DENIED: 'keep-both',
  unreadable_text: 'pick-another',
  ambiguous_pack: 'pick-another',
  unsupported_archive: 'pick-another',
};

export function toFlowError(code: SubtitleErrorCode, a: { source?: string; language?: string } = {}): FlowError {
  const c: ErrorCopy = errorCopy(code, a);
  return { code, message: c.message, action: c.action, actionKind: ACTION_KIND[code] ?? 'retry' };
}

/** Any thrown value from a download or save, as the error to show. */
export function errorFromThrown(e: unknown, a: { source?: string; language?: string } = {}): FlowError {
  const native = errorCodeOf(e);
  if (native === 'NOT_FOUND') return toFlowError('missing', a);
  if (native === 'CANT_WRITE' || native === 'NO_SPACE' || native === 'VERIFY_FAILED' || native === 'REPLACE_DENIED') return toFlowError(native, a);
  if (native === 'ARCHIVE_UNSAFE') return toFlowError('unsupported_archive', a);
  return toFlowError(failureCode(e), a);
}

const NETWORK_TEXT = /network request failed|network error|failed to fetch|no internet|offline/i;

/** The source that did not answer, by name, for the "{Source} isn't responding" sentence. */
function failedSources(sources: readonly SubtitleSourceStatus[]): SubtitleSourceStatus[] {
  return sources.filter((s) => s.state === 'timeout' || s.state === 'error' || s.state === 'challenge' || s.state === 'limit');
}

/** Offline when nobody answered and every failure reads like a network failure. */
export function looksOffline(sources: readonly SubtitleSourceStatus[]): boolean {
  if (sources.length === 0) return false;
  const answered = sources.some((s) => s.state === 'done' || s.state === 'empty');
  if (answered) return false;
  const failed = failedSources(sources);
  return failed.length === sources.length && failed.every((s) => s.state === 'error' && NETWORK_TEXT.test(s.message ?? ''));
}

/** One line per source that failed, with the plain reason. `nameOf` maps a provider id to its display name. */
export function sourceProblems(sources: readonly SubtitleSourceStatus[], nameOf: (id: string) => string): { id: string; text: string; code: SubtitleErrorCode }[] {
  return failedSources(sources).map((s) => {
    const code: SubtitleErrorCode = s.state === 'limit' ? 'limit' : s.state === 'challenge' ? 'challenge' : s.state === 'timeout' ? 'timeout' : 'error';
    return { id: s.providerId, text: errorCopy(code, { source: nameOf(s.providerId) }).message, code };
  });
}

/** "2 sources didn't respond", the same wording Search uses. Empty when all answered. */
export function didntRespondLine(sources: readonly SubtitleSourceStatus[]): string {
  const n = failedSources(sources).length;
  if (n === 0) return '';
  return n === 1 ? "1 source didn't respond" : `${n} sources didn't respond`;
}

// ---------------------------------------------------------------- card icon (36.10)

export interface CardIconModel {
  state: SubtitleCardState;
  lang: string;
}

/** The icon for a stored state, or null when there is none to show (none yet, or a saved one older than 24 h). */
export function cardIconModel(entry: SubtitleState | null | undefined, now: number): CardIconModel | null {
  if (!entry || !stateVisible(entry, now)) return null;
  return { state: entry.state, lang: entry.lang };
}

export function sameCardIcon(a: CardIconModel | null | undefined, b: CardIconModel | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.state === b.state && a.lang === b.lang;
}

/** What TalkBack says: the state in words (NATIVE_CONTRACT 44.8). */
export function cardIconLabel(m: CardIconModel): string {
  return `${CARD_ICON_WORDS[m.state] ?? CARD_ICON_WORDS['needs-look']}. Opens subtitles.`;
}

/** The saved toast, e.g. "English subtitles saved". */
export const savedToast = (lang: string): string => `${languageName(lang)} subtitles saved`;

// ---------------------------------------------------------------- download and save (36.7, 36.8)

export interface SaveRunDeps {
  unzip(base64: string): Promise<{ name: string; base64: string }[]>;
  save(videoPathOrUri: string, fileName: string, base64: string, replace: boolean): Promise<{ path: string }>;
}

export type SaveRunResult =
  | { status: 'saved'; fileName: string; path: string; language: string; prepared: PreparedSubtitle }
  | { status: 'name-taken'; fileName: string; prepared: PreparedSubtitle }
  | { status: 'copies-full'; fileName: string; prepared: PreparedSubtitle }
  | { status: 'failed'; error: FlowError };

/**
 * Downloads the chosen candidate (or reuses `prepared` when the user came back from "name taken"), then saves it next
 * to the video. A taken name comes back as `name-taken` so the sheet can ask Replace / Keep both / Cancel; every
 * other failure is one sentence and one action (36.10).
 */
export async function downloadAndSave(
  a: {
    candidate: SubtitleCandidate;
    provider: SubtitleProvider;
    sourceName: string;
    target: Pick<SubtitleTarget, 'videoPath'>;
    query: Pick<SubtitleQuery, 'fileName' | 'season' | 'episode' | 'absoluteEpisode'>;
    choice: SaveChoice;
    prepared?: PreparedSubtitle | null;
    signal?: AbortSignal;
  },
  deps: SaveRunDeps,
): Promise<SaveRunResult> {
  const copyArgs = { source: a.sourceName, language: a.candidate.language };
  let prepared = a.prepared ?? null;
  try {
    if (!prepared) prepared = await downloadAndPrepare(a.candidate, { provider: a.provider, query: a.query, unzip: deps.unzip, signal: a.signal });
  } catch (e) {
    return { status: 'failed', error: errorFromThrown(e, copyArgs) };
  }
  try {
    const out = await saveWithChoice(
      { save: deps.save },
      {
        video: a.target.videoPath,
        language: a.candidate.language,
        format: prepared.format,
        hearingImpaired: a.candidate.hearingImpaired,
        base64: textToBase64(prepared.text),
        choice: a.choice,
      },
    );
    if (out.status === 'saved') return { status: 'saved', fileName: out.fileName, path: out.path, language: a.candidate.language, prepared };
    return { status: out.status, fileName: out.fileName, prepared };
  } catch (e) {
    return { status: 'failed', error: errorFromThrown(e, copyArgs) };
  }
}

export { SubtitleError };
