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
  autoNewVideos: false,
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

/**
 * 44.15 D10: the functional settings update for accepting the notice (and optionally more fields in the same write).
 * It reads the settings as they are now, never a snapshot from an earlier render.
 */
export function acceptPrivacy(more?: Partial<SubtitleSettings>): (prev: { subtitles: SubtitleSettings }) => { subtitles: SubtitleSettings } {
  return (prev) => ({ subtitles: { ...prev.subtitles, ...more, ...privacyAckPatch() } });
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

/** 'none' (NATIVE_CONTRACT 44.8): nothing found, offline or limited; the icon shows a muted glyph with no badge. */
export type SubtitleCardState = 'getting' | 'saved' | 'needs-look' | 'none';

export interface SubtitleState {
  lang: string;
  /** The saved subtitle's file name; empty while getting. */
  file: string;
  /** Epoch ms of the save (or of the last change while not saved). */
  savedAt: number;
  state: SubtitleCardState;
}

/** A saved state hides 24 h after the save. */
const SAVED_VISIBLE_MS = 24 * 60 * 60 * 1000;
/** A "needs a look" state hides after 24 h too. */
const NEEDS_LOOK_VISIBLE_MS = 24 * 60 * 60 * 1000;
/** A "getting" state hides after 2 minutes: a download that long is gone (the app was killed). */
const GETTING_VISIBLE_MS = 2 * 60 * 1000;
const STATE_KEY = 'subtitles.state';
const MAX_STATES = 300;

/**
 * Whether the card icon still shows for this state: 'getting' for 2 minutes, 'saved' and 'needs-look' for 24 h.
 * An entry with no usable timestamp counts as expired.
 */
// NATIVE_CONTRACT 39.1 S3
export function stateVisible(entry: SubtitleState | null | undefined, now: number): boolean {
  if (!entry) return false;
  if (typeof entry.savedAt !== 'number' || !Number.isFinite(entry.savedAt)) return false;
  const limit = entry.state === 'getting' ? GETTING_VISIBLE_MS : entry.state === 'saved' ? SAVED_VISIBLE_MS : NEEDS_LOOK_VISIBLE_MS;
  return now - entry.savedAt < limit;
}

function clean(raw: unknown): SubtitleState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.state !== 'getting' && o.state !== 'saved' && o.state !== 'needs-look' && o.state !== 'none') return null;
  // A state written without a timestamp is dropped: it counts as expired (S3).
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

/**
 * At app start no download can still be running, so every stored 'getting' entry is stale: remove them. Entries
 * that already expired are dropped too. Returns how many were removed.
 */
// NATIVE_CONTRACT 39.1 S3
export function clearStaleStates(now: number): number {
  const all = readAll();
  let removed = 0;
  for (const k of Object.keys(all)) {
    if (all[k].state === 'getting' || !stateVisible(all[k], now)) {
      delete all[k];
      removed++;
    }
  }
  if (removed > 0) writeAll(all);
  return removed;
}
