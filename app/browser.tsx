import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { BackHandler, Keyboard, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import {
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
import { ThemeColors, radius, spacing, type } from '../constants/theme';
import { haptic } from '../constants/haptics';
import { banners, browserTabs, empty, findCopy, foundTray, historyCopy, notices, textSizeCopy } from '../constants/copy';
import { PixelIcon } from '../components/PixelIcon';
import { Banner, Button, EmptyBlock, IconButton, ListRow, PressableScale, ProgressBar, Sheet, Toggle } from '../components/ui';
import { FoundTray } from '../components/browser/FoundTray';
import { TabWebView, type TabHandlers } from '../components/browser/TabWebView';
import { TabSwitcher } from '../components/browser/TabSwitcher';
import { FindBar, type FindResult } from '../components/browser/FindBar';
import { TextSizeSheet } from '../components/browser/TextSizeSheet';
import { LinkMenu } from '../components/browser/LinkMenu';
import { PopupCard } from '../components/browser/PopupCard';
import { useTabs } from '../components/browser/useTabs';
import { afterSheetCloses } from '../components/browser/FloatingSheet';
import { HistorySuggestions } from '../components/browser/HistorySuggestions';
import { StreamSheet } from '../components/browser/StreamSheet';
import { FoundDownloadSheet, downloadHeaders, type DownloadTarget } from '../components/browser/FoundDownload';
import { BatchSheet } from '../components/browser/BatchSheet';
import { runBatch } from '../components/browser/foundBatch';
import { startFound } from '../components/browser/startFound';
import { isInstaller, mergeFound, pruneToPage } from '../components/browser/foundFilter';
import { activeLabel, activeSummary, matchTransfers } from '../components/browser/foundTransfers';
import { dismissAllVisible, dismissIds, restoreIds, visibleFound } from '../components/browser/foundDismiss';
import { updateBrowserPrefs, useBrowserPrefs } from '../utils/prefs/browser';
import { flushTabs, recordVisit } from '../utils/history';
import { activeTab, backTarget, getTab, isBlank, liveTabs, switcherOrder } from '../utils/browser/tabs';
import * as popupsApi from '../utils/browser/popups';
import { emptyPopups, hostAllowed, type PopupRequest, type PopupsState } from '../utils/browser/popups';
import { hostOf, isAllowedHost, noticeAllowed, siteKey, toBrowserUrl, toggleAllowedHost } from '../utils/browserUrl';

/** A quiet notice for these, at most one every 5 seconds. */
const QUIET_NOTICE: Partial<Record<BrowserRefusalReason, string>> = {
  popup: notices.browser.popup,
  scheme: notices.browser.scheme,
  permission: notices.browser.permission,
};

/** How long the Undo row stays after Remove, Clear or closing tabs. */
const UNDO_MS = 5000;

/** What the screen knows about one tab. Lives in a map keyed by tab id, so switching tabs costs nothing. */
type TabData = {
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

const newData = (): TabData => ({ page: null, found: [], dismissed: new Set(), blocked: 0, crashed: false, refused: null, lastUrl: '', notes: new Set() });

export default function BrowserScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string; prefill?: string }>();
  const { showNotice, downloads, probeUrl, startDownload } = useMaglevEngine();
  const [prefs] = useBrowserPrefs();
  const tabs = useTabs();
  const tabsState = tabs.state;
  const ready = tabsState != null;

  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  // One view ref per live tab.
  const viewRefs = useRef(new Map<string, React.RefObject<MaglevBrowserRef | null>>());
  const registerView = useCallback((id: string, r: React.RefObject<MaglevBrowserRef | null> | null) => {
    if (r) viewRefs.current.set(id, r);
    else viewRefs.current.delete(id);
  }, []);
  // The address each view loaded when it mounted. It never follows the page (onPage.url is not fed back).
  const initialUrls = useRef(new Map<string, string>());

  // Per-tab state: a map in a ref plus a counter that asks for a render.
  const dataRef = useRef(new Map<string, TabData>());
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const getData = (id: string): TabData => {
    let d = dataRef.current.get(id);
    if (!d) {
      d = newData();
      dataRef.current.set(id, d);
    }
    return d;
  };
  const patch = useCallback((id: string, fn: (d: TabData) => void) => {
    let d = dataRef.current.get(id);
    if (!d) {
      d = newData();
      dataRef.current.set(id, d);
    }
    fn(d);
    bump();
  }, []);

  const tab = tabsState ? activeTab(tabsState) : null;
  const activeId = tab?.id ?? '';
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const data = getData(activeId);
  const page = data.page;
  const hasPage = !!tab && !isBlank(tab);
  const view = useCallback((id?: string) => viewRefs.current.get(id ?? activeIdRef.current)?.current ?? null, []);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const [prefillText, setPrefillText] = useState('');
  const [desktop, setDesktop] = useState(prefs.desktopMode);
  const blocked = data.blocked;
  const foundAll = data.found;
  const dismissed = data.dismissed;
  const [undo, setUndo] = useState<{ message: string; ids: string[] } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const found = useMemo(() => visibleFound(foundAll, dismissed), [foundAll, dismissed]);
  const [trayOpen, setTrayOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // Find in page (contract section 28) acts on one tab's view: findTab is the tab it was opened on.
  const [findOpen, setFindOpen] = useState(false);
  const [findResult, setFindResult] = useState<FindResult | null>(null);
  const findTab = useRef<string | null>(null);
  const [textSizeOpen, setTextSizeOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<BrowserLongPressEvent | null>(null);
  const [target, setTarget] = useState<DownloadTarget | null>(null);
  const [batchItems, setBatchItems] = useState<FoundItem[] | null>(null);
  const [streamItem, setStreamItem] = useState<FoundItem | null>(null);
  const [popups, setPopupsState] = useState<PopupsState>(emptyPopups);
  const popupsRef = useRef(popups);
  const setPopups = useCallback((fn: (p: PopupsState) => PopupsState) => {
    popupsRef.current = fn(popupsRef.current);
    setPopupsState(popupsRef.current);
  }, []);
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
    for (const id of [...dataRef.current.keys()]) if (id && !live.has(id)) dataRef.current.delete(id);
    for (const id of [...initialUrls.current.keys()]) if (!live.has(id)) initialUrls.current.delete(id);
    const ids = new Set([...Object.keys(popupsRef.current.prompts), ...Object.keys(popupsRef.current.blocked)]);
    for (const id of ids) if (!live.has(id)) setPopups((p) => popupsApi.drop(p, id, 'closed').state);
  }, [tabsState, setPopups]);

  // Switching tabs dismisses the long-press menu and the found list's Undo (they belong to the tab you left).
  useEffect(() => {
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
  const open = useCallback(
    (url: string) => {
      const id = activeIdRef.current;
      const cur = tabs.ref.current ? getTab(tabs.ref.current, id) : undefined;
      if (!cur) return;
      patch(id, (d) => {
        d.crashed = false;
        d.refused = null;
      });
      setPrefillText('');
      if (isBlank(cur)) tabs.update(id, { url });
      else view(id)?.loadUrl(url);
    },
    [tabs, patch, view],
  );

  const transfers = useMemo(() => matchTransfers(found, downloads), [found, downloads]);
  const active = useMemo(() => activeSummary(downloads), [downloads]);
  const openTransfers = useCallback(() => router.push('/'), [router]);
  const openTransfer = useCallback(
    (id: string) => {
      setTrayOpen(false);
      router.push({ pathname: '/', params: { download: id } });
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

  // `url` comes from this app (Add download, Open in browser) and opens in a new active tab (the active one when it is blank).
  // `prefill` comes from maglev://browser and only fills the bar of a blank tab.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    const key = `${params.url ?? ''}|${params.prefill ?? ''}`;
    if (key === '|' || key === handled.current) return;
    handled.current = key;
    const cur = tabs.ref.current ? activeTab(tabs.ref.current) : null;
    if (typeof params.url === 'string' && params.url.trim()) {
      const t = toBrowserUrl(params.url, prefs.searchEngine);
      if (t.kind === 'magnet') return toAddTorrent(t.uri);
      if (t.kind === 'empty') return;
      if (cur && isBlank(cur)) open(t.url);
      else openTabChecked({ url: t.url });
    } else if (typeof params.prefill === 'string') {
      if (cur && !isBlank(cur)) openTabChecked({});
      setPrefillText(params.prefill);
    }
  }, [ready, params.url, params.prefill, prefs.searchEngine, open, openTabChecked, toAddTorrent, tabs.ref]);

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
    setTimeout(() => inputRef.current?.focus(), 150);
  }, [openTabChecked]);

  const selectTab = useCallback(
    (id: string) => {
      setSwitcherOpen(false);
      setPrefillText('');
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
    const r = popupsApi.open(popupsRef.current, id);
    setPopups(() => r.state);
    if (r.request) runRequest(id, r.request);
  }, [setPopups, runRequest]);
  const popupBlock = useCallback(() => setPopups((p) => popupsApi.block(p, activeIdRef.current)), [setPopups]);
  const popupAlways = useCallback(() => {
    const id = activeIdRef.current;
    const r = popupsApi.allowForSite(popupsRef.current, id, prefs.popupAllowHosts);
    setPopups(() => r.state);
    if (r.host) updateBrowserPrefs(() => ({ popupAllowHosts: r.allowHosts }));
    if (r.request) runRequest(id, r.request);
  }, [setPopups, runRequest, prefs.popupAllowHosts]);

  // ---- back ----
  // Android back: leave a fullscreen video (the view reports canGoBack while one is up), then close the address bar,
  // find in page, the switcher, the long-press menu or the pop-up card, then go back in the page, then close a tab that has an opener, then leave.
  const handleBack = useCallback((): boolean => {
    if (editing) {
      inputRef.current?.blur();
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
  }, [editing, findOpen, closeFind, switcherOpen, linkTarget, prompt, popupBlock, tabs, activeId, page?.canGoBack, view]);
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', handleBack);
      return () => {
        sub.remove();
        void flushTabs();
      };
    }, [handleBack]),
  );

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
          // A new document starts a new list. Files already tagged with it (found before this event) stay.
          d.found = pruneToPage(d.found, e.url);
          d.dismissed = new Set();
        }
      });
      // A new document drops the highlights with it, so the find bar closes.
      if (newDocument && id === findTab.current) closeFind();
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
    onFound: (id, e) => patch(id, (d) => void (d.found = mergeFound(d.found, e.items))),
    onBlockedCount: (id, e) => patch(id, (d) => void (d.blocked = e.page)),
    onDownloadRequest: (id, e) => {
      const d = getData(id);
      // The navigation became a download: the page is not loading any more.
      patch(id, (x) => void (x.page = x.page && x.page.loading ? { ...x.page, loading: false } : x.page));
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
    onPopupBlocked: (id) => setPopups((p) => popupsApi.noteBlocked(p, id)),
    onLongPress: (id, e) => {
      if (id === activeIdRef.current) setLinkTarget(e);
    },
    onFindResult: (id, e) => {
      if (id === findTab.current) setFindResult(e);
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
  const idleText = page?.url ? pageHost : tab?.url ? pageHost : prefillText;
  const allowedHere = isAllowedHost(prefs.allowAdsHosts, pageHost);
  const popupsAllowedHere = hostAllowed(pageHost, prefs.popupAllowHosts);
  const popupsBlockedHere = popupsApi.blockedOnPage(popups, activeId);
  const loading = !!page?.loading;
  const tabCount = tabsState?.tabs.length ?? 1;

  const toggleAds = () => {
    const key = siteKey(pageHost);
    const nowAllowed = !allowedHere;
    updateBrowserPrefs((p) => ({ allowAdsHosts: toggleAllowedHost(p.allowAdsHosts, pageHost) }));
    haptic('select');
    setMenuOpen(false);
    showNotice({ message: nowAllowed ? notices.browser.adsAllowed(key) : notices.browser.adsBlocked(key) }, 3000);
    view()?.reload();
  };

  const togglePopups = () => {
    updateBrowserPrefs((p) => ({ popupAllowHosts: toggleAllowedHost(p.popupAllowHosts, pageHost) }));
    haptic('select');
    setMenuOpen(false);
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
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
      <View style={styles.bar}>
        <IconButton
          icon="back"
          accessibilityLabel="Go back"
          onPress={() => {
            if (!handleBack()) leave();
          }}
        />
        <View style={[styles.address, editing && styles.addressEditing]}>
          {!editing && page?.url ? (
            <PixelIcon
              name={page.secure ? 'lock' : 'warning'}
              size={16}
              color={page.secure ? colors.textMuted : colors.warning}
              accessibilityLabel={page.secure ? 'Secure connection' : 'Not secure'}
            />
          ) : null}
          <TextInput
            ref={inputRef}
            value={editing ? draft : idleText}
            onChangeText={(t) => {
              setSelection(undefined);
              setDraft(t);
            }}
            onFocus={() => {
              const full = page?.url || tab?.url || prefillText;
              setDraft(full);
              setEditing(true);
              setSelection({ start: 0, end: full.length });
              setTimeout(() => setSelection(undefined), 100);
            }}
            onBlur={() => setEditing(false)}
            onSubmitEditing={() => {
              haptic('tap');
              inputRef.current?.blur();
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
            placeholderTextColor={colors.textFaint}
            selectionColor={colors.accent}
            style={styles.input}
            numberOfLines={1}
            accessibilityLabel="Address"
          />
        </View>
        <IconButton
          icon={loading ? 'stop' : 'retry'}
          accessibilityLabel={loading ? 'Stop loading' : 'Reload'}
          disabled={!hasPage}
          onPress={() => {
            haptic('tap');
            if (loading) {
              view()?.stop();
              patch(activeId, (d) => void (d.page = d.page ? { ...d.page, loading: false } : d.page));
            } else view()?.reload();
          }}
        />
        <PressableScale
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
        </PressableScale>
        <IconButton icon="more" accessibilityLabel="More" disabled={!hasPage} onPress={() => setMenuOpen(true)} />
      </View>
      )}
      <View style={styles.progress}>{loading ? <ProgressBar progress={(page?.progress ?? 0) / 100} indeterminate={!page || page.progress <= 0} /> : null}</View>

      <View style={styles.body}>
        {tabsState
          ? liveTabs(tabsState)
              .filter((t) => !isBlank(t))
              .map((t) => {
                if (!initialUrls.current.has(t.id)) initialUrls.current.set(t.id, t.url);
                return (
                  <TabWebView
                    key={t.id}
                    id={t.id}
                    url={initialUrls.current.get(t.id) ?? t.url}
                    active={t.id === activeId}
                    adBlock={prefs.adBlock}
                    allowAdsHosts={prefs.allowAdsHosts}
                    desktopMode={desktop}
                    textZoom={prefs.browserTextZoom}
                    popupPolicy={prefs.popupPolicy}
                    popupAllowHosts={prefs.popupAllowHosts}
                    handlers={handlers}
                    register={registerView}
                  />
                );
              })
          : null}
        {!hasPage ? <EmptyBlock icon="network" title={empty.browser.start.title} body={empty.browser.start.body} /> : null}
        {editing ? (
          <HistorySuggestions
            text={draft}
            skip={page?.url || tab?.url || prefillText}
            onPick={(u) => {
              haptic('tap');
              inputRef.current?.blur();
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
      <PopupCard prompt={prompt} onOpen={popupOpen} onBlock={popupBlock} onAlwaysAllow={popupAlways} />

      <Sheet visible={menuOpen} onClose={() => setMenuOpen(false)} title="This page" subtitle={pageHost || undefined}>
        <ListRow
          icon="forward"
          title="Forward"
          disabled={!page?.canGoForward}
          onPress={() => {
            setMenuOpen(false);
            view()?.goForward();
          }}
        />
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
          <ListRow
            icon="external"
            title={browserTabs.thisPage.popupsRow}
            subtitle={popupsBlockedHere > 0 ? browserTabs.thisPage.blockedOnPage(popupsBlockedHere) : undefined}
            accessory={<Toggle value={popupsAllowedHere} onValueChange={togglePopups} accessibilityLabel={browserTabs.thisPage.popupsRow} />}
            onPress={togglePopups}
          />
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
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xs, minHeight: 56 },
    address: {
      flex: 1,
      minWidth: 44,
      height: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
    },
    addressEditing: { borderColor: c.borderStrong },
    input: { ...type.mono, flex: 1, minWidth: 0, fontSize: type.size.md, color: c.text, paddingVertical: 0 },
    tabButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    tabBox: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
      borderWidth: 2,
      borderColor: c.textMuted,
    },
    tabCount: { ...type.monoBold, fontSize: type.size.xs, lineHeight: 16, color: c.text },
    progress: { height: 3, overflow: 'hidden' },
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
      minHeight: 44,
      paddingHorizontal: spacing.md,
      justifyContent: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.download,
      backgroundColor: c.surface,
      flexShrink: 1,
    },
    activeText: { ...type.mono, fontSize: type.size.sm, color: c.download },
  });
