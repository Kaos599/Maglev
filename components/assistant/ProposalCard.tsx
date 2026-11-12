import React, { memo, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../../constants/theme';
import { CARD_EXPIRED_CAPTION, type CardState } from '../../utils/assistant/cardMachine';
import type { ProposalCardView } from '../../utils/assistant/runtime';
import { Button, Sheet } from '../ui';
import { PixelIcon } from '../PixelIcon';
import { Shimmer } from './Shimmer';

export interface ProposalCardProps {
  view: ProposalCardView;
  state: CardState;
  onConfirm: () => void;
  onDismiss: () => void;
}

/**
 * A proposal awaiting the user's tap, after AI Elements' Confirmation (approve or deny) with its Plan list for
 * multi-step proposals, and the one-line note it settles into.
 */
export const ProposalCard = memo(function ProposalCard({ view, state, onConfirm, onDismiss }: ProposalCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [riskyOpen, setRiskyOpen] = useState(false);

  switch (state.kind) {
    case 'done':
      return (
        <View style={styles.note}>
          <PixelIcon name="check" size={16} color={colors.success} />
          <Text style={styles.noteText}>{state.summary ?? 'Done.'}</Text>
        </View>
      );
    case 'dismissed':
      return (
        <View style={styles.note}>
          <Text style={styles.noteText}>Dismissed.</Text>
        </View>
      );
    case 'expired':
      return (
        <View style={[styles.card, styles.expired]}>
          <Text style={styles.expiredTitle}>{view.title}</Text>
          <Text style={styles.noteText}>{state.caption ?? CARD_EXPIRED_CAPTION}</Text>
        </View>
      );
    default:
      break;
  }

  const working = state.kind === 'confirming' || state.kind === 'executing';
  const confirmLabel = state.kind === 'confirming' ? 'Checking…' : state.kind === 'executing' ? 'Working…' : state.kind === 'failed' ? 'Try again' : view.confirmLabel;
  const problem = state.kind === 'failed' ? state.error : state.reason;

  const onConfirmPress = () => {
    if (view.risky) setRiskyOpen(true);
    else onConfirm();
  };

  return (
    <View style={[styles.card, view.danger && styles.cardDanger]}>
      <View style={styles.head}>
        <PixelIcon name={view.danger ? 'warning' : 'shield'} size={16} color={view.danger ? colors.danger : colors.accentText} />
        <Text style={[styles.ask, view.danger && { color: colors.danger }]}>Needs your OK</Text>
      </View>
      <Text style={styles.title} accessibilityRole="header">
        {view.title}
      </Text>

      {view.sourceName ? (
        <View style={styles.sourceName}>
          <Text style={styles.sourceLabel}>Name from the source</Text>
          <Text style={styles.fact}>{view.sourceName}</Text>
        </View>
      ) : null}

      <View style={styles.facts}>
        {view.facts.map((f) => (
          <Text key={f} style={styles.fact}>
            {f}
          </Text>
        ))}
      </View>

      {view.steps && view.steps.length > 0 ? (
        <View style={styles.plan}>
          {view.steps.map((st, i) => (
            <View key={`${i}-${st}`} style={styles.planRow}>
              <View style={styles.planNum}>
                <Text style={styles.planNumText}>{i + 1}</Text>
              </View>
              {state.kind === 'executing' ? (
                <Shimmer text={st} style={styles.step} />
              ) : (
                <Text style={styles.step}>{st}</Text>
              )}
            </View>
          ))}
        </View>
      ) : null}

      {view.reason ? (
        <View style={styles.says}>
          <Text style={styles.saysLabel}>Assistant says</Text>
          <Text style={styles.saysText}>{view.reason}</Text>
        </View>
      ) : null}

      <Text style={styles.footer}>Sizes and space are checked by Maglev. The name comes from the source.</Text>

      {problem ? (
        <View style={styles.problem} accessibilityRole="alert">
          <PixelIcon name="warning" size={16} color={colors.danger} />
          <Text style={styles.problemText}>{problem}</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button
          label={confirmLabel}
          variant={view.danger ? 'danger' : 'primary'}
          disabled={working}
          onPress={onConfirmPress}
        />
        <Button label={view.dismissLabel} variant="secondary" disabled={working} onPress={onDismiss} />
      </View>

      {/* Same copy as the risky-source confirmation in the Search tab. */}
      <Sheet visible={riskyOpen} onClose={() => setRiskyOpen(false)} title="Add from a risky source?">
        <View style={styles.sheetActions}>
          <Button
            label="Add anyway"
            fullWidth
            onPress={() => {
              setRiskyOpen(false);
              onConfirm();
            }}
          />
          <Button label="Cancel" variant="secondary" fullWidth onPress={() => setRiskyOpen(false)} />
        </View>
      </Sheet>
    </View>
  );
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      alignSelf: 'stretch',
      padding: spacing.md,
      gap: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
    },
    cardDanger: { borderColor: alpha(c.danger, 0.5) },
    expired: { gap: spacing.xs, opacity: 0.7 },
    expiredTitle: { ...type.bodyStrong, fontSize: 14, color: c.textMuted },
    title: { ...type.bodyStrong, fontSize: 16, color: c.text },
    facts: { gap: spacing.xs },
    sourceName: { gap: 2 },
    sourceLabel: { ...type.bodyStrong, fontSize: type.size.sm, color: c.textMuted },
    fact: { ...type.mono, fontSize: type.size.md, lineHeight: 18, color: c.text },
    head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    ask: { ...type.heading, fontSize: type.size.sm, color: c.accentText },
    plan: { gap: spacing.sm },
    planRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    planNum: { minWidth: 20, height: 20, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    planNumText: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    step: { ...type.body, flex: 1, fontSize: 14, lineHeight: 20, color: c.text },
    says: { gap: 2 },
    saysLabel: { ...type.bodyStrong, fontSize: type.size.sm, color: c.textMuted },
    saysText: { ...type.body, fontSize: 14, lineHeight: 20, fontStyle: 'italic', color: c.textMuted },
    footer: { ...type.body, fontSize: type.size.sm, color: c.textFaint },
    problem: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    problemText: { ...type.body, flex: 1, fontSize: type.size.md, lineHeight: 18, color: c.danger },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    sheetActions: { gap: spacing.sm },
    note: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, alignSelf: 'flex-start', paddingHorizontal: spacing.xs },
    noteText: { ...type.body, fontSize: type.size.md, color: c.textMuted },
  });
