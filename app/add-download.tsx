import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChipGroup, friendlyPath } from '../components/settings/SettingsParts';
import { DownloadParts, PART_CHOICES, useLinkDownloadPrefs } from '../utils/prefs/linkDownloads';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { maglevEngine, infoHashToMagnet, isDownloadLink, isShareOpen, isTorrentSource, normalizeIncoming, sanitizeFileName, type UrlProbe } from 'maglev-engine';
import { useTheme } from '../context/ThemeContext';
import { useMaglevEngine } from '../context/EngineContext';
import { ThemeColors, radius, spacing, touch, type } from '../constants/theme';
import { formatBytes } from '../constants/format';
import { haptic } from '../constants/haptics';
import { StreamSheet } from '../components/browser/StreamSheet';
import { streamKindOfLink } from '../components/browser/streamChoice';
import type { FoundItem } from 'maglev-engine';
import { Banner, Button, EmptyBlock, RadioCard, Screen, TextField } from '../components/ui';
import {
  defaultYouTubeQuality,
  formatYouTubeDuration,
  type YouTubeQualityOption,
} from '../utils/youtube';
import {
  detectSocialPlatform,
  extractBulkUrls,
  isSocialOrYouTubeUrl,
  normalizeSocialUrl,
  PLATFORM_LABELS,
  probeSocialMedia,
  type SocialProbeError,
  type SocialProbeResult,
} from '../utils/social';
import { useCookiesTxt } from '../utils/cookiesTxt';
import { useDownloadAdmission } from '../utils/useDownloadAdmission';
import { actionRoute, probeErrorView } from '../utils/downloadCopy';
import { banners, empty, mobileDataLine, notices } from '../constants/copy';
import { pickFolderForThisDownload } from '../utils/downloadFolder';
import { useSettings } from '../context/SettingsContext';
import { START_ENGINE_LABEL, engineStoppedBody, isEngineStopped } from '../utils/addErrorNotice';
import { openBrowser } from '../utils/browser/openBrowser';
import { fileKind } from '../utils/fileKind';
import { SubtitlesAutoRow, useSubtitlesAuto } from '../components/search/SubtitlesAutoRow';
import { askSubtitles, markNotThisOne } from '../utils/subtitles/requests';
import { buildAsk } from '../utils/addedTray';
import { joinTrayIfShowing } from '../components/search/AddedTray';

/** Add a download from a web link, social media post, or bulk URL list. */
type Phase =
  | 'input'
  | 'probing'
  | 'ready'
  | 'ytReady'
  | 'batchReady'
  | 'adding'
  | 'ytAdding'
  | 'batchAdding'
  | 'error';

type BatchQualityPref = 'best' | '1080' | '720' | '480' | 'audio';

const BATCH_QUALITY_CHOICES: {
  id: BatchQualityPref;
  label: string;
  description: string;
}[] = [
  {
    id: 'best',
    label: 'Best quality (up to 4K/8K)',
    description: 'MP4 (Fast-start) · No watermark · Highest resolution or original images',
  },
  {
    id: '1080',
    label: '1080p (Full HD)',
    description: 'MP4 (Fast-start) · Balanced size and crisp quality',
  },
  {
    id: '720',
    label: '720p (HD)',
    description: 'MP4 (Fast-start) · Faster on slow or unstable networks',
  },
  {
    id: '480',
    label: '480p (Data saver)',
    description: 'MP4 (Fast-start) · Smallest video size for weak connections',
  },
  {
    id: 'audio',
    label: 'Sound only',
    description: 'M4A high-bitrate audio track extracted from every video link',
  },
];

/** Splits "movie.final.mp4" into "movie.final" and ".mp4". A leading dot or a long tail is not an extension. */
function splitName(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i <= 0 || name.length - i > 9 || /\s/.test(name.slice(i))) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

function pickQualityForBatch(
  qualities: YouTubeQualityOption[],
  pref: BatchQualityPref,
): YouTubeQualityOption | null {
  if (qualities.length === 0) return null;
  if (pref === 'audio') {
    return qualities.find((q) => q.kind === 'audio') ?? qualities[0];
  }
  const videos = qualities.filter((q) => q.kind !== 'audio');
  if (videos.length === 0) return qualities[0];
  if (pref === 'best') return videos[0];
  const targetHeight = Number.parseInt(pref, 10);
  const exactOrBelow = videos.find((q) => (q.height ?? targetHeight) <= targetHeight);
  return exactOrBelow ?? videos[videos.length - 1];
}

const INVALID_TEXT = "That isn't a web link. Use a link that starts with http or https.";

const PART_OPTIONS: { value: DownloadParts; label: string }[] = PART_CHOICES.map((n) => ({ value: n, label: String(n) }));

export default function AddDownloadScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string; source?: string; from?: string }>();
  const { defaultStoragePath, probeUrl, probeStream, startDownload, showNotice, onMeteredNetwork, restartEngine } = useMaglevEngine();
  const { settings } = useSettings();
  const { summary: cookieSummary, importCookies, clearCookies } = useCookiesTxt();

  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [message, setMessage] = useState<string | null>(null);
  const [errorView, setErrorView] = useState<ReturnType<typeof probeErrorView> | null>(null);
  const [socialError, setSocialError] = useState<SocialProbeError | null>(null);
  const [probe, setProbe] = useState<UrlProbe | null>(null);
  const [notAFile, setNotAFile] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addStopped, setAddStopped] = useState(false);
  const [folderLabel, setFolderLabel] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [streamItem, setStreamItem] = useState<FoundItem | null>(null);
  const [socialProbe, setSocialProbe] = useState<SocialProbeResult | null>(null);
  const [ytQualityId, setYtQualityId] = useState<string | null>(null);
  const [selectedSlideIndex, setSelectedSlideIndex] = useState<number>(-1); // -1 = All slides in carousel
  const [batchUrls, setBatchUrls] = useState<string[]>([]);
  const [batchQualityPref, setBatchQualityPref] = useState<BatchQualityPref>('best');
  const [batchProgressText, setBatchProgressText] = useState<string>('');
  const [showCookieBox, setShowCookieBox] = useState(false);
  const [cookieDraft, setCookieDraft] = useState('');
  const [cookieStatusMsg, setCookieStatusMsg] = useState<string | null>(null);
  const [baseName, setBaseName] = useState('');
  // Parts default to the Settings > Downloads pref; the chips below override it for this download only.
  const [linkPrefs] = useLinkDownloadPrefs();
  const [partsOverride, setPartsOverride] = useState<DownloadParts | null>(null);
  const parts: DownloadParts = partsOverride ?? linkPrefs.downloadParts;
  const token = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef('');
  // NATIVE_CONTRACT 44.5 and 44.12: a video link gets the Subtitles row.
  const fullName = probe ? baseName.trim() + splitName(probe.name).ext : '';
  const subs = useSubtitlesAuto(!!probe && fileKind(fullName || probe.name) === 'video');
  const allowLanRef = useRef(false);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.dismissTo('/');
  }, [router]);

  const handleImportCookieFile = async () => {
    haptic('tap');
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'application/json', '*/*'],
        copyToCacheDirectory: true,
      });
      if (picked.canceled || !picked.assets?.length) return;
      const content = await FileSystem.readAsStringAsync(picked.assets[0].uri);
      const res = importCookies(content);
      if (res.totalCount > 0) {
        haptic('commit');
        setCookieStatusMsg(
          `Loaded ${res.totalCount} cookies (${res.platforms.join(', ') || res.domains.slice(0, 3).join(', ')}).`,
        );
        setShowCookieBox(false);
        if (phase === 'error' && urlRef.current) {
          void submit(urlRef.current, allowLanRef.current);
        }
      } else {
        setCookieStatusMsg('No valid Netscape or JSON cookies found in that file.');
      }
    } catch {
      setCookieStatusMsg('Could not read the selected cookies.txt file.');
    }
  };

  const handlePasteCookiesFromClipboard = async () => {
    haptic('tap');
    try {
      const clip = (await Clipboard.getStringAsync()).trim();
      const source = cookieDraft.trim() || clip;
      if (!source) {
        setCookieStatusMsg('Copy your cookies.txt content first or pick a file.');
        return;
      }
      const res = importCookies(source);
      if (res.totalCount > 0) {
        haptic('commit');
        setCookieDraft('');
        setCookieStatusMsg(
          `Loaded ${res.totalCount} cookies (${res.platforms.join(', ') || res.domains.slice(0, 3).join(', ')}).`,
        );
        setShowCookieBox(false);
        if (phase === 'error' && urlRef.current) {
          void submit(urlRef.current, allowLanRef.current);
        }
      } else {
        setCookieStatusMsg('No valid cookies found in the pasted text.');
      }
    } catch {
      setCookieStatusMsg('Could not read clipboard.');
    }
  };

  const submit = useCallback(
    async (raw: string, allowLan = false) => {
      // Check if the user pasted multiple bulk URLs (multi-line or space-separated)
      const extracted = extractBulkUrls(raw);
      if (extracted.length > 1) {
        setBatchUrls(extracted);
        setMessage(null);
        setAddError(null);
        setSocialError(null);
        setPhase('batchReady');
        return;
      }

      const input = normalizeSocialUrl(normalizeIncoming(raw));
      // A magnet or a .torrent link is a torrent: hand it to Add torrent instead of refusing it.
      if (isTorrentSource(input)) {
        router.replace({ pathname: '/add-torrent', params: { source: input } });
        return;
      }
      // A bare info hash (40 hex or 32 base32) is a torrent too.
      const hashMagnet = infoHashToMagnet(input);
      if (hashMagnet) {
        router.replace({ pathname: '/add-torrent', params: { source: hashMagnet } });
        return;
      }
      if (!isDownloadLink(input)) {
        setMessage(INVALID_TEXT);
        setPhase('input');
        return;
      }
      const mine = ++token.current;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      urlRef.current = input;
      allowLanRef.current = allowLan;
      setMessage(null);
      setAddError(null);
      setSocialError(null);
      setSocialProbe(null);
      setYtQualityId(null);
      setSelectedSlideIndex(-1);
      setPhase('probing');

      if (isSocialOrYouTubeUrl(input)) {
        const soc = await probeSocialMedia(input, probeStream, ac.signal);
        if (mine !== token.current) return;
        if (soc.ok) {
          setSocialProbe(soc);
          setYtQualityId(defaultYouTubeQuality(soc.qualities)?.id ?? soc.qualities[0]?.id ?? null);
          setSelectedSlideIndex(-1);
          setBaseName(sanitizeFileName(soc.title));
          setPhase('ytReady');
          return;
        }
        setNotAFile(false);
        setSocialError(soc);
        setErrorView({ body: soc.message, primary: 'retry' });
        setPhase('error');
        return;
      }

      // An .m3u8 or .mpd link is a stream: offer the same quality sheet the browser uses.
      // When the probe says it is not a stream, carry on as a plain file.
      const streamKind = streamKindOfLink(input);
      if (streamKind) {
        const sp = await probeStream(input, allowLan ? { allowLan: true } : {});
        if (mine !== token.current) return;
        if (sp.ok || (sp.code ?? '').toUpperCase().startsWith('STREAM_')) {
          setStreamItem({
            id: input, url: input, kind: 'video', mime: null, ext: streamKind === 'hls' ? 'm3u8' : 'mpd',
            name: '', size: null, width: null, height: null, source: 'page', stream: streamKind, pageUrl: '', pageTitle: '',
          });
          setPhase('input');
          return;
        }
      }
      const res = await probeUrl(input, allowLan ? { allowLan: true } : {});
      if (mine !== token.current) return;
      if (res.ok) {
        setProbe(res);
        setBaseName(splitName(res.name).base);
        setPhase('ready');
        return;
      }
      setProbe(null);
      setNotAFile((res.code ?? '').toUpperCase() === 'NOT_A_FILE');
      setErrorView(probeErrorView(res.code, res.message, res.httpStatus));
      setPhase('error');
    },
    [probeUrl, probeStream, router],
  );

  // The `url` or `source` param (a share, a maglev:// link, or another screen) fills the field.
  // Only a share (`from=share`, set by app/+native-intent.tsx and stripped from every outside link)
  // or the Add torrent hand-off (`from=add-torrent`) checks the link at once.
  const lastIncoming = useRef<string | null>(null);
  useEffect(() => {
    const raw = params.url || params.source;
    const incoming = typeof raw === 'string' ? raw.trim() : '';
    if (!incoming || incoming === lastIncoming.current) return;
    lastIncoming.current = incoming;
    const shared = isShareOpen({ url: params.url, from: params.from });
    const bulk = extractBulkUrls(incoming);
    if (bulk.length > 1) {
      const joined = bulk.join('\n');
      setText(joined);
      if (shared || params.from === 'add-torrent') {
        void submit(joined);
      }
      return;
    }
    const clean = normalizeSocialUrl(normalizeIncoming(incoming));
    const handoff =
      params.from === 'add-torrent' &&
      (isSocialOrYouTubeUrl(clean) || isDownloadLink(clean));
    if (shared || handoff) {
      setText(clean);
      void submit(clean);
      return;
    }
    if (isTorrentSource(clean)) {
      router.replace({ pathname: '/add-torrent', params: { source: clean } });
      return;
    }
    setText(clean);
  }, [params.url, params.source, params.from, submit, router]);

  const activeQualities = useMemo(() => {
    if (!socialProbe) return [];
    if (
      selectedSlideIndex >= 0 &&
      selectedSlideIndex < socialProbe.items.length
    ) {
      return socialProbe.items[selectedSlideIndex].qualities;
    }
    return socialProbe.qualities;
  }, [socialProbe, selectedSlideIndex]);

  const ytQuality =
    activeQualities.find((q) => q.id === ytQualityId) ??
    activeQualities[0] ??
    null;

  // Free space refreshes when the preview opens.
  const admissionSize = phase === 'ytReady' ? (ytQuality?.estBytes ?? null) : (probe?.size ?? null);
  const { doesntFit, noSpace } = useDownloadAdmission(admissionSize, phase === 'ready' || phase === 'ytReady');

  const onChangeText = (next: string) => {
    token.current++;
    abortRef.current?.abort();
    setText(next);
    setMessage(null);
    setProbe(null);
    setSocialProbe(null);
    setSocialError(null);
    setYtQualityId(null);
    setBatchUrls([]);
    setPhase('input');
  };

  const handlePaste = async () => {
    haptic('tap');
    let clip = '';
    try {
      clip = (await Clipboard.getStringAsync()).trim();
    } catch {
      clip = '';
    }
    if (!clip) {
      setMessage(notices.inline.clipboardEmpty);
      setPhase('input');
      return;
    }
    const bulk = extractBulkUrls(clip);
    if (bulk.length > 1) {
      const joined = bulk.join('\n');
      setText(joined);
      void submit(joined);
      return;
    }
    const link = normalizeIncoming(clip);
    setText(link);
    void submit(link);
  };

  // "Change" picks a folder for this download only: the path goes to startDownload and the default folder is untouched.
  const handleChangeFolder = async () => {
    haptic('tap');
    try {
      const res = await pickFolderForThisDownload(() => maglevEngine.pickFolder());
      if (res.kind === 'cancelled') return;
      if (res.kind === 'unsupported') {
        setAddError(notices.inline.folderNotDirect);
        return;
      }
      setFolderPath(res.path);
      setFolderLabel(res.label);
    } catch {
      setAddError(notices.inline.folderPickerFailed);
    }
  };

  const nameInvalid = baseName.trim().length === 0 || /[\\/]/.test(baseName);
  const nameError = nameInvalid ? (baseName.trim().length === 0 ? 'Enter a file name.' : "A file name can't contain a slash.") : null;

  const start = async (fromError = false) => {
    setPhase('adding');
    setAddError(null);
    setAddStopped(false);
    const renamed = !fromError && probe && !nameInvalid && baseName.trim() + splitName(probe.name).ext !== probe.name
      ? baseName.trim() + splitName(probe.name).ext
      : null;
    const directExt = probe
      ? splitName(renamed ?? probe.name).ext.toLowerCase().replace(/^\./, '')
      : '';
    const useParallelDirectVideo = Boolean(
      partsOverride !== 1 &&
        probe?.resumable &&
        (probe.size == null || probe.size >= 512 * 1024) &&
        (directExt === 'mp4' || directExt === 'm4a' || directExt === 'm4v'),
    );
    const res = await startDownload(urlRef.current, {
      ...(allowLanRef.current ? { allowLan: true } : {}),
      ...(renamed ? { name: renamed } : {}),
      ...(folderPath ? { folder: folderPath } : {}),
      segments: parts,
      ...(useParallelDirectVideo
        ? {
            stream: {
              kind: 'pair',
              variantId: 'direct-video',
              videoUrl: urlRef.current,
              ...(probe?.size && probe.size > 0 ? { videoBytes: probe.size } : {}),
              ext: directExt,
            },
          }
        : {}),
    });
    if (res.ok) {
      haptic('commit');
      if (probe && subs.show) {
        const ask = buildAsk({ infoHash: '', key: `d:${res.id}`, name: renamed ?? probe.name, sizeBytes: probe.size ?? undefined });
        const joined = joinTrayIfShowing({ hash: ask.key, name: renamed ?? probe.name, ask, auto: subs.on });
        if (!joined && subs.on) askSubtitles([ask], { auto: true });
        else if (!joined && !subs.on && subs.settingsOn) markNotThisOne([ask]);
      }
      router.dismissTo('/');
      return;
    }
    if (res.code === 'DUPLICATE') {
      showNotice({ message: notices.addDownload.duplicate });
      router.dismissTo('/');
      return;
    }
    haptic('fail');
    const stopped = isEngineStopped(res);
    const reason = stopped ? engineStoppedBody(res) : res.message;
    if (fromError) {
      setErrorView({ body: reason || "Couldn't start this download.", primary: 'retry' });
      setPhase('error');
      return;
    }
    setAddStopped(stopped);
    setAddError(reason || notices.inline.startDownloadFailed);
    setPhase('ready');
  };

  const buildHeadersForSocial = (
    soc: SocialProbeResult,
    quality: YouTubeQualityOption,
  ) => {
    const h: {
      'User-Agent'?: string;
      Referer?: string;
      Origin?: string;
      Cookie?: string;
      Cookies?: { host: string; cookie: string }[];
    } = {};
    const ua = quality.userAgent || soc.headers.userAgent;
    if (ua) h['User-Agent'] = ua;
    if (soc.headers.referer) h.Referer = soc.headers.referer;
    if (soc.headers.origin) h.Origin = soc.headers.origin;
    if (soc.headers.cookie) h.Cookie = soc.headers.cookie;
    if (soc.headers.cookies && soc.headers.cookies.length > 0) {
      h.Cookies = soc.headers.cookies;
    }
    return Object.keys(h).length > 0 ? h : undefined;
  };

  const startSocialDownload = async () => {
    if (!socialProbe || !ytQuality) return;
    setPhase('ytAdding');
    setAddError(null);
    setAddStopped(false);
    const cleanBase = sanitizeFileName(baseName.trim() || socialProbe.title);

    // Multi-slide Carousel / Gallery / Slideshow download when "All items" (-1) is selected and items > 1
    if (
      socialProbe.items.length > 1 &&
      selectedSlideIndex === -1 &&
      ytQuality.kind !== 'audio'
    ) {
      let startedCount = 0;
      let lastRes: { ok: boolean; code?: string; message?: string } | null = null;
      for (let i = 0; i < socialProbe.items.length; i++) {
        const item = socialProbe.items[i];
        const q = item.qualities[0] ?? ytQuality;
        const slideBase = `${cleanBase}_${i + 1}`;
        const fileName = slideBase.endsWith(q.ext)
          ? slideBase
          : `${slideBase}${q.ext}`;
        const headers = buildHeadersForSocial(socialProbe, q);
        const res = await startDownload(q.url, {
          name: fileName,
          pageUrl: urlRef.current,
          ...(folderPath ? { folder: folderPath } : {}),
          ...(headers ? { headers } : {}),
          segments: parts,
          ...(q.kind === 'pair' || q.kind === 'audio' || q.kind === 'hls'
            ? { stream: q.streamSelection }
            : {}),
        });
        lastRes = res;
        if (res.ok || res.code === 'DUPLICATE') {
          startedCount++;
        }
      }
      if (startedCount > 0) {
        haptic('commit');
        router.dismissTo('/');
        return;
      }
      haptic('fail');
      const stopped = lastRes ? isEngineStopped(lastRes) : false;
      const reason =
        lastRes && stopped ? engineStoppedBody(lastRes) : lastRes?.message;
      setAddStopped(stopped);
      setAddError(reason || notices.inline.startDownloadFailed);
      setPhase('ytReady');
      return;
    }

    const fileName = cleanBase.endsWith(ytQuality.ext)
      ? cleanBase
      : `${cleanBase}${ytQuality.ext}`;
    const headers = buildHeadersForSocial(socialProbe, ytQuality);
    const isImageItem =
      ytQuality.ext === '.jpg' ||
      ytQuality.ext === '.png' ||
      ytQuality.ext === '.webp' ||
      ytQuality.ext === '.gif';
    const res = await startDownload(ytQuality.url, {
      name: fileName,
      pageUrl: urlRef.current,
      ...(folderPath ? { folder: folderPath } : {}),
      ...(headers ? { headers } : {}),
      segments: parts,
      ...(!isImageItem ? { stream: ytQuality.streamSelection } : {}),
    });
    if (res.ok) {
      haptic('commit');
      router.dismissTo('/');
      return;
    }
    if (res.code === 'DUPLICATE') {
      showNotice({ message: notices.addDownload.duplicate });
      router.dismissTo('/');
      return;
    }
    haptic('fail');
    const stopped = isEngineStopped(res);
    const reason = stopped ? engineStoppedBody(res) : res.message;
    setAddStopped(stopped);
    setAddError(reason || notices.inline.startDownloadFailed);
    setPhase('ytReady');
  };

  const startBatchDownloads = async () => {
    if (batchUrls.length === 0) return;
    setPhase('batchAdding');
    setAddError(null);
    setAddStopped(false);

    let addedCount = 0;
    let lastFailMsg = '';
    for (let i = 0; i < batchUrls.length; i++) {
      const u = batchUrls[i];
      setBatchProgressText(`Preparing ${i + 1} of ${batchUrls.length}…`);

      // Subtle anti-429 jitter between rapid batch scrapes
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 220));
      }

      if (isSocialOrYouTubeUrl(u)) {
        const soc = await probeSocialMedia(u, probeStream);
        if (!soc.ok) {
          lastFailMsg = soc.message;
          continue;
        }
        if (soc.items.length > 1 && batchQualityPref !== 'audio') {
          const base = sanitizeFileName(soc.title);
          for (let s = 0; s < soc.items.length; s++) {
            const item = soc.items[s];
            const q =
              pickQualityForBatch(item.qualities, batchQualityPref) ??
              item.qualities[0];
            if (!q) continue;
            const slideName = `${base}_${s + 1}${q.ext}`;
            const headers = buildHeadersForSocial(soc, q);
            const isImg = /\.(?:jpe?g|png|webp|gif)$/i.test(q.ext);
            const r = await startDownload(q.url, {
              name: slideName,
              pageUrl: u,
              ...(folderPath ? { folder: folderPath } : {}),
              ...(headers ? { headers } : {}),
              segments: parts,
              ...(!isImg ? { stream: q.streamSelection } : {}),
            });
            if (r.ok || r.code === 'DUPLICATE') addedCount++;
          }
        } else {
          const q =
            pickQualityForBatch(soc.qualities, batchQualityPref) ??
            soc.qualities[0];
          if (!q) continue;
          const base = sanitizeFileName(soc.title);
          const fileName = base.endsWith(q.ext) ? base : `${base}${q.ext}`;
          const headers = buildHeadersForSocial(soc, q);
          const isImg = /\.(?:jpe?g|png|webp|gif)$/i.test(q.ext);
          const r = await startDownload(q.url, {
            name: fileName,
            pageUrl: u,
            ...(folderPath ? { folder: folderPath } : {}),
            ...(headers ? { headers } : {}),
            segments: parts,
            ...(!isImg ? { stream: q.streamSelection } : {}),
          });
          if (r.ok || r.code === 'DUPLICATE') addedCount++;
          else if (r.message) lastFailMsg = r.message;
        }
      } else {
        const r = await startDownload(u, {
          ...(folderPath ? { folder: folderPath } : {}),
          segments: parts,
        });
        if (r.ok || r.code === 'DUPLICATE') addedCount++;
        else if (r.message) lastFailMsg = r.message;
      }
    }

    if (addedCount > 0) {
      haptic('commit');
      router.dismissTo('/');
      return;
    }
    haptic('fail');
    setAddError(lastFailMsg || notices.inline.startDownloadFailed);
    setPhase('batchReady');
  };

  const renderCookiePanel = () => {
    const hasCookies = cookieSummary.totalCount > 0;
    const summaryLabel = hasCookies
      ? `Cookies active: ${cookieSummary.totalCount} (${cookieSummary.platforms.join(', ') || cookieSummary.domains.slice(0, 2).join(', ')})`
      : 'Anti-block cookies.txt: None loaded';
    return (
      <View style={styles.cookieCard}>
        <View style={styles.cookieHeaderRow}>
          <View style={styles.destText}>
            <Text style={styles.sectionLabel}>Anti-block session</Text>
            <Text style={styles.meta}>{summaryLabel}</Text>
          </View>
          <Button
            label={showCookieBox ? 'Hide' : 'cookies.txt'}
            variant="secondary"
            onPress={() => {
              haptic('tap');
              setShowCookieBox((v) => !v);
            }}
          />
        </View>
        {cookieStatusMsg ? <Text style={styles.meta}>{cookieStatusMsg}</Text> : null}
        {showCookieBox ? (
          <View style={styles.cards}>
            <TextField
              label="Paste Netscape cookies.txt or cookie header"
              value={cookieDraft}
              onChangeText={setCookieDraft}
              placeholder="# Netscape HTTP Cookie File…"
              mono
              multiline
              minLines={3}
              accessibilityLabel="Paste Netscape cookies.txt"
            />
            <View style={styles.actions}>
              <Button
                label="Import cookies.txt file"
                variant="secondary"
                onPress={() => void handleImportCookieFile()}
              />
              <Button
                label="Load pasted / clipboard"
                variant="secondary"
                onPress={() => void handlePasteCookiesFromClipboard()}
              />
              {hasCookies ? (
                <Button
                  label="Clear cookies"
                  variant="ghost"
                  onPress={() => {
                    haptic('tap');
                    clearCookies();
                    setCookieStatusMsg('Cleared stored cookies.');
                  }}
                />
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
    );
  };

  // ---------- Probing ----------
  if (phase === 'probing') {
    const detected = detectSocialPlatform(urlRef.current);
    const platformName = detected ? PLATFORM_LABELS[detected] : null;
    const checkingLabel = platformName
      ? `Checking ${platformName} link…`
      : 'Checking the link…';
    return (
      <Screen title="Add a link" onBack={close}>
        <View style={styles.centered}>
          <Text style={styles.heading}>{checkingLabel}</Text>
          <Button label="Cancel" variant="ghost" onPress={() => { token.current++; abortRef.current?.abort(); setPhase('input'); }} />
        </View>
      </Screen>
    );
  }

  // ---------- Error ----------
  if (phase === 'error' && errorView?.primary === 'blocked') {
    return (
      <Screen title="Add a link" onBack={close}>
        <EmptyBlock
          icon="warning"
          error
          title={settings.network.wifiOnly ? empty.addDownload.waitingForNetwork.title : 'Blocked by your network settings'}
          body={errorView.body}
          primary={{ label: 'Open settings', onPress: () => router.push(actionRoute('openNetworkSettings') ?? '/settings/network') }}
          secondary={{ label: 'Add anyway', onPress: () => void start(true) }}
        />
      </Screen>
    );
  }
  if (phase === 'error' && errorView?.primary === 'allowDevice') {
    return (
      <Screen title="Add a link" onBack={close}>
        <EmptyBlock
          icon="warning"
          error
          title={empty.addDownload.deviceOnNetwork.title}
          body={errorView.body}
          primary={{ label: 'Allow this device', onPress: () => void submit(urlRef.current, true) }}
          secondary={{ label: 'Back', onPress: () => setPhase('input') }}
        />
      </Screen>
    );
  }
  if (phase === 'error') {
    const errTitle = socialError ? socialError.title : empty.addDownload.badLink.title;
    const errBody = socialError ? socialError.message : errorView?.body;
    const offerBrowser = notAFile || socialError?.category === 'auth_blocked';
    return (
      <Screen title="Add a link" onBack={close} scroll contentStyle={styles.content}>
        <EmptyBlock
          icon="warning"
          error
          title={errTitle}
          body={errBody}
          primary={
            offerBrowser
              ? { label: 'Open in browser', onPress: () => openBrowser(router, { url: urlRef.current }, 'replace') }
              : errorView?.primary === 'pasteAnother'
                ? { label: 'Paste another link', onPress: () => { setText(''); void handlePaste(); } }
                : { label: 'Try again', onPress: () => void submit(urlRef.current) }
          }
          secondary={
            offerBrowser
              ? { label: 'Paste another link', onPress: () => { setText(''); void handlePaste(); } }
              : { label: 'Back', onPress: () => setPhase('input') }
          }
        />
      </Screen>
    );
  }

  // ---------- Bulk Batch Queue Ready ----------
  if (phase === 'batchReady' || phase === 'batchAdding') {
    const adding = phase === 'batchAdding';
    const platformCounts = new Map<string, number>();
    for (const u of batchUrls) {
      const p = detectSocialPlatform(u);
      const label = p ? PLATFORM_LABELS[p] : 'Direct link';
      platformCounts.set(label, (platformCounts.get(label) ?? 0) + 1);
    }
    const breakdown = [...platformCounts.entries()]
      .map(([k, count]) => `${count} ${k}`)
      .join(' · ');

    return (
      <Screen title="Add a link" onBack={close} scroll contentStyle={styles.content}>
        <Text style={styles.heading}>{`${batchUrls.length} links in batch queue`}</Text>
        <Text style={styles.meta}>{breakdown}</Text>
        <Text style={styles.sectionLabel}>Quality for all links</Text>
        <View style={styles.cards} accessibilityRole="radiogroup">
          {BATCH_QUALITY_CHOICES.map((c) => (
            <RadioCard
              key={c.id}
              title={c.label}
              description={c.description}
              icon={c.id === 'audio' ? 'play' : 'file'}
              selected={batchQualityPref === c.id}
              onPress={() => {
                if (adding) return;
                haptic('select');
                setBatchQualityPref(c.id);
              }}
            />
          ))}
        </View>
        <View style={styles.destRow}>
          <View style={styles.destText}>
            <Text style={styles.meta}>Save to</Text>
            <Text style={styles.dest} numberOfLines={1} ellipsizeMode="middle" accessibilityLabel={`Save to ${friendlyPath(folderLabel ?? defaultStoragePath)}`}>
              {friendlyPath(folderLabel ?? defaultStoragePath)}
            </Text>
          </View>
          <Button label="Change" variant="secondary" disabled={adding} onPress={() => void handleChangeFolder()} />
        </View>
        {adding && batchProgressText ? <Text style={styles.meta}>{batchProgressText}</Text> : null}
        {addError ? <Banner tone="danger" title={addError} /> : null}
        <View style={styles.gap}>
          <Button
            label={`Download all (${batchUrls.length})`}
            size="lg"
            fullWidth
            loading={adding}
            disabled={adding}
            onPress={() => void startBatchDownloads()}
          />
          <Button label="Cancel" variant="ghost" size="lg" fullWidth disabled={adding} onPress={close} />
        </View>
      </Screen>
    );
  }

  // ---------- Social Media & YouTube Ready ----------
  if ((phase === 'ytReady' || phase === 'ytAdding') && socialProbe && ytQuality) {
    const adding = phase === 'ytAdding';
    const duration = formatYouTubeDuration(socialProbe.durationSecs);
    const subCount = socialProbe.subtitles.length;
    const subNote = subCount === 1 ? '1 subtitle embedded' : subCount > 1 ? `${subCount} subtitles embedded` : '';
    const formatBadge =
      ytQuality.kind === 'audio'
        ? 'M4A Audio'
        : socialProbe.mediaKind === 'image'
          ? 'Original full-res'
          : 'Fast-start MP4 · No watermark';
    const infoLine = [
      socialProbe.platformLabel,
      socialProbe.author,
      duration,
      formatBadge,
      subNote,
    ]
      .filter(Boolean)
      .join(' · ');
    const mobileNote = mobileDataLine(onMeteredNetwork, settings.network.wifiOnly, ytQuality.estBytes);
    const isCarousel = socialProbe.items.length > 1;
    const downloadButtonLabel =
      isCarousel && selectedSlideIndex === -1 && ytQuality.kind !== 'audio'
        ? `Download all (${socialProbe.items.length})`
        : 'Download';

    return (
      <Screen title="Add a link" onBack={close} scroll contentStyle={styles.content}>
        <TextField
          value={baseName}
          onChangeText={setBaseName}
          editable={!adding}
          mono
          multiline
          minLines={1}
          size="lg"
          trailing={<Text style={styles.ext}>{ytQuality.ext}</Text>}
          error={nameError ?? undefined}
          accessibilityLabel="File name"
        />
        {infoLine ? <Text style={styles.meta}>{infoLine}</Text> : null}
        {isCarousel ? (
          <>
            <Text style={styles.sectionLabel}>{`Carousel items (${socialProbe.items.length})`}</Text>
            <View style={styles.actions}>
              <Button
                label={`All ${socialProbe.items.length} items`}
                variant={selectedSlideIndex === -1 ? 'primary' : 'secondary'}
                onPress={() => {
                  if (adding) return;
                  haptic('select');
                  setSelectedSlideIndex(-1);
                  setYtQualityId(socialProbe.qualities[0]?.id ?? null);
                }}
              />
              {socialProbe.items.map((item, idx) => (
                <Button
                  key={item.id}
                  label={`#${idx + 1} (${item.kind})`}
                  variant={selectedSlideIndex === idx ? 'primary' : 'secondary'}
                  onPress={() => {
                    if (adding) return;
                    haptic('select');
                    setSelectedSlideIndex(idx);
                    setYtQualityId(item.qualities[0]?.id ?? null);
                  }}
                />
              ))}
            </View>
          </>
        ) : null}
        <Text style={styles.sectionLabel}>Quality</Text>
        <View style={styles.cards} accessibilityRole="radiogroup">
          {activeQualities.map((q) => (
            <RadioCard
              key={q.id}
              title={q.label}
              description={q.description}
              icon={q.icon}
              selected={q.id === ytQuality.id}
              onPress={() => {
                if (adding) return;
                haptic('select');
                setYtQualityId(q.id);
              }}
            />
          ))}
        </View>
        <View style={styles.destRow}>
          <View style={styles.destText}>
            <Text style={styles.meta}>Save to</Text>
            <Text style={styles.dest} numberOfLines={1} ellipsizeMode="middle" accessibilityLabel={`Save to ${friendlyPath(folderLabel ?? defaultStoragePath)}`}>
              {friendlyPath(folderLabel ?? defaultStoragePath)}
            </Text>
          </View>
          <Button label="Change" variant="secondary" disabled={adding} onPress={() => void handleChangeFolder()} />
        </View>
        {mobileNote ? <Banner tone="info" title={mobileNote} /> : null}
        {doesntFit ? <Banner tone="danger" title={banners.addDownload.notEnoughSpace.title} body={noSpace} /> : null}
        {addError ? (
          addStopped ? (
            <Banner
              tone="danger"
              title={empty.engineStopped.title}
              body={addError}
              actionLabel={START_ENGINE_LABEL}
              onAction={() => void restartEngine().then((ok) => { if (ok) void startSocialDownload(); })}
            />
          ) : (
            <Banner tone="danger" title={addError} />
          )
        ) : null}
        <View style={styles.gap}>
          <Button label={downloadButtonLabel} size="lg" fullWidth loading={adding} disabled={adding || doesntFit || nameInvalid} onPress={() => void startSocialDownload()} />
          <Button label="Cancel" variant="ghost" size="lg" fullWidth disabled={adding} onPress={close} />
        </View>
      </Screen>
    );
  }

  // ---------- Ready ----------
  if ((phase === 'ready' || phase === 'adding') && probe) {
    const adding = phase === 'adding';
    const size = probe.size;
    const mobileNote = mobileDataLine(onMeteredNetwork, settings.network.wifiOnly, size);
    return (
      <Screen title="Add a link" onBack={close} scroll contentStyle={styles.content}>
        <TextField
          value={baseName}
          onChangeText={setBaseName}
          editable={!adding}
          mono
          multiline
          minLines={1}
          size="lg"
          trailing={splitName(probe.name).ext ? <Text style={styles.ext}>{splitName(probe.name).ext}</Text> : null}
          error={nameError ?? undefined}
          accessibilityLabel="File name"
        />
        <Text style={styles.meta}>{size != null ? formatBytes(size) : 'Size unknown'}</Text>
        <Text style={styles.meta} numberOfLines={2}>{probe.urlDisplay}</Text>
        <Text style={styles.meta}>
          {probe.resumable ? 'You can pause and resume this one.' : "This server can't resume. It starts over if it stops."}
        </Text>
        <View style={styles.destRow}>
          <View style={styles.destText}>
            <Text style={styles.meta}>Save to</Text>
            <Text style={styles.dest} numberOfLines={1} ellipsizeMode="middle" accessibilityLabel={`Save to ${friendlyPath(folderLabel ?? defaultStoragePath)}`}>
              {friendlyPath(folderLabel ?? defaultStoragePath)}
            </Text>
          </View>
          <Button label="Change" variant="secondary" disabled={adding} onPress={() => void handleChangeFolder()} />
        </View>
        {subs.show ? <SubtitlesAutoRow on={subs.on} onChange={subs.setOn} disabled={adding} /> : null}
        {subs.node}
        <ChipGroup label="Parts" options={PART_OPTIONS} value={parts} onChange={(v) => setPartsOverride(v)} />
        {mobileNote ? <Banner tone="info" title={mobileNote} /> : null}
        {doesntFit ? <Banner tone="danger" title={banners.addDownload.notEnoughSpace.title} body={noSpace} /> : null}
        {addError ? (
          addStopped ? (
            <Banner
              tone="danger"
              title={empty.engineStopped.title}
              body={addError}
              actionLabel={START_ENGINE_LABEL}
              onAction={() => void restartEngine().then((ok) => { if (ok) void start(); })}
            />
          ) : (
            <Banner tone="danger" title={addError} />
          )
        ) : null}
        <View style={styles.gap}>
          <Button label="Start" size="lg" fullWidth loading={adding} disabled={adding || doesntFit || nameInvalid} onPress={() => void start()} />
          <Button label="Cancel" variant="ghost" size="lg" fullWidth disabled={adding} onPress={close} />
        </View>
      </Screen>
    );
  }

  // ---------- Input ----------
  const canSubmit = text.trim().length > 0;
  return (
    <Screen title="Add a link" onBack={close} scroll contentStyle={styles.content}>
      <TextField
        label="Link to a file, YouTube, or social post (paste multiple lines for batch)"
        value={text}
        onChangeText={onChangeText}
        placeholder="https://… (YouTube, Instagram, TikTok, Reddit, Facebook, Threads, Pinterest)"
        mono
        multiline
        minLines={3}
        returnKeyType="go"
        onSubmitEditing={() => canSubmit && void submit(text)}
        error={message ?? undefined}
        accessibilityLabel="Link to a file or YouTube"
      />
      <View style={styles.actions}>
        <Button label="Paste" icon="clipboard" variant="secondary" onPress={() => void handlePaste()} />
      </View>
      <View style={styles.gap}>
        <Button label="Get info" size="lg" fullWidth disabled={!canSubmit} onPress={() => void submit(text)} />
      </View>
      <StreamSheet item={streamItem} onClose={() => setStreamItem(null)} onStarted={() => { setStreamItem(null); close(); }} onCopyLink={(u) => { void Clipboard.setStringAsync(u); }} />
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.md },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    gap: { marginTop: spacing.sm },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, paddingHorizontal: spacing.xxxl },
    heading: { ...type.bodyStrong, fontSize: type.size.xl, color: c.text, textAlign: 'center' },
    ext: { ...type.mono, fontSize: type.size.lg, lineHeight: Math.round(type.size.lg * 1.4), color: c.textMuted },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    sectionLabel: { ...type.bodyStrong, fontSize: type.size.md, color: c.textMuted },
    cards: { gap: spacing.sm },
    destRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
      minHeight: touch.min,
    },
    cookieCard: {
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    cookieHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: touch.min,
    },
    destText: { flex: 1 },
    dest: { ...type.mono, fontSize: type.size.md, color: c.text, marginTop: 2 },
  });
