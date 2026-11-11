// SM-32 files changed outside Maglev, plus the copy for SM-33 and SM-37 health banners (NATIVE_CONTRACT 18, 20).
// Pure: no React, no IO. The detail screen runs the effects.
// Anything not in the transition table is a no-op.

export type HealthTagName = 'files_missing' | 'files_changed' | 'storage_full' | 'storage_unavailable' | 'no_peers';
export type ResolveAction = 'stop' | 'again' | 'folder' | 'recheck';

export type FileHealthKind = 'idle' | 'missing' | 'changed' | 'picking' | 'working' | 'kept';

export interface FileHealthState {
  kind: FileHealthKind;
  /** Missing file indices while `missing`, `picking` or `working` on a missing set. */
  indices: number[];
  /** The banner state to return to when a pick is cancelled or a call fails. */
  back?: 'missing' | 'changed';
  error?: string;
  /** Shown on the busy button while `working`. */
  action?: ResolveAction;
}

export type FileHealthEvent =
  | { type: 'SYNC'; health: string | null; missing: number[] }
  | { type: 'STOP' }
  | { type: 'AGAIN' }
  | { type: 'PICK_FOLDER' }
  | { type: 'FOLDER_PICKED'; dir: string }
  | { type: 'FOLDER_CANCELLED' }
  | { type: 'PICK_FAILED' }
  | { type: 'RECHECK' }
  | { type: 'STOP_SHARING' }
  | { type: 'RESULT_OK' }
  | { type: 'RESULT_ERR'; code: string; message: string };

export type FileHealthEffect =
  | { type: 'pickFolder' }
  | { type: 'call'; action: ResolveAction; indices: number[]; dir: string }
  | { type: 'haptic'; style: 'success' | 'warning' };

export interface FileHealthStep {
  state: FileHealthState;
  effects: FileHealthEffect[];
}

export const FILE_HEALTH_INITIAL: FileHealthState = { kind: 'idle', indices: [] };

/** Copy for a failed resolve. Known codes get fixed text; anything else shows the native message. */
export function resolveErrorCopy(code: string, message: string): string {
  switch (code) {
    case 'FILES_MISSING':
      return message || "Those files aren't in that folder.";
    case 'INVALID_STATE':
      return 'Wait until the move or check finishes.';
    case 'NOT_FOUND':
      return 'This torrent is gone.';
    default:
      return message || "Couldn't do that. Try again.";
  }
}

/** One step of the SM-32 machine. Returns the next state and the effects to run. */
export function fileHealthStep(state: FileHealthState, event: FileHealthEvent): FileHealthStep {
  const same: FileHealthStep = { state, effects: [] };
  if (event.type === 'SYNC') {
    // A running call or an open picker owns the state until it answers.
    if (state.kind === 'working' || state.kind === 'picking') return same;
    if (event.health === 'files_missing' && event.missing.length > 0) {
      if (state.kind === 'missing') return { state: { ...state, indices: event.missing }, effects: [] };
      return { state: { kind: 'missing', indices: event.missing }, effects: [] };
    }
    if (event.health === 'files_changed') {
      if (state.kind === 'changed' || state.kind === 'kept') return same;
      return { state: { kind: 'changed', indices: [] }, effects: [] };
    }
    return state.kind === 'idle' ? same : { state: FILE_HEALTH_INITIAL, effects: [] };
  }
  switch (state.kind) {
    case 'missing': {
      if (event.type === 'STOP' || event.type === 'AGAIN') {
        const action: ResolveAction = event.type === 'STOP' ? 'stop' : 'again';
        return {
          state: { kind: 'working', indices: state.indices, back: 'missing', action },
          effects: [{ type: 'call', action, indices: state.indices, dir: '' }],
        };
      }
      if (event.type === 'PICK_FOLDER') {
        return {
          state: { kind: 'picking', indices: state.indices, back: 'missing', action: 'folder' },
          effects: [{ type: 'pickFolder' }],
        };
      }
      return same;
    }
    case 'changed': {
      if (event.type === 'RECHECK') {
        return {
          state: { kind: 'working', indices: [], back: 'changed', action: 'recheck' },
          effects: [{ type: 'call', action: 'recheck', indices: [], dir: '' }],
        };
      }
      // Keep it paused. The banner goes away until the tag changes.
      if (event.type === 'STOP_SHARING') return { state: { kind: 'kept', indices: [] }, effects: [] };
      return same;
    }
    case 'picking': {
      if (event.type === 'FOLDER_PICKED') {
        return {
          state: { kind: 'working', indices: state.indices, back: 'missing', action: 'folder' },
          effects: [{ type: 'call', action: 'folder', indices: state.indices, dir: event.dir }],
        };
      }
      if (event.type === 'FOLDER_CANCELLED') return { state: { kind: 'missing', indices: state.indices }, effects: [] };
      if (event.type === 'PICK_FAILED') {
        return {
          state: { kind: 'missing', indices: state.indices, error: "Couldn't open the folder picker. Try again." },
          effects: [{ type: 'haptic', style: 'warning' }],
        };
      }
      return same;
    }
    case 'working': {
      if (event.type === 'RESULT_OK') return { state: FILE_HEALTH_INITIAL, effects: [{ type: 'haptic', style: 'success' }] };
      if (event.type === 'RESULT_ERR') {
        return {
          state: { kind: state.back ?? 'missing', indices: state.indices, error: resolveErrorCopy(event.code, event.message) },
          effects: [{ type: 'haptic', style: 'warning' }],
        };
      }
      return same;
    }
    default:
      return same;
  }
}

export type BannerButtonId =
  | 'stop'
  | 'again'
  | 'folder'
  | 'recheck'
  | 'stopSharing'
  | 'freeSpace'
  | 'move'
  | 'keepTrying'
  | 'remove';

export interface BannerButton {
  id: BannerButtonId;
  label: string;
  variant: 'primary' | 'secondary';
}

export interface HealthBanner {
  tone: 'warning' | 'danger' | 'info';
  title: string;
  buttons: BannerButton[];
}

/** The SM-32 banner for the machine's state, or null when none shows. */
export function fileHealthBanner(state: FileHealthState): HealthBanner | null {
  if (state.kind === 'missing' || (state.kind === 'picking') || (state.kind === 'working' && state.back === 'missing')) {
    const n = state.indices.length;
    return {
      tone: 'warning',
      title: n === 1 ? '1 file was deleted outside Maglev.' : `${n} files were deleted outside Maglev.`,
      buttons: [
        { id: 'stop', label: 'Stop downloading them', variant: 'secondary' },
        { id: 'again', label: 'Download again', variant: 'primary' },
        { id: 'folder', label: 'Pick folder', variant: 'secondary' },
      ],
    };
  }
  if (state.kind === 'changed' || (state.kind === 'working' && state.back === 'changed')) {
    return {
      tone: 'warning',
      title: 'Files were changed after downloading. Recheck before sharing them?',
      buttons: [
        { id: 'recheck', label: 'Recheck', variant: 'primary' },
        { id: 'stopSharing', label: 'Stop sharing', variant: 'secondary' },
      ],
    };
  }
  return null;
}

/** SM-33 and SM-37 banners keyed by health tag. The SM-32 tags have their own machine. */
export function healthBannerFor(tag: string | null | undefined): HealthBanner | null {
  switch (tag) {
    case 'storage_full':
      return {
        tone: 'warning',
        title: 'Storage full.',
        buttons: [
          { id: 'freeSpace', label: 'Free up space', variant: 'primary' },
          { id: 'move', label: 'Move', variant: 'secondary' },
        ],
      };
    case 'storage_unavailable':
      return {
        tone: 'warning',
        title: "The SD card isn't there.",
        buttons: [{ id: 'move', label: 'Move', variant: 'secondary' }],
      };
    case 'no_peers':
      return {
        tone: 'info',
        title: 'No one is sharing this yet',
        buttons: [
          { id: 'keepTrying', label: 'Keep trying', variant: 'primary' },
          { id: 'remove', label: 'Remove', variant: 'secondary' },
        ],
      };
    default:
      return null;
  }
}

/** Short state label for a health tag held in `paused_by`, or undefined for any other value. */
export function healthLabel(tag: string | null | undefined): string | undefined {
  switch (tag) {
    case 'files_missing':
      return 'Files missing';
    case 'files_changed':
      return 'Files changed';
    case 'storage_full':
      return 'Storage full';
    case 'storage_unavailable':
      return 'SD card removed';
    case 'no_peers':
      return 'No one sharing';
    default:
      return undefined;
  }
}

/** "45s", "3m 05s", "1h 02m". */
export function formatElapsed(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** SM-37 line while a magnet looks for its metadata. */
export function resolvingLine(peersSeen: number, secs: number): string {
  return `Looking for peers · ${peersSeen} found · ${formatElapsed(secs)}`;
}
