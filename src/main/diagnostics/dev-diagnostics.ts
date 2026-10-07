/**
 * Connects the dev build's diagnostics to the app: what each source logs to `diag.log`, and
 * what goes into the flight capture (winglog-backend docs/plans/robustness/dev-build.md and
 * scenario-testing.md Part 1). Only constructed in the dev build (`src/main/index.ts`); the
 * sources themselves know nothing about it, they just emit events.
 */
import type { BeyondAtcState, BeyondAtcTranscriptEntry, FlightPhase, SimTelemetry } from '@shared/ipc'
import { parseAtcTaxiFacts } from '@shared/atc-info-boxes'
import { parseTaxiHoldShortRunway } from '@shared/taxi-route-parser'
import type { Diag } from './diag'
import type { FlightCapture } from './flight-capture'

type Listener<A extends unknown[]> = (...args: A) => void

/** The tracking events used, as TrackingController emits them. */
export interface TrackingEvents {
  on(event: 'started' | 'stopped' | 'completed', listener: Listener<[number]>): unknown
  on(
    event: 'phaseChanged',
    listener: Listener<[{ from: FlightPhase; to: FlightPhase; telemetry: SimTelemetry }]>
  ): unknown
}

/** The sim events used, as SimConnectService and ReplaySimConnectService emit them. */
export interface SimEvents {
  on(event: 'telemetry', listener: Listener<[SimTelemetry]>): unknown
  on(event: 'paused', listener: Listener<[boolean]>): unknown
  getLastTelemetry(): SimTelemetry | undefined
}

type RawMessage = { direction: 'in' | 'out'; text: string }

/** The BeyondATC events used, as BeyondAtcService emits them. */
export interface BeyondAtcEvents {
  on(event: 'raw', listener: Listener<[RawMessage]>): unknown
  on(event: 'state', listener: Listener<[BeyondAtcState]>): unknown
  on(event: 'transcript', listener: Listener<[BeyondAtcTranscriptEntry[]]>): unknown
}

/** The GSX events used, as GsxRemoteService emits them. */
export interface GsxEvents {
  on(event: 'raw', listener: Listener<[RawMessage]>): unknown
}

/**
 * Wires the dev build's diagnostics: the diag log and the flight capture.
 */
export class DevDiagnostics {
  /** The last InfoBoxes logged, as JSON, so only a change is logged again. */
  private lastInfoBoxes = ''
  /** The newest transcript line already logged. */
  private lastTranscriptTs = 0

  constructor(
    private readonly diag: Diag,
    private readonly capture: FlightCapture
  ) {}

  /**
   * Records each tracked flight, and logs every phase change with the tick that caused it.
   *
   * @param tracking The tracking controller.
   * @param sim The sim connection.
   */
  attachTracking(tracking: TrackingEvents, sim: SimEvents): void {
    tracking.on('started', (flightId) => {
      const path = this.capture.start(flightId, sim.getLastTelemetry()?.title ?? 'unknown')
      this.diag('capture', `started for flight ${flightId}`, { path })
    })
    const finish = (how: string) => (flightId: number) => {
      this.capture.stop()
      this.diag('capture', `${how}: flight ${flightId}`)
    }
    tracking.on('completed', finish('completed'))
    tracking.on('stopped', finish('stopped'))
    tracking.on('phaseChanged', ({ from, to, telemetry: t }) => {
      this.diag('phase', `${from} -> ${to}`, {
        onGround: t.onGround,
        groundSpeedMs: t.groundSpeedMs,
        altitudeAglM: t.altitudeAglM,
        verticalSpeedMs: t.verticalSpeedMs,
        lat: t.latitude,
        lon: t.longitude
      })
    })
    sim.on('telemetry', (telemetry) => {
      if (this.capture.isRecording) this.capture.telemetry(telemetry)
    })
    sim.on('paused', (paused) => {
      if (this.capture.isRecording) this.capture.paused(paused)
      this.diag('phase', paused ? 'sim paused' : 'sim resumed')
    })
  }

  /**
   * Records and logs every BeyondATC message, and logs what WingLog read from each clearance.
   *
   * @param service The BeyondATC service.
   */
  attachBeyondAtc(service: BeyondAtcEvents): void {
    service.on('raw', ({ direction, text }) => {
      if (this.capture.isRecording) this.capture.beyondAtc(direction, text)
      this.diag('beyondatc', direction, text)
    })
    service.on('state', (state) => {
      const boxes = JSON.stringify(state.infoBoxes)
      if (boxes === this.lastInfoBoxes) return
      this.lastInfoBoxes = boxes
      this.diag('atc', 'InfoBoxes', { boxes: state.infoBoxes, taxi: parseAtcTaxiFacts(state.infoBoxes) })
    })
    service.on('transcript', (transcript) => {
      for (const entry of transcript) {
        if (entry.ts <= this.lastTranscriptTs) continue
        this.lastTranscriptTs = entry.ts
        if (entry.speaker !== 'atc') continue
        this.diag('atc', entry.text, { holdShortRunway: parseTaxiHoldShortRunway(entry.text) })
      }
    })
  }

  /**
   * Records and logs every GSX message and command.
   *
   * @param service The GSX Remote service.
   */
  attachGsx(service: GsxEvents): void {
    service.on('raw', ({ direction, text }) => {
      if (this.capture.isRecording) this.capture.gsx(direction, text)
      this.diag('gsx', direction, text)
    })
  }
}
