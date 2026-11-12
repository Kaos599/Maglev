import React, { memo, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import type { ResultDetailsView } from '../../utils/assistant/runtime';
import { kindIcon, kindsSummary } from '../../utils/assistant/chatView';
import { PixelIcon } from '../PixelIcon';
import { Collapsible } from './Collapsible';

/** "What's inside": one summary line, then small file rows. Collapsed by default so nobody is shown it unasked. */
export const WhatsInside = memo(function WhatsInside({ details }: { details: ResultDetailsView }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);
  const summary = kindsSummary(details);
  return (
    <Collapsible
      open={open}
      onToggle={() => setOpen((o) => !o)}
      accessibilityLabel={`What's inside. ${summary}`}
      header={
        <>
          <Text style={styles.title}>What's inside</Text>
          <Text style={styles.summary}>{summary}</Text>
        </>
      }
    >
      <View style={styles.rows}>
        {details.files.map((f, i) => {
          const tint = f.flag === 'danger' ? colors.danger : f.flag === 'warn' ? colors.warning : colors.textMuted;
          return (
            <View key={`${i}-${f.name}`} style={styles.row}>
              <PixelIcon name={kindIcon(f.kind)} size={16} color={tint} />
              <Text style={[styles.name, f.flag && { color: tint }]}>{f.name}</Text>
              <Text style={styles.size}>{f.sizeText}</Text>
            </View>
          );
        })}
        {details.moreText ? <Text style={styles.more}>{details.moreText}</Text> : null}
      </View>
    </Collapsible>
  );
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    title: { ...type.bodyStrong, fontSize: type.size.md, color: c.text },
    summary: { ...type.body, flex: 1, fontSize: type.size.md, color: c.textMuted },
    rows: { gap: spacing.xs, paddingBottom: spacing.xs },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    name: { ...type.mono, flex: 1, fontSize: type.size.sm, lineHeight: 16, color: c.text },
    size: { ...type.mono, fontSize: type.size.sm, lineHeight: 16, color: c.textMuted },
    more: { ...type.body, fontSize: type.size.sm, color: c.textFaint, paddingLeft: 24 },
  });
