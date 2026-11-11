// SM-27 Remove files (NATIVE_CONTRACT 14). Pure: no React, no IO. The component runs the effects.
// Anything not in the transition table is a no-op.
import { formatBytes } from '../../constants/format.ts';

export type RemoveFilesKind = 'idle' | 'confirming' | 'removing' | 'done' | 'failed';

export interface RemoveFilesState {
  kind: RemoveFilesKind;
  indices: number[];
  bytes: number;
  error?: string;
  freed?: number;
}

export type RemoveFilesEvent =
  | {
      type: 'REQUEST';
      /** Files to delete: included files, and skipped files that still hold bytes on disk. */
      indices: number[];
      bytes: number;
      allIncludedCount: number;
      /** How many of `indices` are included files. Skipped ones never count toward "keep one file". Defaults to all. */
      includedCount?: number;
      /** How many files the user picked, before the empty skipped ones were dropped. */
      requested?: number;
    }
  | { type: 'CONFIRM' }
  | { type: 'CANCEL' }
  | { type: 'RESULT_OK'; freedBytes: number }
  | { type: 'RESULT_ERR'; code: string; message: string }
  | { type: 'NOTICE_SHOWN' };

export type RemoveFilesEffect =
  | { type: 'openSheet' }
  | { type: 'closeSheet' }
  | { type: 'clearSelection' }
  | { type: 'notice'; text: string; tone: 'info' | 'danger' }
  | { type: 'haptic'; style: 'success' | 'warning' }
  | { type: 'call'; fn: 'removeFiles'; indices: number[] };

export interface RemoveFilesStep {
  state: RemoveFilesState;
  effects: RemoveFilesEffect[];
}

export const REMOVE_FILES_INITIAL: RemoveFilesState = { kind: 'idle', indices: [], bytes: 0 };

const IDLE: RemoveFilesState = REMOVE_FILES_INITIAL;

export const NOTHING_TO_REMOVE = "Nothing to remove. Those files aren't on your phone.";

export interface RemovableFile {
  index: number;
  progressBytes: number;
  /** Size on disk of a skipped file (preallocated or partial data). */
  onDiskBytes?: number;
  priority: 'first' | 'normal' | 'skip';
}

/**
 * Builds the REQUEST for the files the user picked. A skipped file is removable when it still holds bytes
 * on disk (preallocated or partial); a skipped file with nothing on disk is dropped, and when that leaves
 * nothing the machine shows a short notice.
 */
export function buildRemoveRequest(
  files: RemovableFile[],
  picked: number[],
): Extract<RemoveFilesEvent, { type: 'REQUEST' }> {
  const byIndex = new Map(files.map((f) => [f.index, f]));
  const indices: number[] = [];
  let bytes = 0;
  let includedCount = 0;
  for (const i of picked) {
    const f = byIndex.get(i);
    if (!f) continue;
    const skipped = f.priority === 'skip';
    const held = Math.max(f.progressBytes, f.onDiskBytes ?? 0);
    if (skipped && held <= 0) continue;
    indices.push(i);
    bytes += held;
    if (!skipped) includedCount++;
  }
  return {
    type: 'REQUEST',
    indices,
    bytes,
    allIncludedCount: files.filter((f) => f.priority !== 'skip').length,
    includedCount,
    requested: picked.length,
  };
}

/** Copy for a failed removal. Known codes get fixed text; anything else shows the native message. */
export function removeErrorCopy(code: string, message: string): string {
  switch (code) {
    case 'INVALID_STATE':
      return 'Wait until the move or check finishes.';
    case 'IO_ERROR':
      return "Couldn't delete the files. Check the folder still exists.";
    case 'NOT_FOUND':
      return 'This torrent is gone.';
    default:
      return message || "Couldn't remove those files.";
  }
}

/** One step of the SM-27 machine. Returns the next state and the effects to run. */
export function removeFilesStep(state: RemoveFilesState, event: RemoveFilesEvent): RemoveFilesStep {
  const same: RemoveFilesStep = { state, effects: [] };
  switch (state.kind) {
    case 'idle': {
      if (event.type !== 'REQUEST') return same;
      if (event.indices.length === 0) {
        // Everything picked was skipped and has nothing on disk: say so instead of doing nothing.
        if ((event.requested ?? 0) > 0) {
          return { state, effects: [{ type: 'notice', text: NOTHING_TO_REMOVE, tone: 'info' }] };
        }
        return same;
      }
      if ((event.includedCount ?? event.indices.length) >= event.allIncludedCount) {
        return {
          state,
          effects: [
            { type: 'notice', text: 'Keep at least one file.', tone: 'danger' },
            { type: 'haptic', style: 'warning' },
          ],
        };
      }
      return {
        state: { kind: 'confirming', indices: event.indices, bytes: event.bytes },
        effects: [{ type: 'openSheet' }],
      };
    }
    case 'confirming': {
      if (event.type === 'CANCEL') return { state: IDLE, effects: [{ type: 'closeSheet' }] };
      if (event.type === 'CONFIRM') {
        return {
          state: { ...state, kind: 'removing', error: undefined },
          effects: [{ type: 'call', fn: 'removeFiles', indices: state.indices }],
        };
      }
      return same;
    }
    case 'removing': {
      if (event.type === 'RESULT_OK') {
        return {
          state: { kind: 'done', indices: [], bytes: 0, freed: event.freedBytes },
          effects: [
            { type: 'closeSheet' },
            { type: 'clearSelection' },
            { type: 'notice', text: `Freed ${formatBytes(event.freedBytes)}.`, tone: 'info' },
            { type: 'haptic', style: 'success' },
          ],
        };
      }
      if (event.type === 'RESULT_ERR') {
        return {
          state: { ...state, kind: 'failed', error: removeErrorCopy(event.code, event.message) },
          effects: [{ type: 'haptic', style: 'warning' }],
        };
      }
      return same;
    }
    case 'failed': {
      if (event.type === 'CONFIRM') {
        return {
          state: { ...state, kind: 'removing', error: undefined },
          effects: [{ type: 'call', fn: 'removeFiles', indices: state.indices }],
        };
      }
      if (event.type === 'CANCEL') return { state: IDLE, effects: [{ type: 'closeSheet' }] };
      return same;
    }
    case 'done': {
      if (event.type === 'NOTICE_SHOWN') return { state: IDLE, effects: [] };
      return same;
    }
  }
}

/** Reducer form for React's useReducer: the state half of `removeFilesStep`. */
export function removeFilesReducer(state: RemoveFilesState, event: RemoveFilesEvent): RemoveFilesState {
  return removeFilesStep(state, event).state;
}
