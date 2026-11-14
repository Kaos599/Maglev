import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  MaglevBrowser,
  type BrowserBlockedCountEvent,
  type BrowserDownloadRequestEvent,
  type BrowserFoundEvent,
  type BrowserLongPressEvent,
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
};

export interface TabWebViewProps {
  id: string;
  /** The address the view loads when it mounts. It never follows the page. */
  url: string;
  active: boolean;
  adBlock: boolean;
  allowAdsHosts: string[];
  desktopMode: boolean;
  popupPolicy: PopupPolicy;
  popupAllowHosts: string[];
  handlers: TabHandlers;
  /** Hands the screen this tab's view ref (and null again on unmount). */
  register: (id: string, ref: React.RefObject<MaglevBrowserRef | null> | null) => void;
}

/**
 * One native browser view for one tab. Stacked with the others by absolute fill; an inactive one is invisible and
 * ignores touches but stays mounted, so switching back is instant.
 */
export function TabWebView({ id, url, active, adBlock, allowAdsHosts, desktopMode, popupPolicy, popupAllowHosts, handlers: h, register }: TabWebViewProps) {
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
      popupPolicy={popupPolicy}
      popupAllowHosts={popupAllowHosts}
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
    />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { opacity: 0 },
});
