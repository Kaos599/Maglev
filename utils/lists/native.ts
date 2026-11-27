// The daily background ad list job lives in Kotlin (WorkManager) and runs with Maglev closed, so it can't read the
// app's settings. This hands it the on/off switch and the list addresses.
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

let Native: { listsConfigure?: (enabled: boolean, urls: string[]) => Promise<unknown> } | null = null;
try {
  Native = Platform.OS === 'android' ? requireOptionalNativeModule('MaglevEngine') : null;
} catch {
  Native = null;
}

/** Schedules (on) or cancels (off) the daily job. Never throws; the next app start sends it again. */
export async function configureListWork(enabled: boolean, urls: readonly string[]): Promise<void> {
  try {
    if (typeof Native?.listsConfigure === 'function') await Native.listsConfigure(enabled, [...urls]);
  } catch {
    // Applied again at the next start or change.
  }
}
