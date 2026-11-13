import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, touch } from '../../constants/theme';
import { tabsCopy } from '../../constants/copy';
import { useAssistantPrefs } from '../../utils/prefs/assistantApp';
import { PixelIcon } from '../PixelIcon';
import { ListRow, PressableScale, Toggle } from '../ui';
import { Caption } from '../settings/SettingsParts';
import { LOCKED_TABS, moveTab, setTabShown, type TabId } from './tabPrefs';
import { setTabPrefs, useTabPrefs } from './tabPrefsStore';

function MoveButton({ dir, name, disabled, onPress }: { dir: 'up' | 'down'; name: string; disabled: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      feedback="sink"
      accessibilityRole="button"
      accessibilityLabel={`Move ${name} ${dir}`}
      accessibilityState={{ disabled }}
      style={[s.move, disabled && s.off]}
    >
      {/* The set has no up arrow, so up is the down chevron turned over. */}
      <View style={dir === 'up' ? s.flip : undefined}>
        <PixelIcon name="chevron-down" size={20} color={colors.text} />
      </View>
    </PressableScale>
  );
}

/** Settings > Interface > Tabs: which tabs show, and their order. Applies live. */
export function TabsSection() {
  const prefs = useTabPrefs();
  const assistant = useAssistantPrefs();
  // The Assistant setting decides whether the assistant exists, so its row appears only while it is on.
  const rows = prefs.order.filter((id) => id !== 'assistant' || assistant.enabled);

  return (
    <>
      {rows.map((id: TabId, i) => {
        const name = tabsCopy.names[id];
        const locked = LOCKED_TABS.includes(id);
        return (
          <ListRow
            key={id}
            title={name}
            subtitle={locked ? tabsCopy.alwaysShown : undefined}
            accessory={
              <View style={rowStyle.accessory}>
                <MoveButton dir="up" name={name} disabled={i === 0} onPress={() => setTabPrefs((p) => moveTab(p, id, 'up', rows))} />
                <MoveButton dir="down" name={name} disabled={i === rows.length - 1} onPress={() => setTabPrefs((p) => moveTab(p, id, 'down', rows))} />
                <Toggle
                  value={locked || !prefs.hidden.includes(id)}
                  disabled={locked}
                  onValueChange={(v) => setTabPrefs((p) => setTabShown(p, id, v))}
                  accessibilityLabel={`Show ${name} tab`}
                />
              </View>
            }
          />
        );
      })}
      <View style={rowStyle.caption}>
        <Caption>{assistant.enabled ? tabsCopy.hint : `${tabsCopy.hint} ${tabsCopy.assistantNote}`}</Caption>
      </View>
    </>
  );
}

const rowStyle = StyleSheet.create({
  accessory: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  caption: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    move: { width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' },
    off: { opacity: 0.3 },
    flip: { transform: [{ rotate: '180deg' }] },
  });
