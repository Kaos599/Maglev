// Saves the one current Assistant conversation so it survives the system ending the process. Pure: storage is
// injected (the hook passes the expo-sqlite kv-store), so Node tests run it with a fake. No React, no expo.
//
// What is saved is exactly the chat items the screen shows, plus whether a turn was running. No API key, no raw
// tool JSON and no model history is saved. After a restore the controller rebuilds the model's history from the
// user and assistant text items only.
import { CARD_EXPIRED_CAPTION } from '../assistant/cardMachine.ts';
import type { ChatItem } from '../assistant/runtime.ts';

export const CHAT_STORE_KEY = 'assistant.chat.v1';
/** The newest items kept. Older ones are dropped first. */
export const MAX_SAVED_ITEMS = 200;
/** Size limit of the saved JSON (characters, close enough to bytes for this text). */
export const MAX_SAVED_BYTES = 512 * 1024;

export interface ChatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SavedChat {
  /** A turn was running when this was saved. If the process then died, the turn was interrupted. */
  busy: boolean;
  items: ChatItem[];
}

export interface ChatStore {
  /** The saved chat, or null when nothing (usable) is saved. */
  load(): SavedChat | null;
  /** Writes the newest items within the caps. Empty items clear the store. */
  save(items: readonly ChatItem[], busy: boolean): void;
  clear(): void;
}

/** The newest items within MAX_SAVED_ITEMS and MAX_SAVED_BYTES. The newest item is always kept. */
export function capItems(items: readonly ChatItem[]): ChatItem[] {
  let out = items.length > MAX_SAVED_ITEMS ? items.slice(items.length - MAX_SAVED_ITEMS) : [...items];
  // Drop the oldest until the JSON fits. Sizes are measured per item so this stays linear.
  let total = out.reduce((n, i) => n + JSON.stringify(i).length + 1, 0);
  let from = 0;
  while (total > MAX_SAVED_BYTES && from < out.length - 1) {
    total -= JSON.stringify(out[from]).length + 1;
    from++;
  }
  if (from > 0) out = out.slice(from);
  return out;
}

const KINDS: ReadonlySet<string> = new Set(['user', 'assistant', 'progress', 'results', 'card', 'note', 'error', 'question', 'link']);

function validItem(i: unknown): i is ChatItem {
  if (typeof i !== 'object' || i === null) return false;
  const o = i as { kind?: unknown; id?: unknown };
  return typeof o.kind === 'string' && KINDS.has(o.kind) && typeof o.id === 'string';
}

/**
 * Makes saved items safe to show in a new process. Nothing is running any more, and every handle (r1, t1) and
 * card id belonged to the old session:
 *  - a card that was still open (proposed, confirming, executing, failed) becomes expired,
 *  - result cards are marked expired (their handles no longer resolve),
 *  - a running progress step becomes failed,
 *  - streaming text stops streaming.
 */
export function restoreItems(items: readonly ChatItem[]): ChatItem[] {
  return items.map((i): ChatItem => {
    switch (i.kind) {
      case 'card': {
        const k = i.state.kind;
        if (k === 'proposed' || k === 'confirming' || k === 'executing' || k === 'failed') {
          return { ...i, state: { kind: 'expired', cardId: i.state.cardId, caption: CARD_EXPIRED_CAPTION } };
        }
        return i;
      }
      case 'results':
        return { ...i, results: i.results.map((r) => ({ ...r, expired: true })) };
      case 'progress':
        return { ...i, steps: i.steps.map((s) => (s.state === 'running' ? { ...s, state: 'failed' as const } : s)) };
      case 'assistant':
        return i.streaming ? { ...i, streaming: false } : i;
      default:
        return i;
    }
  });
}

export function createChatStore(storage: ChatStorage): ChatStore {
  return {
    load() {
      try {
        const raw = storage.getItem(CHAT_STORE_KEY);
        if (!raw) return null;
        const v = JSON.parse(raw) as { v?: unknown; busy?: unknown; items?: unknown };
        if (v?.v !== 1 || !Array.isArray(v.items)) return null;
        const items = v.items.filter(validItem);
        return items.length > 0 ? { busy: v.busy === true, items } : null;
      } catch {
        return null;
      }
    },
    save(items, busy) {
      try {
        if (items.length === 0) {
          storage.setItem(CHAT_STORE_KEY, '');
          return;
        }
        storage.setItem(CHAT_STORE_KEY, JSON.stringify({ v: 1, busy, items: capItems(items) }));
      } catch {
        // A failed write must never break the chat.
      }
    },
    clear() {
      try {
        storage.setItem(CHAT_STORE_KEY, '');
      } catch {
        // nothing to do
      }
    },
  };
}
