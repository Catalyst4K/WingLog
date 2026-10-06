/**
 * Cuts a committable fixture out of a full capture: a time window, the streams a test needs, and
 * the personal identifiers replaced (flightdeck-backend docs/plans/robustness/scenario-testing.md
 * Part 1; CLAUDE.md's Security section). Used by `scripts/fixture-from-capture.ts`.
 *
 * Replaced automatically: the sim's ATC id (tail number or callsign) and BeyondATC's callsign,
 * full and short. BeyondATC's `Settings` lines (account options) are dropped. A spoken callsign
 * ("Cathay one two three") can't be found by text, so the transcript still needs a look by eye
 * before committing.
 */
import type { CapturedLineEvent, FlightFixtureEvent, ParsedFlightFixture } from './flight-fixture'

/** A committed fixture's `capturedAt`: real flight dates aren't kept. */
export const ANONYMOUS_CAPTURED_AT = '2020-01-01T00:00:00.000Z'
/** What the sim's ATC id becomes. */
export const ANONYMOUS_ATC_ID = 'G-TEST'
/** What BeyondATC's callsign becomes, full and short. */
export const ANONYMOUS_CALLSIGN = { full: 'Test 123', shortForm: 'TST123' }

export interface SliceOptions {
  /** Window start, ms from the capture's start; the slice's offsets restart from here. */
  fromMs?: number
  /** Window end, ms from the capture's start, inclusive. */
  toMs?: number
  /** Captured streams to keep, besides the sim's own (always kept: replay needs telemetry). */
  streams?: CapturedLineEvent['type'][]
  /** Extra text to replace, as [found, replacement], e.g. a flight number in a GSX menu. */
  replacements?: [string, string][]
  scenario: string
  notes: string
}

/** `Callsign: {"full": ..., "shortForm": ...}` from BeyondATC, if the capture has one. */
function capturedCallsign(events: FlightFixtureEvent[]): { full: string; shortForm: string } | null {
  for (const event of events) {
    if (event.type !== 'beyondatc' || event.direction !== 'in') continue
    const match = /^Callsign:\s*(\{.*\})\s*$/m.exec(event.text)
    if (!match) continue
    try {
      const value = JSON.parse(match[1]) as { full?: unknown; shortForm?: unknown }
      if (typeof value.full === 'string' && typeof value.shortForm === 'string') return { full: value.full, shortForm: value.shortForm }
    } catch {
      // A malformed Callsign line names nothing to replace; the next one might.
      continue
    }
  }
  return null
}

/** Every identifier to replace, longest first so a full callsign goes before its short form. */
function replacementsFor(events: FlightFixtureEvent[], extra: [string, string][]): [string, string][] {
  const pairs: [string, string][] = [...extra]
  const callsign = capturedCallsign(events)
  if (callsign) pairs.push([callsign.full, ANONYMOUS_CALLSIGN.full], [callsign.shortForm, ANONYMOUS_CALLSIGN.shortForm])
  const atcIds = new Set(events.flatMap((e) => (e.type === 'telemetry' && e.data.atcId ? [e.data.atcId] : [])))
  for (const atcId of atcIds) pairs.push([atcId, ANONYMOUS_ATC_ID])
  return pairs.filter(([found]) => found.trim() !== '').sort((a, b) => b[0].length - a[0].length)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceAll(text: string, pairs: [string, string][]): string {
  return pairs.reduce((out, [found, replacement]) => out.replace(new RegExp(escapeRegExp(found), 'gi'), replacement), text)
}

/** Drops BeyondATC's `Settings` lines from a (possibly multi-line) message; null if nothing's left. */
function withoutSettings(text: string): string | null {
  const lines = text.split('\n').filter((line) => !/^Settings:/.test(line))
  return lines.some((line) => line.trim() !== '') ? lines.join('\n') : null
}

function anonymised(event: FlightFixtureEvent, pairs: [string, string][]): FlightFixtureEvent | null {
  if (event.type === 'telemetry') {
    const atcId = event.data.atcId ? ANONYMOUS_ATC_ID : event.data.atcId
    return { ...event, data: { ...event.data, atcId } }
  }
  if (event.type === 'paused') return event
  const kept = event.type === 'beyondatc' ? withoutSettings(event.text) : event.text
  return kept === null ? null : { ...event, text: replaceAll(kept, pairs) }
}

/**
 * Returns the anonymised slice. Throws if the window holds no telemetry, which replay can't use.
 */
export function sliceCapture(capture: ParsedFlightFixture, options: SliceOptions): ParsedFlightFixture {
  const fromMs = options.fromMs ?? 0
  const toMs = options.toMs ?? Number.POSITIVE_INFINITY
  const streams = new Set(options.streams ?? ['beyondatc', 'gsx'])
  const pairs = replacementsFor(capture.events, options.replacements ?? [])

  const events = capture.events
    .filter((e) => e.tOffsetMs >= fromMs && e.tOffsetMs <= toMs)
    .filter((e) => e.type === 'telemetry' || e.type === 'paused' || streams.has(e.type))
    .map((e) => anonymised(e, pairs))
    .filter((e): e is FlightFixtureEvent => e !== null)
    .map((e) => ({ ...e, tOffsetMs: e.tOffsetMs - fromMs }))
  if (!events.some((e) => e.type === 'telemetry')) throw new Error(`No telemetry between ${fromMs} and ${toMs} ms`)

  return {
    header: {
      scenario: options.scenario,
      aircraftType: capture.header.aircraftType,
      capturedAt: ANONYMOUS_CAPTURED_AT,
      notes: options.notes
    },
    events
  }
}
