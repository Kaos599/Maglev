import React, { useMemo, useRef } from 'react';
import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { type BrowserLongPressEvent } from 'maglev-engine';
import { browserTabs, notices } from '../../constants/copy';
import { haptic } from '../../constants/haptics';
import { ListRow } from '../ui';
import type { PixelIconName } from '../PixelIcon';
import { FloatingSheet, afterSheetCloses } from './FloatingSheet';

export type LinkMenuTarget = BrowserLongPressEvent;

export interface LinkMenuProps {
  /** The long-pressed link or image, or null when the menu is closed. */
  target: LinkMenuTarget | null;
  onClose: () => void;
  openInTab: (url: string, background: boolean) => void;
  download: (url: string) => void;
  addTorrent: (uri: string) => void;
  notify: (message: string) => void;
}

type Row = { icon: PixelIconName; title: string; run: () => void };

/** Middle-truncates a long address to one line. */
export function middleTruncate(s: string, max = 52): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}

/** T3: the long-press menu. Rows per kind (contract 24.10). Every action closes the menu first. */
export function LinkMenu({ target, onClose, openInTab, download, addTorrent, notify }: LinkMenuProps) {
  const last = useRef<LinkMenuTarget | null>(target);
  if (target) last.current = target;
  const t = target ?? last.current;

  const rows = useMemo<Row[]>(() => {
    if (!t) return [];
    const L = browserTabs.longPress;
    const copy = (text: string) => async () => {
      try {
        await Clipboard.setStringAsync(text);
        haptic('done');
        afterSheetCloses(() => notify(notices.browser.linkCopied));
      } catch {
        haptic('fail');
        afterSheetCloses(() => notify(notices.browser.linkCopyFailed));
      }
    };
    const share = (text: string) => () => {
      Share.share({ message: text }).catch(() => {});
    };
    const link = t.url;
    const image = t.imageUrl;
    const out: Row[] = [];
    if (link && link.startsWith('magnet:')) {
      out.push({ icon: 'magnet', title: L.addTorrent, run: () => addTorrent(link) });
      out.push({ icon: 'copy', title: L.copyLink, run: () => void copy(link)() });
      return out;
    }
    const linkRows = (u: string): Row[] => [
      { icon: 'plus', title: L.openNewTab, run: () => openInTab(u, false) },
      { icon: 'external', title: L.openBackground, run: () => openInTab(u, true) },
      { icon: 'copy', title: L.copyLink, run: () => void copy(u)() },
      { icon: 'download', title: L.downloadLink, run: () => download(u) },
      { icon: 'share', title: L.shareLink, run: share(u) },
    ];
    if (t.kind === 'image' && image) {
      return [
        { icon: 'plus', title: L.openImageNewTab, run: () => openInTab(image, false) },
        { icon: 'download', title: L.downloadImage, run: () => download(image) },
        { icon: 'copy', title: L.copyImageLink, run: () => void copy(image)() },
        { icon: 'share', title: L.shareImageLink, run: share(image) },
      ];
    }
    if (link) out.push(...linkRows(link));
    if (t.kind === 'imageLink' && image) out.push({ icon: 'download', title: L.downloadImage, run: () => download(image) });
    return out;
  }, [t, openInTab, download, addTorrent, notify]);

  if (!t) return null;
  const title = middleTruncate((t.kind === 'image' ? t.imageUrl : t.url) ?? '');
  return (
    <FloatingSheet visible={target != null} onClose={onClose} title={title}>
      {rows.map((r) => (
        <ListRow
          key={r.title}
          icon={r.icon}
          title={r.title}
          onPress={() => {
            haptic('select');
            onClose();
            r.run();
          }}
        />
      ))}
    </FloatingSheet>
  );
}
