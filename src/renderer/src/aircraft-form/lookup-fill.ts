/** What a registration lookup fills into the aircraft form: blanks only, never what's typed. */

import type { AirlineOption } from '@shared/ipc'

/** The form fields a lookup can fill. */
export interface LookupFillable {
  icaoType: string
  operator: string
  operatorIata: string
  operatorIcao: string
}

/** The parts of a registration lookup result the form uses. */
export interface LookupResult {
  icaoType: string
  operator: string | null
  operatorIcao: string | null
}

/**
 * Fills the type and the operator from a registration lookup, leaving anything already typed.
 * The airline matched by the operator's ICAO code (canonical name and IATA for the logo) wins
 * over adsbdb's free-text operator name, which doesn't always match the vendored name.
 *
 * @param current The form as it is now.
 * @param result The lookup result.
 * @param matchedAirline The vendored airline found by the result's operator ICAO code, if any.
 * @returns The form with the blanks filled.
 */
export function fillFromLookup<T extends LookupFillable>(
  current: T,
  result: LookupResult,
  matchedAirline: AirlineOption | undefined
): T {
  const fillOperator = !current.operator
  return {
    ...current,
    icaoType: current.icaoType || result.icaoType,
    operator: fillOperator ? (matchedAirline?.name ?? result.operator ?? current.operator) : current.operator,
    operatorIata: fillOperator ? (matchedAirline?.iata ?? '') : current.operatorIata,
    operatorIcao: fillOperator ? (matchedAirline?.icao ?? result.operatorIcao ?? '') : current.operatorIcao
  }
}
