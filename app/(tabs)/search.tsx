import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, Dimensions, ScrollView, StyleSheet, Text, View, findNodeHandle, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useMaglevEngine } from '../../context/EngineContext';
import { useSettings } from '../../context/SettingsContext';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { PixelIcon } from '../../components/PixelIcon';
import { Button, Chip, EmptyBlock, IconButton, PressableScale, Screen, Sheet, TextField, type TextFieldRef } from '../../components/ui';
import { ResultRow } from '../../components/search/ResultRow';
import { SKELETON_FIRST_COUNT, SKELETON_MORE_COUNT, SkeletonRows } from '../../components/search/SkeletonRows';
import { seenRowCount, stableOrder } from '../../components/search/stableOrder';
import { prefetchAllowed } from '../../components/search/prefetch';
import { magnetHash, metadataPrefetch } from '../../components/search/metadataCache';
import { useTabPrefs } from '../../components/tabs/tabPrefsStore';
import { SORT_LABEL, SortFilterSheet, type SortKey } from '../../components/search/SortFilterSheet';
import { FollowSheet } from '../../components/search/FollowSheet';
import { followRuleFromResult, type FollowTarget } from '../../utils/follow';
import { NoticeBanner, addErrorNotice, useNotice, type NoticeState } from '../../components/search/Notice';
import { buildExtraProviders, loadExtraProviders } from '../../components/search/extra';
import { CATEGORY_LABEL, formatAge, providerMap } from '../../components/search/meta';
import { admit, oneTapDecision, pendingNeedOf } from '../../utils/admission';
import { formatBytes } from '../../constants/format';
import { riskySources } from '../../utils/search/safety';
import { addRecentSearch, clearRecentSearches, getSearchPrefs, removeRecentSearch, useSearchPrefs } from '../../utils/prefs/search';
import { availableCategories, directAddRoute, eligibleProviders, mergeInto, rerunProvider, resolveResult, searchAll } from '../../utils/search/aggregate';
import { CloudflareSolverSheet } from '../../components/search/CloudflareSolverSheet';
import { nextNeedsCheck, resultsSummary, shouldShowFixHint, sourcesLine, tallySources, unansweredSources } from '../../utils/search/answered';
import { formatAgeLong } from '../../utils/search/age';
import { CATEGORY_ORDER, type Category, type MergedResult, type SearchUpdate } from '../../utils/search/types';
import { ResultPreviewSheet } from '../../components/search/ResultPreviewSheet';
import { UnansweredSheet } from '../../components/search/UnansweredSheet';
import { MobileDataSheet } from '../../components/search/MobileDataSheet';
import { passesResultFilter } from '../../components/search/sharing';
import { SIZE_STOPS, toFilter } from '../../components/search/sizeRange';
import { oneTapAddNote } from '../../utils/addChecks';
import { SEARCH_TURN_ON_MORE, empty, watchCopy } from '../../constants/copy';
import { countOffSources } from '../../utils/search/offSources';
import { addWatchToStore } from '../../utils/watch/store';
import { Reveal } from '../../components/motion';
import { openBrowser } from '../../utils/browser/openBrowser';
import { noteOrigin } from '../../utils/stats/sourceStore';
import { useAddedTray } from '../../components/search/AddedTray';
import { useSubtitleAvailability } from '../../components/subtitles/useSubtitleEntry';
import { bannerPlan, buildAsk } from '../../utils/addedTray';
import { isVideoResult } from '../../utils/mediaKind';

const DEBOUNCE_MS = 400;
const MIN_QUERY = 2;
/** The top row must hold its place this long, while sources still answer, before its file list is read. */
const PREFETCH_STABLE_MS = 1500;
/** After every source answered, a short pause so the read never competes with the last render. */
const PREFETCH_SETTLED_MS = 300;

const keyOfResult = (r: MergedResult) => r.infoHash;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const announce = (text: string) => AccessibilityInfo.announceForAccessibility(text);
/** Moves screen reader focus to a view after a beat, once the view it replaces has gone. */
function focusView(node: unknown, delay = 100) {
  setTimeout(() => {
    const tag = node ? findNodeHandle(node as never) : null;
    if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
  }, delay);
}

/** The one line in the list that is not a result: "N sources need a quick check". */
interface FixHintItem {
  fixHint: true;
}
type ListItem = MergedResult | FixHintItem;
const FIX_AFTER = 3;

/** Missing numbers sort last in every numeric order. */
function sortResults(list: MergedResult[], sort: SortKey): MergedResult[] {
  const num = (a: number | undefined, b: number | undefined) => (b ?? -1) - (a ?? -1);
  const copy = [...list];
  switch (sort) {
    case 'seeders':
      return copy.sort((a, b) => num(a.seeders, b.seeders));
    case 'newest':
      return copy.sort((a, b) => num(a.publishedAt, b.publishedAt));
    case 'size':
      return copy.sort((a, b) => num(a.sizeBytes, b.sizeBytes));
    case 'name':
      return copy.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export default function SearchScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { startTorrent, restartEngine, telemetry, getFreeSpace, downloads, onMeteredNetwork } = useMaglevEngine();
  const { settings } = useSettings();
  const [prefs, updatePrefs] = useSearchPrefs();

  const [query, setQuery] = useState('');
  // An optional `q` route param (from assistant links) prefills the query once, then is cleared.
  // The search effect below runs on the trimmed query, so setting it starts the search.
  // `c` (a category) comes with it from a Watch notification.
  const { q: qParam, c: cParam } = useLocalSearchParams<{ q?: string; c?: string }>();
  useEffect(() => {
    if (typeof qParam !== 'string' || !qParam.trim()) return;
    setQuery(qParam);
    if (typeof cParam === 'string' && (CATEGORY_ORDER as string[]).includes(cParam)) updatePrefs({ lastCategory: cParam as Category });
    router.setParams({ q: undefined, c: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qParam, router]);
  const [searching, setSearching] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [update, setUpdate] = useState<SearchUpdate | null>(null);
  const [failed, setFailed] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  // One switch with Settings > Search sources > Hide dead torrents: the sheet shows and changes the saved setting.
  const hideNoShare = prefs.hideDead;
  const setHideNoShare = useCallback((hideDead: boolean) => updatePrefs({ hideDead }), [updatePrefs]);
  const [sizeRange, setSizeRange] = useState({ low: 0, high: SIZE_STOPS.length - 1 });
  const [preview, setPreview] = useState<MergedResult | null>(null);
  const [mobileAsk, setMobileAsk] = useState<{ result: MergedResult; note: string } | null>(null);
  const [recents, setRecents] = useState<string[]>(() => prefs.recents);
  const [sessionAdded, setSessionAdded] = useState<Set<string>>(() => new Set());
  // Adds in flight (NATIVE_CONTRACT 44.4): each row with its add under way shows a spinner, however many are running.
  const [busyHashes, setBusyHashes] = useState<Set<string>>(() => new Set());
  const setBusy = useCallback((hash: string, on: boolean) => {
    setBusyHashes((prev) => {
      if (prev.has(hash) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(hash);
      else next.delete(hash);
      return next;
    });
  }, []);
  const [retryTick, setRetryTick] = useState(0);
  const [confirm, setConfirm] = useState<{ result: MergedResult; reason: string } | null>(null);
  const [solving, setSolving] = useState<string | null>(null);
  // True while the user is working through the "needs a quick check" line: after one solve, the next opens.
  const fixing = useRef(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<TextFieldRef>(null);
  const sortBtnRef = useRef<any>(null);
  const fixBtnRef = useRef<any>(null);
  const recentRows = useRef(new Map<string, any>());
  // Per search (request id): which spoken updates have been made, so each is said once.
  const spoken = useRef({ start: 0, end: 0, fix: 0 });
  // The Fix banner animates in only the first time it shows in a search, not each time a list row is recycled.
  const fixSeen = useRef(0);
  const tabs = useTabPrefs();
  const browserTabShown = !tabs.hidden.includes('browse');
  const [following, setFollowing] = useState<FollowTarget | null>(null);
  const followCache = useRef(new Map<string, FollowTarget | null>());
  const { notice, show: showBanner, dismiss } = useNotice();
  // One slot for the Added message and the banner (NATIVE_CONTRACT 44.3): whichever comes last is the one on screen.
  const tabFocused = useIsFocused();
  const tray = useAddedTray({ onView: () => router.push('/' as never), onAnnounce: announce, focused: tabFocused });
  const trayHide = tray.hideMessage;
  const trayAdd = tray.add;
  // NATIVE_CONTRACT 44.15 F7: a banner hides the message but never closes a sheet that is open; it waits for the sheet.
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = tray.sheetOpen;
  const waitingBanner = useRef<NoticeState | null>(null);
  const show = useCallback(
    (next: NoticeState) => {
      if (bannerPlan({ sheetOpen: sheetOpenRef.current }) === 'wait') {
        waitingBanner.current = next;
        return;
      }
      trayHide();
      showBanner(next);
    },
    [trayHide, showBanner],
  );
  useEffect(() => {
    if (tray.sheetOpen || !waitingBanner.current) return;
    const next = waitingBanner.current;
    waitingBanner.current = null;
    trayHide();
    showBanner(next);
  }, [tray.sheetOpen, trayHide, showBanner]);
  const subs = useSubtitleAvailability();
  const subsAvailable = subs.master && subs.sourcesOn > 0;
  const autoSubtitles = settings.subtitles.autoNewVideos;
  const reqId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  // Stable order while sources answer (components/search/stableOrder.ts): the keys last shown, and
  // how far down the user has seen (bottom edge of the screen, in px of list content).
  const shownKeys = useRef<string[]>([]);
  const viewportH = useRef(0);
  // Before the list is measured, the window height stands in (more rows pinned, never fewer).
  const highWater = useRef(Dimensions.get('window').height);
  // Bumped when the user picks a sort (even the same one): rank every row again from the top.
  const [rankTick, setRankTick] = useState(0);

  const trimmed = query.trim();
  const providers = useMemo(() => providerMap(prefs), [prefs]);

  const extra = useMemo(() => buildExtraProviders(prefs.torznab), [prefs.torznab]);
  const engPrefs = useMemo(() => ({ ...prefs, extraProviders: extra }), [prefs, extra]);

  const categories = useMemo<Category[]>(() => {
    const list = availableCategories(engPrefs);
    return ['all', ...list.filter((c) => c !== 'all')];
  }, [engPrefs]);
  const category: Category = categories.includes(prefs.lastCategory) ? prefs.lastCategory : 'all';

  const eligible = useMemo(() => eligibleProviders(category, engPrefs), [category, engPrefs]);
  const onProviders = useMemo(
    () => prefs.enabled.map((id) => providers.get(id)).filter((p): p is NonNullable<typeof p> => !!p),
    [prefs.enabled, providers],
  );

  // Anything that changes what a search asks for restarts it. Sort and recents do not.
  const searchKey = JSON.stringify([prefs.enabled, prefs.useFor, prefs.mirrorOverride, prefs.adult, prefs.waitSeconds, prefs.limit, prefs.hideDead, prefs.torznab]);

  useEffect(() => {
    reqId.current += 1;
    const mine = reqId.current;
    shownKeys.current = [];
    highWater.current = viewportH.current || Dimensions.get('window').height;
    setUpdate(null);
    setFailed(false);
    setStopped(false);
    setSourceFilter(null);
    if (trimmed.length < MIN_QUERY) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const ctl = new AbortController();
    controller.current = ctl;
    const debounce = setTimeout(() => {
      if (spoken.current.start !== mine) {
        spoken.current.start = mine;
        announce(`Searching ${plural(eligible.length, 'source', 'sources')}`);
      }
      const current = getSearchPrefs();
      loadExtraProviders(current.torznab).then((extraProviders) =>
        searchAll(trimmed, category, {
          ...current,
          extraProviders,
          signal: ctl.signal,
          onUpdate: (u: SearchUpdate) => {
            if (reqId.current !== mine) return;
            setUpdate(u);
            if (u.done) setSearching(false);
          },
        }),
      ).then(
        () => {
          if (reqId.current === mine) setSearching(false);
        },
        () => {
          if (reqId.current !== mine || ctl.signal.aborted) return;
          setFailed(true);
          setSearching(false);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(debounce);
      ctl.abort();
    };
    // searchKey stands in for the prefs fields a search depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, category, retryTick, searchKey]);

  // After the user passes a Cloudflare check: one re-run of that source only (SEARCH_CONTRACT section 8).
  const solvingProvider = solving ? providers.get(solving) : undefined;
  const handleSolved = useCallback(() => {
    const id = solving;
    setSolving(null);
    if (!id) return;
    if (!fixing.current) focusView(fixBtnRef.current);
    updatePrefs((p) => ({ needsCheck: p.needsCheck.filter((x) => x !== id) }));
    const next = fixing.current
      ? (update?.sources ?? []).find((x) => x.state === 'challenge' && x.providerId !== id && providers.get(x.providerId)?.cloudflare)
      : undefined;
    if (next) setSolving(next.providerId);
    else fixing.current = false;
    const mine = reqId.current;
    setUpdate((u) => (u ? { ...u, sources: u.sources.map((s) => (s.providerId === id ? { ...s, state: 'searching' as const } : s)) } : u));
    loadExtraProviders(getSearchPrefs().torznab)
      .then((extraProviders) => rerunProvider(id, trimmed, category, { ...getSearchPrefs(), extraProviders }))
      .then((out) => {
        if (!out || reqId.current !== mine) return;
        setUpdate((u) =>
          u
            ? {
                ...u,
                results: mergeInto(u.results, out.results, getSearchPrefs().enabled),
                sources: u.sources.map((s) => (s.providerId === id ? out.status : s)),
              }
            : u,
        );
      })
      .catch(() => {});
  }, [solving, trimmed, category, update, providers, updatePrefs]);

  // Remember which sources sat behind a check, so Settings and the header dot can say so after the search is gone.
  useEffect(() => {
    if (!update?.done) return;
    const prev = getSearchPrefs().needsCheck;
    const next = nextNeedsCheck(prev, update.sources);
    if (next.length !== prev.length || next.some((id, i) => id !== prev[i])) updatePrefs({ needsCheck: next });
  }, [update, updatePrefs]);

  const stop = useCallback(() => {
    reqId.current += 1;
    controller.current?.abort();
    setSearching(false);
    setStopped(true);
  }, []);

  const remember = useCallback((q: string) => {
    if (q.trim().length >= MIN_QUERY) setRecents(addRecentSearch(q));
  }, []);

  // Keyed by the ids, not the array: telemetry ticks every second, and a new Set would re-render every row.
  const inListKey = useMemo(() => telemetry.torrents.map((t) => t.id.toLowerCase()).join(','), [telemetry.torrents]);
  const inList = useMemo(() => new Set(inListKey ? inListKey.split(',') : []), [inListKey]);
  // `sessionAdded` only bridges the moment between an add and the torrent showing up in Transfers. Once it shows up,
  // Transfers is the truth, so it leaves this set: removing it from Transfers then makes the result addable again.
  useEffect(() => {
    setSessionAdded((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      prev.forEach((h) => {
        if (inList.has(h)) changed = true;
        else next.add(h);
      });
      return changed ? next : prev;
    });
    // Also on a sessionAdded change: the torrent can reach Transfers before the add's own update lands.
  }, [inList, sessionAdded]);
  const isAdded = useCallback((infoHash: string) => {
    const h = infoHash.toLowerCase();
    return sessionAdded.has(h) || inList.has(h);
  }, [sessionAdded, inList]);

  const handleAdd = useCallback(
    async (r: MergedResult, skipMobileAsk = false) => {
      const direct = directAddRoute(r);
      if (direct) {
        // A plain file (SEARCH_CONTRACT section 9): the link flow probes, names and starts it.
        remember(trimmed);
        router.push(direct);
        return;
      }
      if (r.directUrl && !r.magnet) {
        // A plain file over http (a mirror override): the link flow only takes https, and it is not a torrent.
        show({ tone: 'danger', title: "This link isn't secure, so Maglev won't download it" });
        return;
      }
      const busyKey = r.infoHash;
      setBusy(busyKey, true);
      remember(trimmed);
      const wait = new AbortController();
      const timer = setTimeout(() => wait.abort(), 15000);
      try {
        // Some sources only show the magnet on a detail page: read it now.
        const ready = await resolveResult(r, wait.signal);
        // Stats (NATIVE_CONTRACT 34.2): remember which source this came from for when it finishes.
        noteOrigin(ready.magnet, { source: r.sources?.[0] ?? r.providerId, category: (r.category ?? category) === 'all' ? null : (r.category ?? category) });
        // SM-35: the metadata size is not known before the add, so the search result's size decides.
        let tightNotice: string | null = null;
        const size = ready.sizeBytes ?? r.sizeBytes;
        if (size && size > 0) {
          try {
            const fs = await getFreeSpace();
            if (fs.ok) {
              const out = admit({
                freeBytes: Math.min(fs.freeBytes, fs.targetFreeBytes ?? fs.freeBytes),
                pendingNeed: pendingNeedOf(telemetry.torrents, downloads),
                stagingFactor: fs.mode === 'staging' ? 2 : 1,
                selectionBytes: size,
              });
              const decision = oneTapDecision(out.result);
              if (decision === 'openSheet') {
                // Doesn't fit: let the user pick files in the add flow instead of adding it all.
                router.push({ pathname: '/add-torrent', params: { source: ready.magnet } });
                return;
              }
              if (decision === 'addWithNotice') tightNotice = `Leaves ${formatBytes(out.leftAfter)} free`;
            }
          } catch {
            // Free space unknown: add as before.
          }
        }
        // On mobile data a big file should never start by surprise. With Wi-Fi only on, the add just waits.
        const mobileNote = oneTapAddNote({ sizeBytes: size, onMetered: onMeteredNetwork, wifiOnly: settings.network.wifiOnly });
        if (mobileNote && !settings.network.wifiOnly && !skipMobileAsk) {
          setMobileAsk({ result: r, note: mobileNote });
          return;
        }
        // Added directly: a background read of the same torrent is no longer needed.
        const readHash = magnetHash(ready.magnet);
        if (readHash) metadataPrefetch.cancelIf(readHash);
        await startTorrent(ready.magnet);
        setSessionAdded((prev) => new Set(prev).add(r.infoHash.toLowerCase()));
        // NATIVE_CONTRACT 44.3: the Added message takes the banner's slot (and the banner steps aside).
        dismiss();
        trayAdd({
          hash: (readHash ?? r.infoHash).toLowerCase(),
          name: r.name,
          ask: isVideoResult({ category: r.category ?? (category === 'all' ? undefined : category), name: r.name }) && subsAvailable
            ? buildAsk({ infoHash: readHash ?? r.infoHash, name: r.name, sizeBytes: size, sourceName: providers.get(r.sources?.[0] ?? r.providerId)?.name })
            : null,
          auto: autoSubtitles,
          note: tightNotice ?? mobileNote ?? undefined,
          sizeBytes: size,
        });
      } catch (e) {
        const { duplicate, notice: n } = addErrorNotice(e, () => {
          void restartEngine().then((ok) => {
            if (ok) void handleAdd(r);
          });
        });
        if (duplicate) {
          setSessionAdded((prev) => new Set(prev).add(r.infoHash.toLowerCase()));
          dismiss();
          trayAdd({ hash: r.infoHash, name: r.name, ask: null, alreadyThere: true, auto: false });
        } else show(n);
      } finally {
        clearTimeout(timer);
        setBusy(busyKey, false);
      }
    },
    [remember, show, dismiss, trayAdd, subsAvailable, autoSubtitles, providers, category, setBusy, startTorrent, restartEngine, trimmed, getFreeSpace, telemetry.torrents, downloads, router, onMeteredNetwork, settings.network.wifiOnly],
  );

  // Tapping Add on a warned row asks first; with the warning off it is one tap.
  const requestAdd = useCallback(
    (r: MergedResult) => {
      const risky = riskySources(r, providers, prefs.warnUnsafe);
      if (!risky) {
        void handleAdd(r);
        return;
      }
      const reason = r.sources.map((id) => providers.get(id)?.unsafeReason).find((x): x is string => !!x) ?? '';
      setConfirm({ result: r, reason });
    },
    [handleAdd, providers, prefs.warnUnsafe],
  );

  const followTargetOf = useCallback(
    (r: MergedResult): FollowTarget | null => {
      const cat = r.category ?? category;
      const key = `${cat}|${trimmed}|${r.name}`;
      const cache = followCache.current;
      if (!cache.has(key)) {
        if (cache.size > 400) cache.clear();
        cache.set(key, followRuleFromResult(r.name, trimmed, cat));
      }
      return cache.get(key) ?? null;
    },
    [category, trimmed],
  );

  const onFollowed = useCallback(
    (target: FollowTarget, status: 'followed' | 'already') => {
      setFollowing(null);
      show({
        tone: 'success',
        title: status === 'already' ? `Already following ${target.title}` : `Following ${target.title}`,
        actionLabel: 'Open Feeds',
        onAction: () => router.push('/feeds' as never),
      });
    },
    [router, show],
  );

  const nameOf = useCallback((id: string) => providers.get(id)?.name ?? id, [providers]);

  // After Stop, sources that never answered are left out of the scoreboard.
  const sources = useMemo(() => (update?.sources ?? []).filter((s) => !(stopped && s.state === 'searching')), [update, stopped]);
  // A source behind a Cloudflare check, or one that failed, has not answered.
  const tally = useMemo(() => tallySources(sources), [sources]);
  const srcLine = sourcesLine(tally);
  const answered = tally.answered;
  const [unansweredOpen, setUnansweredOpen] = useState(false);
  const noteBtnRef = useRef<any>(null);
  const missed = useMemo(() => unansweredSources(sources, nameOf), [sources, nameOf]);
  const total = update?.sources.length ?? 0;

  // Rows the user has had on screen keep their slots while later sources answer; new rows are ranked
  // below them. A new sort, source filter or search ranks everything again (and the list starts at the top).
  const rankKey = `${prefs.sort}|${sourceFilter ?? ''}|${rankTick}|${hideNoShare}|${sizeRange.low}-${sizeRange.high}`;
  const lastRankKey = useRef(rankKey);
  const shown = useMemo(() => {
    const base = update?.results ?? [];
    const bySource = sourceFilter ? base.filter((r) => r.sources.includes(sourceFilter)) : base;
    const filtered = bySource.filter((r) => passesResultFilter(r, { hideDead: hideNoShare, ...toFilter(sizeRange.low, sizeRange.high) }));
    const ranked = sortResults(filtered, prefs.sort);
    if (lastRankKey.current !== rankKey) return ranked;
    return stableOrder(shownKeys.current, ranked, seenRowCount(highWater.current), keyOfResult);
  }, [update, sourceFilter, prefs.sort, rankKey, hideNoShare, sizeRange]);
  useEffect(() => {
    if (lastRankKey.current !== rankKey) {
      lastRankKey.current = rankKey;
      highWater.current = viewportH.current || Dimensions.get('window').height;
    }
    shownKeys.current = shown.map(keyOfResult);
  }, [shown, rankKey]);

  const onListLayout = useCallback((e: LayoutChangeEvent) => {
    viewportH.current = e.nativeEvent.layout.height;
    if (highWater.current < viewportH.current) highWater.current = viewportH.current;
  }, []);
  const onListScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement } = e.nativeEvent;
    const edge = contentOffset.y + layoutMeasurement.height;
    if (edge > highWater.current) highWater.current = edge;
  }, []);

  // Look inside before the tap: read the top result's file list in the background, once it has held
  // its place (or every source answered), so Add -> choose files opens at once. One read at a time,
  // magnets only, never a download (components/search/prefetch.ts), and only when the network rule allows.
  const netOk = useMemo(
    () => prefetchAllowed({ wifiOnly: settings.network.wifiOnly, torrents: telemetry.torrents, downloads }),
    [settings.network.wifiOnly, telemetry.torrents, downloads],
  );
  const top = shown[0];
  const topMagnet = top && top.magnet && !isAdded(top.infoHash) ? top.magnet : null;
  const topKey = topMagnet ? magnetHash(topMagnet) : null;
  useEffect(() => {
    if (!topKey || !topMagnet || !netOk) return;
    const timer = setTimeout(() => {
      if (AppState.currentState === 'active') metadataPrefetch.start(topKey, topMagnet);
    }, searching ? PREFETCH_STABLE_MS : PREFETCH_SETTLED_MS);
    return () => clearTimeout(timer);
  }, [topKey, topMagnet, netOk, searching]);
  // A new top row, a new search, the network rule closing, or leaving the screen stops the read
  // (unless the Add screen already took it).
  useEffect(() => {
    if (!topKey || !netOk) return;
    return () => metadataPrefetch.cancelIf(topKey);
  }, [topKey, netOk]);

  // Sources that returned results, most first: the choices for "show only one source".
  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of update?.results ?? []) for (const id of r.sources) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [update]);

  const challenged = useMemo(() => sources.filter((s) => s.state === 'challenge' && providers.get(s.providerId)?.cloudflare), [sources, providers]);
  const showFix = shouldShowFixHint(Date.now(), prefs.fixHintDismissedAt, challenged.length);
  const startFix = useCallback(() => {
    const first = challenged[0];
    if (!first) return;
    fixing.current = true;
    setSolving(first.providerId);
  }, [challenged]);
  const needsCheckOn = prefs.needsCheck.filter((id) => prefs.enabled.includes(id)).length > 0;

  const fixLine = `${plural(challenged.length, 'source needs', 'sources need')} a quick check. They'll add more results.`;
  const fixTitleText = challenged.length === 1 ? '1 source needs a quick check' : `${challenged.length} sources need a quick check`;
  const dismissFix = useCallback(() => {
    updatePrefs({ fixHintDismissedAt: Date.now() });
    announce('Hidden for a day');
    focusView(inputRef.current);
  }, [updatePrefs]);
  // Said once per search, the first time the line shows.
  useEffect(() => {
    if (!showFix || challenged.length === 0 || spoken.current.fix === reqId.current) return;
    spoken.current.fix = reqId.current;
    announce(fixLine);
  }, [showFix, challenged.length, fixLine]);
  const animateFix = fixSeen.current !== reqId.current;
  useEffect(() => {
    if (showFix) fixSeen.current = reqId.current;
  }, [showFix, update]);

  const fixBanner = useMemo(
    () => (
      <Reveal visible animate={animateFix}>
        <View style={styles.fix}>
          <View style={styles.fixMark} importantForAccessibility="no-hide-descendants">
            <Text style={styles.fixMarkText}>?</Text>
          </View>
          <View style={styles.fixText} accessible accessibilityLabel={fixLine}>
            <Text style={styles.fixTitle}>{fixTitleText}</Text>
            <Text style={styles.fixBody}>They'll add more results.</Text>
          </View>
          <Button label="Fix" variant="ghost" buttonRef={fixBtnRef} onPress={startFix} accessibilityLabel="Fix sources that need a quick check" />
          <IconButton icon="close" size={16} onPress={dismissFix} accessibilityLabel="Dismiss" />
        </View>
      </Reveal>
    ),
    [styles, fixLine, fixTitleText, startFix, dismissFix, animateFix],
  );

  const listData = useMemo<readonly ListItem[]>(() => {
    if (!showFix || shown.length === 0) return shown;
    return [...shown.slice(0, FIX_AFTER), { fixHint: true }, ...shown.slice(FIX_AFTER)];
  }, [shown, showFix]);

  const renderItem = useCallback(
    ({ item }: { item: ListItem }) =>
      'fixHint' in item ? (
        fixBanner
      ) : (
      <ResultRow
        name={item.name}
        category={item.category}
        sizeBytes={item.sizeBytes}
        seeders={item.seeders}
        leechers={item.leechers}
        age={formatAgeLong(item.publishedAt)}
        via={item.sources.map(nameOf).join(' · ')}
        risky={riskySources(item, providers, prefs.warnUnsafe)}
        added={isAdded(item.infoHash)}
        busy={busyHashes.has(item.infoHash)}
        onAdd={() => requestAdd(item)}
        onOpen={() => setPreview(item)}
        onFollow={followTargetOf(item) ? () => setFollowing(followTargetOf(item)) : undefined}
      />
      ),
    [fixBanner, followTargetOf, busyHashes, requestAdd, setPreview, isAdded, nameOf, providers, prefs.warnUnsafe],
  );

  const watchThisSearch = useCallback(() => {
    const r = addWatchToStore({ query: trimmed, category });
    if (r.ok) show({ tone: 'success', title: watchCopy.watching(r.watch.query), body: watchCopy.watchingBody });
    else show({ tone: 'info', title: r.error });
  }, [trimmed, category, show]);

  const openProviders = useCallback(() => router.push('/settings/search-providers' as never), [router]);

  const idle = trimmed.length < MIN_QUERY;
  // The result line is not a live region (it ticks too often); say the outcome once per search.
  useEffect(() => {
    if (searching || trimmed.length < MIN_QUERY || failed || (!update && !stopped)) return;
    if (spoken.current.end === reqId.current) return;
    spoken.current.end = reqId.current;
    announce(shown.length === 0 ? 'No results' : plural(shown.length, 'result', 'results'));
  }, [searching, trimmed, failed, update, stopped, shown.length]);
  const showRecents = focused && idle && recents.length > 0;
  useEffect(() => {
    if (showRecents) announce(`Recent searches, ${recents.length}`);
    // Said when the list opens, not on each change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRecents]);
  const removeRecent = useCallback(
    (text: string) => {
      const at = recents.indexOf(text);
      const next = removeRecentSearch(text);
      setRecents(next);
      announce(`Removed ${text}`);
      const nextText = next[at] ?? next[at - 1];
      focusView(nextText !== undefined ? recentRows.current.get(nextText) : inputRef.current);
    },
    [recents],
  );
  const clearRecents = useCallback(() => {
    setRecents(clearRecentSearches());
    announce('Recent searches cleared');
    focusView(inputRef.current);
  }, []);
  const hasResults = (update?.results.length ?? 0) > 0;

  const enabledCount = prefs.enabled.length;
  const offCount = useMemo(() => countOffSources([...providers.values()], prefs.enabled, prefs.adult), [providers, prefs.enabled, prefs.adult]);
  let body: React.ReactNode;
  if (idle) {
    body =
      enabledCount === 0 ? (
        <EmptyBlock
          icon="search"
          title={empty.search.noSource.title}
          body={empty.search.noSource.body}
          primary={{ label: 'Change sources', onPress: openProviders }}
        />
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.idle}>
          <EmptyBlock
            icon="search"
            title={empty.search.idle(enabledCount).title}
            body={empty.search.idle(enabledCount).body}
          />
          <View style={styles.disclaimerRow}>
            <PixelIcon name="shield" size={16} color={colors.textMuted} />
            <Text style={styles.disclaimer}>Maglev doesn't host or index anything. You're responsible for what you download.</Text>
          </View>
        </ScrollView>
      );
  } else if (failed) {
    body = (
      <EmptyBlock
        icon="warning"
        error
        title={empty.search.unavailable.title}
        body={empty.search.unavailable.body}
        primary={{ label: 'Retry', icon: 'retry', onPress: () => setRetryTick((n) => n + 1) }}
      />
    );
  } else if (eligible.length === 0) {
    body = (
      <EmptyBlock
        icon="search"
        title={empty.search.noSource.title}
        body={empty.search.noSource.body}
        primary={{ label: 'Change sources', onPress: openProviders }}
      />
    );
  } else {
    const emptyResults =
      update && answered === 0 ? (
        <EmptyBlock
          icon="warning"
          error
          title={empty.search.noAnswer.title}
          body={empty.search.noAnswer.body}
          primary={{ label: 'Retry', icon: 'retry', onPress: () => setRetryTick((n) => n + 1) }}
        />
      ) : (
        // 45.5: sources that are off could have answered. Changing them restarts the search through `searchKey`.
        <EmptyBlock
          icon="search"
          title={empty.search.noResults(trimmed, offCount).title}
          body={empty.search.noResults(trimmed, offCount).body}
          primary={offCount > 0 ? { label: SEARCH_TURN_ON_MORE, onPress: openProviders } : undefined}
        />
      );
    const list = (
      <View style={styles.listWrap} onLayout={onListLayout}>
        <FlashList
          key={rankKey}
          data={listData}
          keyExtractor={(item: ListItem) => ('fixHint' in item ? 'fix-hint' : keyOfResult(item))}
          getItemType={(item: ListItem) => ('fixHint' in item ? 'fix' : 'result')}
          renderItem={renderItem}
          contentContainerStyle={tray.inset ? { ...styles.list, paddingBottom: spacing.xxxl + tray.inset } : styles.list}
          keyboardShouldPersistTaps="handled"
          onScroll={onListScroll}
          ListFooterComponent={searching && shown.length > 0 ? <SkeletonRows count={SKELETON_MORE_COUNT} /> : null}
          ListEmptyComponent={
            searching ? (
              <SkeletonRows count={SKELETON_FIRST_COUNT} />
            ) : (
              showFix ? (
                <>
                  {fixBanner}
                  {emptyResults}
                </>
              ) : (
                emptyResults
              )
            )
          }
        />
      </View>
    );
    body = (
      <>
        <View style={styles.sources}>
          {searching ? (
            <>
              <View style={styles.summaryRow}>
                <Text style={styles.summary}>{`Searching… ${answered} of ${total || eligible.length} sources`}</Text>
                <Button label="Stop" variant="ghost" onPress={stop} accessibilityLabel="Stop searching" />
              </View>
              <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <View style={[styles.trackFill, { width: `${Math.min(100, Math.round((answered / Math.max(1, total || eligible.length)) * 100))}%` }]} />
              </View>
            </>
          ) : (
            <View style={styles.summaryRow}>
              <View style={styles.summaryText}>
                <Text style={styles.count} numberOfLines={1}>{`${stopped ? 'Stopped · ' : ''}${shown.length} ${shown.length === 1 ? 'result' : 'results'}`}</Text>
                {srcLine ? (
                  <View style={styles.noteRow}>
                    <PressableScale
                      pressableRef={noteBtnRef}
                      onPress={() => setUnansweredOpen(true)}
                      style={styles.noteBtn}
                      hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel={`${resultsSummary(shown.length, tally, stopped)}. Show which sources did not respond`}
                    >
                      <Text style={[styles.note, srcLine.bad && styles.noteBad]} numberOfLines={1}>
                        {srcLine.text}
                      </Text>
                      <PixelIcon name="chevron-right" size={16} color={srcLine.bad ? colors.danger : colors.textMuted} />
                    </PressableScale>
                  </View>
                ) : null}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Button
                  label={watchCopy.watchButton}
                  icon="alarm"
                  variant="ghost"
                  onPress={watchThisSearch}
                  accessibilityLabel={watchCopy.watchHint}
                />
                {hasResults ? (
                  <Button
                    label={SORT_LABEL[prefs.sort]}
                    icon="sort"
                    variant="ghost"
                    buttonRef={sortBtnRef}
                    onPress={() => setSortOpen(true)}
                    accessibilityLabel={`Sort: ${SORT_LABEL[prefs.sort]}`}
                  />
                ) : null}
              </View>
            </View>
          )}
        </View>
        {list}
      </>
    );
  }

  return (
    <Screen
      title="Search"
      actions={
        <>
          {/* Labelled, not icon-only: people could not tell the globe opened the browser. Hidden when the Browser tab is on. */}
          {!browserTabShown ? (
            <PressableScale
              onPress={() => openBrowser(router)}
              style={styles.browserBtn}
              accessibilityRole="button"
              accessibilityLabel="Open the browser"
            >
              <PixelIcon name="network" size={16} color={colors.text} />
              <Text style={styles.browserText}>Browser</Text>
            </PressableScale>
          ) : null}
          <IconButton
            icon="filter"
            dot={needsCheckOn}
            onPress={openProviders}
            accessibilityLabel={`Sources, ${prefs.enabled.length} on${needsCheckOn ? ', some need a quick check' : ''}`}
          />
        </>
      }
    >
      <View style={styles.pad}>
        <TextField
          leadingIcon="search"
          clearable
          clearLabel="Clear search"
          size="lg"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => {
            remember(query);
            setRetryTick((n) => n + 1);
          }}
          placeholder="Name, show, file…"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search torrents"
          ref={inputRef}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <Reveal visible={showRecents}>
          {/* A scroll view with handled taps: a tap on a row registers before the field loses focus. */}
          <ScrollView keyboardShouldPersistTaps="handled" scrollEnabled={false} style={styles.recentsWrap}>
            <View style={styles.recentsCard} accessibilityLabel="Recent searches">
              <View style={styles.recentsHead}>
                <Text style={styles.sectionLabel} accessibilityRole="header">
                  Recent
                </Text>
                <Button label="Clear" variant="ghost" onPress={clearRecents} accessibilityLabel="Clear recent searches" />
              </View>
              {recents.map((r) => (
                <View key={r} style={styles.recentRow}>
                  <PressableScale
                    pressableRef={(n) => {
                      if (n) recentRows.current.set(r, n);
                      else recentRows.current.delete(r);
                    }}
                    containerStyle={styles.recentMain}
                    style={styles.recentMainInner}
                    onPress={() => {
                      setQuery(r);
                      remember(r);
                      inputRef.current?.blur();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Search ${r}`}
                  >
                    <PixelIcon name="clock" size={16} color={colors.textMuted} />
                    <Text style={styles.recentText} numberOfLines={1}>
                      {r}
                    </Text>
                  </PressableScale>
                  <IconButton icon="close" size={16} onPress={() => removeRecent(r)} accessibilityLabel={`Remove ${r} from recent searches`} />
                </View>
              ))}
            </View>
          </ScrollView>
        </Reveal>
      </View>
      <View accessibilityRole="radiogroup" accessibilityLabel="Category">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catScroll} contentContainerStyle={styles.chips}>
        {categories.map((c) => (
          <Chip key={c} role="radio" label={CATEGORY_LABEL[c]} selected={c === category} onPress={() => updatePrefs({ lastCategory: c })} />
        ))}
      </ScrollView>
      </View>
      {notice ? (
        <View style={styles.pad}>
          <NoticeBanner notice={notice} onDismiss={dismiss} />
        </View>
      ) : null}
      <View style={styles.body}>{body}</View>
      {solvingProvider?.cloudflare ? (
        <CloudflareSolverSheet
          visible
          providerName={solvingProvider.name}
          solverUrl={solvingProvider.cloudflare.solverUrl}
          onClose={() => {
            setSolving(null);
            focusView(fixBtnRef.current);
          }}
          onSolved={handleSolved}
        />
      ) : null}
      <UnansweredSheet sources={unansweredOpen ? missed : null} onClose={() => setUnansweredOpen(false)} returnFocusRef={noteBtnRef} />
      <FollowSheet target={following} onClose={() => setFollowing(null)} onDone={onFollowed} />
      <SortFilterSheet
        visible={sortOpen}
        onClose={() => setSortOpen(false)}
        returnFocusRef={sortBtnRef}
        sort={prefs.sort}
        onSortChange={(s) => {
          updatePrefs({ sort: s });
          setRankTick((n) => n + 1);
        }}
        sources={sourceCounts.map(([id, count]) => ({ id, name: nameOf(id), count }))}
        sourceFilter={sourceFilter}
        onSourceChange={setSourceFilter}
        sizeRange={sizeRange}
        onSizeRangeChange={(low, high) => setSizeRange({ low, high })}
        hideNoShare={hideNoShare}
        onHideNoShareChange={setHideNoShare}
        shownCount={shown.length}
        totalCount={update?.results.length ?? 0}
        onReset={() => {
          setSourceFilter(null);
          setSizeRange({ low: 0, high: SIZE_STOPS.length - 1 });
          setHideNoShare(true);
        }}
      />
      <ResultPreviewSheet
        result={
          preview
            ? {
                name: preview.name,
                sizeBytes: preview.sizeBytes,
                seeders: preview.seeders,
                leechers: preview.leechers,
                age: formatAge(preview.publishedAt),
                via: preview.sources.map(nameOf).join(' · '),
                detailUrl: preview.detailUrl,
                added: isAdded(preview.infoHash),
              }
            : null
        }
        onClose={() => setPreview(null)}
        onAdd={() => {
          const r = preview;
          setPreview(null);
          if (r) requestAdd(r);
        }}
        onOpenInBrowser={() => {
          const url = preview?.detailUrl;
          setPreview(null);
          if (url) openBrowser(router, { url });
        }}
      />
      <MobileDataSheet
        note={mobileAsk?.note ?? null}
        onClose={() => setMobileAsk(null)}
        onConfirm={() => {
          const r = mobileAsk?.result;
          setMobileAsk(null);
          if (r) void handleAdd(r, true);
        }}
      />
      {tray.node}
      <Sheet visible={!!confirm} onClose={() => setConfirm(null)} title="Add from a risky source?" subtitle={confirm?.reason}>
        <View style={styles.confirmActions}>
          <Button
            label="Add anyway"
            fullWidth
            onPress={() => {
              const r = confirm?.result;
              setConfirm(null);
              if (r) void handleAdd(r);
            }}
          />
          <Button label="Cancel" variant="secondary" fullWidth onPress={() => setConfirm(null)} />
        </View>
      </Sheet>
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    pad: { paddingHorizontal: spacing.lg },
    confirmActions: { gap: spacing.sm },
    filterRow: { marginTop: spacing.md },
    catScroll: { flexGrow: 0, marginTop: spacing.md, marginBottom: spacing.sm },
    chips: { paddingHorizontal: spacing.lg, gap: spacing.sm },
    idle: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxxl, gap: spacing.xxl },
    recentsWrap: { flexGrow: 0, marginTop: spacing.sm },
    recentsCard: { borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, paddingBottom: spacing.xs },
    recentsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: spacing.lg, paddingRight: spacing.xs },
    recentRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.lg, paddingRight: spacing.xs },
    recentMain: { flex: 1, minHeight: touch.min },
    recentMainInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: touch.min },
    recentText: { ...type.body, flex: 1, fontSize: type.size.base, color: c.text },
    sourceChips: { marginTop: spacing.sm },
    sectionLabel: { ...type.bodyStrong, fontSize: type.size.sm, color: c.textMuted },
    wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    disclaimerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingTop: spacing.lg, borderTopWidth: 1, borderTopColor: c.border },
    disclaimer: { ...type.body, flex: 1, fontSize: type.size.xs, lineHeight: 16, color: c.textMuted, textAlign: 'left' },
    browserBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, height: touch.min, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: c.borderStrong, backgroundColor: c.surface },
    browserText: { ...type.bodyStrong, fontSize: type.size.md, color: c.text },
    track: { height: 2, backgroundColor: c.border },
    trackFill: { height: 2, backgroundColor: c.accent },
    fix: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 64, paddingVertical: spacing.sm, paddingLeft: spacing.md, paddingRight: spacing.xs, marginBottom: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    fixMark: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, borderWidth: 1, borderColor: c.accent },
    fixMarkText: { ...type.monoBold, fontSize: type.size.base, color: c.accentText },
    fixText: { flex: 1, gap: 2 },
    fixTitle: { ...type.bodyStrong, fontVariant: ['tabular-nums'], fontSize: type.size.md, color: c.text },
    fixBody: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    sources: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm },
    summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
    summaryText: { flex: 1, minWidth: 0, justifyContent: 'center', minHeight: touch.min },
    count: { ...type.bodyStrong, fontVariant: ['tabular-nums'], fontSize: type.size.md, lineHeight: 18, color: c.text },
    noteRow: { flexDirection: 'row' },
    noteBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start' },
    note: { ...type.body, fontSize: type.size.sm, lineHeight: 17, color: c.textMuted },
    noteBad: { color: c.danger },
    summary: { ...type.body, fontVariant: ['tabular-nums'], flex: 1, fontSize: type.size.sm, lineHeight: 17, color: c.textMuted },
    body: { flex: 1, marginTop: spacing.sm },
    listWrap: { flex: 1 },
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
  });

export { ErrorBoundary } from '../../components/ErrorScreen';
