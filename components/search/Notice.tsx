import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, BannerTone } from '../ui';

export interface NoticeState {
  tone: BannerTone;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** Short-lived inline notice (plain toast replacement). Auto-dismisses after 4s. */
export function useNotice() {
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setNotice(null);
  }, []);

  const show = useCallback((next: NoticeState) => {
    if (timer.current) clearTimeout(timer.current);
    setNotice(next);
    timer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { notice, show, dismiss };
}

export function NoticeBanner({ notice, onDismiss }: { notice: NoticeState | null; onDismiss: () => void }) {
  if (!notice) return null;
  return <Banner tone={notice.tone} title={notice.title} body={notice.body} actionLabel={notice.actionLabel} onAction={notice.onAction} onDismiss={onDismiss} />;
}

/** Maps an engine add failure to plain copy. Contract: Error carries `.code`. */
export function addErrorNotice(e: unknown): { duplicate: boolean; notice: NoticeState } {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'DUPLICATE') {
    return { duplicate: true, notice: { tone: 'info', title: 'Already in your list' } };
  }
  if (code === 'INVALID_SOURCE') {
    return { duplicate: false, notice: { tone: 'danger', title: 'That link is not a valid torrent' } };
  }
  const message = e instanceof Error && e.message ? e.message : 'Try again in a moment.';
  return { duplicate: false, notice: { tone: 'danger', title: 'Could not add the torrent', body: message } };
}
