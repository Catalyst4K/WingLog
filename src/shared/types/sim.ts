/** The sim connection and its live telemetry. */

/**
 * Live sim telemetry, in SI units throughout (meters, m/s, kg, degrees) per
 * docs/decisions.md §5 — convert to aviation units only at the UI layer.
 */
export interface SimTelemetry {
  latitude: number
  longitude: number
  altitudeM: number
  /** Barometric altitude with the Kohlsman set to standard (1013.25 mb/29.92 in) —
   *  logbook-detail-improvements.md Phase 3: what a correctly-flown PFD reads above the
   *  transition altitude, independent of each aircraft's own altimeter implementation
   *  (confirmed real and trustworthy for this live, winglog-backend's
   *  docs/simconnect-notes.md, 2026-09-13 entry — unlike INDICATED ALTITUDE, which depends
   *  on the aircraft's own Kohlsman setting and produced the -13,500 ft chart bug this
   *  field exists to avoid repeating). */
  pressureAltitudeM: number
  altitudeAglM: number
  verticalSpeedMs: number
  indicatedAirspeedMs: number
  trueAirspeedMs: number
  machSpeed: number
  groundSpeedMs: number
  headingTrueDeg: number
  pitchDeg: number
  bankDeg: number
  onGround: boolean
  gForce: number
  fuelTotalKg: number
  totalWeightKg: number
  windSpeedMs: number
  windDirectionDeg: number
  engineCombustion1: boolean
  gearHandlePosition: number
  flapsHandleIndex: number
  parkingBrakeOn: boolean
  /** Autopilot selected altitude (AUTOPILOT ALTITUDE LOCK VAR). Optional: flights captured
   *  before it existed (replay fixtures) don't carry it. */
  apSelectedAltitudeM?: number
  atcId: string
  atcModel: string
  title: string
  simRate: number
  slewActive: boolean
}

export type SimConnectionStatus =
  { state: 'disconnected' } | { state: 'connecting' } | { state: 'connected'; simConnectVersion: string }
