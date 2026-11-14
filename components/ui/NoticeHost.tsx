import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMaglevEngine } from '../../context/EngineContext';
import { spacing } from '../../constants/theme';
import { Banner } from './Banner';

/** Bottom of the tab bar (56) plus a gap. Matches where Transfers used to place its own notice. */
const TAB_BAR_CLEARANCE = 56 + spacing.sm;

/**
 * The one place engine notices ("Added to Transfers.", "Link copied.", Undo after a remove) show.
 * It sits at the app root so every screen and sheet can raise one. A notice with an action keeps
 * its button and stays until the engine times it out; a plain one has a dismiss button.
 */
export function NoticeHost() {
  const { notice, dismissNotice } = useMaglevEngine();
  const insets = useSafeAreaInsets();
  if (!notice) return null;
  return (
    <View style={[styles.wrap, { bottom: insets.bottom + spacing.lg + TAB_BAR_CLEARANCE }]} pointerEvents="box-none">
      <Banner
        tone="neutral"
        title={notice.message}
        actionLabel={notice.actionLabel}
        onAction={notice.onAction}
        onDismiss={notice.actionLabel ? undefined : dismissNotice}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: spacing.lg, right: spacing.lg },
});
