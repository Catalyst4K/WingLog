/** The airline of the flight the app is showing, for the logo beside a headline that has no airline code of its own (BeyondATC's callsign). */

import { useEffect, useState } from 'react'
import { winglogApi } from './data/winglog-api'
import { useLiveTopic } from './live/LiveClient'

/**
 * Looks the planned route's flight up in the logbook and fleet. A flight with no fleet aircraft, a window that cannot ask (the second
 * screen), or a failed lookup simply has no logo: nothing is shown and nothing is reported.
 *
 * @returns The IATA code of the flight's aircraft's airline, or null.
 */
export function useFlightAirlineIata(): string | null {
  const flightId = useLiveTopic('plannedRoute', null)?.flightId ?? null
  const [found, setFound] = useState<{ flightId: number; iata: string | null } | null>(null)
  useEffect(() => {
    if (flightId === null) return
    let current = true
    Promise.resolve()
      .then(() => Promise.all([winglogApi().flightList(), winglogApi().aircraftList()]))
      .then(([flights, fleet]) => {
        if (!current || !Array.isArray(flights) || !Array.isArray(fleet)) return
        const aircraftId = flights.find((f) => f.id === flightId)?.aircraftId
        setFound({ flightId, iata: fleet.find((a) => a.id === aircraftId)?.operatorIata ?? null })
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [flightId])
  return found !== null && found.flightId === flightId ? found.iata : null
}
