import React, { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, BackHandler, Keyboard, Share, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Pressable } from 'react-native-gesture-handler';
import * as Clipboard from 'expo-clipboard';
import {
  clearCookies,
  nameFromUrl,
  type BrowserDownloadRequestEvent,
  type BrowserLongPressEvent,
  type BrowserPageEvent,
  type BrowserRefusalReason,
  type FoundItem,
  type MaglevBrowserRef,
} from 'maglev-engine';
import { useTheme } from '../context/ThemeContext';
import { useMaglevEngine } from '../context/EngineContext';
import { ThemeColors, radius, spacing, touch, type } from '../constants/theme';
import { haptic } from '../constants/haptics';
import { bookmarkCopy } from '../constants/bookmarkCopy';
import { banners, browserTabs, empty, findCopy, foundTray, historyCopy, notices, textSizeCopy } from '../constants/copy';
import { PixelIcon } from '../components/PixelIcon';
import { Banner, Button, Chip, Dialog, EmptyBlock, IconButton, ListRow, PressableScale, ProgressBar, Sheet, TextField, type TextFieldRef, Toggle } from '../components/ui';
import { FoundTray } from '../components/browser/FoundTray';
import { TabWebView, type TabHandlers } from '../components/browser/TabWebView';
import { ReloadStrip, type ReloadStripHandle } from '../components/browser/ReloadStrip';
import { TabSwitcher } from '../components/browser/TabSwitcher';
import { AddressSwipe } from '../components/browser/AddressSwipe';
import { FindBar, type FindResult } from '../components/browser/FindBar';
import { TextSizeSheet } from '../components/browser/TextSizeSheet';
import { LinkMenu } from '../components/browser/LinkMenu';
import { PopupCard } from '../components/browser/PopupCard';
import { useTabs } from '../components/browser/useTabs';
import { afterSheetCloses } from '../components/browser/FloatingSheet';
import { HistorySuggestions } from '../components/browser/HistorySuggestions';
import { StartPage } from '../components/browser/StartPage';
import { MediaMenu } from '../components/browser/MediaMenu';
import { BookmarkToggle } from '../components/browser/BookmarkToggle';
import { BookmarkSheet } from '../components/browser/BookmarkSheet';
import { findBookmark, useBookmarks } from '../utils/browser/bookmarks';
import { StreamSheet } from '../components/browser/StreamSheet';
import { FoundDownloadSheet, downloadHeaders, type DownloadTarget } from '../components/browser/FoundDownload';
import { BatchSheet } from '../components/browser/BatchSheet';
import { runBatch } from '../components/browser/foundBatch';
import { startFound } from '../components/browser/startFound';
import { isInstaller, mergeFound, pruneToPage } from '../components/browser/foundFilter';
import { activeLabel, activeSummary, matchTransfers } from '../components/browser/foundTransfers';
import { dismissAllVisible, dismissIds, restoreIds, visibleFound } from '../components/browser/foundDismiss';
import { getBrowserPrefs, updateBrowserPrefs, useBrowserPrefs } from '../utils/prefs/browser';
import { keepHosts, privateSession } from '../utils/browser/privateSession';
import { hostsToWipe } from '../utils/browser/privateHosts';
import { buildMediaMenu, hasMenu, parseMediaHit, type MediaHit } from '../utils/browser/mediaHit';
import { flushTabs, recordVisit } from '../utils/history';
import { activeTab, backTarget, getTab, isBlank, liveTabs, switcherOrder } from '../utils/browser/tabs';
import * as popupsApi from '../utils/browser/popups';
import {
  getPopups,
  getTabData,
  getViewOwner,
  initialUrls,
  notifyTabData,
  releaseViewOwner,
  setPopupsState,
  setViewOwner,
  subscribeTabData,
  tabData,
  tabDataVersion,
  type TabData,
} from '../utils/browser/tabData';
import { DOWNLOAD_HELD_ACTION, DOWNLOAD_HELD_NOTICE, FOUND_HINT_MS, foundHintDue, foundHintText, opensSaveSheet } from '../utils/browser/hardening';
import { hostAllowed, type PopupRequest, type PopupsState } from '../utils/browser/popups';
import { hostOf, isAllowedHost, noticeAllowed, siteKey, toBrowserUrl, toggleAllowedHost } from '../utils/browserUrl';
import { recordPopupBlockStored } from '../utils/browser/popupLog';
import { browserSettingsCopy } from '../constants/browserSettingsCopy';

/** The site's pop-up choice in the ⋮ menu: Ask (neither list), Allow (allow list), Block (block list). */
type PopupSiteMode = 'ask' | 'allow' | 'block';

/** A quiet notice for these, at most one every 5 seconds. */
const QUIET_NOTICE: Partial<Record<BrowserRefusalReason, string>> = {
  popup: notices.browser.popup,
  scheme: notices.browser.scheme,
  permission: notices.browser.permission,
};

/** How long the Undo row stays after Remove, Clear or closing tabs. */
const UNDO_MS = 5000;

/** Browser screens currently mounted (the Browse tab and the /browser route can both be). */
let mountedScreens = 0;

/** inTab: shown inside the tab bar, which already pads for the system navigation area, so the bottom inset is skipped. */
export default function BrowserScreen({ inTab = false }: { inTab?: boolean }) {
  const { colors, dark } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string; open?: string; newTab?: string; source?: string }>();
  const { showNotice, downloads, probeUrl, startDownload } = useMaglevEngine();
  const [prefs] = useBrowserPrefs();
  const tabs = useTabs();
  const tabsState = tabs.state;
  const ready = tabsState != null;

  // Section 30: the Browse tab and the /browser stack route can both exist and share one tab set. Only the focused
  // instance mounts native views (it takes the owner token on focus), and a blurred or backgrounded browser pauses them.
  const instanceId = useId();
  const focused = useIsFocused();
  const [appForeground, setAppForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => setAppForeground(st === 'active'));
    return () => sub.remove();
  }, []);
  const isOwner = useSyncExternalStore(subscribeTabData, () => getViewOwner() === instanceId, () => false);
  useEffect(() => () => releaseViewOwner(instanceId), [instanceId]);
  // Shared per-tab data and pop-up prompts changed (any instance): render again.
  useSyncExternalStore(subscribeTabData, tabDataVersion, tabDataVersion);

  const inputRef = useRef<TextFieldRef>(null);
  // One view ref per live tab.
  const viewRefs = useRef(new Map<string, React.RefObject<MaglevBrowserRef | null>>());
  const registerView = useCallback((id: string, r: React.RefObject<MaglevBrowserRef | null> | null) => {
    if (r) viewRefs.current.set(id, r);
    else viewRefs.current.delete(id);
  }, []);
  // Per-tab state is shared by every instance (utils/browser/tabData.ts); `patch` changes it and asks every screen to render.
  const getData = getTabData;
  const patch = useCallback((id: string, fn: (d: TabData) => void) => {
    fn(getTabData(id));
    notifyTabData();
  }, []);

  const tab = tabsState ? activeTab(tabsState) : null;
  const activeId = tab?.id ?? '';
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  // 0.34 section 4: the reload train under the header. Fed only by the active tab; hidden when the tab changes.
  const reloadRef = useRef<ReloadStripHandle>(null);
  useEffect(() => {
    reloadRef.current?.reset();
  }, [activeId]);
  const data = getData(activeId);
  const page = data.page;
  const hasPage = !!tab && !isBlank(tab);
  const view = useCallback((id?: string) => viewRefs.current.get(id ?? activeIdRef.current)?.current ?? null, []);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const fullUrlRef = useRef('');
  fullUrlRef.current = page?.url || tab?.url || '';
  // Rule 8: the address TextInput is mounted only while editing, so Android can never hand it focus on its own.
  const startEditing = useCallback((url?: string) => {
    const full = url ?? fullUrlRef.current;
    setDraft(full);
    setSelection({ start: 0, end: full.length });
    setEditing(true);
    setTimeout(() => setSelection(undefined), 100);
  }, []);
  // A tab switch ends editing cleanly; a new tab (newTab) opens already editing and keeps it.
  const editTabRef = useRef(activeId);
  const keepEditingOnSwitch = useRef(false);
  useEffect(() => {
    if (editTabRef.current === activeId) return;
    editTabRef.current = activeId;
    if (keepEditingOnSwitch.current) keepEditingOnSwitch.current = false;
    else setEditing(false);
  }, [activeId]);
  // Tabs whose current load came from a deep link or the card (not typed). Read when the tab's view mounts (TabWebView urlSource).
  const linkTabs = useRef(new Set<string>());
  const [desktop, setDesktop] = useState(prefs.desktopMode);
  const blocked = data.blocked;
  const foundAll = data.found;
  const dismissed = data.dismissed;
  const [undo, setUndo] = useState<{ message: string; ids: string[] } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const found = useMemo(() => visibleFound(foundAll, dismissed), [foundAll, dismissed]);
  const [trayOpen, setTrayOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const bookmarks = useBookmarks();
  const [bookmarkEditOpen, setBookmarkEditOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // Find in page (contract section 28) acts on one tab's view: findTab is the tab it was opened on.
  const [findOpen, setFindOpen] = useState(false);
  const [findResult, setFindResult] = useState<FindResult | null>(null);
  const findTab = useRef<string | null>(null);
  const [textSizeOpen, setTextSizeOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<BrowserLongPressEvent | null>(null);
  const [mediaHit, setMediaHit] = useState<MediaHit | null>(null);
  const [clearSiteOpen, setClearSiteOpen] = useState(false);
  const [target, setTarget] = useState<DownloadTarget | null>(null);
  const [batchItems, setBatchItems] = useState<FoundItem[] | null>(null);
  const [streamItem, setStreamItem] = useState<FoundItem | null>(null);
  // 24.11: a one-line "Maglev found N files" note, once per page, until the tray opens or a few seconds pass.
  const [hintTab, setHintTab] = useState<string | null>(null);
  const hintShown = hintTab === activeId && data.hint === 'shown' && found.length > 0 && !trayOpen;
  useEffect(() => {
    if (!hasPage || !foundHintDue(found.length, data.hint, trayOpen)) return;
    patch(activeId, (d) => void (d.hint = 'shown'));
    setHintTab(activeId);
  }, [hasPage, found.length, data.hint, trayOpen, activeId, patch]);
  useEffect(() => {
    if (trayOpen && data.hint !== 'done') patch(activeId, (d) => void (d.hint = 'done'));
  }, [trayOpen, data.hint, activeId, patch]);
  useEffect(() => {
    if (!hintShown) return;
    const t = setTimeout(() => patch(activeId, (d) => void (d.hint = 'done')), FOUND_HINT_MS);
    return () => clearTimeout(t);
  }, [hintShown, activeId, patch]);
  const popups = getPopups();
  const setPopups = useCallback((fn: (p: PopupsState) => PopupsState) => setPopupsState(fn(getPopups())), []);
  const lastNoticeAt = useRef(0);
  // H1: a refused page and a crash page are never recorded. Both clear when the next page starts loading (kept per tab in `crashed` and `refused`).

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  // A tab that sleeps or closes loses its page state and any waiting pop-up (a waiting card counts as Blocked).
  useEffect(() => {
    if (!tabsState) return;
    const live = new Set(liveTabs(tabsState).map((t) => t.id));
    for (const id of [...tabData.keys()]) if (id && !live.has(id)) tabData.delete(id);
    for (const id of [...initialUrls.keys()]) if (!live.has(id)) initialUrls.delete(id);
    const ids = new Set([...Object.keys(getPopups().prompts), ...Object.keys(getPopups().blocked)]);
    for (const id of ids) if (!live.has(id)) setPopups((p) => popupsApi.drop(p, id, 'closed').state);
  }, [tabsState, setPopups]);

  // Switching tabs dismisses the long-press menu and the found list's Undo (they belong to the tab you left).
  useEffect(() => {
    setMediaHit(null);
    setClearSiteOpen(false);
    setLinkTarget(null);
    setUndo(null);
  }, [activeId]);

  // Removes the highlights and brings the address bar back. VIEW_GONE (the view is already gone) is ignored.
  const closeFind = useCallback(() => {
    const id = findTab.current;
    findTab.current = null;
    setFindOpen(false);
    setFindResult(null);
    if (id) view(id)?.clearFind().catch(() => {});
  }, [view]);

  // Switching tabs closes find on the tab you left.
  useEffect(() => {
    if (findTab.current && findTab.current !== activeId) closeFind();
  }, [activeId, closeFind]);

  const openFind = useCallback(() => {
    setMenuOpen(false);
    afterSheetCloses(() => {
      findTab.current = activeIdRef.current;
      setFindResult(null);
      setFindOpen(true);
    });
  }, []);

  const openTabChecked = useCallback(
    (opts: { url?: string; opener?: string | null; background?: boolean }) => {
      const r = tabs.open(opts);
      if (r.result === 'cap') showNotice({ message: browserTabs.capNotice }, 4000);
      return r;
    },
    [tabs, showNotice],
  );

  // Loads an address in the active tab. A blank tab has no view yet, so it gets the address and mounts one.
  // `fromLink` (a deep link or the card) only applies to a blank tab, which mounts its view with that source;
  // an address in a tab that already has a view is always typed (view.loadUrl).
  const open = useCallback(
    (url: string, fromLink = false) => {
      const id = activeIdRef.current;
      const cur = tabs.ref.current ? getTab(tabs.ref.current, id) : undefined;
      if (!cur) return;
      patch(id, (d) => {
        d.crashed = false;
        d.refused = null;
      });
      if (isBlank(cur)) {
        if (fromLink) linkTabs.current.add(id);
        else linkTabs.current.delete(id);
        tabs.update(id, { url });
      } else {
        linkTabs.current.delete(id);
        view(id)?.loadUrl(url);
      }
    },
    [tabs, patch, view],
  );

  const transfers = useMemo(() => matchTransfers(found, downloads), [found, downloads]);
  const active = useMemo(() => activeSummary(downloads), [downloads]);
  const openTransfers = useCallback(() => router.push('/'), [router]);
  const openTransfer = useCallback(
    (id: string) => {
      setTrayOpen(false);
      // NATIVE_CONTRACT 40.1: "go to the download" opens its page.
      router.push({ pathname: '/download/[id]', params: { id } });
    },
    [router],
  );

  const toAddTorrent = useCallback(
    (uri: string) => router.push({ pathname: '/add-torrent', params: { source: uri } }),
    [router],
  );

  const go = useCallback(
    (text: string) => {
      const t = toBrowserUrl(text, prefs.searchEngine);
      if (t.kind === 'empty') return;
      if (t.kind === 'magnet') return toAddTorrent(t.uri);
      open(t.url);
    },
    [prefs.searchEngine, open, toAddTorrent],
  );

  // `url` opens in a new active tab (the active one when it is blank). It comes from a deep link or the card
  // (`source=link`, never typed: the view applies the link-tap refusals) or from this app (Add download, bookmarks,
  // history, which keep the typed rules). Each deep link and each in-app open carries a fresh `open` nonce, so the
  // same address handed over twice loads twice.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (typeof params.url !== 'string' || !params.url.trim()) return;
    const key = `${params.url}|${params.open ?? ''}`;
    if (key === handled.current) return;
    handled.current = key;
    const t = toBrowserUrl(params.url, prefs.searchEngine);
    if (t.kind === 'magnet') return toAddTorrent(t.uri);
    if (t.kind === 'empty') return;
    const fromLink = params.source === 'link';
    const cur = tabs.ref.current ? activeTab(tabs.ref.current) : null;
    if (cur && isBlank(cur) && params.newTab !== '1') {
      open(t.url, fromLink);
    } else {
      const r = openTabChecked({ url: t.url });
      if (fromLink && r.id) linkTabs.current.add(r.id);
    }
  }, [ready, params.url, params.open, params.source, params.newTab, prefs.searchEngine, open, openTabChecked, toAddTorrent, tabs.ref]);

  // ---- tabs ----
  const closeWithUndo = useCallback(
    (ids: string[] | 'all') => {
      const u = ids === 'all' ? tabs.closeAll() : tabs.close(ids[0]);
      if (!u) return;
      showNotice(
        { message: ids === 'all' ? browserTabs.closedAll : browserTabs.closedTab, actionLabel: browserTabs.undo, onAction: () => tabs.undo(u) },
        UNDO_MS,
      );
    },
    [tabs, showNotice],
  );

  const newTab = useCallback(() => {
    const r = openTabChecked({});
    if (r.result !== 'ok') return;
    setSwitcherOpen(false);
    haptic('select');
    keepEditingOnSwitch.current = true;
    startEditing('');
  }, [openTabChecked, startEditing]);

  const selectTab = useCallback(
    (id: string) => {
      setSwitcherOpen(false);
      tabs.select(id);
    },
    [tabs],
  );

  // ---- pop-up card (T5) ----
  const prompt = popupsApi.promptFor(popups, activeId);
  const runRequest = useCallback(
    (id: string, req: PopupRequest) => {
      if (req.kind === 'window') {
        openTabChecked({ url: req.url, opener: id });
      } else if (req.kind === 'redirect') {
        view(id)?.followRedirect(req.url).catch(() => {});
      } else {
        view(id)
          ?.openApp(req.url)
          .then((r) => {
            if (r.opened) return;
            if (r.fallbackUrl) view(id)?.followRedirect(r.fallbackUrl).catch(() => {});
            else showNotice({ message: browserTabs.popup.noApp }, 4000);
          });
      }
    },
    [openTabChecked, view, showNotice],
  );
  const popupOpen = useCallback(() => {
    const id = activeIdRef.current;
    const r = popupsApi.open(getPopups(), id);
    setPopups(() => r.state);
    if (r.request) runRequest(id, r.request);
  }, [setPopups, runRequest]);
  // Scrim and Back: block this once, remember nothing.
  const popupDismiss = useCallback(() => setPopups((p) => popupsApi.dismiss(p, activeIdRef.current)), [setPopups]);
  // Block: this request and the site's later ones are refused, and the site joins the block list (0.34 §2 rule 3).
  const popupBlock = useCallback(() => {
    const id = activeIdRef.current;
    const r = popupsApi.blockForSite(getPopups(), id, getBrowserPrefs().popupBlockHosts);
    setPopups(() => r.state);
    const host = r.host;
    if (!host) return;
    updateBrowserPrefs((p) => ({ popupBlockHosts: popupsApi.addSiteHost(p.popupBlockHosts, host) }));
    showNotice(
      {
        message: browserSettingsCopy.popupCard.blockedOn(host),
        actionLabel: browserSettingsCopy.popupCard.undo,
        onAction: () => updateBrowserPrefs((p) => ({ popupBlockHosts: popupsApi.undoBlockForSite(p.popupBlockHosts, host) })),
      },
      5000,
    );
  }, [setPopups, showNotice]);
  const popupAlways = useCallback(() => {
    const id = activeIdRef.current;
    const r = popupsApi.allowForSite(getPopups(), id, prefs.popupAllowHosts);
    setPopups(() => r.state);
    if (r.host) {
      const host = r.host;
      // Never in both lists: allowing a site takes it off the block list.
      updateBrowserPrefs((p) => ({ popupAllowHosts: r.allowHosts, popupBlockHosts: popupsApi.removeSiteHost(p.popupBlockHosts, host) }));
    }
    if (r.request) runRequest(id, r.request);
  }, [setPopups, runRequest, prefs.popupAllowHosts]);

  // ---- back ----
  // Android back: leave a fullscreen video (the view reports canGoBack while one is up), then close the address bar,
  // find in page, the switcher, the long-press menu or the pop-up card, then go back in the page, then close a tab that has an opener, then leave.
  const handleBack = useCallback((): boolean => {
    if (editing) {
      inputRef.current?.blur();
      setEditing(false);
      Keyboard.dismiss();
      return true;
    }
    if (findOpen) {
      closeFind();
      return true;
    }
    if (switcherOpen) {
      setSwitcherOpen(false);
      return true;
    }
    if (linkTarget) {
      setLinkTarget(null);
      return true;
    }
    if (mediaHit) {
      setMediaHit(null);
      return true;
    }
    if (prompt) {
      popupBlock();
      return true;
    }
    const cur = tabs.ref.current;
    if (!cur) return false;
    const next = backTarget(cur, activeId, !!page?.canGoBack);
    if (next === 'goBack') {
      view()?.goBack();
      return true;
    }
    if (next === 'leave') return false;
    tabs.close(activeId);
    return true;
  }, [editing, findOpen, closeFind, switcherOpen, linkTarget, mediaHit, prompt, popupBlock, tabs, activeId, page?.canGoBack, view]);
  useFocusEffect(
    useCallback(() => {
      setViewOwner(instanceId);
      const sub = BackHandler.addEventListener('hardwareBackPress', handleBack);
      return () => {
        sub.remove();
        void flushTabs();
      };
    }, [handleBack, instanceId]),
  );

  // Private browsing: really leaving the browser wipes the cookies of the hosts seen. Moving between the Browse tab and
  // other tabs is not leaving (the tab screen stays mounted and its private tabs stay open), so this runs on unmount
  // only, and only when no other browser screen is still mounted after a short wait (the Browse tab and the /browser
  // route share one tab set). A session that is never left this way is wiped at the next app start (_layout.tsx).
  useEffect(() => {
    mountedScreens += 1;
    return () => {
      mountedScreens -= 1;
      setTimeout(() => {
        if (mountedScreens === 0) void privateSession.wipe();
      }, 300);
    };
  }, []);

  // ---- found list (per active tab) ----
  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  const offerUndo = useCallback((message: string, ids: string[]) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    if (ids.length === 0) return setUndo(null);
    setUndo({ message, ids });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  }, []);

  const removeOne = useCallback(
    (item: FoundItem) => {
      const r = dismissIds(dismissed, found, [item.id]);
      patch(activeIdRef.current, (d) => {
        d.dismissed = r.next;
      });
      offerUndo(foundTray.removed(item.name), r.added);
    },
    [dismissed, found, offerUndo, patch],
  );

  const clearAll = useCallback(() => {
    const r = dismissAllVisible(dismissed, found);
    patch(activeIdRef.current, (d) => {
      d.dismissed = r.next;
    });
    offerUndo(foundTray.cleared(r.added.length), r.added);
  }, [dismissed, found, offerUndo, patch]);

  const undoDismiss = useCallback(() => {
    if (!undo) return;
    patch(activeIdRef.current, (d) => {
      d.dismissed = restoreIds(d.dismissed, undo.ids);
    });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(null);
  }, [undo, patch]);

  // Empties what the screen hid and what it listed, then asks the view to report the page again.
  // VIEW_GONE means the view is already gone (the screen is closing), so a rejection is ignored.
  const scanAgain = useCallback(() => {
    patch(activeIdRef.current, (d) => {
      d.dismissed = new Set();
      d.found = [];
    });
    setUndo(null);
    haptic('select');
    view()?.resetFound().catch(() => {});
  }, [patch, view]);

  // ---- events from each tab's view (the id is the tab that raised it) ----
  const impl: TabHandlers = {
    onPage: (id, e) => {
      let skipRecord = false;
      let newDocument = false;
      patch(id, (d) => {
        d.page = e;
        if (e.loading) {
          d.crashed = false;
          d.refused = null;
        }
        skipRecord = d.crashed || d.refused != null;
        if (e.url !== d.lastUrl) {
          newDocument = true;
          d.lastUrl = e.url;
          d.notes.clear();
          d.hint = 'idle';
          // A new document starts a new list. Files already tagged with it (found before this event) stay.
          d.found = pruneToPage(d.found, e.url);
          d.dismissed = new Set();
        }
      });
      // A new document drops the highlights with it, so the find bar closes.
      if (newDocument && id === findTab.current) closeFind();
      // Private browsing: remember the host so its cookies are wiped when the browser is left (privateHosts.ts).
      if (getBrowserPrefs().privateBrowsing) privateSession.note(e.url);
      // H1: only a finished load is recorded. The store skips non-web addresses, repeats and the off setting.
      if (e.loading === false && !skipRecord) {
        recordVisit({ url: e.url, title: e.title ?? '' }).catch(() => {});
      }
      const cur = tabs.ref.current ? getTab(tabs.ref.current, id) : undefined;
      if (cur && e.url && (cur.url !== e.url || cur.title !== (e.title ?? ''))) {
        tabs.update(id, { url: e.url, title: e.title ?? '' });
        if (cur.url !== e.url) {
          setPopups((p) => popupsApi.drop(p, id, 'navigated').state);
          if (id === activeIdRef.current) setUndo(null);
        }
      }
    },
    onFound: (id, e) => {
      if (getBrowserPrefs().privateBrowsing) for (const it of e.items) privateSession.note(it.url);
      patch(id, (d) => void (d.found = mergeFound(d.found, e.items)));
    },
    onBlockedCount: (id, e) => patch(id, (d) => void (d.blocked = e.page)),
    onDownloadRequest: (id, e) => {
      if (getBrowserPrefs().privateBrowsing) privateSession.note(e.url);
      const d = getData(id);
      // The navigation became a download: the page is not loading any more.
      patch(id, (x) => void (x.page = x.page && x.page.loading ? { ...x.page, loading: false } : x.page));
      // 24.11: a download the page started without a tap only joins the Files list (the view already added it).
      if (!opensSaveSheet(e.tapped)) {
        // NATIVE_CONTRACT 39.2 B1: a held download is never silent; the notice opens the Files tray where it was listed.
        if (id === activeIdRef.current) {
          showNotice({ message: DOWNLOAD_HELD_NOTICE, actionLabel: DOWNLOAD_HELD_ACTION, onAction: () => setTrayOpen(true) }, 6000);
        }
        return;
      }
      setTarget({
        url: e.url,
        name: e.name || nameFromUrl(e.url),
        size: e.size,
        pageUrl: e.referer || d.page?.url || '',
        userAgent: e.userAgent || d.page?.userAgent || '',
      });
    },
    onMagnet: (_id, e) => toAddTorrent(e.uri),
    onRefused: (id, e) => {
      if (e.reason === 'ssl' || e.reason === 'local') {
        patch(id, (d) => void (d.refused = e.reason as 'ssl' | 'local'));
        return;
      }
      const message = QUIET_NOTICE[e.reason];
      const now = Date.now();
      if (id !== activeIdRef.current || !message || !noticeAllowed(lastNoticeAt.current, now)) return;
      lastNoticeAt.current = now;
      showNotice({ message }, 3000);
    },
    onCrashed: (id) => patch(id, (d) => void (d.crashed = true)),
    onPageNote: (id, e) => {
      const d = getData(id);
      if (id !== activeIdRef.current || d.notes.has(e.note)) return;
      d.notes.add(e.note);
      showNotice({ message: e.note === 'drm' ? notices.browser.drm : notices.browser.blob }, 5000);
    },
    onNewWindow: (id, e) => void openTabChecked({ url: e.url, opener: id }),
    onPopupRequest: (id, e) => setPopups((p) => popupsApi.request(p, id, { url: e.url, kind: e.kind, sourceUrl: e.sourceUrl })),
    onPopupBlocked: (id, e) => {
      setPopups((p) => popupsApi.noteBlocked(p, id));
      // 0.34 section 2 rule 5: the link and its source site go to the blocked pop-ups log (never in Private browsing).
      recordPopupBlockStored({ sourceUrl: e.sourceUrl, url: e.url, kind: e.kind, at: Date.now() }, getBrowserPrefs().privateBrowsing);
    },
    onLongPress: (id, e) => {
      if (id === activeIdRef.current) setLinkTarget(e);
    },
    onFindResult: (id, e) => {
      if (id === findTab.current) setFindResult(e);
    },
    // 24.10a: a long press over a video. The payload is checked in parseMediaHit; images stay on the link menu.
    onMediaHit: (id, e) => {
      if (id !== activeIdRef.current) return;
      const hit = parseMediaHit(e.json);
      if (hit && hit.kind === 'video' && hasMenu(buildMediaMenu(hit))) setMediaHit(hit);
    },
    // 0.34 section 4: the train follows the active tab only.
    onPullProgress: (id, e) => {
      if (id === activeIdRef.current) reloadRef.current?.pull(e.progress);
    },
    onReloadState: (id, e) => {
      if (id !== activeIdRef.current) return;
      if (e.state === 'start') reloadRef.current?.reloadStart();
      else reloadRef.current?.reloadEnd();
    },
  };
  const implRef = useRef(impl);
  implRef.current = impl;
  // The views get one stable object that always calls the latest handlers.
  const handlers = useMemo<TabHandlers>(() => {
    const keys = Object.keys(impl) as (keyof TabHandlers)[];
    return Object.fromEntries(keys.map((k) => [k, (...a: unknown[]) => (implRef.current[k] as (...x: unknown[]) => void)(...a)])) as unknown as TabHandlers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- link menu actions ----
  const openLinkInTab = useCallback(
    (url: string, background: boolean) => {
      const r = openTabChecked({ url, opener: activeIdRef.current, background });
      const id = r.id;
      if (background && id) {
        afterSheetCloses(() => showNotice({ message: browserTabs.openedInNewTab, actionLabel: browserTabs.switchTo, onAction: () => tabs.select(id) }, 5000));
      }
    },
    [openTabChecked, showNotice, tabs],
  );
  const downloadLink = useCallback(
    (url: string) => {
      const d = getData(activeIdRef.current);
      setTarget({ url, name: nameFromUrl(url), size: null, pageUrl: d.page?.url ?? '', userAgent: d.page?.userAgent ?? '' });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const notify = useCallback((message: string) => showNotice({ message }, 2500), [showNotice]);
  // A video manifest from the media menu goes through the same stream sheet as a found one.
  const streamFromHit = useCallback((hit: MediaHit, url: string, kind: 'hls' | 'dash') => {
    const d = getData(activeIdRef.current);
    setStreamItem({
      id: `media:${url}`,
      url,
      kind: 'video',
      mime: null,
      ext: null,
      name: nameFromUrl(url),
      size: null,
      width: null,
      height: null,
      source: 'page',
      stream: kind,
      pageUrl: hit.pageUrl || d.page?.url || '',
      pageTitle: d.page?.title ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 24.10a: "Clear this site's data". Cookies of the host and its parent domains (Search's hosts are left alone), then
  // local and session storage in the page, then a reload.
  const clearSiteData = useCallback(async () => {
    setClearSiteOpen(false);
    const id = activeIdRef.current;
    const url = getData(id).page?.url ?? '';
    const targets = hostsToWipe([url], keepHosts()).map((h) => `https://${h}/`);
    try {
      if (targets.length > 0) await clearCookies(targets);
    } catch {
      // Best effort: storage and reload still run.
    }
    try {
      await view(id)?.clearSiteStorage();
    } catch {
      // VIEW_GONE: the page is already closed.
    }
    view(id)?.reload();
    haptic('done');
    showNotice({ message: browserTabs.thisPage.clearSiteDone }, 3000);
  }, [view, showNotice]);

  // Each file goes through the single-download path. One failure never stops the rest; Retry runs the failed ones.
  const runBatchFor = useCallback(
    async (items: FoundItem[]) => {
      const deps = { headersFor: downloadHeaders, probeUrl, startDownload };
      const userAgent = page?.userAgent ?? '';
      const result = await runBatch(items, (item) =>
        startFound(deps, { url: item.url, pageUrl: item.pageUrl || page?.url || '', userAgent }),
      );
      haptic(result.failed.length === 0 ? 'commit' : 'fail');
      showNotice(
        {
          message: notices.browser.batchDone(result.added, result.duplicate, result.failed.length),
          ...(result.failed.length > 0 ? { actionLabel: 'Retry', onAction: () => void runBatchFor(result.failed) } : {}),
        },
        result.failed.length > 0 ? 8000 : 5000,
      );
    },
    [page?.url, page?.userAgent, probeUrl, startDownload, showNotice],
  );

  const pickFile = (item: FoundItem) => {
    setTrayOpen(false);
    setTarget({
      url: item.url,
      name: item.name,
      size: item.size,
      pageUrl: item.pageUrl || page?.url || '',
      userAgent: page?.userAgent ?? '',
      installer: isInstaller(item),
    });
  };

  const copy = async (text: string) => {
    try {
      await Clipboard.setStringAsync(text);
      haptic('done');
      showNotice({ message: notices.browser.linkCopied }, 2500);
    } catch {
      haptic('fail');
      showNotice({ message: notices.browser.linkCopyFailed });
    }
  };

  const pageHost = page ? hostOf(page.url) : tab?.url ? hostOf(tab.url) : '';
  const idleText = page?.url || tab?.url ? pageHost : '';
  const allowedHere = isAllowedHost(prefs.allowAdsHosts, pageHost);
  const popupsAllowedHere = hostAllowed(pageHost, prefs.popupAllowHosts);
  const popupsBlockedAtSite = hostAllowed(pageHost, prefs.popupBlockHosts);
  const popupsBlockedHere = popupsApi.blockedOnPage(popups, activeId);
  const loading = !!page?.loading;
  const tabCount = tabsState?.tabs.length ?? 1;

  // 0.34 section 3 rule 5: the page menu's Reload row, which shows Stop while the page loads.
  const reloadOrStop = () => {
    haptic('tap');
    if (loading) {
      view()?.stop();
      patch(activeId, (d) => void (d.page = d.page ? { ...d.page, loading: false } : d.page));
    } else view()?.reload();
  };

  const toggleAds = () => {
    const key = siteKey(pageHost);
    const nowAllowed = !allowedHere;
    updateBrowserPrefs((p) => ({ allowAdsHosts: toggleAllowedHost(p.allowAdsHosts, pageHost) }));
    haptic('select');
    setMenuOpen(false);
    showNotice({ message: nowAllowed ? notices.browser.adsAllowed(key) : notices.browser.adsBlocked(key) }, 3000);
    view()?.reload();
  };

  // 0.34 section 2 rule 4: the site's pop-up choice. A site is in at most one of the two lists.
  const popupSiteMode: PopupSiteMode = popupsBlockedAtSite ? 'block' : popupsAllowedHere ? 'allow' : 'ask';
  const popupChoices: { value: PopupSiteMode; label: string }[] = [
    { value: 'ask', label: browserSettingsCopy.popupSite.ask },
    { value: 'allow', label: browserSettingsCopy.popupSite.allow },
    { value: 'block', label: browserSettingsCopy.popupSite.block },
  ];
  const setPopupSite = (mode: PopupSiteMode) => {
    if (mode === popupSiteMode || !pageHost) return;
    // Drop every entry that covers this page (a parent site too), then add this site to the chosen list.
    const elsewhere = (list: string[]) => list.filter((e) => !popupsApi.hostAllowed(pageHost, [e]));
    updateBrowserPrefs((p) => ({
      popupAllowHosts: mode === 'allow' ? popupsApi.addSiteHost(elsewhere(p.popupAllowHosts), pageHost) : elsewhere(p.popupAllowHosts),
      popupBlockHosts: mode === 'block' ? popupsApi.addSiteHost(elsewhere(p.popupBlockHosts), pageHost) : elsewhere(p.popupBlockHosts),
    }));
    haptic('select');
  };

  return (
    <SafeAreaView style={styles.root} edges={inTab ? ['top', 'left', 'right'] : ['top', 'left', 'right', 'bottom']}>
      {findOpen ? (
        <FindBar
          result={findResult}
          onSearch={(q) => {
            setFindResult(null);
            const id = findTab.current;
            if (id) view(id)?.findInPage(q).catch(() => {});
          }}
          onStep={(forward) => {
            const id = findTab.current;
            if (id) view(id)?.findNext(forward).catch(() => {});
          }}
          onClose={closeFind}
        />
      ) : (
      <AddressSwipe
        strip={tabsState ? switcherOrder(tabsState) : []}
        activeId={activeId}
        enabled={!editing && ready}
        canFocusAddress={!editing && ready}
        onFocusAddress={() => startEditing()}
        onSelect={selectTab}
        onOpenSwitcher={() => setSwitcherOpen(true)}
        trailing={
          <>
            <Pressable
              onPress={() => {
                haptic('select');
                setSwitcherOpen(true);
              }}
              onLongPress={newTab}
              accessibilityRole="button"
              accessibilityLabel={browserTabs.tabButtonLabel(tabCount)}
              disabled={!ready}
              style={styles.tabButton}
            >
              <View style={styles.tabBox}>
                <Text style={styles.tabCount} numberOfLines={1}>
                  {tabCount > 99 ? browserTabs.tabButtonMany : tabCount}
                </Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => setMenuOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="More"
              disabled={!ready}
              style={styles.tabButton}
            >
              <PixelIcon name="more" size={20} color={colors.text} />
            </Pressable>
          </>
        }>
        <View style={[styles.address, editing && styles.addressEditing]}>
          {prefs.privateBrowsing ? (
            <PixelIcon name="shield" size={16} color={colors.accent} accessibilityLabel={historyCopy.settings.privateIndicator} />
          ) : null}
          {!editing && page?.url && findBookmark(bookmarks, page.url) ? (
            <PressableScale
              onPress={() => {
                haptic('select');
                setBookmarkEditOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={bookmarkCopy.savedIndicator}
              hitSlop={14}
              style={styles.savedIcon}
            >
              <PixelIcon name="bookmark" size={16} color={colors.accent} />
            </PressableScale>
          ) : null}
          {!editing && page?.url ? (
            <PixelIcon
              name={page.secure ? 'lock' : 'warning'}
              size={16}
              color={page.secure ? colors.textMuted : colors.warning}
              accessibilityLabel={page.secure ? 'Secure connection' : 'Not secure'}
            />
          ) : null}
          {!editing ? (
            // Rule 8: idle, the address is a plain label that can never take focus. AddressSwipe's tap calls startEditing.
            <View pointerEvents="none" style={styles.addressInput}>
              <Text
                style={[styles.idleLabel, !idleText && styles.idlePlaceholder]}
                numberOfLines={1}
                accessibilityRole="button"
                accessibilityLabel="Address"
                accessibilityHint="Double tap to type an address"
              >
                {idleText || 'Search or type an address'}
              </Text>
            </View>
          ) : (
          <View style={styles.addressInput}>
            <TextField
              bare
              mono
              autoFocus
              ref={inputRef}
              value={draft}
              onChangeText={(t) => {
                setSelection(undefined);
                setDraft(t);
              }}
              onBlur={() => setEditing(false)}
              onSubmitEditing={() => {
                haptic('tap');
                inputRef.current?.blur();
                setEditing(false);
                go(draft);
              }}
              selection={selection}
              selectTextOnFocus
              returnKeyType="go"
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              placeholder="Search or type an address"
              style={styles.input}
              numberOfLines={1}
              accessibilityLabel="Address"
            />
          </View>
          )}
        </View>
      </AddressSwipe>
      )}
      <View style={styles.progress}>{loading ? <ProgressBar progress={(page?.progress ?? 0) / 100} indeterminate={!page || page.progress <= 0} /> : null}</View>

      <View style={styles.body}>
        {tabsState && isOwner
          ? liveTabs(tabsState)
              .filter((t) => !isBlank(t))
              .map((t) => {
                if (!initialUrls.has(t.id)) initialUrls.set(t.id, t.url);
                return (
                  <TabWebView
                    key={t.id}
                    id={t.id}
                    url={initialUrls.get(t.id) ?? t.url}
                    urlSource={linkTabs.current.has(t.id) ? 'link' : 'typed'}
                    active={focused && appForeground && t.id === activeId}
                    adBlock={prefs.adBlock}
                    allowAdsHosts={prefs.allowAdsHosts}
                    desktopMode={desktop}
                    textZoom={prefs.browserTextZoom}
                    privateMode={prefs.privateBrowsing}
                    popupPolicy={prefs.popupPolicy}
                    popupAllowHosts={prefs.popupAllowHosts}
                    popupBlockHosts={prefs.popupBlockHosts}
                    blockThirdPartyCookies={prefs.blockThirdPartyCookies}
                    httpsFirst={prefs.httpsFirst}
                    pullToRefresh
                    refreshColor={colors.accent}
                    refreshBackground={colors.surface}
                    darkPages={prefs.darkPages && dark}
                    handlers={handlers}
                    register={registerView}
                  />
                );
              })
          : null}
        <ReloadStrip ref={reloadRef} />
        {!hasPage ? (
          <StartPage
            privateMode={prefs.privateBrowsing}
            onOpen={(url, o) => {
              haptic('tap');
              if (o?.newTab) openTabChecked({ url });
              else go(url);
            }}
          />
        ) : null}
        {editing ? (
          <HistorySuggestions
            text={draft}
            skip={page?.url || tab?.url || ''}
            onPick={(u) => {
              haptic('tap');
              inputRef.current?.blur();
              setEditing(false);
              Keyboard.dismiss();
              go(u);
            }}
          />
        ) : null}
        {data.refused ? (
          <View style={styles.floating}>
            <Banner
              tone="warning"
              title={data.refused === 'ssl' ? banners.browser.sslRefused.title : banners.browser.localRefused.title}
              body={data.refused === 'ssl' ? banners.browser.sslRefused.body : banners.browser.localRefused.body}
              onDismiss={() => patch(activeId, (d) => void (d.refused = null))}
            />
          </View>
        ) : null}
        {data.crashed ? (
          <View style={styles.crashed}>
            <EmptyBlock
              icon="warning"
              error
              title={empty.browser.crashed.title}
              body={empty.browser.crashed.body}
              primary={{
                label: 'Reload',
                onPress: () => {
                  haptic('tap');
                  patch(activeId, (d) => void (d.crashed = false));
                  view()?.reload();
                },
              }}
            />
          </View>
        ) : null}
        {hasPage ? (
          <View style={styles.overlay} pointerEvents="box-none">
            {active ? (
              <PressableScale
                onPress={() => {
                  haptic('select');
                  openTransfers();
                }}
                accessibilityRole="button"
                accessibilityLabel={foundTray.downloadingLabel(activeLabel(active))}
                style={styles.activeChip}
              >
                <Text style={styles.activeText} numberOfLines={1}>
                  {activeLabel(active)}
                </Text>
              </PressableScale>
            ) : null}
            <Button
              label={`Files · ${found.length}`}
              icon="file"
              variant="secondary"
              accessibilityLabel={`Files, ${found.length} found`}
              onPress={() => {
                haptic('select');
                setTrayOpen(true);
              }}
            />
          </View>
        ) : null}
        {hintShown ? (
          <View style={styles.hint} pointerEvents="none" accessibilityLiveRegion="polite">
            <Text style={styles.hintText}>{foundHintText(found.length)}</Text>
          </View>
        ) : null}
      </View>

      <FoundTray visible={trayOpen} items={found} userAgent={page?.userAgent ?? ''} onRemove={removeOne} onClear={clearAll} transfers={transfers} onOpenTransfer={openTransfer} onScanAgain={scanAgain} onDownloadSelected={(items) => { setTrayOpen(false); setBatchItems(items); }} undo={undo} onUndo={undoDismiss} onClose={() => setTrayOpen(false)} onPick={pickFile} onPickStream={(item) => { setTrayOpen(false); setStreamItem(item); }} />
      <BatchSheet items={batchItems} onClose={() => setBatchItems(null)} onStart={(items) => void runBatchFor(items)} />
      <FoundDownloadSheet target={target} onClose={() => setTarget(null)} onView={openTransfer} />

      <StreamSheet
        item={streamItem}
        pageTitle={page?.title}
        pageUrl={page?.url}
        userAgent={page?.userAgent}
        onClose={() => setStreamItem(null)}
        onCopyLink={(u) => void copy(u)}
      />

      <LinkMenu target={linkTarget} onClose={() => setLinkTarget(null)} openInTab={openLinkInTab} download={downloadLink} addTorrent={toAddTorrent} notify={notify} />
      <MediaMenu
        hit={mediaHit}
        onClose={() => setMediaHit(null)}
        onSave={(_h, u) => downloadLink(u)}
        onStream={streamFromHit}
        onOpenNewTab={(u) => openLinkInTab(u, false)}
        onCopy={(u) => void copy(u)}
        onShare={(u) => {
          Share.share({ message: u }).catch(() => {});
        }}
        onShowFound={() => setTrayOpen(true)}
        onDownloadPage={(u) => router.push({ pathname: '/add-download', params: { url: u } })}
        onLinkOptions={(href) => setLinkTarget({ kind: 'link', url: href, imageUrl: null, text: null })}
      />
      <PopupCard prompt={prompt} onAllowOnce={popupOpen} onBlock={popupBlock} onAlwaysAllow={popupAlways} onDismiss={popupDismiss} />

      <Sheet visible={menuOpen} onClose={() => setMenuOpen(false)} title={hasPage ? historyCopy.menuTitlePage : historyCopy.menuTitleBlank} subtitle={(hasPage && pageHost) || undefined}>
        <View style={styles.menuRow}>
          <IconButton
            icon="back"
            accessibilityLabel="Go back"
            disabled={!page?.canGoBack}
            onPress={() => {
              setMenuOpen(false);
              if (!handleBack()) leave();
            }}
          />
          <IconButton
            icon="forward"
            accessibilityLabel="Go forward"
            disabled={!page?.canGoForward}
            onPress={() => {
              setMenuOpen(false);
              view()?.goForward();
            }}
          />
          <IconButton
            icon={loading ? 'stop' : 'retry'}
            accessibilityLabel={loading ? 'Stop loading' : 'Reload page'}
            disabled={!hasPage}
            onPress={() => {
              setMenuOpen(false);
              reloadOrStop();
            }}
          />
        </View>
        {hasPage ? (
          <>
        <ListRow icon="search" title={findCopy.menuRow} onPress={openFind} />
        <ListRow
          icon="text-size"
          title={textSizeCopy.menuRow}
          value={textSizeCopy.value(prefs.browserTextZoom)}
          onPress={() => {
            setMenuOpen(false);
            afterSheetCloses(() => setTextSizeOpen(true));
          }}
        />
        <ListRow
          icon="interface"
          title="Desktop site"
          accessory={<Toggle value={desktop} onValueChange={setDesktop} accessibilityLabel="Desktop site" />}
        />
        {prefs.adBlock && pageHost ? (
          <ListRow
            icon="shield"
            title={allowedHere ? 'Block ads on this site' : 'Allow ads on this site'}
            subtitle={allowedHere ? 'Ads are allowed here' : blocked > 0 ? `${blocked} blocked on this page` : undefined}
            onPress={toggleAds}
          />
        ) : null}
        {pageHost ? (
          <>
            <ListRow
              icon="external"
              title={browserTabs.thisPage.popupsRow}
              subtitle={[browserSettingsCopy.popupSite.hint[popupSiteMode], popupsBlockedHere > 0 ? browserTabs.thisPage.blockedOnPage(popupsBlockedHere) : null].filter(Boolean).join(' · ')}
            />
            <View style={styles.popupChoices} accessibilityRole="radiogroup" accessibilityLabel={browserTabs.thisPage.popupsRow}>
              {popupChoices.map((c) => (
                <Chip key={c.value} label={c.label} role="radio" selected={popupSiteMode === c.value} onPress={() => setPopupSite(c.value)} />
              ))}
            </View>
          </>
        ) : null}
        <ListRow
          icon="copy"
          title="Copy page link"
          disabled={!page?.url}
          onPress={() => {
            setMenuOpen(false);
            if (page?.url) void copy(page.url);
          }}
        />
        <BookmarkToggle url={page?.url ?? tab?.url ?? ''} title={page?.title ?? tab?.title ?? ''} onDone={() => setMenuOpen(false)} />
        {/^https?:\/\//i.test(page?.url ?? '') ? (
          <ListRow
            icon="trash"
            title={browserTabs.thisPage.clearSiteRow}
            onPress={() => {
              setMenuOpen(false);
              afterSheetCloses(() => setClearSiteOpen(true));
            }}
          />
        ) : null}
          </>
        ) : null}
        <ListRow
          icon="bookmark"
          title={bookmarkCopy.menuRow}
          onPress={() => {
            setMenuOpen(false);
            router.push('/browser-bookmarks');
          }}
        />
        <ListRow
          icon="clock"
          title={historyCopy.menuRow}
          onPress={() => {
            setMenuOpen(false);
            router.push('/browser-history');
          }}
        />
        <ListRow
          icon="settings"
          title="Browser settings"
          onPress={() => {
            setMenuOpen(false);
            router.push('/settings/browser');
          }}
        />
      </Sheet>

      <Dialog
        visible={clearSiteOpen}
        onClose={() => setClearSiteOpen(false)}
        title={browserTabs.thisPage.clearSiteTitle}
        actions={
          <>
            <Button label={browserTabs.thisPage.clearSiteAction} variant="danger" fullWidth onPress={() => void clearSiteData()} />
            <Button label="Cancel" variant="secondary" fullWidth onPress={() => setClearSiteOpen(false)} />
          </>
        }
      >
        <Text style={styles.dialogBody}>{browserTabs.thisPage.clearSiteBody(pageHost)}</Text>
      </Dialog>

      <TextSizeSheet
        visible={textSizeOpen}
        value={prefs.browserTextZoom}
        onChange={(browserTextZoom) => updateBrowserPrefs({ browserTextZoom })}
        onClose={() => setTextSizeOpen(false)}
      />

      {switcherOpen && tabsState ? (
        <TabSwitcher
          tabs={switcherOrder(tabsState)}
          activeId={activeId}
          onSelect={selectTab}
          onClose={(id) => closeWithUndo([id])}
          onNewTab={newTab}
          onCloseAll={() => {
            setSwitcherOpen(false);
            closeWithUndo('all');
          }}
          onDismiss={() => setSwitcherOpen(false)}
        />
      ) : null}
      <BookmarkSheet visible={bookmarkEditOpen} onClose={() => setBookmarkEditOpen(false)} url={page?.url ?? ''} title={page?.title ?? ''} />
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    // The header bar itself lives in AddressSwipe. This is the text field's wrapper, which takes touches only while editing.
    addressInput: { flex: 1, minWidth: 0, flexDirection: 'row' },
    menuRow: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: spacing.sm },
    address: {
      flex: 1,
      minWidth: touch.min,
      height: touch.min,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
    },
    // A fixed 16×16 box centred in the bar, so the tappable icon lines up with the shield and lock beside it.
    savedIcon: { width: 16, height: 16, alignSelf: 'center', alignItems: 'center', justifyContent: 'center' },
    addressEditing: { borderColor: c.borderStrong },
    input: { fontSize: type.size.md, paddingVertical: 0 },
    idleLabel: { ...type.mono, flex: 1, minWidth: 0, color: c.text, fontSize: type.size.md, paddingVertical: 0 },
    idlePlaceholder: { color: c.textFaint },
    tabButton: { width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' },
    tabBox: {
      paddingHorizontal: 6, // design-exception: count pill inside the 44 px tab glyph
      paddingVertical: 2,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
      borderWidth: 2,
      borderColor: c.textMuted,
    },
    tabCount: { ...type.monoBold, fontSize: type.size.xs, lineHeight: 16, color: c.text },
    progress: { height: 3, overflow: 'hidden' },
    dialogBody: { ...type.body, color: c.textMuted },
    body: { flex: 1 },
    web: { flex: 1 },
    floating: { position: 'absolute', left: spacing.md, right: spacing.md, top: spacing.md },
    crashed: { ...StyleSheet.absoluteFill, backgroundColor: c.bg, justifyContent: 'center' },
    // Floats over the page, bottom-right. The body already ends at the tab bar and the safe area, so 12 px from the edges is enough.
    overlay: {
      position: 'absolute',
      left: spacing.md,
      right: spacing.md,
      bottom: spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: spacing.sm,
    },
    activeChip: {
      minHeight: touch.min,
      paddingHorizontal: spacing.md,
      justifyContent: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.download,
      backgroundColor: c.surface,
      flexShrink: 1,
    },
    activeText: { ...type.mono, fontSize: type.size.sm, color: c.download },
    // A one-line note above the Files button, bottom-right: 12 px edge + 44 px button + 8 px gap.
    hint: {
      position: 'absolute',
      right: spacing.md,
      bottom: spacing.md + touch.min + spacing.sm,
      maxWidth: '80%',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    hintText: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    popupChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  });
