import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { maglevEngine, type DownloadSnapshot, type EngineResult } from 'maglev-engine';
import { useEngineActions, useEngineState, useEngineTelemetry } from '../../context/EngineContext';
import { useSettings } from '../../context/SettingsContext';
import { useUpdatePrefs } from '../../utils/prefs/update';
import { buildVideoSiteInfo, engineHeaders, partsOption } from '../../utils/videoSites';
import { pickSameOption, shouldRefresh } from '../../utils/videoSiteRefresh';

type RefreshUrl = (id: string, url: string, options?: import('maglev-engine').DownloadOptions) => Promise<EngineResult>;

/**
 * Gets fresh links for a video-site download whose link was refused or expired: reads the page again and gives the
 * download the same quality's new links. Returns true when the download took them. Never throws.
 *
 * The automatic try never updates yt-dlp first (a refused link must not wait on a download). When that try fails the
 * card says "Video sites need an update"; its Update button passes `updateFirst` and does the update, then this again.
 */
export async function refreshVideoSiteDownload(d: DownloadSnapshot, refreshDownloadUrl: RefreshUrl, updateFirst = false): Promise<boolean> {
  const pageUrl = d.pageUrl;
  if (!pageUrl) return false;
  try {
    if (updateFirst) await maglevEngine.videoSitesUpdate();
    const res = await maglevEngine.videoSitesResolve(pageUrl);
    if (!res.ok) return false;
    const option = pickSameOption(buildVideoSiteInfo(JSON.parse(res.json)), d.name);
    if (!option) return false;
    const parts = partsOption(option);
    const out = await refreshDownloadUrl(d.id, option.video.url, {
      headers: engineHeaders(option.video),
      pageUrl,
      ...(parts ? { parts } : {}),
    });
    return out.ok;
  } catch {
    return false;
  }
}

/**
 * Mounted once (root layout). While the app is in the foreground, every video-site download that needs a link because
 * the site refused it gets one automatic try per hour. On mobile data it waits when "Wi-Fi only" is on.
 */
export function useVideoSiteRefresh(): void {
  const { downloads } = useEngineTelemetry();
  const { onMeteredNetwork } = useEngineState();
  const { refreshDownloadUrl } = useEngineActions();
  const { settings } = useSettings();
  const [updatePrefs] = useUpdatePrefs();
  const tries = useRef(new Map<string, number>());
  const downloadsRef = useRef(downloads);
  downloadsRef.current = downloads;
  const blocked = settings.network.wifiOnly && onMeteredNetwork;

  const run = useCallback(
    (list: DownloadSnapshot[]) => {
      if (AppState.currentState !== 'active' || blocked) return;
      const now = Date.now();
      for (const d of list) {
        if (!shouldRefresh(d, tries.current.get(d.id), now)) continue;
        tries.current.set(d.id, now);
        void refreshVideoSiteDownload(d, refreshDownloadUrl);
      }
    },
    [blocked, refreshDownloadUrl],
  );

  useEffect(() => {
    run(downloads);
  }, [downloads, run]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') run(downloadsRef.current);
    });
    return () => sub.remove();
  }, [run]);

  // "Keep video sites working" and "Update on mobile data" reach the daily background update (WorkManager) here, at
  // start and on every change. Off cancels it.
  const { videoSitesAuto, videoSitesMobile } = updatePrefs;
  useEffect(() => {
    void maglevEngine.videoSitesConfigure(videoSitesAuto, videoSitesMobile);
  }, [videoSitesAuto, videoSitesMobile]);
}
