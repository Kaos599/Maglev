// In-memory provider health: 3 consecutive failures pause a provider for 5 minutes.

export const FAILURE_LIMIT = 3;
export const PAUSE_MS = 5 * 60 * 1000;

interface Entry {
  failures: number;
  pausedUntil: number;
}

const table = new Map<string, Entry>();
let clock: () => number = () => Date.now();

export function setClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

export function resetHealth(): void {
  table.clear();
}

export function recordSuccess(id: string): void {
  table.delete(id);
}

export function recordFailure(id: string): void {
  const e = table.get(id) ?? { failures: 0, pausedUntil: 0 };
  e.failures += 1;
  if (e.failures >= FAILURE_LIMIT) {
    e.pausedUntil = clock() + PAUSE_MS;
    e.failures = 0;
  }
  table.set(id, e);
}

/** Milliseconds left on the pause, or 0 when the provider may run. */
export function pausedFor(id: string): number {
  const e = table.get(id);
  if (!e || !e.pausedUntil) return 0;
  const left = e.pausedUntil - clock();
  if (left <= 0) {
    table.delete(id);
    return 0;
  }
  return left;
}
