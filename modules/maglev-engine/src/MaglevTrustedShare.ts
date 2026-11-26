import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

// Asks Android whether the quick share card just handed the app this exact link. Only Maglev's own code can set it,
// so it tells a real share apart from a maglev://add-download link that a web page or app opened.

let Native: any = null;
try {
  Native = Platform.OS === 'android' ? requireOptionalNativeModule('MaglevEngine') : null;
} catch {
  Native = null;
}

/** True once for a link the share card just recorded (within about a minute). False on web, mock or any error. */
export async function consumeTrustedShare(url: string): Promise<boolean> {
  try {
    if (typeof Native?.consumeTrustedShare !== 'function') return false;
    return (await Native.consumeTrustedShare(url)) === true;
  } catch {
    return false;
  }
}
