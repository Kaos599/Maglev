import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { checkTrackerText } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { Button, Sheet } from '../ui';

interface AddProps {
  visible: boolean;
  onClose: () => void;
  busy: boolean;
  /** A message from the engine for the last try, shown under the field. */
  error: string | null;
  /** Called with one address per entry once every line has passed the check. */
  onSubmit: (urls: string[]) => void;
}

/** Add tracker (NATIVE_CONTRACT 15): paste one address per line. A bad line names itself and blocks the whole add. */
export function AddTrackerSheet({ visible, onClose, busy, error, onSubmit }: AddProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [text, setText] = useState('');

  useEffect(() => {
    if (visible) setText('');
  }, [visible]);

  const blank = text.trim().length === 0;
  const checked = useMemo(() => (blank ? null : checkTrackerText(text)), [blank, text]);
  const problem = checked && !checked.ok ? checked.message : null;
  const message = problem ?? error;
  const canAdd = !busy && checked !== null && checked.ok;

  return (
    <Sheet
      visible={visible}
      onClose={() => !busy && onClose()}
      title="Add tracker"
      subtitle="One address per line. Use http://, https:// or udp://."
    >
      <TextInput
        value={text}
        onChangeText={setText}
        style={[s.input, message ? { borderColor: colors.danger } : null]}
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
      {message ? (
        <Text style={s.error} accessibilityLiveRegion="polite">
          {message}
        </Text>
      ) : null}
      <View style={s.actions}>
        <Button label="Cancel" variant="ghost" disabled={busy} onPress={onClose} />
        <Button
          label={checked && checked.ok && checked.urls.length > 1 ? `Add ${checked.urls.length}` : 'Add'}
          loading={busy}
          disabled={!canAdd}
          onPress={() => checked && checked.ok && onSubmit(checked.urls)}
        />
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

/** Confirm before a tracker goes (NATIVE_CONTRACT 15). */
export function RemoveTrackerSheet({ url, last, busy, onClose, onRemove }: RemoveProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Sheet visible={url !== null} onClose={() => !busy && onClose()} title="Remove tracker?" subtitle={url ?? undefined}>
      <Text style={s.body}>
        {last
          ? "This is the last tracker. Peers can still be found without it, but it may take longer."
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
