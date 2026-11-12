import React, { memo, useMemo } from 'react';
import { AccessibilityActionEvent, StyleProp, StyleSheet, Text, TextStyle } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import type { TokenKey } from '../../utils/assistant/glossary';
import { scanJargon } from '../../utils/assistant/jargonScan';

export interface JargonTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
  /** Called when a known glossary term is tapped. The sheet it opens never calls the model. */
  onTerm: (key: TokenKey) => void;
}

const MAX_ACTIONS = 6;

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
  // TalkBack cannot reliably focus a span inside a paragraph. So the whole message is one focus stop and each
  // distinct term is a custom action ("WEB-DL, what is this?") in TalkBack's Actions menu. Sighted taps still hit the span.
  const terms = useMemo(() => {
    const seen = new Set<string>();
    const out: { key: TokenKey; label: string }[] = [];
    for (const s of segments) {
      if (s.key && !seen.has(s.key) && out.length < MAX_ACTIONS) {
        seen.add(s.key);
        out.push({ key: s.key as TokenKey, label: s.text });
      }
    }
    return out;
  }, [segments]);
  const actions = useMemo(() => terms.map((t) => ({ name: t.key as string, label: `${t.label}, what is this?` })), [terms]);
  const onAction = (e: AccessibilityActionEvent) => {
    const hit = terms.find((t) => t.key === e.nativeEvent.actionName);
    if (hit) onTerm(hit.key);
  };
  return (
    <Text
      style={style}
      selectable
      accessible={terms.length > 0 ? true : undefined}
      accessibilityActions={terms.length > 0 ? actions : undefined}
      onAccessibilityAction={terms.length > 0 ? onAction : undefined}
    >
      {segments.map((s, i) =>
        s.key ? (
          <Text
            key={i}
            style={term}
            onPress={() => onTerm(s.key as TokenKey)}
            accessibilityRole="button"
            accessibilityLabel={`${s.text}, what is this?`}
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
