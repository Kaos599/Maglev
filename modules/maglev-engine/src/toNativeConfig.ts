import type { GovernanceConfig, NativeConfig, NativeEncryption, PausedBy } from './MaglevEngine.types.ts';
import { SPEED_PRESET_MAP, type MaglevSettings } from './MaglevSettings.types.ts';

/**
 * Pure mapping from persisted UI settings to the Rust `NativeConfig` (docs/NATIVE_CONTRACT.md section 3).
 * Keys are snake_case because the object is serialized as-is and deserialized by serde.
 */

const ENCRYPTION_MAP: Record<MaglevSettings['network']['encryption'], NativeEncryption> = {
  REQUIRED: 'require',
  PREFERRED: 'prefer',
  DISABLED: 'disable',
};

function speedLimitBps(preset: MaglevSettings['bandwidth']['downloadPreset'], customBps: number): number {
  if (preset === 'CUSTOM') return Math.max(0, Math.floor(customBps || 0));
  return SPEED_PRESET_MAP[preset] ?? 0;
}

/** True when a proxy is enabled but its type is not SOCKS5 (the engine accepts socks5/socks5h only). */
export function proxyUnsupported(proxy: MaglevSettings['network']['proxy']): boolean {
  return proxy.enabled && proxy.type !== 'SOCKS5';
}

/**
 * Builds `socks5h://user:pass@host:port` (remote DNS) with URL-encoded credentials.
 * Null when the proxy is off or its type is unsupported; check `proxyUnsupported` to tell the user why.
 */
export function buildProxyUrl(proxy: MaglevSettings['network']['proxy']): string | null {
  if (!proxy.enabled || proxyUnsupported(proxy) || !proxy.host.trim() || !(proxy.port > 0)) return null;
  const scheme = 'socks5h';
  const user = proxy.username ? encodeURIComponent(proxy.username) : '';
  const pass = proxy.password ? encodeURIComponent(proxy.password) : '';
  const auth = user ? `${user}${pass ? `:${pass}` : ''}@` : '';
  const host = proxy.host.trim();
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host; // IPv6 literal
  return `${scheme}://${auth}${hostPart}:${Math.floor(proxy.port)}`;
}

export function toNativeConfig(settings: MaglevSettings): NativeConfig {
  const { network, bandwidth } = settings;
  return {
    listen_port: network.listeningPort,
    enable_upnp: network.upnpEnabled,
    enable_dht: network.dhtEnabled,
    enable_lsd: network.lsdEnabled,
    enable_pex: network.pexEnabled,
    encryption: ENCRYPTION_MAP[network.encryption] ?? 'prefer',
    max_active_downloads: bandwidth.maxActiveDownloads,
    max_active_seeds: bandwidth.maxActiveUploads,
    max_connections_per_torrent: bandwidth.maxConnectionsPerTorrent,
    download_limit_bps: speedLimitBps(bandwidth.downloadPreset, bandwidth.downloadLimitBytesPerSec),
    upload_limit_bps: speedLimitBps(bandwidth.uploadPreset, bandwidth.uploadLimitBytesPerSec),
    seed_ratio_limit: bandwidth.seedingRatioLimit,
    seed_time_limit_mins: Math.floor(bandwidth.seedingDurationLimitSeconds / 60),
    proxy_url: buildProxyUrl(network.proxy),
    ip_filter_path: network.ipFilterEnabled && network.ipFilterPath ? network.ipFilterPath : null,
  };
}

/** Payload for `setGovernance`. Kotlin watches connectivity and battery; Rust only sees allowed/not allowed. */
export function toGovernance(settings: MaglevSettings): GovernanceConfig {
  const { network, power } = settings;
  return {
    wifiOnly: network.wifiOnly,
    ssidWhitelist: network.ssidWhitelistEnabled ? [...network.allowedSsids] : [],
    chargingOnly: power.downloadOnlyWhileCharging,
    batteryCutoffPct: power.batteryCutoffThreshold,
    autoExitOnComplete: power.autoExitOnComplete,
    resumeAfterRestart: power.resumeAfterRestart,
    vpnOnly: network.vpnOnly,
  };
}

/** Governance reason tags that appear in `Snapshot.pausedBy` (contract section 3). */
export const GOVERNANCE_REASONS: Record<'wifiOnly' | 'chargingOnly' | 'batteryCutoff' | 'vpnOnly', PausedBy> = {
  vpnOnly: 'vpn_required',
  wifiOnly: 'wifi_only',
  chargingOnly: 'charging_only',
  batteryCutoff: 'battery',
};

/**
 * Human labels for fields that only take effect after an engine restart
 * (port, dht, upnp, proxy per contract section 2 `nativeApplyConfig`).
 */
export function restartReasons(prev: NativeConfig, next: NativeConfig): string[] {
  const reasons: string[] = [];
  if (prev.listen_port !== next.listen_port) reasons.push('listening port');
  if (prev.enable_dht !== next.enable_dht) reasons.push('dht');
  if (prev.enable_upnp !== next.enable_upnp) reasons.push('upnp');
  if (prev.proxy_url !== next.proxy_url) reasons.push('proxy');
  return reasons;
}
