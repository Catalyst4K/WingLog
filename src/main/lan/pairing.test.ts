import { describe, expect, it } from 'vitest'
import {
  cleanDeviceName,
  hashToken,
  MAX_WRONG_CODES,
  newDeviceToken,
  PAIRING_WINDOW_MS,
  PairingWindow
} from './pairing'

describe('PairingWindow', () => {
  it('shows a six-digit code, with leading zeros kept', () => {
    for (let i = 0; i < 50; i++) expect(new PairingWindow(0).shownCode).toMatch(/^\d{6}$/)
    expect(new PairingWindow(0, '004217').shownCode).toBe('004217')
  })

  it('pairs on the right code, once', () => {
    const window = new PairingWindow(1000, '123456')
    expect(window.attempt('123456', 2000)).toBe('paired')
    expect(window.attempt('123456', 3000)).toBe('closed')
  })

  it('counts a wrong code and still accepts the right one after it', () => {
    const window = new PairingWindow(0, '123456')
    expect(window.attempt('654321', 10)).toBe('wrong')
    expect(window.attempt('123456', 20)).toBe('paired')
  })

  it('closes after five wrong codes, even for the right one', () => {
    const window = new PairingWindow(0, '123456')
    for (let i = 0; i < MAX_WRONG_CODES; i++) expect(window.attempt('000000', i)).toBe('wrong')
    expect(window.isOpen(10)).toBe(false)
    expect(window.attempt('123456', 10)).toBe('closed')
  })

  it('closes after five minutes', () => {
    const window = new PairingWindow(0, '123456')
    expect(window.isOpen(PAIRING_WINDOW_MS - 1)).toBe(true)
    expect(window.attempt('123456', PAIRING_WINDOW_MS)).toBe('closed')
  })

  it('treats anything but a matching string as a wrong code', () => {
    for (const value of [123456, null, undefined, {}, ['123456'], '12345', '1234567', ''])
      expect(new PairingWindow(0, '123456').attempt(value, 1)).toBe('wrong')
  })
})

describe('device tokens', () => {
  it('are 32 random bytes as base64url and never repeat', () => {
    const a = newDeviceToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newDeviceToken()).not.toBe(a)
  })

  it('hash to a stable SHA-256 hex that is not the token', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abd')).not.toBe(hashToken('abc'))
  })
})

describe('cleanDeviceName', () => {
  it('keeps a normal name, trimmed', () => {
    expect(cleanDeviceName("  Callum's iPad ")).toBe("Callum's iPad")
  })

  it('removes control characters and cuts to 40 characters', () => {
    expect(cleanDeviceName('Pad\n\u0007one')).toBe('Padone')
    expect(cleanDeviceName('x'.repeat(100))).toHaveLength(40)
  })

  it('falls back to "Device" for nothing usable', () => {
    for (const value of [undefined, null, 5, {}, '', '   ', '\n\t'])
      expect(cleanDeviceName(value)).toBe('Device')
  })
})
