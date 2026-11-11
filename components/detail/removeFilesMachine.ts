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
  | { type: 'REQUEST'; indices: number[]; bytes: number; allIncludedCount: number }
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
      if (event.indices.length === 0) return same;
      if (event.indices.length >= event.allIncludedCount) {
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
