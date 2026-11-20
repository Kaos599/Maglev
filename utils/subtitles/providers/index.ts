/**
 * Subtitle provider registry (docs/NATIVE_CONTRACT.md section 36.3). Every provider is listed here; the wave that
 * ports the sources adds them. `enabledProviders` decides which of them run.
 */
import type { SubtitleProvider } from '../types.ts';
import type { SourceEntry } from '../../lists/schema.ts';
import type { SubtitleSettings } from '../../../modules/maglev-engine/src/MaglevSettings.types.ts';
import { BATCH_1 } from './batch1.ts';
import { BATCH_2 } from './batch2.ts';
import { BATCH_3 } from './batch3.ts';
import { BATCH_4 } from './batch4.ts';
import { BATCH_5 } from './batch5.ts';

export const SUBTITLE_PROVIDERS: SubtitleProvider[] = [...BATCH_1, ...BATCH_2, ...BATCH_3, ...BATCH_4, ...BATCH_5];

export type ListOverrides = Record<string, SourceEntry> | null | undefined;

/** True when the signed list turned this source off (`enabled: false`): the user can't turn it on. */
export function listTurnedOff(id: string, overrides: ListOverrides): boolean {
  return overrides?.[id]?.enabled === false;
}

/**
 * Whether a provider is on. Precedence: the signed list's `enabled: false` always wins; then the user's own switch;
 * then the provider's `enabledByDefault`.
 */
export function providerEnabled(p: Pick<SubtitleProvider, 'id' | 'enabledByDefault'>, prefs: Pick<SubtitleSettings, 'sourceEnabled'>, overrides: ListOverrides): boolean {
  if (listTurnedOff(p.id, overrides)) return false;
  const mine = prefs.sourceEnabled[p.id];
  return typeof mine === 'boolean' ? mine : p.enabledByDefault;
}

/** The provider with the list's mirrors in front (https only; validated when the list was read). */
function withListMirrors<P extends Pick<SubtitleProvider, 'id' | 'mirrors'>>(p: P, overrides: ListOverrides): P {
  const m = overrides?.[p.id]?.mirrors;
  return m && m.length > 0 ? { ...p, mirrors: m.slice() } : p;
}

/**
 * The providers to ask: none when the master switch is off, otherwise those that are on, with the list's mirrors
 * applied. `providers` is for tests.
 */
export function enabledProviders(
  prefs: Pick<SubtitleSettings, 'enabled' | 'sourceEnabled'>,
  overrides: ListOverrides,
  providers: readonly SubtitleProvider[] = SUBTITLE_PROVIDERS,
): SubtitleProvider[] {
  if (!prefs.enabled) return [];
  return providers.filter((p) => providerEnabled(p, prefs, overrides)).map((p) => withListMirrors(p, overrides));
}
