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
import { Button, Chip, EmptyBlock, PressableScale, Sheet } from '../ui';
import { useFoundSize } from './useFoundSize';
import { BATCH_CAP, allSelected, canSelect, selectAllIds, toggleSelected } from './foundBatch';
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
  inTransfers = false,
  selecting = false,
  checked = false,
}: {
  /** Selection mode: the row shows a box instead of Remove, and a tap ticks it. */
  selecting?: boolean;
  checked?: boolean;
  item: FoundItem;
  /** The file is already a download in Transfers: the row says so and a tap opens it. */
  inTransfers?: boolean;
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
        accessibilityLabel={`${item.name}, ${meta}${inTransfers ? `, ${foundTray.inTransfers}` : ''}`}
        accessibilityHint={selecting ? undefined : 'Long-press to select several files'}
        accessibilityState={selecting ? { checked } : undefined}
        style={styles.row}
        containerStyle={styles.rowMain}
      >
        <View style={[styles.thumb, selecting && checked && styles.thumbChecked]}>
          {selecting ? (
            <PixelIcon name={checked ? 'check' : 'checkbox-empty'} size={20} color={checked ? colors.accent : colors.textMuted} />
          ) : item.kind === 'image' && !thumbFailed ? (
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
          {inTransfers ? <Text style={styles.tag}>{foundTray.inTransfers}</Text> : null}
          {installer ? (
            <Text style={styles.warning}>
              {banners.browser.installer.title}. {banners.browser.installer.body}
            </Text>
          ) : null}
        </View>
      </PressableScale>
      {selecting ? null : (
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
      )}
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
  /** Forgets the list and scans the page again (NATIVE_CONTRACT 24.6a). */
  onScanAgain: () => void;
  /** The picked rows go to the batch sheet. */
  onDownloadSelected: (items: FoundItem[]) => void;
  /** Found item id to the id of the download that already has its link (foundTransfers.matchTransfers). */
  transfers?: ReadonlyMap<string, string>;
  /** A row tagged "In Transfers" was tapped. */
  onOpenTransfer?: (downloadId: string) => void;
  /** Set for 5 seconds after Remove or Clear. Shows a one-line Undo row. */
  undo?: { message: string } | null;
  onUndo?: () => void;
  /** The user agent the page used. Sent with size requests, like a download. */
  userAgent?: string;
}

/** The files the page loaded or links to, filtered by kind. Tap a row to download it. */
export function FoundTray({ visible, items, onClose, onPick, onPickStream, onRemove, onClear, onScanAgain, onDownloadSelected, undo = null, onUndo, transfers, onOpenTransfer, userAgent = '' }: FoundTrayProps) {
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

  // null = not selecting. A long press on a row starts it.
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const selecting = picked != null;
  const pickedItems = useMemo(() => (picked ? shown.filter((i) => picked.has(i.id)) : []), [picked, shown]);
  const everything = picked != null && allSelected(picked, shown);
  const stopSelecting = () => setPicked(null);
  const close = () => {
    setPicked(null);
    onClose();
  };

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
    <Sheet visible={visible} onClose={close} title={foundTray.title} subtitle={items.length ? foundTray.count(items.length) : undefined}>
      {undo ? (
        <View style={styles.undoRow} accessibilityLiveRegion="polite">
          <Text style={styles.undoText} numberOfLines={1}>
            {undo.message}
          </Text>
          <PressableScale onPress={onUndo} haptic="select" accessibilityRole="button" accessibilityLabel={foundTray.undo} style={styles.undoButton}>
            <Text style={styles.undoAction}>{foundTray.undo}</Text>
          </PressableScale>
        </View>
      ) : null}
      {items.length === 0 ? (
        <EmptyBlock
          icon="file"
          title={empty.browser.noFiles.title}
          body={empty.browser.noFiles.body}
          primary={{ label: foundTray.scanAgain, onPress: onScanAgain }}
        />
      ) : (
        <View>
          {selecting ? (
            <View style={styles.selectBar}>
              <PressableScale
                onPress={() => setPicked(everything ? new Set() : new Set(selectAllIds(shown)))}
                haptic="select"
                accessibilityRole="button"
                style={styles.selectButton}
              >
                <Text style={styles.selectText}>{everything ? foundTray.selectNone : foundTray.selectAll}</Text>
              </PressableScale>
              {pickedItems.length === 1 ? (
                <PressableScale onPress={() => void copyLink(pickedItems[0])} haptic="select" accessibilityRole="button" style={styles.selectButton}>
                  <Text style={styles.selectText}>{foundTray.copyLink}</Text>
                </PressableScale>
              ) : null}
              <PressableScale onPress={stopSelecting} haptic="select" accessibilityRole="button" style={styles.selectButton}>
                <Text style={styles.selectText}>{foundTray.cancelSelect}</Text>
              </PressableScale>
              <View style={styles.selectSpacer} />
              <Button
                label={foundTray.downloadN(pickedItems.length)}
                disabled={pickedItems.length === 0}
                onPress={() => {
                  onDownloadSelected(pickedItems);
                  stopSelecting();
                }}
              />
            </View>
          ) : null}
          {selecting && picked && picked.size >= BATCH_CAP ? <Text style={styles.capNote}>{foundTray.capNote(BATCH_CAP)}</Text> : null}
          <View style={[styles.chipRow, selecting && styles.hidden]} pointerEvents={selecting ? 'none' : 'auto'} accessibilityElementsHidden={selecting} importantForAccessibility={selecting ? 'no-hide-descendants' : 'auto'}>
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
            extraData={picked}
            keyExtractor={(i) => i.id}
            style={{ maxHeight: height * 0.55 }}
            renderItem={({ item }) => (
              <Row
                item={item}
                userAgent={userAgent}
                inTransfers={transfers?.has(item.id) ?? false}
                selecting={selecting}
                checked={picked?.has(item.id) ?? false}
                onPress={() => {
                  if (picked) {
                    if (canSelect(item)) setPicked(toggleSelected(picked, item.id));
                    return;
                  }
                  const dl = transfers?.get(item.id);
                  if (dl && onOpenTransfer) onOpenTransfer(dl);
                  else if (item.stream) onPickStream(item);
                  else onPick(item);
                }}
                onLongPress={() => {
                  if (!picked && canSelect(item)) setPicked(new Set([item.id]));
                }}
                onRemove={() => onRemove(item)}
              />
            )}
          />
          <PressableScale
            onPress={onScanAgain}
            haptic="select"
            accessibilityRole="button"
            accessibilityLabel={foundTray.scanAgainLabel}
            style={styles.scanAgain}
          >
            <PixelIcon name="retry" size={20} color={colors.accent} />
            <Text style={styles.scanAgainText}>{foundTray.scanAgain}</Text>
          </PressableScale>
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
    selectBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingBottom: spacing.sm },
    selectButton: { minWidth: 44, minHeight: 44, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'center' },
    selectText: { ...type.mono, fontSize: type.size.md, color: c.accent },
    selectSpacer: { flex: 1 },
    capNote: { ...type.mono, fontSize: type.size.sm, color: c.textMuted, paddingBottom: spacing.sm },
    hidden: { display: 'none' },
    thumbChecked: { backgroundColor: c.selBg, borderColor: c.selBorder },
    undoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, paddingBottom: spacing.sm },
    undoText: { ...type.body, flex: 1, minWidth: 0, fontSize: type.size.md, color: c.text },
    undoButton: { minWidth: 44, minHeight: 44, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'center' },
    undoAction: { ...type.mono, fontSize: type.size.md, color: c.accent },
    scanAgain: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.sm },
    scanAgainText: { ...type.mono, fontSize: type.size.md, color: c.accent },
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
    tag: { ...type.mono, fontSize: type.size.sm, color: c.accent, marginTop: 2 },
    warning: { ...type.body, fontSize: 12, lineHeight: 17, color: c.warning, marginTop: 2 },
  });
