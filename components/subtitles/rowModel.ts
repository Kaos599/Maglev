/**
 * The Subtitles row on the download page (docs/NATIVE_CONTRACT.md 44.14) as pure logic: facts in, one line and one
 * button out. No React, so Node tests run it. `SubtitlesRow.tsx` only draws the result.
 */
import { pickMainFile } from '../../utils/mainFile.ts';
import {
  MORE_SOURCES,
  ROW_BUTTONS,
  ROW_CLOSE_MATCH,
  ROW_FAILED,
  ROW_LIMITED,
  ROW_NEEDS_OK,
  ROW_NONE,
  ROW_NOT_ASKED,
  ROW_NOT_STARTED,
  ROW_OFFLINE,
  ROW_QUEUED,
  ROW_QUEUED_NO_LIST,
  ROW_SEARCHING,
  ROW_SKIPPED,
  ROW_UNAVAILABLE,
  USE_BEST_MATCH,
  bulkProgress,
  foundInOtherOnly,
  rowHasAlready,
  rowLabel,
  rowNoneOff,
  rowPackLine,
  rowSaved,
  rowSavedNoLanguage,
} from '../../utils/subtitles/copy.ts';
import type { FileRun, RequestPhase } from '../../utils/subtitles/requests.ts';
import { bulkIndex, pageRowAction } from '../../utils/subtitles/season.ts';
import { downloadEntryMode, fileStarted, torrentEntryMode, type CardIconModel, type FileLike, type SubtitleTarget } from './flow.ts';

/** What the button does. 'find', 'change', 'pick', 'edit-name' and 'find-more' open the one-video sheet; the sheet's start differs. */
export type RowAction = 'find' | 'cancel' | 'pick' | 'edit-name' | 'see-all' | 'try-again' | 'review' | 'ask-pack' | 'more-sources' | 'use-best' | 'busy';

/** How the sheet opens: on its results (the default) or with the 42 name field already open. */
export type SheetStart = 'results' | 'edit-name';

export interface RowInput {
  /** The request's phase (`useRequestPhases`), when there is one. */
  phase?: RequestPhase;
  /** The request's "found in {other} only" language. */
  otherLang?: string;
  /** Torrent requests: the runner has listed the video files. */
  fileListKnown: boolean;
  /** Season pack: one run per video file. Null for a single video. */
  pack?: { total: number; saved: number; needYou: number } | null;
  /** The stored per-video state, used when there is no request. */
  stored?: CardIconModel | null;
  /** Language of a saved subtitle or of the one already there. */
  language?: string | null;
  /** The video has some bytes on disk (42.1). */
  started: boolean;
  /** One video's sheet can open (a target exists). */
  canOpenSheet: boolean;
  /** 44.15 D7: a pack with no request can be asked for as a whole ("Get subtitles"). */
  canAskPack?: boolean;
  /** 44.15 D10: the privacy notice has not been accepted, so a request waits. */
  needsOk?: boolean;
  /** 45.5: how many sources are off and could have answered. Shown only with "No match yet". */
  offSources?: number;
  /** 46.5: a pack's needs-pick runs whose best stored candidate qualifies (46.3's `k`). */
  bestK?: number;
  /** 46.3: a bulk save is running for this pack: how many have ended, of how many. */
  bulk?: { done: number; total: number } | null;
}

export type RowGlyph = 'getting' | 'saved' | 'needs-look' | 'none';

export interface RowModel {
  line: string;
  /** The line is muted (nothing to do yet). */
  muted: boolean;
  button: { label: string; action: RowAction } | null;
  /** Same shapes as the card icon (44.8). */
  glyph: RowGlyph;
  start: SheetStart;
  a11y: string;
  /** A second text button: "More sources" (45.5), or "See all" next to "Use best match" (46.5). */
  extra?: { label: string; action: 'more-sources' | 'see-all' };
}

/** Counts for a season pack from the request's per-file runs. Null unless there are two or more videos. */
export function packCounts(files: Record<string, FileRun> | undefined): { total: number; saved: number; needYou: number } | null {
  const runs = files ? Object.values(files) : [];
  if (runs.length < 2) return null;
  return { total: runs.length, saved: runs.filter((r) => r.phase === 'saved').length, needYou: runs.filter((r) => r.phase === 'needs-pick').length };
}

const GLYPH: Record<RequestPhase, RowGlyph> = {
  queued: 'getting',
  searching: 'getting',
  saved: 'saved',
  'needs-pick': 'needs-look',
  none: 'none',
  'has-already': 'none',
  offline: 'none',
  limited: 'none',
  skipped: 'none',
  failed: 'none',
  unavailable: 'none',
};

/** A stored state stands in for a phase when there is no request. */
function storedPhase(s: CardIconModel): RequestPhase {
  return s.state === 'saved' ? 'saved' : s.state === 'needs-look' ? 'needs-pick' : s.state === 'getting' ? 'searching' : 'none';
}

const make = (line: string, muted: boolean, button: RowModel['button'], glyph: RowGlyph, start: SheetStart = 'results'): RowModel => ({
  line,
  muted,
  button,
  glyph,
  start,
  a11y: rowLabel(line, button?.label ?? null),
});

/** 44.14 table: the phase to the line and the button. */
export function rowModel(i: RowInput): RowModel {
  let phase = i.phase;
  let fromRequest = phase !== undefined;
  if (!phase && i.stored) {
    phase = storedPhase(i.stored);
    fromRequest = false;
  }
  const sheet = (label: string, action: RowAction): RowModel['button'] => (i.canOpenSheet ? { label, action } : null);

  if (!phase) {
    if (!i.started) return make(ROW_NOT_STARTED, true, null, 'none');
    // 44.15 D7: a pack has no single video to open, so its button asks for the whole pack.
    if (i.canAskPack) return make(ROW_NOT_ASKED, false, { label: ROW_BUTTONS.getSubtitles, action: 'ask-pack' }, 'none');
    return make(ROW_NOT_ASKED, false, sheet(ROW_BUTTONS.find, 'find'), 'none');
  }

  // 44.15 D10: a request found without the one-time OK is held until the user reviews the notice.
  if (fromRequest && i.needsOk && phase !== 'skipped' && phase !== 'saved' && phase !== 'has-already') {
    return make(ROW_NEEDS_OK, false, { label: ROW_BUTTONS.review, action: 'review' }, 'none');
  }

  // Season pack: a count, and "See all" opens the status sheet.
  if (i.pack && phase !== 'skipped') {
    const line = rowPackLine(i.pack);
    if (i.bulk) return make(line, false, { label: bulkProgress(bulkIndex(i.bulk.done, i.bulk.total), i.bulk.total), action: 'busy' }, GLYPH[phase]);
    // 46.5: "Use best match" when a run qualifies; every other pack keeps "See all". The list stays one tap away.
    if (pageRowAction(i.bestK ?? 0) === 'use-best') {
      return { ...make(line, false, { label: USE_BEST_MATCH, action: 'use-best' }, GLYPH[phase]), extra: { label: ROW_BUTTONS.seeAll, action: 'see-all' } };
    }
    return make(line, false, { label: ROW_BUTTONS.seeAll, action: 'see-all' }, GLYPH[phase]);
  }

  const language = i.language ?? i.stored?.lang ?? null;
  switch (phase) {
    case 'queued':
      return make(i.fileListKnown ? ROW_QUEUED : ROW_QUEUED_NO_LIST, false, { label: ROW_BUTTONS.cancel, action: 'cancel' }, 'getting');
    case 'searching':
      // A stored "getting" state has no request to cancel.
      return make(ROW_SEARCHING, false, fromRequest ? { label: ROW_BUTTONS.cancel, action: 'cancel' } : null, 'getting');
    case 'saved':
      return make(language ? rowSaved(language) : rowSavedNoLanguage, false, sheet(ROW_BUTTONS.change, 'find'), 'saved');
    case 'needs-pick':
      return make(i.otherLang ? foundInOtherOnly(i.otherLang) : ROW_CLOSE_MATCH, false, sheet(ROW_BUTTONS.pick, 'pick'), 'needs-look');
    case 'none': {
      const k = i.offSources ?? 0;
      const m = make(k > 0 ? rowNoneOff(k) : ROW_NONE, false, sheet(ROW_BUTTONS.editName, 'edit-name'), 'none', 'edit-name');
      return k > 0 ? { ...m, extra: { label: MORE_SOURCES, action: 'more-sources' } } : m;
    }
    case 'has-already':
      return make(rowHasAlready(language), false, sheet(ROW_BUTTONS.findMore, 'find'), 'none');
    case 'offline':
      return make(ROW_OFFLINE, true, null, 'none');
    case 'limited':
      return make(ROW_LIMITED, true, null, 'none');
    case 'skipped':
      return make(ROW_SKIPPED, true, sheet(ROW_BUTTONS.find, 'find'), 'none');
    case 'failed':
      return make(ROW_FAILED, false, { label: ROW_BUTTONS.tryAgain, action: 'try-again' }, 'none');
    case 'unavailable':
      return make(ROW_UNAVAILABLE, true, null, 'none');
  }
}

// ---------------------------------------------------------------- when the row shows, and what it can open

export interface RowFacts {
  /** Null: no row (44.14 "Where it shows"). */
  show: boolean;
  /** 44.15 D7: a pack (two or more videos): no single target, but the whole pack can be asked for. */
  canAskPack?: boolean;
  started: boolean;
  canOpenSheet: boolean;
  /** A torrent's single video file, for the sheet's target. */
  file: FileLike | null;
  fileListKnown: boolean;
}

const g = (a: { master: boolean; sourcesOn: number }) => ({ master: a.master, sourcesOn: a.sourcesOn });

/**
 * Torrent page: shows when the torrent has an included video, the master switch is on and a source is on. One video
 * opens the sheet; a pack (two or more) has no single target, so only "See all" applies.
 */
export function torrentRowFacts(
  t: { finished?: boolean; folder: string | null | undefined },
  files: readonly FileLike[],
  avail: { master: boolean; sourcesOn: number },
  hasFileList: boolean,
): RowFacts {
  const videos = pickMainFile(files).videos as FileLike[];
  if (!avail.master || avail.sourcesOn < 1 || videos.length === 0) return { show: false, started: false, canOpenSheet: false, file: null, fileListKnown: hasFileList };
  const started = videos.some(fileStarted);
  if (videos.length > 1) return { show: true, started, canOpenSheet: false, canAskPack: true, file: null, fileListKnown: hasFileList };
  const one = torrentEntryMode(t, files, g(avail));
  return { show: true, started, canOpenSheet: one.mode === 'enabled' && one.file !== null, file: one.file, fileListKnown: hasFileList };
}

/** Link page: shows for a video by its name that is not a stream still joining. */
export function downloadRowFacts(
  d: { state: string; name: string; folder: string; downloaded?: number; muxNeeded?: boolean },
  avail: { master: boolean; sourcesOn: number },
): RowFacts {
  const mode = downloadEntryMode(d, g(avail));
  return { show: mode !== 'hidden', started: mode === 'enabled' || mode === 'unavailable', canOpenSheet: mode === 'enabled', file: null, fileListKnown: true };
}

export type { SubtitleTarget };
