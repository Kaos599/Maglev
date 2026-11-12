import React, { memo, useMemo } from 'react';
import { StyleProp, StyleSheet, Text, TextStyle } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import type { TokenKey } from '../../utils/assistant/glossary';
import { scanJargon } from '../../utils/assistant/jargonScan';

export interface JargonTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
  /** Called when a known glossary term is tapped. The sheet it opens never calls the model. */
  onTerm: (key: TokenKey) => void;
}

/**
 * Assistant text with known glossary terms dotted-underlined and tappable. The app does the scan
 * (utils/assistant/jargonScan.ts), so the model cannot invent a term.
 */
export const JargonText = memo(function JargonText({ text, style, onTerm }: JargonTextProps) {
  const { colors } = useTheme();
  const segments = useMemo(() => scanJargon(text), [text]);
  const term = useMemo(
    () => StyleSheet.create({ t: { textDecorationLine: 'underline', textDecorationStyle: 'dotted', textDecorationColor: colors.accentText } }).t,
    [colors],
  );
  return (
    <Text style={style} selectable>
      {segments.map((s, i) =>
        s.key ? (
          <Text
            key={i}
            style={term}
            onPress={() => onTerm(s.key as TokenKey)}
            accessibilityRole="button"
            accessibilityHint="Explains this term"
          >
            {s.text}
          </Text>
        ) : (
          s.text
        ),
      )}
    </Text>
  );
});
