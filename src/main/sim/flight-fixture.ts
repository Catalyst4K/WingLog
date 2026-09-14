import type { SimTelemetry } from '@shared/ipc'

/**
 * NDJSON fixture format shared by the flight capture script
 * (scripts/spike-capture-flight.ts) and ReplaySimConnectService — one source of truth for
 * the shape flightdeck-backend's docs/plans/flight-replay-harness.md Design §1 specifies,
 * so a change to one side can't silently drift from the other.
 */
export interface FlightFixtureHeader {
  scenario: string
  aircraftType: string
  capturedAt: string
  notes: string
}

export type FlightFixtureEvent =
  | { type: 'telemetry'; tOffsetMs: number; data: SimTelemetry }
  | { type: 'paused'; tOffsetMs: number; value: boolean }

export interface ParsedFlightFixture {
  header: FlightFixtureHeader
  events: FlightFixtureEvent[]
}

/** Parses an already-read NDJSON fixture (header line, then one event per line). Throws on
 *  an empty file or a fixture with no telemetry events at all — both unusable for replay. */
export function parseFlightFixture(ndjson: string): ParsedFlightFixture {
  const lines = ndjson.trim().split('\n').filter((line) => line.length > 0)
  if (lines.length === 0) throw new Error('Empty fixture file')

  const header = JSON.parse(lines[0]) as FlightFixtureHeader
  const events = lines.slice(1).map((line) => JSON.parse(line) as FlightFixtureEvent)
  if (!events.some((e) => e.type === 'telemetry')) {
    throw new Error('Fixture has no telemetry events')
  }
  return { header, events }
}
