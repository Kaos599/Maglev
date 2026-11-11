// SM-28 Tracker edit (NATIVE_CONTRACT 15). Pure: no React, no IO. The component runs the effects.
// Anything not in the transition table is a no-op. The engine still checks every address; this only
// catches obvious mistakes before a call is made.

export type TrackerEditKind = 'idle' | 'adding' | 'saving' | 'confirmRemove' | 'removing';

export interface ParsedTrackers {
  valid: string[];
  invalid: string[];
  duplicates: string[];
}

export interface TrackerEditState {
  kind: TrackerEditKind;
  /** Pasted text in the add sheet. */
  text: string;
  /** Addresses the torrent already has, lower-cased and trimmed for the duplicate check. */
  existing: string[];
  parsed: ParsedTrackers;
  /** Message shown under the add field. */
  error?: string;
  /** The address being removed. */
  url?: string;
}

export type TrackerEditEvent =
  | { type: 'OPEN_ADD'; existing?: string[] }
  | { type: 'TEXT'; value: string }
  | { type: 'SUBMIT' }
  | { type: 'CANCEL' }
  | { type: 'ASK_REMOVE'; url: string }
  | { type: 'CONFIRM_REMOVE' }
  | { type: 'OK'; addedCount?: number }
  | { type: 'ERR'; message: string };

export type TrackerEditEffect =
  | { type: 'openSheet' }
  | { type: 'closeSheet' }
  | { type: 'show'; message: string }
  | { type: 'notice'; text: string; tone: 'info' | 'danger' }
  | { type: 'call'; fn: 'addTrackers'; urls: string[] }
  | { type: 'call'; fn: 'removeTracker'; url: string };

export interface TrackerEditStep {
  state: TrackerEditState;
  effects: TrackerEditEffect[];
}

const EMPTY_PARSED: ParsedTrackers = { valid: [], invalid: [], duplicates: [] };

export const TRACKER_EDIT_INITIAL: TrackerEditState = {
  kind: 'idle',
  text: '',
  existing: [],
  parsed: EMPTY_PARSED,
};

/** One address per line. Shape: scheme://host[:port][/path], with http, https or udp. */
const TRACKER_LINE = /^(https?|udp):\/\/[^\s/]+(:\d+)?(\/\S*)?$/i;

/**
 * Splits pasted text into valid, invalid and duplicate addresses. Lines are trimmed; blank lines are ignored.
 * A duplicate matches `existing` or an earlier line, ignoring case. The first copy is kept in `valid`.
 */
export function parseTrackerLines(text: string, existing: readonly string[]): ParsedTrackers {
  const seen = new Set(existing.map((e) => e.trim().toLowerCase()));
  const valid: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!TRACKER_LINE.test(line)) {
      invalid.push(line);
      continue;
    }
    const key = line.toLowerCase();
    if (seen.has(key)) {
      duplicates.push(line);
      continue;
    }
    seen.add(key);
    valid.push(line);
  }
  return { valid, invalid, duplicates };
}

function plural(n: number): string {
  return n === 1 ? 'tracker' : 'trackers';
}

/** One step of the SM-28 machine. Returns the next state and the effects to run. */
export function trackerEditStep(state: TrackerEditState, event: TrackerEditEvent): TrackerEditStep {
  const same: TrackerEditStep = { state, effects: [] };
  switch (state.kind) {
    case 'idle': {
      if (event.type === 'OPEN_ADD') {
        const existing = (event.existing ?? []).map((e) => e.trim().toLowerCase());
        return {
          state: { ...TRACKER_EDIT_INITIAL, kind: 'adding', existing, parsed: parseTrackerLines('', existing) },
          effects: [{ type: 'openSheet' }],
        };
      }
      if (event.type === 'ASK_REMOVE') {
        return { state: { ...state, kind: 'confirmRemove', url: event.url }, effects: [{ type: 'openSheet' }] };
      }
      return same;
    }
    case 'adding': {
      if (event.type === 'TEXT') {
        return { state: { ...state, text: event.value, parsed: parseTrackerLines(event.value, state.existing) }, effects: [] };
      }
      if (event.type === 'SUBMIT') {
        const { valid, invalid } = state.parsed;
        if (valid.length === 0) {
          const message = invalid.length ? `Not a tracker address: ${invalid[0]}` : 'Paste at least one tracker address.';
          return { state: { ...state, error: message }, effects: [{ type: 'show', message }] };
        }
        if (invalid.length > 0) {
          const message = `Not a tracker address: ${invalid[0]}`;
          return { state: { ...state, error: message }, effects: [{ type: 'show', message }] };
        }
        return {
          state: { ...state, kind: 'saving', error: undefined },
          effects: [{ type: 'call', fn: 'addTrackers', urls: valid }],
        };
      }
      if (event.type === 'CANCEL') {
        return { state: { ...TRACKER_EDIT_INITIAL, existing: state.existing }, effects: [{ type: 'closeSheet' }] };
      }
      return same;
    }
    case 'saving': {
      if (event.type === 'OK') {
        const n = event.addedCount ?? state.parsed.valid.length;
        const d = state.parsed.duplicates.length;
        const skipped = d > 0 ? ` Skipped ${d} already in the list.` : '';
        return {
          state: TRACKER_EDIT_INITIAL,
          effects: [
            { type: 'closeSheet' },
            { type: 'notice', text: `Added ${n} ${plural(n)}.${skipped}`, tone: 'info' },
          ],
        };
      }
      if (event.type === 'ERR') {
        return {
          state: { ...state, kind: 'adding', error: event.message },
          effects: [{ type: 'show', message: event.message }],
        };
      }
      return same;
    }
    case 'confirmRemove': {
      if (event.type === 'CANCEL') return { state: { ...state, kind: 'idle', url: undefined }, effects: [{ type: 'closeSheet' }] };
      if (event.type === 'CONFIRM_REMOVE') {
        return {
          state: { ...state, kind: 'removing' },
          effects: [{ type: 'call', fn: 'removeTracker', url: state.url ?? '' }],
        };
      }
      return same;
    }
    case 'removing': {
      if (event.type === 'OK') {
        return {
          state: { ...state, kind: 'idle', url: undefined },
          effects: [{ type: 'closeSheet' }, { type: 'notice', text: 'Tracker removed.', tone: 'info' }],
        };
      }
      if (event.type === 'ERR') {
        return {
          state: { ...state, kind: 'idle', url: undefined },
          effects: [{ type: 'closeSheet' }, { type: 'notice', text: event.message, tone: 'danger' }],
        };
      }
      return same;
    }
  }
}

/** Reducer form for React's useReducer: the state half of `trackerEditStep`. */
export function trackerEditReducer(state: TrackerEditState, event: TrackerEditEvent): TrackerEditState {
  return trackerEditStep(state, event).state;
}
