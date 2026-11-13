import { useSyncExternalStore } from 'react';

/**
 * Whether a reply finished while the Assistant tab was out of view. The chat controller sets it; the tab bar shows
 * a dot for it. Kept free of storage and navigation imports.
 */
let unseen = false;
const listeners = new Set<() => void>();

export function getUnseenReply(): boolean {
  return unseen;
}

export function setUnseenReply(next: boolean): void {
  if (next === unseen) return;
  unseen = next;
  listeners.forEach((l) => l());
}

export function subscribeUnseenReply(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUnseenReply(): boolean {
  return useSyncExternalStore(subscribeUnseenReply, getUnseenReply, getUnseenReply);
}
