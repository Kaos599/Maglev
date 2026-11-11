import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Platform, StyleSheet, Text, View } from 'react-native';
import { maglevEngine } from 'maglev-engine';
import { Banner, Button, Screen } from '../components/ui';
import { PixelIcon, PixelIconName } from '../components/PixelIcon';
import { BrandMark } from '../components/onboarding/BrandMark';
import { ProgressSquares } from '../components/onboarding/ProgressSquares';
import { StepLayout } from '../components/onboarding/StepLayout';
import { useMaglevEngine } from '../context/EngineContext';
import { useSettings } from '../context/SettingsContext';
import { useTheme } from '../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../constants/theme';

type StepId = 'welcome' | 'notifications' | 'folder' | 'background';

const API_LEVEL = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10) || 0;
const NEEDS_NOTIFICATION_STEP = Platform.OS !== 'android' || API_LEVEL >= 33;
const NEEDS_LEGACY_STORAGE = Platform.OS === 'android' && API_LEVEL <= 28;
const DEFAULT_FOLDER_LABEL = 'Download/Maglev';

const STEPS: StepId[] = NEEDS_NOTIFICATION_STEP
  ? ['welcome', 'notifications', 'folder', 'background']
  : ['welcome', 'folder', 'background'];

function IconTile({ name }: { name: PixelIconName }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.tile}>
      <PixelIcon name={name} size={24} color={colors.accentText} />
    </View>
  );
}

export default function OnboardingScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { settings, updateSettings } = useSettings();
  const { storageStatus, permissionStatus, refreshPermissions } = useMaglevEngine();
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [folderNote, setFolderNote] = useState<string | null>(null);
  const step = STEPS[index];

  const finish = useCallback(() => {
    updateSettings({ onboarded: true });
  }, [updateSettings]);

  const next = useCallback(() => {
    setFolderNote(null);
    if (index >= STEPS.length - 1) finish();
    else setIndex(index + 1);
  }, [index, finish]);

  // Back goes to the previous step. On step 1 the system default (leave the app) applies.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (index > 0) {
        setFolderNote(null);
        setIndex(index - 1);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [index]);

  const allowNotifications = useCallback(async () => {
    setBusy(true);
    try {
      await maglevEngine.requestNotifications();
      await refreshPermissions();
    } finally {
      setBusy(false);
    }
    next();
  }, [next, refreshPermissions]);

  const chooseFolder = useCallback(async () => {
    setBusy(true);
    try {
      const res = await maglevEngine.pickDownloadFolder();
      if ('cancelled' in res) return;
      updateSettings({ downloadFolder: { uri: res.uri, displayName: res.displayName, mode: res.mode } });
      setFolderNote(null);
    } finally {
      setBusy(false);
    }
  }, [updateSettings]);

  const useFolder = useCallback(async () => {
    if (NEEDS_LEGACY_STORAGE && permissionStatus?.legacyStorage !== 'granted') {
      setBusy(true);
      try {
        const res = await maglevEngine.requestLegacyStorage();
        const status = await refreshPermissions();
        if (!res.ok || status.legacyStorage === 'denied') {
          setFolderNote('Storage access was refused. Files are saved in app storage instead.');
          return;
        }
      } finally {
        setBusy(false);
      }
    }
    next();
  }, [next, permissionStatus, refreshPermissions]);

  const allowBackground = useCallback(async () => {
    setBusy(true);
    try {
      await maglevEngine.openBatterySettings();
      await refreshPermissions();
    } finally {
      setBusy(false);
    }
    next();
  }, [next, refreshPermissions]);

  const folder = settings.downloadFolder;
  const folderLabel = folder ? folder.displayName : storageStatus?.fallback ? 'App storage' : DEFAULT_FOLDER_LABEL;

  let content: React.ReactNode;
  if (step === 'welcome') {
    content = (
      <StepLayout
        hero={<BrandMark height={96} />}
        title="Maglev"
        body="Fast, simple torrents."
        actions={
          <>
            <Button label="Get started" size="lg" fullWidth onPress={next} />
            <Button label="Skip setup" variant="ghost" fullWidth onPress={finish} />
          </>
        }
      />
    );
  } else if (step === 'notifications') {
    content = (
      <StepLayout
        hero={<IconTile name="bell" />}
        title="Stay in the loop"
        body="Get notified when downloads finish and keep them running in the background."
        actions={
          <>
            <Button label="Allow" size="lg" fullWidth loading={busy} onPress={allowNotifications} />
            <Button label="Not now" variant="ghost" fullWidth disabled={busy} onPress={next} />
          </>
        }
      />
    );
  } else if (step === 'folder') {
    content = (
      <StepLayout
        hero={<IconTile name="folder" />}
        title="Download folder"
        body="Choose where finished files are saved."
        extra={
          <View style={styles.folderWrap}>
            <View style={styles.folderRow} accessible accessibilityLabel={`Current folder ${folderLabel}`}>
              <PixelIcon name="folder" size={20} color={colors.textMuted} />
              <Text style={styles.folderText} numberOfLines={1} ellipsizeMode="middle">
                {folderLabel}
              </Text>
            </View>
            {folder?.mode === 'staging' ? (
              <Text style={styles.caption}>Files are copied there when they finish.</Text>
            ) : null}
            {folderNote ? <Banner tone="warning" title={folderNote} /> : null}
          </View>
        }
        actions={
          <>
            <Button label="Use this folder" size="lg" fullWidth loading={busy} onPress={useFolder} />
            <Button label="Choose another…" variant="secondary" fullWidth disabled={busy} onPress={chooseFolder} />
            <Button label="Skip" variant="ghost" fullWidth disabled={busy} onPress={next} />
          </>
        }
      />
    );
  } else {
    content = (
      <StepLayout
        hero={<IconTile name="power" />}
        title="Keep running"
        body="Android may stop downloads to save battery. Allow Maglev to keep running?"
        actions={
          <>
            <Button label="Allow" size="lg" fullWidth loading={busy} onPress={allowBackground} />
            <Button label="Skip" variant="ghost" fullWidth disabled={busy} onPress={finish} />
          </>
        }
      />
    );
  }

  return (
    <Screen edges={['top', 'bottom', 'left', 'right']} testID="onboarding">
      <View style={styles.progress}>
        <ProgressSquares index={index} total={STEPS.length} />
      </View>
      <View key={step} style={styles.fill}>
        {content}
      </View>
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1 },
    progress: { alignItems: 'center', paddingTop: spacing.xl, paddingBottom: spacing.sm },
    tile: {
      width: 56,
      height: 56,
      borderRadius: radius.lg,
      backgroundColor: c.surfaceRaised,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    folderWrap: { alignSelf: 'stretch', marginTop: spacing.xl, gap: spacing.sm },
    folderRow: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    folderText: { ...type.mono, fontSize: 13, color: c.text, flexShrink: 1 },
    caption: { ...type.body, fontSize: 12, lineHeight: 17, color: c.textMuted, textAlign: 'center' },
  });
