import { useSyncExternalStore } from 'react';
import { getListsVersion, subscribeLists } from './store.ts';

/** Changes whenever a new source list is applied, so a screen can recompute what it derived from it. */
export function useListsVersion(): number {
  return useSyncExternalStore(subscribeLists, getListsVersion, getListsVersion);
}
