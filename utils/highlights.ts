/**
 * When the new-feature highlight shows (docs/NATIVE_CONTRACT.md section 37.2). Pure: no React Native imports.
 */
import { HIGHLIGHTS, type Highlight } from '../constants/highlights.ts';

/** "0.28" or "0.28.0" as [major, minor], or null when it isn't a version. */
export function parseVersion(v: string | null | undefined): [number, number] | null {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?/.exec((v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Numeric "major.minor" order: negative, 0 or positive. Unreadable versions compare as 0.0. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const [am, an] = parseVersion(a) ?? [0, 0];
  const [bm, bn] = parseVersion(b) ?? [0, 0];
  return am - bm || an - bn;
}

export interface HighlightPlan {
  /** The entry to show, or null. */
  show: { version: string; highlight: Highlight } | null;
  /** True when `lastSeenVersion` should move to the installed version without showing anything. */
  advanceSilently: boolean;
}

/** The decision with its side effect named. `table` is for tests. */
export function highlightPlan(
  installed: string,
  lastSeen: string | null | undefined,
  firstInstall: boolean,
  enabled: boolean,
  table: Record<string, Highlight> = HIGHLIGHTS,
): HighlightPlan {
  // Onboarding covers a first install and sets lastSeenVersion itself.
  if (firstInstall) return { show: null, advanceSilently: false };
  if (compareVersions(installed, lastSeen) <= 0) return { show: null, advanceSilently: false };
  if (enabled) {
    const versions = Object.keys(table)
      .filter((v) => compareVersions(v, lastSeen) > 0 && compareVersions(v, installed) <= 0)
      .sort((a, b) => compareVersions(b, a));
    if (versions.length > 0) return { show: { version: versions[0], highlight: table[versions[0]] }, advanceSilently: false };
  }
  return { show: null, advanceSilently: true };
}

/** The entry to show now, or null (37.2). */
export function highlightToShow(
  installed: string,
  lastSeen: string | null | undefined,
  firstInstall: boolean,
  enabled: boolean,
  table: Record<string, Highlight> = HIGHLIGHTS,
): Highlight | null {
  return highlightPlan(installed, lastSeen, firstInstall, enabled, table).show?.highlight ?? null;
}

/**
 * Whether the launch was a plain one. A share, magnet, file or deep link hands the app a URL; a launcher start
 * hands it none (or only the bare scheme). The sheet waits for the next plain launch.
 */
export function isPlainLaunch(initialUrl: string | null | undefined): boolean {
  const u = (initialUrl ?? '').trim();
  return u === '' || /^[a-z][a-z0-9+.-]*:\/*$/i.test(u);
}
