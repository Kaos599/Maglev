import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { siteSheetCopy } from '../../constants/copy';
import { PixelIcon } from '../PixelIcon';
import { Button, ListRow, RadioCard, Sheet, Toggle } from '../ui';

export type SitePopupMode = 'ask' | 'allow' | 'block';

export interface SiteSettingsSheetProps {
  visible: boolean;
  onClose: () => void;
  host: string;
  /** https page. Shown as "Secure connection" or "Not secure". */
  secure: boolean;
  /** The global ad blocker is on. When it is off the Ads section is hidden, as the menu did before. */
  adBlockOn: boolean;
  /** This site is on the allow list (ads shown). The toggle shows the inverse. */
  adsAllowed: boolean;
  adsBlockedCount: number;
  onToggleAds: () => void;
  popupMode: SitePopupMode;
  onPopupMode: (mode: SitePopupMode) => void;
  popupsBlockedCount: number;
  /** Opens the confirm dialog for clearing this site's data. Only passed for http(s) pages. */
  onClear?: () => void;
}

/**
 * The per-site controls. A view over state that lives in app/browser.tsx:
 * every change goes through the same handlers the page menu used before, and applies at once.
 */
export function SiteSettingsSheet({
  visible,
  onClose,
  host,
  secure,
  adBlockOn,
  adsAllowed,
  adsBlockedCount,
  onToggleAds,
  popupMode,
  onPopupMode,
  popupsBlockedCount,
  onClear,
}: SiteSettingsSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const c = siteSheetCopy;
  const choices: { value: SitePopupMode; title: string; hint: string; icon: 'bell' | 'check' | 'close' }[] = [
    { value: 'ask', title: c.ask, hint: c.askHint, icon: 'bell' },
    { value: 'allow', title: c.allow, hint: c.allowHint, icon: 'check' },
    { value: 'block', title: c.block, hint: c.blockHint, icon: 'close' },
  ];
  return (
    <Sheet visible={visible} onClose={onClose} title={c.title}>
      <View style={styles.head}>
        <View style={styles.tile}>
          <PixelIcon name={secure ? 'lock' : 'warning'} size={20} color={secure ? colors.accent : colors.warning} />
        </View>
        <View style={styles.headText}>
          <Text style={styles.host} numberOfLines={1}>
            {host}
          </Text>
          <Text style={[styles.status, !secure && { color: colors.warning }]}>{secure ? c.secure : c.notSecure}</Text>
        </View>
      </View>

      {adBlockOn ? (
        <>
          <Text style={styles.section} accessibilityRole="header">
            {c.adsSection}
          </Text>
          <ListRow
            icon="shield"
            title={c.adsToggle}
            subtitle={adsBlockedCount > 0 ? c.blockedOnPage(adsBlockedCount) : undefined}
            accessory={<Toggle value={!adsAllowed} onValueChange={onToggleAds} accessibilityLabel={c.adsToggle} />}
          />
        </>
      ) : null}

      <View style={styles.sectionRow}>
        <Text style={styles.section} accessibilityRole="header">
          {c.popupsSection}
        </Text>
        {popupsBlockedCount > 0 ? <Text style={styles.count}>{c.blockedOnPage(popupsBlockedCount)}</Text> : null}
      </View>
      <View style={styles.cards} accessibilityRole="radiogroup" accessibilityLabel={c.popupsSection}>
        {choices.map((o) => (
          <RadioCard
            key={o.value}
            icon={o.icon}
            title={o.title}
            description={o.hint}
            selected={popupMode === o.value}
            onPress={() => onPopupMode(o.value)}
          />
        ))}
      </View>

      {onClear ? (
        <View style={styles.clear}>
          <Button label={c.clear} variant="danger" fullWidth onPress={onClear} />
        </View>
      ) : null}
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    tile: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      backgroundColor: c.surface,
    },
    headText: { flex: 1, minWidth: 0 },
    host: { ...type.mono, fontSize: type.size.md, color: c.text },
    status: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    sectionRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingRight: spacing.lg },
    section: { ...type.heading, fontSize: type.size.sm, color: c.textMuted, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xs },
    count: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    cards: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    clear: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  });
