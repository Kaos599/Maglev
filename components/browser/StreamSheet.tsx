import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import { sanitizeFileName, type FoundItem, type StreamProbe } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { banners, mobileDataLine, notices, streamSheet } from '../../constants/copy';
import { probeErrorView } from '../../utils/downloadCopy';
import { useDownloadAdmission } from '../../utils/useDownloadAdmission';
import { hostOf } from '../../utils/browserUrl';
import { Banner, Button, RadioCard } from '../ui';
import { FloatingSheet, afterSheetCloses, NoteRow } from './FloatingSheet';
import { useSettings } from '../../context/SettingsContext';
import { downloadHeaders } from './FoundDownload';
import { SaveToRow } from './SaveToRow';
import { audioLabel, buildSelection, defaultAudio, defaultVariant, needsAudioPicker, qualityLabel } from './streamChoice';

type Phase = 'probing' | 'ready' | 'error' | 'adding';

const STREAM_BANNERS = {
  STREAM_PROTECTED: banners.browser.streamProtected.title,
  STREAM_LIVE: banners.browser.streamLive.title,
  STREAM_UNSUPPORTED: banners.browser.streamUnsupported.title,
} as const;

interface Props {
  item: FoundItem | null;
  /** The title of the page the stream was found on. Prefills the name. */
  pageTitle?: string;
  /** The user agent the page used. Sent as the User-Agent. */
  userAgent?: string;
  /** The page address. Sent as the Referer when the item has none. */
  pageUrl?: string;
  onClose: () => void;
  /** Called instead of onClose after a download started (or was a duplicate). Defaults to onClose. */
  onStarted?: () => void;
  onCopyLink: (url: string) => void;
}

/** Pick a quality (and audio language) of an HLS or DASH stream, then Start. */
export function StreamSheet({ item, pageTitle, userAgent = '', pageUrl = '', onClose, onStarted, onCopyLink }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { probeStream, startDownload, showNotice, onMeteredNetwork } = useMaglevEngine();
  const { settings } = useSettings();
  const last = useRef<FoundItem | null>(item);
  if (item) last.current = item;
  const it = item ?? last.current;

  const [phase, setPhase] = useState<Phase>('probing');
  const [probe, setProbe] = useState<StreamProbe | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [audioId, setAudioId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [tries, setTries] = useState(0);
  const token = useRef(0);

  const url = item?.url ?? null;
  useEffect(() => {
    if (!url || !item) return;
    const mine = ++token.current;
    setPhase('probing');
    setProbe(null);
    setMessage(null);
    setVariantId(null);
    setAudioId(null);
    setName(sanitizeFileName((pageTitle || item.name || '').trim()));
    void (async () => {
      const headers = await downloadHeaders({ url, pageUrl: item.pageUrl || pageUrl, userAgent });
      const res = await probeStream(url, { headers });
      if (mine !== token.current) return;
      if (res.ok) {
        setProbe(res);
        setVariantId(defaultVariant(res.variants)?.id ?? null);
        setAudioId(defaultAudio(res.audioTracks));
        setName((n) => n || sanitizeFileName((res.title || '').trim()));
        setPhase('ready');
        return;
      }
      const known = STREAM_BANNERS[res.code as keyof typeof STREAM_BANNERS];
      if (known) {
        setMessage(res.message || known);
        setCanRetry(false);
      } else {
        setMessage(res.message || probeErrorView(res.code, res.message, res.httpStatus).body);
        setCanRetry(true);
      }
      setPhase('error');
    })();
    // The item object changes with every render of the parent; the link and a retry decide a new probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tries, probeStream]);

  const variant = probe?.variants.find((v) => v.id === variantId) ?? null;
  const { doesntFit } = useDownloadAdmission(variant?.estBytes ?? null, phase === 'ready');

  if (!it) return null;
  const adding = phase === 'adding';
  const mobileNote = phase === 'ready' ? mobileDataLine(onMeteredNetwork, settings.network.wifiOnly, variant?.estBytes ?? null) : null;
  const askAudio = probe ? needsAudioPicker(variant, probe.audioTracks) : false;

  const start = async () => {
    if (!probe || !variant) return;
    setPhase('adding');
    setMessage(null);
    const clean = sanitizeFileName(name.trim());
    const headers = await downloadHeaders({ url: it.url, pageUrl: it.pageUrl || pageUrl, userAgent });
    const res = await startDownload(it.url, {
      headers,
      ...(clean ? { name: clean } : {}),
      stream: buildSelection(probe.kind, probe, variant, audioId),
    });
    if (res.ok) {
      haptic('commit');
      (onStarted ?? onClose)();
      afterSheetCloses(() => showNotice({ message: notices.browser.addedToTransfers }, 3000));
      return;
    }
    if (res.code === 'DUPLICATE') {
      (onStarted ?? onClose)();
      afterSheetCloses(() => showNotice({ message: notices.addDownload.duplicate }));
      return;
    }
    haptic('fail');
    setMessage(res.message || notices.inline.startDownloadFailed);
    setPhase('ready');
  };

  return (
    <FloatingSheet visible={item != null} onClose={onClose} title={streamSheet.title} subtitle={hostOf(it.url)}>
      <View style={styles.body}>
        {phase === 'probing' ? (
          <View style={styles.reading} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.meta}>{streamSheet.reading}</Text>
          </View>
        ) : null}

        {probe && phase !== 'probing' && phase !== 'error' ? (
          <>
            <Text style={styles.label}>{streamSheet.quality}</Text>
            <View style={styles.cards} accessibilityRole="radiogroup">
              {probe.variants.map((v) => (
                <RadioCard
                  key={v.id}
                  title={qualityLabel(v, probe.variants)}
                  description={v.audio === 'none' ? 'No sound' : `${(v.bandwidth / 1_000_000).toFixed(1)} Mbps`}
                  icon="file"
                  selected={v.id === variantId}
                  onPress={() => {
                    haptic('select');
                    setVariantId(v.id);
                  }}
                />
              ))}
            </View>
            {askAudio ? (
              <>
                <Text style={styles.label}>{streamSheet.audio}</Text>
                <View style={styles.cards} accessibilityRole="radiogroup">
                  {probe.audioTracks.map((t, i) => (
                    <RadioCard
                      key={t.id}
                      title={audioLabel(t, i)}
                      description=""
                      icon="play"
                      selected={t.id === audioId}
                      onPress={() => {
                        haptic('select');
                        setAudioId(t.id);
                      }}
                    />
                  ))}
                </View>
              </>
            ) : null}
            <Text style={styles.label}>{streamSheet.name}</Text>
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
              editable={!adding}
              accessibilityLabel="File name"
            />
            <SaveToRow disabled={adding} onError={setMessage} />
          </>
        ) : null}

        {mobileNote ? <NoteRow text={mobileNote} /> : null}
        {doesntFit ? <Banner tone="danger" title={banners.addDownload.notEnoughSpace.title} body={banners.addDownload.notEnoughSpace.body} /> : null}
        {message ? <Banner tone="danger" title={message} /> : null}

        <View style={styles.actions}>
          <Button label="Copy link" icon="copy" variant="ghost" onPress={() => onCopyLink(it.url)} disabled={adding} />
          {phase === 'error' ? (
            canRetry ? <Button label="Try again" onPress={() => setTries((n) => n + 1)} /> : <Button label="Close" onPress={onClose} />
          ) : (
            <Button label="Start" loading={adding} disabled={phase !== 'ready' || !variant || doesntFit} onPress={() => void start()} />
          )}
        </View>
      </View>
    </FloatingSheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    body: { gap: spacing.sm },
    reading: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48 },
    cards: { gap: spacing.sm },
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
