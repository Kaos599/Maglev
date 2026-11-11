// Small helpers shared by the games, books and regional providers.

import { decodeEntities } from '../text.ts';
import { infoHashFromMagnet } from '../magnet.ts';

const RU_MONTHS: Record<string, number> = {
  янв: 0, фев: 1, мар: 2, апр: 3, май: 4, мая: 4, июн: 5, июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11,
};
const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

/** "13 Дек 25" (Rutor, MegaPeer; spaces may be nbsp) -> epoch ms UTC. */
export function parseRuDate(s: string | undefined): number | undefined {
  const m = /(\d{1,2})\s+([А-Яа-яЁё]{3})[А-Яа-яЁё]*\.?\s+(\d{2,4})/.exec((s ?? '').replace(/ /g, ' '));
  if (!m) return undefined;
  const month = RU_MONTHS[m[2].toLowerCase()];
  if (month === undefined) return undefined;
  return Date.UTC(fullYear(parseInt(m[3], 10)), month, parseInt(m[1], 10));
}

/** "11 Nov 2026" (AudioBookBay) -> epoch ms UTC. */
export function parseEnDate(s: string | undefined): number | undefined {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/.exec(s ?? '');
  if (!m) return undefined;
  const month = EN_MONTHS.indexOf(m[2].toLowerCase());
  return month < 0 ? undefined : Date.UTC(parseInt(m[3], 10), month, parseInt(m[1], 10));
}

/** "30/08/2018" (Torrent9) -> epoch ms UTC. A 1970 date is the site's "unknown". */
export function parseDmy(s: string | undefined): number | undefined {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s ?? '');
  if (!m) return undefined;
  const year = parseInt(m[3], 10);
  if (year <= 1970) return undefined;
  return Date.UTC(year, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
}

const POWER: Record<string, number> = { '': 0, K: 1, M: 2, G: 3, T: 4 };

/**
 * Sizes from torrent sites ("639.07 MB", "49.1Mo", "558.19 MBs") count in powers of 1024 even though
 * they say MB. French "o" (octet) is read as "B".
 */
export function parseBinarySize(s: string | undefined | null): number | undefined {
  if (!s) return undefined;
  const m = /^\s*([\d.,]+)\s*([KMGT]?)i?[oB]?s?\s*$/i.exec(s.replace(/ /g, ' '));
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 1024 ** POWER[m[2].toUpperCase()]);
}

/** Splits an HTML page into <tr> chunks (the chunk before the first row is dropped). */
export function tableRows(body: string): string[] {
  return body.split(/<tr[\s>]/i).slice(1);
}

/** Inner HTML of every <td> in a row. */
export function cells(row: string): string[] {
  const out: string[] = [];
  const re = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(row))) out.push(m[1]);
  return out;
}

/** The first magnet link on a detail page. */
export function firstMagnet(body: string): { magnet: string; infoHash: string } | null {
  const m = /href=["'](magnet:\?[^"']+)["']/i.exec(body);
  if (!m) return null;
  const magnet = decodeEntities(m[1]);
  const infoHash = infoHashFromMagnet(magnet);
  return infoHash ? { magnet, infoHash } : null;
}

export function absUrl(base: string, href: string): string {
  const b = base.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return `https:${href}`;
  return href.startsWith('/') ? b + href : `${b}/${href}`;
}
