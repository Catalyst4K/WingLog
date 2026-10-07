/**
 * Runs a capture (base or transformed) through the real main-process pieces, wired as
 * `src/main/index.ts` wires them, and records what the app knew after every event, for the rules
 * to check (winglog-backend docs/plans/robustness/scenario-testing.md Parts 1 and 2).
 *
 * Runs under vitest only: TrackingController's landing capture imports CSVs through Vite.
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type {
  BeyondAtcArrivalClearance,
  BeyondAtcInfoBox,
  FlightPhase,
  SimTelemetry
} from '../../src/shared/ipc'
import { ArrivalClearanceTracker } from '../../src/main/beyondatc/arrival-clearance'
import { BeyondAtcService } from '../../src/main/beyondatc/BeyondAtcService'
import { createAircraft } from '../../src/main/db/aircraft-repo'
import { createDb, type WingLogDb } from '../../src/main/db/client'
import { createFlight, getFlight } from '../../src/main/db/flight-repo'
import { listCachedProcedures } from '../../src/main/db/navdata-repo'
import { GsxRemoteService } from '../../src/main/gsx-remote/GsxRemoteService'
import type { ParsedFlightFixture } from '../../src/main/sim/flight-fixture'
import { replayCapture } from '../../src/main/sim/replay-capture'
import { TrackingController } from '../../src/main/tracking/TrackingController'
import { dbFlightStore } from '../../src/main/db/flight-store'

/** What the app knew just after one event of the capture. */
export interface Sample {
  tOffsetMs: number
  event: 'telemetry' | 'paused' | 'beyondatc' | 'gsx'
  /** The tracked flight's phase; null once tracking has ended. */
  phase: FlightPhase | null
  /** The latest sim tick. */
  telemetry: SimTelemetry
  infoBoxes: BeyondAtcInfoBox[]
  assignedGate: string | null
  /** The BeyondATC tab's arrival card. */
  arrival: BeyondAtcArrivalClearance | null
}

export interface ScenarioSetup {
  depIcao: string
  arrIcao: string
  /** Fills the database before the flight starts (cached runways, procedures). */
  seed?: (db: WingLogDb) => void
  /** Sets the test's fake clock; see replayCapture's setClock. */
  setClock?: (epochMs: number) => void
}

export interface ScenarioResult {
  samples: Sample[]
  /** The flight row at the end. */
  flight: ReturnType<typeof getFlight>
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Plays the capture to its end and returns the timeline. */
export async function runScenario(
  capture: ParsedFlightFixture,
  setup: ScenarioSetup
): Promise<ScenarioResult> {
  const { db } = createDb(':memory:')
  migrate(db, { migrationsFolder: 'drizzle' })
  setup.seed?.(db)
  const replay = replayCapture(capture, { mode: 'instant', setClock: setup.setClock })
  const aircraft = createAircraft(db, { registration: 'SCENARIO', icaoType: replay.sim.header.aircraftType })
  const flightId = createFlight(db, {
    aircraftId: aircraft.id,
    depIcao: setup.depIcao,
    arrIcao: setup.arrIcao
  }).id

  const beyondAtc = new BeyondAtcService('replay', undefined, replay.beyondAtc.socketCtor)
  const gsx = new GsxRemoteService('replay', 0, replay.gsx.socketCtor)
  const arrival = new ArrivalClearanceTracker({
    getArrivalIcao: () => setup.arrIcao,
    listApproaches: (icao) => listCachedProcedures(db, icao, 'approach', null)
  })
  beyondAtc.on('state', (state) => arrival.onInfoBoxes(state.infoBoxes))
  const controller = new TrackingController(dbFlightStore(db), replay.sim)
  controller.on('point', (point) => arrival.onPhase(point.phase))

  const samples: Sample[] = []
  const sample = (tOffsetMs: number, event: Sample['event']): void => {
    const state = beyondAtc.getState()
    samples.push({
      tOffsetMs,
      event,
      phase: controller.getActive()?.phase ?? null,
      telemetry: replay.sim.getLastTelemetry() as SimTelemetry,
      infoBoxes: state.infoBoxes,
      assignedGate: state.assignedGate,
      arrival: arrival.getClearance()
    })
  }
  // Registered after the app's own listeners, so each sample sees the event's effect.
  let offset = 0
  replay.sim.on('offset', (tOffsetMs) => (offset = tOffsetMs))
  replay.sim.on('telemetry', () => sample(offset, 'telemetry'))
  replay.sim.on('paused', () => sample(offset, 'paused'))
  replay.sim.on('captured', (event) => {
    if (event.direction === 'in') sample(offset, event.type)
  })

  beyondAtc.start()
  gsx.start()
  await nextTurn()
  controller.start(flightId)
  const done = new Promise<void>((resolve) => replay.sim.on('replayComplete', resolve))
  replay.sim.start()
  await done
  beyondAtc.stop()
  gsx.stop()
  return { samples, flight: getFlight(db, flightId) }
}
