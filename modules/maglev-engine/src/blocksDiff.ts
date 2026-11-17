import type { ActiveBlock } from './MaglevEngine.types.ts';

/** Whether the block list changed: the set of tags or any field, including the battery `levelPct`. */
export function blocksChanged(next: readonly ActiveBlock[], prev: readonly ActiveBlock[]): boolean {
  return JSON.stringify(next) !== JSON.stringify(prev);
}
