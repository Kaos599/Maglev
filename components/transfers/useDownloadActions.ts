import { useCallback, useMemo } from 'react';
import { useRouter } from 'expo-router';
import { maglevEngine, type DownloadSnapshot, type EngineResult } from 'maglev-engine';
import { useEngineActions } from '../../context/EngineContext';
import { notices } from '../../constants/copy';
import {
  OPEN_FOLDER_FAILED_TEXT,
  SHARE_FAILED_TEXT,
  actionRoute,
  allowDeviceFailureText,
  openFailureText,
  type DownloadAction,
} from '../../utils/downloadCopy';
import { downloadTarget, type SubtitleTarget } from '../subtitles/flow';

/**
 * NATIVE_CONTRACT 40.4: the one set of handlers for a link download. Transfers (card buttons) and the download page
 * (`app/download/[id].tsx`) both use it, so a failure gives the same notice text wherever the button was.
 *
 * Every handler takes the download's id. Failures are shown as a notice (the global toast), never thrown.
 * `run(d, action)` is the switch the buttons share: settings-style actions go to their screen, "Paste new link"
 * opens the download's page (the field is there), the rest call the handler of the same name.
 */
export interface DownloadActions {
  open: (id: string) => void;
  openFolder: (id: string) => void;
  share: (id: string) => void;
  allowDevice: (id: string) => void;
  resumeAnyway: (id: string) => void;
  retry: (id: string) => void;
  pause: (id: string) => void;
  resume: (id: string) => void;
  /** Keeping the files goes through the Undo window; deleting them happens now (the caller confirms first). */
  remove: (id: string, deleteFiles: boolean) => Promise<boolean>;
  /** Speed limit for this download in bytes per second, 0 = no limit. */
  setLimit: (id: string, downLimitBps: number) => void;
  /** Points the download at a new link to the same file. The caller shows the result ("different file", a message). */
  newLink: (id: string, url: string) => Promise<EngineResult>;
  /** The subtitle sheet's target for a finished video, or null. The caller owns the sheet. */
  findSubtitles: (d: DownloadSnapshot) => SubtitleTarget | null;
  /** Opens the page of a link download. */
  openPage: (id: string) => void;
  /** Runs one of `downloadActions`' buttons. */
  run: (d: DownloadSnapshot, action: DownloadAction) => void;
}

export function useDownloadActions(): DownloadActions {
  const router = useRouter();
  const { showNotice, pauseDownload, resumeDownload, retryDownload, removeDownload, setDownloadLimits, refreshDownloadUrl } = useEngineActions();

  const open = useCallback(
    (id: string) => {
      void maglevEngine.openDownload(id).then((res) => {
        if (!res.ok) showNotice({ message: openFailureText(res.code, res.message) });
      });
    },
    [showNotice],
  );
  const openFolder = useCallback(
    (id: string) => {
      void maglevEngine.openDownloadFolder(id).then((res) => {
        if (!res.ok) showNotice({ message: res.message || OPEN_FOLDER_FAILED_TEXT });
      });
    },
    [showNotice],
  );
  const share = useCallback(
    (id: string) => {
      void maglevEngine.shareDownload(id).then((res) => {
        if (!res.ok) showNotice({ message: res.message || SHARE_FAILED_TEXT });
      });
    },
    [showNotice],
  );
  const retry = useCallback((id: string) => void retryDownload(id), [retryDownload]);
  const allowDevice = useCallback(
    (id: string) => {
      void maglevEngine.allowLanHost(id).then((res) => {
        if (!res.ok) showNotice({ message: allowDeviceFailureText(res.code, res.message) });
        else retry(id);
      });
    },
    [showNotice, retry],
  );
  const resumeAnyway = useCallback(
    (id: string) => {
      void maglevEngine.resumeDownloadAnyway(id).then((res) => {
        if (!res.ok) showNotice({ message: res.message || notices.common.retryFailed });
      });
    },
    [showNotice],
  );
  const pause = useCallback((id: string) => void pauseDownload(id), [pauseDownload]);
  const resume = useCallback((id: string) => void resumeDownload(id), [resumeDownload]);
  const remove = useCallback((id: string, deleteFiles: boolean) => removeDownload(id, deleteFiles), [removeDownload]);
  const setLimit = useCallback((id: string, bps: number) => void setDownloadLimits(id, bps), [setDownloadLimits]);
  const newLink = refreshDownloadUrl;
  const findSubtitles = useCallback((d: DownloadSnapshot) => downloadTarget(d), []);
  const openPage = useCallback((id: string) => router.push({ pathname: '/download/[id]', params: { id } }), [router]);

  const run = useCallback(
    (d: DownloadSnapshot, action: DownloadAction) => {
      const route = actionRoute(action.kind, action.route);
      if (route) {
        router.push(route as never);
        return;
      }
      switch (action.kind) {
        case 'pause':
          pause(d.id);
          break;
        case 'resume':
          resume(d.id);
          break;
        case 'retry':
        case 'restart':
          retry(d.id);
          break;
        case 'newLink':
          openPage(d.id);
          break;
        case 'open':
          open(d.id);
          break;
        case 'allowDevice':
          allowDevice(d.id);
          break;
        case 'resumeAnyway':
          resumeAnyway(d.id);
          break;
        // 'remove' is the card's own sheet step (it calls onPress); the page has Remove in its menu.
      }
    },
    [router, pause, resume, retry, openPage, open, allowDevice, resumeAnyway],
  );

  return useMemo(
    () => ({ open, openFolder, share, allowDevice, resumeAnyway, retry, pause, resume, remove, setLimit, newLink, findSubtitles, openPage, run }),
    [open, openFolder, share, allowDevice, resumeAnyway, retry, pause, resume, remove, setLimit, newLink, findSubtitles, openPage, run],
  );
}
