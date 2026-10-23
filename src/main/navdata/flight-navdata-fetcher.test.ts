import { describe, expect, it, vi } from 'vitest'
import { FlightNavdataFetcher, type ShownFlight } from './flight-navdata-fetcher'

const PLAN_WITH_ALTERNATE = JSON.stringify({ alternate: { icao_code: 'VMMC' } })

function flight(overrides: Partial<ShownFlight> = {}): ShownFlight {
  return { flightId: 1, depIcao: 'ZJSY', arrIcao: 'VHHH', ofpJson: null, ...overrides }
}

/** A fetcher on a fake provider and a flight and sim status the test can change. */
function setup(initial: ShownFlight | undefined = flight()) {
  const calls: string[] = []
  const state = { flight: initial as ShownFlight | undefined, connected: true, failing: new Set<string>() }
  const provider = {
    refreshAirport: vi.fn((icao: string) => {
      calls.push(`airport ${icao}`)
      return state.failing.has(`airport ${icao}`) ? Promise.reject(new AggregateError([])) : Promise.resolve()
    }),
    refreshTaxiNetwork: vi.fn((icao: string) => {
      calls.push(`taxi ${icao}`)
      return state.failing.has(`taxi ${icao}`) ? Promise.reject(new AggregateError([])) : Promise.resolve()
    })
  }
  let clock = 0
  const fetcher = new FlightNavdataFetcher({
    provider,
    shownFlight: () => state.flight,
    simConnected: () => state.connected,
    now: () => (clock += 700)
  })
  return { fetcher, calls, state, provider }
}

describe('FlightNavdataFetcher', () => {
  it("fetches the shown flight's airports, the arrival's runways and procedures first", async () => {
    const { fetcher, calls } = setup()
    fetcher.refresh()
    await fetcher.idle()
    expect(calls).toEqual(['airport VHHH', 'airport ZJSY', 'taxi VHHH', 'taxi ZJSY'])
  })

  it("includes the plan's alternate", async () => {
    const { fetcher, calls } = setup(flight({ ofpJson: PLAN_WITH_ALTERNATE }))
    fetcher.refresh()
    await fetcher.idle()
    expect(calls).toContain('airport VMMC')
    expect(calls).toContain('taxi VMMC')
  })

  it('skips the placeholder a free flight carries and a plan it cannot read', async () => {
    const { fetcher, calls } = setup(flight({ arrIcao: 'ZZZZ', ofpJson: 'not json' }))
    fetcher.refresh()
    await fetcher.idle()
    expect(calls).toEqual(['airport ZJSY', 'taxi ZJSY'])
  })

  it('does not fetch a second time once it has worked', async () => {
    const { fetcher, calls } = setup()
    fetcher.refresh()
    await fetcher.idle()
    fetcher.refresh()
    fetcher.refresh()
    await fetcher.idle()
    expect(calls).toHaveLength(4)
  })

  it('does not queue what is already waiting', async () => {
    const { fetcher, calls } = setup()
    fetcher.refresh()
    fetcher.refresh()
    await fetcher.idle()
    expect(calls).toHaveLength(4)
  })

  it('fetches for a different flight', async () => {
    const { fetcher, calls, state } = setup()
    fetcher.refresh()
    await fetcher.idle()
    state.flight = flight({ flightId: 2, depIcao: 'EGLL', arrIcao: 'WMKK' })
    fetcher.refresh()
    await fetcher.idle()
    expect(calls.slice(4)).toEqual(['airport WMKK', 'airport EGLL', 'taxi WMKK', 'taxi EGLL'])
  })

  it('does nothing without a flight, or while the sim is not connected', async () => {
    const { fetcher, calls, state } = setup(undefined)
    fetcher.refresh()
    state.flight = flight()
    state.connected = false
    fetcher.refresh()
    await fetcher.idle()
    expect(calls).toEqual([])
  })

  it('fetches when the sim connects after the flight was planned', async () => {
    const { fetcher, calls, state } = setup()
    state.connected = false
    fetcher.refresh()
    await fetcher.idle()
    expect(calls).toEqual([])
    state.connected = true
    fetcher.refresh()
    await fetcher.idle()
    expect(calls).toHaveLength(4)
  })

  it('tries a failed fetch again on the next trigger, and not the ones that worked', async () => {
    const { fetcher, calls, state } = setup()
    state.failing.add('taxi VHHH')
    fetcher.refresh()
    await fetcher.idle()
    expect(calls).toEqual(['airport VHHH', 'airport ZJSY', 'taxi VHHH', 'taxi ZJSY'])
    state.failing.clear()
    fetcher.refresh()
    await fetcher.idle()
    expect(calls.slice(4)).toEqual(['taxi VHHH'])
  })

  it('goes on to the next airport after one fails', async () => {
    const { fetcher, calls, state } = setup()
    state.failing.add('airport VHHH')
    fetcher.refresh()
    await fetcher.idle()
    expect(calls).toContain('airport ZJSY')
    expect(calls).toContain('taxi VHHH')
  })

  it('does one fetch at a time', async () => {
    let running = 0
    let most = 0
    const slow = (): Promise<void> => {
      running += 1
      most = Math.max(most, running)
      return new Promise((resolve) =>
        setTimeout(() => {
          running -= 1
          resolve()
        }, 5)
      )
    }
    const fetcher = new FlightNavdataFetcher({
      provider: { refreshAirport: slow, refreshTaxiNetwork: slow },
      shownFlight: () => flight(),
      simConnected: () => true,
      now: () => 0
    })
    fetcher.refresh()
    await fetcher.idle()
    expect(most).toBe(1)
  })

  it('drops what is waiting when the flight has moved on, or the sim has gone', async () => {
    const { fetcher, calls, state, provider } = setup()
    // The flight changes while the first fetch is running, before the rest get their turn.
    provider.refreshAirport.mockImplementationOnce((icao: string) => {
      calls.push(`airport ${icao}`)
      state.flight = flight({ flightId: 2, depIcao: 'EGLL', arrIcao: 'WMKK' })
      return Promise.resolve()
    })
    fetcher.refresh()
    await fetcher.idle()
    expect(calls).toEqual(['airport VHHH'])
    state.connected = false
    fetcher.refresh()
    await fetcher.idle()
    expect(calls).toEqual(['airport VHHH'])
  })
})
