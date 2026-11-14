/**
 * Counts the sheets and cards that are open, so something that wants to appear on its own (the star card)
 * can wait until none is. Sheet and FloatingSheet report through `useOverlayTracking(visible)`.
 */
import { useEffect } from 'react';

let open = 0;

export function overlayOpenCount(): number {
  return open;
}

export function anyOverlayOpen(): boolean {
  return open > 0;
}

export function useOverlayTracking(visible: boolean): void {
  useEffect(() => {
    if (!visible) return;
    open += 1;
    return () => {
      open = Math.max(0, open - 1);
    };
  }, [visible]);
}
