/**
 * What a client does when the sim PC's flight or its data arrives: keep the mirror of the flight, and have the procedure store look
 * again at the flight it shows, so it holds nothing while the sim PC flies one and takes up what a sync wrote on its row otherwise.
 */
import type { LanFlightSnapshot, TrackPoint } from '@shared/ipc'
import type { ProcedureSelectionStore } from '../procedures/ProcedureSelectionStore'
import type { LiveHub } from '../live/LiveHub'
import type { TwinSyncPort } from './TwinSync'
import type { FlightMirror } from './flight-mirror'

/**
 * @param mirror The flight the sim PC is tracking, as this computer knows it.
 * @param selection This computer's procedure store.
 * @returns What the link calls when the sim PC shows a flight (or none).
 */
export function followHostFlight(
  mirror: Pick<FlightMirror, 'setFlight' | 'clear'>,
  selection: Pick<ProcedureSelectionStore, 'refresh'>
): (flight: LanFlightSnapshot | null, track: () => TrackPoint[]) => void {
  return (flight, track) => {
    if (flight) mirror.setFlight(flight, track)
    else mirror.clear()
    // Whether the sim PC is flying may have changed: if so the sim PC's choice is the one shown, not one held here.
    selection.refresh()
  }
}

/**
 * Calls `landed` once for each sync that ends well: rows may have come in.
 *
 * @param sync The sync with the sim PC.
 * @param landed What to do then.
 */
export function onSyncLanded(sync: Pick<TwinSyncPort, 'onChange' | 'status'>, landed: () => void): void {
  let lastSeen: string | null = null
  sync.onChange(() => {
    const { state, lastSyncedAt } = sync.status()
    if (state !== 'idle' || lastSyncedAt === lastSeen) return
    lastSeen = lastSyncedAt
    landed()
  })
}

/**
 * Shows the sim PC's planned route once the flight it is for has synced: the route arrived first and was held back, since this computer
 * had no id for the flight yet.
 *
 * @param mirror The flight the sim PC is tracking, as this computer knows it.
 * @param hub This computer's hub.
 */
export function showHeldRoute(
  mirror: Pick<FlightMirror, 'releaseHeldRoute'>,
  hub: Pick<LiveHub, 'publish'>
): void {
  const route = mirror.releaseHeldRoute()
  if (route) hub.publish('plannedRoute', route)
}
