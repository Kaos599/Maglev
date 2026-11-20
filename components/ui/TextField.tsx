import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, TextInputProps, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { IconButton } from './IconButton';

export interface TextFieldProps extends TextInputProps {
  /** Visible label above the field. Also the accessibility label unless you pass one. */
  label?: string;
  /** Quiet help under the field. Hidden while there is an error. */
  help?: string;
  /** Error text under the field, with an icon. Marks the field invalid. */
  error?: string;
  /** Pixel icon at the start of the field, such as `search`. */
  leadingIcon?: PixelIconName;
  /** Show a "Clear" button while there is text. */
  clearable?: boolean;
  /** Accessibility label of the clear button. Default "Clear". Say what it clears when a screen has two fields. */
  clearLabel?: string;
  /** Filenames, URLs, paths and numbers: `type.mono`, and no autocorrect or autocapitalize. */
  mono?: boolean;
  /** `md` is 44 dp tall, `lg` is 48 dp (search boxes). Multiline fields grow from `minLines`. */
  size?: 'md' | 'lg';
  /** Multiline only: shortest height, in lines. Default 3. */
  minLines?: number;
  /** Multiline only: tallest height, in lines, before the field scrolls. Default 8. */
  maxLines?: number;
  /** Rendered inside the box after the input, before the clear button (for example a file extension). */
  trailing?: React.ReactNode;
  /**
   * Only the styled input: no border, fill, fixed height, label, help or error. For a caller that owns its
   * container (address bar, find bar). Font, placeholder, selection and cursor colours still come from here.
   */
  bare?: boolean;
  /** The field sits on a `surface` container (a sheet or card): fill with `bg` so it stays visible. Screens leave it off. */
  onSurface?: boolean;
  testID?: string;
}

/** The TextInput instance a ref to a TextField points at. */
export type TextFieldRef = React.ComponentRef<typeof TextInput>;

const LINE_HEIGHT = 1.4;
const DEFAULT_MIN_LINES = 3;
const DEFAULT_MAX_LINES = 8;

/**
 * The one text input. Surface fill, 1 px hairline, accent border on focus, danger border and an
 * icon plus text on error. It forwards its ref to the inner TextInput.
 *
 * Fonts are read at render (through `makeStyles`), so Clean, Retro and Mono switch live.
 */
export const TextField = forwardRef<TextFieldRef, TextFieldProps>(function TextField(
  {
    label,
    help,
    error,
    leadingIcon,
    clearable = false,
    clearLabel = 'Clear',
    onSurface = false,
    mono = false,
    size = 'md',
    trailing,
    bare = false,
    minLines = DEFAULT_MIN_LINES,
    maxLines = DEFAULT_MAX_LINES,
    multiline = false,
    editable = true,
    value,
    onChangeText,
    onFocus,
    onBlur,
    style,
    accessibilityLabel,
    accessibilityHint,
    placeholder,
    autoCapitalize,
    autoCorrect,
    spellCheck,
    testID,
    ...rest
  },
  ref,
) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const inner = useRef<TextFieldRef>(null);
  useImperativeHandle(ref, () => inner.current as TextFieldRef);
  const [focused, setFocused] = useState(false);

  const disabled = editable === false;
  const invalid = Boolean(error);
  const showClear = clearable && editable && typeof value === 'string' && value.length > 0;
  const fontSize = size === 'lg' ? type.size.lg : type.size.base;
  const lineHeight = Math.round(fontSize * LINE_HEIGHT);

  const handleFocus = useCallback<NonNullable<TextInputProps['onFocus']>>(
    (e) => {
      setFocused(true);
      onFocus?.(e);
    },
    [onFocus],
  );
  const handleBlur = useCallback<NonNullable<TextInputProps['onBlur']>>(
    (e) => {
      setFocused(false);
      onBlur?.(e);
    },
    [onBlur],
  );
  const clear = useCallback(() => {
    onChangeText?.('');
    inner.current?.focus();
  }, [onChangeText]);

  const borderColor = invalid ? colors.danger : focused && !disabled ? colors.accent : colors.borderStrong;
  const minHeight = size === 'lg' ? touch.min + spacing.xs : touch.min;
  const boxHeight = multiline
    ? { minHeight: Math.max(minHeight, minLines * lineHeight + spacing.md * 2), maxHeight: maxLines * lineHeight + spacing.md * 2 }
    : { height: minHeight };

  if (bare) {
    return (
      <TextInput
        ref={inner}
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        onBlur={onBlur}
        editable={editable}
        multiline={multiline}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        selectionColor={colors.accent}
        cursorColor={colors.accent}
        autoCapitalize={autoCapitalize ?? (mono ? 'none' : undefined)}
        autoCorrect={autoCorrect ?? (mono ? false : undefined)}
        spellCheck={spellCheck ?? (mono ? false : undefined)}
        accessibilityLabel={accessibilityLabel ?? label ?? placeholder}
        accessibilityHint={accessibilityHint}
        testID={testID}
        style={[mono ? styles.inputMono : styles.inputBody, { fontSize }, disabled && styles.inputDisabled, style]}
        {...rest}
      />
    );
  }

  const hint = invalid ? `Error: ${error}` : help ? help : undefined;
  const a11yLabel = accessibilityLabel ?? label ?? placeholder;

  return (
    <View style={styles.wrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={[styles.box, boxHeight, multiline && styles.boxMulti, onSurface && styles.boxOnSurface, { borderColor }]}>
        {leadingIcon ? (
          <View style={[styles.lead, multiline && styles.leadMulti]}>
            <PixelIcon name={leadingIcon} size={16} color={colors.textMuted} />
          </View>
        ) : null}
        <TextInput
          ref={inner}
          value={value}
          onChangeText={onChangeText}
          onFocus={handleFocus}
          onBlur={handleBlur}
          editable={editable}
          multiline={multiline}
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          autoCapitalize={autoCapitalize ?? (mono ? 'none' : undefined)}
          autoCorrect={autoCorrect ?? (mono ? false : undefined)}
          spellCheck={spellCheck ?? (mono ? false : undefined)}
          accessibilityLabel={a11yLabel}
          accessibilityHint={accessibilityHint ?? hint}
          accessibilityState={{ disabled }}
          testID={testID}
          style={[
            mono ? styles.inputMono : styles.inputBody,
            { fontSize, lineHeight: multiline ? lineHeight : undefined },
            multiline ? styles.inputMulti : styles.inputSingle,
            disabled && styles.inputDisabled,
            style,
          ]}
          {...rest}
        />
        {trailing ? <View style={[styles.lead, multiline && styles.leadMulti]}>{trailing}</View> : null}
        {showClear ? (
          <IconButton icon="close" size={16} onPress={clear} accessibilityLabel={clearLabel} testID={testID ? `${testID}-clear` : undefined} />
        ) : null}
      </View>
      {invalid ? (
        <View style={styles.message} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <PixelIcon name="warning" size={16} color={colors.danger} />
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : help ? (
        <Text style={styles.help}>{help}</Text>
      ) : null}
    </View>
  );
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { gap: spacing.xs },
    label: { ...type.bodyStrong, fontSize: type.size.sm, color: c.text },
    box: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: spacing.md,
      paddingRight: spacing.xs,
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderRadius: radius.md,
    },
    boxMulti: { alignItems: 'flex-start', paddingRight: spacing.md },
    boxOnSurface: { backgroundColor: c.bg },
    lead: { justifyContent: 'center' },
    leadMulti: { paddingTop: spacing.md },
    inputBody: { ...type.body, flex: 1, minWidth: 0, color: c.text },
    inputMono: { ...type.mono, flex: 1, minWidth: 0, color: c.text },
    inputSingle: { paddingVertical: 0, height: '100%' },
    inputMulti: { paddingVertical: spacing.md, textAlignVertical: 'top', alignSelf: 'stretch' },
    inputDisabled: { color: c.textFaint },
    message: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    error: { ...type.body, flex: 1, fontSize: type.size.sm, color: c.danger },
    help: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
  });
