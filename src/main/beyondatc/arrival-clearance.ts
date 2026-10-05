import { EventEmitter } from 'node:events'
import type { BeyondAtcArrivalClearance, BeyondAtcInfoBox, BeyondAtcTranscriptEntry, FlightPhase, NavdataProcedureOption } from '@shared/ipc'
import { matchClearanceApproach } from '@shared/atc-approach-match'
import { parseAtcClearance, type AtcClearanceUpdate } from '@shared/atc-clearance-parser'
import { parseAtcBoxClearance } from '@shared/atc-info-boxes'

export interface ArrivalClearanceDeps {
  /** The airport being flown to: the active flight's arrival, else BeyondATC's own route. */
  getArrivalIcao(): string | null
  /** The airport's approaches from navdata, to name a spoken approach the way the sim does. */
  listApproaches(icao: string): NavdataProcedureOption[]
}

/**
 * Keeps ATC's arrival clearance for the BeyondATC tab's info card, from the moment it's given
 * until touchdown (Callum, 2026-10-05). On flight 229 the STAR/runway clearance showed only in
 * the latest-instruction card, which the next ATC line replaced before it was read.
 *
 * - A STAR clearance ("cleared LOGA2H arrival, runway 27R") sets the STAR and runway. It
 *   clears a known approach only when its runway differs from that approach's.
 * - An approach clearance or "expect" advisory sets the approach and transition, named the
 *   way the airport's navdata names it. A later line naming the same approach without a
 *   transition keeps the one already known.
 * - The first tracking point in 'landing' (touchdown) clears it all.
 *
 * Read from BeyondATC's InfoBoxes (`STAR` + `Arrival Runway`, `Landing Runway` + `Transition`,
 * `Cleared Approach`). ATC's speech is read only while BeyondATC has sent no boxes this
 * session (flightdeck-backend's docs/decisions.md, 2026-10-05).
 *
 * Lives in main, published as a LiveHub topic, so a LAN client (v1.5) sees the same card
 * (flightdeck-backend's docs/plans/live-data-seam.md). Emits 'clearance' on every change.
 */
export class ArrivalClearanceTracker extends EventEmitter {
  private clearance: BeyondAtcArrivalClearance | null = null
  private lastTs = 0
  private boxesSeen = false
  private lastBoxesKey = ''

  constructor(private readonly deps: ArrivalClearanceDeps) {
    super()
  }

  getClearance(): BeyondAtcArrivalClearance | null {
    return this.clearance
  }

  /** Reads ATC lines not seen before (by timestamp, since the transcript is capped), only while
   *  BeyondATC sends no InfoBoxes. */
  onTranscript(transcript: BeyondAtcTranscriptEntry[]): void {
    let next = this.clearance
    for (const entry of transcript) {
      if (entry.speaker !== 'atc' || entry.ts <= this.lastTs) continue
      this.lastTs = entry.ts
      if (this.boxesSeen) continue
      const parsed = parseAtcClearance(entry.text)
      if (parsed) next = this.apply(next, parsed)
    }
    this.set(next)
  }

  /** Reads each new set of InfoBoxes once. */
  onInfoBoxes(boxes: BeyondAtcInfoBox[]): void {
    if (boxes.length > 0) this.boxesSeen = true
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
