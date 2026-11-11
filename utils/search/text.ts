// Tolerant string, XML and size helpers. React Native has no DOMParser, so we parse by hand.

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED[body] ?? whole;
  });
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Returns the raw inner text of each <tag>...</tag> block. */
export function extractBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Text of the first <tag> (namespaces allowed, e.g. "nyaa:seeders"), CDATA unwrapped, entities decoded. */
export function tagText(block: string, tag: string): string | undefined {
  const t = escapeRe(tag);
  const m = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'i').exec(block);
  if (!m) return undefined;
  let v = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  v = cdata ? cdata[1].trim() : decodeEntities(v);
  return v;
}

/** Attribute value from the first <tag .../> or <tag ...>. */
export function tagAttr(block: string, tag: string, attr: string): string | undefined {
  const t = escapeRe(tag);
  const m = new RegExp(`<${t}\\s([^>]*?)/?>`, 'i').exec(block);
  if (!m) return undefined;
  const a = new RegExp(`${escapeRe(attr)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(m[1]);
  return a ? decodeEntities(a[1] ?? a[2] ?? '') : undefined;
}

/** All <torznab:attr name=".." value=".."/> pairs, collected into name -> values[]. */
export function torznabAttrs(block: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const re = /<(?:torznab|newznab):attr\s+([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const n = /name\s*=\s*"([^"]*)"/i.exec(m[1]);
    const v = /value\s*=\s*"([^"]*)"/i.exec(m[1]);
    if (n && v) (out[n[1].toLowerCase()] ||= []).push(decodeEntities(v[1]));
  }
  return out;
}

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/** "624.0 MiB" -> bytes. Plain numbers are bytes. */
export function parseSize(s: string | undefined | null): number | undefined {
  if (s == null) return undefined;
  const m = /^\s*([\d.,]+)\s*([A-Za-z]*)\s*$/.exec(String(s));
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2].toLowerCase() || 'b';
  const mult = UNITS[unit];
  return mult ? Math.round(n * mult) : undefined;
}

export function toInt(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

export function toMs(v: string | undefined | null): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}
