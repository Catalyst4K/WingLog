import { EventEmitter } from 'node:events'
import type { BeyondAtcArrivalClearance, BeyondAtcTranscriptEntry, FlightPhase, NavdataProcedureOption } from '@shared/ipc'
import { matchClearanceApproach } from '@shared/atc-approach-match'
import { parseAtcClearance } from '@shared/atc-clearance-parser'

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
 * Lives in main, published as a LiveHub topic, so a LAN client (v1.5) sees the same card
 * (flightdeck-backend's docs/plans/live-data-seam.md). Emits 'clearance' on every change.
 */
export class ArrivalClearanceTracker extends EventEmitter {
  private clearance: BeyondAtcArrivalClearance | null = null
  private lastTs = 0

  constructor(private readonly deps: ArrivalClearanceDeps) {
    super()
  }

  getClearance(): BeyondAtcArrivalClearance | null {
    return this.clearance
  }

  /** Reads ATC lines not seen before (by timestamp, since the transcript is capped). */
  onTranscript(transcript: BeyondAtcTranscriptEntry[]): void {
    let next = this.clearance
    for (const entry of transcript) {
      if (entry.speaker !== 'atc' || entry.ts <= this.lastTs) continue
      this.lastTs = entry.ts
      next = this.apply(next, entry.text)
    }
    this.set(next)
  }

  /** Touchdown clears the card. */
  onPhase(phase: FlightPhase): void {
    if (phase === 'landing') this.set(null)
  }

  private apply(current: BeyondAtcArrivalClearance | null, text: string): BeyondAtcArrivalClearance | null {
    const parsed = parseAtcClearance(text)
    if (!parsed) return current
    const { starIdent, approachIdent } = parsed.fields
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
      const transition = named.fields.approachTransition ?? (current?.approachIdent === ident ? current.approachTransition : null)
      return {
        starIdent: current?.starIdent ?? null,
        runway: current?.runway ?? null,
        approachIdent: ident,
        approachTransition: transition
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
