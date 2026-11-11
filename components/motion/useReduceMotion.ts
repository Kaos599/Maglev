import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

/*
 * One app-wide reduce-motion flag. Every tab button and icon button reads it, so it is a
 * single shared subscription rather than one AccessibilityInfo listener per component.
 */
let reduceMotion = false;
let started = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (next === reduceMotion) return;
  reduceMotion = next;
  listeners.forEach((l) => l());
}

function start() {
  if (started) return;
  started = true;
  AccessibilityInfo.isReduceMotionEnabled().then(set).catch(() => {});
  // Lives for the whole app; never removed.
  AccessibilityInfo.addEventListener('reduceMotionChanged', set);
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => reduceMotion;

/** True when the system asks for less motion. Updates live. */
export function useReduceMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
