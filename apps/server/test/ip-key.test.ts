import { describe, expect, it } from 'vitest'
import { ipKey } from '../src/services/ipKey.js'

describe('ipKey', () => {
  it('unwraps IPv4-mapped IPv6 so ::ffff:1.2.3.4 and 1.2.3.4 share one key', () => {
    expect(ipKey('::ffff:1.2.3.4')).toBe('1.2.3.4')
    expect(ipKey('1.2.3.4')).toBe('1.2.3.4')
    expect(ipKey('::ffff:1.2.3.4')).toBe(ipKey('1.2.3.4'))
  })

  it('unwraps the hex and upper-case spellings of a mapped address too', () => {
    expect(ipKey('::ffff:0102:0304')).toBe('1.2.3.4')
    expect(ipKey('::FFFF:1.2.3.4')).toBe('1.2.3.4')
    expect(ipKey('0:0:0:0:0:ffff:1.2.3.4')).toBe('1.2.3.4')
  })

  it('keeps two different IPv4 clients seen as ::ffff: addresses apart', () => {
    expect(ipKey('::ffff:1.2.3.4')).not.toBe(ipKey('::ffff:1.2.3.5'))
    expect(ipKey('::ffff:10.0.0.1')).not.toBe(ipKey('::ffff:192.168.0.1'))
  })

  it('keys IPv4 on the full address', () => {
    expect(ipKey('10.0.0.1')).not.toBe(ipKey('10.0.0.2'))
  })

  it('gives two native IPv6 addresses in the same /64 one key', () => {
    const a = ipKey('2001:db8:1:2::1')
    expect(a).toBe(ipKey('2001:db8:1:2:ffff:ffff:ffff:ffff'))
    expect(a).toBe(ipKey('2001:0DB8:0001:0002:0000:0000:0000:0042'))
    expect(a).toBe('2001:db8:1:2::/64')
  })

  it('gives different /64s different keys', () => {
    expect(ipKey('2001:db8:1:2::1')).not.toBe(ipKey('2001:db8:1:3::1'))
    expect(ipKey('2001:db8::1')).not.toBe(ipKey('2001:db9::1'))
  })

  it('handles loopback, zone ids and non-mapped IPv4 tails', () => {
    expect(ipKey('::1')).toBe('0:0:0:0::/64')
    expect(ipKey('fe80::1%eth0')).toBe(ipKey('fe80::2'))
    // NAT64 prefix is native IPv6, not a mapped address
    expect(ipKey('64:ff9b::1.2.3.4')).toBe('64:ff9b:0:0::/64')
  })

  it('keys anything that is not an IP verbatim', () => {
    expect(ipKey('not-an-ip')).toBe('not-an-ip')
  })
})
