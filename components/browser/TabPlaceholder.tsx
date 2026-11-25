import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { hostOf } from '../../utils/browserUrl';
import { isBlank, type Tab } from '../../utils/browser/tabs';
import { titleOf } from './TabSwitcher';
import { PageSlot, type PageSlotName } from './TabWebView';

export interface TabPlaceholderProps {
  tab: Tab;
  /** 'prev' or 'next' while it stands in for a neighbour; anything else keeps it hidden. */
  slot: PageSlotName;
  offset: SharedValue<number>;
  pageWidth: SharedValue<number>;
}

/**
 * Stands in for a neighbouring tab that has no page to show during a swipe: one that is asleep or blank
 * (docs/contracts-0.35/tab-switch.md rule 2). The host and title, centred on the page background. No spinner.
 */
export function TabPlaceholder({ tab, slot, offset, pageWidth }: TabPlaceholderProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const host = isBlank(tab) ? '' : hostOf(tab.url);
  const title = titleOf(tab);
  return (
    <PageSlot slot={slot} offset={offset} pageWidth={pageWidth} pointerEvents="none">
      <View style={styles.panel} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {host ? (
          <Text style={styles.host} numberOfLines={1}>
            {host}
          </Text>
        ) : null}
        {title && title !== host ? (
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
        ) : null}
      </View>
    </PageSlot>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    panel: { flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.xs },
    host: { ...type.mono, fontSize: type.size.base, color: c.text, textAlign: 'center' },
    title: { ...type.body, fontSize: type.size.sm, color: c.textMuted, textAlign: 'center' },
  });
