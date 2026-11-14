import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import Constants from 'expo-constants';
import { maglevEngine } from 'maglev-engine';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { Button, ListRow, RadioCard, Sheet, Toggle } from '../../components/ui';
import { Caption, Card, SettingsPage } from '../../components/settings/SettingsParts';
import { Wordmark } from '../../components/settings/Wordmark';
import { MaglevMark } from '../../components/brand/MaglevMark';
import { errorScreenCopy, updateCopy } from '../../constants/copy';
import { clearCrashLog, copyCrashReport, getCrashLog } from '../../utils/crashLog';
import { REPO_URL, StarTicket } from '../../components/settings/StarTicket';
import { buildIssueUrl, plainNotes } from '../../utils/update/check';
import type { UpdateState } from '../../utils/update/machine';
import {
  checkNow,
  dismissDownloadFailure,
  downloadNow,
  firstUpdateAsks,
  getManagedBy,
  installNow,
  openInstallPermission,
  skipThisVersion,
  useManagedCheck,
  useUpdateState,
} from '../../utils/update';
import { useUpdatePrefs } from '../../utils/prefs/update';
import type { PixelIconName } from '../../components/PixelIcon';

type Extra = { homepage?: string; sourceUrl?: string; privacyUrl?: string };

const MODE_ICONS: Record<'ask' | 'download' | 'auto', PixelIconName> = { ask: 'bell', download: 'download', auto: 'retry' };

/** The update this state is about, when there is one the card can show. */
function updateInfoOf(s: UpdateState) {
  return 'info' in s ? s.info : null;
}

/** What went wrong, in plain English, from the engine code. */
function failureText(code: string): string {
  const n = updateCopy.notices;
  if (code === 'UPDATE_INVALID') return n.invalid;
  if (code === 'STORAGE_FULL') return n.storageFull;
  if (code === 'BLOCKED') return n.blocked;
  return code === 'INSTALL_FAILED' || code === 'INSTALL_CANCELLED' ? n.installFailed : n.downloadFailed;
}

/** Phone details for the bug form (Android only; other platforms send what they have). */
function phoneDetails() {
  const c = (Platform.constants ?? {}) as { Release?: string; Model?: string; Manufacturer?: string };
  const device = [c.Manufacturer, c.Model].filter(Boolean).join(' ');
  return { android: String(c.Release ?? Platform.Version ?? ''), device };
}

export default function AboutSettings() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [crashCount, setCrashCount] = useState(() => getCrashLog().length);
  const [engine, setEngine] = useState<string>('—');
  const [cardOpen, setCardOpen] = useState(false);
  const appVersion = Constants.expoConfig?.version ?? '—';
  const extra = (Constants.expoConfig?.extra ?? {}) as Extra;
  const update = useUpdateState();
  const managedCheck = useManagedCheck();
  const [prefs, setPrefs] = useUpdatePrefs();
  const managedBy = getManagedBy();
  const info = updateInfoOf(update);
  const pending = useRef(false);

  useEffect(() => {
    let alive = true;
    maglevEngine
      .version()
      .then((v) => {
        if (!alive) return;
        setEngine(v.engine === 'unavailable' || !v.version ? 'Unavailable' : `${v.engine} ${v.version}`);
      })
      .catch(() => alive && setEngine('Unavailable'));
    return () => {
      alive = false;
    };
  }, []);

  // A manual check that finds a version opens the card.
  useEffect(() => {
    if (pending.current && update.kind !== 'checking') {
      pending.current = false;
      if (info) setCardOpen(true);
    }
  }, [update, info]);

  const links = [
    extra.homepage && { title: 'Website', url: extra.homepage },
    extra.sourceUrl && extra.sourceUrl !== REPO_URL && { title: 'Source code', url: extra.sourceUrl },
    extra.privacyUrl && { title: 'Privacy policy', url: extra.privacyUrl },
  ].filter(Boolean) as { title: string; url: string }[];

  const newerManaged = managedCheck.status === 'newer' ? managedCheck.info : null;
  const hasUpdate = (info !== null && update.kind !== 'done') || newerManaged !== null;
  const checking = update.kind === 'checking' || managedCheck.status === 'checking';

  const checkValue = checking
    ? updateCopy.check.checking
    : update.kind === 'upToDate' || managedCheck.status === 'upToDate'
      ? updateCopy.check.upToDate
      : update.kind === 'checkFailed' || managedCheck.status === 'failed'
        ? updateCopy.check.failed
        : undefined;

  const reportBug = () => {
    const { android, device } = phoneDetails();
    void Linking.openURL(buildIssueUrl({ version: appVersion, android, device }));
  };

  const runCheck = () => {
    pending.current = true;
    void checkNow({ manual: true });
  };

  return (
    <SettingsPage title="About">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.brand}>
        <MaglevMark height={64} cruising tappable />
        <Wordmark />
      </View>
      <StarTicket />
      <Card>
        <ListRow
          title="App version"
          value={hasUpdate ? undefined : appVersion}
          accessory={
            hasUpdate ? (
              <View style={s.versionEnd}>
                <Text style={s.versionText}>{appVersion}</Text>
                <View style={s.badge} accessible accessibilityLabel={updateCopy.versionBadge}>
                  <Text style={s.badgeText}>{updateCopy.versionBadge}</Text>
                </View>
              </View>
            ) : undefined
          }
        />
        {hasUpdate ? (
          <ListRow
            title={updateCopy.available((info?.version ?? newerManaged?.version) as string)}
            subtitle={managedBy ? updateCopy.managedBy(managedBy) : undefined}
            icon="download"
            onPress={() => (newerManaged ? void Linking.openURL(newerManaged.pageUrl) : setCardOpen(true))}
          />
        ) : (
          <ListRow
            title={updateCopy.check.title}
            icon="retry"
            value={checkValue}
            disabled={checking}
            onPress={runCheck}
          />
        )}
        {managedBy ? (
          <ListRow title={updateCopy.updatesRow.title} subtitle={updateCopy.managedBy(managedBy)} />
        ) : (
          <>
            <View style={s.block} accessibilityRole="radiogroup" accessibilityLabel={updateCopy.updatesRow.title}>
              <Text style={s.label}>{updateCopy.updatesRow.title}</Text>
              {updateCopy.modes.map((m) => (
                <RadioCard
                  key={m.value}
                  title={m.title}
                  icon={MODE_ICONS[m.value]}
                  description={m.description}
                  selected={prefs.updateMode === m.value}
                  onPress={() => prefs.updateMode !== m.value && setPrefs({ updateMode: m.value })}
                  accessibilityLabel={`${m.title}. ${m.description}`}
                />
              ))}
            </View>
            <ListRow
              title={updateCopy.updatesRow.autoCheck}
              subtitle={updateCopy.updatesRow.autoCheckHint}
              accessory={
                <Toggle
                  value={prefs.updateAutoCheck}
                  onValueChange={(updateAutoCheck) => setPrefs({ updateAutoCheck })}
                  accessibilityLabel={updateCopy.updatesRow.autoCheck}
                />
              }
            />
          </>
        )}
        <ListRow title={updateCopy.report.title} subtitle={updateCopy.report.subtitle} icon="external" onPress={reportBug} />
        <ListRow title="Engine" value={engine} />
        <ListRow
          title="Built by Kaos"
          subtitle="Source code on GitHub"
          icon="github"
          onPress={() => void Linking.openURL(REPO_URL)}
          accessibilityHint="Opens the Maglev source code on GitHub"
        />
        {links.map((l) => (
          <ListRow key={l.url} title={l.title} onPress={() => void Linking.openURL(l.url)} />
        ))}
      </Card>
      {crashCount > 0 ? (
        <Card>
          <ListRow
            title={errorScreenCopy.copy}
            subtitle={errorScreenCopy.about.subtitle}
            icon="copy"
            onPress={() => void copyCrashReport()}
          />
          <ListRow
            title={errorScreenCopy.about.clear}
            icon="trash"
            onPress={() => {
              clearCrashLog();
              setCrashCount(0);
            }}
          />
        </Card>
      ) : null}
      <Sheet
        visible={cardOpen && info !== null}
        onClose={() => setCardOpen(false)}
        title={info ? updateCopy.card.title(info.version) : ''}
      >
        {info ? <UpdateCard state={update} notes={info.notes} onClose={() => setCardOpen(false)} /> : null}
      </Sheet>
    </SettingsPage>
  );
}

function UpdateCard({ state, notes, onClose }: { state: UpdateState; notes: string; onClose: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const text = plainNotes(notes);
  const c = updateCopy.card;

  const status = (() => {
    switch (state.kind) {
      case 'downloading': {
        const pct = state.total > 0 ? Math.min(100, Math.floor((state.bytes / state.total) * 100)) : null;
        return pct === null ? c.downloading : `${c.downloading} ${pct}%`;
      }
      case 'waitingForWifi':
        return c.waitingForWifi;
      case 'installing':
        return c.installing;
      case 'needsUser':
        return c.confirm;
      case 'downloadFailed':
      case 'installFailed':
        return failureText(state.code);
      case 'needsPermission':
        return updateCopy.notices.needsPermission;
      default:
        return null;
    }
  })();
  const failed = state.kind === 'downloadFailed' || state.kind === 'installFailed';
  const canInstall = state.kind === 'ready' || state.kind === 'readyAsk' || state.kind === 'installFailed' || state.kind === 'needsUser';
  const canDownload = state.kind === 'available' || state.kind === 'waiting' || state.kind === 'waitingForWifi';
  const canSkip = canDownload || canInstall;

  return (
    <View style={s.cardBody}>
      <Text style={s.label}>{c.whatsNew}</Text>
      <ScrollView style={s.notes} nestedScrollEnabled>
        <Text style={s.notesText}>{text || c.noNotes}</Text>
      </ScrollView>
      {status ? <Text style={[s.status, failed && { color: colors.danger }]}>{status}</Text> : null}
      {canInstall || state.kind === 'installing' ? <Caption>{updateCopy.notices.restartWarning}</Caption> : null}
      {canInstall && firstUpdateAsks() ? <Caption>{updateCopy.hints.firstUpdate}</Caption> : null}
      <View style={s.actions}>
        {state.kind === 'needsPermission' ? (
          <Button label={c.allowInstalls} onPress={() => void openInstallPermission()} />
        ) : null}
        {canInstall ? <Button label={state.kind === 'installFailed' ? c.retry : c.install} onPress={() => void installNow()} /> : null}
        {canDownload ? <Button label={c.download} onPress={() => void downloadNow()} /> : null}
        {state.kind === 'downloadFailed' ? (
          <Button
            label={c.retry}
            onPress={() => {
              void downloadNow();
            }}
          />
        ) : null}
        <Button
          label={c.later}
          variant="ghost"
          onPress={() => {
            if (state.kind === 'downloadFailed') dismissDownloadFailure();
            onClose();
          }}
        />
        {canSkip ? (
          <Button
            label={c.skip}
            variant="ghost"
            onPress={() => {
              skipThisVersion();
              onClose();
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    brand: { alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.xxl },
    block: { padding: spacing.lg, gap: spacing.sm },
    label: { ...type.bodyStrong, fontSize: 14, color: c.text },
    versionEnd: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    versionText: { ...type.body, fontSize: 14, color: c.textMuted },
    badge: { backgroundColor: c.accent, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2 },
    badgeText: { ...type.bodyStrong, fontSize: 12, color: c.onAccent },
    cardBody: { gap: spacing.md },
    notes: { maxHeight: 200 },
    notesText: { ...type.body, fontSize: 14, color: c.textMuted },
    status: { ...type.body, fontSize: 14, color: c.text },
    actions: { gap: spacing.sm },
  });
