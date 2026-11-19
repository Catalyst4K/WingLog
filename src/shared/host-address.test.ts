import { describe, expect, it } from 'vitest'
import {
  formatPairingText,
  isCertificatePin,
  isHomeNetworkAddress,
  parseHostAddress,
  parsePairingText
} from './host-address'

describe('parseHostAddress', () => {
  it('accepts a private address with a port, however it was copied', () => {
    expect(parseHostAddress('192.168.1.20:5051')).toBe('192.168.1.20:5051')
    expect(parseHostAddress('  http://192.168.1.20:5051/  ')).toBe('192.168.1.20:5051')
    expect(parseHostAddress('ws://10.0.0.7:49321/live')).toBe('10.0.0.7:49321')
    expect(parseHostAddress('172.16.4.2:80')).toBe('172.16.4.2:80')
    expect(parseHostAddress('172.31.255.255:65535')).toBe('172.31.255.255:65535')
    expect(parseHostAddress('169.254.10.10:5051')).toBe('169.254.10.10:5051')
    expect(parseHostAddress('127.0.0.1:5051')).toBe('127.0.0.1:5051')
  })

  it('accepts a local name', () => {
    expect(parseHostAddress('simpc:5051')).toBe('simpc:5051')
    expect(parseHostAddress('localhost:5051')).toBe('localhost:5051')
    expect(parseHostAddress('SIM-PC.local:5051')).toBe('SIM-PC.local:5051')
  })

  it('refuses an address on the internet', () => {
    expect(parseHostAddress('8.8.8.8:5051')).toBeNull()
    expect(parseHostAddress('172.32.0.1:5051')).toBeNull()
    expect(parseHostAddress('192.169.1.1:5051')).toBeNull()
    expect(parseHostAddress('example.com:5051')).toBeNull()
    expect(parseHostAddress('simpc.example.org:5051')).toBeNull()
  })

  it('refuses what is not an address with a port', () => {
    expect(parseHostAddress('')).toBeNull()
    expect(parseHostAddress('192.168.1.20')).toBeNull()
    expect(parseHostAddress('192.168.1.20:0')).toBeNull()
    expect(parseHostAddress('192.168.1.20:70000')).toBeNull()
    expect(parseHostAddress('192.168.1.300:5051')).toBeNull()
    expect(parseHostAddress('192.168.1.20:5051/path')).toBeNull()
    expect(parseHostAddress('[fe80::1]:5051')).toBeNull()
    expect(parseHostAddress('user@192.168.1.20:5051')).toBeNull()
    expect(parseHostAddress('-bad-:5051')).toBeNull()
  })
})

/** A pin as the host makes them: 43 characters of base64url. */
const PIN = 'Ab-_09'.repeat(7) + 'A'

describe('isCertificatePin', () => {
  it('accepts 43 base64url characters and nothing else', () => {
    expect(PIN).toHaveLength(43)
    expect(isCertificatePin(PIN)).toBe(true)
    for (const bad of [
      PIN.slice(1),
      PIN + 'a',
      `${PIN.slice(1)}=`,
      `${PIN.slice(1)}+`,
      `${PIN.slice(1)}/`,
      '',
      null,
      5,
      undefined
    ]) {
      expect(isCertificatePin(bad), String(bad)).toBe(false)
    }
  })
})

describe('the pairing text', () => {
  it('is the address, the code and the certificate pin in one line, and reads back', () => {
    const text = formatPairingText('192.168.1.20:5051', '123456', PIN)
    expect(text).toBe(`winglog-pair://192.168.1.20:5051/123456/${PIN}`)
    expect(parsePairingText(text)).toEqual({ address: '192.168.1.20:5051', code: '123456', pin: PIN })
  })

  it('reads the text from before the pin existed, which has none', () => {
    expect(parsePairingText('winglog-pair://192.168.1.20:5051/123456')).toEqual({
      address: '192.168.1.20:5051',
      code: '123456',
      pin: null
    })
  })

  it('reads a pin however the parts were separated', () => {
    expect(parsePairingText(`192.168.1.20:5051 123456 ${PIN}`)).toEqual({
      address: '192.168.1.20:5051',
      code: '123456',
      pin: PIN
    })
    expect(parsePairingText(`192.168.1.20:5051, 123456, ${PIN}`)?.pin).toBe(PIN)
  })

  it('refuses the whole text when its pin is the wrong length or has other characters, rather than pairing without one', () => {
    for (const bad of [PIN.slice(1), `${PIN}a`, `${PIN.slice(1)}=`, `${PIN.slice(1)}!`]) {
      expect(parsePairingText(`winglog-pair://192.168.1.20:5051/123456/${bad}`), bad).toBeNull()
    }
  })

  it('refuses a public address even with a good pin', () => {
    expect(parsePairingText(`winglog-pair://8.8.8.8:5051/123456/${PIN}`)).toBeNull()
  })

  it('reads an address with the code after it, however it was separated', () => {
    expect(parsePairingText('192.168.1.20:5051 123456')).toEqual({
      address: '192.168.1.20:5051',
      code: '123456',
      pin: null
    })
    expect(parsePairingText('192.168.1.20:5051, 123456')).toEqual({
      address: '192.168.1.20:5051',
      code: '123456',
      pin: null
    })
    expect(parsePairingText('http://192.168.1.20:5051/ 123456')).toEqual({
      address: '192.168.1.20:5051',
      code: '123456',
      pin: null
    })
  })

  it('reads a plain address with no code', () => {
    expect(parsePairingText('192.168.1.20:5051')).toEqual({
      address: '192.168.1.20:5051',
      code: null,
      pin: null
    })
    expect(parsePairingText('  http://simpc.local:5051/  ')).toEqual({
      address: 'simpc.local:5051',
      code: null,
      pin: null
    })
  })

  it('refuses text with no home-network address, even with a code', () => {
    expect(parsePairingText('')).toBeNull()
    expect(parsePairingText('hello')).toBeNull()
    expect(parsePairingText('winglog-pair://8.8.8.8:5051/123456')).toBeNull()
    expect(parsePairingText('example.com:5051 123456')).toBeNull()
  })
})

describe('isHomeNetworkAddress (audit L8)', () => {
  it.each([
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.10.10',
    '127.0.0.1',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fe80::1',
    'febf::1',
    'fc00::1',
    'fd12:3456:789a::5',
    '::ffff:192.168.1.5',
    '::ffff:c0a8:0105',
    '::ffff:127.0.0.1'
  ])('accepts %s', (address) => {
    expect(isHomeNetworkAddress(address)).toBe(true)
  })

  it.each([
    '8.8.8.8',
    '172.32.0.1',
    '192.169.1.1',
    '256.1.1.1',
    '2606:4700::1111',
    '2001:db8::1',
    'fec0::1',
    'fb00::1',
    '::',
    '::2',
    '::ffff:8.8.8.8',
    '::ffff:0808:0808',
    '1::2::3',
    'fe80::g',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7',
    '::ffff:300.1.1.1',
    'simpc',
    'simpc.local',
    ''
  ])('refuses %s', (address) => {
    expect(isHomeNetworkAddress(address)).toBe(false)
  })
})
