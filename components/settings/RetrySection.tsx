import React from 'react';
import { AUTO_RETRY_DELAYS, type AutoRetryDelayMin } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { ListRow, Toggle } from '../ui';
import { Caption, Card, ChipGroup } from './SettingsParts';

const retryCopy = {
  title: 'Retry failed downloads',
  keepTitle: 'Keep trying',
  keepSubtitle: 'Off: stop after 3 tries.',
  caption: 'Only for downloads that failed on a bad connection or a busy server.',
} as const;

const OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: '1', label: 'After 1 min' },
  { value: '5', label: 'After 5 min' },
  { value: '15', label: 'After 15 min' },
  { value: '60', label: 'After 1 hour' },
] as const;

/** Wait before a failed link download tries again by itself. Read in Kotlin (WorkManager). Rendered on Settings > Downloads. */
export function RetrySection() {
  const { settings, updateSettings } = useSettings();
  const b = settings.bandwidth;
  const value = (b.autoRetry === 'off' ? 'off' : String(b.autoRetryDelayMin)) as (typeof OPTIONS)[number]['value'];

  const pick = (v: (typeof OPTIONS)[number]['value']) => {
    if (v === 'off') {
      updateSettings((prev) => ({ bandwidth: { ...prev.bandwidth, autoRetry: 'off' } }));
      return;
    }
    const n = Number(v) as AutoRetryDelayMin;
    if (!AUTO_RETRY_DELAYS.includes(n)) return;
    updateSettings((prev) => ({ bandwidth: { ...prev.bandwidth, autoRetry: 'after', autoRetryDelayMin: n } }));
  };

  return (
    <>
      <Card>
        <ChipGroup label={retryCopy.title} options={OPTIONS} value={value} onChange={pick} />
        {b.autoRetry === 'off' ? null : (
          <ListRow
            title={retryCopy.keepTitle}
            subtitle={retryCopy.keepSubtitle}
            accessory={
              <Toggle
                value={b.autoRetryAlways}
                onValueChange={(v) => updateSettings((prev) => ({ bandwidth: { ...prev.bandwidth, autoRetryAlways: v } }))}
                accessibilityLabel={retryCopy.keepTitle}
              />
            }
          />
        )}
      </Card>
      <Caption>{retryCopy.caption}</Caption>
    </>
  );
}
