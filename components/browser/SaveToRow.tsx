import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { maglevEngine } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { notices } from '../../constants/copy';
import { Button } from '../ui';
import { friendlyPath } from '../settings/SettingsParts';

/**
 * "Save to · Change" for the browser's download sheets, same as Add download. The picked folder is
 * stored by the engine as the active target, so nothing is passed to startDownload.
 * `onError` receives a plain-English message when the picker fails.
 */
export function SaveToRow({ disabled, onError }: { disabled?: boolean; onError?: (message: string) => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { defaultStoragePath } = useMaglevEngine();
  const [label, setLabel] = useState<string | null>(null);

  const change = async () => {
    haptic('tap');
    try {
      const res = await maglevEngine.pickDownloadFolder();
      if ('cancelled' in res) return;
      setLabel(res.displayName);
    } catch {
      onError?.(notices.inline.folderPickerFailed);
    }
  };

  const shown = friendlyPath(label ?? defaultStoragePath);
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.meta}>Save to</Text>
        <Text style={styles.dest} numberOfLines={1} ellipsizeMode="middle" accessibilityLabel={`Save to ${shown}`}>
          {shown}
        </Text>
      </View>
      <Button label="Change" variant="secondary" disabled={disabled} onPress={() => void change()} />
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
      minHeight: touch.min,
    },
    text: { flex: 1 },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    dest: { ...type.mono, fontSize: type.size.md, color: c.text, marginTop: 2 },
  });
