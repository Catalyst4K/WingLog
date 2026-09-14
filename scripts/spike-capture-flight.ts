/**
 * Phase 0 spike (flightdeck-backend/docs/plans/flight-replay-harness.md): capture a real
 * MSFS flight's telemetry to an NDJSON fixture, for the replay harness (Phase 1) to consume.
 *
 * Plain tsx, no Electron — `SimConnectService` itself has no better-sqlite3/Electron
 * dependency, so this taps it directly instead of re-deriving the raw SimVar reads
 * spike-simconnect.ts does. That keeps the SimVar list centralized in simvars.ts per
 * CLAUDE.md ("don't scatter SimVar strings") and guarantees the captured shape matches
 * exactly what TrackingController receives live — the whole point of a replay fixture.
 *
 * Output format (see the plan doc's Design §1): a header line, then one line per event,
 * timestamped relative to capture start (tOffsetMs) rather than wall-clock, so replay
 * timing is independent of when it was recorded.
 *   {scenario, aircraftType, capturedAt, notes}
 *   {type: 'telemetry', tOffsetMs, data: SimTelemetry}
 *   {type: 'paused', tOffsetMs, value: boolean}
 *
 * Usage:
 *   npm run spike:capture-flight -- <scenario-name> [notes...]
 * Example:
 *   npm run spike:capture-flight -- tier1-short-hop Pushback to shutdown, YSSY-YSSY
 *
 * Env vars:
 *   SPIKE_CAPTURE_OUTPUT    override the output file path (default: flight-captures/<scenario>-<timestamp>.ndjson)
 *   SPIKE_CAPTURE_AIRCRAFT  override the header's aircraftType (default: the first tick's sim TITLE)
 *
 * No SIMCONNECT_HOST/PORT here — SimConnectService only connects to a local sim, unlike the
 * raw spike scripts. Fly on the same machine this runs on.
 *
 * Ctrl+C stops the capture cleanly and prints a summary. Raw captures are real flight data
 * (real coordinates, real times) — CLAUDE.md's Security section: they stay local, under
 * flight-captures/ (gitignored), never committed as-is. A trimmed/anonymized fixture derived
 * from one is what actually lands in the test suite — that scrubbing step isn't built yet,
 * per the plan doc's Design §4.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SimConnectService } from '../src/main/sim/SimConnectService'
import type { SimTelemetry } from '@shared/ipc'

const scenario = process.argv[2]
if (!scenario) {
  console.error('Usage: npm run spike:capture-flight -- <scenario-name> [notes...]')
  process.exit(1)
}
const notes = process.argv.slice(3).join(' ')
const aircraftOverride = process.env['SPIKE_CAPTURE_AIRCRAFT']

const capturedAt = new Date().toISOString()
const outputPath =
  process.env['SPIKE_CAPTURE_OUTPUT'] ??
  `flight-captures/${scenario}-${capturedAt.replace(/[:.]/g, '-')}.ndjson`

mkdirSync(dirname(outputPath), { recursive: true })

const startedAt = Date.now()
let headerWritten = false
let tickCount = 0
let pauseEventCount = 0

function writeHeaderOnce(telemetry: SimTelemetry): void {
  if (headerWritten) return
  headerWritten = true
  const header = { scenario, aircraftType: aircraftOverride ?? telemetry.title, capturedAt, notes }
  writeFileSync(outputPath, JSON.stringify(header) + '\n')
  console.log(`Capturing to ${outputPath}`)
  console.log(`Header: ${JSON.stringify(header)}`)
}

function appendEvent(event: unknown): void {
  appendFileSync(outputPath, JSON.stringify(event) + '\n')
}

const sim = new SimConnectService()

sim.on('status', (status) => {
  console.log(`[status] ${JSON.stringify(status)}`)
})

sim.on('telemetry', (telemetry) => {
  writeHeaderOnce(telemetry)
  tickCount += 1
  appendEvent({ type: 'telemetry', tOffsetMs: Date.now() - startedAt, data: telemetry })
  if (tickCount % 30 === 0) {
    console.log(
      `[${tickCount} ticks, ${Math.round((Date.now() - startedAt) / 1000)}s] ` +
        `alt=${Math.round(telemetry.altitudeM)}m gs=${Math.round(telemetry.groundSpeedMs)}m/s onGround=${telemetry.onGround}`
    )
  }
})

sim.on('paused', (paused) => {
  pauseEventCount += 1
  console.log(`[paused] ${paused}`)
  appendEvent({ type: 'paused', tOffsetMs: Date.now() - startedAt, value: paused })
})

console.log(`Waiting for MSFS... (scenario "${scenario}")`)
sim.start()

process.on('SIGINT', () => {
  console.log(
    `\nStopping capture. ${tickCount} ticks, ${pauseEventCount} pause event(s) written to ${outputPath}`
  )
  if (!headerWritten) {
    console.warn('No telemetry was ever received — the sim likely never connected. Output file was not created.')
  }
  sim.stop()
  process.exit(0)
})
