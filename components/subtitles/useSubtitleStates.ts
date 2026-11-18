import { useSyncExternalStore } from 'react';
import { getStateVersion, subscribeStates } from './stateStore';

/** Changes whenever any subtitle state is written. Lists put it in their render dependencies. */
export function useSubtitleStateVersion(): number {
  return useSyncExternalStore(subscribeStates, getStateVersion, getStateVersion);
}
