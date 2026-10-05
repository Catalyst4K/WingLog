import { EventEmitter } from 'node:events'
import type { BeyondAtcArrivalClearance, BeyondAtcInfoBox, FlightPhase, NavdataProcedureOption } from '@shared/ipc'
import { matchClearanceApproach } from '@shared/atc-approach-match'
import { parseAtcBoxClearance, type AtcClearanceUpdate } from '@shared/atc-info-boxes'

export interface ArrivalClearanceDeps {
  /** The airport being flown to: the active flight's arrival, else BeyondATC's own route. */
  getArrivalIcao(): string | null
  /** The airport's approaches from navdata, to name a cleared approach the way the sim does. */
  listApproaches(icao: string): NavdataProcedureOption[]
}

/**
 * Keeps ATC's arrival clearance for the BeyondATC tab's info card, from the moment it's given
 * until touchdown (Callum, 2026-10-05). On flight 229 the STAR/runway clearance showed only in
 * the latest-instruction card, which the next ATC line replaced before it was read.
 *
 * Read only from BeyondATC's InfoBoxes, never ATC's speech (flightdeck-backend's
 * docs/decisions.md, 2026-10-05). Real sets, VHHH-ZJSY 2026-10-05:
 * - `STAR` + `Arrival Runway` set the STAR and runway. A known approach is cleared only when
 *   the runway differs from its own.
 * - `Landing Runway` (+ `Transition`) sets the runway and the approach transition.
 * - `Cleared Approach` sets the approach, named the way the airport's navdata names it. A
 *   transition already known for that runway is kept.
 * - The first tracking point in 'landing' (touchdown) clears it all.
 *
 * Lives in main, published as a LiveHub topic, so a LAN client (v1.5) sees the same card
 * (flightdeck-backend's docs/plans/live-data-seam.md). Emits 'clearance' on every change.
 */
export class ArrivalClearanceTracker extends EventEmitter {
  private clearance: BeyondAtcArrivalClearance | null = null
  private lastBoxesKey = ''

  constructor(private readonly deps: ArrivalClearanceDeps) {
    super()
  }

  getClearance(): BeyondAtcArrivalClearance | null {
    return this.clearance
  }

  /** Reads each new set of InfoBoxes once. */
  onInfoBoxes(boxes: BeyondAtcInfoBox[]): void {
    const key = JSON.stringify(boxes)
    if (key === this.lastBoxesKey) return
    this.lastBoxesKey = key
    const parsed = parseAtcBoxClearance(boxes)
    if (parsed) this.set(this.apply(this.clearance, parsed))
  }

  /** Touchdown clears the card. */
  onPhase(phase: FlightPhase): void {
    if (phase === 'landing') this.set(null)
  }

  private apply(current: BeyondAtcArrivalClearance | null, parsed: AtcClearanceUpdate): BeyondAtcArrivalClearance | null {
    const { starIdent, approachIdent, approachTransition } = parsed.fields
    if (starIdent) {
      const runway = parsed.arrivalRunway ?? null
      const keepsApproach = current?.approachIdent != null && runway !== null && current.approachIdent.endsWith(` ${runway}`)
      return {
        starIdent,
        runway,
        approachIdent: keepsApproach ? current!.approachIdent : null,
        approachTransition: keepsApproach ? current!.approachTransition : null
      }
    }
    if (approachIdent) {
      // Navdata's name when it has the approach, otherwise exactly what ATC said.
      const icao = this.deps.getArrivalIcao()
      const matched = icao ? matchClearanceApproach(parsed, this.deps.listApproaches(icao)) : null
      const named = matched?.fields.approachIdent ? matched : parsed
      const ident = named.fields.approachIdent ?? approachIdent
      // A transition already known is kept for the same approach, or for the first approach named
      // on the briefed runway (ZJSY: `Transition` SY498 came two minutes before `Cleared Approach`).
      const briefed = current?.approachIdent == null && current?.runway != null && ident.endsWith(` ${current.runway}`)
      const transition = named.fields.approachTransition ?? (current && (current.approachIdent === ident || briefed) ? current.approachTransition : null)
      return {
        starIdent: current?.starIdent ?? null,
        runway: current?.runway ?? null,
        approachIdent: ident,
        approachTransition: transition
      }
    }
    if (parsed.arrivalRunway) {
      // A runway on its own (`Landing Runway`), maybe with the approach transition: an approach
      // for another runway no longer applies.
      const runway = parsed.arrivalRunway
      const keepsApproach = current?.approachIdent != null && current.approachIdent.endsWith(` ${runway}`)
      return {
        starIdent: current?.starIdent ?? null,
        runway,
        approachIdent: keepsApproach ? current!.approachIdent : null,
        approachTransition: approachTransition ?? (keepsApproach ? current!.approachTransition : null)
      }
    }
    return current
  }

  private set(next: BeyondAtcArrivalClearance | null): void {
    if (JSON.stringify(next) === JSON.stringify(this.clearance)) return
    this.clearance = next
    this.emit('clearance', next)
  }
}
