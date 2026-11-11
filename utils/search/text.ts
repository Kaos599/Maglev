// Tolerant string, XML and size helpers. React Native has no DOMParser, so we parse by hand.

// HTML named entities seen in index titles: XML basics, Latin-1 (U+00A0–U+00FF) and common punctuation.
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp:'\u00a0', iexcl:'\u00a1', cent:'\u00a2', pound:'\u00a3', curren:'\u00a4', yen:'\u00a5', brvbar:'\u00a6', sect:'\u00a7', uml:'\u00a8', copy:'\u00a9', ordf:'\u00aa', laquo:'\u00ab', not:'\u00ac', shy:'\u00ad', reg:'\u00ae', macr:'\u00af', deg:'\u00b0', plusmn:'\u00b1', sup2:'\u00b2', sup3:'\u00b3', acute:'\u00b4', micro:'\u00b5', para:'\u00b6', middot:'\u00b7', cedil:'\u00b8', sup1:'\u00b9', ordm:'\u00ba', raquo:'\u00bb', frac14:'\u00bc', frac12:'\u00bd', frac34:'\u00be', iquest:'\u00bf', Agrave:'\u00c0', Aacute:'\u00c1', Acirc:'\u00c2', Atilde:'\u00c3', Auml:'\u00c4', Aring:'\u00c5', AElig:'\u00c6', Ccedil:'\u00c7', Egrave:'\u00c8', Eacute:'\u00c9', Ecirc:'\u00ca', Euml:'\u00cb', Igrave:'\u00cc', Iacute:'\u00cd', Icirc:'\u00ce', Iuml:'\u00cf', ETH:'\u00d0', Ntilde:'\u00d1', Ograve:'\u00d2', Oacute:'\u00d3', Ocirc:'\u00d4', Otilde:'\u00d5', Ouml:'\u00d6', times:'\u00d7', Oslash:'\u00d8', Ugrave:'\u00d9', Uacute:'\u00da', Ucirc:'\u00db', Uuml:'\u00dc', Yacute:'\u00dd', THORN:'\u00de', szlig:'\u00df', agrave:'\u00e0', aacute:'\u00e1', acirc:'\u00e2', atilde:'\u00e3', auml:'\u00e4', aring:'\u00e5', aelig:'\u00e6', ccedil:'\u00e7', egrave:'\u00e8', eacute:'\u00e9', ecirc:'\u00ea', euml:'\u00eb', igrave:'\u00ec', iacute:'\u00ed', icirc:'\u00ee', iuml:'\u00ef', eth:'\u00f0', ntilde:'\u00f1', ograve:'\u00f2', oacute:'\u00f3', ocirc:'\u00f4', otilde:'\u00f5', ouml:'\u00f6', divide:'\u00f7', oslash:'\u00f8', ugrave:'\u00f9', uacute:'\u00fa', ucirc:'\u00fb', uuml:'\u00fc', yacute:'\u00fd', thorn:'\u00fe', yuml:'\u00ff', ndash:'\u2013', mdash:'\u2014', lsquo:'\u2018', rsquo:'\u2019', sbquo:'\u201a', ldquo:'\u201c', rdquo:'\u201d', bdquo:'\u201e', hellip:'\u2026', bull:'\u2022', trade:'\u2122', euro:'\u20ac', dagger:'\u2020', prime:'\u2032', lsaquo:'\u2039', rsaquo:'\u203a', oelig:'\u0153', OElig:'\u0152', scaron:'\u0161', Scaron:'\u0160', Yuml:'\u0178', circ:'\u02c6', tilde:'\u02dc', thinsp:'\u2009', ensp:'\u2002', emsp:'\u2003', zwj:'\u200d', zwnj:'\u200c', lrm:'\u200e', rlm:'\u200f',
};

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
