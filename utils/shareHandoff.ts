import { takePendingShare } from '../modules/maglev-engine/src/MaglevQuickShare';

// The share card leaves a link in a one-shot native store (see MaglevQuickShare.takePendingShare). The app reads it
// when it starts and each time it comes back to the front.

let startLink: string | null | undefined;
const listeners = new Set<() => void>();

/**
 * The link waiting when the app started, read once and remembered. Both the start-up routing and the What's New
 * decision ask for it, in either order, and get the same answer: a store that can be read only once must not hide
 * the link from whichever of them asks second.
 */
export function takeStartLink(): string | null {
  if (startLink === undefined) startLink = takePendingShare();
  return startLink;
}

/** True when the app started with a shared link: that launch is not a plain one. */
export function startedWithSharedLink(): boolean {
  return takeStartLink() !== null;
}

/** A link left for the running app, or null. Tells the listeners, so the What's New decision can wait. */
export function takeSharedLink(): string | null {
  const link = takePendingShare();
  if (link) listeners.forEach((l) => l());
  return link;
}

/** Calls [cb] whenever a link is taken while the app runs. Returns the way to stop. */
export function onSharedLinkTaken(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
