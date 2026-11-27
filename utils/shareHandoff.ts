import { takePendingShare } from '../modules/maglev-engine/src/MaglevQuickShare';

// Every link that opens an Add screen (a share, a magnet or .torrent from another app, a Watch notification's Download
// action) waits in a one-shot native store. The app reads and clears it each time it starts and each time it comes back
// to the front. Nothing here remembers a link: a start-up that finds the store empty must see an empty store, even when
// the JS runtime outlived the screen (a download kept the process alive after a swipe away).

let sharedLaunch = false;
const listeners = new Set<() => void>();

/**
 * Reads and clears the store at start-up. Returns the stored link only when the start URL is plain; a real start URL
 * (a tile, a notification, any maglev:// route) is newer, so it wins and the stored link is dropped. Sets the
 * "this launch came from a share" flag for the What's New decision, and clears it first so a runtime that started
 * before cannot leave it set.
 */
export function takeStartLink(startUrlIsPlain: boolean): string | null {
  sharedLaunch = false;
  const link = takePendingShare();
  if (!link || !startUrlIsPlain) return null;
  sharedLaunch = true;
  return link;
}

/** True when this launch was started by a stored share link. Read by the What's New decision; reset when the app goes to the background. */
export function sharedLaunchFlag(): boolean {
  return sharedLaunch;
}

/** The app went to the background: the next start-up or return is judged on its own. */
export function clearSharedLaunch(): void {
  sharedLaunch = false;
}

/** A link left for the running app, or null. Tells the listeners, so the What's New decision can wait. */
export function takeSharedLink(): string | null {
  const link = takePendingShare();
  if (link) listeners.forEach((l) => l());
  return link;
}

/** A link arrived another way while the app runs; it is newer than anything waiting, so what waits is dropped. */
export function dropPendingShare(): void {
  takePendingShare();
}

/** Calls [cb] whenever a link is taken while the app runs. Returns the way to stop. */
export function onSharedLinkTaken(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
