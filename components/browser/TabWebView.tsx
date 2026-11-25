import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useTheme } from '../../context/ThemeContext';
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
  type BrowserPullProgressEvent,
  type BrowserReloadStateEvent,
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
  /** 0.34 section 4: drag progress of a pull to reload (0 to 1.5). */
  onPullProgress(id: string, e: BrowserPullProgressEvent): void;
  /** 0.34 section 4: a reload started or ended. */
  onReloadState(id: string, e: BrowserReloadStateEvent): void;
};

export interface TabWebViewProps {
  id: string;
  /** The address the view loads when it mounts. It never follows the page. */
  url: string;
  /** 'link' when the address came from a deep link or card (never typed); 'typed' otherwise. Read at mount. */
  urlSource: 'typed' | 'link';
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
  /** Sites whose pop-ups are always refused (0.34 section 2). */
  popupBlockHosts: string[];
  /** Pull down at the top of the page to reload it. */
  pullToRefresh: boolean;
  /** Refuse third-party cookies (Settings › Browser › Privacy). Optional: defaults to true, today's behaviour. */
  blockThirdPartyCookies?: boolean;
  /** Try https:// first for http:// addresses (Settings › Browser › Advanced). Optional: defaults to true. */
  httpsFirst?: boolean;
  /** Spinner colours (theme accent and surface). */
  refreshColor: string;
  refreshBackground: string;
  /** Algorithmic darkening is allowed (the app is dark and "Dark pages" is on). */
  darkPages: boolean;
  handlers: TabHandlers;
  /** Hands the screen this tab's view ref (and null again on unmount). */
  register: (id: string, ref: React.RefObject<MaglevBrowserRef | null> | null) => void;
  /** Where the page sits during a tab swipe (docs/contracts-0.35/tab-switch.md). Only 'active' takes touches. */
  slot: PageSlotName;
  /** The swipe offset in page pixels, shared with the header bar. */
  offset?: SharedValue<number>;
  /** The width the pages occupy; a neighbour sits one page width beside the active one. */
  pageWidth?: SharedValue<number>;
}

/**
 * Where a page sits while the header is swiped. 'active' follows the offset; 'next' sits one page to the right and is
 * shown only while the offset is negative, 'prev' one page to the left, shown only while it is positive. 'hidden' is
 * invisible at rest.
 */
export type PageSlotName = 'active' | 'prev' | 'next' | 'hidden';

const SLOT_CODE: Record<PageSlotName, number> = { hidden: 0, active: 1, prev: 2, next: 3 };

export interface PageSlotProps {
  slot: PageSlotName;
  offset?: SharedValue<number>;
  pageWidth?: SharedValue<number>;
  pointerEvents: 'auto' | 'none';
  children: React.ReactNode;
}

/**
 * The moving sheet for one page. Position and visibility are worked out on the UI thread from the offset and a
 * per-view slot value, so a drag never re-renders React. The slot value changes in a layout effect, in the same
 * commit as the screen's offset reset, so the new slot and the reset reach the UI thread together. A view that has
 * just mounted starts hidden and takes its slot in that same layout effect.
 */
export function PageSlot({ slot, offset, pageWidth, pointerEvents, children }: PageSlotProps) {
  const { colors } = useTheme();
  const zero = useSharedValue(0);
  const off = offset ?? zero;
  const width = pageWidth ?? zero;
  const code = useSharedValue(SLOT_CODE.hidden);
  useLayoutEffect(() => {
    code.value = SLOT_CODE[slot];
  }, [code, slot]);
  const style = useAnimatedStyle(() => {
    const s = code.value;
    const o = off.value;
    if (s === 1) return { opacity: 1, transform: [{ translateX: o }] };
    if (s === 2) return { opacity: o > 0 ? 1 : 0, transform: [{ translateX: o - width.value }] };
    if (s === 3) return { opacity: o < 0 ? 1 : 0, transform: [{ translateX: o + width.value }] };
    return { opacity: 0, transform: [{ translateX: 0 }] };
  });
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]} pointerEvents={pointerEvents}>
      {children}
      {/* The seam between two pages: on the edge that faces the active page. Only a neighbour has it, and a neighbour
          is visible only mid-swipe, so it is gone at rest. */}
      {slot === 'next' || slot === 'prev' ? (
        <View pointerEvents="none" style={[styles.seam, slot === 'next' ? styles.seamLeft : styles.seamRight, { backgroundColor: colors.border }]} />
      ) : null}
    </Animated.View>
  );
}

/**
 * One native browser view for one tab. Stacked with the others by absolute fill; an inactive one is invisible and
 * ignores touches but stays mounted, so switching back is instant. A neighbour of the active tab is shown beside it
 * during a swipe, still paused (native `active` false) and without touches.
 */
export function TabWebView({ id, url, urlSource, active, slot, offset, pageWidth, adBlock, allowAdsHosts, desktopMode, textZoom, privateMode, popupPolicy, popupAllowHosts, popupBlockHosts, pullToRefresh, blockThirdPartyCookies = true, httpsFirst = true, refreshColor, refreshBackground, darkPages, handlers: h, register }: TabWebViewProps) {
  const ref = useRef<MaglevBrowserRef>(null);
  useEffect(() => {
    register(id, ref);
    return () => register(id, null);
  }, [id, register]);
  return (
    <PageSlot slot={slot} offset={offset} pageWidth={pageWidth} pointerEvents={active ? 'auto' : 'none'}>
    <MaglevBrowser
      ref={ref}
      url={url}
      urlSource={urlSource}
      active={active}
      adBlock={adBlock}
      allowAdsHosts={allowAdsHosts}
      desktopMode={desktopMode}
      textZoom={textZoom}
      privateMode={privateMode}
      popupPolicy={popupPolicy}
      popupAllowHosts={popupAllowHosts}
      popupBlockHosts={popupBlockHosts}
      pullToRefresh={pullToRefresh}
      blockThirdPartyCookies={blockThirdPartyCookies}
      httpsFirst={httpsFirst}
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
      onPullProgress={(e) => h.onPullProgress(id, e)}
      onReloadState={(e) => h.onReloadState(id, e)}
    />
    </PageSlot>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  seam: { position: 'absolute', top: 0, bottom: 0, width: 1 },
  seamLeft: { left: 0 },
  seamRight: { right: 0 },
});
