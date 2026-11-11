import React from 'react';
import type { FilePriority } from 'maglev-engine';
import { Banner, ListRow, Sheet } from '../ui';

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Current priority, or null when several files with different priorities are selected. */
  current: FilePriority | null;
  onSelect: (priority: FilePriority) => void;
  error?: string | null;
}

/**
 * Radio sheet for file priority (UI_SPEC S9.3). "Download first" reorders downloading; it does not
 * change bandwidth, so the copy never says "faster".
 */
export function PrioritySheet({ visible, onClose, title, subtitle, current, onSelect, error }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title} subtitle={subtitle}>
      {error ? <Banner tone="warning" title={error} /> : null}
      <ListRow
        title="Download first"
        subtitle="Fetched before other files"
        icon="priority-first"
        selected={current === 'first'}
        onPress={() => onSelect('first')}
      />
      <ListRow title="Normal" selected={current === 'normal'} onPress={() => onSelect('normal')} />
      <ListRow
        title="Skip"
        subtitle="Not downloaded"
        selected={current === 'skip'}
        onPress={() => onSelect('skip')}
      />
    </Sheet>
  );
}
