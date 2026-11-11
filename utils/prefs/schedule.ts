import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { maglevEngine } from 'maglev-engine';
import type { ScheduleConfig, ScheduleRule } from 'maglev-engine';

/** Contract: docs/NATIVE_CONTRACT.md section 11.5. Days are 0 = Monday through 6 = Sunday. */
const KEY = 'maglev.schedule.v1';
const MB = 1_048_576;

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Speed presets in bytes per second. 0 means no limit in that direction. */
export const LIMIT_PRESETS: readonly { bps: number; label: string }[] = [
  { bps: 0, label: 'No limit' },
  { bps: 256 * 1024, label: '256 KB/s' },
  { bps: MB, label: '1 MB/s' },
  { bps: 5 * MB, label: '5 MB/s' },
  { bps: 10 * MB, label: '10 MB/s' },
];

export const NIGHT_PRESET = { start: '01:00', end: '07:00' } as const;

function defaults(): ScheduleConfig {
  return { enabled: false, rules: [] };
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normalizeRule(x: unknown): ScheduleRule | null {
  const r = x as Partial<ScheduleRule> | null;
  if (!r || typeof r.id !== 'string' || !TIME.test(String(r.start)) || !TIME.test(String(r.end))) return null;
  const days = Array.isArray(r.days)
    ? Array.from(new Set(r.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))).sort()
    : [];
  const action = r.action === 'limit' ? 'limit' : 'pause';
  const rule: ScheduleRule = { id: r.id, days, start: r.start as string, end: r.end as string, action };
  if (action === 'limit') {
    rule.downBps = typeof r.downBps === 'number' && r.downBps > 0 ? Math.floor(r.downBps) : 0;
    rule.upBps = typeof r.upBps === 'number' && r.upBps > 0 ? Math.floor(r.upBps) : 0;
  }
  return rule;
}

function normalize(raw: unknown): ScheduleConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    rules: Array.isArray(o.rules) ? o.rules.flatMap((r) => normalizeRule(r) ?? []) : [],
  };
}

let cache: ScheduleConfig | null = null;
const listeners = new Set<() => void>();

export function getSchedule(): ScheduleConfig {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = Storage.getItemSync(KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    // Storage unavailable: defaults for this session.
  }
  cache = normalize(parsed) ?? defaults();
  return cache;
}

/** Sends the current schedule to Kotlin. Failures are swallowed: the next change or app start retries. */
export async function syncScheduleToNative(): Promise<void> {
  try {
    await maglevEngine.setSchedule(getSchedule());
  } catch {
    // Native side unavailable.
  }
}

/** Saves, notifies and pushes to native. */
export function updateSchedule(change: Partial<ScheduleConfig> | ((s: ScheduleConfig) => Partial<ScheduleConfig>)): ScheduleConfig {
  const prev = getSchedule();
  const patch = typeof change === 'function' ? change(prev) : change;
  const next = normalize({ ...prev, ...patch });
  cache = next;
  try {
    Storage.setItemSync(KEY, JSON.stringify(next));
  } catch {
    // Kept in memory only.
  }
  listeners.forEach((l) => l());
  void syncScheduleToNative();
  return next;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSchedule(): [ScheduleConfig, typeof updateSchedule] {
  const s = useSyncExternalStore(subscribe, getSchedule, getSchedule);
  return [s, updateSchedule];
}

export function newRuleId(): string {
  return `rule_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function pauseRule(start: string, end: string, days: number[] = ALL_DAYS): ScheduleRule {
  return { id: newRuleId(), days, start, end, action: 'pause' };
}

/** True when the window runs past midnight (end before start). */
export function isOvernight(r: Pick<ScheduleRule, 'start' | 'end'>): boolean {
  return r.end < r.start;
}

export function isAllDay(r: Pick<ScheduleRule, 'start' | 'end'>): boolean {
  return r.start === r.end;
}

export function speedLabel(bps: number | undefined): string {
  if (!bps || bps <= 0) return 'No limit';
  const preset = LIMIT_PRESETS.find((p) => p.bps === bps);
  if (preset) return preset.label;
  return bps >= MB ? `${+(bps / MB).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`;
}

/** "Limit 1 MB/s down, 256 KB/s up", or "Pause". */
export function actionLabel(r: ScheduleRule): string {
  if (r.action === 'pause') return 'Pause';
  const parts: string[] = [];
  if (r.downBps) parts.push(`${speedLabel(r.downBps)} down`);
  if (r.upBps) parts.push(`${speedLabel(r.upBps)} up`);
  return `Limit ${parts.join(', ') || 'none'}`;
}

export function daysLabel(days: number[]): string {
  if (days.length === 7) return 'Every day';
  if (days.length === 0) return 'No days';
  if (days.join() === '0,1,2,3,4') return 'Weekdays';
  if (days.join() === '5,6') return 'Weekends';
  return days.map((d) => DAY_LABELS[d]).join(' ');
}

/** Short value for the Settings list. */
export function scheduleSummary(s: ScheduleConfig): string {
  if (!s.enabled) return 'Off';
  if (s.rules.length === 0) return 'No rules';
  if (s.rules.length === 1) {
    const r = s.rules[0];
    return `${r.action === 'pause' ? 'Pause' : 'Limit'} ${r.start}–${r.end}`;
  }
  return `${s.rules.length} rules`;
}

export function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
