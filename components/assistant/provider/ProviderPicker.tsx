import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../../constants/theme';
import { Chip } from '../../ui';
import type { PresetId, ProviderPreset } from '../../../utils/prefs/assistant';

/** Provider chips plus the one-line note for the chosen one. */
export function ProviderPicker({
  presets,
  value,
  onChange,
}: {
  presets: readonly ProviderPreset[];
  value: PresetId;
  onChange: (id: PresetId) => void;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const current = presets.find((p) => p.id === value);
  return (
    <View style={s.wrap} accessibilityRole="radiogroup" accessibilityLabel="Provider">
      <Text style={s.label}>Provider</Text>
      <View style={s.chips}>
        {presets.map((p) => (
          <Chip key={p.id} label={p.label} selected={p.id === value} onPress={() => onChange(p.id)} />
        ))}
      </View>
      {current ? <Text style={s.caption}>{current.notes}</Text> : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { gap: spacing.sm },
    label: { ...type.bodyStrong, fontSize: 14, color: c.text },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    caption: { ...type.body, fontSize: 12, lineHeight: 17, color: c.textMuted },
  });
