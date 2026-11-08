import { describe, expect, it } from 'vitest'
import { backgroundOffer, startsHidden } from './background'

const host = { runMode: 'host', multiDevice: true } as const

describe('running in the background', () => {
  it('is offered to the sim PC’s host in a multi-device build that has a tray', () => {
    expect(
      backgroundOffer({ capabilities: host, trayAvailable: true, isPackaged: false, platform: 'win32' })
    ).toEqual({ available: true, loginItemAvailable: false })
  })

  it('offers start-with-Windows only to an installed copy on Windows', () => {
    expect(
      backgroundOffer({ capabilities: host, trayAvailable: true, isPackaged: true, platform: 'win32' })
        .loginItemAvailable
    ).toBe(true)
    expect(
      backgroundOffer({ capabilities: host, trayAvailable: true, isPackaged: true, platform: 'darwin' })
        .loginItemAvailable
    ).toBe(false)
  })

  it('is not offered to a client, in a release build, or with no tray to get the window back from', () => {
    const base = { trayAvailable: true, isPackaged: true, platform: 'win32' }
    expect(
      backgroundOffer({ ...base, capabilities: { runMode: 'client', multiDevice: true } }).available
    ).toBe(false)
    expect(
      backgroundOffer({ ...base, capabilities: { runMode: 'host', multiDevice: false } }).available
    ).toBe(false)
    expect(backgroundOffer({ ...base, capabilities: host, trayAvailable: false })).toEqual({
      available: false,
      loginItemAvailable: false
    })
  })

  it('leaves the window hidden at start only when it is chosen and offered', () => {
    expect(startsHidden({ available: true, loginItemAvailable: false }, true)).toBe(true)
    expect(startsHidden({ available: true, loginItemAvailable: false }, false)).toBe(false)
    expect(startsHidden({ available: false, loginItemAvailable: false }, true)).toBe(false)
  })
})
