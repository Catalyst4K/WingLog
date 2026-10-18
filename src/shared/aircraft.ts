/** Rules about a fleet aircraft that both main and the renderer apply. */

import type { Aircraft } from './ipc'

/**
 * An aircraft is retired if it was replaced (`replacedByAircraftId`, its flights moved to
 * the replacement) or retired outright (`retiredAt`, its flights kept — winglog-backend
 * docs/plans/fleet-retire.md). Retired aircraft stay viewable but aren't selectable.
 *
 * @param a The aircraft.
 * @returns True if it is retired either way.
 */
export function isRetired(a: Pick<Aircraft, 'replacedByAircraftId' | 'retiredAt'>): boolean {
  return a.replacedByAircraftId !== null || a.retiredAt !== null
}
