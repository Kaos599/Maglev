import type { PixelIconName } from '../components/PixelIcon';

/**
 * New-feature highlight after an update (docs/NATIVE_CONTRACT.md section 37.1). Only versions with a headline
 * feature have an entry. Keys are "major.minor".
 */
export interface Highlight {
  title: string;
  body: string;
  icon: PixelIconName;
  /** Where the primary button goes. */
  tryRoute: string;
  tryLabel: string;
}

export const HIGHLIGHTS: Record<string, Highlight> = {
  '0.30': {
    title: 'Subtitles',
    body: "Find and save subtitles for videos you've downloaded, from 21 free sources. No account needed.",
    icon: 'subtitles',
    tryRoute: '/settings/subtitles',
    tryLabel: 'Set up subtitles',
  },
};
