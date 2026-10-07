/** The arrival stand BeyondATC assigned, as a hook. */

import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { useLiveTopic } from './live/LiveClient'

/**
 * The arrival stand BeyondATC assigned, live (stand-positions.md): BeyondATC normally hands it to GSX itself; when that handoff
 * fails, GSX's gate search is the fallback, and this is what WingLog offers there.
 *
 * It's BeyondATC's "Expect Gate" / "Taxi to Gate" InfoBox, as main keeps it (`assignedGate`, BeyondAtcService) after the box set
 * is replaced. The box is set as soon as BeyondATC assigns the gate, which can be well before ATC says it (one gate was assigned
 * with the first half of a split clearance and only spoken in the second). Never read from speech (winglog-backend's
 * docs/decisions.md, 2026-10-05). Null when BeyondATC hasn't assigned one.
 *
 * @returns The stand, or null.
 */
export function useAtcAssignedStand(): string | null {
  return useLiveTopic('beyondAtcState', EMPTY_BEYONDATC_STATE).assignedGate
}
