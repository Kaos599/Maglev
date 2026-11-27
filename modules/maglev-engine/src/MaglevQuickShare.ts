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
 * The link the share card left for the app, once, or null (nothing waiting, too old, web, mock or any error). [startUp]
 * is true for the take at start-up: it accepts a link up to ten minutes old and tidies old copies. A take while running
 * accepts only a link from the last minute and does no disk work when nothing waits. Maglev's own taps and the card hand
 * a link over this way instead of as the start intent, so a later start from the launcher icon never brings an old
 * share back.
 */
export function takePendingShare(startUp: boolean): string | null {
  try {
    const link = Native?.takePendingShare?.(startUp);
    return typeof link === 'string' && link.length > 0 ? link : null;
  } catch {
    return null;
  }
}

/** Clears the waiting link without reading it or marking it trusted. Nothing to do on web or in the mock. */
export function dropPendingShare(): void {
  try {
    Native?.dropPendingShare?.();
  } catch {
    // Nothing waits that matters: the next take is judged on its own.
  }
}

/** Calls [cb] when the card leaves a link while the app runs. Returns the way to stop. */
export function onShareWaiting(cb: () => void): () => void {
  try {
    const sub = Native?.addListener?.('onShareWaiting', cb);
    return () => {
      try {
        sub?.remove?.();
      } catch {
        // Already gone.
      }
    };
  } catch {
    return () => {};
  }
}
