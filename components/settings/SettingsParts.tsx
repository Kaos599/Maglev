import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View, StyleProp, ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { Button, Chip, Screen, Sheet } from '../ui';

/** Sub-screen shell: header with back, scrolling body, instant-apply content. */
export function SettingsPage({ title, children }: { title: string; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <Screen
      title={title}
      onBack={() => router.back()}
      scroll
      edges={['top', 'left', 'right', 'bottom']}
      contentStyle={pageStyle}
    >
      {children}
    </Screen>
  );
}

const pageStyle: StyleProp<ViewStyle> = { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxxl };

/** Surface card that groups rows. */
export function Card({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return <View style={s.card}>{children}</View>;
}

/** Small muted explanation under a control. */
export function Caption({ children, tone }: { children: React.ReactNode; tone?: 'warning' }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return <Text style={[s.caption, tone === 'warning' && { color: colors.warning }]}>{children}</Text>;
}

/** A labelled group of Chips for picking one value. */
export function ChipGroup<T extends string | number>({
  label,
  caption,
  options,
  value,
  onChange,
}: {
  label: string;
  caption?: string;
  options: readonly { value: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={s.group} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={s.groupLabel}>{label}</Text>
      <View style={s.chips}>
        {options.map((o) => (
          <Chip key={String(o.value)} label={o.label} selected={o.value === value} onPress={() => onChange(o.value)} />
        ))}
      </View>
      {caption ? <Caption>{caption}</Caption> : null}
    </View>
  );
}

export interface InputSheetProps {
  visible: boolean;
  title: string;
  subtitle?: string;
  initial: string;
  unit?: string;
  numeric?: boolean;
  decimal?: boolean;
  secure?: boolean;
  placeholder?: string;
  /** Returns an error message, or null when the value is acceptable. */
  validate: (raw: string) => string | null;
  onClose: () => void;
  onSubmit: (raw: string) => void;
  submitLabel?: string;
}

/** Sheet with one text or numeric field and inline validation. */
export function InputSheet({
  visible,
  title,
  subtitle,
  initial,
  unit,
  numeric,
  decimal,
  secure,
  placeholder,
  validate,
  onClose,
  onSubmit,
  submitLabel = 'Save',
}: InputSheetProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [text, setText] = useState(initial);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (visible) {
      setText(initial);
      setTouched(false);
    }
  }, [visible, initial]);
  const error = validate(text.trim());
  const submit = () => {
    setTouched(true);
    if (error) return;
    onSubmit(text.trim());
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={title} subtitle={subtitle}>
      <View style={s.inputRow}>
        <TextInput
          value={text}
          onChangeText={(t) => {
            setText(t);
            setTouched(true);
          }}
          style={[s.input, touched && error ? { borderColor: colors.danger } : null]}
          keyboardType={numeric ? (decimal ? 'decimal-pad' : 'number-pad') : 'default'}
          secureTextEntry={secure}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accent}
          onSubmitEditing={submit}
          returnKeyType="done"
          accessibilityLabel={title}
        />
        {unit ? <Text style={s.unit}>{unit}</Text> : null}
      </View>
      {touched && error ? (
        <Text style={s.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      <View style={s.sheetActions}>
        <Button label="Cancel" variant="ghost" onPress={onClose} />
        <Button label={submitLabel} onPress={submit} disabled={!!error} />
      </View>
    </Sheet>
  );
}

/** Parses an integer in [min, max]; returns the number or null. */
export function parseIntIn(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n >= min && n <= max ? n : null;
}

/** Friendly path for display: drops the storage root. */
export function friendlyPath(path: string): string {
  return path.replace(/^\/storage\/emulated\/0\/?/, '').replace(/^\/sdcard\/?/, '') || path;
}

const MB = 1_048_576;
export function formatLimit(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return 'Unlimited';
  const mb = bytesPerSec / MB;
  return mb >= 1 ? `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB/s` : `${Math.round(bytesPerSec / 1024)} KB/s`;
}
export const BYTES_PER_MB = MB;

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      paddingVertical: spacing.xs,
      overflow: 'hidden',
    },
    caption: { ...type.body, fontSize: 12, lineHeight: 17, color: c.textMuted },
    group: { padding: spacing.lg, gap: spacing.sm },
    groupLabel: { ...type.bodyStrong, fontSize: 14, color: c.text },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    input: {
      ...type.mono,
      flex: 1,
      minHeight: touch.min,
      paddingHorizontal: spacing.md,
      fontSize: 15,
      color: c.text,
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: radius.md,
    },
    unit: { ...type.mono, fontSize: 13, color: c.textMuted },
    error: { ...type.body, fontSize: 12, color: c.danger, marginTop: spacing.sm },
    sheetActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.lg },
  });
