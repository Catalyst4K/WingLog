/**
 * Everything flight tracking reads from and writes to the logbook, as one narrow interface
 * (winglog-backend docs/coding-standards.md §9): tracking is host side, the database app side.
 * The app's implementation is src/main/db/flight-store.ts; a future host on the sim PC can send
 * the same operations to wherever the logbook lives.
 */
import type {
  Flight,
  NavdataRunway,
  NewFreeFlightInput,
  NewLanding,
  NewTrackPoint,
  PausedInterval,
  ProcedureSelection,
  TrackPoint
} from '@shared/ipc'
import type { TrackCleanupResult } from './resume-cleanup'

/** The logbook operations TrackingController uses. Every id is a flight's. */
export interface FlightStore {
  getFlight(flightId: number): Flight | undefined
  /** A planned flight goes active: off-blocks time and fuel out (kg). */
  startFlight(flightId: number, fuelOutKg: number): void
  /** A free flight, created straight away as active. */
  createFreeFlight(input: NewFreeFlightInput): Flight
  /** Deletes a flight that never got going. */
  abandonFlight(flightId: number): void
  /** Fuel out (kg) as measured at the first real movement. */
  finalizeFuelOut(flightId: number, fuelOutKg: number): void
  /** Takeoff time, now. */
  recordOff(flightId: number): void
  /** Landing time, now. */
  recordOn(flightId: number): void
  /** On-blocks: fuel in (kg) and the time spent paused. */
  completeFlight(flightId: number, fuelInKg: number, pausedIntervals: PausedInterval[]): void
  setArrIcao(flightId: number, icao: string): void
  setDepIcao(flightId: number, icao: string): void
  /** The simplified flown route, as JSON. */
  setFlownRoute(flightId: number, flownRouteJson: string): void
  setSelectedProcedures(flightId: number, selection: ProcedureSelection): void
  /** Stores one track point; returns it with its id. */
  addTrackPoint(point: NewTrackPoint): TrackPoint
  listTrackPoints(flightId: number): TrackPoint[]
  addLanding(landing: NewLanding): void
  countLandings(flightId: number): number
  /** An airport's cached runways, empty when none are cached. */
  listRunways(icao: string): NavdataRunway[]
  /** The fleet aircraft to suggest next time this sim title is flown. */
  rememberAircraftForTitle(title: string, aircraftId: number): void
  /** Runs the track cleanup over the stored track and saves it; undefined when nothing changed. */
  cleanUpTrack(flightId: number): TrackCleanupResult | undefined
  /** Matches GSX's receipts to the flight, in the background; a no-op when GSX is off. */
  saveGsxInvoices(flightId: number): void
}
