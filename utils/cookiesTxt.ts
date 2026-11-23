/**
 * Netscape `cookies.txt` & raw cookie header parser, storage, and domain matcher.
 *
 * Enables authenticated scraping and download requests across Meta (Instagram,
 * Facebook, Threads), Reddit, TikTok, Pinterest, and YouTube so login walls,
 * age-gates, and anonymous IP rate-limits (HTTP 403 / 429) can be bypassed.
 */

import { useEffect, useState } from 'react';
import { kvGet, kvSet } from './prefs/kv.ts';

const COOKIES_STORAGE_KEY = 'maglev.social.cookies.v1';

export interface StoredCookie {
  domain: string;
  includeSubdomains: boolean;
  path: string;
  secure: boolean;
  expiry: number;
  name: string;
  value: string;
}

export interface CookieSummary {
  totalCount: number;
  domains: string[];
  platforms: string[];
  rawText: string;
}

const PLATFORM_DOMAIN_LABELS: { label: string; suffixes: string[] }[] = [
  { label: 'Instagram', suffixes: ['instagram.com', 'cdninstagram.com'] },
  { label: 'TikTok', suffixes: ['tiktok.com', 'tiktokv.com', 'tiktokcdn.com'] },
  { label: 'Reddit', suffixes: ['reddit.com', 'redd.it'] },
  { label: 'Facebook', suffixes: ['facebook.com', 'fbcdn.net', 'fb.watch'] },
  { label: 'Threads', suffixes: ['threads.net', 'threads.com'] },
  { label: 'Pinterest', suffixes: ['pinterest.com', 'pinimg.com'] },
  { label: 'YouTube', suffixes: ['youtube.com', 'googlevideo.com', 'google.com'] },
];

type Listener = () => void;
const listeners = new Set<Listener>();
let cachedRaw: string | null = null;
let cachedParsed: StoredCookie[] | null = null;

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // listener errors ignored
    }
  }
}

/**
 * Parses Netscape HTTP Cookie File format (`cookies.txt`), JSON cookie arrays
 * (EditThisCookie / Cookie-Editor format), or `name=value; name2=value2` strings.
 */
export function parseCookiesTxt(input: string, defaultDomain = ''): StoredCookie[] {
  const text = (input ?? '').trim();
  if (!text) return [];

  // 1. JSON array export (Cookie-Editor / EditThisCookie browser extensions)
  if (text.startsWith('[') && text.endsWith(']')) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        const out: StoredCookie[] = [];
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue;
          const name = String(item.name ?? '').trim();
          const value = String(item.value ?? '').trim();
          const rawDomain = String(item.domain ?? defaultDomain).trim().toLowerCase();
          if (!name || !rawDomain) continue;
          const cleanDomain = rawDomain.replace(/^\.+/, '');
          out.push({
            domain: cleanDomain,
            includeSubdomains: rawDomain.startsWith('.') || item.hostOnly === false,
            path: String(item.path ?? '/').trim() || '/',
            secure: Boolean(item.secure),
            expiry: typeof item.expirationDate === 'number' ? Math.floor(item.expirationDate) : 0,
            name,
            value,
          });
        }
        return deduplicateCookies(out);
      }
    } catch {
      // Fall through to line-by-line parser
    }
  }

  const lines = text.split(/\r?\n/);
  const out: StoredCookie[] = [];

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    // Netscape `#HttpOnly_.domain.com\t...` prefix stays active, other `#` comments are skipped.
    if (line.startsWith('#')) {
      if (/^#HttpOnly_/i.test(line)) {
        line = line.replace(/^#HttpOnly_/i, '');
      } else {
        continue;
      }
    }

    // Standard 7-field Netscape tab-separated row (or whitespace-separated when tabs were converted)
    const tabParts = line.includes('\t') ? line.split('\t') : line.split(/\s+/);
    if (tabParts.length >= 7) {
      const rawDomain = tabParts[0].trim().toLowerCase();
      const flag = tabParts[1].trim().toUpperCase() === 'TRUE';
      const path = tabParts[2].trim() || '/';
      const secure = tabParts[3].trim().toUpperCase() === 'TRUE';
      const expiry = Number.parseInt(tabParts[4].trim(), 10) || 0;
      const name = tabParts[5].trim();
      const value = tabParts.slice(6).join('\t').trim();
      const cleanDomain = rawDomain.replace(/^\.+/, '');
      if (cleanDomain && name) {
        out.push({
          domain: cleanDomain,
          includeSubdomains: flag || rawDomain.startsWith('.'),
          path,
          secure,
          expiry,
          name,
          value,
        });
        continue;
      }
    }

    // Fallback: `[domain] name=value; name2=value2` or plain `name=value; name2=value2`
    let targetDomain = defaultDomain.toLowerCase().replace(/^\.+/, '');
    let cookiePart = line;
    const prefixMatch = line.match(/^([a-z0-9.-]+\.[a-z]{2,})\s*:\s*(.+)$/i);
    if (prefixMatch) {
      targetDomain = prefixMatch[1].toLowerCase().replace(/^\.+/, '');
      cookiePart = prefixMatch[2];
    }
    if (cookiePart.includes('=')) {
      const pairs = cookiePart.split(';');
      const inferredDomains = targetDomain
        ? [targetDomain]
        : inferDomainsFromCookieNames(
            pairs.map((p) => p.split('=')[0]?.trim() ?? '').filter(Boolean),
          );
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (!name || /^(path|domain|expires|max-age|secure|httponly|samesite)$/i.test(name)) {
          continue;
        }
        for (const dom of inferredDomains) {
          out.push({
            domain: dom,
            includeSubdomains: true,
            path: '/',
            secure: true,
            expiry: 0,
            name,
            value,
          });
        }
      }
    }
  }

  return deduplicateCookies(out);
}

function inferDomainsFromCookieNames(names: string[]): string[] {
  const lower = new Set(names.map((n) => n.toLowerCase()));
  const domains = new Set<string>();
  if (lower.has('sessionid') || lower.has('ds_user_id') || lower.has('ig_did')) {
    domains.add('instagram.com');
    domains.add('threads.net');
    domains.add('threads.com');
  }
  if (lower.has('c_user') || lower.has('xs') || lower.has('datr')) {
    domains.add('facebook.com');
  }
  if (lower.has('reddit_session') || lower.has('token_v2')) {
    domains.add('reddit.com');
  }
  if (lower.has('sid_tt') || lower.has('sessionid_ss') || lower.has('tt_chain_token')) {
    domains.add('tiktok.com');
  }
  if (lower.has('_pinterest_sess')) {
    domains.add('pinterest.com');
  }
  if (lower.has('sapisid') || lower.has('__secure-3psid') || lower.has('login_info')) {
    domains.add('youtube.com');
  }
  if (domains.size === 0) {
    // Broad default when raw `name=value` is pasted without domain headers
    return [
      'instagram.com',
      'facebook.com',
      'threads.net',
      'threads.com',
      'reddit.com',
      'tiktok.com',
      'pinterest.com',
      'youtube.com',
    ];
  }
  return [...domains];
}

function deduplicateCookies(cookies: StoredCookie[]): StoredCookie[] {
  const map = new Map<string, StoredCookie>();
  for (const c of cookies) {
    const key = `${c.domain}\u0000${c.path}\u0000${c.name}`;
    map.set(key, c);
  }
  return [...map.values()];
}

function getStoredCookies(): StoredCookie[] {
  const raw = kvGet(COOKIES_STORAGE_KEY) ?? '';
  if (raw !== cachedRaw || !cachedParsed) {
    cachedRaw = raw;
    cachedParsed = parseCookiesTxt(raw);
  }
  return cachedParsed;
}

export function importCookiesTxt(text: string): CookieSummary {
  const clean = (text ?? '').trim();
  const parsed = parseCookiesTxt(clean);
  if (parsed.length === 0) {
    return getCookieSummary();
  }
  kvSet(COOKIES_STORAGE_KEY, clean);
  cachedRaw = clean;
  cachedParsed = parsed;
  notify();
  return getCookieSummary();
}

export function clearCookiesTxt(): void {
  kvSet(COOKIES_STORAGE_KEY, '');
  cachedRaw = '';
  cachedParsed = [];
  notify();
}

export function getCookieSummary(): CookieSummary {
  const rawText = kvGet(COOKIES_STORAGE_KEY) ?? '';
  const cookies = getStoredCookies();
  const domainSet = new Set<string>();
  for (const c of cookies) {
    domainSet.add(c.domain);
  }
  const domains = [...domainSet];
  const platforms: string[] = [];
  for (const p of PLATFORM_DOMAIN_LABELS) {
    if (
      domains.some((d) =>
        p.suffixes.some((suf) => d === suf || d.endsWith(`.${suf}`)),
      )
    ) {
      platforms.push(p.label);
    }
  }
  return {
    totalCount: cookies.length,
    domains,
    platforms,
    rawText,
  };
}

function domainMatches(cookieDomain: string, requestHost: string): boolean {
  const cd = cookieDomain.toLowerCase().replace(/^\.+/, '');
  const rh = requestHost.toLowerCase().replace(/^\.+/, '');
  if (!cd || !rh) return false;
  return rh === cd || rh.endsWith(`.${cd}`) || cd.endsWith(`.${rh}`);
}

/**
 * Builds the `Cookie: a=b; c=d` header string for a given target URL from stored `cookies.txt`.
 */
export function getCookieHeaderForUrl(targetUrl: string): string | undefined {
  const cookies = getStoredCookies();
  if (cookies.length === 0) return undefined;
  let host = '';
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!host) return undefined;

  // Match domain (and share Instagram cookies with Threads when appropriate)
  const matched = cookies.filter((c) => {
    if (domainMatches(c.domain, host)) return true;
    if (
      (host.endsWith('threads.net') || host.endsWith('threads.com')) &&
      domainMatches(c.domain, 'instagram.com')
    ) {
      return true;
    }
    return false;
  });
  if (matched.length === 0) return undefined;

  const byName = new Map<string, string>();
  for (const c of matched) {
    byName.set(c.name, c.value);
  }
  const pairs: string[] = [];
  for (const [k, v] of byName.entries()) {
    pairs.push(`${k}=${v}`);
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

/**
 * Builds per-host cookie entries for Rust `DownloadOptions.headers.Cookies`
 * so redirects across CDN and origin hosts preserve authenticated cookies.
 */
export function getHostCookiesForUrl(
  ...urls: (string | undefined)[]
): { host: string; cookie: string }[] {
  const out: { host: string; cookie: string }[] = [];
  const seenHosts = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      const host = new URL(u).hostname.toLowerCase();
      if (!host || seenHosts.has(host)) continue;
      const header = getCookieHeaderForUrl(u);
      if (header) {
        seenHosts.add(host);
        out.push({ host, cookie: header });
      }
    } catch {
      // ignore invalid URL
    }
  }
  return out;
}

export function useCookiesTxt(): {
  summary: CookieSummary;
  importCookies: (text: string) => CookieSummary;
  clearCookies: () => void;
} {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return {
    summary: getCookieSummary(),
    importCookies: importCookiesTxt,
    clearCookies: clearCookiesTxt,
  };
}
