export interface IpRangeRule {
  startIp: number; // 32-bit unsigned int
  endIp: number;   // 32-bit unsigned int
  name: string;
}

/**
 * IP Filtering / Blocklist Engine supporting PeerGuardian and eMule .dat formats.
 *
 * Provides O(log N) binary search rejection for peer IP connection handshakes.
 */
export class MaglevIpFilter {
  private rules: IpRangeRule[] = [];
  private isEnabled: boolean = false;

  constructor(rules: IpRangeRule[] = []) {
    this.setRules(rules);
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }

  public getRulesCount(): number {
    return this.rules.length;
  }

  /**
   * Parse PeerGuardian or eMule .dat / .p2p content into sorted, non-overlapping IP rules.
   */
  public parseDatContent(content: string): number {
    const lines = content.split(/\r?\n/);
    const parsed: IpRangeRule[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
        continue;
      }

      // Format 1: "Name:1.2.3.4-1.2.3.255"
      if (trimmed.includes(':') && trimmed.includes('-')) {
        const colonIdx = trimmed.indexOf(':');
        const name = trimmed.substring(0, colonIdx).trim();
        const rangePart = trimmed.substring(colonIdx + 1).trim();
        const dashIdx = rangePart.indexOf('-');
        if (dashIdx !== -1) {
          const startStr = rangePart.substring(0, dashIdx).trim();
          const endStr = rangePart.substring(dashIdx + 1).trim();
          const startIp = this.ipv4ToUint32(startStr);
          const endIp = this.ipv4ToUint32(endStr);
          if (startIp !== null && endIp !== null && startIp <= endIp) {
            parsed.push({ startIp, endIp, name: name || 'Blocked' });
            continue;
          }
        }
      }

      // Format 2: "1.2.3.4 - 1.2.3.255 , 000 , Range Name"
      if (trimmed.includes('-')) {
        const parts = trimmed.split(',');
        const rangePart = parts[0].trim();
        const name = parts.length > 2 ? parts[2].trim() : 'Blocked';
        const dashParts = rangePart.split('-');
        if (dashParts.length === 2) {
          const startIp = this.ipv4ToUint32(dashParts[0].trim());
          const endIp = this.ipv4ToUint32(dashParts[1].trim());
          if (startIp !== null && endIp !== null && startIp <= endIp) {
            parsed.push({ startIp, endIp, name });
            continue;
          }
        }
      }
    }

    this.setRules(parsed);
    return this.rules.length;
  }

  public setRules(rules: IpRangeRule[]): void {
    // Sort by start IP for binary search
    this.rules = [...rules].sort((a, b) => a.startIp - b.startIp);
  }

  /**
   * Check if an IP address string is blocked via O(log N) binary search.
   */
  public isIpBlocked(ipStr: string): boolean {
    if (!this.isEnabled || this.rules.length === 0) {
      return false;
    }

    const target = this.ipv4ToUint32(ipStr);
    if (target === null) return false;

    let low = 0;
    let high = this.rules.length - 1;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const rule = this.rules[mid];

      if (target >= rule.startIp && target <= rule.endIp) {
        return true; // Match blocked range
      } else if (target < rule.startIp) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    return false;
  }

  private ipv4ToUint32(ip: string): number | null {
    const octets = ip.split('.');
    if (octets.length !== 4) return null;

    let num = 0;
    for (let i = 0; i < 4; i++) {
      const octet = parseInt(octets[i], 10);
      if (isNaN(octet) || octet < 0 || octet > 255) return null;
      num = (num << 8) | octet;
    }
    return num >>> 0; // unsigned 32-bit integer
  }
}

export const ipFilter = new MaglevIpFilter();
