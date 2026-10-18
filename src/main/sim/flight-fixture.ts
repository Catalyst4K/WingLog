/**
 * The recorded-flight format: a header line, then one timestamped event per line (sim telemetry,
 * pause, BeyondATC and GSX messages). Shared by the capture, the replay and the fixture tools.
 */
import type { SimTelemetry } from '@shared/ipc'

/**
 * NDJSON fixture format shared by the flight capture script
 * (scripts/spike-capture-flight.ts) and ReplaySimConnectService — one source of truth for
 * the shape winglog-backend's docs/plans/flight-replay-harness.md Design §1 specifies,
 * so a change to one side can't silently drift from the other.
 */
export interface FlightFixtureHeader {
  scenario: string
  aircraftType: string
  capturedAt: string
  notes: string
}

/** One BeyondATC or GSX message, unparsed, in or out, written by the dev build's full capture
 *  (src/main/diagnostics/flight-capture.ts). replay-capture.ts feeds the incoming ones to the
 *  services (winglog-backend robustness/scenario-testing.md Part 1). */
export interface CapturedLineEvent {
  type: 'beyondatc' | 'gsx'
  tOffsetMs: number
  direction: 'in' | 'out'
  text: string
}

export type FlightFixtureEvent =
  | { type: 'telemetry'; tOffsetMs: number; data: SimTelemetry }
  | { type: 'paused'; tOffsetMs: number; value: boolean }
  | CapturedLineEvent

export interface ParsedFlightFixture {
  header: FlightFixtureHeader
  events: FlightFixtureEvent[]
}

/** Parses an already-read NDJSON fixture (header line, then one event per line). Throws on
 *  an empty file or a fixture with no telemetry events at all — both unusable for replay.
 *
 * @param ndjson The file's text.
 * @returns The header and events.
 * @throws On an empty file, or one with no telemetry.
 */
export function parseFlightFixture(ndjson: string): ParsedFlightFixture {
  const lines = ndjson
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
  if (lines.length === 0) throw new Error('Empty fixture file')

  const header = JSON.parse(lines[0]) as FlightFixtureHeader
  const events = lines.slice(1).map((line) => JSON.parse(line) as FlightFixtureEvent)
  if (!events.some((e) => e.type === 'telemetry')) {
    throw new Error('Fixture has no telemetry events')
  }
  return { header, events }
}

/**
 * The NDJSON text of a fixture, as parseFlightFixture reads it back.
 *
 * @param fixture The fixture.
 * @returns The NDJSON text, ending with a newline.
 */
export function formatFlightFixture(fixture: ParsedFlightFixture): string {
  return [fixture.header, ...fixture.events].map((line) => JSON.stringify(line)).join('\n') + '\n'
}
