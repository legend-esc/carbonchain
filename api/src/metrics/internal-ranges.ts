/**
 * Internal-network allowlist + proxy-trust helpers for
 * internal-network.middleware.ts (issue: middleware trusted req.ip
 * unconditionally and the allowlist omitted the IPv6 ULA range fc00::/7
 * and the shared-address-space range 100.64.0.0/10).
 */

export const INTERNAL_PREFIXES = [
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  '10.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '192.168.',
];

/** fc00::/7 unique local addresses, expressed as the two /8 prefixes it spans. */
export const IPV6_ULA_PREFIXES = ['fc', 'fd'];

function isIpv4InSharedAddressSpace(ip: string): boolean {
  // 100.64.0.0/10 -> second octet in [64, 127]
  const match = /^100\.(\d{1,3})\./.exec(ip);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 64 && second <= 127;
}

function isIpv6UniqueLocal(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return IPV6_ULA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isInternalAddress(ip: string): boolean {
  if (INTERNAL_PREFIXES.some((range) => ip.startsWith(range))) return true;
  if (isIpv4InSharedAddressSpace(ip)) return true;
  if (isIpv6UniqueLocal(ip)) return true;
  return false;
}

export interface ProxyTrustConfig {
  /** Only trust req.ip (which may derive from X-Forwarded-For) when true. */
  trustProxy: boolean;
}

export function resolveClientIp(
  req: { ip?: string; socket: { remoteAddress?: string } },
  config: ProxyTrustConfig,
): string {
  if (config.trustProxy && req.ip) {
    return req.ip;
  }
  return req.socket.remoteAddress ?? '';
}
