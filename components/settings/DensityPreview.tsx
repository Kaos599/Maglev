import React, { useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import type { TelemetryDensity } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type, radius } from '../../constants/theme';
import { formatProgressPercent } from '../../constants/format';
import { PixelIcon } from '../PixelIcon';
import { Button, ListRow } from '../ui';
import { CompactLine } from '../detail/CompactLine';
import { ProgressBadge, ProgressCard } from '../detail/ProgressCard';
import { StateBadge } from '../detail/StateBadge';
import { TorrentStats } from '../detail/TorrentStats';
import { DownloadStats, type DownloadStatsInput } from '../transfers/DownloadStats';

export type PreviewKind = 'link' | 'torrent';

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
/** The width of the page the preview draws (a 412 dp phone), then scales down to the card's inner width. */
const CANVAS_W = 412;
const FRAME_BORDER = 1;
/** NATIVE_CONTRACT 41.4: the preview is about 236 dp high and fades to the background over its last 48 dp. */
const PREVIEW_H = 236;
const FADE_H = 48;

// NATIVE_CONTRACT 41.4: fixed sample data, never live data.
const LINK_SAMPLE: DownloadStatsInput = {
  state: 'downloading',
  downBps: 8.4 * MB,
  eta: 7 * 60,
  size: 5.8 * GB,
  downloaded: 2.2 * GB,
  segmentsActive: 8,
  activeSecs: 270,
  finishedAt: 0,
  addedAt: 0,
  sessionBytes: 8.1 * MB * 270,
  bytesWifi: 0,
  bytesMobile: 0,
};
const LINK_PROGRESS = 0.38;
const TORRENT_PROGRESS = 0.42;
const TORRENT_SAMPLE = {
  downBps: 2.1 * MB,
  upBps: 140 * KB,
  etaSecs: 3 * 60,
  ratio: 0.04,
  peersLive: 18,
  peersSeen: 353,
  totalBytes: 123 * MB,
  timing: { activeSecs: 72, finishedAt: 0, addedAt: 0, sessionBytes: 1.7 * MB * 72, bytesWifi: 0, bytesMobile: 0 },
};

/**
 * NATIVE_CONTRACT 41.4: the page as it looks in one density, drawn from the real page parts (ProgressCard, CompactLine,
 * DownloadStats, TorrentStats, Button, ListRow) with the sample data above, scaled down to fit its card.
 * Hidden from screen readers and from touches; the card around it carries the words.
 */
export function DensityPreview({ kind, density }: { kind: PreviewKind; density: TelemetryDensity }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [w, setW] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  const scale = w > 0 ? (w - 2 * FRAME_BORDER) / CANVAS_W : 1;
  const canvasH = Math.round(PREVIEW_H / scale);
  const compact = density === 'COMPACT';
  const link = kind === 'link';

  return (
    <View
      style={s.frame}
      onLayout={onLayout}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={`density-preview-${kind}-${compact ? 'compact' : 'detailed'}`}
    >
      {w > 0 ? (
        <View
          style={[
            s.canvas,
            {
              height: canvasH,
              transformOrigin: 'top left',
              transform: [{ scale }],
            },
          ]}
        >
          <View style={s.header}>
            <PixelIcon name="back" size={24} color={colors.text} />
            <Text style={s.name} numberOfLines={1}>
              {link ? 'ubuntu-24.04.1.iso' : 'Sintel'}
            </Text>
            <PixelIcon name="pause" size={24} color={colors.text} />
          </View>
          <View style={s.body}>
            {link ? (
              <ProgressCard badge={<ProgressBadge label="Downloading" tint={colors.download} />} percent={`${Math.round(LINK_PROGRESS * 100)}%`} progress={LINK_PROGRESS} tone="download" barLabel="Download progress">
                {compact ? <CompactLine down={LINK_SAMPLE.downBps} etaSecs={LINK_SAMPLE.eta} /> : null}
              </ProgressCard>
            ) : (
              <ProgressCard badge={<StateBadge state="DOWNLOADING" />} percent={formatProgressPercent(TORRENT_PROGRESS)} progress={TORRENT_PROGRESS} tone="download" barLabel="Download progress">
                {compact ? <CompactLine down={TORRENT_SAMPLE.downBps} up={TORRENT_SAMPLE.upBps} etaSecs={TORRENT_SAMPLE.etaSecs} /> : null}
              </ProgressCard>
            )}
            <View style={s.block}>
              <Button label="Open folder" icon="folder" variant="secondary" fullWidth onPress={noop} />
            </View>
            {!compact ? <View style={s.block}>{link ? <DownloadStats download={LINK_SAMPLE} /> : <TorrentStats {...TORRENT_SAMPLE} />}</View> : null}
            <ListRow title="Saved to" value={link ? 'Download/Maglev' : 'Download/Maglev/Sintel'} icon="folder" />
          </View>
        </View>
      ) : null}
      <Svg style={s.fade} width="100%" height={FADE_H}>
        <Defs>
          <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.bg} stopOpacity={0} />
            <Stop offset="1" stopColor={colors.bg} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height={FADE_H} fill="url(#fade)" />
      </Svg>
    </View>
  );
}

function noop() {}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    frame: { height: PREVIEW_H, borderRadius: radius.sm, borderWidth: FRAME_BORDER, borderColor: c.border, overflow: 'hidden', backgroundColor: c.bg },
    canvas: { position: 'absolute', top: 0, left: 0, width: CANVAS_W },
    header: { height: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg },
    name: { ...type.heading, flex: 1, fontSize: 20, color: c.text }, // design-exception: scaled replica of the real header, size is part of the preview geometry
    body: { paddingHorizontal: spacing.lg },
    block: { marginBottom: spacing.md },
    fade: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  });
