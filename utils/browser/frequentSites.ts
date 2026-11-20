/** Frequent sites for the start page, worked out from history rows. Pure. */
export interface FrequentSite {
  host: string;
  /** Where a tap goes: the site's front page on the scheme of its most visited page. */
  url: string;
  visits: number;
}

interface Row {
  url: string;
  host: string;
  visits: number;
}

const siteOf = (host: string) => (host ?? '').toLowerCase().replace(/^www\./, '');

/** Top `limit` sites by total visits (www and bare host count as one), ignoring sites seen fewer than `minVisits` times. */
export function frequentSites(rows: readonly Row[], limit = 8, minVisits = 2): FrequentSite[] {
  const by = new Map<string, { host: string; visits: number; top: Row }>();
  for (const r of rows) {
    const key = siteOf(r.host);
    if (!key || !/^https?:\/\//i.test(r.url)) continue;
    const cur = by.get(key);
    if (!cur) by.set(key, { host: key, visits: r.visits, top: r });
    else {
      cur.visits += r.visits;
      if (r.visits > cur.top.visits) cur.top = r;
    }
  }
  return [...by.values()]
    .filter((s) => s.visits >= minVisits)
    .sort((a, b) => b.visits - a.visits || a.host.localeCompare(b.host))
    .slice(0, limit)
    .map((s) => {
      const m = /^(https?:\/\/[^/?#]+)/i.exec(s.top.url);
      return { host: s.host, url: `${m ? m[1] : `https://${s.host}`}/`, visits: s.visits };
    });
}
