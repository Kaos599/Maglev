/**
 * Android share (ACTION_SEND / SEND_MULTIPLE) arrives as one VIEW intent, rewritten by the MainActivity
 * patch in plugins/withShareIntents.js. One source is the plain data URI. Several sources are packed as
 * `maglev://share?u=<encoded>&u=<encoded>`. The first goes to the add flow at once; the rest wait here and
 * the Transfers screen opens the next one each time it is focused again.
 */
const SHARE_PATH = /^(?:maglev:\/\/)?\/?share\?(.*)$/i;

let queue: string[] = [];

/** The packed sources, or null when [raw] is not a packed share. */
export function parsePackedShare(raw: string): string[] | null {
  const m = SHARE_PATH.exec(raw.trim());
  if (!m) return null;
  const out: string[] = [];
  for (const part of m[1].split('&')) {
    if (!part.startsWith('u=')) continue;
    try {
      const v = decodeURIComponent(part.slice(2)).trim();
      if (v) out.push(v);
    } catch {
      // skip a malformed entry
    }
  }
  return out;
}

/** Replaces the waiting sources. */
export function setShareQueue(sources: string[]): void {
  queue = [...sources];
}

/** The next waiting source, or null. */
export function takeNextShared(): string | null {
  return queue.shift() ?? null;
}

export function sharedWaiting(): number {
  return queue.length;
}
