/**
 * Copy for Settings › Browser: the hub, its section screens and the site lists (docs/contracts-0.34/browser.md §5).
 * Kept apart from copy.ts so the browser settings land in one place. Titles are the visible labels the settings
 * search index matches (utils/settingsIndex.ts).
 */
import type { BrowserPrefs, PopupPolicy } from '../utils/prefs/browser';
import type { SearchEngine } from '../utils/browserUrl';

export type HubSection = 'general' | 'startPage' | 'privacy' | 'blocking' | 'media' | 'gestures';

export const searchEngineNames: Record<SearchEngine, string> = {
  duckduckgo: 'DuckDuckGo',
  google: 'Google',
  bing: 'Bing',
  brave: 'Brave',
};

const popupShort: Record<PopupPolicy, string> = { ask: 'Ask', block: 'Block', allow: 'Allow' };

export const browserSettingsCopy = {
  hubTitle: 'Browser',
  sections: {
    general: 'General',
    startPage: 'Start page',
    privacy: 'Privacy and site data',
    blocking: 'Blocking',
    blocklists: 'Block lists',
    media: 'Downloads and media',
    gestures: 'Tabs and gestures',
  },
  general: {
    desktopSite: 'Desktop site by default',
    desktopSiteSubtitle: 'Ask sites for their desktop version by default.',
    engineCaption: 'Used when you type words instead of an address.',
  },
  startPage: {
    showFrequent: 'Show often visited sites',
    showFrequentSubtitle: 'Sites you open most, from your history.',
    showBookmarks: 'Show bookmarks',
    showBookmarksSubtitle: 'Your saved pages, shown as tiles.',
    caption: 'Recent pages still show below the start page when history is saved.',
    allHidden: { title: 'Start page is empty', body: 'Turn a section back on under Start page in Browser settings.' },
  },
  blocking: {
    blocklists: 'Block lists',
    blocklistsSubtitle: 'Where the ad and tracker lists come from, and when they were updated.',
    adSites: 'Sites allowed to show ads',
  },
  blocklists: {
    unavailable: "The block list isn't available in this build.",
    addressesCaption: 'Lists load over https and merge into one. Press Update now to fetch them.',
  },
  media: {
    hideSmall: 'Hide small files in Find videos',
    hideSmallSubtitle: 'Hides video and audio under 1 MB and images under 50 KB in the list of found files.',
    streamQuality: 'Video quality for streams',
    streamQualityCaption: 'Ask lets you pick a quality each time you start a stream.',
    qualities: { best: 'Best', '1080': '1080p', '720': '720p', ask: 'Ask' },
  },
  gestures: {
    swipeTabs: 'Swipe the header to switch tabs',
    swipeTabsSubtitle: 'Swipe left or right on the header to move between tabs, or down to see all tabs.',
    pullToRefresh: 'Pull down to reload',
    pullToRefreshSubtitle: 'Pull down at the top of a page to reload it.',
  },
  sites: {
    search: 'Search sites',
    noMatch: 'No sites match',
    noMatchBody: 'Try another part of the address.',
    popupEmpty: { title: 'No sites allowed', body: 'Sites you let open pop-ups show up here.' },
  },
} as const;

const qualityText: Record<BrowserPrefs['streamQuality'], string> = {
  best: 'Best quality',
  '1080': '1080p at most',
  '720': '720p at most',
  ask: 'Ask for quality',
};

/** The live one-line summaries the hub shows under each section (contract §5, "Hub design"). */
export function hubSummaries(p: BrowserPrefs): Record<HubSection, string> {
  const start = [p.showFrequentSites && 'Often visited sites', p.showBookmarksOnStart && 'Bookmarks'].filter(Boolean);
  return {
    general: `${searchEngineNames[p.searchEngine]} · Text ${p.browserTextZoom}% · ${p.darkPages ? 'Dark pages on' : 'Dark pages off'}`,
    startPage: start.length ? start.join(' · ') : 'Nothing shown',
    privacy: `${p.privateBrowsing ? 'Private browsing on' : 'Private browsing off'} · ${p.saveHistory ? 'History saved' : 'History not saved'}`,
    blocking: `${p.adBlock ? 'Ads blocked' : 'Ads allowed'} · Pop-ups: ${popupShort[p.popupPolicy]}`,
    media: `${p.hideSmallFiles ? 'Hide small files' : 'Show small files'} · ${qualityText[p.streamQuality]}`,
    gestures: `${p.swipeTabs ? 'Swipe header' : 'Swipe off'} · ${p.pullToRefresh ? 'Pull to reload' : 'No pull to reload'}`,
  };
}
