import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

// Opens the quick share card (QuickShareActivity) for a link. Native side: share/MaglevQuickShareModule.kt.

let Native: any = null;
try {
  Native = Platform.OS === 'android' ? requireOptionalNativeModule('MaglevQuickShare') : null;
} catch {
  Native = null;
}

/** True when the card opened. False (module missing, or the launch failed): the caller falls back to its own screen. */
export function openQuickShare(url: string): boolean {
  try {
    return !!Native && Native.open(url) === true;
  } catch {
    return false;
  }
}
