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
    magnetInClipboard: { title: 'Magnet link in clipboard' },
    torrentLinkInClipboard: { title: 'Torrent link in clipboard' },
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
    none: { title: 'No transfers yet', body: 'Paste a magnet link, open a .torrent file or tap one in your browser.' },
    noMatch: { title: 'No matching transfers', body: 'Try a different search.' },
    noneInFilter: (filter: string | number) => ({
      title: `No ${toName(filter).toLowerCase()} transfers`,
      body: 'Pick another filter to see more.',
    }),
  },
  search: {
    unavailable: { title: 'Search is unavailable right now', body: 'Check your connection and try again.' },
    noSource: { title: 'No source covers this category', body: 'Turn on a source that searches it.' },
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
    waitingForNetwork: { title: 'Waiting for a network' },
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

/** Labels on the browser's stream sheet. Not linted as notices; they are short field names. */
export const streamSheet = {
  title: 'Video stream',
  reading: 'Reading the stream',
  quality: 'Quality',
  audio: 'Audio',
  name: 'Name',
} as const;
