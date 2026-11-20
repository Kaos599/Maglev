/**
 * The subtitle sheet as a pure state machine (docs/NATIVE_CONTRACT.md 36.5, 36.10). The sheet component only
 * dispatches events and runs the effects for the phase it is in; every rule (default selection, tabs, name taken,
 * errors) lives here so Node tests cover it without rendering.
 *
 *   closed -> notice (first time only) -> searching -> results -> downloading -> saved
 *                                                         |            |-> name-taken -> downloading
 *                                                         |            '-> results (with an error line)
 *                                                         '-> failed (search could not run at all)
 */
import { defaultSelection, forLanguage, type RankedSubtitle } from '../../utils/subtitles/rank.ts';
import type { SubtitleSourceStatus } from '../../utils/subtitles/search.ts';
import type { SaveChoice } from '../../utils/subtitles/naming.ts';
import { parseName, parsedText, parseTyped } from '../../utils/subtitles/parseName.ts';
import { NOTE_MATCHED_BY_NAME, NOTE_MATCHED_BY_TYPED } from '../../utils/subtitles/copy.ts';
import { toFlowError, type FlowError } from './flow.ts';

export type SheetPhase = 'closed' | 'notice' | 'searching' | 'results' | 'downloading' | 'name-taken' | 'saved' | 'failed';

export interface SheetState {
  phase: SheetPhase;
  /** Language tabs in preference order (36.2). */
  languages: string[];
  /** The active tab. */
  language: string;
  /** A language picked from "Other…"; shown as one more tab. */
  extra: string | null;
  ranked: RankedSubtitle[];
  sources: SubtitleSourceStatus[];
  searchDone: boolean;
  /** `providerId:id` of the chosen row, or null. */
  selectedKey: string | null;
  /** True once the user picked a row, so streaming results never move the choice. */
  picked: boolean;
  /** A problem with the search or the last download or save. One sentence, one action. */
  error: FlowError | null;
  /** The choice that found the name taken, so Replace / Keep both knows what to retry. */
  pendingChoice: SaveChoice | null;
  /** Shown to the user after Keep both. */
  keepBothNote: boolean;
  /** The file name that already exists. */
  takenName: string | null;
  /** Set on saved. */
  savedName: string | null;
  savedLang: string | null;
  /** Rows whose download failed in this sheet; Pick another and the default selection skip them (39.1 S7). */
  failedKeys: string[];
  /** Every row of the active tab already failed, so Pick another has nothing left (39.1 S7). */
  noneLeft: boolean;
  /** Copies .2 to .9 all exist: only Replace or Cancel are offered (39.1 S8). */
  copiesFull: boolean;
  /** NATIVE_CONTRACT 42.3: the typed text the search uses instead of the file name, or null for the file name. Lives only while the sheet is open. */
  searchName: string | null;
  /** The "Searching for" row is a text field. */
  editing: boolean;
  /** What is in that field. */
  draft: string;
}

export type SheetEvent =
  /** `editName`: open with the 42 name field already open, holding this text (44.14 "Edit name"). */
  | { type: 'OPEN'; languages: string[]; needsNotice: boolean; editName?: string }
  | { type: 'NOTICE_CONTINUE' }
  | { type: 'NOTICE_NOT_NOW' }
  | { type: 'SEARCH_UPDATE'; ranked: RankedSubtitle[]; sources: SubtitleSourceStatus[]; done: boolean }
  | { type: 'SEARCH_FAILED'; error: FlowError }
  | { type: 'RETRY_SEARCH' }
  | { type: 'PICK_TAB'; language: string }
  | { type: 'PICK_OTHER'; language: string }
  | { type: 'SELECT'; key: string }
  | { type: 'DOWNLOAD' }
  | { type: 'DOWNLOAD_FAILED'; error: FlowError }
  | { type: 'NAME_TAKEN'; fileName: string }
  | { type: 'COPIES_FULL'; fileName: string }
  | { type: 'PICK_ANOTHER' }
  | { type: 'CHOOSE'; choice: 'replace' | 'keep-both' | 'cancel' }
  | { type: 'SAVED'; fileName: string; language: string }
  | { type: 'EDIT_NAME'; draft: string }
  | { type: 'DRAFT_CHANGE'; draft: string }
  | { type: 'SEARCH_NAME'; detected: string }
  | { type: 'USE_FILE_NAME' }
  | { type: 'CLOSE' };

export const rowKey = (r: RankedSubtitle): string => `${r.candidate.providerId}:${r.candidate.id}`;

export const CLOSED: SheetState = {
  phase: 'closed',
  languages: [],
  language: '',
  extra: null,
  ranked: [],
  sources: [],
  searchDone: false,
  selectedKey: null,
  picked: false,
  error: null,
  pendingChoice: null,
  keepBothNote: false,
  takenName: null,
  savedName: null,
  savedLang: null,
  failedKeys: [],
  noneLeft: false,
  copiesFull: false,
  searchName: null,
  editing: false,
  draft: '',
};

/** Tabs: the chosen languages, then the one picked from "Other…" when it isn't among them. */
export function tabsOf(s: Pick<SheetState, 'languages' | 'extra'>): string[] {
  return s.extra && !s.languages.includes(s.extra) ? [...s.languages, s.extra] : s.languages;
}

/** The rows of the active tab, already grouped and ordered. */
export function rowsOf(s: Pick<SheetState, 'ranked' | 'language'>): RankedSubtitle[] {
  return forLanguage(s.ranked, s.language);
}

/** What the active tab shows: still looking, rows, or nothing found for it. */
export function tabStatus(s: Pick<SheetState, 'ranked' | 'language' | 'searchDone'>): 'searching' | 'rows' | 'nothing' {
  if (rowsOf(s).length > 0) return 'rows';
  return s.searchDone ? 'nothing' : 'searching';
}

/** True when the tab has rows but none is in "Fits this file" (the "Nothing fits this file" box). */
export function nothingFits(s: Pick<SheetState, 'ranked' | 'language'>): boolean {
  const rows = rowsOf(s);
  return rows.length > 0 && !rows.some((r) => r.group === 'fits');
}

/** The chosen row, if it is on the active tab. */
export function selectedRow(s: Pick<SheetState, 'ranked' | 'language' | 'selectedKey'>): RankedSubtitle | null {
  if (!s.selectedKey) return null;
  return rowsOf(s).find((r) => rowKey(r) === s.selectedKey) ?? null;
}

/** Download stays disabled until a row is chosen (and while a download runs). */
export function canDownload(s: SheetState): boolean {
  return (s.phase === 'results' || s.phase === 'searching') && selectedRow(s) !== null;
}

/** The rows of the active tab that did not fail in this sheet. */
function untriedRows(s: Pick<SheetState, 'ranked' | 'language' | 'failedKeys'>): RankedSubtitle[] {
  return rowsOf(s).filter((r) => !s.failedKeys.includes(rowKey(r)));
}

// NATIVE_CONTRACT 39.1 S7: the default selection never lands on a row that already failed.
function withDefault(s: SheetState): SheetState {
  if (s.picked) return s;
  const rows = untriedRows(s);
  const at = defaultSelection(rows);
  return { ...s, selectedKey: at === null ? null : rowKey(rows[at]) };
}

/** Errors that come from the save, not from the chosen row: the same row may still be fine. */
const SAVE_STAGE_ERRORS = new Set(['CANT_WRITE', 'NO_SPACE', 'VERIFY_FAILED', 'REPLACE_DENIED', 'missing']);

function startSearch(s: SheetState): SheetState {
  return { ...s, phase: 'searching', ranked: [], sources: [], searchDone: false, selectedKey: null, picked: false, error: null, failedKeys: [], noneLeft: false, copiesFull: false };
}

/**
 * NATIVE_CONTRACT 42.3: Search is allowed only when the typed text has a title. `detected` is the file name's own
 * words in typing form; typing that back is the same as "Use file name" (no typed name, so the fingerprint is used).
 */
export function draftTitleOk(draft: string): boolean {
  return parseTyped(draft).title !== '';
}

/** The words of the name a search runs on, plain form (collapsed row) or typing form (field). */
export function searchText(fileName: string, searchName: string | null, typing = false): string {
  return parsedText(searchName ? parseTyped(searchName) : parseName(fileName), typing);
}

/** NATIVE_CONTRACT 42.5: the one muted line under the results, or null. */
export function searchNote(s: Pick<SheetState, 'searchName'>, fileComplete: boolean): string | null {
  if (!fileComplete) return NOTE_MATCHED_BY_NAME;
  return s.searchName ? NOTE_MATCHED_BY_TYPED : null;
}

export function sheetReducer(s: SheetState, e: SheetEvent): SheetState {
  switch (e.type) {
    case 'OPEN': {
      const languages = e.languages.length > 0 ? e.languages.slice() : ['en'];
      const base: SheetState = { ...CLOSED, languages, language: languages[0], ...(e.editName !== undefined ? { editing: true, draft: e.editName } : {}) };
      return e.needsNotice ? { ...base, phase: 'notice' } : startSearch(base);
    }
    case 'NOTICE_CONTINUE':
      return s.phase === 'notice' ? startSearch(s) : s;
    case 'NOTICE_NOT_NOW':
    case 'CLOSE':
      return CLOSED;
    // NATIVE_CONTRACT 42.3: the "Searching for" row. Only while there is a search step to edit.
    case 'EDIT_NAME':
      return s.phase === 'results' || s.phase === 'searching' ? { ...s, editing: true, draft: e.draft } : s;
    case 'DRAFT_CHANGE':
      return s.editing ? { ...s, draft: e.draft } : s;
    case 'SEARCH_NAME': {
      if ((s.phase !== 'results' && s.phase !== 'searching') || !draftTitleOk(s.draft)) return s;
      const typed = parseTyped(s.draft);
      const same = parsedText(typed, true) === e.detected;
      return startSearch({ ...s, searchName: same ? null : s.draft.trim(), editing: false, draft: '' });
    }
    case 'USE_FILE_NAME':
      return s.phase === 'results' || s.phase === 'searching' ? startSearch({ ...s, searchName: null, editing: false, draft: '' }) : s;
    case 'RETRY_SEARCH':
      return startSearch(s);
    case 'SEARCH_UPDATE': {
      if (s.phase !== 'searching' && s.phase !== 'results') return s;
      const next = withDefault({ ...s, ranked: e.ranked, sources: e.sources, searchDone: e.done, phase: e.done ? 'results' : 'searching' });
      return next;
    }
    case 'SEARCH_FAILED':
      return s.phase === 'searching' || s.phase === 'results' ? { ...s, phase: 'failed', error: e.error, searchDone: true } : s;
    case 'PICK_TAB':
    case 'PICK_OTHER': {
      const next: SheetState = { ...s, language: e.language, extra: e.type === 'PICK_OTHER' ? e.language : s.extra, picked: false, selectedKey: null, error: null, noneLeft: false };
      return withDefault(next);
    }
    case 'SELECT':
      return { ...s, selectedKey: e.key, picked: true, error: null, noneLeft: false };
    case 'PICK_ANOTHER': {
      // NATIVE_CONTRACT 39.1 S7: the next row that has not failed; none left says so.
      if (s.phase !== 'results' && s.phase !== 'searching') return s;
      const open = untriedRows(s);
      return open.length > 0
        ? { ...s, selectedKey: rowKey(open[0]), picked: true, error: null, noneLeft: false }
        : { ...s, selectedKey: null, picked: true, error: null, noneLeft: true };
    }
    case 'DOWNLOAD':
      return canDownload(s) ? { ...s, phase: 'downloading', error: null, pendingChoice: null, noneLeft: false } : s;
    case 'DOWNLOAD_FAILED': {
      if (s.phase !== 'downloading') return s;
      const failedKeys = s.selectedKey && !SAVE_STAGE_ERRORS.has(e.error.code) && !s.failedKeys.includes(s.selectedKey) ? [...s.failedKeys, s.selectedKey] : s.failedKeys;
      return { ...s, phase: 'results', error: e.error, keepBothNote: false, failedKeys };
    }
    case 'NAME_TAKEN':
      return s.phase === 'downloading' ? { ...s, phase: 'name-taken', takenName: e.fileName, copiesFull: false } : s;
    case 'COPIES_FULL':
      // NATIVE_CONTRACT 39.1 S8
      return s.phase === 'downloading' ? { ...s, phase: 'name-taken', takenName: e.fileName, copiesFull: true, keepBothNote: false } : s;
    case 'CHOOSE':
      // NATIVE_CONTRACT 39.1 S5: after "belongs to another app", Keep both saves the second copy from the results.
      if (s.phase === 'results' && s.error?.code === 'REPLACE_DENIED' && e.choice === 'keep-both') {
        return { ...s, phase: 'downloading', pendingChoice: 'keep-both', keepBothNote: true, takenName: null, error: null };
      }
      if (s.phase !== 'name-taken') return s;
      if (e.choice === 'cancel') return { ...s, phase: 'results', takenName: null, error: null, copiesFull: false };
      // Nothing left to keep beside (S8): Keep both is not an answer then.
      if (e.choice === 'keep-both' && s.copiesFull) return s;
      return { ...s, phase: 'downloading', pendingChoice: e.choice, keepBothNote: e.choice === 'keep-both', takenName: null, error: null, copiesFull: false };
    case 'SAVED':
      return s.phase === 'downloading' ? { ...s, phase: 'saved', savedName: e.fileName, savedLang: e.language, takenName: null } : s;
    default:
      return s;
  }
}

export interface CardWrite {
  state: 'getting' | 'saved' | 'needs-look';
  lang: string;
  file: string;
  savedAt: number;
}

/**
 * What to do with the stored card state when the phase changes: a state to write, 'clear' to forget it (the user
 * cancelled or closed while it was getting), or null for no change.
 */
export function cardStateFor(prev: SheetPhase, next: SheetState, now: number): CardWrite | 'clear' | null {
  if (prev === next.phase) return null;
  if (next.phase === 'downloading' && prev !== 'name-taken') return { state: 'getting', lang: next.language, file: '', savedAt: now };
  if (next.phase === 'saved') return { state: 'saved', lang: next.savedLang ?? next.language, file: next.savedName ?? '', savedAt: now };
  if (next.phase === 'results' && prev === 'downloading' && next.error) return { state: 'needs-look', lang: next.language, file: '', savedAt: now };
  if ((prev === 'downloading' || prev === 'name-taken') && (next.phase === 'closed' || (next.phase === 'results' && !next.error))) return 'clear';
  return null;
}

export { toFlowError };
