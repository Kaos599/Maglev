import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { Banner, Button, Chip, Sheet, Toggle } from '../ui';
import { CATEGORY_LABEL, ProviderInfo, formatSeconds, methodLine } from '../search/meta';
import { Monogram } from './ProviderRow';
import type { SearchPrefs } from '../../utils/prefs/search';
import type { Category } from '../../utils/search/types';
import { banners } from '../../constants/copy';

export interface TestOutcome {
  ok: boolean;
  ms: number;
  message?: string;
}

const stripScheme = (s: string) => s.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

/** Details for one provider: test, address, categories, priority, on/off. */
export function ProviderSheet({
  provider,
  prefs,
  enabled,
  position,
  onCount,
  test,
  testing,
  onClose,
  onTest,
  onToggle,
  onMove,
  onUseFor,
  onAddress,
  onRemove,
}: {
  provider: ProviderInfo | null;
  prefs: SearchPrefs;
  enabled: boolean;
  /** 0-based index in the On list, or -1. */
  position: number;
  onCount: number;
  test?: TestOutcome;
  testing: boolean;
  onClose: () => void;
  onTest: () => void;
  onToggle: (next: boolean) => void;
  onMove: (delta: -1 | 1) => void;
  onUseFor: (cats: Category[] | null) => void;
  /** Empty string clears the override. */
  onAddress: (value: string) => void;
  onRemove?: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const id = provider?.id;
  const defaultAddr = provider ? stripScheme(provider.mirrors[0] ?? '') : '';
  const custom = !!provider?.custom;
  const current = provider ? (custom ? provider.mirrors[0] ?? '' : prefs.mirrorOverride[provider.id] ?? '') : '';
  const [address, setAddress] = useState('');

  useEffect(() => {
    setAddress(stripScheme(current) || defaultAddr);
    // Reset the field only when a different provider opens or the stored value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, current]);

  if (!provider) return <Sheet visible={false} onClose={onClose} title="" />;

  const cats = provider.categories.filter((c) => c !== 'all' && (c !== 'adult' || prefs.adult));
  const selected = prefs.useFor[provider.id] ?? cats;
  const chosen = cats.filter((c) => selected.includes(c));

  const toggleCat = (c: Category) => {
    const on = chosen.includes(c);
    if (on && chosen.length === 1) return; // at least one category stays
    const next = on ? chosen.filter((x) => x !== c) : cats.filter((x) => chosen.includes(x) || x === c);
    onUseFor(next.length === cats.length ? null : next);
  };

  const commitAddress = () => {
    const raw = address.trim();
    if (!raw || (!custom && stripScheme(raw) === defaultAddr)) {
      if (!custom) onAddress('');
      setAddress(stripScheme(current) || defaultAddr);
      return;
    }
    onAddress(/^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : `https://${raw.replace(/\/+$/, '')}`);
  };

  const done = () => {
    commitAddress();
    onClose();
  };

  const modified = !custom && !!prefs.mirrorOverride[provider.id];

  return (
    <Sheet visible onClose={done} title={provider.name} subtitle={methodLine(provider.method)}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {provider.unsafeReason ? <Banner tone="warning" title={banners.sources.unsafe.title} body={provider.unsafeReason} /> : null}

        <View style={styles.headRow}>
          <Monogram abbr={provider.abbr} tint={enabled} />
          <Text style={styles.headText}>{enabled ? 'Used when you search' : 'Not used for search'}</Text>
          <Toggle value={enabled} onValueChange={onToggle} disabled={!!provider.turnedOff} accessibilityLabel={`Use ${provider.name} for search`} />
        </View>

        <View style={styles.testRow} accessibilityLiveRegion="polite">
          {test ? (
            <PixelIcon name={test.ok ? 'check' : 'warning'} size={20} color={test.ok ? colors.success : colors.danger} />
          ) : (
            <PixelIcon name="clock" size={20} color={colors.textMuted} />
          )}
          <Text style={styles.testText}>
            {testing
              ? 'Checking…'
              : test
                ? test.ok
                  ? `Answered in ${formatSeconds(test.ms)}`
                  : test.message || "Didn't answer"
                : 'Not checked yet'}
          </Text>
          <Button label="Test now" variant="secondary" onPress={onTest} loading={testing} />
        </View>

        <View style={styles.group}>
          <Text style={styles.label}>Address</Text>
          <TextInput
            value={address}
            onChangeText={setAddress}
            onBlur={commitAddress}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            selectionColor={colors.accent}
            accessibilityLabel={`${provider.name} address`}
          />
          <View style={styles.hintRow}>
            <Text style={styles.hint}>Use a mirror if this address is blocked on your network.</Text>
            {modified ? (
              <Button label="Reset" variant="ghost" onPress={() => onAddress('')} accessibilityLabel="Reset address to default" />
            ) : null}
          </View>
        </View>

        {cats.length > 1 ? (
          <View style={styles.group}>
            <Text style={styles.label}>Use for</Text>
            <View style={styles.wrap}>
              {cats.map((c) => (
                <Chip key={c} label={CATEGORY_LABEL[c]} selected={chosen.includes(c)} onPress={() => toggleCat(c)} />
              ))}
            </View>
          </View>
        ) : null}

        {enabled && position >= 0 ? (
          <View style={styles.group}>
            <Text style={styles.label}>Priority</Text>
            <Text style={styles.hint}>
              Number {position + 1} of {onCount}. When two sources return the same torrent, the higher one wins.
            </Text>
            <View style={styles.wrap}>
              <Button label="Move up" variant="secondary" onPress={() => onMove(-1)} disabled={position === 0} />
              <Button label="Move down" variant="secondary" onPress={() => onMove(1)} disabled={position === onCount - 1} />
            </View>
          </View>
        ) : null}

        {onRemove ? <Button label="Remove indexer" variant="danger" onPress={onRemove} /> : null}
        <Button label="Done" onPress={done} fullWidth />
      </ScrollView>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    content: { gap: spacing.lg, paddingBottom: spacing.sm },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    headText: { ...type.body, flex: 1, fontSize: 13, color: c.textMuted },
    testRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.bg,
    },
    testText: { ...type.body, flex: 1, fontSize: 13, color: c.text },
    group: { gap: spacing.sm },
    label: { ...type.bodyStrong, fontSize: 12, color: c.textMuted },
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
    hintRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    hint: { ...type.body, flex: 1, fontSize: 12, lineHeight: 17, color: c.textMuted },
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  });
