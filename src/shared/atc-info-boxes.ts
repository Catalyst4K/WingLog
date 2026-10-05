import type { BeyondAtcInfoBox, ProcedureSelection } from './ipc'

/** A clearance read from one set of InfoBoxes, as a partial `ProcedureSelection` update. */
export interface AtcClearanceUpdate {
  fields: Partial<Pick<ProcedureSelection, 'departureRunway' | 'sidIdent' | 'starIdent' | 'approachIdent' | 'approachTransition'>>
  /** A labelled "what changed" summary for the prompt. */
  summary: string
  /** A STAR clearance's or landing runway ("08"). Not a field: ProcedureSelection keeps the
   *  arrival runway only inside approachIdent (route.ts's approachRunway), so
   *  approachForArrivalRunway (the renderer's atcApproachMatch.ts) turns it into an approach
   *  once the airport's approach list is known. */
  arrivalRunway?: string
}

/** "ILS-Z approach runway 08" (the `Cleared Approach` box): the type and runway. */
const CLEARED_APPROACH = /^([A-Z0-9]+(?:-[A-Z0-9]+)*) approach,? runway (\d{1,2}[LRC]?)$/i

/**
 * BeyondATC's InfoBoxes, read as typed facts (flightdeck-backend's
 * docs/plans/beyondatc-infoboxes-first.md). The boxes carry each clearance's facts as their own
 * fields, and are the only source for any fact they cover: ATC's speech isn't parsed for them
 * (docs/decisions.md, 2026-10-05).
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

export function normaliseTitle(title: string): string {
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

/** The value of the first box with one of these titles (normalised), trimmed; null when none
 *  has one. */
export function boxValue(boxes: BeyondAtcInfoBox[], ...titles: string[]): string | null {
  for (const box of boxes) {
    if (titles.includes(normaliseTitle(box.title))) {
      const value = nonEmpty(box.info)
      if (value) return value
    }
  }
  return null
}

/** "QNH 1014" → '1014': BeyondATC sometimes repeats the box's own label in its value (ZJSY,
 *  2026-10-05). */
export function withoutLabel(value: string, label: string): string {
  const prefix = `${label.toLowerCase()} `
  return value.toLowerCase().startsWith(prefix) ? value.slice(prefix.length).trim() : value
}

const RUNWAY_VALUE = /^(?:runway +)?(\d{1,2}[LRC]?)$/i

function runwayValue(value: string | null): string | null {
  return value ? (RUNWAY_VALUE.exec(value)?.[1]?.toUpperCase() ?? null) : null
}

/** "ILS-Z approach runway 08" (the `Cleared Approach` box) → 'ILS Z 08', the sim's own naming,
 *  confirmed against the sim's navdata (beyondatc-notes.md, "Identifier-matching question
 *  closed": BeyondATC hyphenates the type, the sim spaces it). */
export function clearedApproachIdent(value: string | null): string | null {
  const match = value ? CLEARED_APPROACH.exec(value.trim()) : null
  return match ? `${match[1]!.replace('-', ' ').toUpperCase()} ${match[2]!.toUpperCase()}` : null
}

/**
 * The procedure clearance in one set of InfoBoxes, in the same shape as a spoken one
 * (parseAtcClearance), or null when the boxes hold none. Real sets, VHHH-ZJSY 2026-10-05:
 * - departure clearance: `SID` PECA3A + `Taxi to Runway` 07R;
 * - STAR clearance: `STAR` UPRS2C + `Arrival Runway` 08;
 * - approach briefing: `Landing Runway` 08 + `Transition` SY498 (sets the runway and the
 *   approach transition; the approach itself comes from the runway's navdata);
 * - approach clearance: `Cleared Approach` "ILS-Z approach runway 08";
 * - `Landing Runway` on its own (with QNH, after the STAR): the runway only.
 */
export function parseAtcBoxClearance(boxes: BeyondAtcInfoBox[]): AtcClearanceUpdate | null {
  const sid = boxValue(boxes, 'sid')?.toUpperCase() ?? null
  if (sid) {
    const departureRunway = runwayValue(boxValue(boxes, 'taxi to runway', 'departure runway'))
    return {
      fields: { sidIdent: sid, ...(departureRunway && { departureRunway }) },
      summary: departureRunway ? `SID ${sid}, runway ${departureRunway}` : `SID ${sid}`
    }
  }

  const star = boxValue(boxes, 'star')?.toUpperCase() ?? null
  const arrivalRunway = runwayValue(boxValue(boxes, 'arrival runway', 'landing runway'))
  if (star) {
    return {
      fields: { starIdent: star },
      summary: arrivalRunway ? `STAR ${star}, runway ${arrivalRunway}` : `STAR ${star}`,
      ...(arrivalRunway && { arrivalRunway })
    }
  }

  const approachIdent = clearedApproachIdent(boxValue(boxes, 'cleared approach'))
  const transition = boxValue(boxes, 'transition')?.toUpperCase() ?? null
  if (approachIdent) {
    return {
      fields: transition ? { approachIdent, approachTransition: transition } : { approachIdent },
      summary: transition ? `Approach ${approachIdent} via ${transition}` : `Approach ${approachIdent}`
    }
  }

  if (arrivalRunway) {
    return {
      fields: transition ? { approachTransition: transition } : {},
      summary: transition ? `Runway ${arrivalRunway} via ${transition}` : `Runway ${arrivalRunway}`,
      arrivalRunway
    }
  }
  return null
}

const FEET_PER_METRE = 1 / 0.3048

/** "FL360" → 36000, "3,000m" → 9843, "11000 feet" → 11000. Null for anything else. A bare
 *  number is metres only with a metric unit; feet otherwise. */
export function levelToFeet(level: string): number | null {
  const value = level.trim()
  const fl = /^FL ?(\d{2,3})$/i.exec(value)
  if (fl) return Number(fl[1]) * 100
  const match = /^([\d,]+) ?(m|meters|metres|feet|ft)?$/i.exec(value)
  if (!match) return null
  const number = Number(match[1]!.replace(/,/g, ''))
  if (!Number.isFinite(number) || number <= 0) return null
  return match[2] && /^m/i.test(match[2]) ? Math.round(number * FEET_PER_METRE) : number
}


/** Titles that carry a cleared level (VHHH-ZJSY, 2026-10-05: `Altitude Clearance` FL140,
 *  `climb`/`Climb` FL180/FL360, `Descend to` 3,000m; ZJSY-VHHH, same evening: `Continue Climb To`
 *  FL371 after a granted step, `Descend To` "11,000" in feet with no unit). */
const LEVEL_TITLES = [
  'altitude clearance',
  'climb',
  'climb to',
  'continue climb to',
  'descend',
  'descend to',
  'new cruise altitude',
  'cruise altitude'
]

/** The cleared level in one set of InfoBoxes, in feet, or null when it has none. */
export function boxClearedLevelFt(boxes: BeyondAtcInfoBox[]): number | null {
  const value = boxValue(boxes, ...LEVEL_TITLES)
  return value ? levelToFeet(value) : null
}
