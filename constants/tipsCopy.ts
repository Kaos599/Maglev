/**
 * Settings › Tips.
 * `focus` is the settings search id of the row to scroll to and highlight (utils/settingsIndex.ts, the same
 * mechanism a search result uses). A card whose feature is only on the video-sites branch carries `needs`.
 */
import type { PixelIconName } from '../components/PixelIcon';

export type TipTopicId = 'yours' | 'links' | 'browser' | 'finding' | 'subtitles' | 'downloads' | 'data' | 'phone';

export interface TipTopic {
  id: TipTopicId;
  name: string;
  icon: PixelIconName;
}

export interface TipAction {
  /** The button text. */
  label: string;
  /** Screen the button opens, or (with `steps`) the screen the steps sheet offers at its end. */
  route?: string;
  /** Settings search id of the row to scroll to on that screen. */
  focus?: string;
  /** Numbered steps shown in a sheet. A card with steps gets the outlined button. */
  steps?: string[];
  /** Label of the sheet's own button when a card has both steps and a route. */
  routeLabel?: string;
}

export interface Tip {
  id: string;
  topic: TipTopicId;
  title: string;
  body: string;
  where: string;
  action: TipAction;
  icon: PixelIconName;
  /** Hidden unless this feature exists in the build. */
  needs?: 'videoSites';
}

export const tipsCopy = {
  title: 'Tips',
  rowValue: (count: number) => `${count} short tips, by topic`,
  topicsTitle: 'Topics',
  steps: 'Steps',
  pickTopic: 'Pick another topic',
  prev: 'Previous tip',
  next: 'Next tip',
  done: 'Done',
  whereLabel: 'Where it lives',
  tipCount: (n: number) => (n === 1 ? '1 tip' : `${n} tips`),
  position: (i: number, n: number) => `${i} / ${n}`,
  endTitle: (topic: string) => `That's all for ${topic}`,
  endBody: (n: number, topic: string) => `Next up: ${n === 1 ? '1 tip' : `${n} tips`} on ${topic}.`,
  endNext: (topic: string) => `Next: ${topic}`,
  topicLabel: (name: string, n: number) => `Topic: ${name}, ${n === 1 ? '1 tip' : `${n} tips`}. Change topic`,
} as const;

export const TIP_TOPICS: readonly TipTopic[] = [
  { id: 'yours', name: 'Make it yours', icon: 'interface' },
  { id: 'links', name: 'Getting links in', icon: 'link' },
  { id: 'browser', name: 'Browser', icon: 'network' },
  { id: 'finding', name: 'Finding things', icon: 'search' },
  { id: 'subtitles', name: 'Subtitles', icon: 'subtitles' },
  { id: 'downloads', name: 'Downloads', icon: 'download' },
  { id: 'data', name: 'Data and battery', icon: 'bandwidth' },
  { id: 'phone', name: 'Around the phone', icon: 'bell' },
];

export const TIPS: readonly Tip[] = [
  // Make it yours
  { id: 'font', topic: 'yours', icon: 'text-size', title: 'Pick a font style', body: 'Clean, Retro or Mono. Retro gives Maglev a pixel look.', where: 'Settings › Appearance › Font', action: { label: 'Change font', route: '/settings/interface', focus: 'appearance-font' } },
  { id: 'accent', topic: 'yours', icon: 'interface', title: 'Choose an accent colour', body: "Eight colours. Maglev's buttons and highlights take the one you pick.", where: 'Settings › Appearance › Accent', action: { label: 'Change accent', route: '/settings/interface', focus: 'appearance-accent' } },
  { id: 'app-icon', topic: 'yours', icon: 'file-app', title: 'Change the app icon', body: 'Pick another train for your home screen. It changes when you leave Maglev.', where: 'Settings › Appearance › App icon', action: { label: 'Change app icon', route: '/settings/interface', focus: 'appearance-app-icon' } },
  { id: 'mode', topic: 'yours', icon: 'moon', title: 'Choose light, dark or system', body: 'System follows your phone. OLED and Dim keep Maglev dark.', where: 'Settings › Appearance › Mode', action: { label: 'Change mode', route: '/settings/interface', focus: 'appearance-mode' } },
  { id: 'tabs', topic: 'yours', icon: 'grid', title: 'Choose your tabs', body: 'Show the tabs you use, hide the rest, and drag them into your order.', where: 'Settings › Appearance › Tabs', action: { label: 'Change tabs', route: '/settings/interface', focus: 'appearance-tabs' } },
  { id: 'density', topic: 'yours', icon: 'card-text', title: 'Compact or detailed', body: 'Compact shows speed and time left. Detailed adds amounts, connections and timing.', where: 'Settings › Appearance › Download page', action: { label: 'Change download page', route: '/settings/interface', focus: 'appearance-transfer-details' } },

  // Getting links in
  { id: 'share', topic: 'links', icon: 'share', title: 'Share a link to Maglev', body: 'In any app, tap Share and pick Maglev. A small card opens over the app, so you stay where you were.', where: 'Any app › Share › Maglev', action: { label: 'Show me how', steps: ['In any app, open the link and tap Share.', 'Pick Maglev in the share sheet.', 'Tap Download. You stay in that app.'] } },
  { id: 'text-menu', topic: 'links', icon: 'copy', title: 'Download with Maglev', body: 'Select a link anywhere. "Download with Maglev" is in the text menu, sometimes under ⋮.', where: 'Any app › select a link › text menu', action: { label: 'Show me how', steps: ['Touch and hold a link to select it.', 'Tap Download with Maglev. If you don\'t see it, tap ⋮ first.', 'Tap Download in the sheet that opens.'] } },
  { id: 'clipboard', topic: 'links', icon: 'clipboard', title: 'Copy a link, Maglev offers it', body: 'Copy a link in any app, then open Maglev. One tap downloads it. Android shows a notice when it reads the link.', where: 'Settings › Adding and finishing › Offer to download copied links', action: { label: 'Change clipboard setting', route: '/settings/downloads', focus: 'storage-offer-links' } },
  { id: 'magnets', topic: 'links', icon: 'magnet', title: 'Magnets and .torrent files', body: 'Tap a magnet link or a .torrent file in another app. Maglev opens Add torrent, where you pick files and tap Add.', where: 'Any app › tap a magnet or .torrent link', action: { label: 'Show me how', steps: ['Tap a magnet link on a web page.', 'Choose Maglev if your phone asks which app.', 'Check the files and tap Add.'] } },
  { id: 'video-sites', topic: 'links', icon: 'link', needs: 'videoSites', title: 'Download videos from YouTube, X, Instagram and more', body: 'Paste a link to a video page, or share it to Maglev. Maglev reads the video and lets you pick its quality. Experimental: some sites may fail.', where: 'Transfers › Add', action: { label: 'Add a link', route: '/add-torrent' } },
  { id: 'firefox', topic: 'links', icon: 'external', title: "Maglev in Firefox's download list", body: 'In Firefox, Maglev shows in the list of download apps for a file. Pick it to download there.', where: 'Firefox › a download link › the app list', action: { label: 'Show me how', steps: ['In Firefox, tap a file link.', 'Pick Maglev in the list that opens.'] } },

  // Browser
  { id: 'browser', topic: 'browser', icon: 'network', title: 'Maglev has a browser', body: 'Open a page and Maglev lists the videos and files on it.', where: 'The Browser tab', action: { label: 'Open the browser', route: '/browse' } },
  { id: 'long-press', topic: 'browser', icon: 'file-video', title: 'Long-press a video', body: 'On any page, long-press a video to download it or its stream.', where: 'Browser › any page with a video', action: { label: 'Show me how', steps: ['On a page, touch and hold the video.', 'Tap Download video.'] } },
  { id: 'header-swipe', topic: 'browser', icon: 'forward', title: 'Swipe the header to switch tabs', body: 'Swipe left or right on the header to change tabs. Swipe down to see them all.', where: 'Browser › swipe the header', action: { label: 'Show me how', steps: ['Swipe the header to the right for the previous tab.', 'Swipe left for the next one.', 'Swipe down to see all your tabs.'] } },
  { id: 'private', topic: 'browser', icon: 'lock', title: 'Private browsing', body: 'Keeps no history or open tabs. Cookies and cached pages from sites you visit are cleared when you leave. Site storage and third-party cookies can stay.', where: 'Settings › Browser › Privacy and site data', action: { label: 'Turn it on', route: '/settings/browser-privacy', focus: 'browser-private-browsing' } },
  { id: 'bookmarks', topic: 'browser', icon: 'bookmark', title: 'Bookmarks', body: 'Save a page from the page menu. Bookmarks show on the start page and when you type an address.', where: 'Browser › ⋮ page menu › Bookmark', action: { label: 'Open bookmarks', route: '/browser-bookmarks' } },
  { id: 'dark-pages', topic: 'browser', icon: 'sun', title: 'Dark pages', body: 'Darkens pages that only have a light look, while Maglev is dark.', where: 'Settings › Browser › General › Dark pages', action: { label: 'Open dark pages setting', route: '/settings/browser-general', focus: 'browser-dark-pages' } },
  { id: 'ad-blocking', topic: 'browser', icon: 'shield', title: 'Ads blocked, your call', body: 'Ads and trackers are blocked. Let the sites you want to support show ads.', where: 'Settings › Browser › Blocking', action: { label: 'Open ad blocking', route: '/settings/browser-blocking', focus: 'browser-ad-blocking' } },
  { id: 'popups', topic: 'browser', icon: 'warning', title: 'Block pop-ups, site by site', body: 'Pop-ups from a site ask first. Block a site, or allow it once, from the pop-up card. Undo for five seconds.', where: 'Browser › padlock or ⋮ page menu › Site settings', action: { label: 'Open Blocking', route: '/settings/browser-blocking', focus: 'browser-popups-ask' } },
  { id: 'pull-reload', topic: 'browser', icon: 'retry', title: 'Pull down to reload', body: 'Pull down at the top of a page to reload it.', where: 'Browser › top of any page', action: { label: 'Show me how', steps: ['Open a page in the Browser.', 'Pull down from the top of the page.', 'Let go to reload it.'] } },
  { id: 'third-party-cookies', topic: 'browser', icon: 'shield', title: 'Block cookies from other sites', body: 'Stops other sites from following you across pages.', where: 'Settings › Browser › Privacy and site data', action: { label: 'Open privacy settings', route: '/settings/browser-privacy', focus: 'browser-block-cookies' } },
  { id: 'https-first', topic: 'browser', icon: 'lock', title: 'Try https first', body: 'Opens the secure version of a site when there is one.', where: 'Settings › Browser › Advanced', action: { label: 'Open advanced browser settings', route: '/settings/browser-advanced', focus: 'browser-https-first' } },

  // Finding things
  { id: 'search', topic: 'finding', icon: 'search', title: 'Search many sources at once', body: 'The Search tab asks many torrent sources together and sorts what they find. Adult sources stay hidden until you turn them on.', where: 'The Search tab', action: { label: 'Open Search', route: '/search' } },
  { id: 'watch', topic: 'finding', icon: 'alarm', title: 'Watch for a title', body: 'Watch a search and Maglev checks in the background. It tells you when a new copy shows up.', where: 'Search › Watch. Saved: Settings › Watches', action: { label: 'Open Watches', route: '/settings/watch' } },
  { id: 'feeds', topic: 'finding', icon: 'feeds', title: 'New episodes on their own', body: 'Add a feed and a rule, and new episodes download by themselves.', where: 'The Feeds tab', action: { label: 'Open Feeds', route: '/feeds' } },
  { id: 'share-magnet', topic: 'finding', icon: 'share', title: 'Share without adding', body: 'Tap a search result, then Share or Copy to pass on its magnet link.', where: 'Search › tap a result', action: { label: 'Open Search', route: '/search' } },
  { id: 'jackett', topic: 'finding', icon: 'link', title: 'Bring Jackett or Prowlarr', body: 'Already run Jackett or Prowlarr? Connect it and its results join Search.', where: 'Settings › Search sources', action: { label: 'Connect one', route: '/settings/search-providers', focus: 'search-jackett' } },

  // Subtitles
  { id: 'subtitles', topic: 'subtitles', icon: 'subtitles', title: 'Subtitles in one tap', body: 'Find subtitles from 21 sources, 2 on to start. No account needed. Maglev can also look as soon as a video finishes.', where: 'Settings › Subtitles', action: { label: 'Open Subtitles', route: '/settings/subtitles', focus: 'subtitles-sources' } },
  { id: 'season', topic: 'subtitles', icon: 'subtitles', title: 'A whole season at once', body: 'One row per episode. "Use the best match" saves them all in one tap.', where: 'Transfers › open the season › Subtitles', action: { label: 'Show me how', steps: ['Open the season in Transfers.', 'Tap Subtitles.', 'Tap Use the best match for all.'] } },

  // Downloads
  { id: 'swipe-row', topic: 'downloads', icon: 'forward', title: 'Swipe a download', body: 'Swipe right to pause or resume, left to remove it from the list. Files are kept.', where: 'Settings › Appearance › Swipe to pause or remove', action: { label: 'Show me how', steps: ['Swipe a download to the right to pause or resume it.', 'Swipe to the left to take it off the list.'], route: '/settings/interface', focus: 'appearance-swipe-actions', routeLabel: 'Open Appearance' } },
  { id: 'limit-one', topic: 'downloads', icon: 'speed-limit', title: 'Limit one download', body: 'Give one download its own speed limit, from its page.', where: 'Transfers › open a download › ⋮ › Speed limit', action: { label: 'Open Transfers', route: '/' } },
  { id: 'files', topic: 'downloads', icon: 'file', title: 'Pick files in a torrent', body: 'Download only the files you want, and choose which come first.', where: 'Transfers › open a torrent › Files', action: { label: 'Open Transfers', route: '/' } },
  { id: 'play', topic: 'downloads', icon: 'play', title: 'Play while it downloads', body: 'Start watching a video before the download finishes. Works for torrents with a video or audio file.', where: 'Transfers › open a torrent › Play', action: { label: 'Open Transfers', route: '/' } },
  { id: 'parts', topic: 'downloads', icon: 'pieces', title: 'Faster links in parts', body: 'Links download in several parts at once. Choose how many.', where: 'Settings › Adding and finishing › Parts per download', action: { label: 'Change parts', route: '/settings/downloads', focus: 'speed-parts' } },
  { id: 'retry', topic: 'downloads', icon: 'retry', title: 'Retry on its own', body: 'A download that fails on a bad connection or a busy server tries again by itself, with a pause between tries.', where: 'Settings › Adding and finishing › Retry failed downloads', action: { label: 'Change retry', route: '/settings/downloads', focus: 'speed-retry' } },
  { id: 'move', topic: 'downloads', icon: 'move', title: 'Move a finished download', body: "Move a torrent's files to another folder.", where: 'Transfers › open a torrent › ⋮ › Move to…', action: { label: 'Open Transfers', route: '/' } },
  { id: 'fresh-link', topic: 'downloads', icon: 'retry', needs: 'videoSites', title: 'Get a fresh link', body: 'When a site refuses a video link, Maglev reads the page again and gets a fresh one. Experimental: some sites may fail.', where: 'Transfers › the download marked "Video sites need an update" or "Link expired"', action: { label: 'Open Transfers', route: '/' } },

  // Data and battery
  { id: 'wifi-only', topic: 'data', icon: 'wifi', title: 'Wi-Fi only', body: 'Downloads pause on mobile data. Or name the Wi-Fi networks Maglev may use.', where: 'Settings › Network › Wi-Fi only', action: { label: 'Open Network', route: '/settings/network', focus: 'network-wifi-only' } },
  { id: 'night', topic: 'data', icon: 'schedule', title: 'Download at night', body: 'Set your hours, and downloads pause outside them. A night preset is 01:00 to 07:00.', where: 'Settings › Scheduling › Only download at night', action: { label: 'Open Scheduling', route: '/settings/scheduling', focus: 'scheduling-night' } },
  { id: 'battery', topic: 'data', icon: 'power', title: 'Save battery', body: 'Download only while plugged in, or pause when the battery runs low.', where: 'Settings › Power', action: { label: 'Open Power', route: '/settings/power', focus: 'power-charging-only' } },
  { id: 'vpn', topic: 'data', icon: 'lock', title: 'Only over a VPN', body: 'Downloads wait until a VPN is connected.', where: 'Settings › Network › Only download over a VPN', action: { label: 'Open Network', route: '/settings/network', focus: 'network-vpn-only' } },

  // Around the phone
  { id: 'quick-tile', topic: 'phone', icon: 'settings', title: 'Quick settings tile', body: "Pause or resume every download from your phone's quick settings.", where: "Your phone's quick settings › Maglev tile", action: { label: 'Show me how', steps: ['Swipe down from the top of the screen to open quick settings.', 'Open the tile editor (usually a pencil or Edit button).', 'Drag the Maglev tile into the active tiles.'] } },
  { id: 'status-bar', topic: 'phone', icon: 'bell', title: 'Progress in the status bar', body: 'See how a download is going without opening Maglev.', where: 'Settings › Notifications › Live progress in status bar', action: { label: 'Open Notifications', route: '/settings/notifications', focus: 'notifications-progress' } },
  { id: 'stats', topic: 'phone', icon: 'grid', title: 'Your downloads as a city', body: 'Stats draws a pixel city from what you downloaded. Each building is a day in a week or month, or a week in the year view.', where: 'Settings › App › Stats', action: { label: 'Open Stats', route: '/stats' } },
  { id: 'backup', topic: 'phone', icon: 'upload', title: 'Back up your settings', body: 'Settings, bookmarks, lists and feeds in one file. Downloaded files and browsing history are not included.', where: 'Settings › Backup and restore › Export backup', action: { label: 'Open Backup', route: '/settings/backup', focus: 'backup-export' } },
  { id: 'assistant', topic: 'phone', icon: 'assistant', title: 'Ask the Assistant', body: 'It can search for a torrent and add it for you. Experimental, and off until you turn it on.', where: 'Settings › Assistant', action: { label: 'Open Assistant', route: '/settings/assistant', focus: 'assistant-enable' } },
];
