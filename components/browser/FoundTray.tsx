import React, { useMemo, useState } from 'react';
import { FlatList, Image, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { FoundItem } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { haptic } from '../../constants/haptics';
import { banners, empty, notices } from '../../constants/copy';
import { hostOf } from '../../utils/browserUrl';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { Chip, EmptyBlock, PressableScale, Sheet } from '../ui';
import { FILTER_LABEL, countByKind, effectiveFilter, isInstaller, sortFound, streamTag, visibleFilters, type FoundFilter } from './foundFilter';

const KIND_ICON: Record<FoundItem['kind'], PixelIconName> = {
  video: 'file-video',
  audio: 'file-audio',
  image: 'file-image',
  document: 'file-doc',
  other: 'file',
};

function iconFor(item: FoundItem): PixelIconName {
  if (item.stream) return 'stream';
  if (isInstaller(item)) return 'file-app';
  return KIND_ICON[item.kind];
}

function Row({ item, onPress, onLongPress }: { item: FoundItem; onPress: () => void; onLongPress: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [thumbFailed, setThumbFailed] = useState(false);
  const tag = streamTag(item);
  const installer = isInstaller(item);
  const meta = [item.size != null ? formatBytes(item.size) : null, hostOf(item.url), tag].filter(Boolean).join(' · ');
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, ${meta}`}
      accessibilityHint="Long-press to copy the link"
      style={styles.row}
    >
      <View style={styles.thumb}>
        {item.kind === 'image' && !thumbFailed ? (
          <Image source={{ uri: item.url }} style={styles.thumbImage} resizeMode="cover" onError={() => setThumbFailed(true)} />
        ) : (
          <PixelIcon name={iconFor(item)} size={20} color={installer ? colors.warning : colors.textMuted} />
        )}
      </View>
      <View style={styles.main}>
        <Text style={styles.name} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
        {installer ? (
          <Text style={styles.warning}>
            {banners.browser.installer.title}. {banners.browser.installer.body}
          </Text>
        ) : null}
      </View>
    </PressableScale>
  );
}

export interface FoundTrayProps {
  visible: boolean;
  items: readonly FoundItem[];
  onClose: () => void;
  /** A file row was tapped. */
  onPick: (item: FoundItem) => void;
  /** A stream row (HLS or DASH) was tapped. */
  onPickStream: (item: FoundItem) => void;
}

/** The files the page loaded or links to, filtered by kind. Tap a row to download it. */
export function FoundTray({ visible, items, onClose, onPick, onPickStream }: FoundTrayProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { showNotice } = useMaglevEngine();
  const { height } = useWindowDimensions();
  const [filter, setFilter] = useState<FoundFilter>('all');
  const counts = useMemo(() => countByKind(items), [items]);
  const active = effectiveFilter(filter, counts);
  const shown = useMemo(() => sortFound(items, active), [items, active]);

  const copyLink = async (item: FoundItem) => {
    try {
      await Clipboard.setStringAsync(item.url);
      haptic('done');
      showNotice({ message: notices.browser.linkCopied }, 2500);
    } catch {
      haptic('fail');
      showNotice({ message: notices.browser.linkCopyFailed });
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Files" subtitle={items.length ? `${items.length} found on your pages` : undefined}>
      {items.length === 0 ? (
        <EmptyBlock icon="file" title={empty.browser.noFiles.title} body={empty.browser.noFiles.body} />
      ) : (
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="radiogroup">
            {visibleFilters(counts).map((f) => (
              <Chip key={f} label={FILTER_LABEL[f]} count={counts[f]} selected={f === active} onPress={() => setFilter(f)} />
            ))}
          </ScrollView>
          <FlatList
            data={shown}
            keyExtractor={(i) => i.id}
            style={{ maxHeight: height * 0.55 }}
            renderItem={({ item }) => (
              <Row item={item} onPress={() => (item.stream ? onPickStream(item) : onPick(item))} onLongPress={() => void copyLink(item)} />
            )}
          />
        </View>
      )}
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    chips: { flexDirection: 'row', gap: spacing.sm, paddingBottom: spacing.md },
    row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
    thumb: {
      width: 40,
      height: 40,
      borderRadius: radius.md,
      backgroundColor: c.surfaceRaised,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    thumbImage: { width: 40, height: 40 },
    main: { flex: 1, minWidth: 44 },
    name: { ...type.mono, fontSize: type.size.md, color: c.text },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted, marginTop: 2 },
    warning: { ...type.body, fontSize: 12, lineHeight: 17, color: c.warning, marginTop: 2 },
  });
