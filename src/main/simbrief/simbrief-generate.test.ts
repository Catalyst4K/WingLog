import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DispatchOpenSimBriefParams } from '../../shared/ipc'
import { dispatchOptionsToUrlParams, type DispatchOptions } from '@shared/dispatch-options'

const { fromPartition, cookiesGet, clearStorageData, signSimbriefRequest, executeJavaScript, FakeBrowserWindow } =
  vi.hoisted(() => {
    // A minimal hand-rolled emitter rather than importing node:events — vi.hoisted's
    // factory runs before this file's own imports are initialized, so it can only use
    // what it defines itself.
    class MiniEmitter {
      private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
      on(event: string, handler: (...args: unknown[]) => void): this {
        const existing = this.listeners.get(event) ?? []
        existing.push(handler)
        this.listeners.set(event, existing)
        return this
      }
      emit(event: string, ...args: unknown[]): void {
        for (const handler of this.listeners.get(event) ?? []) handler(...args)
      }
    }

    // Shared across every instance's webContents, so a test can preset the next
    // executeJavaScript resolution before the code under test creates the window that
    // will call it (e.g. fetchSimbriefPilotId's window, created deep inside
    // createCustomAirframeFromShare's navigation handler).
    const executeJavaScriptMock = vi.fn()
    class FakeWebContents extends MiniEmitter {
      executeJavaScript = executeJavaScriptMock
    }
    class FakeBrowserWindowImpl extends MiniEmitter {
      static instances: FakeBrowserWindowImpl[] = []
      webContents = new FakeWebContents()
      loadURL = vi.fn()
      close = vi.fn(() => this.emit('closed'))
      destroy = vi.fn()
      options: unknown
      constructor(options: unknown) {
        super()
        this.options = options
        FakeBrowserWindowImpl.instances.push(this)
      }
    }
    return {
      fromPartition: vi.fn(),
      cookiesGet: vi.fn(),
      clearStorageData: vi.fn(),
      signSimbriefRequest: vi.fn(),
      executeJavaScript: executeJavaScriptMock,
      FakeBrowserWindow: FakeBrowserWindowImpl
    }
  })

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  session: { fromPartition }
}))

vi.mock('../backend/backend-client', () => ({ signSimbriefRequest }))

import {
  buildGenerateUrl,
  createCustomAirframeFromShare,
  extractSavedAirframeId,
  fetchSimbriefPilotId,
  fetchSimbriefUsername,
  GENERATE_PARTITION,
  generateOfp,
  isSimbriefLoggedIn,
  loginToSimbrief,
  logoutOfSimbrief
} from './simbrief-generate'

function lastWindow(): InstanceType<typeof FakeBrowserWindow> {
  const instances = FakeBrowserWindow.instances
  return instances[instances.length - 1]
}

const BASE: DispatchOpenSimBriefParams = {
  origIcao: 'EGLL',
  destIcao: 'WSSS',
  icaoType: 'A388',
  simbriefAirframeId: null
}

describe('GENERATE_PARTITION', () => {
  it('is a persisted partition, so the SimBrief popup session survives an app restart', () => {
    // flight-test-findings-2026-09-06.md #10 — a regression here would be silent
    // otherwise (nothing else breaks, SimBrief just quietly stops persisting logins).
    expect(GENERATE_PARTITION.startsWith('persist:')).toBe(true)
  })
})

describe('buildGenerateUrl', () => {
  it('builds a minimal URL against the keyed worker endpoint', () => {
    const url = new URL(buildGenerateUrl(BASE, 'abc123', 1788307200))
    expect(url.origin + url.pathname).toBe('https://www.simbrief.com/ofp/ofp.loader.api.php')
    expect(url.searchParams.get('orig')).toBe('EGLL')
    expect(url.searchParams.get('dest')).toBe('WSSS')
    expect(url.searchParams.get('type')).toBe('A388')
    expect(url.searchParams.get('apicode')).toBe('abc123')
    expect(url.searchParams.get('timestamp')).toBe('1788307200')
    expect(url.searchParams.get('outputpage')).toBe('winglog.local/generate')
  })

  it('prefers a saved airframe ID over simbriefType and icaoType for `type`', () => {
    const url = new URL(
      buildGenerateUrl({ ...BASE, simbriefAirframeId: '123456_1582090020', simbriefType: 'A20N' }, 'abc123', 1788307200)
    )
    expect(url.searchParams.get('type')).toBe('123456_1582090020')
  })

  it('prefers simbriefType over the bare icaoType when there is no saved airframe', () => {
    const url = new URL(buildGenerateUrl({ ...BASE, simbriefType: 'A20N' }, 'abc123', 1788307200))
    expect(url.searchParams.get('type')).toBe('A20N')
  })

  it('appends airline/fltnum/date/deph/depm only when present', () => {
    const withExtras: DispatchOpenSimBriefParams = {
      ...BASE,
      airlineIcao: 'BAW',
      flightNumber: '002',
      departure: { dateEpochSeconds: 1788307200, hour: 18, minute: 25 }
    }
    const url = new URL(buildGenerateUrl(withExtras, 'abc123', 1788307200))
    expect(url.searchParams.get('airline')).toBe('BAW')
    expect(url.searchParams.get('fltnum')).toBe('002')
    expect(url.searchParams.get('date')).toBe('1788307200')
    expect(url.searchParams.get('deph')).toBe('18')
    expect(url.searchParams.get('depm')).toBe('25')

    const withoutExtras = new URL(buildGenerateUrl(BASE, 'abc123', 1788307200))
    expect(withoutExtras.searchParams.has('airline')).toBe(false)
    expect(withoutExtras.searchParams.has('fltnum')).toBe(false)
    expect(withoutExtras.searchParams.has('date')).toBe(false)
  })

  it('passes through advanced dispatch-options extras', () => {
    const url = new URL(buildGenerateUrl({ ...BASE, extra: [['units', 'KGS'], ['contpct', '0.03']] }, 'abc123', 1788307200))
    expect(url.searchParams.get('units')).toBe('KGS')
    expect(url.searchParams.get('contpct')).toBe('0.03')
  })

  // Every field the Advanced tab can set (src/renderer/src/dispatch-options.ts), fed
  // through its own real dispatchOptionsToUrlParams — not a hand-picked subset — to catch
  // a field silently dropped or renamed between the advanced dialog and the keyed
  // generation URL, which the smaller spot-check above wouldn't necessarily surface.
  it('round-trips every real Advanced-tab field into the generation URL', () => {
    const filledOptions: DispatchOptions = {
      pax: 'auto',
      cargo: '2000',
      manualzfw: '65000',
      manualpayload: '18000',
      fuelfactor: '1.02',
      addedfuel: '500',
      contpct: '0.03',
      resvrule: '45',
      taxiout: '15',
      taxiin: '10',
      tankering: '0',
      civalue: '85',
      cruisemode: 'LRC',
      cruisesub: 'auto',
      fl: '370',
      climb: '250/300/.78',
      descent: '.78/300/250',
      route: 'DCT',
      origrwy: '27L',
      destrwy: '02C'
    }
    const extra = dispatchOptionsToUrlParams(filledOptions)
    // Sanity check on the fixture itself — every field above is set, so this should be a
    // 1:1 mapping with no accidental omissions before it's even fed through the URL builder.
    expect(extra).toHaveLength(Object.keys(filledOptions).length)

    const url = new URL(buildGenerateUrl({ ...BASE, extra }, 'abc123', 1788307200))
    for (const [field, value] of extra) {
      expect(url.searchParams.get(field), `field "${field}"`).toBe(value)
    }
  })
})

describe('extractSavedAirframeId', () => {
  // Real URL a spike watched a WingLog-owned BrowserWindow navigate to right after a
  // real "Save Airframe" click (docs/plans/simbrief-airframe-picker.md, 2026-09-07).
  it('extracts the airframe id from a real post-save navigation', () => {
    expect(extractSavedAirframeId('https://dispatch.simbrief.com/airframes/saved/1788802707601')).toBe(
      '1788802707601'
    )
  })

  // Every other navigation the share → login → save flow actually passes through, per
  // the same live spike — none of these should be mistaken for the save itself.
  it('returns null for every other navigation the share/login flow passes through', () => {
    expect(extractSavedAirframeId('https://dispatch.simbrief.com/airframes/share/80_1709125568637')).toBeNull()
    expect(extractSavedAirframeId('https://identity.api.navigraph.com/login?signin=abc123')).toBeNull()
    expect(
      extractSavedAirframeId('https://appleid.apple.com/auth/authorize?client_id=com.navigraph.identity-service')
    ).toBeNull()
    expect(extractSavedAirframeId('https://dispatch.simbrief.com/airframes')).toBeNull()
  })
})

describe('functions backed by a real BrowserWindow/session', () => {
  beforeEach(() => {
    FakeBrowserWindow.instances.length = 0
    cookiesGet.mockReset().mockResolvedValue([])
    clearStorageData.mockReset().mockResolvedValue(undefined)
    fromPartition.mockReset().mockReturnValue({ cookies: { get: cookiesGet }, clearStorageData })
    signSimbriefRequest.mockReset()
    executeJavaScript.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('loginToSimbrief', () => {
    it('opens the SimBrief home page in the persisted partition and resolves once closed', async () => {
      const promise = loginToSimbrief()
      const win = lastWindow()
      expect(win.options).toMatchObject({ webPreferences: { partition: GENERATE_PARTITION } })
      expect(win.loadURL).toHaveBeenCalledWith('https://www.simbrief.com/')
      win.close()
      await expect(promise).resolves.toBeUndefined()
    })
  })

  describe('isSimbriefLoggedIn', () => {
    it('is true when the SSO cookie is present', async () => {
      cookiesGet.mockResolvedValue([{ name: 'simbrief_sso', value: 'x' }])
      expect(await isSimbriefLoggedIn()).toBe(true)
      expect(fromPartition).toHaveBeenCalledWith(GENERATE_PARTITION)
      expect(cookiesGet).toHaveBeenCalledWith({ name: 'simbrief_sso', domain: 'simbrief.com' })
    })

    it('is false when the SSO cookie is absent', async () => {
      cookiesGet.mockResolvedValue([])
      expect(await isSimbriefLoggedIn()).toBe(false)
    })
  })

  describe('logoutOfSimbrief', () => {
    it('clears every stored cookie/storage item in the persisted partition', async () => {
      await logoutOfSimbrief()
      expect(fromPartition).toHaveBeenCalledWith(GENERATE_PARTITION)
      expect(clearStorageData).toHaveBeenCalled()
    })
  })

  describe('fetchSimbriefUsername / fetchSimbriefPilotId', () => {
    it('returns the value read off the account page', async () => {
      executeJavaScript.mockResolvedValueOnce('LandingHangar711')
      const result = await fetchSimbriefUsername()
      expect(result).toBe('LandingHangar711')
      const win = lastWindow()
      expect(win.loadURL).toHaveBeenCalledWith('https://www.simbrief.com/system/profile.php')
      expect(win.destroy).toHaveBeenCalled()
      expect(executeJavaScript.mock.calls[0][0]).toContain('user.navigraph.username')
    })

    it('fetches the pilot id using its own data-key', async () => {
      executeJavaScript.mockResolvedValueOnce('700123')
      expect(await fetchSimbriefPilotId()).toBe('700123')
      expect(executeJavaScript.mock.calls[0][0]).toContain('user.pilot_id')
    })

    it('returns null (and still destroys the window) when the field never populates', async () => {
      executeJavaScript.mockResolvedValueOnce(null)
      expect(await fetchSimbriefUsername()).toBeNull()
      expect(lastWindow().destroy).toHaveBeenCalled()
    })

    it('returns null (and still destroys the window) when reading the page throws', async () => {
      executeJavaScript.mockRejectedValueOnce(new Error('page not ready'))
      await expect(fetchSimbriefUsername()).resolves.toBeNull()
      expect(lastWindow().destroy).toHaveBeenCalled()
    })
  })

  describe('generateOfp', () => {
    it('signs the request, then opens the keyed generation URL and resolves once closed', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-11T12:00:00.000Z'))
      signSimbriefRequest.mockResolvedValue('signed-code')

      const promise = generateOfp(BASE)
      await vi.waitFor(() => expect(signSimbriefRequest).toHaveBeenCalled())

      expect(signSimbriefRequest).toHaveBeenCalledWith({
        origIcao: 'EGLL',
        destIcao: 'WSSS',
        type: 'A388',
        timestamp: Math.floor(new Date('2026-09-11T12:00:00.000Z').getTime() / 1000),
        outputPage: 'winglog.local/generate'
      })

      const win = lastWindow()
      const expectedUrl = buildGenerateUrl(BASE, 'signed-code', Math.floor(Date.now() / 1000))
      expect(win.loadURL).toHaveBeenCalledWith(expectedUrl)

      win.close()
      await expect(promise).resolves.toBeUndefined()
    })
  })

  describe('createCustomAirframeFromShare', () => {
    const SHARE_URL = 'https://dispatch.simbrief.com/airframes/share/80_1709125568637'

    it('resolves null when the window is closed before any save navigation', async () => {
      const promise = createCustomAirframeFromShare(SHARE_URL)
      const win = lastWindow()
      expect(win.loadURL).toHaveBeenCalledWith(SHARE_URL)
      win.close()
      await expect(promise).resolves.toBeNull()
    })

    it('ignores navigations that are not the post-save redirect', async () => {
      const promise = createCustomAirframeFromShare(SHARE_URL)
      const win = lastWindow()
      win.webContents.emit('did-navigate', {}, 'https://identity.api.navigraph.com/login?signin=abc123')
      // Still open, still only the one window — the ignored navigation didn't settle it.
      expect(FakeBrowserWindow.instances).toHaveLength(1)
      win.close()
      await expect(promise).resolves.toBeNull()
    })

    it('resolves pilotId_airframeId once the save navigation is observed', async () => {
      executeJavaScript.mockResolvedValueOnce('700123')
      const promise = createCustomAirframeFromShare(SHARE_URL)
      const shareWin = lastWindow()

      shareWin.webContents.emit('did-navigate', {}, 'https://dispatch.simbrief.com/airframes/saved/999')

      await expect(promise).resolves.toBe('700123_999')
      expect(FakeBrowserWindow.instances).toHaveLength(2)
      expect(shareWin.close).toHaveBeenCalled()
    })

    it('also resolves on an in-page save navigation, and returns null if no pilot id is found', async () => {
      executeJavaScript.mockResolvedValueOnce(null)
      const promise = createCustomAirframeFromShare(SHARE_URL)
      const shareWin = lastWindow()

      shareWin.webContents.emit('did-navigate-in-page', {}, 'https://dispatch.simbrief.com/airframes/saved/999')

      await expect(promise).resolves.toBeNull()
    })

    it('does not resolve twice if the window closes after the save navigation already settled it', async () => {
      executeJavaScript.mockResolvedValueOnce('700123')
      const promise = createCustomAirframeFromShare(SHARE_URL)
      const shareWin = lastWindow()

      shareWin.webContents.emit('did-navigate', {}, 'https://dispatch.simbrief.com/airframes/saved/999')
      await expect(promise).resolves.toBe('700123_999')

      // A stray 'closed' event after settlement must not throw or change the result.
      expect(() => shareWin.emit('closed')).not.toThrow()
    })
  })
})
