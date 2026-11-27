// Cloudflare challenge detection: a 403 or 503 whose headers or body show Cloudflare is a challenge, anything else
// is a plain block. Pure: no network, no React Native imports. Maglev never solves a challenge itself: the user passes
// it once in a real WebView.

export interface HeaderReader {
  get(name: string): string | null | undefined;
}

const MARKERS = /challenge-platform|cf-chl|<title>\s*just a moment/i;

/**
 * True when the response is a Cloudflare check page: status 403/503 and either
 * the `cf-mitigated: challenge` header, or `server: cloudflare` with an HTML body that carries a challenge marker.
 * A plain 403 (or a 403 from another server) is not a challenge.
 */
export function isCloudflareChallenge(status: number, headers: HeaderReader | null | undefined, body: string): boolean {
  if (status !== 403 && status !== 503) return false;
  const mitigated = (headers?.get('cf-mitigated') ?? '').toLowerCase();
  if (mitigated.includes('challenge')) return true;
  const server = (headers?.get('server') ?? '').toLowerCase();
  const html = /^\s*<(!doctype|html)/i.test(body);
  return server.includes('cloudflare') && html && MARKERS.test(body);
}

/** Host part of a URL, lowercase; '' when the URL does not parse. */
export function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(url.trim());
  return m ? m[1].toLowerCase() : '';
}
