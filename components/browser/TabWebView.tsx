import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  MaglevBrowser,
  type BrowserBlockedCountEvent,
  type BrowserDownloadRequestEvent,
  type BrowserFindResultEvent,
  type BrowserFoundEvent,
  type BrowserLongPressEvent,
  type BrowserMediaHitEvent,
  type BrowserMagnetEvent,
  type BrowserNewWindowEvent,
  type BrowserNoteEvent,
  type BrowserPageEvent,
  type BrowserPopupBlockedEvent,
  type BrowserPopupRequestEvent,
  type BrowserRefusedEvent,
  type MaglevBrowserRef,
} from 'maglev-engine';
import type { PopupPolicy } from '../../utils/prefs/browser';
import { mediaHitScript } from '../../utils/browser/mediaHitScript';

/**
 * The page script needs no nonce: it reports through the native call `__maglevMediaHit()` after a long press, so the
 * per-page nonce of PageScan (which the view owns) is never used and '' is passed.
 */
const MEDIA_HIT_SCRIPT = mediaHitScript('');

/** Every handler gets the id of the tab whose view raised the event. */
export type TabHandlers = {
  onPage(id: string, e: BrowserPageEvent): void;
  onFound(id: string, e: BrowserFoundEvent): void;
  onBlockedCount(id: string, e: BrowserBlockedCountEvent): void;
  onDownloadRequest(id: string, e: BrowserDownloadRequestEvent): void;
  onMagnet(id: string, e: BrowserMagnetEvent): void;
  onRefused(id: string, e: BrowserRefusedEvent): void;
  onCrashed(id: string): void;
  onPageNote(id: string, e: BrowserNoteEvent): void;
  onNewWindow(id: string, e: BrowserNewWindowEvent): void;
  onPopupRequest(id: string, e: BrowserPopupRequestEvent): void;
  onPopupBlocked(id: string, e: BrowserPopupBlockedEvent): void;
  onLongPress(id: string, e: BrowserLongPressEvent): void;
  onFindResult(id: string, e: BrowserFindResultEvent): void;
  onMediaHit(id: string, e: BrowserMediaHitEvent): void;
};

export interface TabWebViewProps {
  id: string;
  /** The address the view loads when it mounts. It never follows the page. */
  url: string;
  active: boolean;
  adBlock: boolean;
  allowAdsHosts: string[];
  desktopMode: boolean;
  /** Page text size in percent (applies to every live tab). */
  textZoom: number;
  /** Private browsing: the view bypasses the page cache. */
  privateMode: boolean;
  popupPolicy: PopupPolicy;
  popupAllowHosts: string[];
  /** Pull down at the top of the page to reload it. */
  pullToRefresh: boolean;
  /** Spinner colours (theme accent and surface). */
  refreshColor: string;
  refreshBackground: string;
  /** Algorithmic darkening is allowed (the app is dark and "Dark pages" is on). */
  darkPages: boolean;
  handlers: TabHandlers;
  /** Hands the screen this tab's view ref (and null again on unmount). */
  register: (id: string, ref: React.RefObject<MaglevBrowserRef | null> | null) => void;
}

/**
 * One native browser view for one tab. Stacked with the others by absolute fill; an inactive one is invisible and
 * ignores touches but stays mounted, so switching back is instant.
 */
export function TabWebView({ id, url, active, adBlock, allowAdsHosts, desktopMode, textZoom, privateMode, popupPolicy, popupAllowHosts, pullToRefresh, refreshColor, refreshBackground, darkPages, handlers: h, register }: TabWebViewProps) {
  const ref = useRef<MaglevBrowserRef>(null);
  useEffect(() => {
    register(id, ref);
    return () => register(id, null);
  }, [id, register]);
  return (
    <View style={[StyleSheet.absoluteFill, !active && styles.hidden]} pointerEvents={active ? 'auto' : 'none'}>
    <MaglevBrowser
      ref={ref}
      url={url}
      active={active}
      adBlock={adBlock}
      allowAdsHosts={allowAdsHosts}
      desktopMode={desktopMode}
      textZoom={textZoom}
      privateMode={privateMode}
      popupPolicy={popupPolicy}
      popupAllowHosts={popupAllowHosts}
      pullToRefresh={pullToRefresh}
      refreshColor={refreshColor}
      refreshBackground={refreshBackground}
      darkPages={darkPages}
      mediaHitScript={MEDIA_HIT_SCRIPT}
      style={styles.fill}
      onPage={(e) => h.onPage(id, e)}
      onFound={(e) => h.onFound(id, e)}
      onBlockedCount={(e) => h.onBlockedCount(id, e)}
      onDownloadRequest={(e) => h.onDownloadRequest(id, e)}
      onMagnet={(e) => h.onMagnet(id, e)}
      onRefused={(e) => h.onRefused(id, e)}
      onCrashed={() => h.onCrashed(id)}
      onPageNote={(e) => h.onPageNote(id, e)}
      onNewWindow={(e) => h.onNewWindow(id, e)}
      onPopupRequest={(e) => h.onPopupRequest(id, e)}
      onPopupBlocked={(e) => h.onPopupBlocked(id, e)}
      onLongPress={(e) => h.onLongPress(id, e)}
      onFindResult={(e) => h.onFindResult(id, e)}
      onMediaHit={(e) => h.onMediaHit(id, e)}
    />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { opacity: 0 },
});
