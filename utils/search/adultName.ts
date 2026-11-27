// A name-only check for porn releases that a source did not label as adult. It must stay conservative:
// a missed row is fine, but hiding a real film is not, so only strong signals count.

/** Studio and site names that are unlikely to be anything else. Matched as whole token runs. */
const STUDIOS: readonly (readonly string[])[] = [
  ['brazzers'],
  ['bangbros'],
  ['realitykings'],
  ['reality', 'kings'],
  ['naughtyamerica'],
  ['naughty', 'america'],
  ['metart'],
  ['mofos'],
  ['evilangel'],
  ['digitalplayground'],
  ['digital', 'playground'],
  ['pornhub'],
  ['onlyfans'],
  ['teamskeet'],
  ['nubiles'],
  ['julesjordan'],
];

/** Studio names that are also ordinary words. Only a signal at the start of a name, where scene releases put the studio, followed by a two-digit date part. */
const SCENE_STUDIOS: ReadonlySet<string> = new Set(['vixen', 'blacked', 'tushy']);

const SPLIT = /[\s._\-[\]()]+/;
const YEAR = /^(19|20)\d\d$/;
/** Words that come before XXX when it counts events. */
const NUMERAL_BEFORE: ReadonlySet<string> = new Set(['bowl', 'wrestlemania', 'olympiad']);

function runAt(tokens: readonly string[], at: number, run: readonly string[]): boolean {
  return run.every((t, i) => tokens[at + i] === t);
}

/** True when the name carries a strong sign of an adult release. Single words such as "sex" or "adult" never count. */
export function looksAdult(name: string): boolean {
  const raw = name.trim();
  if (!raw) return false;
  const tokens = raw.split(SPLIT).filter(Boolean);
  const lower = tokens.map((t) => t.toLowerCase());

  // "xXx" opening a name, written as the film's title or followed by a year or a colon, is the film.
  const filmTitle =
    tokens[0] === 'xXx' || /^xxx\s*:/i.test(raw) || (lower[0] === 'xxx' && lower[1] !== undefined && YEAR.test(lower[1]));

  for (let i = 0; i < lower.length; i++) {
    if (lower[i] !== 'xxx') continue;
    // The film writes its title "xXx"; porn names use XXX or xxx.
    if (tokens[i] === 'xXx' || (i === 0 && filmTitle)) continue;
    // XXX is also the Roman numeral 30: Super Bowl XXX, WrestleMania XXX.
    if (i > 0 && NUMERAL_BEFORE.has(lower[i - 1])) continue;
    return true;
  }
  for (const run of STUDIOS) {
    for (let i = 0; i + run.length <= lower.length; i++) if (runAt(lower, i, run)) return true;
  }
  if (SCENE_STUDIOS.has(lower[0]) && lower[1] !== undefined && /^\d{2}$/.test(lower[1])) return true;
  return false;
}
