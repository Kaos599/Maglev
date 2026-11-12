import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../../constants/theme';
import { questionLabel } from '../../utils/assistant/chatView';
import { PressableScale } from '../ui/PressableScale';

export interface QuestionnaireProps {
  question: string;
  options: string[];
  answered?: string;
  onAnswer: (option: string) => void;
}

/**
 * A question with tappable answers, after AI Elements' Questionnaire. Once answered the chips lock, the
 * chosen one stays lit and the rest dim.
 */
export const Questionnaire = memo(function Questionnaire({ question, options, answered, onAnswer }: QuestionnaireProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const locked = answered !== undefined;
  return (
    <View style={styles.card} accessible={false}>
      <Text style={styles.question} accessibilityRole="header" accessibilityLabel={questionLabel(question, answered)}>
        {question}
      </Text>
      <View style={styles.options}>
        {options.map((o) => {
          const chosen = locked && o === answered;
          return (
            <PressableScale
              key={o}
              disabled={locked}
              onPress={() => onAnswer(o)}
              accessibilityRole="button"
              accessibilityLabel={o}
              accessibilityState={{ disabled: locked, selected: chosen }}
              style={(pressed) => [styles.chip, chosen ? styles.chosen : pressed ? styles.pressed : styles.idle, locked && !chosen && styles.dim]}
            >
              <Text style={[styles.chipText, { color: chosen ? colors.accentText : colors.text }]}>{o}</Text>
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: { alignSelf: 'stretch', padding: spacing.md, gap: spacing.sm, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius.md },
    question: { ...type.bodyStrong, fontSize: 15, lineHeight: 21, color: c.text },
    options: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: { minHeight: 44, maxWidth: '100%', justifyContent: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.xs, borderRadius: radius.pill, borderWidth: 1 },
    idle: { backgroundColor: c.bg, borderColor: c.border },
    pressed: { backgroundColor: c.surfaceRaised, borderColor: c.border },
    chosen: { backgroundColor: alpha(c.accent, 0.15), borderColor: c.accent },
    dim: { opacity: 0.4 },
    chipText: { ...type.bodyStrong, fontSize: 13 },
  });
