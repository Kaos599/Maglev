// Age of a result written out, for result rows. Pure: no React, no IO.
const MIN = 60_000;
const DAY = 86_400_000;

/** Age written out for result rows: "just now", "5 minutes ago", "3 months ago", "1 year ago". Empty when unknown. */
export function formatAgeLong(publishedAt: number | undefined, now = Date.now()): string {
  if (!publishedAt || publishedAt > now + DAY) return '';
  const diff = now - publishedAt;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (diff < 2 * MIN) return 'just now';
  if (diff < 60 * MIN) return unit(Math.round(diff / MIN), 'minute');
  if (diff < DAY) return unit(Math.round(diff / (60 * MIN)), 'hour');
  const days = Math.round(diff / DAY);
  if (days < 30) return unit(days, 'day');
  if (days < 365) return unit(Math.round(days / 30), 'month');
  return unit(Math.round(days / 365), 'year');
}
