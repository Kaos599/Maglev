/** Copy and pure helpers for the "Download the copied link?" prompt on Transfers. */
export const clipboardCopy = {
  title: 'Download the copied link?',
  download: 'Download',
  notNow: 'Not now',
  torrentFallback: 'Torrent from your clipboard',
  settingTitle: 'Offer to download copied links',
  settingSubtitle: 'Asks when you open Maglev with a link copied. Android shows a notice when it reads it.',
} as const;

const MAGNET = /^magnet:/i;
const TORRENT_LINK = /\.torrent(\?|#|$)/i;

/** What to show under the title: a magnet's name, a link's file name, or its host. Never an info-hash. */
export function clipboardLabel(link: string): string {
  const t = link.trim();
  if (MAGNET.test(t)) {
    const m = /[?&]dn=([^&]+)/i.exec(t);
    if (m) {
      try {
        const name = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
        if (name) return name;
      } catch {
        // fall through
      }
    }
    return clipboardCopy.torrentFallback;
  }
  try {
    const u = new URL(t);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    let file = '';
    try {
      file = decodeURIComponent(last);
    } catch {
      file = last;
    }
    if (/\.[A-Za-z0-9]{1,8}$/.test(file)) return file;
    return u.host.replace(/^www\./, '');
  } catch {
    return clipboardCopy.torrentFallback;
  }
}

export type ClipboardRoute =
  | { pathname: '/add-torrent'; params: { source: string } }
  | { pathname: '/add-download'; params: { url: string } };

/** Magnets and .torrent links go to the torrent flow, any other web link to the link download flow. */
export function clipboardRoute(link: string): ClipboardRoute {
  const t = link.trim();
  if (MAGNET.test(t) || TORRENT_LINK.test(t)) return { pathname: '/add-torrent', params: { source: t } };
  return { pathname: '/add-download', params: { url: t } };
}

/** Plain web file links open the quick share card. Magnets and .torrent links keep going to Add torrent. */
export function clipboardUsesCard(link: string): boolean {
  const t = link.trim();
  return !MAGNET.test(t) && !TORRENT_LINK.test(t) && /^https?:\/\//i.test(t);
}
