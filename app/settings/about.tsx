import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter, type Href } from 'expo-router';
import Constants from 'expo-constants';
import { maglevEngine } from 'maglev-engine';
import { ThemeColors, spacing, touch, type } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { Button, Dialog, ListRow, PressableScale } from '../../components/ui';
import { useMaglevEngine } from '../../context/EngineContext';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { Wordmark } from '../../components/settings/Wordmark';
import { MaglevMark } from '../../components/brand/MaglevMark';
import { errorScreenCopy, updateCopy } from '../../constants/copy';
import { clearCrashLog, copyCrashReport, getCrashLog } from '../../utils/crashLog';
import { REPO_URL, StarTicket } from '../../components/settings/StarTicket';
import { aboutExtrasCopy } from '../../constants/aboutCopy';
import { buildIssueUrl, deviceLabel } from '../../utils/update/check';
import { useHasUpdate } from '../../components/settings/updates/useHasUpdate';

type Extra = { homepage?: string; privacyUrl?: string };

/** Phone details for the bug form (Android only; other platforms send what they have). */
function phoneDetails() {
  const c = (Platform.constants ?? {}) as { Release?: string; Model?: string; Manufacturer?: string };
  const device = deviceLabel(c.Manufacturer, c.Model);
  return { android: String(c.Release ?? Platform.Version ?? ''), device };
}

export default function AboutSettings() {
  const { colors } = useTheme();
  const router = useRouter();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [crashCount, setCrashCount] = useState(() => getCrashLog().length);
  const [engine, setEngine] = useState<string>('—');
  const appVersion = Constants.expoConfig?.version ?? '—';
  const extra = (Constants.expoConfig?.extra ?? {}) as Extra;
  const { hasUpdate, version } = useHasUpdate();

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

  const links = [
    extra.homepage && { title: 'Website', url: extra.homepage },
    extra.privacyUrl && { title: 'Privacy policy', url: extra.privacyUrl },
  ].filter(Boolean) as { title: string; url: string }[];

  const reportBug = () => {
    const { android, device } = phoneDetails();
    void Linking.openURL(buildIssueUrl({ version: appVersion, android, device }));
  };
  const openUpdates = () => router.push('/settings/updates');

  const { showNotice } = useMaglevEngine();
  const [logWarning, setLogWarning] = useState(false);
  const [sharing, setSharing] = useState(false);
  const shareLog = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const made = await maglevEngine.exportDebugLog();
      if (!made.ok) throw new Error(made.code);
      const shared = await maglevEngine.shareDebugLog(made.uri);
      if (!shared.ok) throw new Error(shared.code);
    } catch {
      showNotice({ message: aboutExtrasCopy.debugLog.failed });
    } finally {
      setSharing(false);
      setLogWarning(false);
    }
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
        {hasUpdate && version ? (
          <ListRow title={updateCopy.available(version)} icon="download" onPress={openUpdates} />
        ) : null}
        <ListRow title={updateCopy.report.title} subtitle={updateCopy.report.subtitle} icon="external" onPress={reportBug} />
        <ListRow
          title={aboutExtrasCopy.debugLog.title}
          subtitle={aboutExtrasCopy.debugLog.subtitle}
          icon="copy"
          onPress={() => setLogWarning(true)}
        />
        <ListRow
          title="Built by Kaos"
          subtitle="Source code on GitHub"
          icon="github"
          onPress={() => void Linking.openURL(REPO_URL)}
          accessibilityHint="Opens the Maglev source code on GitHub"
        />
        <ListRow
          title={aboutExtrasCopy.licence.title}
          value={aboutExtrasCopy.licence.value}
          icon="file"
          onPress={() => router.push('/settings/licenses' as Href)}
          accessibilityHint={aboutExtrasCopy.licence.hint}
        />
        <ListRow
          title={aboutExtrasCopy.releaseNotes}
          value={appVersion}
          icon="clock"
          onPress={() => router.push('/settings/whats-new' as Href)}
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
      <PressableScale
        onPress={openUpdates}
        style={s.footer}
        accessibilityRole="button"
        accessibilityLabel={`Version ${appVersion}. Opens Updates`}
      >
        <Text style={s.footerText}>{`Version ${appVersion} · ${engine}`}</Text>
      </PressableScale>
      <Dialog
        visible={logWarning}
        onClose={() => setLogWarning(false)}
        title={aboutExtrasCopy.debugLog.dialogTitle}
        actions={
          <>
            <Button label={aboutExtrasCopy.debugLog.share} fullWidth loading={sharing} onPress={() => void shareLog()} />
            <Button
              label={aboutExtrasCopy.debugLog.cancel}
              variant="secondary"
              fullWidth
              onPress={() => setLogWarning(false)}
            />
          </>
        }
      >
        <Text style={s.dialogBody}>{aboutExtrasCopy.debugLog.dialogBody}</Text>
      </Dialog>
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    brand: { alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.xxl },
    footer: { minHeight: touch.min, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.md },
    dialogBody: { ...type.body, color: c.textMuted },
    footerText: { ...type.mono, fontSize: type.size.md, color: c.textMuted, textAlign: 'center' },
  });
