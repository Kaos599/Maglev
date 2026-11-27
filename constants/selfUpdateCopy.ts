// Words for the parts that update themselves with no app update: the video page reader (yt-dlp) and the ad block
// list. Settings already names yt-dlp in its version line, so these may too; the add screen never does.

export const videoSitesCopy = {
  /** "yt-dlp 2026.11.23 · checked 2 h ago". */
  readerLine: (version: string | null, checked: string | null) =>
    `yt-dlp ${version ?? 'built in'} · ${checked ? `checked ${checked}` : 'not checked yet'}`,
  /** Under the reader line while the copy that came with the app still runs. */
  builtIn: 'Still the version that came with the app, which sites refuse. It updates on Wi-Fi, or tap Check now.',
  results: {
    blocked: 'Your network settings block this download right now.',
    rolledBack: "The newest version didn't run on this phone, so Maglev kept the one that works. It tries again when a newer one is out.",
    failed: (why: string | null) => (why ? `The last check didn't finish: ${why}` : "The last check didn't finish. Maglev tries again later."),
  },
  notices: {
    updated: (version: string | null) => `Updated yt-dlp to ${version ?? 'the newest version'}`,
    current: (version: string | null) => `yt-dlp is up to date${version ? ` (${version})` : ''}`,
    rolledBack: "The newest yt-dlp didn't run on this phone, so Maglev kept the one that works.",
    blocked: 'Your network settings block this download right now.',
    failed: "Couldn't update yt-dlp. Check your connection.",
  },
  /** The add screen, after a read failed on the copy that came with the app. */
  add: {
    updateNow: 'Update now',
    updateFailed: "Couldn't update video support. Check your connection and try again.",
  },
} as const;

export const adListTimeCopy = {
  /** A list saved by an older Maglev whose download time can't be known. The next update writes it. */
  unknown: (domains: number | string) => `${domains} domains · update time unknown`,
} as const;
