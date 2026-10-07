/**
 * What the taxi line remembers about ATC's clearance, as pure step functions (coding-standards.md §10):
 * `(memory, input, nowMs) → { memory, clearance }`. `useTaxiRouteHighlight` keeps the memory in `uiMemory()` (so a remount
 * doesn't re-take old clearances) and passes the clock in; the offline simulation replays recorded BeyondATC traffic through the
 * same code.
 */
import type { BeyondAtcInfoBox, BeyondAtcTranscriptEntry, FlightPhase } from '@shared/ipc'
import { parseTaxiHoldShortRunway } from '@shared/taxi-route-parser'
import { boxTaxiClearance, startOf, type TaxiClearance } from './taxi-clearance'

/** The taxi line's clearance and what's been read, so a remount doesn't re-take old ones. */
export interface TaxiMemory {
  clearance: TaxiClearance | null
  /** The newest transcript line already looked at, epoch ms. */
  lastTranscriptTs: number
  /** Whether the aircraft was last seen past the takeoff roll. */
  departed: boolean
  /** The last InfoBoxes taxi clearance taken, and when (epoch ms). */
  boxKey: string
  boxAt: number
  /** The last spoken hold-short runway, and when (epoch ms). */
  holdShort: { runway: string; at: number } | null
}

/** Nothing read yet. */
export const INITIAL_TAXI_MEMORY: TaxiMemory = {
  clearance: null,
  lastTranscriptTs: 0,
  departed: false,
  boxKey: '',
  boxAt: 0,
  holdShort: null
}

/** How close a spoken "hold short of runway" must be to a box route to belong to it: BeyondATC
 *  updates the boxes and speaks within a second or two of each other. */
export const HOLD_SHORT_PAIR_MS = 30_000

/** From the takeoff roll until touchdown the departure's taxi route is finished with: otherwise it stays drawn on top of the
 *  flown track at every zoom. Landing isn't in here, so an arrival's "taxi to stand" clearance still draws after touchdown. */
const DEPARTED_PHASES: ReadonlySet<FlightPhase> = new Set(['takeoff', 'climb', 'cruise', 'descent'])

/**
 * Whether the flight has left the ground, so the departure's taxi route is finished with.
 *
 * @param phase The active flight's phase, or null with no active flight.
 * @returns True from the takeoff roll until touchdown.
 */
export function isDeparted(phase: FlightPhase | null): boolean {
  return phase !== null && DEPARTED_PHASES.has(phase)
}

/**
 * @param clearance A clearance.
 * @param runway The runway ATC said to hold short of.
 * @returns The clearance with that hold short, unless it already has one.
 */
function withHoldShort(clearance: TaxiClearance, runway: string): TaxiClearance {
  return clearance.holdShortRunway ? clearance : { ...clearance, holdShortRunway: runway }
}

/**
 * ATC's speech: only "hold short of runway …", which has no box. Each line is read once (the memory holds the newest read), and
 * a hold short joins the box route set within HOLD_SHORT_PAIR_MS of it.
 *
 * @param memory What's been read so far.
 * @param transcript BeyondATC's transcript.
 * @param nowMs The current time, epoch ms.
 * @returns The memory after, and the clearance with a hold short added, or null when none was.
 */
export function stepTaxiTranscript(
  memory: TaxiMemory,
  transcript: BeyondAtcTranscriptEntry[],
  nowMs: number
): { memory: TaxiMemory; clearance: TaxiClearance | null } {
  let next = memory
  let changed: TaxiClearance | null = null
  for (const entry of transcript) {
    if (entry.speaker !== 'atc' || entry.ts <= next.lastTranscriptTs) continue
    next = { ...next, lastTranscriptTs: entry.ts }
    const runway = parseTaxiHoldShortRunway(entry.text)
    if (!runway) continue
    next = { ...next, holdShort: { runway, at: nowMs } }
    if (next.clearance && nowMs - next.boxAt <= HOLD_SHORT_PAIR_MS) {
      next = { ...next, clearance: withHoldShort(next.clearance, runway) }
      changed = next.clearance
    }
  }
  return { memory: next, clearance: changed }
}

/**
 * The clearance itself, taken once per new set of taxi boxes.
 *
 * @param memory What's been read so far.
 * @param infoBoxes BeyondATC's InfoBoxes now.
 * @param position The aircraft's position now, where the clearance starts.
 * @param nowMs The current time, epoch ms.
 * @returns The memory after, and the new clearance, or null when the boxes hold no new taxi clearance.
 */
export function stepTaxiBoxes(
  memory: TaxiMemory,
  infoBoxes: BeyondAtcInfoBox[],
  position: { lat: number; lon: number } | null,
  nowMs: number
): { memory: TaxiMemory; clearance: TaxiClearance | null } {
  const box = boxTaxiClearance(infoBoxes)
  if (!box) return { memory, clearance: null }
  const key = JSON.stringify(box)
  if (key === memory.boxKey) return { memory, clearance: null }
  let clearance: TaxiClearance = { ...box, ...startOf(position) }
  if (memory.holdShort && nowMs - memory.holdShort.at <= HOLD_SHORT_PAIR_MS) {
    clearance = withHoldShort(clearance, memory.holdShort.runway)
  }
  return { memory: { ...memory, boxKey: key, boxAt: nowMs, clearance }, clearance }
}
