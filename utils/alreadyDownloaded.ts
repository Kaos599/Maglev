// "You already downloaded this": finds a finished download for the link being added. Pure; plain node can import it.
import type { DownloadSnapshot } from '../modules/maglev-engine/src/MaglevEngine.types.ts';

/** Query parameters that only say where a link was shared from, never which page it is. */
const TRACKING = /^(utm_.*|si|s|t|feature|ref|ref_src|ref_url|fbclid|igsh|igshid|pp)$/i;

/** One key per page: lower-case host without www or m, x.com and twitter.com alike, youtu.be as youtube.com/watch, no tracking. */
export function linkKey(url: string): string {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec((url ?? '').trim());
  if (!m) return '';
  let host = m[1].toLowerCase().replace(/^(www|m|mobile)\./, '');
  let path = m[2] === '/' ? '' : m[2].replace(/\/+$/, '');
  const params = (m[3] ?? '').replace(/^\?/, '').split('&').filter(Boolean);
  if (host === 'twitter.com') host = 'x.com';
  if (host === 'youtu.be') {
    params.unshift(`v=${path.replace(/^\//, '')}`);
    host = 'youtube.com';
    path = '/watch';
  }
  const kept = params.filter((p) => !TRACKING.test(p.split('=')[0])).sort();
  return `${host}${path}${kept.length ? `?${kept.join('&')}` : ''}`;
}

/**
 * The finished download whose page or link is the one being added, or null. A download keeps the page it came from
 * (a video page) or its own link without the query; the second only counts when the link being added has no query either.
 */
export function findFinishedDownload(link: string, downloads: readonly DownloadSnapshot[]): DownloadSnapshot | null {
  const key = linkKey(link);
  if (!key) return null;
  const hasQuery = key.includes('?');
  return (
    downloads.find((d) => {
      if (d.state !== 'finished') return false;
      if (d.pageUrl && linkKey(d.pageUrl) === key) return true;
      return !hasQuery && !d.pageUrl && linkKey(d.urlDisplay) === key;
    }) ?? null
  );
}
