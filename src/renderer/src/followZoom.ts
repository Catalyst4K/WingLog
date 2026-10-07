/**
 * The zoom Track's map follows the aircraft at, by phase of flight (winglog-backend's
 * docs/plans/map-follow-zoom-and-load.md). On the ground it's close enough to read the taxi
 * chart; in the air it steps out with altitude (Callum, 2026-10-02: one fixed airborne zoom
 * was too close once airborne, and no SID fixes were on screen after takeoff).
 */

import type { TrackPoint } from '@shared/ipc'

const FT = 0.3048

export const FOLLOW_ZOOM_GROUND = 15

/** Airborne bands, lowest first: below 10,000 ft, 10,000 ft to FL250, above FL250.
 *  Pressure altitude, so a QNH change at transition can't move a band. */
const AIRBORNE_BANDS: { topM: number; zoom: number }[] = [
  { topM: 10_000 * FT, zoom: 11 },
  { topM: 25_000 * FT, zoom: 10 },
  { topM: Infinity, zoom: 9 }
]

/** How far past a band edge the aircraft must be before the band changes, so levelling off
 *  near 10,000 ft or FL250 doesn't flick the zoom back and forth. */
const BAND_HYSTERESIS_M = 500 * FT

/** 'ground', or the index of an airborne band. */
export type FollowBand = 'ground' | number

type BandInput = Pick<TrackPoint, 'onGround' | 'altitudeM' | 'pressureAltitudeM'>

function rawAirborneBand(altitudeM: number): number {
  return AIRBORNE_BANDS.findIndex((band) => altitudeM < band.topM)
}

/**
 * The band for this sample, staying in `previous` while the aircraft is still within the
 * hysteresis margin of it.
 *
 * @param point The aircraft's altitude and whether it is on the ground.
 * @param previous The band it was in, or null.
 * @returns The band.
 */
export function followBand(point: BandInput, previous: FollowBand | null): FollowBand {
  if (point.onGround) return 'ground'
  // Older rows have no pressure altitude; true altitude is close enough for picking a zoom.
  const altitudeM = point.pressureAltitudeM ?? point.altitudeM
  if (typeof previous === 'number') {
    const bottomM = previous === 0 ? -Infinity : AIRBORNE_BANDS[previous - 1]!.topM
    const topM = AIRBORNE_BANDS[previous]!.topM
    if (altitudeM >= bottomM - BAND_HYSTERESIS_M && altitudeM < topM + BAND_HYSTERESIS_M) return previous
  }
  return rawAirborneBand(altitudeM)
}

/**
 * @param band The band.
 * @returns The map zoom for it.
 */
export function zoomForBand(band: FollowBand): number {
  return band === 'ground' ? FOLLOW_ZOOM_GROUND : AIRBORNE_BANDS[band]!.zoom
}
