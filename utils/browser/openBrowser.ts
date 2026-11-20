/**
 * The one way to open the browser (docs/NATIVE_CONTRACT.md section 30). It goes to the Browse tab when that tab is
 * shown in the tab bar, so the tab set the user already has stays in one screen, and uses the /browser stack route
 * only when the tab is hidden. Params (`url`, `prefill`) reach the screen either way.
 */
import { visibleTabs } from '../../components/tabs/tabPrefs.ts';
import { getTabPrefs } from '../../components/tabs/tabPrefsStore.ts';

/** `newTab` always opens the url in a new tab, even when the current tab is blank. */
export type OpenBrowserParams = { url?: string; prefill?: string; newTab?: boolean };
export type OpenBrowserMode = 'push' | 'replace' | 'dismissTo';

/** The slice of the expo-router `router` this needs. */
export interface BrowserRouter {
  push(href: any): void;
  replace(href: any): void;
  navigate(href: any): void;
  dismissTo(href: any): void;
}

/** True when Browse is in the tab bar right now. */
const browseTabShown = (): boolean => visibleTabs(getTabPrefs(), { assistantEnabled: false }).includes('browse');

let openCounter = 0;

export function openBrowser(router: BrowserRouter, params?: OpenBrowserParams, mode: OpenBrowserMode = 'push'): void {
  const clean: Record<string, string> = {};
  if (params?.url) clean.url = params.url;
  if (params?.prefill) clean.prefill = params.prefill;
  const has = Object.keys(clean).length > 0;
  if (has) {
    // A fresh `open` value each time, so opening the same address again still reaches the mounted screen.
    clean.open = `${Date.now().toString(36)}-${++openCounter}`;
    if (params?.newTab && clean.url) clean.newTab = '1';
  }
  if (browseTabShown()) {
    router.navigate(has ? { pathname: '/browse', params: clean } : '/browse');
    return;
  }
  const href = has ? { pathname: '/browser', params: clean } : '/browser';
  router[mode](href);
}
