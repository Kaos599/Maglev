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
}

export type SheetEvent =
  | { type: 'OPEN'; languages: string[]; needsNotice: boolean }
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
  | { type: 'CHOOSE'; choice: 'replace' | 'keep-both' | 'cancel' }
  | { type: 'SAVED'; fileName: string; language: string }
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

function withDefault(s: SheetState): SheetState {
  if (s.picked) return s;
  const rows = rowsOf(s);
  const at = defaultSelection(rows);
  return { ...s, selectedKey: at === null ? null : rowKey(rows[at]) };
}

function startSearch(s: SheetState): SheetState {
  return { ...s, phase: 'searching', ranked: [], sources: [], searchDone: false, selectedKey: null, picked: false, error: null };
}

export function sheetReducer(s: SheetState, e: SheetEvent): SheetState {
  switch (e.type) {
    case 'OPEN': {
      const languages = e.languages.length > 0 ? e.languages.slice() : ['en'];
      const base: SheetState = { ...CLOSED, languages, language: languages[0] };
      return e.needsNotice ? { ...base, phase: 'notice' } : startSearch(base);
    }
    case 'NOTICE_CONTINUE':
      return s.phase === 'notice' ? startSearch(s) : s;
    case 'NOTICE_NOT_NOW':
    case 'CLOSE':
      return CLOSED;
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
      const next: SheetState = { ...s, language: e.language, extra: e.type === 'PICK_OTHER' ? e.language : s.extra, picked: false, selectedKey: null, error: null };
      return withDefault(next);
    }
    case 'SELECT':
      return { ...s, selectedKey: e.key, picked: true, error: null };
    case 'DOWNLOAD':
      return canDownload(s) ? { ...s, phase: 'downloading', error: null, pendingChoice: null } : s;
    case 'DOWNLOAD_FAILED':
      return s.phase === 'downloading' ? { ...s, phase: 'results', error: e.error, keepBothNote: false } : s;
    case 'NAME_TAKEN':
      return s.phase === 'downloading' ? { ...s, phase: 'name-taken', takenName: e.fileName } : s;
    case 'CHOOSE':
      if (s.phase !== 'name-taken') return s;
      if (e.choice === 'cancel') return { ...s, phase: 'results', takenName: null, error: null };
      return { ...s, phase: 'downloading', pendingChoice: e.choice, keepBothNote: e.choice === 'keep-both', takenName: null, error: null };
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
