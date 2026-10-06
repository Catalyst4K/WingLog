/**
 * Keeps ATC's arrival clearance (STAR, runway, approach) for the BeyondATC tab's card, from
 * BeyondATC's InfoBoxes until touchdown.
 */
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

  /**
   * Reads each new set of InfoBoxes once.
   *
   * @param boxes BeyondATC's InfoBoxes now.
   */
  onInfoBoxes(boxes: BeyondAtcInfoBox[]): void {
    const key = JSON.stringify(boxes)
    if (key === this.lastBoxesKey) return
    this.lastBoxesKey = key
    const parsed = parseAtcBoxClearance(boxes)
    if (parsed) this.set(this.apply(this.clearance, parsed))
  }

  /**
   * Touchdown clears the card.
   *
   * @param phase The tracked flight's phase.
   */
  onPhase(phase: FlightPhase): void {
    if (phase === 'landing') this.set(null)
  }

  /**
   * The card after one parsed set of boxes.
   *
   * @param current The card now, or null.
   * @param parsed What the boxes clear.
   * @returns The card after.
   */
  private apply(current: BeyondAtcArrivalClearance | null, parsed: AtcClearanceUpdate): BeyondAtcArrivalClearance | null {
    const { starIdent, approachIdent } = parsed.fields
    if (starIdent) return this.withStar(current, starIdent, parsed.arrivalRunway ?? null)
    if (approachIdent) return this.withApproach(current, parsed, approachIdent)
    if (parsed.arrivalRunway) return this.withRunway(current, parsed.arrivalRunway, parsed.fields.approachTransition)
    return current
  }

  /**
   * `STAR` + `Arrival Runway`: a known approach is kept only if it's for that runway.
   *
   * @param current The card now, or null.
   * @param starIdent The STAR cleared.
   * @param runway The runway cleared with it, or null.
   * @returns The card after.
   */
  private withStar(current: BeyondAtcArrivalClearance | null, starIdent: string, runway: string | null): BeyondAtcArrivalClearance {
    const kept = runway !== null && current?.approachIdent != null && current.approachIdent.endsWith(` ${runway}`) ? current : null
    return { starIdent, runway, approachIdent: kept?.approachIdent ?? null, approachTransition: kept?.approachTransition ?? null }
  }

  /**
   * `Cleared Approach`: named the way the airport's navdata names it, and a transition already
   * known for that approach (or the first one named on the briefed runway) kept.
   *
   * @param current The card now, or null.
   * @param parsed What the boxes clear.
   * @param approachIdent The approach as ATC named it.
   * @returns The card after.
   */
  private withApproach(current: BeyondAtcArrivalClearance | null, parsed: AtcClearanceUpdate, approachIdent: string): BeyondAtcArrivalClearance {
    const named = this.navdataNamed(parsed)
    const ident = named.fields.approachIdent ?? approachIdent
    // ZJSY: `Transition` SY498 came two minutes before `Cleared Approach`.
    const briefed = current?.approachIdent == null && current?.runway != null && ident.endsWith(` ${current.runway}`)
    const keepsTransition = current !== null && (current.approachIdent === ident || briefed)
    return {
      starIdent: current?.starIdent ?? null,
      runway: current?.runway ?? null,
      approachIdent: ident,
      approachTransition: named.fields.approachTransition ?? (keepsTransition ? current.approachTransition : null)
    }
  }

  /**
   * The cleared approach as the airport's navdata names it, when navdata has it.
   *
   * @param parsed What the boxes clear.
   * @returns The navdata match, or the boxes' own wording.
   */
  private navdataNamed(parsed: AtcClearanceUpdate): AtcClearanceUpdate {
    const icao = this.deps.getArrivalIcao()
    const matched = icao ? matchClearanceApproach(parsed, this.deps.listApproaches(icao)) : null
    return matched?.fields.approachIdent ? matched : parsed
  }

  /**
   * `Landing Runway` on its own, maybe with the approach transition: an approach for another
   * runway no longer applies.
   *
   * @param current The card now, or null.
   * @param runway The runway cleared.
   * @param approachTransition The transition cleared with it, if any.
   * @returns The card after.
   */
  private withRunway(
    current: BeyondAtcArrivalClearance | null,
    runway: string,
    approachTransition: string | null | undefined
  ): BeyondAtcArrivalClearance {
    const kept = current?.approachIdent != null && current.approachIdent.endsWith(` ${runway}`) ? current : null
    return {
      starIdent: current?.starIdent ?? null,
      runway,
      approachIdent: kept?.approachIdent ?? null,
      approachTransition: approachTransition ?? kept?.approachTransition ?? null
    }
  }

  private set(next: BeyondAtcArrivalClearance | null): void {
    if (JSON.stringify(next) === JSON.stringify(this.clearance)) return
    this.clearance = next
    this.emit('clearance', next)
  }
}
