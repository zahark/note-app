import { isIPv4, isIPv6 } from 'node:net'

/**
 * Expands a valid IPv6 address (optionally ending in a dotted IPv4 tail) into its 8 16-bit groups.
 * The caller must have checked `isIPv6(addr)`.
 */
function ipv6Groups(addr: string): number[] {
  let text = addr
  const lastColon = text.lastIndexOf(':')
  const last = text.slice(lastColon + 1)
  if (last.includes('.')) {
    // rewrite the dotted IPv4 tail as two hex groups: "::ffff:1.2.3.4" → "::ffff:102:304"
    const [a = 0, b = 0, c = 0, d = 0] = last.split('.').map(Number)
    const hex = (n: number) => n.toString(16)
    text = `${text.slice(0, lastColon + 1)}${hex((a << 8) | b)}:${hex((c << 8) | d)}`
  }
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16))
  const [head = '', tail] = text.split('::')
  const left = parse(head)
  if (tail === undefined) return left
  const right = parse(tail)
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right]
}

/**
 * Normalizes a client address (Fastify `request.ip`) into the key used by every per-IP limit:
 * - an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is unwrapped to plain IPv4 first;
 * - IPv4 keys on the full address;
 * - native IPv6 keys on its /64 prefix (one host's /64 counts as one client).
 * Anything that is not a valid IP is keyed verbatim.
 */
export function ipKey(ip: string): string {
  let addr = ip.trim()
  const zone = addr.indexOf('%')
  if (zone >= 0) addr = addr.slice(0, zone)
  if (isIPv4(addr)) return addr
  if (!isIPv6(addr)) return ip

  const groups = ipv6Groups(addr.toLowerCase())
  const isV4Mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff
  if (isV4Mapped) {
    const hi = groups[6] ?? 0
    const lo = groups[7] ?? 0
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
  }
  const prefix = groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')
  return `${prefix}::/64`
}
