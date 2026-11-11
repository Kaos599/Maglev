import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Button, Chip, Sheet } from '../ui';

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = ['00', '15', '30', '45'];

export interface TimePickerSheetProps {
  visible: boolean;
  title: string;
  /** "HH:MM" */
  value: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
}

/** Hour and minute chips: no native picker dependency, and every target is 44 px. */
export function TimePickerSheet({ visible, title, value, onClose, onSubmit }: TimePickerSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [hour, setHour] = useState(value.slice(0, 2));
  const [minute, setMinute] = useState(value.slice(3, 5));

  useEffect(() => {
    if (visible) {
      setHour(value.slice(0, 2));
      setMinute(value.slice(3, 5));
    }
  }, [visible, value]);

  // A minute that is not on the 15-minute grid (older data) is still shown and selectable.
  const minutes = MINUTES.includes(minute) ? MINUTES : [...MINUTES, minute].sort();

  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <Text style={styles.label}>Hour</Text>
      <View style={styles.grid}>
        {HOURS.map((h) => (
          <Chip key={h} label={h} selected={h === hour} onPress={() => setHour(h)} />
        ))}
      </View>
      <Text style={styles.label}>Minute</Text>
      <View style={styles.grid}>
        {minutes.map((m) => (
          <Chip key={m} label={m} selected={m === minute} onPress={() => setMinute(m)} />
        ))}
      </View>
      <View style={styles.actions}>
        <Button label="Cancel" variant="ghost" onPress={onClose} />
        <Button label={`Set ${hour}:${minute}`} onPress={() => onSubmit(`${hour}:${minute}`)} />
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    label: { ...type.body, fontSize: 13, color: c.textMuted, marginBottom: spacing.sm, marginTop: spacing.xs },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.sm },
  });
