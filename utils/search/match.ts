// Title-word matching shared by the assistant's scoring and the Search screen's Best match order.

const ARTICLES = new Set(['the', 'a', 'an']);

/** Scripts written without spaces between words: a title in them is one long token, so it is matched by substring. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export function titleTokens(s: string): string[] {
  const tokens = s
    .normalize('NFKC')
    // Fold Latin accents only (combining marks U+0300-036F); marks that belong to other scripts stay.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]+/g, '')
    .normalize('NFKC')
    .toLowerCase()
    // Apostrophes are dropped, not split on: "Schindler's" becomes "schindlers".
    .replace(/['’‘`´]/g, '')
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => t.length > 0 && !ARTICLES.has(t));
  // "Ocean.s.Eleven" has lost its apostrophe to a dot: glue a lone s or t back on.
  const out: string[] = [];
  for (const t of tokens) {
    if ((t === 's' || t === 't') && out.length > 0) out[out.length - 1] += t;
    else out.push(t);
  }
  return out;
}

function bigrams(s: string): string[] {
  const cs = Array.from(s);
  if (cs.length < 2) return [s];
  const out: string[] = [];
  for (let i = 0; i < cs.length - 1; i++) out.push(cs[i] + cs[i + 1]);
  return out;
}

/** Whether a wanted token shows up in the release's title tokens. Unspaced scripts match by substring or character pairs. */
function hasToken(want: string, have: Set<string>, haveText: string): boolean {
  if (have.has(want)) return true;
  if (!UNSPACED.test(want)) return false;
  if (haveText.includes(want)) return true;
  // A one-character difference in a long title ("進撃の巨人" vs "進撃の巨神") still counts as the same title.
  const pairs = bigrams(want);
  if (pairs.length < 4) return false;
  return pairs.filter((b) => haveText.includes(b)).length / pairs.length >= 0.75;
}

/**
 * The wanted title words that the name does not show. A release often glues or splits a word the user typed the
 * other way ("prime time" against "Primetime", "primetime" against "Prime.Time"), so two adjacent words that join
 * into one the other side has count as matched, and so do the two sides joined whole.
 */
export function missingTokens(want: readonly string[], have: readonly string[]): string[] {
  const set = new Set(have);
  const haveText = have.join('');
  if (want.join('') === haveText) return [];
  const joined = new Set<string>();
  for (let i = 0; i + 1 < have.length; i++) {
    joined.add(have[i] + have[i + 1]);
    if (i + 2 < have.length) joined.add(have[i] + have[i + 1] + have[i + 2]);
  }
  const covered = new Set<number>();
  for (let i = 0; i + 1 < want.length; i++) {
    if (set.has(want[i] + want[i + 1])) {
      covered.add(i);
      covered.add(i + 1);
    }
  }
  return want.filter((t, i) => !covered.has(i) && !hasToken(t, set, haveText) && !joined.has(t));
}
