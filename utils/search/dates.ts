// Date helpers for HTML sources that show relative ages ("8 days ago", "1 year, 8 months") or
// "11 Nov 2026 18:04:58". Pure and Hermes-safe: no Date.parse on free-form strings.

const UNIT_MS: Record<string, number> = {
  second: 1e3,
  sec: 1e3,
  minute: 60e3,
  min: 60e3,
  hour: 3600e3,
  day: 86_400e3,
  week: 7 * 86_400e3,
  month: 30 * 86_400e3,
  year: 365 * 86_400e3,
};

/**
 * "8 days ago", "10 months ago", "Yesterday", "Today", "1 Year+", "6 months, 2 weeks" -> epoch ms.
 * Approximate by nature (a month is 30 days). Returns undefined when nothing is recognised.
 */
export function parseRelative(s: string | undefined | null, now = Date.now()): number | undefined {
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  if (!t) return undefined;
  if (t === 'today' || t === 'just now' || t === 'now') return now;
  if (t === 'yesterday') return now - 86_400e3;
  if (t === 'last week') return now - UNIT_MS.week;
  if (t === 'last month') return now - UNIT_MS.month;
  if (t === 'last year') return now - UNIT_MS.year;
  let total = 0;
  let found = false;
  const re = /(\d+)\s*(second|sec|minute|min|hour|day|week|month|year)s?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    total += parseInt(m[1], 10) * UNIT_MS[m[2]];
    found = true;
  }
  return found ? now - total : undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "11 Nov 2026 18:04:58" or "11 Nov 2026" or "11 November 2026" -> epoch ms (UTC). */
export function parseDayMonthYear(s: string | undefined | null): number | undefined {
  if (!s) return undefined;
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return undefined;
  const year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
  return Date.UTC(year, month, parseInt(m[1], 10), m[4] ? parseInt(m[4], 10) : 0, m[5] ? parseInt(m[5], 10) : 0, m[6] ? parseInt(m[6], 10) : 0);
}

/** "2026-04-23" or "2026-04-23 17:01:02" (optionally with a "T") -> epoch ms (UTC). */
export function parseIsoLike(s: string | undefined | null): number | undefined {
  if (!s) return undefined;
  const m = /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return undefined;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
}
