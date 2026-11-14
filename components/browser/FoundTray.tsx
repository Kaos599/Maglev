import React, { useMemo, useState } from 'react';
import { FlatList, Image, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { FoundItem } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { banners, empty, foundTray, notices } from '../../constants/copy';
import { useBrowserPrefs } from '../../utils/prefs/browser';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { Chip, EmptyBlock, PressableScale, Sheet } from '../ui';
import { useFoundSize } from './useFoundSize';
import { FILTER_LABEL, chosenFilter, countByKind, defaultFilter, effectiveFilter, foundDetail, foundSizeLabel, isInstaller, pageKeyOf, sortFound, sourceLabel, splitSmall, visibleFilters, type FoundFilter } from './foundFilter';

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

function Row({
  item,
  userAgent,
  onPress,
  onLongPress,
  onRemove,
}: {
  item: FoundItem;
  userAgent: string;
  onPress: () => void;
  onLongPress: () => void;
  onRemove: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { probeStream } = useMaglevEngine();
  const [thumbFailed, setThumbFailed] = useState(false);
  const installer = isInstaller(item);
  const probed = useFoundSize(item, userAgent, probeStream);
  const detail = foundDetail({ ...item, height: item.height ?? probed.height });
  const sizeText = foundSizeLabel(probed);
  const meta = [sizeText, detail, sourceLabel(item)].filter(Boolean).join(' · ');
  return (
    <View style={styles.rowWrap}>
      <PressableScale
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${meta}`}
        accessibilityHint="Long-press to copy the link"
        style={styles.row}
        containerStyle={styles.rowMain}
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
      <PressableScale
        onPress={onRemove}
        haptic="select"
        feedback="sink"
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={foundTray.remove(item.name)}
        style={styles.remove}
      >
        <PixelIcon name="close" size={20} color={colors.textMuted} />
      </PressableScale>
    </View>
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
  /** Removes one file from the list. */
  onRemove: (item: FoundItem) => void;
  /** Empties the list. */
  onClear: () => void;
  /** The user agent the page used. Sent with size requests, like a download. */
  userAgent?: string;
}

/** The files the page loaded or links to, filtered by kind. Tap a row to download it. */
export function FoundTray({ visible, items, onClose, onPick, onPickStream, onRemove, onClear, userAgent = '' }: FoundTrayProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { showNotice } = useMaglevEngine();
  const { height } = useWindowDimensions();
  const [prefs, updatePrefs] = useBrowserPrefs();
  const [choice, setChoice] = useState<{ key: string; filter: FoundFilter } | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const pageKey = useMemo(() => pageKeyOf(items), [items]);
  const small = useMemo(() => splitSmall(items), [items]);
  const hiding = prefs.hideSmallFiles && revealed !== pageKey && small.hidden.length > 0;
  const listed = hiding ? small.shown : items;
  const counts = useMemo(() => countByKind(listed), [listed]);
  const active = effectiveFilter(chosenFilter(choice, pageKey) ?? defaultFilter(counts), counts);
  const shown = useMemo(() => sortFound(listed, active), [listed, active]);

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
    <Sheet visible={visible} onClose={onClose} title={foundTray.title} subtitle={items.length ? foundTray.count(items.length) : undefined}>
      {items.length === 0 ? (
        <EmptyBlock icon="file" title={empty.browser.noFiles.title} body={empty.browser.noFiles.body} />
      ) : (
        <View>
          <View style={styles.chipRow}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chips} accessibilityRole="radiogroup">
              {visibleFilters(counts).map((f) => (
                <Chip key={f} label={FILTER_LABEL[f]} count={counts[f]} selected={f === active} onPress={() => setChoice({ key: pageKey, filter: f })} />
              ))}
            </ScrollView>
            <PressableScale
              onPress={onClear}
              haptic="select"
              accessibilityRole="button"
              accessibilityLabel={foundTray.clearLabel}
              style={styles.clear}
            >
              <Text style={styles.clearText}>{foundTray.clear}</Text>
            </PressableScale>
          </View>
          <View style={styles.smallRow}>
            <Chip
              label={foundTray.hideSmall}
              selected={prefs.hideSmallFiles}
              onPress={() => {
                updatePrefs({ hideSmallFiles: !prefs.hideSmallFiles });
                setRevealed(null);
              }}
            />
            {small.hidden.length > 0 && prefs.hideSmallFiles ? (
              <PressableScale
                onPress={() => setRevealed(hiding ? pageKey : null)}
                haptic="select"
                accessibilityRole="button"
                accessibilityLabel={hiding ? foundTray.showHidden(small.hidden.length) : foundTray.hideAgain}
                style={styles.hiddenButton}
              >
                <Text style={styles.hiddenText}>{hiding ? foundTray.hidden(small.hidden.length) : foundTray.hideAgain}</Text>
              </PressableScale>
            ) : null}
          </View>
          <FlatList
            data={shown}
            keyExtractor={(i) => i.id}
            style={{ maxHeight: height * 0.55 }}
            renderItem={({ item }) => (
              <Row
                item={item}
                userAgent={userAgent}
                onPress={() => (item.stream ? onPickStream(item) : onPick(item))}
                onLongPress={() => void copyLink(item)}
                onRemove={() => onRemove(item)}
              />
            )}
          />
        </View>
      )}
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    chipRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.md },
    chipScroll: { flex: 1 },
    chips: { flexDirection: 'row', gap: spacing.sm },
    clear: { minWidth: 44, minHeight: 44, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'center' },
    clearText: { ...type.mono, fontSize: type.size.md, color: c.danger },
    smallRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.sm },
    hiddenButton: { minHeight: 44, paddingHorizontal: spacing.sm, justifyContent: 'center' },
    hiddenText: { ...type.mono, fontSize: type.size.sm, color: c.accent },
    rowWrap: { flexDirection: 'row', alignItems: 'center' },
    rowMain: { flex: 1, minWidth: 44 },
    row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
    remove: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
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
