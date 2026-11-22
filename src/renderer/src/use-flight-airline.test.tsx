import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { LiveTopic, LiveTopics, PlannedRoute } from '@shared/live'
import { emptyProcedureSelection } from '@shared/procedure-selection'
import { LiveClientContext, type LiveClient } from './live/LiveClient'
import { useFlightAirlineIata } from './use-flight-airline'

/** This computer's own ids: the flight is 3 here (the sim PC numbers it 445). */
const LOCAL_FLIGHT_ID = 3

function routeFor(flightId: number): PlannedRoute {
  return { flightId, revision: 1, selection: emptyProcedureSelection(), waypoints: [] }
}

function clientWith(route: PlannedRoute | null): LiveClient {
  return {
    get: <T extends LiveTopic>(topic: T) =>
      Promise.resolve(topic === 'plannedRoute' ? (route as LiveTopics[T]) : undefined),
    subscribe: () => () => undefined,
    command: () => Promise.resolve()
  }
}

async function mount(route: PlannedRoute | null) {
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <LiveClientContext.Provider value={clientWith(route)}>{children}</LiveClientContext.Provider>
  )
  const view = renderHook(() => useFlightAirlineIata(), { wrapper })
  await act(async () => {})
  return view.result
}

// The contract of the hook: it finds the airline of the flight its route names, by the id the route carries, which must be this computer's.
// A twin's route gets that id in the main process (flight-mirror.test.ts); this does not show that.
describe('useFlightAirlineIata', () => {
  beforeEach(() => {
    window.winglog = {
      flightList: vi.fn().mockResolvedValue([{ id: LOCAL_FLIGHT_ID, aircraftId: 9 }]),
      aircraftList: vi.fn().mockResolvedValue([{ id: 9, operatorIata: 'SQ' }])
    } as unknown as typeof window.winglog
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('finds the airline of the flight whose id the route carries', async () => {
    expect((await mount(routeFor(LOCAL_FLIGHT_ID))).current).toBe('SQ')
  })

  it('shows no logo for a route whose id is no flight on this computer', async () => {
    expect((await mount(routeFor(445))).current).toBeNull()
  })

  it('shows no logo when there is no route', async () => {
    expect((await mount(null)).current).toBeNull()
  })
})
