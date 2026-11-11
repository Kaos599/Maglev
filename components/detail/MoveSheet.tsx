import React from 'react';
import { Banner, ListRow, Sheet } from '../ui';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Where the files are now, already friendly (no storage root). */
  currentFolder: string;
  busy: boolean;
  error: string | null;
  /** Offer "Pick a folder again" beside the error. */
  pickAgain?: boolean;
  onDefault: () => void;
  onPick: () => void;
}

/** Destination chooser for "Move to…" (NATIVE_CONTRACT 11.3). */
export function MoveSheet({ visible, onClose, currentFolder, busy, error, pickAgain, onDefault, onPick }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Move to…" subtitle={`Now in ${currentFolder}`}>
      {error ? <Banner tone="danger" title="Couldn't move" body={error} actionLabel={pickAgain ? 'Pick a folder again' : undefined} onAction={pickAgain ? onPick : undefined} /> : null}
      <ListRow title="Download/Maglev (default)" icon="folder" disabled={busy} onPress={onDefault} />
      <ListRow title="Pick a folder" icon="move" disabled={busy} onPress={onPick} />
    </Sheet>
  );
}
