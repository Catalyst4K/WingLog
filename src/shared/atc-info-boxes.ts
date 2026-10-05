import type { BeyondAtcInfoBox } from './ipc'

/**
 * BeyondATC's InfoBoxes, read as typed facts (flightdeck-backend's
 * docs/plans/beyondatc-infoboxes-first.md). The boxes carry each clearance's facts as their own
 * fields, so they're preferred over parsing ATC's speech wherever a box exists.
 *
 * Titles are matched exactly as captured on real flights (EGLL flight 229 and VHHH-ZJSY flight
 * 230, 2026-10-05), trimmed and ignoring case: BeyondATC sends " Frequency" with a leading space
 * and both "climb" and "Climb". A title not listed here is ignored, never guessed at.
 */
export interface AtcTaxiFacts {
  /** `Taxi Via 1`..`n`, in number order: ['B', 'B', 'V', 'H', 'J']. Empty with no taxi route. */
  taxiVia: string[]
  /** `Hold Position`: the holding point at the end of a departure taxi ('J1'). */
  holdPosition: string | null
  /** `Taxi to Runway`: '07R'. */
  taxiToRunway: string | null
  /** `Taxi to Gate` / `Taxi to Stand`, label removed: "Gate 102" → '102'. */
  taxiToGate: string | null
  /** `Expect Gate`, label removed. Set before the taxi call (ZJSY: 1.5 min earlier). */
  expectGate: string | null
}

const TAXI_VIA = /^taxi via (\d+)$/i

function normaliseTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** "Gate 102" → '102', "Stand N32" → 'N32', "411" → '411'. Null for anything else. */
function gateValue(info: string): string | null {
  return /^(?:(?:gate|stand) +)?(\S+)$/i.exec(info.trim())?.[1] ?? null
}

function nonEmpty(info: string): string | null {
  const value = info.trim()
  return value === '' ? null : value
}

export function parseAtcTaxiFacts(boxes: BeyondAtcInfoBox[]): AtcTaxiFacts {
  const facts: AtcTaxiFacts = { taxiVia: [], holdPosition: null, taxiToRunway: null, taxiToGate: null, expectGate: null }
  const via: { n: number; taxiway: string }[] = []
  for (const box of boxes) {
    const title = normaliseTitle(box.title)
    const viaMatch = TAXI_VIA.exec(title)
    if (viaMatch) {
      const taxiway = nonEmpty(box.info)
      if (taxiway) via.push({ n: Number(viaMatch[1]), taxiway: taxiway.toUpperCase() })
      continue
    }
    switch (title) {
      case 'hold position':
        facts.holdPosition = nonEmpty(box.info)?.toUpperCase() ?? null
        break
      case 'taxi to runway':
        facts.taxiToRunway = nonEmpty(box.info)?.toUpperCase() ?? null
        break
      case 'taxi to gate':
      case 'taxi to stand':
        facts.taxiToGate = gateValue(box.info)
        break
      case 'expect gate':
      case 'expect stand':
        facts.expectGate = gateValue(box.info)
        break
    }
  }
  facts.taxiVia = via.sort((a, b) => a.n - b.n).map((v) => v.taxiway)
  return facts
}

/** The gate BeyondATC has assigned, from either box: the taxi clearance's, else the earlier
 *  `Expect Gate`. Null with neither. */
export function assignedGate(facts: AtcTaxiFacts): string | null {
  return facts.taxiToGate ?? facts.expectGate
}
