// Video sites: retry a refused download with fresh links (docs/NATIVE_CONTRACT.md section 48). Pure helpers; the hook
// in components/transfers/useVideoSiteRefresh.ts does the work. Plain node can import this file.
import type { DownloadSnapshot } from 'maglev-engine';
import { isVideoSiteUrl, type VideoSiteInfo, type VideoSiteOption } from './videoSites.ts';

/** One automatic try per download per hour. */
export const REFRESH_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * What quality a download was saved at, from its name ("Title 1080p.mp4"). An audio file ends in .m4a, or has no
 * height in its name. A video option without a known height (Instagram) is not audio, so only .m4a counts as audio.
 */
export function qualityOfName(name: string): { height: number | null; audioOnly: boolean } {
  const n = (name ?? '').trim();
  const audioOnly = /\.(m4a|aac|mp3|opus|ogg)$/i.test(n);
  const stem = n.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const m = /(?:^|\s)(\d{3,4})p$/.exec(stem);
  return { height: !audioOnly && m ? Number(m[1]) : null, audioOnly };
}

/** The option with the same height (or the audio-only one) as the saved name, or null. */
export function pickSameOption(info: VideoSiteInfo, name: string): VideoSiteOption | null {
  const q = qualityOfName(name);
  if (q.audioOnly) return info.options.find((o) => o.ext === 'm4a' && o.height === null) ?? null;
  if (q.height !== null) return info.options.find((o) => o.height === q.height && o.ext !== 'm4a') ?? null;
  // No height in the name (Instagram): the one video without a height, if the page has exactly one.
  const plain = info.options.filter((o) => o.height === null && o.ext !== 'm4a');
  return plain.length === 1 ? plain[0] : null;
}

/** True for a `needs_link` video-site download whose link was refused or expired, with no try in the last hour. */
export function shouldRefresh(d: DownloadSnapshot, lastTryMs: number | undefined, nowMs: number): boolean {
  if (d.state !== 'needs_link') return false;
  const code = d.error?.code;
  if (code !== 'LINK_REFUSED' && code !== 'LINK_EXPIRED') return false;
  if (!d.pageUrl || !isVideoSiteUrl(d.pageUrl)) return false;
  return lastTryMs === undefined || nowMs - lastTryMs >= REFRESH_COOLDOWN_MS;
}

/** True when the card and sheet should offer "Get a fresh link" instead of "Paste new link". */
export function offersFreshLink(d: DownloadSnapshot): boolean {
  return shouldRefresh(d, undefined, 0);
}
