import type { MergedResult, SearchProvider } from './types';

type NamedProvider = Pick<SearchProvider, 'name' | 'unsafeReason'>;

/**
 * Names of the sources behind a result when EVERY one of them is flagged unsafe, else null.
 * One clean source is enough to clear the warning, because it corroborates the same info hash.
 */
export function riskySources(
  result: Pick<MergedResult, 'sources'>,
  providers: ReadonlyMap<string, NamedProvider>,
  warnUnsafe = true,
): string[] | null {
  if (!warnUnsafe || result.sources.length === 0) return null;
  const names: string[] = [];
  for (const id of result.sources) {
    const p = providers.get(id);
    if (!p || !p.unsafeReason) return null;
    names.push(p.name);
  }
  return names;
}
