/**
 * What the taxi line remembers about ATC's clearance, as pure step functions (coding-standards.md §10):
 * `(memory, input, nowMs) → { memory, clearance }`. `useTaxiRouteHighlight` keeps the memory in `uiMemory()` (so a remount
 * doesn't re-take old clearances) and passes the clock in; the offline simulation replays recorded BeyondATC traffic through the
 * same code.
 */
import type { BeyondAtcInfoBox, FlightPhase } from '@shared/ipc'
import { boxTaxiClearance, startOf, type TaxiClearance } from './taxi-clearance'

/** The taxi line's clearance and what's been read, so a remount doesn't re-take old ones. */
export interface TaxiMemory {
  clearance: TaxiClearance | null
  /** Whether the aircraft was last seen past the takeoff roll. */
  departed: boolean
  /** The last InfoBoxes taxi clearance taken, and when (epoch ms). */
  boxKey: string
  boxAt: number
}

/** Nothing read yet. */
export const INITIAL_TAXI_MEMORY: TaxiMemory = {
  clearance: null,
  departed: false,
  boxKey: '',
  boxAt: 0
}

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
  const clearance: TaxiClearance = { ...box, ...startOf(position) }
  return { memory: { ...memory, boxKey: key, boxAt: nowMs, clearance }, clearance }
}
