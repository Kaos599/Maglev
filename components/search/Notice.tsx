import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, BannerTone } from '../ui';

export interface NoticeState {
  tone: BannerTone;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Overrides the 4 s default. */
  durationMs?: number;
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
    timer.current = setTimeout(() => setNotice(null), next.durationMs ?? 4000);
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

export { addErrorNotice } from '../../utils/addErrorNotice';
