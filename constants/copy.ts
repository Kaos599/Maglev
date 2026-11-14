import { formatBytes } from './format.ts';

/**
 * One voice for notices, banners and empty states. Every string a notice, banner or empty state
 * shows lives here, grouped by screen, so scripts/test-copy-voice.js can lint them all.
 * (Native error messages, assistant output and the assistant system prompt are out of scope.)
 *
 * Voice
 *   - Plain, calm, second person. Sentence case. No "!", "Successfully", "Oops", "Uh oh",
 *     "Error:", emoji, ALL CAPS words (acronyms such as VPN, URL, RSS are fine) or ellipses.
 *   - Contractions: "Couldn't", "Can't". Never "Could not", "Cannot", "Please", or a sentence that starts "Unable to" or "Failed to".
 *
 * Notices (toasts)
 *   - Say what happened in the past tense, or what is true now. At most 12 words. Ends with a period.
 *   - An error names the cause in plain words. When the user can do something, the notice carries an
 *     action (Undo, Retry, Open settings), matching AGENTS.md section 4.7 and components/detail/errorActions.ts.
 *     Do not repeat that mapping here.
 *
 * Banners
 *   - A title of at most 8 words with no period, then an optional body of at most 16 words that ends
 *     with a period. At most one action.
 *
 * Empty states
 *   - A title saying what is empty: at most 5 words, no period.
 *   - One line saying how to fill it: at most 16 words, ends with a period.
 *   - At most one primary action. The same structure on every screen.
 *   - A body that comes from the engine at run time (an error message) is passed in by the screen.
 *
 * Glossary: the same word for the same thing everywhere.
 *   - transfer: any item in the Transfers list. The tab, filters and bulk actions say "transfers".
 *   - torrent: an item added from a magnet link or a .torrent file ("Add torrent", the torrent screen).
 *   - download: an item added from a web link ("Add download"), and the act of downloading.
 *   - magnet link: never "magnet URL". folder: never "directory" or "path".
 *   - source: a place Search looks in. Never "provider" or "indexer" on screen.
 *   Known outliers left alone because they come from outside this file: native error messages
 *   ("already in your list") and the assistant ("Already in your downloads").
 */

export const glossary = {
  transfer: { use: 'transfer', avoid: [/\byour list\b/i, /\bqueue item\b/i] },
  torrent: { use: 'torrent', avoid: [/\btorrent url\b/i] },
  magnet: { use: 'magnet link', avoid: [/\bmagnet url\b/i] },
  folder: { use: 'folder', avoid: [/\bdirectory\b/i, /\bfile path\b/i] },
  source: { use: 'source', avoid: [/\bprovider\b/i, /\bindexer\b/i] },
} as const;

/** Words that may be written in capitals. */
export const ACRONYMS = ['VPN', 'URL', 'RSS', 'SD', 'DHT', 'IP', 'ID', 'USB', 'UI', 'OK', 'API', 'VLC', 'HTTP', 'HTTPS', 'UPnP'] as const;

/** Capitalised words that may appear mid-sentence. */
export const PROPER_WORDS = ['Maglev', 'Android', 'Transfers', 'Wi-Fi', 'Atom', 'Settings', 'Search', 'Feeds', 'Undo', 'Retry'] as const;

const toName = (s: string | number) => String(s);

// ---------------------------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------------------------
export const notices = {
  /** Used by more than one screen. */
  common: {
    retryFailed: "Couldn't try again.",
  },
  /** Inline errors set by a screen and shown in a banner or sheet. */
  inline: {
    notTorrentFile: "That isn't a .torrent file.",
    openFileFailed: "Couldn't open that file.",
    clipboardEmpty: 'Your clipboard is empty.',
    startDownloadFailed: "Couldn't start this download.",
    folderPickerFailed: "Couldn't open the folder picker. Try again.",
    storageRefused: 'Storage access was refused. Files are saved in app storage instead.',
    readFileFailed: "Couldn't read that file. Pick another one.",
    removeTorrentFailed: "Couldn't remove this torrent. Try again.",
    shareFailed: "Couldn't share. Try again.",
    resumeFailed: "Couldn't resume the torrent.",
    streamFailed: "Couldn't start the stream.",
    noPlayer: 'No video player found. Install VLC or another player.',
    readInfoFailed: "Couldn't read torrent info.",
    apiKeyFailed: "Couldn't save the API key on this device. Try again.",
  },
  /** context/EngineContext.tsx */
  engine: {
    removed: (name: string | number) => `Removed ${toName(name)}.`,
    removedMany: (count: string | number) => `Removed ${toName(count)} transfers.`,
    removeFailed: (name: string | number) => `Couldn't remove ${toName(name)}. Try again.`,
    removeFailedMany: (count: string | number) => `Couldn't remove ${toName(count)} transfers. Try again.`,
    pauseFailed: (label: string | number) => `Couldn't pause ${toName(label)}. Try again.`,
    resumeFailed: (label: string | number) => `Couldn't resume ${toName(label)}. Try again.`,
    pauseAllFailed: "Couldn't pause all. Try again.",
    resumeAllFailed: "Couldn't resume all. Try again.",
    downloadActionFailed: (verb: string | number) => `Couldn't ${toName(verb)}. Try again.`,
  },
  /** Multi-select actions on Transfers. */
  bulk: {
    someFailed: (done: string | number, failed: string | number, verb: string | number) =>
      `${toName(verb)} ${toName(done)}. Couldn't finish ${toName(failed)}.`,
    allFailed: (failed: string | number, verb: string | number) => `Couldn't ${toName(verb)} ${toName(failed)}.`,
  },
  browser: {
    popup: 'Blocked a pop-up.',
    scheme: 'Blocked a link that opens another app.',
    permission: 'Blocked a request for your camera, mic or location.',
    drm: "This video is protected. Maglev can't save it.",
    blob: "This player streams in a way Maglev can't save.",
    linkCopied: 'Link copied.',
    linkCopyFailed: "Couldn't copy the link.",
    addedToTransfers: 'Added to Transfers.',
    adsAllowed: (site: string | number) => `Ads allowed on ${toName(site)}.`,
    adsBlocked: (site: string | number) => `Blocking ads on ${toName(site)}.`,
    listUpdated: (domains: string | number) => `Block list updated. ${toName(domains)} domains.`,
    listReset: 'Back to the built-in list.',
    listAddressAdded: 'List address added.',
    dataCleared: 'Browsing data cleared.',
    dataClearFailed: "Couldn't clear browsing data.",
    /** Block list update errors, keyed by the native error code. */
    listError: {
      NETWORK: "Couldn't reach the list. Check your connection.",
      HTTP_STATUS: 'The list server returned an error.',
      LIST_TOO_LARGE: 'That list is too big.',
      LIST_INVALID: "That list doesn't look like a block list.",
      BLOCKED: 'Blocked by your network settings.',
      INVALID_ARGUMENT: "That list address isn't valid.",
      OTHER: "Couldn't update the list.",
    },
  },
  addDownload: {
    duplicate: 'This link is already in Transfers.',
  },
  addTorrent: {
    addedWaiting: 'Added. You can choose files once its details arrive.',
    addFailed: 'Something went wrong. Try again.',
  },
  detail: {
    keepOneFile: 'Keep at least one file.',
    priorityFailed: "Couldn't change the file priority.",
    lookingForPeers: 'Looking for more peers.',
    retryIn: (seconds: string | number) => `Try again in ${toName(seconds)} s.`,
    peersFailed: "Couldn't ask for more peers.",
    magnetCopied: 'Magnet link copied.',
    magnetCopyFailed: "Couldn't copy the magnet link.",
    magnetShareFailed: "Couldn't share the magnet link.",
    torrentSaveFailed: "Couldn't save the .torrent file.",
    limitFailed: "Couldn't change the speed limit.",
    moving: 'Moving files.',
    checking: 'Checking files.',
    openFolderFailed: "Couldn't open the folder.",
    stateFailed: "Couldn't change the torrent state.",
    resumedToStream: 'Resumed to stream.',
  },
} as const;

// ---------------------------------------------------------------------------------------------
// Banners (inline notices with a title, an optional body and at most one action)
// ---------------------------------------------------------------------------------------------
export const banners = {
  settings: {
    notificationsOff: { title: 'Notifications are off', body: 'Downloads may stop in the background.' },
    batteryRestricted: { title: 'Android may stop downloads to save battery' },
    legacyStorageDenied: { title: 'Storage access denied', body: 'Files are saved in app storage instead.' },
  },
  storage: {
    folderAccessLost: { title: 'Folder access lost', body: 'Maglev can no longer write to your chosen folder.' },
    appStorageFallback: { title: 'Files are saved in app storage', body: "The download folder isn't available right now." },
  },
  browser: {
    installer: { title: 'This is an app installer', body: 'Only download it if you trust the site.' },
    sslRefused: { title: "Couldn't open this page securely", body: "The site's certificate isn't trusted, so Maglev stopped." },
    localRefused: { title: 'Blocked a device on your network', body: "Pages can't send you there. Type the address yourself if you trust it." },
    streamProtected: { title: 'This video is protected' },
    streamLive: { title: 'This is a live stream' },
    streamUnsupported: { title: "Maglev can't save this kind of stream" },
    streamFailed: { title: "Couldn't read this stream" },
  },
  addDownload: {
    notEnoughSpace: { title: 'Not enough space', body: 'Free up some storage, then try again.' },
  },
  addTorrent: {
    addFailed: { title: "Couldn't add this torrent" },
  },
  feeds: {
    loadFailed: (name: string | number) => ({ title: `Couldn't load ${toName(name)}` }),
  },
  transfers: {
    magnetInClipboard: { title: 'Add the magnet you copied?' },
    torrentLinkInClipboard: { title: 'Add the torrent link you copied?' },
    linkInClipboard: { title: 'Add the link you copied?' },
  },
  detail: {
    updatesPaused: { title: 'Updates paused' },
    torrentProblem: { title: 'This torrent has a problem' },
    deleteFailed: { title: "Couldn't delete" },
    removeFailed: { title: "Couldn't remove" },
    shareFailed: { title: "Couldn't share" },
    actionFailed: { title: "Couldn't do that" },
    moveFailed: { title: "Couldn't move" },
  },
  sources: {
    unsafe: { title: 'Unsafe source' },
  },
} as const;

// ---------------------------------------------------------------------------------------------
// Empty states: a title (what is empty) and a body (how to fill it)
// ---------------------------------------------------------------------------------------------
export const empty = {
  transfers: {
    none: { title: 'Nothing downloading', body: 'Add a link or a .torrent file, or find something.' },
    noMatch: { title: 'No matching transfers', body: 'Try a different search.' },
    noneInFilter: (filter: string | number) => ({
      title: `No ${toName(filter).toLowerCase()} transfers`,
      body: 'Pick another filter to see more.',
    }),
  },
  search: {
    unavailable: { title: 'Search is unavailable right now', body: 'Check your connection and try again.' },
    noSource: { title: 'No source covers this category', body: 'Turn on a source that searches it.' },
    idle: (sources: number | string) => ({
      title: `Search ${toName(sources)} ${Number(sources) === 1 ? 'source' : 'sources'} at once`,
      body: 'Tap the box to see your recent searches.',
    }),
    noAnswer: { title: 'No source answered', body: 'Check your connection or try other sources.' },
    noResults: (query: string | number) => ({
      title: 'No results',
      body: `Nothing matches "${toName(query)}". Try fewer words or another category.`,
    }),
  },
  feeds: {
    none: { title: 'No feeds yet', body: 'Follow an RSS or Atom feed to see new torrents here.' },
    nothingNew: { title: 'Nothing new yet', body: 'Pull down to check for new releases.' },
  },
  addTorrent: {
    noFiles: { title: 'No files listed', body: 'This torrent has no files to choose from.' },
    duplicate: { title: 'Already in Transfers', body: 'This torrent is already added.' },
    timedOut: { title: "Couldn't find torrent info" },
    timedOutMagnet: 'No peers answered in time. Retry, or add it anyway and Maglev keeps looking.',
    timedOutFile: 'No peers answered in time.',
    readFailed: { title: "Couldn't read this torrent" },
  },
  addDownload: {
    waitingForNetwork: { title: 'Waiting for Wi-Fi' },
    deviceOnNetwork: { title: 'A device on your network' },
    badLink: { title: "Couldn't use this link" },
  },
  detail: {
    notFound: { title: 'Torrent not found', body: 'It may have been removed.' },
    loadFailed: { title: "Couldn't load this torrent" },
    noFiles: { title: 'No files yet', body: 'File info appears once the torrent has its metadata.' },
    peersUnavailable: (connected: string | number) => ({
      title: "Peer details aren't available yet",
      body: `${toName(connected)} connected. The list fills in shortly.`,
    }),
    noPeers: { title: 'No peers connected', body: 'Peers show up while the torrent is running.' },
    noTrackers: { title: 'No trackers', body: 'Peers can still be found without one. Add a tracker to look for more.' },
  },
  browser: {
    start: { title: 'Nothing open yet', body: 'Type an address or search for something above.' },
    crashed: { title: 'This page stopped working', body: 'Reload to try it again.' },
    noFiles: { title: 'No files found yet', body: 'Play a video or open a page with files. Maglev lists what it finds here.' },
    noAllowedSites: { title: 'No sites allowed', body: 'Sites you allow ads on show up here.' },
  },
  engineError: {
    title: 'Engine failed to start',
  },
} as const;

/** Labels on the browser's found-files list. Short field names, not notices. */
export const foundTray = {
  title: 'Files',
  count: (n: string | number) => `${n} found on this page`,
  clear: 'Clear',
  clearLabel: 'Clear the list of found files',
  remove: (name: string | number) => `Remove ${name} from the list`,
  hideSmall: 'Hide small files',
  hidden: (n: string | number) => `${n} hidden`,
  showHidden: (n: string | number) => `Show ${n} hidden small files`,
  hideAgain: 'Hide small files again',
} as const;

/** Labels on the browser's stream sheet. Not linted as notices; they are short field names. */
export const streamSheet = {
  title: 'Video stream',
  reading: 'Reading the stream',
  quality: 'Quality',
  audio: 'Audio',
  name: 'Name',
} as const;

// ---------------------------------------------------------------------------------------------
// Onboarding: what each step says. Plain, concrete, no hype.
// ---------------------------------------------------------------------------------------------
export const onboarding = {
  welcome: {
    title: 'Maglev',
    body: 'Torrents, web links and videos in one place.',
    detail: 'Search many sources at once, find videos in the browser, and follow feeds for new releases.',
  },
  notifications: {
    title: 'Know when it is done',
    body: 'Maglev tells you when a download finishes, and shows progress while it runs in the background.',
  },
  folder: {
    title: 'Download folder',
    body: 'Finished files are saved here. You can change it later in Settings.',
  },
  background: {
    title: 'Keep running',
    body: 'Android may stop downloads to save battery. Allow Maglev to keep running?',
  },
  mobileData: {
    title: 'Download on mobile data?',
    body: 'Large downloads can use a lot of your data plan.',
  },
};
/** The + button's menu (components/add/AddMenuSheet.tsx). */
export const addMenu = {
  title: 'Add',
  magnet: 'Magnet link',
  copyFirst: 'Copy a link first',
  typeHint: 'Enter a web link or magnet link',
  fileHint: 'Pick one from your phone',
  searchHint: 'Look in your sources',
  browseHint: 'Find a file or video on a web page',
} as const;

// ---------------------------------------------------------------------------------------------
// Mobile data note on the add screens (one quiet line; the size is formatted at run time)
// ---------------------------------------------------------------------------------------------
/**
 * The one line the add screens show under the size. Null when there is nothing to say: not on mobile data,
 * or on mobile data with Wi-Fi only off and no known size. With Wi-Fi only on the download waits, so the
 * size doesn't matter.
 */
export function mobileDataLine(onMetered: boolean, wifiOnly: boolean, sizeBytes: number | null): string | null {
  if (!onMetered) return null;
  if (wifiOnly) return 'This waits for Wi-Fi.';
  if (sizeBytes == null || !(sizeBytes > 0)) return null;
  return `You're on mobile data. This is ${formatBytes(sizeBytes)}.`;
}
/**
 * Settings > Interface > Font. Each description is linted by scripts/test-copy-voice.js like a
 * banner body: at most 16 words, ends with a period. The sample is a made-up file shown in each style.
 */
export const fontStyleCopy = {
  label: 'Font',
  hint: 'Applies as soon as you pick it.',
  sampleName: 'Big Buck Bunny 1080p',
  sampleSize: '691 MB',
  options: [
    { value: 'clean', title: 'Clean', description: 'Easy to read. Inter for titles, names and numbers.' },
    { value: 'retro', title: 'Retro', description: 'Pixel titles and fixed-width numbers, like an old terminal.' },
    { value: 'mono', title: 'Mono', description: 'Fixed-width titles, names and numbers. Labels and text stay easy to read.' },
  ],
} as const;

/** Settings > Interface > Tabs. */
export const tabsCopy = {
  label: 'Tabs',
  hint: 'Choose which tabs show and their order. Applies as soon as you change it.',
  reorderHint: 'Hold a tab and drag to reorder.',
  alwaysShown: 'Always shown',
  assistantNote: 'Turn the Assistant on in Settings to add its tab here.',
  names: {
    index: 'Transfers',
    search: 'Search',
    feeds: 'Feeds',
    assistant: 'Assistant',
    browse: 'Browser',
    settings: 'Settings',
  },
} as const;

/** Settings > Appearance > App icon. The hint is linted like a banner body: at most 16 words, ends with a period. */
export const appIconCopy = {
  label: 'App icon',
  hint: 'Changes when you leave Maglev. Your home screen may take a moment to update.',
  /** "Teal app icon, selected" */
  a11y: (name: string, selected: boolean) => `${name} app icon${selected ? ', selected' : ''}`,
} as const;

/** The screen shown when a screen crashes, and the crash log row in Settings > About. */
export const errorScreenCopy = {
  title: 'Something went wrong',
  body: 'Maglev hit a problem on this screen. Reload to try again.',
  reload: 'Reload',
  copy: 'Copy crash report',
  copied: 'Report copied',
  copyFailed: 'Couldn\'t copy the report',
  about: {
    title: 'Crash report',
    subtitle: 'Saved on this phone only. Nothing is sent.',
    clear: 'Clear crash log',
  },
} as const;

// ---------------------------------------------------------------------------------------------
// play (0.19: Play while downloading; docs/contracts-0.19/play-and-storage.md section 1)
// ---------------------------------------------------------------------------------------------
export const playCopy = {
  label: 'Play',
  a11y: (name: string) => `Play ${name}`,
  needsResume: 'Resume the download first.',
  storageFull: 'Phone storage is full. Free up space to keep downloading.',
  noFile: "There's nothing to play in this torrent yet.",
  failed: "Couldn't start playing.",
  resumedToPlay: 'Resumed so it can play.',
} as const;

// ---------------------------------------------------------------------------------------------
// storage (0.19: low-storage protection and the Free up space screen; same contract, sections 2 and 3)
// ---------------------------------------------------------------------------------------------
export const storageCopy = {
  /** Same words as the notification: StorageGuard.PAUSED_TITLE / PAUSED_TEXT. */
  pausedTitle: 'Paused: phone storage is almost full',
  freeUp: 'Free up space',
  screenTitle: 'Free up space',
  freeLabel: 'Free now',
  reserveLabel: 'Kept free for your phone',
  unknown: '—',
  listTitle: 'Finished downloads, largest first',
  emptyTitle: 'Nothing finished to remove',
  emptyBody: 'Finished torrents and downloads show up here, largest first.',
  removeAction: 'Remove and delete files',
  removeSelected: (n: number) => `Remove and delete ${n} ${n === 1 ? 'item' : 'items'}`,
  confirmTitle: 'Delete files from your phone?',
  confirmBody: (count: number, size: string) =>
    `This removes ${count} ${count === 1 ? 'item' : 'items'} and deletes ${size} from your phone. There is no undo.`,
  removed: (count: number) => `Removed ${count} ${count === 1 ? 'item' : 'items'}.`,
  removeFailed: "Couldn't remove everything. Try again.",
  selectNone: 'Select none',
  selectAll: 'Select all',
} as const;

// ---- backup (Settings > Backup and restore) ----
export const backupCopy = {
  title: 'Backup and restore',
  export: { title: 'Export backup', subtitle: 'Save your settings and lists to one file.' },
  restore: { title: 'Restore from backup', subtitle: 'Pick a backup file from this phone.' },
  last: (when: string) => `Last backup ${when}`,
  never: 'No backup yet',
  secrets: 'Passwords, API keys and tokens are never saved in a backup.',
  notIncluded: 'Downloaded files, chat history and the crash log are not included.',
  exportDone: (name: string) => `Saved ${name}`,
  exportFailed: "Couldn't save the backup",
  readFailed: "Couldn't read that file",
  previewTitle: 'Restore this backup',
  partsHeader: 'What to restore',
  parts: {
    settings: 'Settings',
    search: 'Search sources',
    feeds: 'Feeds and rules',
    schedule: 'Schedule',
    assistant: 'Assistant',
    torrents: 'Torrents',
    downloads: 'Downloads',
  },
  torrentsNote: 'Torrents and downloads are added paused. Files are not in the backup, so Maglev checks the saved folder first.',
  settingsConfirm: {
    title: 'Replace your settings?',
    body: 'The settings in this backup replace the ones on this phone.',
    action: 'Replace and restore',
  },
  restoreAction: 'Restore',
  restoring: 'Restoring',
  doneTitle: 'Restore finished',
  added: (n: number) => `${n} added`,
  skipped: (n: number) => `${n} already here, skipped`,
  failed: (n: number) => `${n} couldn't be added`,
  defaultFolder: (n: number) => `${n} saved to the default folder, because the old folder isn't on this phone`,
  restartNote: 'Some changes show after you restart Maglev.',
  startAll: 'Start all',
  started: (n: number) => `Started ${n}`,
  done: 'Done',
} as const;

// region quick share
/** The card that floats over the app you shared from (docs/contracts-0.19/quick-share.md). Mirrored in share/QuickShareText.kt; scripts/test-quick-share.js keeps them equal. */
export const quickShareCopy = {
  setting: {
    title: 'Add without asking',
    subtitle: 'Shared magnets, torrent files and file links start at once. Web pages still show the card.',
  },
  gettingDetails: 'Getting details…',
  magnetName: 'Magnet link',
  torrentName: 'Torrent file',
  adding: 'Adding…',
  sizeUnknown: 'Size unknown',
  savesTo: 'Saves to',
  download: 'Download',
  downloadAnyway: 'Download anyway',
  openInMaglev: 'Open in Maglev',
  freeUpSpace: 'Free up space',
  findVideos: 'Find videos on this page',
  close: 'Close',
  webPage: 'This is a web page, not a file',
  noLink: 'No link in what you shared',
  alreadyIn: 'Already in Maglev',
  added: 'Added to Maglev',
  addedServiceLater: 'Added to Maglev. It starts when you open the app.',
  couldNotAdd: "Couldn't add that. Try again.",
  engineFailed: "Maglev couldn't start. Open the app and try again.",
} as const;
// endregion quick share

// region watch
/** Watch for a title (docs/contracts-0.19/watch.md). Screens: Settings > Watches, the Watch button on Search. */
export const watchCopy = {
  title: 'Watches',
  rowTitle: 'Watches',
  rowValue: (n: number) => (n === 0 ? 'None' : n === 1 ? '1 title' : `${n} titles`),
  intro: 'Maglev checks for new copies of a title in the background and tells you when one shows up.',
  empty: 'You are not watching anything yet. Search for a title and tap Watch.',
  watchButton: 'Watch',
  watchHint: 'Watch this search',
  watching: (q: string) => `Watching "${q}"`,
  watchingBody: 'You will get a notification when a new copy shows up. Change it in Settings, Watches.',
  capNotice: 'You can watch up to 20 titles. Delete one first.',
  alreadyNotice: 'You are already watching that.',
  mobileData: 'Use mobile data',
  mobileDataHint: 'Off means Wi-Fi only.',
  pause: 'Pause',
  resume: 'Resume',
  paused: 'Paused',
  delete: 'Delete',
  deleteTitle: 'Delete this watch?',
  deleteBody: 'You will stop getting notifications for it.',
  lastNew: (name: string) => `Last new: ${name}`,
  noneNew: 'Nothing new yet',
  every: 'Check every',
  backgroundNote: 'Android decides the exact time, so a check can come later than you chose. It does not run after you force-stop Maglev, until you open it again.',
} as const;
// endregion watch
