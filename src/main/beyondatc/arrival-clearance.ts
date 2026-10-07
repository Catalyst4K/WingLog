/**
 * Keeps ATC's arrival clearance (STAR, runway, approach) for the BeyondATC tab's card, from
 * BeyondATC's InfoBoxes until touchdown.
 */
import { EventEmitter } from 'node:events'
import type { BeyondAtcArrivalClearance, BeyondAtcInfoBox, FlightPhase } from '@shared/ipc'
import {
  INITIAL_ARRIVAL_STATE,
  stepArrival,
  type ArrivalInput,
  type ArrivalLookup,
  type ArrivalState
} from './arrival-clearance-step'

/** What the tracker needs to look up. */
export type ArrivalClearanceDeps = ArrivalLookup

/**
 * Keeps ATC's arrival clearance for the BeyondATC tab's info card, from the moment it's given until touchdown. Otherwise the
 * STAR/runway clearance showed only in the latest-instruction card, which the next ATC line replaced before it was read.
 *
 * Read only from BeyondATC's InfoBoxes, never ATC's speech (winglog-backend's docs/decisions.md, 2026-10-05). Real sets
 * (VHHH-ZJSY):
 * - `STAR` + `Arrival Runway` set the STAR and runway. A known approach is cleared only when the runway differs from its own.
 * - `Landing Runway` (+ `Transition`) sets the runway and the approach transition.
 * - `Cleared Approach` sets the approach, named the way the airport's navdata names it. A transition already known for that
 *   runway is kept.
 * - The first tracking point in 'landing' (touchdown) clears it all.
 *
 * The rules are in arrival-clearance-step.ts (a pure step function); this class holds the state and emits. Lives in main,
 * published as a LiveHub topic, so a LAN client (v1.5) sees the same card (winglog-backend's docs/plans/live-data-seam.md).
 * Emits 'clearance' on every change.
 */
export class ArrivalClearanceTracker extends EventEmitter {
  private state: ArrivalState = INITIAL_ARRIVAL_STATE

  constructor(private readonly deps: ArrivalClearanceDeps) {
    super()
  }

  /**
   * The card now.
   *
   * @returns The arrival clearance, or null before any is given.
   */
  getClearance(): BeyondAtcArrivalClearance | null {
    return this.state.clearance
  }

  /**
   * Reads each new set of InfoBoxes once.
   *
   * @param boxes BeyondATC's InfoBoxes now.
   */
  onInfoBoxes(boxes: BeyondAtcInfoBox[]): void {
    this.step({ kind: 'boxes', boxes })
  }

  /**
   * Touchdown clears the card.
   *
   * @param phase The tracked flight's phase.
   */
  onPhase(phase: FlightPhase): void {
    this.step({ kind: 'phase', phase })
  }

  private step(input: ArrivalInput): void {
    const before = this.state.clearance
    this.state = stepArrival(this.state, input, this.deps)
    if (this.state.clearance !== before) this.emit('clearance', this.state.clearance)
  }
}
