/**
 * Tracker address rules (NATIVE_CONTRACT 15). The same rules run in Rust (`native/maglev-core/src/trackers.rs`),
 * in the mock engine and in the Add tracker sheet, so a bad line is caught before it is sent and the three agree.
 */

export const MAX_TRACKERS_PER_CALL = 100;
const MAX_URL_LEN = 2048;

function splitUrl(s: string): { scheme: string; authority: string; tail: string } | null {
  const at = s.indexOf('://');
  if (at < 0) return null;
  const rest = s.slice(at + 3);
  const end = rest.search(/[/?#]/);
  const cut = end < 0 ? rest.length : end;
  return { scheme: s.slice(0, at).toLowerCase(), authority: rest.slice(0, cut).toLowerCase(), tail: rest.slice(cut) };
}

function stripDefaultPort(scheme: string, authority: string): string {
  const def = scheme === 'http' ? ':80' : scheme === 'https' ? ':443' : null;
  if (def && authority.endsWith(def) && authority.length > def.length) return authority.slice(0, -def.length);
  return authority;
}

/** Form two addresses are compared in: lower case scheme and host, no default port, "/" for an empty path, no fragment. */
export function trackerKey(url: string): string {
  const t = url.trim();
  const p = splitUrl(t);
  if (!p) return t;
  const tail = p.tail.split('#')[0] || '/';
  return `${p.scheme}://${stripDefaultPort(p.scheme, p.authority)}${tail}`;
}

export type TrackerUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/** Checks one announce URL (http, https or udp) and returns its canonical form, or a short reason. */
export function validateTrackerUrl(raw: string): TrackerUrlCheck {
  const t = raw.trim();
  const bad = (reason: string): TrackerUrlCheck => ({ ok: false, reason });
  if (!t) return bad('it is empty');
  if (t.length > MAX_URL_LEN) return bad('it is too long');
  if (/[\s\u0000-\u001f\u007f]/.test(t)) return bad('it has spaces in it');
  const p = splitUrl(t);
  if (!p) return bad('it must start with http://, https:// or udp://');
  if (p.scheme !== 'http' && p.scheme !== 'https' && p.scheme !== 'udp') {
    return bad('only http://, https:// and udp:// trackers work');
  }
  const a = p.authority;
  if (!a) return bad('it has no host name');
  if (a.includes('@')) return bad('it must not contain a user name or password');
  let host: string;
  let port: string | null;
  if (a.startsWith('[')) {
    const close = a.indexOf(']');
    if (close < 0) return bad('its IPv6 address is not closed with ]');
    host = a.slice(1, close);
    if (!/^[0-9a-f:.]*$/.test(host)) return bad('its IPv6 address is not valid');
    const after = a.slice(close + 1);
    if (after === '') port = null;
    else if (after.startsWith(':')) port = after.slice(1);
    else return bad('its port is not valid');
  } else {
    const colon = a.lastIndexOf(':');
    host = colon < 0 ? a : a.slice(0, colon);
    port = colon < 0 ? null : a.slice(colon + 1);
    if (!host) return bad('it has no host name');
    if (!/^[a-z0-9._-]+$/.test(host)) return bad('its host name is not valid');
  }
  if (!host) return bad('it has no host name');
  if (port !== null) {
    const n = /^\d+$/.test(port) ? Number(port) : NaN;
    if (!(n > 0 && n <= 65535)) return bad('its port is not valid');
  } else if (p.scheme === 'udp') {
    return bad('a udp:// tracker needs a port');
  }
  return { ok: true, url: trackerKey(t) };
}

export type TrackerListCheck = { ok: true; urls: string[] } | { ok: false; message: string };

/** Checks a list of lines. Blank lines are ignored and repeats are dropped. One bad line fails the whole list. */
export function checkTrackerLines(lines: readonly string[]): TrackerListCheck {
  const urls: string[] = [];
  const seen = new Set<string>();
  let count = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    count += 1;
    if (count > MAX_TRACKERS_PER_CALL) return { ok: false, message: `Add up to ${MAX_TRACKERS_PER_CALL} trackers at a time` };
    const r = validateTrackerUrl(line);
    if (!r.ok) {
      const shown = Array.from(line).slice(0, 60).join('');
      return { ok: false, message: `"${shown}" isn't a tracker address: ${r.reason}` };
    }
    const key = trackerKey(r.url);
    if (!seen.has(key)) {
      seen.add(key);
      urls.push(r.url);
    }
  }
  if (urls.length === 0) return { ok: false, message: 'Enter at least one tracker address' };
  return { ok: true, urls };
}

/** Pasted text: one address per line (any whitespace also separates, since an address has none). */
export function checkTrackerText(text: string): TrackerListCheck {
  return checkTrackerLines(text.split(/\s+/));
}
