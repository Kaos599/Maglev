/**
 * The app's single assistant prefs store: expo-sqlite kv for prefs, expo-secure-store for the API key.
 * utils/prefs/assistant.ts stays pure (injected storage) so node tests can run it; this file is the wiring.
 */
import { useSyncExternalStore } from 'react';
import * as SecureStore from 'expo-secure-store';
import { kvGet, kvSet } from './kv';
import { createAssistantPrefsStore, type AssistantPrefs } from './assistant';

export const assistantPrefs = createAssistantPrefsStore(
  { getItem: kvGet, setItem: kvSet },
  {
    get: (name) => SecureStore.getItemAsync(name),
    set: (name, value) => SecureStore.setItemAsync(name, value),
    remove: (name) => SecureStore.deleteItemAsync(name),
  },
);

const get = () => assistantPrefs.get();

/** Reactive assistant prefs. */
export function useAssistantPrefs(): AssistantPrefs {
  return useSyncExternalStore(assistantPrefs.subscribe, get, get);
}
