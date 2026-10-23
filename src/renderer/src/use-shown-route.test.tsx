import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { ProcedureSelection } from '@shared/ipc'
import type { LiveTopic, LiveTopics, PlannedRoute } from '@shared/live'
import type { Waypoint } from '@shared/route'
import { emptyProcedureSelection } from '@shared/procedure-selection'
import { LiveClientContext, type LiveClient } from './live/LiveClient'
import { useShownRoute } from './use-shown-route'

// A trimmed SimBrief OFP with the field names of a real one, not real flight data.
const OFP = JSON.stringify({
  fetch: { status: 'Success' },
  origin: { icao_code: 'EGLL' },
  destination: { icao_code: 'VHHH' },
  navlog: {
    fix: [
      { ident: 'BPK', altitude_feet: '4000', distance: '5', pos_lat: '51.7', pos_long: '0.1' },
      { ident: 'VHHH', altitude_feet: '0', distance: '20', pos_lat: '22.3', pos_long: '113.9' }
    ]
  }
})
const AIRPORTS = { depIcao: 'EGLL', arrIcao: 'VHHH', altnIcao: null, ofpJson: OFP }
const SELECTION: ProcedureSelection = emptyProcedureSelection()

const wp = (ident: string, lat: number, lon: number): Waypoint => ({ ident, lat, lon }) as Waypoint
const MAIN_ROUTE = (flightId: number): PlannedRoute => ({
  flightId,
  revision: 1,
  selection: SELECTION,
  waypoints: [wp('MAINA', 10, 20), wp('MAINB', 11, 21)]
})

/** A live client holding only the planned route, which a test can push to. */
function fakeClient(initial: PlannedRoute | null): {
  client: LiveClient
  push: (r: PlannedRoute | null) => void
} {
  let current = initial
  const listeners = new Set<(payload: PlannedRoute | null) => void>()
  const client: LiveClient = {
    get: <T extends LiveTopic>(topic: T) =>
      Promise.resolve(topic === 'plannedRoute' ? (current as LiveTopics[T]) : undefined),
    subscribe: (topic, listener) => {
      if (topic !== 'plannedRoute') return () => undefined
      listeners.add(listener as (p: PlannedRoute | null) => void)
      return () => listeners.delete(listener as (p: PlannedRoute | null) => void)
    },
    command: () => Promise.resolve()
  }
  return {
    client,
    push: (route) => {
      current = route
      listeners.forEach((l) => l(route))
    }
  }
}

async function mount(initial: PlannedRoute | null, flightId: number | undefined) {
  const { client, push } = fakeClient(initial)
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <LiveClientContext.Provider value={client}>{children}</LiveClientContext.Provider>
  )
  const { result } = renderHook(
    () => useShownRoute(flightId === undefined ? undefined : { id: flightId }, AIRPORTS, SELECTION),
    { wrapper }
  )
  await act(async () => {})
  return {
    seen: {
      get idents() {
        return result.current.map((w) => w.ident)
      }
    },
    push
  }
}

describe('useShownRoute', () => {
  it("draws the main process's route for a saved flight", async () => {
    const { seen } = await mount(MAIN_ROUTE(7), 7)
    expect(seen.idents).toEqual(['MAINA', 'MAINB'])
  })

  it('assembles its own route until main has sent one for this flight, then switches to it', async () => {
    const { seen, push } = await mount(null, 7)
    expect(seen.idents).toEqual(['BPK', 'VHHH'])
    await act(async () => push(MAIN_ROUTE(7)))
    expect(seen.idents).toEqual(['MAINA', 'MAINB'])
  })

  it("never draws another flight's route", async () => {
    const { seen } = await mount(MAIN_ROUTE(3), 7)
    expect(seen.idents).toEqual(['BPK', 'VHHH'])
  })

  it('assembles the route of a plan that is not a flight yet, whatever main holds', async () => {
    const { seen } = await mount(MAIN_ROUTE(7), undefined)
    expect(seen.idents).toEqual(['BPK', 'VHHH'])
  })

  it('follows each new route main sends, and goes back to its own when main has none', async () => {
    const { seen, push } = await mount(MAIN_ROUTE(7), 7)
    await act(async () => push({ ...MAIN_ROUTE(7), revision: 2, waypoints: [wp('NEWA', 1, 2)] }))
    expect(seen.idents).toEqual(['NEWA'])
    await act(async () => push(null))
    expect(seen.idents).toEqual(['BPK', 'VHHH'])
  })
})
