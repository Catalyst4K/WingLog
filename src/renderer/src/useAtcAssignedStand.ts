import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { useLiveTopic } from './live/LiveClient'

/**
 * The arrival stand BeyondATC assigned, live (stand-positions.md, Callum 2026-10-02):
 * BeyondATC normally hands it to GSX itself; when that handoff fails, GSX's gate search is the
 * fallback, and this is what WingLog offers there.
 *
 * It's BeyondATC's "Expect Gate" / "Taxi to Gate" InfoBox, as main keeps it (`assignedGate`,
 * BeyondAtcService) after the box set is replaced. The box is set as soon as BeyondATC assigns
 * the gate, which can be well before ATC says it: EGLL, flight 229, 2026-10-05, gate 411 was
 * assigned with the first half of a split clearance (12:17) but only spoken in the second
 * (12:24). Never read from speech (flightdeck-backend's docs/decisions.md, 2026-10-05). Null
 * when BeyondATC hasn't assigned one.
 */
export function useAtcAssignedStand(): string | null {
  return useLiveTopic('beyondAtcState', EMPTY_BEYONDATC_STATE).assignedGate
}
