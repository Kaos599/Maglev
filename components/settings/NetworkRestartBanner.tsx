import React, { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { maglevEngine } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { Banner } from '../ui';
import { networkAdvancedCopy as copy } from '../../constants/copy';
import { UNKNOWN_NETWORK_STATUS, readNetworkStatus, type NetworkStatus } from '../../utils/networkStatus';

/** The downloader's own word on the saved network settings, refreshed on focus and after each change. */
export function useNetworkStatus() {
  const { settings } = useSettings();
  const { restartRequired, restartEngine: restartWithSettings, showNotice } = useMaglevEngine();
  const [status, setStatus] = useState<NetworkStatus>(UNKNOWN_NETWORK_STATUS);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(readNetworkStatus(await maglevEngine.getEffectiveConfig()));
    } catch {
      setStatus(UNKNOWN_NETWORK_STATUS);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  // A change is applied a moment after it is saved, so ask again once it has settled.
  const changeKey = JSON.stringify(settings.network);
  useEffect(() => {
    const t = setTimeout(() => void refresh(), 700);
    return () => clearTimeout(t);
  }, [changeKey, refresh]);

  const restart = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // The module's own restartEngine (NATIVE_CONTRACT 41) resolves with a result, never throws on failure.
      if (typeof maglevEngine.restartEngine === 'function') {
        const res = await maglevEngine.restartEngine();
        if (!res || (res as { ok?: boolean }).ok === false) throw new Error('restart failed');
      } else if (!(await restartWithSettings())) throw new Error('restart failed');
      showNotice({ message: copy.restarted }, 4000);
    } catch {
      showNotice({ message: copy.restartFailed });
    } finally {
      setBusy(false);
      void refresh();
    }
  }, [busy, refresh, restartWithSettings, showNotice]);

  // Before the downloader reports it, fall back to the older "changed, needs a restart" flag.
  const restartPending = status.restartPending ?? restartRequired;
  return { restartPending, blocklist: status.blocklist, busy, restart };
}

/** "Restart the downloader to apply these changes", with a Restart button. Renders nothing when nothing waits. */
export function NetworkRestartBanner({ restartPending, busy, onRestart }: { restartPending: boolean; busy: boolean; onRestart: () => void }) {
  if (!restartPending) return null;
  return (
    <Banner
      tone="warning"
      title={copy.restartTitle}
      actionLabel={busy ? copy.restarting : copy.restartAction}
      onAction={busy ? () => {} : onRestart}
      testID="network-restart-banner"
    />
  );
}
