import React, { useMemo, useRef } from 'react';
import { haptic } from '../../constants/haptics';
import { ListRow } from '../ui';
import { FloatingSheet, NoteRow } from './FloatingSheet';
import { middleTruncate } from './LinkMenu';
import { buildMediaMenu, classifyVideoUrl, type MediaHit, type MenuItem } from '../../utils/browser/mediaHit';

export interface MediaMenuProps {
  /** The long-pressed image or video, or null when the menu is closed. */
  hit: MediaHit | null;
  onClose: () => void;
  /** Save image, Download video, Save preview image: a normal found download (name and folder sheet). `url` is the address to save. */
  onSave: (hit: MediaHit, url: string) => void;
  /** A stream manifest (HLS or DASH). Falls back to `onSave` when not given. */
  onStream?: (hit: MediaHit, url: string, kind: 'hls' | 'dash') => void;
  onOpenNewTab: (url: string) => void;
  onCopy: (url: string) => void;
  onShare: (url: string) => void;
  /** Opens the Files tray for this page. */
  onShowFound: () => void;
  /** Opens the link menu for the link around the media. The row is left out when not given. */
  onLinkOptions?: (linkHref: string) => void;
}

/** The long-press menu for an image or a video. Every action closes the menu first, like LinkMenu. */
export function MediaMenu({ hit, onClose, onSave, onStream, onOpenNewTab, onCopy, onShare, onShowFound, onLinkOptions }: MediaMenuProps) {
  const last = useRef<MediaHit | null>(hit);
  if (hit) last.current = hit;
  const h = hit ?? last.current;
  const menu = useMemo(() => (h ? buildMediaMenu(h) : null), [h]);
  if (!h || !menu) return null;

  const run = (item: MenuItem) => {
    const url = item.url;
    switch (item.id) {
      case 'save-image':
      case 'download-video':
      case 'save-poster':
        if (url) onSave(h, url);
        break;
      case 'download-stream':
        if (url) {
          const kind = classifyVideoUrl(url);
          if (onStream && kind !== 'direct') onStream(h, url, kind);
          else onSave(h, url);
        }
        break;
      case 'open-tab':
        if (url) onOpenNewTab(url);
        break;
      case 'copy':
        if (url) onCopy(url);
        break;
      case 'share':
        if (url) onShare(url);
        break;
      case 'show-found':
        onShowFound();
        break;
      case 'link-options':
        if (url) onLinkOptions?.(url);
        break;
    }
  };

  const items = menu.items.filter((i) => i.id !== 'link-options' || onLinkOptions);
  return (
    <FloatingSheet visible={hit != null} onClose={onClose} title={middleTruncate(h.url ?? h.poster ?? (h.alt || (h.kind === 'video' ? 'Video' : 'Image')))}>
      {menu.note ? <NoteRow text={menu.note} /> : null}
      {items.map((item) => (
        <ListRow
          key={item.id}
          icon={item.icon}
          title={item.title}
          onPress={() => {
            haptic('select');
            onClose();
            run(item);
          }}
        />
      ))}
    </FloatingSheet>
  );
}
