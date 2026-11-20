/**
 * Where "Find videos on this page" (Quick Share card, maglev://browser?url=) lands.
 * The card opens maglev://browser; browserIntentRoute turns that into the stack route /browser?prefill=.
 * When the Browser tab is in the tab bar the same params go to the tab route /browse instead, so the
 * bottom bar stays and Back behaves like any tab. Pure, so scripts/test-share-tabs.js runs it directly.
 */
export function shareBrowserRoute(route: string, browseTabShown: boolean): string {
  if (!browseTabShown) return route;
  const m = /^\/browser(?=$|[?#])(.*)$/s.exec(route);
  return m ? `/browse${m[1]}` : route;
}
