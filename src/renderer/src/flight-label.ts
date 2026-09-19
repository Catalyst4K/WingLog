import { displayIcao } from './display-icao'

interface LabelledFlight {
  flightNumber: string | null
  depIcao: string
  arrIcao: string
}

/**
 * How a flight is named in prose — dialogs, banners, headings. Never the database id: a
 * pilot has no use for "Flight #204" and it reads like something they should recognise
 * (Callum, 2026-09-19). The flight number/callsign when there is one, otherwise the route
 * when both airports are real, otherwise whichever end is known, otherwise "this flight".
 */
export function flightLabel(flight: LabelledFlight | undefined | null): string {
  if (!flight) return 'this flight'
  const number = flight.flightNumber?.trim()
  if (number) return number
  const dep = flight.depIcao && flight.depIcao !== 'ZZZZ' ? flight.depIcao : null
  const arr = flight.arrIcao && flight.arrIcao !== 'ZZZZ' ? flight.arrIcao : null
  if (dep && arr) return `${displayIcao(dep)} → ${displayIcao(arr)}`
  if (dep) return `flight from ${dep}`
  if (arr) return `flight to ${arr}`
  return 'this flight'
}
