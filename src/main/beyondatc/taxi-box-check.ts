import type { BeyondAtcInfoBox } from '@shared/ipc'
import { parseAtcTaxiFacts } from '@shared/atc-info-boxes'
import { parseTaxiRoute } from '@shared/taxi-route-parser'

/** How close together a box route and a spoken route must be to count as the same clearance. */
const SAME_CLEARANCE_MS = 120_000

interface Heard {
  taxiways: string[]
  at: number
}

/**
 * Compares the taxi route in BeyondATC's InfoBoxes with the one ATC speaks, and reports when
 * they disagree (flightdeck-backend's docs/plans/beyondatc-infoboxes-first.md, Callum
 * 2026-10-05: "the box wins, and the mismatch is logged"). The map uses the box route; this
 * only leaves a record in main.log, so a BeyondATC-side difference can be spotted and reported.
 * Each pair is reported once, whichever arrives second.
 */
export class TaxiBoxCheck {
  private box: Heard | null = null
  private spoken: Heard | null = null

  constructor(private readonly report: (message: string) => void) {}

  onInfoBoxes(boxes: BeyondAtcInfoBox[], now: number): void {
    const taxiways = parseAtcTaxiFacts(boxes).taxiVia
    if (taxiways.length === 0 || (this.box && sameTaxiways(this.box.taxiways, taxiways))) return
    this.box = { taxiways, at: now }
    this.compare()
  }

  onAtcLine(text: string, now: number): void {
    const taxiways = parseTaxiRoute(text)
    if (!taxiways) return
    this.spoken = { taxiways, at: now }
    this.compare()
  }

  private compare(): void {
    const { box, spoken } = this
    if (!box || !spoken || Math.abs(box.at - spoken.at) > SAME_CLEARANCE_MS) return
    if (!sameTaxiways(box.taxiways, spoken.taxiways)) {
      this.report(`[beyondatc] taxi route mismatch: InfoBoxes ${box.taxiways.join(', ')}; speech ${spoken.taxiways.join(', ')}`)
    }
    // Compared once: the next report needs a new box route or a new spoken one.
    this.spoken = null
  }
}

function sameTaxiways(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t.toUpperCase() === b[i]!.toUpperCase())
}
