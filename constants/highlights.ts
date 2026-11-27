import type { PixelIconName } from '../components/PixelIcon';

/**
 * New-feature highlight after an update. Only versions with a headline
 * feature have an entry. Keys are "major.minor".
 */
export interface Highlight {
  title: string;
  body: string;
  icon: PixelIconName;
  /** Where the primary button goes. */
  tryRoute: string;
  tryLabel: string;
  /** Shows the Experimental tag under the title. */
  experimental?: boolean;
  /** One muted line after the body text. */
  note?: string;
}

export const HIGHLIGHTS: Record<string, Highlight> = {
  '0.30': {
    title: 'Subtitles',
    body: "Find and save subtitles for videos you've downloaded, from free sources. No account needed.",
    icon: 'subtitles',
    tryRoute: '/settings/subtitles',
    tryLabel: 'Set up subtitles',
  },
  '1.0': {
    title: 'Download almost any link',
    body: 'Share or paste a YouTube, X or Instagram link and pick a quality. Files, magnets and torrents work as before.',
    icon: 'link',
    tryRoute: '/add-torrent',
    tryLabel: 'Try a link',
    experimental: true,
    note: 'Video links are new and some sites may fail. If one does, tell us with Report a bug in Settings › About.',
  },
};
