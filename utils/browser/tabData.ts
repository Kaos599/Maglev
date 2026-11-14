/**
 * Per-tab data every browser screen instance shares (docs/NATIVE_CONTRACT.md section 30): what each live tab's view
 * reported (page, found list, blocked count, ...), the address each view loaded when it mounted, the pop-up prompts,
 * and who owns the native views. View refs are not here; they stay per screen instance.
 */
import type { BrowserPageEvent, FoundItem } from 'maglev-engine';
import { emptyPopups, type PopupsState } from './popups.ts';

/** What the screen knows about one tab. */
export type TabData = {
  page: BrowserPageEvent | null;
  found: FoundItem[];
  // Remove and Clear only hide ids (NATIVE_CONTRACT 24.6a): the view keeps its tracker, so a re-requested file stays hidden.
  dismissed: ReadonlySet<string>;
  blocked: number;
  crashed: boolean;
  refused: 'ssl' | 'local' | null;
  lastUrl: string;
  notes: Set<string>;
};

export const newTabData = (): TabData => ({ page: null, found: [], dismissed: new Set(), blocked: 0, crashed: false, refused: null, lastUrl: '', notes: new Set() });

export const tabData = new Map<string, TabData>();
/** The address each view loaded when it mounted. It never follows the page. */
export const initialUrls = new Map<string, string>();

let popups: PopupsState = emptyPopups();
let owner: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

export function getTabData(id: string): TabData {
  let d = tabData.get(id);
  if (!d) {
    d = newTabData();
    tabData.set(id, d);
  }
  return d;
}

export const getPopups = (): PopupsState => popups;
export function setPopupsState(next: PopupsState): void {
  popups = next;
  notifyTabData();
}

/** Asks every subscribed screen to render again. */
export function notifyTabData(): void {
  version++;
  listeners.forEach((l) => l());
}
export const tabDataVersion = (): number => version;
export function subscribeTabData(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---- owner token: only the focused screen instance mounts native views ----

export const getViewOwner = (): string | null => owner;
export function setViewOwner(id: string): void {
  if (owner === id) return;
  owner = id;
  // The views of the old owner are going away and the new owner mounts fresh ones at each tab's current address.
  initialUrls.clear();
  tabData.clear();
  notifyTabData();
}
/** Gives the token up when the screen instance unmounts (its views go with it). Blur alone keeps it, so a blurred browser keeps its pages. */
export function releaseViewOwner(id: string): void {
  if (owner !== id) return;
  owner = null;
  initialUrls.clear();
  tabData.clear();
  notifyTabData();
}
