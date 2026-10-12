/** BeyondATC's frequency list, read for display: runways learned from the tuned station, readable names, and the list grouped by airport and type. */

import type { BeyondAtcFrequencyOption } from './types/beyondatc'

/**
 * A frequency as one comparable string, so "133.9" and "133.900" are the same station.
 *
 * @param frequency A frequency as BeyondATC or the user wrote it.
 * @returns The frequency to three decimals, or the trimmed text when it isn't a number.
 */
export function normaliseFrequency(frequency: string): string {
  const mhz = Number(frequency.trim())
  return Number.isFinite(mhz) && frequency.trim() !== '' ? mhz.toFixed(3) : frequency.trim()
}

/**
 * The runways named in a station's name, which is how BeyondATC reports a tuned station: "Singapore Approach (20R, 20C)" or
 * "Heathrow Ground (09R)". The `Frequencies` list itself carries none (flight 236).
 *
 * @param name A station name from a `Facility` line.
 * @returns The runways as text ("20R, 20C"), or an empty string when the name has none.
 */
export function runwaysFromStationName(name: string): string {
  const match = /\(([^()]*)\)\s*$/.exec(name.trim())
  if (!match) return ''
  const runways = match[1].split(',').map((r) => r.trim())
  return runways.every((r) => /^\d{1,2}[LCR]?$/.test(r)) ? runways.join(', ') : ''
}

/**
 * A station's name for reading: BeyondATC sends the list's names in capitals ("SINGAPORE APPROACH"). A short all-capitals name is a code
 * ("WSSS" for an ATIS), not a word, and is left alone, as is a name already in mixed case.
 *
 * @param name A station name.
 * @returns The name in title case where it was all capitals.
 */
export function stationDisplayName(name: string): string {
  const trimmed = name.trim()
  if (trimmed !== trimmed.toUpperCase() || trimmed.length <= 4) return trimmed
  return trimmed
    .toLowerCase()
    .replace(/(^|[\s(-])(\p{L})/gu, (_all, before: string, letter: string) => before + letter.toUpperCase())
}

/** The order a flight uses the types in, as BeyondATC names them. Anything else follows. */
const TYPE_ORDER = ['Clearance', 'Ground', 'Tower', 'Departure', 'Approach', 'ATIS', 'Center']

export interface FrequencyGroup {
  /** BeyondATC's own type ("Approach", "Clearance", ...). */
  type: string
  stations: BeyondAtcFrequencyOption[]
}

export interface AirportFrequencies {
  /** The airport's ICAO, or an empty string for the entries tied to no airport (en route). */
  airport: string
  airportName: string
  groups: FrequencyGroup[]
}

/**
 * The list grouped by airport, then by type in the order a flight uses them, each station keeping BeyondATC's own order within its type.
 * The airports come in the order they first appear; the entries tied to no airport are one group last.
 *
 * @param options Every frequency BeyondATC offers.
 * @returns One entry per airport.
 */
export function groupFrequencies(options: BeyondAtcFrequencyOption[]): AirportFrequencies[] {
  const airports: AirportFrequencies[] = []
  for (const option of options) {
    let entry = airports.find((a) => a.airport === option.airport)
    if (!entry) {
      entry = { airport: option.airport, airportName: option.airportName, groups: [] }
      airports.push(entry)
    }
    let group = entry.groups.find((g) => g.type === option.type)
    if (!group) {
      group = { type: option.type, stations: [] }
      entry.groups.push(group)
    }
    group.stations.push(option)
  }
  const rank = (type: string): number => {
    const i = TYPE_ORDER.indexOf(type)
    return i < 0 ? TYPE_ORDER.length : i
  }
  for (const entry of airports) entry.groups.sort((a, b) => rank(a.type) - rank(b.type))
  return [...airports.filter((a) => a.airport !== ''), ...airports.filter((a) => a.airport === '')]
}

/**
 * Which airport the picker opens on: the departure while the flight is in its first half, the arrival after.
 *
 * @param progressPct How far through the flight plan, 0 to 100, or null when unknown.
 * @returns `departure` or `arrival`.
 */
export function openingAirport(progressPct: number | null): 'departure' | 'arrival' {
  return progressPct !== null && progressPct >= 50 ? 'arrival' : 'departure'
}
