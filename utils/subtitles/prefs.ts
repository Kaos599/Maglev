/**
 * Subtitle prefs (docs/NATIVE_CONTRACT.md sections 36.2 and 36.10). Pure helpers over the `subtitles` section of
 * the settings (modules/maglev-engine/src/MaglevSettings.types.ts, UI only: never in toNativeConfig), plus the
 * per-video state kept in kv `subtitles.state`.
 */
import { kvGet, kvSet } from '../prefs/kv.ts';
import { defaultLanguages } from './languages.ts';
import type { SubtitleSettings } from '../../modules/maglev-engine/src/MaglevSettings.types.ts';

export type { SubtitleSettings };
export type HearingPref = SubtitleSettings['hearingImpaired'];

export const DEFAULT_SUBTITLE_SETTINGS: SubtitleSettings = {
  enabled: true,
  languages: [],
  hearingImpaired: 'both',
  sourceEnabled: {},
  privacyAck: false,
};

/** The language order in force: the user's pick, or the phone's language then English (36.2). */
export function effectiveLanguages(s: Pick<SubtitleSettings, 'languages'>, locale?: string | null): string[] {
  return s.languages.length > 0 ? s.languages.slice() : defaultLanguages(locale);
}

/** The one-time notice (36.10) is needed until the user accepted it. */
export function needsPrivacyNotice(s: Pick<SubtitleSettings, 'privacyAck'>): boolean {
  return !s.privacyAck;
}

/** The patch to store after Continue on the notice. */
export function privacyAckPatch(): Pick<SubtitleSettings, 'privacyAck'> {
  return { privacyAck: true };
}

/** A new `sourceEnabled` map with one switch set. */
export function withSourceEnabled(s: Pick<SubtitleSettings, 'sourceEnabled'>, providerId: string, on: boolean): Record<string, boolean> {
  return { ...s.sourceEnabled, [providerId]: on };
}

/** A new language list with `code` moved to `index` (or added there); duplicates are removed. */
export function withLanguageAt(list: readonly string[], code: string, index: number): string[] {
  const rest = list.filter((c) => c !== code);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, code);
  return rest;
}

// ---------------------------------------------------------------- per-video state (36.10)

export type SubtitleCardState = 'getting' | 'saved' | 'needs-look';

export interface SubtitleState {
  lang: string;
  /** The saved subtitle's file name; empty while getting. */
  file: string;
  /** Epoch ms of the save (or of the last change while not saved). */
  savedAt: number;
  state: SubtitleCardState;
}

/** A saved state hides 24 h after the save. */
export const SAVED_VISIBLE_MS = 24 * 60 * 60 * 1000;
const STATE_KEY = 'subtitles.state';
const MAX_STATES = 300;

/** Whether the card icon still shows for this state. Only 'saved' ever hides. */
export function stateVisible(entry: SubtitleState | null | undefined, now: number): boolean {
  if (!entry) return false;
  if (entry.state !== 'saved') return true;
  return now - entry.savedAt < SAVED_VISIBLE_MS;
}

function clean(raw: unknown): SubtitleState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.state !== 'getting' && o.state !== 'saved' && o.state !== 'needs-look') return null;
  if (typeof o.lang !== 'string' || typeof o.savedAt !== 'number' || !Number.isFinite(o.savedAt)) return null;
  return { lang: o.lang, file: typeof o.file === 'string' ? o.file : '', savedAt: o.savedAt, state: o.state };
}

function readAll(): Record<string, SubtitleState> {
  const out: Record<string, SubtitleState> = {};
  try {
    const raw = kvGet(STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const e = clean(v);
        if (e) out[k] = e;
      }
    }
  } catch {
    // unreadable: start empty
  }
  return out;
}

function writeAll(all: Record<string, SubtitleState>): void {
  const keys = Object.keys(all);
  if (keys.length > MAX_STATES) {
    keys.sort((a, b) => all[b].savedAt - all[a].savedAt);
    for (const k of keys.slice(MAX_STATES)) delete all[k];
  }
  try {
    kvSet(STATE_KEY, JSON.stringify(all));
  } catch {
    // memory only
  }
}

/** The state for a video path or URI, or null. Doesn't apply the 24 h rule; use stateVisible. */
export function getSubtitleState(videoKey: string): SubtitleState | null {
  return readAll()[videoKey] ?? null;
}

export function setSubtitleState(videoKey: string, entry: SubtitleState): void {
  const all = readAll();
  all[videoKey] = entry;
  writeAll(all);
}

export function clearSubtitleState(videoKey: string): void {
  const all = readAll();
  if (!(videoKey in all)) return;
  delete all[videoKey];
  writeAll(all);
}
