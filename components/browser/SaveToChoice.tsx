import React, { useMemo } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { saveTo } from '../../constants/copy';
import { Chip } from '../ui';
import { friendlyPath } from '../settings/SettingsParts';
import { saveFolder, subfolderName } from './saveTo';

/**
 * "Save to" for one download. The default folder, or a subfolder of the default root. The choice goes to
 * `startDownload` as `folder` and never touches the engine's target, so the next download is not affected.
 * `value` is null for the default folder, else the typed subfolder name.
 */
export function SaveToChoice({ value, onChange, root, disabled }: { value: string | null; onChange: (next: string | null) => void; root: string; disabled?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { defaultStoragePath } = useMaglevEngine();
  const folder = value != null ? saveFolder(root, value) : null;
  const shown = friendlyPath(folder ?? (value != null ? root : defaultStoragePath));
  return (
    <View style={styles.box}>
      <Text style={styles.meta}>{saveTo.title}</Text>
      <Text style={styles.dest} numberOfLines={1} ellipsizeMode="middle" accessibilityLabel={`${saveTo.title} ${shown}`}>
        {shown}
      </Text>
      <View style={styles.chips} accessibilityRole="radiogroup">
        <Chip label={saveTo.defaultFolder} role="radio" selected={value == null} disabled={disabled} onPress={() => onChange(null)} />
        <Chip label={saveTo.subfolder} role="radio" selected={value != null} disabled={disabled} onPress={() => onChange(value ?? '')} />
      </View>
      {value != null ? (
        <TextInput
          value={value}
          onChangeText={(t) => onChange(t.replace(/[\\/]/g, ''))}
          onBlur={() => onChange(subfolderName(value))}
          editable={!disabled}
          placeholder={saveTo.namePlaceholder}
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accent}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          maxLength={64}
          style={styles.field}
          accessibilityLabel={saveTo.namePlaceholder}
        />
      ) : null}
      <Text style={styles.meta}>{saveTo.onlyThis}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    box: { gap: spacing.xs, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: spacing.md },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    dest: { ...type.mono, fontSize: type.size.md, color: c.text },
    chips: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.xs },
    field: {
      ...type.mono,
      fontSize: type.size.md,
      color: c.text,
      minHeight: touch.min,
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
    },
  });
