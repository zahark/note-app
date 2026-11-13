import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

/**
 * Normalizes a client address (`request.clientIp`, see `clientIpOf` in app.ts) into the key used by
 * every per-IP limit:
 * - an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is unwrapped to plain IPv4 first;
 * - IPv4 keys on the full address;
 * - native IPv6 keys on its /64 prefix (one host's /64 counts as one client).
 * Anything that is not a valid IP is keyed verbatim.
 */
export function ipKey(ip: string): string {
  // drop an IPv6 zone id (`fe80::1%eth0`)
  const addr = ip.trim().split('%', 1)[0] ?? ''
  if (isIP(addr) === 0) return ip
  const parsed = ipaddr.process(addr)
  if (parsed.kind() === 'ipv4') return parsed.toString()
  const prefix = (parsed as ipaddr.IPv6).parts.slice(0, 4).map((g) => g.toString(16)).join(':')
  return `${prefix}::/64`
}
