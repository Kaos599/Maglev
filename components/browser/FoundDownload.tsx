import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { getCookies, sanitizeFileName, type DownloadOptions, type UrlProbe } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { haptic } from '../../constants/haptics';
import { banners, foundTray, mobileDataLine, notices } from '../../constants/copy';
import { probeErrorView } from '../../utils/downloadCopy';
import { useDownloadAdmission } from '../../utils/useDownloadAdmission';
import { hostOf } from '../../utils/browserUrl';
import { Banner, Button, Sheet } from '../ui';
import { useSettings } from '../../context/SettingsContext';
import { SaveToChoice } from './SaveToChoice';
import { saveFolder } from './saveTo';

/** A file the browser found, or one a page offered as a download. */
export interface DownloadTarget {
  url: string;
  name: string;
  size: number | null;
  /** The page it came from. Sent as the Referer. */
  pageUrl: string;
  /** The user agent the page used. Sent as the User-Agent. */
  userAgent: string;
  installer?: boolean;
}

type Phase = 'probing' | 'ready' | 'error' | 'adding';

/** Headers that make the download look like the page asked for it (cookies, referer, user agent). */
export async function downloadHeaders(t: Pick<DownloadTarget, 'url' | 'pageUrl' | 'userAgent'>): Promise<NonNullable<DownloadOptions['headers']>> {
  const headers: NonNullable<DownloadOptions['headers']> = {};
  const cookie = await getCookies(t.url);
  if (cookie) headers.Cookie = cookie;
  if (t.pageUrl) headers.Referer = t.pageUrl;
  if (t.userAgent) headers['User-Agent'] = t.userAgent;
  return headers;
}

/** Name, size and folder for one file, then Start. Same checks as Add download (probe, free space, admission). */
export function FoundDownloadSheet({ target, onClose, onView }: { target: DownloadTarget | null; onClose: () => void; /** Opens the new download in Transfers (the View action on the notice). */ onView?: (id: string) => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { probeUrl, startDownload, showNotice, onMeteredNetwork } = useMaglevEngine();
  const { settings } = useSettings();
  const last = useRef<DownloadTarget | null>(target);
  if (target) last.current = target;
  const t = target ?? last.current;

  const [phase, setPhase] = useState<Phase>('probing');
  const [name, setName] = useState('');
  const [probe, setProbe] = useState<UrlProbe | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  // null = the default folder. Else the subfolder name typed for this download only.
  const [sub, setSub] = useState<string | null>(null);
  const token = useRef(0);

  const url = target?.url ?? null;
  useEffect(() => {
    if (!url || !target) return;
    const mine = ++token.current;
    setPhase('probing');
    setProbe(null);
    setMessage(null);
    setName(target.name);
    setSub(null);
    void (async () => {
      const headers = await downloadHeaders(target);
      const res = await probeUrl(url, { headers });
      if (mine !== token.current) return;
      if (res.ok) {
        setProbe(res);
        setName((n) => (n === target.name || !n ? res.name || target.name : n));
        setPhase('ready');
        return;
      }
      setMessage(probeErrorView(res.code, res.message, res.httpStatus).body);
      setPhase('error');
    })();
    // The target object changes with every render of the parent; the link and a retry decide a new probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tries, probeUrl]);

  const size = probe?.size ?? t?.size ?? null;
  const { doesntFit } = useDownloadAdmission(size, phase === 'ready');

  if (!t) return null;
  const mobileNote = phase === 'ready' ? mobileDataLine(onMeteredNetwork, settings.network.wifiOnly, size) : null;
  const adding = phase === 'adding';
  const root = settings.storage.defaultPath;
  const folder = sub != null ? saveFolder(root, sub) : null;
  const folderMissing = sub != null && folder == null;

  const start = async () => {
    setPhase('adding');
    setMessage(null);
    const clean = sanitizeFileName(name.trim());
    const edited = name.trim() !== '' && clean !== (probe?.name ?? t.name);
    const headers = await downloadHeaders(t);
    const res = await startDownload(t.url, { headers, ...(edited ? { name: clean } : {}), ...(folder ? { folder } : {}) });
    if (res.ok) {
      haptic('commit');
      showNotice({ message: notices.browser.addedToTransfers, actionLabel: foundTray.view, onAction: () => onView?.(res.id) }, 5000);
      onClose();
      return;
    }
    if (res.code === 'DUPLICATE') {
      showNotice({ message: notices.addDownload.duplicate });
      onClose();
      return;
    }
    haptic('fail');
    setMessage(res.message || notices.inline.startDownloadFailed);
    setPhase('ready');
  };

  return (
    <Sheet visible={target != null} onClose={onClose} title="Download" subtitle={hostOf(t.url)}>
      <View style={styles.body}>
        <Text style={styles.label}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          style={styles.field}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          multiline
          selectionColor={colors.accent}
          placeholderTextColor={colors.textFaint}
          editable={phase === 'ready'}
          accessibilityLabel="File name"
        />
        <Text style={styles.meta}>{phase === 'probing' ? 'Checking the file' : size != null ? formatBytes(size) : 'Size unknown'}</Text>
        <SaveToChoice value={sub} onChange={setSub} root={root} disabled={adding} />
        {mobileNote ? <Banner tone="info" title={mobileNote} /> : null}
        {t.installer ? <Banner tone="warning" title={banners.browser.installer.title} body={banners.browser.installer.body} /> : null}
        {doesntFit ? <Banner tone="danger" title={banners.addDownload.notEnoughSpace.title} body={banners.addDownload.notEnoughSpace.body} /> : null}
        {message ? <Banner tone="danger" title={message} /> : null}
        <View style={styles.actions}>
          <Button label="Cancel" variant="ghost" onPress={onClose} disabled={adding} />
          {phase === 'error' ? (
            <Button label="Try again" onPress={() => setTries((n) => n + 1)} />
          ) : (
            <Button label="Start" loading={adding} disabled={phase !== 'ready' || doesntFit || folderMissing} onPress={() => void start()} />
          )}
        </View>
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    body: { gap: spacing.sm },
    label: { ...type.bodyStrong, fontSize: type.size.md, color: c.textMuted },
    field: {
      ...type.mono,
      fontSize: type.size.md,
      color: c.text,
      minHeight: 48,
      textAlignVertical: 'top',
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  });
