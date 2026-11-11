import { describe, expect, it } from 'vitest'
import { formatPairingText, isHomeNetworkAddress, parseHostAddress, parsePairingText } from './host-address'

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

describe('the pairing text', () => {
  it('is the address and the code in one line, and reads back', () => {
    const text = formatPairingText('192.168.1.20:5051', '123456')
    expect(text).toBe('winglog-pair://192.168.1.20:5051/123456')
    expect(parsePairingText(text)).toEqual({ address: '192.168.1.20:5051', code: '123456' })
  })

  it('reads an address with the code after it, however it was separated', () => {
    expect(parsePairingText('192.168.1.20:5051 123456')).toEqual({
      address: '192.168.1.20:5051',
      code: '123456'
    })
    expect(parsePairingText('192.168.1.20:5051, 123456')).toEqual({
      address: '192.168.1.20:5051',
      code: '123456'
    })
    expect(parsePairingText('http://192.168.1.20:5051/ 123456')).toEqual({
      address: '192.168.1.20:5051',
      code: '123456'
    })
  })

  it('reads a plain address with no code', () => {
    expect(parsePairingText('192.168.1.20:5051')).toEqual({ address: '192.168.1.20:5051', code: null })
    expect(parsePairingText('  http://simpc.local:5051/  ')).toEqual({
      address: 'simpc.local:5051',
      code: null
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
