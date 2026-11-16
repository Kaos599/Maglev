import React from 'react';
import { Card, ChipGroup } from './SettingsParts';
import { DownloadParts, PART_CHOICES, useLinkDownloadPrefs } from '../../utils/prefs/linkDownloads';

const OPTIONS: { value: DownloadParts; label: string }[] = PART_CHOICES.map((n) => ({ value: n, label: String(n) }));

/** Parts per link download. Rendered on Settings > Downloads. */
export function PartsSection() {
  const [prefs, update] = useLinkDownloadPrefs();
  return (
    <Card>
      <ChipGroup
        label="Parts per download"
        caption="More parts can be faster. Sites that don't allow it get one part automatically."
        options={OPTIONS}
        value={prefs.downloadParts}
        onChange={(v) => update({ downloadParts: v })}
      />
    </Card>
  );
}
