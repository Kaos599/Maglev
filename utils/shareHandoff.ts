import { dropPendingShare as dropNativeShare, takePendingShare } from '../modules/maglev-engine/src/MaglevQuickShare';

// Every link that opens an Add screen (a share, a magnet or .torrent from another app, a Watch notification's Download
// action) waits in a one-shot native store. The app reads and clears it each time it starts and each time it comes back
// to the front. Nothing here remembers a link: a start-up that finds the store empty must see an empty store, even when
// the JS runtime outlived the screen (a download kept the process alive after a swipe away).

let sharedLaunch = false;
const listeners = new Set<() => void>();

/**
 * Reads and clears the store at start-up. A stored entry (under ten minutes old) wins over the start URL: a restored task
 * reports the intent it was first started with, which may be long stale, while the store always holds the newest thing
 * Maglev itself opened. Sets the "this launch came from a link in the store" flag for the What's New decision, and
 * clears it first so a runtime that started before cannot leave it set.
 */
export function takeStartLink(): string | null {
  sharedLaunch = false;
  const link = takePendingShare(true);
  if (link) sharedLaunch = true;
  return link;
}

/**
 * True when this launch was started by a stored link. Read by the What's New decision. It stays set until that decision
 * has read it ([clearSharedLaunch]), not merely until the app goes to the background.
 */
export function sharedLaunchFlag(): boolean {
  return sharedLaunch;
}

/** The What's New decision has read the flag: the next start-up or return is judged on its own. */
export function clearSharedLaunch(): void {
  sharedLaunch = false;
}

/** A link left for the running app in the last minute, or null. Tells the listeners, so the What's New decision can wait. */
export function takeSharedLink(): string | null {
  const link = takePendingShare(false);
  if (link) listeners.forEach((l) => l());
  return link;
}

/** A link arrived another way while the app runs; it is newer than anything waiting, so what waits is dropped. */
export function dropPendingShare(): void {
  dropNativeShare();
}

/** Calls [cb] whenever a link is taken while the app runs. Returns the way to stop. */
export function onSharedLinkTaken(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
