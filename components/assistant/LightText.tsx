import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import type { TokenKey } from '../../utils/assistant/glossary';
import { parseLight } from '../../utils/assistant/chatView';
import { JargonText } from './JargonText';

/**
 * Assistant text with light formatting: paragraphs, bullet and numbered lists, **bold**. Our own parser
 * (utils/assistant/chatView.ts) so nothing else can render: no links, no images. Glossary terms stay tappable.
 */
export const LightText = memo(function LightText({ text, onTerm }: { text: string; onTerm: (key: TokenKey) => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const blocks = useMemo(() => parseLight(text), [text]);
  return (
    <View style={styles.wrap}>
      {blocks.map((b, i) =>
        b.type === 'p' ? (
          <JargonText key={i} spans={b.spans} style={styles.text} onTerm={onTerm} />
        ) : (
          <View key={i} style={styles.list}>
            {b.items.map((item, j) => (
              <View key={j} style={styles.item}>
                <Text style={[styles.text, styles.marker]}>{b.type === 'ol' ? `${j + 1}.` : '•'}</Text>
                <View style={styles.itemBody}>
                  <JargonText spans={item} style={styles.text} onTerm={onTerm} />
                </View>
              </View>
            ))}
          </View>
        ),
      )}
    </View>
  );
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { gap: spacing.sm },
    text: { ...type.body, fontSize: 15, lineHeight: 21, color: c.text },
    list: { gap: spacing.xs },
    item: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
    marker: { minWidth: 16, color: c.textMuted },
    itemBody: { flex: 1 },
  });
