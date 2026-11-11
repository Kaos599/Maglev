import React from 'react';
import { Stack } from 'expo-router';
import { ListRow, Toggle } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { assistantPrefs, useAssistantPrefs } from '../../utils/prefs/assistantApp';

const fmt = (n: number) => n.toLocaleString();

export default function AssistantSettings() {
  const p = useAssistantPrefs();
  const used = p.tokensUsed.input + p.tokensUsed.output;
  return (
    <SettingsPage title="ASSISTANT">
      <Stack.Screen options={{ headerShown: false }} />
      <Card>
        <ListRow
          title="Assistant"
          subtitle="Adds an Assistant tab. When off, the tab is gone and nothing is sent anywhere."
          accessory={
            <Toggle
              value={p.enabled}
              onValueChange={(v) => assistantPrefs.update({ enabled: v })}
              accessibilityLabel="Assistant"
            />
          }
        />
        {used > 0 ? (
          <ListRow
            title="Tokens used"
            value={fmt(used)}
            subtitle={`${fmt(p.tokensUsed.input)} sent · ${fmt(p.tokensUsed.output)} received`}
          />
        ) : null}
        {p.warningAcceptedAt ? (
          <ListRow
            title="Show the usage notice again"
            subtitle="You'll see it next time you open the Assistant tab."
            onPress={() => assistantPrefs.update({ warningAcceptedAt: null })}
          />
        ) : null}
      </Card>
    </SettingsPage>
  );
}
