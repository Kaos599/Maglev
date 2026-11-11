/**
 * Expo Router native intent handler. Android hands incoming VIEW intents to the router as URLs;
 * `redirectSystemPath` rewrites them before navigation.
 * API: https://docs.expo.dev/router/advanced/native-intent/ (type `NativeIntent` in expo-router: `redirectSystemPath({ path, initial })`
 * returns `string | Promise<string | null> | null`; a falsy value means no redirect).
 */

const ADD_ROUTE = '/add-torrent';

function addRoute(source: string): string {
  return `${ADD_ROUTE}?source=${encodeURIComponent(source)}`;
}

function isTorrentLocation(url: string): boolean {
  const pathPart = url.split(/[?#]/)[0];
  return /\.torrent$/i.test(pathPart);
}

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const raw = (path ?? '').trim();
    if (/^magnet:/i.test(raw)) return addRoute(raw);
    if (/^content:\/\//i.test(raw) || /^file:\/\//i.test(raw)) return addRoute(raw);
    if (/^https?:\/\//i.test(raw) && isTorrentLocation(raw)) return addRoute(raw);
    // Some launchers hand a file:// intent over with the scheme stripped: a bare absolute path.
    // Treat it as the local file it is, so it resolves like the document picker.
    if (/^\/(?!add-torrent\b).*\.torrent$/i.test(raw.split(/[?#]/)[0]) && !/^\/(torrent|settings|search|feeds)\//i.test(raw)) {
      return addRoute(`file://${raw}`);
    }
    // Some launchers pass the intent data as a router path with the magnet URI embedded after a slash.
    const embedded = /^\/?(magnet:.*)$/i.exec(raw);
    if (embedded) return addRoute(embedded[1]);
    return path;
  } catch {
    return '/';
  }
}
