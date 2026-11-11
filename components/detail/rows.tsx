import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DetailFile, DetailPeer, DetailTracker } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes, formatSpeed } from '../../constants/format';
import { PixelIcon } from '../PixelIcon';
import { PressableScale, ProgressBar } from '../ui';
import { Checkbox } from './Checkbox';
import { isMediaFile } from './torrentLabels';

interface FileRowProps {
  file: DetailFile;
  onToggle: (file: DetailFile, next: boolean) => void;
  onOpenActions: (file: DetailFile) => void;
}

function FileRowBase({ file, onToggle, onOpenActions }: FileRowProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const done = file.length > 0 && file.progressBytes >= file.length;
  const frac = file.length > 0 ? file.progressBytes / file.length : 0;
  const actionable = done || isMediaFile(file.path);
  const body = (
    <View style={styles.body}>
      <Text style={[styles.name, !file.included && styles.skipped]} numberOfLines={2} ellipsizeMode="middle">
        {file.path}
      </Text>
      <Text style={styles.meta}>
        {formatBytes(file.length)} · {file.included ? `${Math.floor(frac * 100)}%` : 'Skipped'}
        {done ? ' · Done' : ''}
      </Text>
      {file.included ? (
        <View style={styles.bar}>
          <ProgressBar progress={frac} tone={done ? 'seed' : 'download'} accessibilityLabel={`${Math.floor(frac * 100)} percent`} />
        </View>
      ) : null}
    </View>
  );
  return (
    <View style={styles.row}>
      <Checkbox
        checked={file.included}
        onChange={(next) => onToggle(file, next)}
        accessibilityLabel={`Download ${file.path}`}
      />
      {actionable ? (
        <PressableScale
          style={styles.press}
          onPress={() => onOpenActions(file)}
          accessibilityRole="button"
          accessibilityLabel={`${file.path}, ${formatBytes(file.length)}. File options`}
        >
          {body}
          <PixelIcon name="more" size={20} color={colors.textMuted} />
        </PressableScale>
      ) : (
        <View style={styles.press}>{body}</View>
      )}
    </View>
  );
}
export const FileRow = memo(FileRowBase);

export function PeerRow({ peer }: { peer: DetailPeer }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.listItem} accessible accessibilityLabel={`${peer.addr}, ${peer.client || 'unknown client'}`}>
      <Text style={styles.name} numberOfLines={1}>{peer.addr}</Text>
      <Text style={styles.meta} numberOfLines={1}>{peer.client || 'Unknown client'}</Text>
      <View style={styles.speeds}>
        <Text style={[styles.speed, { color: colors.download }]}>↓ {formatSpeed(peer.downBps)}</Text>
        <Text style={[styles.speed, { color: colors.upload }]}>↑ {formatSpeed(peer.upBps)}</Text>
      </View>
    </View>
  );
}

export function TrackerRow({ tracker }: { tracker: DetailTracker }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.listItem}>
      <Text style={styles.name} selectable>{tracker.url}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      marginBottom: spacing.sm,
      paddingLeft: spacing.xs,
    },
    press: { flex: 1, minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingRight: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm },
    body: { flex: 1 },
    name: { ...type.mono, fontSize: type.size.md, color: c.text },
    skipped: { color: c.textMuted },
    meta: { ...type.mono, fontSize: type.size.xs, color: c.textMuted, marginTop: 2 },
    bar: { marginTop: spacing.sm },
    listItem: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      marginBottom: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    speeds: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.xs },
    speed: { ...type.mono, fontSize: type.size.sm },
  });
