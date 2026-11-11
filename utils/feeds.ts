import Storage from 'expo-sqlite/kv-store';

export interface Feed {
  id: string;
  name: string;
  url: string;
}

export interface FeedItem {
  /** Stable per feed: guid, link or title+date. */
  id: string;
  feedId: string;
  title: string;
  /** Magnet link or .torrent URL; null when the entry carries no torrent. */
  source: string | null;
  /** Lowercase hex info-hash when the source is a magnet, else null. */
  infoHash: string | null;
  sizeBytes: number | null;
  publishedAt: number | null;
}

const FEEDS_KEY = 'maglev.feeds.list.v1';
const SEEN_KEY = 'maglev.feeds.seen.v1';
const SEEN_CAP = 300;
const FETCH_TIMEOUT_MS = 10_000;

let memFeeds: Feed[] | null = null;
let memSeen: Record<string, string[]> | null = null;

export function loadFeeds(): Feed[] {
  try {
    const raw = Storage.getItemSync(FEEDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((f) => f && typeof f.id === 'string' && typeof f.url === 'string' && typeof f.name === 'string');
      }
    }
  } catch {
    // fall through to memory
  }
  return memFeeds ?? [];
}

export function saveFeeds(feeds: Feed[]): void {
  memFeeds = feeds;
  try {
    Storage.setItemSync(FEEDS_KEY, JSON.stringify(feeds));
  } catch {
    // memory only
  }
}

/** Ids of items the user has already seen, per feed id. */
export function loadSeen(): Record<string, string[]> {
  try {
    const raw = Storage.getItemSync(SEEN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string[]>;
    }
  } catch {
    // fall through
  }
  return memSeen ?? {};
}

export function saveSeen(seen: Record<string, string[]>): void {
  const trimmed: Record<string, string[]> = {};
  for (const k of Object.keys(seen)) trimmed[k] = seen[k].slice(-SEEN_CAP);
  memSeen = trimmed;
  try {
    Storage.setItemSync(SEEN_KEY, JSON.stringify(trimmed));
  } catch {
    // memory only
  }
}

/** Returns an http(s) URL string or null. */
export function normalizeFeedUrl(input: string): string | null {
  const t = input.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    const u = new URL(t);
    return u.host ? u.toString() : null;
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function infoHashFromMagnet(magnet: string): string | null {
  const m = /xt=urn:btih:([0-9a-zA-Z]+)/i.exec(magnet);
  if (!m) return null;
  const h = m[1];
  return /^[0-9a-fA-F]{40}$/.test(h) ? h.toLowerCase() : null;
}

export function relativeTime(ts: number | null, now: number = Date.now()): string {
  if (ts === null) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} mo ago`;
  return `${Math.floor(mo / 12)} y ago`;
}

function decode(s: string): string {
  return s
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function tagText(block: string, name: string): string | null {
  const n = name.replace(':', '\\:');
  const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i').exec(block);
  return m ? decode(m[1]) : null;
}

function attrValues(block: string, tag: string, attr: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\s[^>]*?${attr}=["']([^"']+)["'][^>]*>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push(decode(m[1]));
  return out;
}

function parseSize(text: string | null): number | null {
  if (!text) return null;
  const m = /^([\d.]+)\s*([KMGT]?i?B)?$/i.exec(text.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const unit = (m[2] || 'B').toUpperCase();
  const pow = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 }[unit] ?? 0;
  return Math.round(n * Math.pow(1024, pow));
}

function pickSource(block: string, title: string): string | null {
  const candidates = [
    tagText(block, 'torrent:magnetURI'),
    ...attrValues(block, 'enclosure', 'url'),
    ...attrValues(block, 'link', 'href'),
    tagText(block, 'link'),
    tagText(block, 'guid'),
  ].filter((c): c is string => !!c);
  const magnet = candidates.find((c) => /^magnet:\?/i.test(c));
  if (magnet) return magnet;
  const hash = tagText(block, 'nyaa:infoHash') ?? tagText(block, 'torrent:infoHash');
  if (hash && /^[0-9a-fA-F]{40}$/.test(hash)) {
    return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`;
  }
  const file = candidates.find((c) => /^https?:\/\/\S+/i.test(c) && /\.torrent(\?|$)/i.test(c));
  return file ?? null;
}

export interface ParsedFeed {
  title: string;
  items: Omit<FeedItem, 'feedId'>[];
}

/** Lightweight RSS 2.0 / Atom parser. Throws when the text is not a feed. */
export function parseFeed(xml: string): ParsedFeed {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw new Error('This address is not an RSS or Atom feed.');
  const blocks = xml.split(/<item[\s>]|<entry[\s>]/i).slice(1);
  const head = xml.split(/<item[\s>]|<entry[\s>]/i)[0];
  const feedTitle = tagText(head, 'title') ?? '';
  const items: Omit<FeedItem, 'feedId'>[] = [];
  for (const raw of blocks) {
    const end = raw.search(/<\/item>|<\/entry>/i);
    const block = end === -1 ? raw : raw.slice(0, end);
    const title = tagText(block, 'title');
    if (!title) continue;
    const dateText = tagText(block, 'pubDate') ?? tagText(block, 'published') ?? tagText(block, 'updated') ?? tagText(block, 'dc:date');
    const t = dateText ? Date.parse(dateText) : NaN;
    const source = pickSource(block, title);
    const enclosureLen = attrValues(block, 'enclosure', 'length')[0];
    const size =
      (enclosureLen && parseInt(enclosureLen, 10) > 0 ? parseInt(enclosureLen, 10) : null) ??
      parseSize(tagText(block, 'nyaa:size')) ??
      (tagText(block, 'torrent:contentLength') ? parseInt(tagText(block, 'torrent:contentLength') as string, 10) || null : null);
    const guid = tagText(block, 'guid') ?? tagText(block, 'id') ?? tagText(block, 'link') ?? `${title}|${dateText ?? ''}`;
    items.push({
      id: guid,
      title,
      source,
      infoHash: source && /^magnet:/i.test(source) ? infoHashFromMagnet(source) : null,
      sizeBytes: size,
      publishedAt: isNaN(t) ? null : t,
    });
  }
  return { title: feedTitle, items };
}

/** Fetches and parses one feed. Throws Error with a plain message (timeout, HTTP status, not a feed). */
export async function fetchFeed(url: string): Promise<ParsedFeed> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`The feed server answered ${res.status}.`);
    return parseFeed(await res.text());
  } catch (e) {
    if (controller.signal.aborted) throw new Error('The feed took too long to respond.');
    if (e instanceof Error && /answered|not an RSS/.test(e.message)) throw e;
    throw new Error('Could not reach the feed. Check your connection.');
  } finally {
    clearTimeout(timer);
  }
}
