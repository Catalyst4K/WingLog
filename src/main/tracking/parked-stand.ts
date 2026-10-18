/**
 * Records the stand a flight finished at, from the arrival airport's stands and the final position.
 */
import type { NavdataStand } from '@shared/ipc'
import { nearestStand } from '@shared/stands'

export interface ParkedStandDeps {
  getArrivalIcao: (flightId: number) => string | null
  getStands: (icao: string) => Promise<NavdataStand[]>
  setParkedStand: (flightId: number, icao: string, stand: string) => void
}

/**
 * Records which stand a just-completed flight finished at (winglog-backend's
 * docs/plans/stand-positions.md): the arrival airport's stand nearest the aircraft's final
 * position, if one is within reach. Best effort — no stand data (sim gone, a free flight with
 * no arrival airport) just records nothing. Returns the stand recorded, or null.
 *
 * @param deps The arrival airport, its stands, and where to record the result.
 * @param flightId The flight just completed.
 * @param position The aircraft's final position, or null.
 * @returns The stand recorded, or null.
 */
export async function recordParkedStand(
  deps: ParkedStandDeps,
  flightId: number,
  position: { lat: number; lon: number } | null
): Promise<string | null> {
  const icao = deps.getArrivalIcao(flightId)
  if (!icao || !position || icao === 'ZZZZ') return null
  const stand = nearestStand(await deps.getStands(icao), position)
  if (!stand) return null
  deps.setParkedStand(flightId, icao, stand.name)
  return stand.name
}
