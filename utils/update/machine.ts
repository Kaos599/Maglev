/**
 * State machine U1 (docs/NATIVE_CONTRACT.md section 27.8). Pure: `reduce(state, event)` returns the next state, and an
 * event that does not apply to the current state returns the same state. No ad-hoc states anywhere else.
 *
 *   Idle -> Checking -> UpToDate | Available(info) | CheckFailed
 *   Available -> (ask) Waiting | (download/auto, Wi-Fi) Downloading | (mobile data) WaitingForWifi -> Downloading
 *   Downloading -> Ready(path) | DownloadFailed(code) -> Available
 *   Ready -> (auto, safe) Installing | (else) ReadyAsk -> Installing (tap)
 *   Installing -> NeedsPermission -> Installing (returned) | NeedsUser | Done | InstallFailed
 *   Available | Ready -> Skipped(version)
 *   Any -> Managed
 */
import type { ManagedBy } from 'maglev-engine';
import type { UpdateInfo } from './check.ts';

export type UpdateMode = 'ask' | 'download' | 'auto';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate' }
  | { kind: 'checkFailed' }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'waiting'; info: UpdateInfo }
  | { kind: 'waitingForWifi'; info: UpdateInfo }
  | { kind: 'downloading'; info: UpdateInfo; bytes: number; total: number }
  | { kind: 'downloadFailed'; info: UpdateInfo; code: string }
  | { kind: 'ready'; info: UpdateInfo; path: string }
  | { kind: 'readyAsk'; info: UpdateInfo; path: string }
  | { kind: 'installing'; info: UpdateInfo; path: string; silent: boolean; retried: boolean }
  | { kind: 'needsPermission'; info: UpdateInfo; path: string; retried: boolean }
  | { kind: 'needsUser'; info: UpdateInfo; path: string }
  | { kind: 'done'; info: UpdateInfo }
  | { kind: 'installFailed'; info: UpdateInfo; path: string; code: string }
  | { kind: 'skipped'; version: string }
  | { kind: 'managed'; by: ManagedBy };

export type UpdateEvent =
  | { type: 'managed'; by: ManagedBy }
  | { type: 'check' }
  /** At startup: an update downloaded in an earlier run is still on disk. */
  | { type: 'restore'; info: UpdateInfo; path: string }
  | { type: 'checked'; info: UpdateInfo | null; skippedVersion: string | null; manual: boolean }
  | { type: 'checkFailed' }
  /** After an automatic check found a version: route it by mode and network. */
  | { type: 'route'; mode: UpdateMode; unmetered: boolean }
  /** The user tapped Download (or Retry). */
  | { type: 'download' }
  /** Wi-Fi came back while waiting. */
  | { type: 'wifi' }
  | { type: 'progress'; bytes: number; total: number }
  | { type: 'downloaded'; path: string }
  | { type: 'downloadFailed'; code: string }
  /** DownloadFailed returns to Available. */
  | { type: 'dismissFailure' }
  | { type: 'readyRoute'; mode: UpdateMode; safe: boolean }
  /** The user tapped Install, or Maglev installs on its own after readyRoute. */
  | { type: 'install' }
  | { type: 'installStatus'; status: 'started' | 'needs_permission' | 'needs_user' }
  | { type: 'permissionReturned' }
  | { type: 'installed' }
  | { type: 'installFailed'; code: string }
  | { type: 'skip' };

export const initialState: UpdateState = { kind: 'idle' };

function infoOf(s: UpdateState): UpdateInfo | null {
  return 'info' in s ? s.info : null;
}

export function reduce(s: UpdateState, e: UpdateEvent): UpdateState {
  // Any -> Managed, and Managed is final.
  if (e.type === 'managed') return { kind: 'managed', by: e.by };
  if (s.kind === 'managed') return s;

  switch (e.type) {
    case 'check':
      return s.kind === 'idle' || s.kind === 'upToDate' || s.kind === 'checkFailed' || s.kind === 'skipped' || s.kind === 'done'
        ? { kind: 'checking' }
        : s;
    case 'restore':
      return s.kind === 'idle' ? { kind: 'ready', info: e.info, path: e.path } : s;
    case 'checked':
      if (s.kind !== 'checking') return s;
      if (!e.info) return { kind: 'upToDate' };
      if (!e.manual && e.skippedVersion === e.info.version) return { kind: 'skipped', version: e.info.version };
      return { kind: 'available', info: e.info };
    case 'checkFailed':
      return s.kind === 'checking' ? { kind: 'checkFailed' } : s;
    case 'route':
      if (s.kind !== 'available') return s;
      if (e.mode === 'ask') return { kind: 'waiting', info: s.info };
      return e.unmetered ? { kind: 'downloading', info: s.info, bytes: 0, total: s.info.size } : { kind: 'waitingForWifi', info: s.info };
    case 'download':
      return s.kind === 'available' || s.kind === 'waiting' || s.kind === 'waitingForWifi' || s.kind === 'downloadFailed'
        ? { kind: 'downloading', info: s.info, bytes: 0, total: s.info.size }
        : s;
    case 'wifi':
      return s.kind === 'waitingForWifi' ? { kind: 'downloading', info: s.info, bytes: 0, total: s.info.size } : s;
    case 'progress':
      return s.kind === 'downloading' ? { ...s, bytes: e.bytes, total: e.total > 0 ? e.total : s.total } : s;
    case 'downloaded':
      return s.kind === 'downloading' ? { kind: 'ready', info: s.info, path: e.path } : s;
    case 'downloadFailed':
      return s.kind === 'downloading' ? { kind: 'downloadFailed', info: s.info, code: e.code } : s;
    case 'dismissFailure':
      return s.kind === 'downloadFailed' ? { kind: 'available', info: s.info } : s;
    case 'readyRoute':
      // From readyAsk too: an automatic install that waited for a safe moment tries again.
      if (s.kind !== 'ready' && s.kind !== 'readyAsk') return s;
      return e.mode === 'auto' && e.safe
        ? { kind: 'installing', info: s.info, path: s.path, silent: true, retried: false }
        : { kind: 'readyAsk', info: s.info, path: s.path };
    case 'install':
      if (s.kind === 'ready' || s.kind === 'readyAsk' || s.kind === 'installFailed' || s.kind === 'needsUser') {
        return { kind: 'installing', info: s.info, path: s.path, silent: false, retried: false };
      }
      // A tap on the permission card re-sends the install once the user is back; see permissionReturned.
      return s;
    case 'installStatus':
      if (s.kind !== 'installing') return s;
      if (e.status === 'needs_permission') return { kind: 'needsPermission', info: s.info, path: s.path, retried: s.retried };
      if (e.status === 'needs_user') return { kind: 'needsUser', info: s.info, path: s.path };
      return s;
    case 'permissionReturned':
      // Back from the "Install unknown apps" screen: the install retries once.
      return s.kind === 'needsPermission' && !s.retried
        ? { kind: 'installing', info: s.info, path: s.path, silent: false, retried: true }
        : s;
    case 'installed':
      return s.kind === 'installing' || s.kind === 'needsUser' ? { kind: 'done', info: s.info } : s;
    case 'installFailed':
      return s.kind === 'installing' || s.kind === 'needsUser' ? { kind: 'installFailed', info: s.info, path: s.path, code: e.code } : s;
    case 'skip': {
      const info = infoOf(s);
      return info && (s.kind === 'available' || s.kind === 'waiting' || s.kind === 'waitingForWifi' || s.kind === 'ready' || s.kind === 'readyAsk')
        ? { kind: 'skipped', version: info.version }
        : s;
    }
    default:
      return s;
  }
}

/** The 24 h gate for the automatic check (27.2). */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function autoCheckDue(args: { now: number; lastCheckAt: number | null; autoCheck: boolean; managedBy: ManagedBy | null }): boolean {
  if (!args.autoCheck || args.managedBy !== null) return false;
  return args.lastCheckAt === null || args.lastCheckAt > args.now || args.now - args.lastCheckAt >= CHECK_INTERVAL_MS;
}
