import { Platform, requireOptionalNativeModule } from 'expo-modules-core';
import type { WatchNotification } from './cycle';
import type { NetworkState } from './logic';

/** Kotlin `MaglevWatchModule` (modules/maglev-engine/android/.../watch). Null on web or an old build. */
interface NativeWatch {
  getNetwork(): NetworkState;
  notify(n: WatchNotification): boolean;
  cancel(watchId: string): void;
}

let native: NativeWatch | null | undefined;
function mod(): NativeWatch | null {
  if (native === undefined) {
    try {
      native = Platform.OS === 'android' ? requireOptionalNativeModule<NativeWatch>('MaglevWatch') : null;
    } catch {
      native = null;
    }
  }
  return native ?? null;
}

/** Unknown network counts as offline: a watch never runs on a link it cannot check. */
export async function watchNetwork(): Promise<NetworkState> {
  try {
    return mod()?.getNetwork() ?? { connected: false, unmetered: false, globalWifiOnly: false };
  } catch {
    return { connected: false, unmetered: false, globalWifiOnly: false };
  }
}

export async function postWatchNotification(n: WatchNotification): Promise<boolean> {
  try {
    return mod()?.notify(n) === true;
  } catch {
    return false;
  }
}

export function cancelWatchNotification(watchId: string): void {
  try {
    mod()?.cancel(watchId);
  } catch {
    // Nothing to cancel.
  }
}
