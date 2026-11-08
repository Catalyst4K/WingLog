import { describe, expect, it } from 'vitest'
import { parseHostAddress } from './host-address'

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
