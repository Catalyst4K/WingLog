/**
 * The live ATIS for the weather panel's tabs, asked for with the METARs and again when Refresh is pressed (winglog-backend
 * docs/plans/online-atis-weather.md). Main decides which ATIS each tab gets and whether anything is shown at all (no network chosen,
 * or IVAO without a VID, shows nothing); the panel only draws what comes back.
 */
import { useEffect, useState } from 'react'
import type { AirportAtis, AtisAnswer, AtisRequest, AtisSlot } from '@shared/ipc'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'

/** The airport each tab shows, or null when it has none (or not yet a whole code). */
export type WeatherSlots = Record<AtisSlot, string | null>

const SLOTS: AtisSlot[] = ['departure', 'destination', 'alternate', 'custom']

/**
 * @param codes The airport of each tab.
 * @returns A request for each tab that has a whole four-letter code.
 */
function requestsFor(codes: WeatherSlots): AtisRequest[] {
  return SLOTS.flatMap((slot) => {
    const icao = codes[slot]?.trim().toUpperCase() ?? ''
    return icao.length === 4 ? [{ icao, slot }] : []
  })
}

/**
 * @param codes The airport of each tab.
 * @param refreshKey Changes when the pilot presses Refresh.
 * @returns The latest answer, or null before the first. The tab's own answer comes from `atisFor`.
 */
export function useWeatherAtis(codes: WeatherSlots, refreshKey: number): AtisAnswer | null {
  const [answer, setAnswer] = useState<AtisAnswer | null>(null)
  const { departure, destination, alternate, custom } = codes
  useEffect(() => {
    const requests = requestsFor({ departure, destination, alternate, custom })
    if (requests.length === 0) return
    let cancelled = false
    // Deferred a tick, like the METAR fetch beside it, so the state update runs in a timer callback.
    const timer = setTimeout(() => {
      runAsync(
        'MetarPanel onlineAtisGet',
        // Inside a promise so a screen without the lookup reports it instead of throwing.
        Promise.resolve()
          .then(() => winglogApi().onlineAtisGet(requests))
          .then((next) => {
            if (!cancelled) setAnswer(next)
          })
      )
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [departure, destination, alternate, custom, refreshKey])
  return answer
}

/**
 * @param answer The latest answer.
 * @param slot A tab.
 * @param icao The airport the tab shows now.
 * @returns The tab's answer, only when it is for the airport the tab shows now (an answer for an airport just changed is not shown).
 */
export function atisFor(
  answer: AtisAnswer | null,
  slot: AtisSlot,
  icao: string | null
): AirportAtis | undefined {
  const code = icao?.trim().toUpperCase()
  return answer?.airports.find((airport) => airport.slot === slot && airport.icao === code)
}
