import React from 'react';
import { Stack } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { useSettings } from '../../context/SettingsContext';
import { Button, ListRow, SectionHeader, Toggle } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { ClipboardSetting } from '../../components/settings/ClipboardSetting';
import { PartsSection } from '../../components/settings/PartsSection';
import { RetrySection } from '../../components/settings/RetrySection';
import { quickShareCopy } from '../../constants/copy';
import { haptic } from '../../constants/haptics';
import { useCookiesTxt } from '../../utils/cookiesTxt';

export default function DownloadsSettings() {
  const { settings, updateSettings } = useSettings();
  const { summary: cookieSummary, importCookies, clearCookies } = useCookiesTxt();
  const p = settings.power;
  const set = (patch: Partial<typeof p>) => updateSettings((prev) => ({ power: { ...prev.power, ...patch } }));

  const handleImportCookies = async () => {
    haptic('tap');
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'application/json', '*/*'],
        copyToCacheDirectory: true,
      });
      if (!picked.canceled && picked.assets?.length) {
        const text = await FileSystem.readAsStringAsync(picked.assets[0].uri);
        importCookies(text);
        haptic('commit');
        return;
      }
      const clip = (await Clipboard.getStringAsync()).trim();
      if (clip) {
        importCookies(clip);
        haptic('commit');
      }
    } catch {
      // ignore picker cancellation
    }
  };

  const cookieSubtitle =
    cookieSummary.totalCount > 0
      ? `${cookieSummary.totalCount} cookies active (${cookieSummary.platforms.join(', ') || cookieSummary.domains.slice(0, 3).join(', ')}).`
      : 'Import Netscape cookies.txt for Instagram, TikTok, Reddit, Facebook, Threads, Pinterest, and YouTube.';

  return (
    <SettingsPage title="Adding and finishing">
      <Stack.Screen options={{ headerShown: false }} />
      <SectionHeader title="Adding downloads" />
      <Card>
        <ListRow
          title={quickShareCopy.setting.title}
          subtitle={quickShareCopy.setting.subtitle}
          accessory={
            <Toggle
              value={settings.storage.addWithoutAsking}
              onValueChange={(v) => updateSettings((prev) => ({ storage: { ...prev.storage, addWithoutAsking: v } }))}
              accessibilityLabel={quickShareCopy.setting.title}
            />
          }
        />
        <ClipboardSetting />
      </Card>
      <SectionHeader title="Link downloads" />
      <PartsSection />
      <RetrySection />
      <Card>
        <ListRow
          title="Social login session"
          subtitle={cookieSubtitle}
          onPress={() => void handleImportCookies()}
          accessory={
            cookieSummary.totalCount > 0 ? (
              <Button
                label="Clear"
                variant="secondary"
                onPress={() => {
                  haptic('tap');
                  clearCookies();
                }}
              />
            ) : (
              <Button
                label="Import"
                variant="secondary"
                onPress={() => void handleImportCookies()}
              />
            )
          }
        />
      </Card>
      <SectionHeader title="When downloads finish" />
      <Card>
        <ListRow
          title="Close when done"
          subtitle="Exit Maglev after the last download finishes."
          accessory={<Toggle value={p.autoExitOnComplete} onValueChange={(v) => set({ autoExitOnComplete: v })} accessibilityLabel="Close when done" />}
        />
        <ListRow
          title="Resume after restart"
          subtitle="Continue downloads after the phone restarts or Maglev updates."
          accessory={<Toggle value={p.resumeAfterRestart} onValueChange={(v) => set({ resumeAfterRestart: v })} accessibilityLabel="Resume after restart" />}
        />
      </Card>
    </SettingsPage>
  );
}
