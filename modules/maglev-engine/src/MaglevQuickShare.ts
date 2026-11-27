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

/**
 * The link the share card left for the app, once, or null (nothing waiting, older than ten minutes, web, mock or any
 * error). The card hands a link over this way instead of as the start intent, so a later start from the launcher icon
 * never brings an old share back.
 */
export function takePendingShare(): string | null {
  try {
    const link = Native?.takePendingShare?.();
    return typeof link === 'string' && link.length > 0 ? link : null;
  } catch {
    return null;
  }
}
