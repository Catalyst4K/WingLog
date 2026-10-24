/** The Logbook's online filter: all flights, those flown on a network, or on one network. */
import type { LogbookFlight } from '@shared/ipc'

export type OnlineFilter = 'all' | 'online' | 'vatsim' | 'ivao'

/** The choices, in the order they are offered. */
export const ONLINE_FILTERS: OnlineFilter[] = ['all', 'online', 'vatsim', 'ivao']

/**
 * @param flights The flights.
 * @param filter Which to keep.
 * @returns The flights that match: any online flight for 'online', that network's for 'vatsim' or 'ivao', all for 'all'.
 */
export function filterByOnline(flights: LogbookFlight[], filter: OnlineFilter): LogbookFlight[] {
  if (filter === 'all') return flights
  if (filter === 'online') return flights.filter((f) => f.onlineNetwork !== null)
  return flights.filter((f) => f.onlineNetwork === filter)
}

/**
 * @param flights The flights.
 * @returns True when any was flown online: the filter is only worth showing then.
 */
export function hasOnlineFlights(flights: LogbookFlight[]): boolean {
  return flights.some((f) => f.onlineNetwork !== null)
}
