import { describe, expect, it, vi } from 'vitest'
import type { BeyondAtcAtis, BeyondAtcConnectionStatus } from '@shared/ipc'
import { readBeyondAtcAtis } from './read-beyondatc-atis'

const EGLL: BeyondAtcAtis = {
  icao: 'EGLL',
  code: 'R',
  text: 'EGLL ATIS R',
  arrivalRunways: [],
  departureRunways: []
}

function session(state: BeyondAtcConnectionStatus['state'], atis: BeyondAtcAtis[] | null) {
  return {
    getStatus: () => ({ state, lastError: null }) as BeyondAtcConnectionStatus,
    readAtis: vi.fn(() => Promise.resolve(atis))
  }
}

describe('readBeyondAtcAtis', () => {
  it('reads fresh from a connected BeyondATC', async () => {
    const connected = session('connected', [EGLL])
    expect(await readBeyondAtcAtis(connected, false)).toEqual({ state: 'shown', airports: [EGLL] })
    expect(connected.readAtis).toHaveBeenCalledTimes(1)
  })

  it('is off, and asks nothing, with no session, while not connected, or while hidden', async () => {
    const off = { state: 'off', airports: [] }
    expect(await readBeyondAtcAtis(undefined, false)).toEqual(off)
    for (const state of ['disconnected', 'connecting'] as const) {
      const notConnected = session(state, [EGLL])
      expect(await readBeyondAtcAtis(notConnected, false)).toEqual(off)
      expect(notConnected.readAtis).not.toHaveBeenCalled()
    }
    const hidden = session('connected', [EGLL])
    expect(await readBeyondAtcAtis(hidden, true)).toEqual(off)
    expect(hidden.readAtis).not.toHaveBeenCalled()
  })

  it('is unavailable when a connected BeyondATC does not answer', async () => {
    expect(await readBeyondAtcAtis(session('connected', null), false)).toEqual({
      state: 'unavailable',
      airports: []
    })
  })
})
