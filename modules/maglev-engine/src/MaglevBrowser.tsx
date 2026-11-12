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

export type MaglevBrowserProps = {
  url?: string;
  adBlock?: boolean;
  allowAdsHosts?: string[];
  desktopMode?: boolean;
  style?: StyleProp<ViewStyle>;
  onPage?: (e: BrowserPageEvent) => void;
  onFound?: (e: BrowserFoundEvent) => void;
  onBlockedCount?: (e: BrowserBlockedCountEvent) => void;
  onDownloadRequest?: (e: BrowserDownloadRequestEvent) => void;
  onMagnet?: (e: BrowserMagnetEvent) => void;
  onRefused?: (e: BrowserRefusedEvent) => void;
  onCrashed?: () => void;
  onPageNote?: (e: BrowserNoteEvent) => void;
};

export type MaglevBrowserRef = {
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  /** For a URL the user typed. Blocked hosts and local addresses may open when typed. */
  loadUrl(url: string): void;
  scan(): void;
  clearData(): void;
};

type NativeEvent<T> = { nativeEvent: T };
type NativeProps = {
  url?: string;
  adBlock?: boolean;
  allowAdsHosts?: string[];
  desktopMode?: boolean;
  style?: StyleProp<ViewStyle>;
  onPage?: (e: NativeEvent<BrowserPageEvent>) => void;
  onFound?: (e: NativeEvent<BrowserFoundEvent>) => void;
  onBlockedCount?: (e: NativeEvent<BrowserBlockedCountEvent>) => void;
  onDownloadRequest?: (e: NativeEvent<BrowserDownloadRequestEvent>) => void;
  onMagnet?: (e: NativeEvent<BrowserMagnetEvent>) => void;
  onRefused?: (e: NativeEvent<BrowserRefusedEvent>) => void;
  onCrashed?: (e: NativeEvent<object>) => void;
  onPageNote?: (e: NativeEvent<BrowserNoteEvent>) => void;
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
  { onPage, onFound, onBlockedCount, onDownloadRequest, onMagnet, onRefused, onCrashed, onPageNote, ...rest },
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
      clearData: () => nativeRef.current?.clearData(),
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
/** Clears the browser's cookies, cache, storage and history. Works without the browser screen open. */
export const clearBrowserData = () => call<object>('clearBrowserData');
