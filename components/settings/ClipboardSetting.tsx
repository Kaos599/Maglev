import React from 'react';
import { ListRow, Toggle } from '../ui';
import { clipboardCopy } from '../../constants/clipboardCopy';
import { useCatchCopiedLinks } from '../../utils/prefs/clipboard';

/** Settings row: offer to download a link that is on the clipboard when Maglev opens. */
export function ClipboardSetting() {
  const [on, setOn] = useCatchCopiedLinks();
  return (
    <ListRow
      title={clipboardCopy.settingTitle}
      subtitle={clipboardCopy.settingSubtitle}
      accessory={<Toggle value={on} onValueChange={setOn} accessibilityLabel={clipboardCopy.settingTitle} />}
    />
  );
}
