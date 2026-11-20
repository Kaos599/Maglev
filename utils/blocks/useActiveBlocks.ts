/**
 * Which rules hold transfers right now (NATIVE_CONTRACT 35.3). Loads `getActiveBlocks` once, follows
 * `addBlocksListener`, and lets go on unmount. Safe before the engine is ready: the list stays empty.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { maglevEngine, type ActiveBlock } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import type { BlockContext } from './reasons';

const NONE: ActiveBlock[] = [];

export function useActiveBlocks(): ActiveBlock[] {
  const [blocks, setBlocks] = useState<ActiveBlock[]>(NONE);
  useEffect(() => {
    let alive = true;
    // An event that lands before the first read finishes is newer than that read.
    let fresh = false;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = maglevEngine.addBlocksListener((next) => {
        if (!alive) return;
        fresh = true;
        setBlocks(next);
      });
    } catch {
      unsubscribe = undefined;
    }
    try {
      Promise.resolve(maglevEngine.getActiveBlocks())
        .then((first) => {
          if (alive && !fresh && Array.isArray(first)) setBlocks(first);
        })
        .catch(() => {});
    } catch {
      // The engine is not ready: no blocks to show.
    }
    return () => {
      alive = false;
      try {
        unsubscribe?.();
      } catch {
        // Already gone.
      }
    };
  }, []);
  return blocks;
}

/** How many downloads run at once. 0 in settings means no limit, so nothing queues; the engine default is 3. */
export function queueLimitOf(maxActiveDownloads: number | undefined): number {
  return maxActiveDownloads && maxActiveDownloads > 0 ? maxActiveDownloads : 3;
}

/** Blocks plus the queue size: what the copy table needs. For a screen that is not under the Transfers tab. */
export function useLiveBlockContext(): BlockContext {
  const blocks = useActiveBlocks();
  const { settings } = useSettings();
  const queueLimit = queueLimitOf(settings.bandwidth.maxActiveDownloads);
  return useMemo(() => ({ blocks, queueLimit }), [blocks, queueLimit]);
}

/** The Transfers screen loads the blocks once and shares them with every card through this. */
const BlockContextContext = createContext<BlockContext>({});

export function useBlockContext(): BlockContext {
  return useContext(BlockContextContext);
}

export const BlockContextProvider = BlockContextContext.Provider;
