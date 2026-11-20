/**
 * Pure helpers behind Settings > Subtitles (docs/NATIVE_CONTRACT.md section 36.10). No React Native imports, so
 * scripts/test-subtitles-settings.js runs them in Node. The subtitle core itself lives in utils/subtitles/*.
 */
import { LANGUAGES, defaultLanguages, languageName, phoneLocale, type LanguageInfo } from './subtitles/languages.ts';
import { effectiveLanguages, withLanguageAt } from './subtitles/prefs.ts';
import { listTurnedOff, providerEnabled, type ListOverrides } from './subtitles/providers/index.ts';
import type { SubtitleProvider } from './subtitles/types.ts';
import type { SubtitleSettings } from '../modules/maglev-engine/src/MaglevSettings.types.ts';

/**
 * Whether this build carries an OpenSubtitles.com app key (`OPENSUBTITLES_API_KEY`, section 36.1). The app has no
 * build-time config channel yet (no expo `extra`), so this is false and the account row stays hidden. When the
 * owner registers the key, read it here and add the account screen.
 */
export function hasOpenSubtitlesKey(): boolean {
  return false;
}

// ---------------------------------------------------------------- languages

/** "Phone language (English)": what the empty list follows. */
export function phoneLanguageLabel(locale: string | null | undefined = phoneLocale()): string {
  return `Phone language (${languageName(defaultLanguages(locale)[0])})`;
}

/** The value shown on the Languages row. */
export function languagesValue(languages: readonly string[], locale?: string | null): string {
  if (languages.length === 0) return phoneLanguageLabel(locale);
  const names = languages.map(languageName);
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

/** A new order with `code` moved one place up (-1) or down (1). Out-of-range moves return the same order. */
export function moveLanguage(list: readonly string[], code: string, delta: -1 | 1): string[] {
  const i = list.indexOf(code);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list.slice();
  return withLanguageAt(list, code, j);
}

/** Adds at the end, or removes when already chosen. */
export function toggleLanguage(list: readonly string[], code: string): string[] {
  return list.includes(code) ? list.filter((c) => c !== code) : [...list, code];
}

/** Languages not chosen yet that match the query (English or native name, or the code). All of them for an empty query. */
export function pickableLanguages(chosen: readonly string[], query: string): LanguageInfo[] {
  const q = query.trim().toLowerCase();
  return LANGUAGES.filter((l) => !chosen.includes(l.code)).filter(
    (l) => !q || l.name.toLowerCase().includes(q) || l.native.toLowerCase().includes(q) || l.code.toLowerCase() === q,
  );
}

/** The order the lookups use, for the page's caption. Re-exported so the screen has one import. */
export function languageOrder(s: Pick<SubtitleSettings, 'languages'>, locale?: string | null): string[] {
  return effectiveLanguages(s, locale);
}

// ---------------------------------------------------------------- sources

const MATCH_LABEL = { hash: 'fingerprint', name: 'name', imdb: 'IMDb' } as const;

/** "By fingerprint and name". */
function matchesLine(matches: SubtitleProvider['matches']): string {
  const parts = matches.map((m) => MATCH_LABEL[m]);
  if (parts.length === 0) return 'By name';
  if (parts.length === 1) return `By ${parts[0]}`;
  return `By ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Many languages", or up to three names and a count. */
function languagesLine(languages: SubtitleProvider['languages']): string {
  if (languages === 'many') return 'Many languages';
  if (languages.length === 0) return 'Few languages';
  const names = languages.map(languageName);
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

export interface SourceRow {
  id: string;
  name: string;
  /** Two letters for the monogram. */
  abbr: string;
  matches: string;
  languages: string;
  on: boolean;
  /** The signed list turned it off: the switch can't be used. */
  turnedOff: { note: string | null } | null;
  homepage: string;
}

function abbrOf(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'SU';
}

/** One row per provider, in registry order, with the list's say applied. */
export function sourceRows(
  providers: readonly SubtitleProvider[],
  prefs: Pick<SubtitleSettings, 'sourceEnabled'>,
  overrides: ListOverrides,
): SourceRow[] {
  return providers.map((p) => {
    const off = listTurnedOff(p.id, overrides);
    return {
      id: p.id,
      name: p.name,
      abbr: abbrOf(p.name),
      matches: matchesLine(p.matches),
      languages: languagesLine(p.languages),
      on: providerEnabled(p, prefs, overrides),
      turnedOff: off ? { note: overrides?.[p.id]?.note ?? null } : null,
      homepage: p.homepage,
    };
  });
}

/** The row value on the Settings > Subtitles page: "3 on", or "None yet" with an empty registry. */
export function sourcesValue(rows: readonly SourceRow[]): string {
  if (rows.length === 0) return 'None yet';
  return `${rows.filter((r) => r.on).length} on`;
}
