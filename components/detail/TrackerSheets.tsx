import React, { useMemo } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { Button, Sheet } from '../ui';

interface AddProps {
  visible: boolean;
  onClose: () => void;
  /** True while `addTrackers` is in flight. */
  busy: boolean;
  /** The text in the box. The machine owns it (SM-28). */
  text: string;
  onTextChange: (text: string) => void;
  /** The message under the field: a bad line, an empty paste, or the engine's answer. */
  error: string | null;
  /** How many addresses the paste holds that will be added. */
  count: number;
  onSubmit: () => void;
}

/** Add tracker (NATIVE_CONTRACT 15): paste one address per line. A bad line names itself and blocks the whole add. */
export function AddTrackerSheet({ visible, onClose, busy, text, onTextChange, error, count, onSubmit }: AddProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);

  return (
    <Sheet
      visible={visible}
      onClose={() => !busy && onClose()}
      title="Add tracker"
      subtitle="One address per line. Use http://, https:// or udp://."
    >
      <TextInput
        value={text}
        onChangeText={onTextChange}
        style={[s.input, error ? { borderColor: colors.danger } : null]}
        multiline
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        editable={!busy}
        placeholder={'udp://tracker.example.org:1337/announce\nhttps://tracker.example.org/announce'}
        placeholderTextColor={colors.textFaint}
        selectionColor={colors.accent}
        textAlignVertical="top"
        accessibilityLabel="Tracker addresses, one per line"
      />
      {error ? (
        <Text style={s.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      <View style={s.actions}>
        <Button label="Cancel" variant="ghost" disabled={busy} onPress={onClose} />
        <Button label={count > 1 ? `Add ${count}` : 'Add'} loading={busy} disabled={busy} onPress={onSubmit} />
      </View>
    </Sheet>
  );
}

interface RemoveProps {
  /** The address to remove, or null when the sheet is closed. */
  url: string | null;
  /** True when it is the only tracker the torrent has. */
  last: boolean;
  busy: boolean;
  onClose: () => void;
  onRemove: () => void;
}

/** Confirm before a tracker goes (NATIVE_CONTRACT 15, SM-28). */
export function RemoveTrackerSheet({ url, last, busy, onClose, onRemove }: RemoveProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Sheet visible={url !== null} onClose={() => !busy && onClose()} title="Remove this tracker?">
      <Text style={s.body}>{url ?? ''}</Text>
      <Text style={s.body}>
        {last
          ? 'This is the last tracker. Peers can still be found without it, but it may take longer.'
          : 'Maglev stops asking this tracker for peers. The other trackers keep working.'}
      </Text>
      <View style={s.stack}>
        <Button label="Remove" variant="danger" fullWidth loading={busy} onPress={onRemove} />
        <Button label="Cancel" variant="ghost" fullWidth disabled={busy} onPress={onClose} />
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    input: {
      ...type.mono,
      minHeight: 120,
      maxHeight: 220,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      fontSize: 14,
      color: c.text,
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: radius.md,
    },
    error: { ...type.body, fontSize: 12, color: c.danger, marginTop: spacing.sm },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: spacing.sm,
      marginTop: spacing.lg,
      minHeight: touch.min,
    },
    body: { ...type.body, fontSize: 14, color: c.textMuted },
    stack: { gap: spacing.sm, marginTop: spacing.lg },
  });
