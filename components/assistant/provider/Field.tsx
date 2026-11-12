import React, { useMemo } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../../constants/theme';

export interface FieldProps {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  caption?: string;
  secure?: boolean;
  editable?: boolean;
  keyboardType?: 'default' | 'url';
  onSubmitEditing?: () => void;
  testID?: string;
}

/** Labelled single-line field. Values are filenames, keys and addresses, so they use the mono face. */
export function Field({ label, value, onChangeText, placeholder, caption, secure, editable = true, keyboardType = 'default', onSubmitEditing, testID }: FieldProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={s.wrap}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        selectionColor={colors.accent}
        onSubmitEditing={onSubmitEditing}
        returnKeyType="done"
        style={[s.input, !editable && s.disabled]}
        accessibilityLabel={label}
        testID={testID}
      />
      {caption ? <Text style={s.caption}>{caption}</Text> : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { gap: spacing.xs },
    label: { ...type.bodyStrong, fontSize: 14, color: c.text },
    input: {
      ...type.mono,
      minHeight: touch.min,
      paddingHorizontal: spacing.md,
      fontSize: 14,
      color: c.text,
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: radius.md,
    },
    disabled: { opacity: 0.5 },
    caption: { ...type.body, fontSize: 12, lineHeight: 17, color: c.textMuted },
  });
