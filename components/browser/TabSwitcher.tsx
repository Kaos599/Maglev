import React, { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { browserTabs } from '../../constants/copy';
import { haptic } from '../../constants/haptics';
import { hostOf } from '../../utils/browserUrl';
import { isBlank, type Tab } from '../../utils/browser/tabs';
import { Button, IconButton, ListRow, PressableScale, Sheet } from '../ui';

export interface TabSwitcherProps {
  /** Newest first (`switcherOrder`). */
  tabs: Tab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  onCloseAll: () => void;
  /** Leaves the switcher without choosing. */
  onDismiss: () => void;
}

const titleOf = (t: Tab): string => t.title || (isBlank(t) ? browserTabs.switcher.blankTitle : hostOf(t.url) || t.url);

/** T2: the full-screen tab list. The parent unmounts it when closed. */
export function TabSwitcher({ tabs, activeId, onSelect, onClose, onNewTab, onCloseAll, onDismiss }: TabSwitcherProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <IconButton icon="back" accessibilityLabel="Close" onPress={onDismiss} />
        <Text style={styles.heading} numberOfLines={1} accessibilityRole="header">
          {browserTabs.switcher.title}
        </Text>
        <Button label={browserTabs.switcher.newTab} icon="plus" variant="secondary" onPress={onNewTab} />
        <IconButton icon="more" accessibilityLabel={browserTabs.switcher.menuLabel} onPress={() => setMenuOpen(true)} />
      </View>
      <FlatList
        data={tabs}
        keyExtractor={(t) => t.id}
        extraData={activeId}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          const title = titleOf(item);
          const host = isBlank(item) ? '' : hostOf(item.url);
          const active = item.id === activeId;
          return (
            <View style={[styles.row, active && styles.rowActive]}>
              <PressableScale
                onPress={() => {
                  haptic('select');
                  onSelect(item.id);
                }}
                accessibilityRole="button"
                accessibilityLabel={host && host !== title ? `${title}, ${host}` : title}
                accessibilityState={{ selected: active }}
                style={styles.rowMain}
              >
                <Text style={styles.title} numberOfLines={1}>
                  {title}
                </Text>
                {host ? (
                  <Text style={styles.host} numberOfLines={1}>
                    {host}
                  </Text>
                ) : null}
              </PressableScale>
              <IconButton
                icon="close"
                accessibilityLabel={browserTabs.switcher.closeTabLabel(title)}
                onPress={() => {
                  haptic('tap');
                  onClose(item.id);
                }}
              />
            </View>
          );
        }}
      />
      <Sheet visible={menuOpen} onClose={() => setMenuOpen(false)} title={browserTabs.switcher.menuLabel}>
        <ListRow
          icon="trash"
          title={browserTabs.switcher.closeAll}
          destructive
          onPress={() => {
            setMenuOpen(false);
            haptic('warn');
            onCloseAll();
          }}
        />
      </Sheet>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { ...StyleSheet.absoluteFill, backgroundColor: c.bg, zIndex: 10 },
    header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xs, minHeight: 56 },
    heading: { ...type.heading, flex: 1, fontSize: type.size.lg, color: c.text },
    list: { padding: spacing.md, gap: spacing.sm },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 56,
      paddingLeft: spacing.md,
      paddingRight: spacing.xs,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
    },
    rowActive: { borderColor: c.accent },
    rowMain: { flex: 1, minHeight: 56, justifyContent: 'center', paddingVertical: spacing.sm },
    title: { ...type.mono, fontSize: type.size.md, color: c.text },
    host: { ...type.body, fontSize: type.size.sm, color: c.textMuted, marginTop: 2 },
  });
