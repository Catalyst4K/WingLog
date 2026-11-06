/** The name of the airport typed into a Dispatch field, shown quietly under it. */

import { useEffect, useState } from 'react'
import { winglogApi } from '../data/winglog-api'

/**
 * Looks the airport up once the code is four letters long.
 *
 * @param icao What is typed in the field.
 * @returns The airport's name, or null while it is not a known airport.
 */
export function useAirportName(icao: string): string | null {
  const [found, setFound] = useState<{ icao: string; name: string } | null>(null)
  const code = icao.trim().toUpperCase()
  useEffect(() => {
    if (code.length !== 4) return
    let cancelled = false
    // Deferred a tick so the update runs in a timer callback, and so typing the fourth letter and the lookup do not race.
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => winglogApi().airportSearch(code))
        .then((options) => {
          if (cancelled) return
          const hit = options.find((o) => o.icao === code)
          setFound(hit ? { icao: code, name: hit.name } : null)
        })
        // A name is a courtesy: a failed lookup leaves the field as it is.
        .catch(() => undefined)
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code])
  return found && found.icao === code ? found.name : null
}
