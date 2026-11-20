/**
 * Private browsing, cookie side. Pure logic plus a session object whose pieces come in through `deps`, so tests run it
 * with fakes (no React, no native imports).
 *
 * What it does, and what it cannot do:
 * - While private browsing is on, every host the browser loads (page navigations, found files, downloads the page
 *   starts) is remembered. When the user leaves the browser, the cookies of those hosts are expired through
 *   `clearCookies` and the page cache is emptied. The real host is kept (`www.site.com` is not `site.com`: the cookie
 *   jar returns host-only cookies only for the exact host), and each parent domain is expired too, down to the
 *   registrable domain (never a bare suffix such as `com` or `co.uk`).
 * - Android has ONE cookie jar for the whole app. The Cloudflare site checks of Search live in it
 *   (docs/SEARCH_CONTRACT.md section 8), so nothing here wipes the jar: only hosts that are not Search's are expired.
 * - The list of hosts is also written to kv, so a kill in the middle of a private session is cleaned up at the next
 *   start. Only host names are stored, never page addresses, and the list is deleted after the wipe.
 * - Not covered: localStorage and IndexedDB (Android can only clear those for the whole app, which would also reset
 *   Search's sites; the per-site clear runs inside one open page), cookies of third-party hosts the app never saw a
 *   request for, and cookies set on a deeper path than the page the app saw. The setting's copy says so.
 */

/** A lower-case host (`www.` kept), or '' when `urlOrHost` has none. */
export function hostOf(urlOrHost: string): string {
  const s = (urlOrHost ?? '').trim().toLowerCase();
  if (!s) return '';
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/.exec(s);
  const h = m ? m[1] : /^[a-z0-9.-]+$/.test(s) ? s : '';
  return h.replace(/\.$/, '');
}

/** True when `a` is `b` or a subdomain of it, or the other way round (they can share cookies). */
function related(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

const SLD = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);

/** How many labels the shortest wipeable domain of `labels` has: 2, or 3 under a country pair such as co.uk. */
function minLabels(labels: string[]): number {
  const n = labels.length;
  return n >= 3 && labels[n - 1].length === 2 && SLD.has(labels[n - 2]) ? 3 : 2;
}

/**
 * Hosts whose cookies to expire: each visited host plus its parent domains (a site often sets cookies on its parent
 * domain), minus anything related to a host in `keep` (Search's sources and site checks).
 */
export function hostsToWipe(visited: Iterable<string>, keep: Iterable<string>): string[] {
  const keepHosts = [...keep].map(hostOf).filter(Boolean);
  const out = new Set<string>();
  for (const v of visited) {
    const h = hostOf(v);
    if (!h || /^[\d.]+$/.test(h) || !h.includes('.')) continue; // IPs and single labels have no parents worth expiring
    const labels = h.split('.');
    const min = minLabels(labels);
    for (let i = 0; i <= labels.length - min; i++) {
      const cand = labels.slice(i).join('.');
      if (keepHosts.some((k) => related(cand, k))) continue;
      out.add(cand);
    }
  }
  return [...out];
}

/** The hosts Search relies on: enabled sources (with mirrors), custom mirrors, Torznab servers and passed checks. */
export function searchKeepHosts(input: {
  enabledProviders: Array<{ homepage: string; mirrors: string[] }>;
  mirrorOverrides: string[];
  torznabUrls: string[];
  clearanceHosts: string[];
}): string[] {
  const all = [
    ...input.enabledProviders.flatMap((p) => [p.homepage, ...p.mirrors]),
    ...input.mirrorOverrides,
    ...input.torznabUrls,
    ...input.clearanceHosts,
  ];
  return [...new Set(all.map(hostOf).filter(Boolean))];
}

export const PRIVATE_HOSTS_KEY = 'maglev.browser.privateHosts.v1';

export type PrivateSessionDeps = {
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  /** Expires the cookies of these addresses in the shared jar. */
  clearCookies(urls: string[]): Promise<number>;
  /** Empties the page cache only (never cookies). */
  clearCache(): Promise<void>;
  /** Hosts to leave alone. Read at wipe time so it is current. */
  keepHosts(): string[];
};

export function createPrivateSession(deps: PrivateSessionDeps) {
  let hosts: Set<string> | null = null;

  function load(): Set<string> {
    if (hosts) return hosts;
    hosts = new Set();
    try {
      const raw = deps.kvGet(PRIVATE_HOSTS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) for (const h of arr) if (typeof h === 'string' && h) hosts.add(h);
    } catch {
      // Unreadable: start empty.
    }
    return hosts;
  }

  function save(): void {
    try {
      deps.kvSet(PRIVATE_HOSTS_KEY, JSON.stringify([...load()]));
    } catch {
      // Kept in memory only.
    }
  }

  return {
    /** Remembers the host of a page, file or download address. Only call while private browsing is on. */
    note(urlOrHost: string): void {
      const h = hostOf(urlOrHost);
      if (!h) return;
      const set = load();
      if (set.has(h)) return;
      set.add(h);
      save();
    },
    /** Hosts waiting to be wiped (from this run or one that was killed). */
    pending(): string[] {
      return [...load()];
    },
    /**
     * Expires the cookies of the remembered hosts (minus Search's) and empties the page cache (each step on its own),
     * then deletes the list unless the cookie clear failed.
     * Safe to call at any time; does nothing when the list is empty. Returns how many cookies were removed.
     */
    async wipe(): Promise<number> {
      const set = load();
      if (set.size === 0) return 0;
      const snapshot = [...set];
      const targets = hostsToWipe(snapshot, deps.keepHosts());
      let removed = 0;
      let cookiesOk = true;
      try {
        removed = await deps.clearCookies(targets.map((h) => `https://${h}/`));
      } catch {
        cookiesOk = false;
      }
      try {
        await deps.clearCache();
      } catch {
        // The cache is best effort; it never decides whether the cookie list is kept.
      }
      // A failed cookie clear keeps the list, so the next start tries again.
      if (cookiesOk) {
        for (const h of snapshot) set.delete(h);
        save();
      }
      return removed;
    },
  };
}

export type PrivateSession = ReturnType<typeof createPrivateSession>;
