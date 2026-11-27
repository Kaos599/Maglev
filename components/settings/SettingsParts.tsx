import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, StyleProp, ViewStyle } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SETTINGS_INDEX } from '../../utils/settingsIndex';
import { FocusAnchor, SettingsFocusProvider, rowKey } from './settingsFocus';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { Button, Chip, Screen, SectionHeader, Sheet, TextField } from '../ui';
import type { TextFieldRef } from '../ui/TextField';

/** Sub-screen shell: header with back, scrolling body, instant-apply content. */
export function SettingsPage({ title, children }: { title: string; children: React.ReactNode }) {
  const router = useRouter();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const contentRef = useRef<React.ComponentRef<typeof View>>(null);
  // The search result's index entry says which row title and section to look for on this page.
  const target = useMemo(() => {
    const entry = focus ? SETTINGS_INDEX.find((e) => e.id === focus) : null;
    return entry ? { title: entry.title, section: entry.section } : null;
  }, [focus]);
  const scrollTo = useCallback((y: number, animated: boolean) => scrollRef.current?.scrollTo({ y, animated }), []);
  // Clear the param so coming back to this page does not scroll again.
  // A cold start can still be mounting the root navigator when the highlight ends; setParams then throws and closed the
  // app (on a phone, "Attempted to navigate before mounting the Root Layout", stack top setParams). Clearing the
  // param only stops a second scroll on return, so skipping it once is harmless.
  const onDone = useCallback(() => {
    try {
      router.setParams({ focus: undefined } as never);
    } catch {
      // Not mounted yet.
    }
  }, [router]);
  return (
    <Screen title={title} onBack={() => router.back()} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView ref={scrollRef} style={pageFill} keyboardShouldPersistTaps="handled">
        <View ref={contentRef} collapsable={false} style={pageStyle}>
          <SettingsFocusProvider target={target} contentRef={contentRef} scrollTo={scrollTo} onDone={onDone}>
            {children}
          </SettingsFocusProvider>
        </View>
      </ScrollView>
    </Screen>
  );
}

const pageFill: StyleProp<ViewStyle> = { flex: 1 };
const pageStyle: StyleProp<ViewStyle> = {
  padding: spacing.lg,
  gap: spacing.lg,
  paddingBottom: spacing.xxxl,
};

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

/** SectionHeader, then one or more cards, then an optional caption directly under them. Same spacing as the Settings root. */
export function Section({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }) {
  return (
    <View style={sectionStyle}>
      <SectionHeader title={title} />
      {children}
      {caption ? <Caption>{caption}</Caption> : null}
    </View>
  );
}

const sectionStyle: StyleProp<ViewStyle> = { gap: spacing.sm };

/** A labelled group of Chips for picking one value. */
export function ChipGroup<T extends string | number>({
  label,
  caption,
  options,
  value,
  onChange,
  minChipWidth,
}: {
  label: string;
  caption?: string;
  options: readonly { value: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
  /** A floor for each chip's width. A one-character label ("1") leaves a chip narrower than the 44 dp touch target. */
  minChipWidth?: number;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <FocusAnchor anchorKey={rowKey(label)}>
      <View style={s.group} accessibilityRole="radiogroup" accessibilityLabel={label}>
        <Text style={s.groupLabel}>{label}</Text>
        <View style={s.chips}>
          {options.map((o) => {
            const chip = <Chip key={String(o.value)} label={o.label} selected={o.value === value} onPress={() => onChange(o.value)} />;
            // The wrapper sets the floor and the chip stretches to it.
            return minChipWidth ? (
              <View key={String(o.value)} style={{ minWidth: minChipWidth }}>
                {chip}
              </View>
            ) : (
              chip
            );
          })}
        </View>
        {caption ? <Caption>{caption}</Caption> : null}
      </View>
    </FocusAnchor>
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
  // autoFocus runs while the sheet's window is still sliding in, and Android then focuses the field without raising
  // the keyboard. Focus by ref once the sheet reports it has finished opening. Closing blurs the field first, so the
  // keyboard leaves with the sheet.
  const fieldRef = useRef<TextFieldRef>(null);
  useEffect(() => {
    if (!visible) fieldRef.current?.blur();
  }, [visible]);
  const focusField = useCallback(() => fieldRef.current?.focus(), []);
  const error = validate(text.trim());
  const submit = () => {
    setTouched(true);
    if (error) return;
    onSubmit(text.trim());
  };
  return (
    <Sheet visible={visible} onClose={onClose} onOpened={focusField} title={title} subtitle={subtitle}>
      <TextField
        ref={fieldRef}
        onSurface
        value={text}
        onChangeText={(t) => {
          setText(t);
          setTouched(true);
        }}
        mono={numeric}
        keyboardType={numeric ? (decimal ? 'decimal-pad' : 'number-pad') : 'default'}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
        trailing={unit ? <Text style={s.unit}>{unit}</Text> : undefined}
        error={touched && error ? error : undefined}
        onSubmitEditing={submit}
        returnKeyType="done"
        accessibilityLabel={title}
      />
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
    caption: { ...type.body, fontSize: type.size.sm, lineHeight: 17, color: c.textMuted },
    group: { padding: spacing.lg, gap: spacing.sm },
    groupLabel: { ...type.bodyStrong, fontSize: type.size.base, color: c.text },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    unit: { ...type.mono, fontSize: type.size.md, color: c.textMuted },
    sheetActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: spacing.sm,
      marginTop: spacing.lg,
    },
  });
