import React, { memo, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import type { ProgressStep } from '../../utils/assistant/runtime';
import { stepDetail, stepIcon, stepLabel, stepsRunning, stepsSummary, traceOpen } from '../../utils/assistant/chatView';
import { PixelIcon } from '../PixelIcon';
import { Collapsible } from './Collapsible';
import { Shimmer } from './Shimmer';

/**
 * "Steps" for one turn, after AI Elements' Chain of Thought: a collapsed summary line that opens into the
 * steps. Each step is a Tool row that opens to its one plain detail line. Never raw JSON.
 */
export const Trace = memo(function Trace({ steps }: { steps: ProgressStep[] }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // null until the user taps: then it opens by itself while a step runs, and their choice wins from then on.
  const [choice, setChoice] = useState<boolean | null>(null);
  if (steps.length === 0) return null;
  const open = traceOpen(choice, steps);
  const running = stepsRunning(steps);
  const summary = stepsSummary(steps);

  return (
    <View style={styles.wrap}>
      <Collapsible
        open={open}
        onToggle={() => setChoice(!open)}
        accessibilityLabel={`Steps. ${summary}`}
        header={
          <>
            <Text style={styles.title}>Steps</Text>
            {running ? (
              <Shimmer text={summary} style={styles.summary} />
            ) : (
              <Text style={styles.summary}>{summary}</Text>
            )}
          </>
        }
      >
        <View style={styles.list}>
          {steps.map((s) => (
            <TraceStep key={s.callId + s.text} step={s} />
          ))}
        </View>
      </Collapsible>
    </View>
  );
});

const TraceStep = memo(function TraceStep({ step }: { step: ProgressStep }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);
  const detail = stepDetail(step);
  const failed = step.state === 'failed';
  const tint = failed ? colors.warning : colors.textMuted;
  const label = stepLabel(step);
  const row = (
    <>
      <PixelIcon name={stepIcon(step)} size={16} color={tint} />
      {step.state === 'running' ? (
        <Shimmer text={label} style={[styles.stepText, { flex: 1 }]} />
      ) : (
        <Text style={[styles.stepText, { flex: 1, color: tint }]}>{label}</Text>
      )}
      {step.state === 'done' ? <PixelIcon name="check" size={16} color={colors.accentText} /> : null}
    </>
  );
  if (!detail) return <View style={styles.stepRow}>{row}</View>;
  // A running step shows its live line right under it, with nothing to tap open.
  if (step.state === 'running') {
    return (
      <View>
        <View style={styles.stepRow}>{row}</View>
        <Text style={styles.detail}>{detail}</Text>
      </View>
    );
  }
  return (
    <View>
      <Collapsible open={open} onToggle={() => setOpen((o) => !o)} accessibilityLabel={label} header={row}>
        <Text style={styles.detail}>{detail}</Text>
      </Collapsible>
    </View>
  );
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { alignSelf: 'stretch', paddingHorizontal: spacing.md, borderWidth: 1, borderColor: c.border, borderRadius: radius.md },
    title: { ...type.heading, fontSize: type.size.sm, color: c.textMuted },
    summary: { ...type.body, flex: 1, fontSize: type.size.md, color: c.textMuted },
    list: { paddingBottom: spacing.sm, gap: spacing.xs },
    stepRow: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    stepText: { ...type.body, fontSize: type.size.md, color: c.textMuted },
    detail: { ...type.body, fontSize: type.size.md, lineHeight: 18, color: c.textFaint, paddingLeft: 24, paddingBottom: spacing.xs },
  });
