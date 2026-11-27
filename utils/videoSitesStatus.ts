// What Settings says about the part that reads video pages: the version in use, the last check and its result. The
// native side reads it from the yt-dlp file and the updater's own record, both kept off backups.
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

export type VideoSitesResult = 'updated' | 'current' | 'failed' | 'blocked' | 'rolledBack';

export interface VideoSitesReport {
  /** Version inside the yt-dlp file that runs; null while the copy that came with the app hasn't been unpacked yet. */
  version: string | null;
  /** Epoch ms of the last check that reached GitHub on this phone, or null. */
  lastCheckAt: number | null;
  result: VideoSitesResult | null;
  /** Plain words about the last failure, or null. */
  error: string | null;
  /** True while the copy that came with the app runs (no checked download yet). */
  builtIn: boolean;
}

let Native: { videoSitesReport?: () => Promise<unknown> } | null = null;
try {
  Native = Platform.OS === 'android' ? requireOptionalNativeModule('MaglevEngine') : null;
} catch {
  Native = null;
}

const RESULTS: readonly VideoSitesResult[] = ['updated', 'current', 'failed', 'blocked', 'rolledBack'];

/** Never throws. Null where there is no native module (web, or a build without it). */
export async function getVideoSitesReport(): Promise<VideoSitesReport | null> {
  try {
    if (typeof Native?.videoSitesReport !== 'function') return null;
    const r = (await Native.videoSitesReport()) as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') return null;
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
    return {
      version: str(r.version),
      lastCheckAt: typeof r.lastCheckAt === 'number' && r.lastCheckAt > 0 ? r.lastCheckAt : null,
      result: RESULTS.includes(r.result as VideoSitesResult) ? (r.result as VideoSitesResult) : null,
      error: str(r.error),
      builtIn: r.builtIn === true,
    };
  } catch {
    return null;
  }
}
