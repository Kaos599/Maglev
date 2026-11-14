import * as React from 'react';
import { Platform, requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

/**
 * Binding for the native browser view `MaglevBrowserView` and the block list calls of the `MaglevEngine` module.
 * Contract: docs/NATIVE_CONTRACT.md section 24. Native side: modules/maglev-engine/android/.../browser/.
 *
 * Where the native view does not exist (web, or a build without it) the component shows a plain message. It never
 * shows made-up pages or files (AGENTS.md section 4.1).
 */

export type FoundKind = 'video' | 'audio' | 'image' | 'document' | 'other';

export type FoundItem = {
  /** Stable hash of the normalized URL. */
  id: string;
  url: string;
  kind: FoundKind;
  mime: string | null;
  ext: string | null;
  name: string;
  size: number | null;
  width: number | null;
  height: number | null;
  source: 'network' | 'page' | 'download';
  stream: null | 'hls' | 'dash';
  pageUrl: string;
  pageTitle: string;
};

export type BrowserClearOptions = { cookies: boolean; cache: boolean };

export type BrowserRefusalReason = 'popup' | 'scheme' | 'ssl' | 'permission' | 'local';

export type BrowserPageEvent = {
  url: string;
  title: string;
  /** True while a video is fullscreen too, so Back leaves fullscreen first. */
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** 0 to 100. */
  progress: number;
  secure: boolean;
  /** The user agent the page sees. Send it with a download of a found file. */
  userAgent: string;
};

export type BrowserFoundEvent = { items: FoundItem[] };
/** `page` is the count for this page load; `total` is the count since the browser opened. */
export type BrowserBlockedCountEvent = { page: number; total: number };
export type BrowserDownloadRequestEvent = {
  url: string;
  mime: string | null;
  size: number | null;
  name: string | null;
  userAgent: string;
  referer: string | null;
};
export type BrowserMagnetEvent = { uri: string };
export type BrowserRefusedEvent = { url: string; reason: BrowserRefusalReason };
/** `drm`: the page uses protected video. `blob`: the player streams in a way Maglev can't save. */
export type BrowserNoteEvent = { note: 'drm' | 'blob' };

export type PopupKind = 'window' | 'redirect' | 'app';
/** Open `url` in a new foreground tab with this tab as its opener. `gesture` is true for a tapped link or `window.open`. */
export type BrowserNewWindowEvent = { url: string; gesture: boolean };
/** The policy is `ask` and something the user didn't tap for wants to run. Nothing has happened yet. */
export type BrowserPopupRequestEvent = { url: string; kind: PopupKind; sourceUrl: string };
/** Refused under `block`, or by the always-refuse rules. Count it; never show a notice. */
export type BrowserPopupBlockedEvent = { url: string; kind: PopupKind };
/** A long press on a link or an image. `url` is an absolute http(s) address or `magnet:`; `imageUrl` an absolute http(s) address. */
export type BrowserLongPressEvent = {
  kind: 'link' | 'image' | 'imageLink';
  url: string | null;
  imageUrl: string | null;
  text: string | null;
};
/** `active` is 0-based. `total` is 0 when nothing matches. `done` is false while the page is still being counted. */
export type BrowserFindResultEvent = { active: number; total: number; done: boolean };
export type OpenAppResult = { opened: boolean; fallbackUrl: string | null };

export type MaglevBrowserProps = {
  url?: string;
  /** False for a tab in the background: the view pauses its page and media. Default true. */
  active?: boolean;
  popupPolicy?: 'ask' | 'block' | 'allow';
  /** Sites allowed to open pop-ups and redirects, matched on the page host by suffix. */
  popupAllowHosts?: string[];
  adBlock?: boolean;
  allowAdsHosts?: string[];
  desktopMode?: boolean;
  /** Page text size in percent, 50 to 200. Default 100. Pinch zoom is separate. */
  textZoom?: number;
  style?: StyleProp<ViewStyle>;
  onPage?: (e: BrowserPageEvent) => void;
  onFound?: (e: BrowserFoundEvent) => void;
  onBlockedCount?: (e: BrowserBlockedCountEvent) => void;
  onDownloadRequest?: (e: BrowserDownloadRequestEvent) => void;
  onMagnet?: (e: BrowserMagnetEvent) => void;
  onRefused?: (e: BrowserRefusedEvent) => void;
  onCrashed?: () => void;
  onPageNote?: (e: BrowserNoteEvent) => void;
  onNewWindow?: (e: BrowserNewWindowEvent) => void;
  onPopupRequest?: (e: BrowserPopupRequestEvent) => void;
  onPopupBlocked?: (e: BrowserPopupBlockedEvent) => void;
  onLongPress?: (e: BrowserLongPressEvent) => void;
  onFindResult?: (e: BrowserFindResultEvent) => void;
};

export type MaglevBrowserRef = {
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  /** For a URL the user typed. Blocked hosts and local addresses may open when typed. */
  loadUrl(url: string): void;
  scan(): void;
  /** Forget the files this page reported and scan it again. Rejects with VIEW_GONE once the view is destroyed. */
  resetFound(): Promise<void>;
  /** Cookies and web storage (`cookies`), cache and form data (`cache`). History is not part of it (contract 24.9). */
  clearData(options: BrowserClearOptions): void;
  /** Forget this screen's back/forward list. */
  clearHistoryList(): void;
  /** Loads a held redirect. Unlike `loadUrl` it doesn't count as typed, so the refusals still apply. */
  followRedirect(url: string): Promise<void>;
  /** Opens an intent:, market:, tel:, mailto: or custom-scheme address in another app. Call only after the user said yes. Never rejects. */
  openApp(url: string): Promise<OpenAppResult>;
  /** Highlights matches of `query` and reports them through onFindResult. Rejects with VIEW_GONE once the view is destroyed. */
  findInPage(query: string): Promise<void>;
  /** Moves to the next (`true`) or previous match. Rejects with VIEW_GONE once the view is destroyed. */
  findNext(forward: boolean): Promise<void>;
  /** Removes the highlights. Rejects with VIEW_GONE once the view is destroyed. */
  clearFind(): Promise<void>;
};

type NativeEvent<T> = { nativeEvent: T };
type NativeProps = {
  url?: string;
  active?: boolean;
  popupPolicy?: 'ask' | 'block' | 'allow';
  popupAllowHosts?: string[];
  adBlock?: boolean;
  allowAdsHosts?: string[];
  desktopMode?: boolean;
  textZoom?: number;
  style?: StyleProp<ViewStyle>;
  onPage?: (e: NativeEvent<BrowserPageEvent>) => void;
  onFound?: (e: NativeEvent<BrowserFoundEvent>) => void;
  onBlockedCount?: (e: NativeEvent<BrowserBlockedCountEvent>) => void;
  onDownloadRequest?: (e: NativeEvent<BrowserDownloadRequestEvent>) => void;
  onMagnet?: (e: NativeEvent<BrowserMagnetEvent>) => void;
  onRefused?: (e: NativeEvent<BrowserRefusedEvent>) => void;
  onCrashed?: (e: NativeEvent<object>) => void;
  onPageNote?: (e: NativeEvent<BrowserNoteEvent>) => void;
  onNewWindow?: (e: NativeEvent<BrowserNewWindowEvent>) => void;
  onPopupRequest?: (e: NativeEvent<BrowserPopupRequestEvent>) => void;
  onPopupBlocked?: (e: NativeEvent<BrowserPopupBlockedEvent>) => void;
  onLongPress?: (e: NativeEvent<BrowserLongPressEvent>) => void;
  onFindResult?: (e: NativeEvent<BrowserFindResultEvent>) => void;
};

let Native: any = null;
try {
  Native = Platform.OS === 'android' ? requireOptionalNativeModule('MaglevEngine') : null;
} catch {
  Native = null;
}

/** True when the native browser view can render (Android with the engine module). */
export const browserAvailable: boolean = Native != null;

const NativeBrowser: React.ComponentType<NativeProps & React.RefAttributes<MaglevBrowserRef>> | null =
  browserAvailable ? requireNativeViewManager<NativeProps>('MaglevEngine', 'MaglevBrowserView') : null;

const NOT_AVAILABLE = "The browser isn't available in this build.";

export const MaglevBrowser = React.forwardRef<MaglevBrowserRef, MaglevBrowserProps>(function MaglevBrowser(
  { onPage, onFound, onBlockedCount, onDownloadRequest, onMagnet, onRefused, onCrashed, onPageNote, onNewWindow, onPopupRequest, onPopupBlocked, onLongPress, onFindResult, ...rest },
  ref,
) {
  const nativeRef = React.useRef<MaglevBrowserRef | null>(null);
  React.useImperativeHandle(
    ref,
    () => ({
      goBack: () => nativeRef.current?.goBack(),
      goForward: () => nativeRef.current?.goForward(),
      reload: () => nativeRef.current?.reload(),
      stop: () => nativeRef.current?.stop(),
      loadUrl: (url: string) => nativeRef.current?.loadUrl(url),
      scan: () => nativeRef.current?.scan(),
      resetFound: () => nativeRef.current?.resetFound() ?? Promise.resolve(),
      clearData: (options: BrowserClearOptions) => nativeRef.current?.clearData(options),
      clearHistoryList: () => nativeRef.current?.clearHistoryList(),
      followRedirect: (url: string) => nativeRef.current?.followRedirect(url) ?? Promise.resolve(),
      findInPage: (query: string) => nativeRef.current?.findInPage(query) ?? Promise.resolve(),
      findNext: (forward: boolean) => nativeRef.current?.findNext(forward) ?? Promise.resolve(),
      clearFind: () => nativeRef.current?.clearFind() ?? Promise.resolve(),
      openApp: async (url: string): Promise<OpenAppResult> => {
        try {
          return (await nativeRef.current?.openApp(url)) ?? { opened: false, fallbackUrl: null };
        } catch {
          return { opened: false, fallbackUrl: null };
        }
      },
    }),
    [],
  );

  if (!NativeBrowser) {
    return (
      <View style={[styles.fallback, rest.style]}>
        <Text style={styles.fallbackText}>{NOT_AVAILABLE}</Text>
      </View>
    );
  }
  return (
    <NativeBrowser
      {...rest}
      ref={nativeRef}
      onPage={onPage ? (e) => onPage(e.nativeEvent) : undefined}
      onFound={onFound ? (e) => onFound(e.nativeEvent) : undefined}
      onBlockedCount={onBlockedCount ? (e) => onBlockedCount(e.nativeEvent) : undefined}
      onDownloadRequest={onDownloadRequest ? (e) => onDownloadRequest(e.nativeEvent) : undefined}
      onMagnet={onMagnet ? (e) => onMagnet(e.nativeEvent) : undefined}
      onRefused={onRefused ? (e) => onRefused(e.nativeEvent) : undefined}
      onCrashed={onCrashed ? () => onCrashed() : undefined}
      onPageNote={onPageNote ? (e) => onPageNote(e.nativeEvent) : undefined}
      onNewWindow={onNewWindow ? (e) => onNewWindow(e.nativeEvent) : undefined}
      onPopupRequest={onPopupRequest ? (e) => onPopupRequest(e.nativeEvent) : undefined}
      onPopupBlocked={onPopupBlocked ? (e) => onPopupBlocked(e.nativeEvent) : undefined}
      onLongPress={onLongPress ? (e) => onLongPress(e.nativeEvent) : undefined}
      onFindResult={onFindResult ? (e) => onFindResult(e.nativeEvent) : undefined}
    />
  );
});

const styles = StyleSheet.create({
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  fallbackText: { textAlign: 'center' },
});

// ---- block list calls (MaglevEngine module) ----

export type BlocklistErrorCode =
  | 'NETWORK'
  | 'HTTP_STATUS'
  | 'LIST_TOO_LARGE'
  | 'LIST_INVALID'
  | 'BLOCKED'
  | 'INVALID_ARGUMENT'
  | 'ENGINE_UNAVAILABLE'
  | 'INTERNAL';

export type BlocklistResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: BlocklistErrorCode; message: string };

export type BlocklistInfo = {
  domains: number;
  /** Epoch milliseconds of the last update, or null for the built-in list. */
  updatedAt: number | null;
  source: 'bundled' | 'downloaded';
  urls: string[];
  bytes: number;
};

const unavailable = (): { ok: false; code: BlocklistErrorCode; message: string } => ({
  ok: false,
  code: 'ENGINE_UNAVAILABLE',
  message: NOT_AVAILABLE,
});

async function call<T>(name: string, ...args: unknown[]): Promise<BlocklistResult<T>> {
  try {
    if (typeof Native?.[name] !== 'function') return unavailable();
    return (await Native[name](...args)) as BlocklistResult<T>;
  } catch (e: any) {
    return { ok: false, code: 'INTERNAL', message: String(e?.message ?? e) };
  }
}

/** Fetches the lists (https only), merges them and replaces the active list. The old list stays on failure. */
export const updateBlocklist = (urls: string[]) => call<BlocklistInfo>('updateBlocklist', urls);
export const getBlocklistInfo = () => call<BlocklistInfo>('getBlocklistInfo');
/** Back to the built-in list. */
export const resetBlocklist = () => call<BlocklistInfo>('resetBlocklist');
/**
 * Clears the browser's cookies and web storage (`cookies`) and cache and form data (`cache`). History is cleared by
 * `clearHistoryRange('all')` in utils/history. Works without the browser screen open.
 */
export const clearBrowserData = (options: BrowserClearOptions = { cookies: true, cache: true }) => call<object>('clearBrowserData', options);

/** Tells native whether to empty the history when Maglev closes (contract 24.9). Resolves quietly where there is no native module. */
export async function setHistoryWipeOnClose(enabled: boolean): Promise<void> {
  try {
    if (typeof Native?.setHistoryWipeOnClose === 'function') await Native.setHistoryWipeOnClose(enabled);
  } catch {
    // The JS cold-start wipe still runs.
  }
}

/**
 * How many times native emptied the history because Maglev closed (contract section 30). JS compares it with the last
 * count it saw to know the in-memory tabs are stale. 0 where there is no native module (the mock).
 */
export async function getHistoryWipeCount(): Promise<number> {
  try {
    if (typeof Native?.getHistoryWipeCount === 'function') {
      const n = Number(await Native.getHistoryWipeCount());
      return Number.isFinite(n) ? n : 0;
    }
  } catch {
    // Treated as no wipe.
  }
  return 0;
}
