// NATIVE_CONTRACT 45.5: when no subtitle is found, count the sources that are off and could have answered. Pure:
// settings and provider lists only, nothing is fetched.
import type { SubtitleProvider } from './types.ts';
import { SUBTITLE_PROVIDERS, listTurnedOff, providerEnabled, type ListOverrides } from './providers/index.ts';
import { effectiveLanguages } from './prefs.ts';
import { parseName } from './parseName.ts';
import type { SubtitleSettings } from '../../modules/maglev-engine/src/MaglevSettings.types.ts';

export interface OffSources {
  /** How many sources are off and cover at least one of the user's languages. */
  count: number;
  /** Their names, anime-focused ones first. */
  names: string[];
  /** The anime-focused source to name, when the video is anime. */
  animeName: string | null;
}

const NO_OFF_SOURCES: OffSources = { count: 0, names: [], animeName: null };

const base = (code: string): string => code.toLowerCase().split('-')[0];

/** A provider with no language data counts as covering every language. */
function coversLanguages(p: Pick<SubtitleProvider, 'languages'>, languages: readonly string[]): boolean {
  if (p.languages === 'many' || !Array.isArray(p.languages) || p.languages.length === 0) return true;
  const have = new Set(p.languages.map(base));
  return languages.some((l) => have.has(base(l)));
}

/** True for a file name that reads like anime: a leading [Group] tag or absolute episode numbering. */
export function looksLikeAnime(fileName: string): boolean {
  if (!fileName) return false;
  if (/^\s*\[[^\]]+\]/.test(fileName)) return true;
  return parseName(fileName).absoluteEpisode !== undefined;
}

export function subtitleOffSources(
  prefs: Pick<SubtitleSettings, 'enabled' | 'languages' | 'sourceEnabled'>,
  overrides: ListOverrides,
  opts: { anime?: boolean; locale?: string | null; providers?: readonly SubtitleProvider[] } = {},
): OffSources {
  if (!prefs.enabled) return NO_OFF_SOURCES;
  const languages = effectiveLanguages(prefs, opts.locale);
  const off = (opts.providers ?? SUBTITLE_PROVIDERS).filter(
    (p) => !providerEnabled(p, prefs, overrides) && !listTurnedOff(p.id, overrides) && coversLanguages(p, languages),
  );
  if (opts.anime) off.sort((a, b) => Number(b.focus === 'anime') - Number(a.focus === 'anime'));
  const first = off[0];
  return { count: off.length, names: off.map((p) => p.name), animeName: opts.anime && first?.focus === 'anime' ? first.name : null };
}
