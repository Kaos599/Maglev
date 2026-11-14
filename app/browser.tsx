import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Keyboard, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import {
  MaglevBrowser,
  nameFromUrl,
  type BrowserDownloadRequestEvent,
  type BrowserPageEvent,
  type BrowserRefusalReason,
  type FoundItem,
  type MaglevBrowserRef,
} from 'maglev-engine';
import { useTheme } from '../context/ThemeContext';
import { useMaglevEngine } from '../context/EngineContext';
import { ThemeColors, radius, spacing, type } from '../constants/theme';
import { haptic } from '../constants/haptics';
import { banners, empty, foundTray, notices } from '../constants/copy';
import { PixelIcon } from '../components/PixelIcon';
import { Banner, Button, EmptyBlock, IconButton, ListRow, PressableScale, ProgressBar, Sheet, Toggle } from '../components/ui';
import { FoundTray } from '../components/browser/FoundTray';
import { StreamSheet } from '../components/browser/StreamSheet';
import { FoundDownloadSheet, downloadHeaders, type DownloadTarget } from '../components/browser/FoundDownload';
import { BatchSheet } from '../components/browser/BatchSheet';
import { runBatch } from '../components/browser/foundBatch';
import { startFound } from '../components/browser/startFound';
import { isInstaller, mergeFound, pruneToPage } from '../components/browser/foundFilter';
import { activeLabel, activeSummary, matchTransfers } from '../components/browser/foundTransfers';
import { dismissAllVisible, dismissIds, restoreIds, visibleFound } from '../components/browser/foundDismiss';
import { updateBrowserPrefs, useBrowserPrefs } from '../utils/prefs/browser';
import { hostOf, isAllowedHost, noticeAllowed, siteKey, toBrowserUrl, toggleAllowedHost } from '../utils/browserUrl';

/** A quiet notice for these, at most one every 5 seconds. */
const QUIET_NOTICE: Partial<Record<BrowserRefusalReason, string>> = {
  popup: notices.browser.popup,
  scheme: notices.browser.scheme,
  permission: notices.browser.permission,
};

/** How long the Undo row stays after Remove or Clear. */
const UNDO_MS = 5000;

export default function BrowserScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string; prefill?: string }>();
  const { showNotice, downloads, probeUrl, startDownload } = useMaglevEngine();
  const [prefs] = useBrowserPrefs();

  const browserRef = useRef<MaglevBrowserRef>(null);
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  // `propUrl` is only ever what the user asked for. The address bar text comes from `page`, never from the prop.
  const [propUrl, setPropUrl] = useState<string | undefined>(undefined);
  const [started, setStarted] = useState(false);
  const [page, setPage] = useState<BrowserPageEvent | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const [prefillText, setPrefillText] = useState('');
  const [desktop, setDesktop] = useState(prefs.desktopMode);
  const [blocked, setBlocked] = useState(0);
  const [foundAll, setFound] = useState<FoundItem[]>([]);
  // Remove and Clear only hide ids (NATIVE_CONTRACT 24.6a): the view keeps its tracker, so a re-requested file stays hidden.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [undo, setUndo] = useState<{ message: string; ids: string[] } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const found = useMemo(() => visibleFound(foundAll, dismissed), [foundAll, dismissed]);
  const [trayOpen, setTrayOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [target, setTarget] = useState<DownloadTarget | null>(null);
  const [batchItems, setBatchItems] = useState<FoundItem[] | null>(null);
  const [streamItem, setStreamItem] = useState<FoundItem | null>(null);
  const [crashed, setCrashed] = useState(false);
  const [refused, setRefused] = useState<'ssl' | 'local' | null>(null);
  const lastNoticeAt = useRef(0);
  const lastPageUrl = useRef('');
  const notesShown = useRef(new Set<string>());

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const open = useCallback(
    (url: string) => {
      setCrashed(false);
      setRefused(null);
      if (!started) {
        setStarted(true);
        setPropUrl(url);
      } else {
        browserRef.current?.loadUrl(url);
      }
    },
    [started],
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

  // `url` comes from this app (Add download) and loads. `prefill` comes from maglev://browser and only fills the bar.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const key = `${params.url ?? ''}|${params.prefill ?? ''}`;
    if (key === '|' || key === handled.current) return;
    handled.current = key;
    if (typeof params.url === 'string' && params.url.trim()) go(params.url);
    else if (typeof params.prefill === 'string') setPrefillText(params.prefill);
  }, [params.url, params.prefill, go]);

  // Back leaves a fullscreen video or goes to the previous page first, then leaves the screen.
  const handleBack = useCallback((): boolean => {
    if (editing) {
      inputRef.current?.blur();
      Keyboard.dismiss();
      return true;
    }
    if (page?.canGoBack) {
      browserRef.current?.goBack();
      return true;
    }
    return false;
  }, [editing, page?.canGoBack]);
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', handleBack);
      return () => sub.remove();
    }, [handleBack]),
  );

  const onPage = useCallback((e: BrowserPageEvent) => {
    setPage(e);
    if (e.url !== lastPageUrl.current) {
      lastPageUrl.current = e.url;
      notesShown.current.clear();
      // A new document starts a new list. Files already tagged with it (found before this event) stay.
      setFound((prev) => pruneToPage(prev, e.url));
      setDismissed(new Set());
      setUndo(null);
    }
  }, []);

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
      setDismissed(r.next);
      offerUndo(foundTray.removed(item.name), r.added);
    },
    [dismissed, found, offerUndo],
  );

  const clearAll = useCallback(() => {
    const r = dismissAllVisible(dismissed, found);
    setDismissed(r.next);
    offerUndo(foundTray.cleared(r.added.length), r.added);
  }, [dismissed, found, offerUndo]);

  const undoDismiss = useCallback(() => {
    if (!undo) return;
    setDismissed((d) => restoreIds(d, undo.ids));
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(null);
  }, [undo]);

  // Empties what the screen hid and what it listed, then asks the view to report the page again.
  // VIEW_GONE means the view is already gone (the screen is closing), so a rejection is ignored.
  const scanAgain = useCallback(() => {
    setDismissed(new Set());
    setFound([]);
    setUndo(null);
    haptic('select');
    browserRef.current?.resetFound().catch(() => {});
  }, []);

  const onRefused = useCallback(
    (e: { reason: BrowserRefusalReason }) => {
      if (e.reason === 'ssl' || e.reason === 'local') {
        setRefused(e.reason);
        return;
      }
      const message = QUIET_NOTICE[e.reason];
      const now = Date.now();
      if (!message || !noticeAllowed(lastNoticeAt.current, now)) return;
      lastNoticeAt.current = now;
      showNotice({ message }, 3000);
    },
    [showNotice],
  );

  const onPageNote = useCallback(
    (e: { note: 'drm' | 'blob' }) => {
      if (notesShown.current.has(e.note)) return;
      notesShown.current.add(e.note);
      showNotice({ message: e.note === 'drm' ? notices.browser.drm : notices.browser.blob }, 5000);
    },
    [showNotice],
  );

  const onDownloadRequest = useCallback(
    (e: BrowserDownloadRequestEvent) => {
      // The navigation became a download: the page is not loading any more.
      setPage((p) => (p && p.loading ? { ...p, loading: false } : p));
      setTarget({
        url: e.url,
        name: e.name || nameFromUrl(e.url),
        size: e.size,
        pageUrl: e.referer || page?.url || '',
        userAgent: e.userAgent || page?.userAgent || '',
      });
    },
    [page?.url, page?.userAgent],
  );

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

  const pageHost = page ? hostOf(page.url) : '';
  const idleText = page?.url ? pageHost : prefillText;
  const allowedHere = isAllowedHost(prefs.allowAdsHosts, pageHost);
  const loading = !!page?.loading;

  const toggleAds = () => {
    const key = siteKey(pageHost);
    const nowAllowed = !allowedHere;
    updateBrowserPrefs((p) => ({ allowAdsHosts: toggleAllowedHost(p.allowAdsHosts, pageHost) }));
    haptic('select');
    setMenuOpen(false);
    showNotice({ message: nowAllowed ? notices.browser.adsAllowed(key) : notices.browser.adsBlocked(key) }, 3000);
    browserRef.current?.reload();
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
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
              const full = page?.url || prefillText;
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
          disabled={!started}
          onPress={() => {
            haptic('tap');
            if (loading) {
              browserRef.current?.stop();
              setPage((p) => (p ? { ...p, loading: false } : p));
            } else browserRef.current?.reload();
          }}
        />
        <IconButton icon="more" accessibilityLabel="More" disabled={!started} onPress={() => setMenuOpen(true)} />
      </View>
      <View style={styles.progress}>{loading ? <ProgressBar progress={(page?.progress ?? 0) / 100} indeterminate={!page || page.progress <= 0} /> : null}</View>

      <View style={styles.body}>
        {started ? (
          <MaglevBrowser
            ref={browserRef}
            url={propUrl}
            adBlock={prefs.adBlock}
            allowAdsHosts={prefs.allowAdsHosts}
            desktopMode={desktop}
            style={styles.web}
            onPage={onPage}
            onFound={(e) => setFound((prev) => mergeFound(prev, e.items))}
            onBlockedCount={(e) => setBlocked(e.page)}
            onDownloadRequest={onDownloadRequest}
            onMagnet={(e) => toAddTorrent(e.uri)}
            onRefused={onRefused}
            onCrashed={() => setCrashed(true)}
            onPageNote={onPageNote}
          />
        ) : (
          <EmptyBlock icon="network" title={empty.browser.start.title} body={empty.browser.start.body} />
        )}
        {refused ? (
          <View style={styles.floating}>
            <Banner
              tone="warning"
              title={refused === 'ssl' ? banners.browser.sslRefused.title : banners.browser.localRefused.title}
              body={refused === 'ssl' ? banners.browser.sslRefused.body : banners.browser.localRefused.body}
              onDismiss={() => setRefused(null)}
            />
          </View>
        ) : null}
        {crashed ? (
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
                  setCrashed(false);
                  browserRef.current?.reload();
                },
              }}
            />
          </View>
        ) : null}
      </View>

      {started ? (
        <View style={styles.footer}>
          <Text style={styles.blocked} accessibilityLiveRegion="none">
            {prefs.adBlock && blocked > 0 ? `${blocked} blocked` : ''}
          </Text>
          <View style={styles.footerActions}>
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
        </View>
      ) : null}

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

      <Sheet visible={menuOpen} onClose={() => setMenuOpen(false)} title="This page" subtitle={pageHost || undefined}>
        <ListRow
          icon="forward"
          title="Forward"
          disabled={!page?.canGoForward}
          onPress={() => {
            setMenuOpen(false);
            browserRef.current?.goForward();
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
            onPress={toggleAds}
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
          icon="settings"
          title="Browser settings"
          onPress={() => {
            setMenuOpen(false);
            router.push('/settings/browser');
          }}
        />
      </Sheet>
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
    progress: { height: 3, overflow: 'hidden' },
    body: { flex: 1 },
    web: { flex: 1 },
    floating: { position: 'absolute', left: spacing.md, right: spacing.md, top: spacing.md },
    crashed: { ...StyleSheet.absoluteFill, backgroundColor: c.bg, justifyContent: 'center' },
    footer: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    footerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
    activeChip: {
      minHeight: 44,
      paddingHorizontal: spacing.md,
      justifyContent: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.download,
      flexShrink: 1,
    },
    activeText: { ...type.mono, fontSize: type.size.sm, color: c.download },
    blocked: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
  });
