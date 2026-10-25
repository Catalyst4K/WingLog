/**
 * The map's GeoJSON for traffic aircraft, and the text of the popup a click opens. Pure. Every string here came from a network feed, so
 * the popup is built from text nodes only (see use-network-traffic-overlay.ts): nothing in it is ever parsed as HTML.
 */
import type { Feature, FeatureCollection, Point } from 'geojson'
import { glidePosition } from '@shared/traffic-glide'
import type { TrafficAircraft } from '@shared/ipc'
import { mToFt, msToKt } from '../units'

/** What a traffic symbol carries for the layers and the popup. */
export interface TrafficFeatureProperties {
  callsign: string
  headingDeg: number
  onGround: boolean
  aircraftIcao: string
  departure: string
  arrival: string
  altitudeM: number
  groundSpeedMs: number
}

/**
 * @param aircraft The aircraft as published.
 * @param secondsSinceReceived Seconds since this screen received them, on its own clock.
 * @returns One point per aircraft, glided on from its reported position.
 */
export function trafficFeatures(
  aircraft: TrafficAircraft[],
  secondsSinceReceived: number
): FeatureCollection<Point, TrafficFeatureProperties> {
  const features: Feature<Point, TrafficFeatureProperties>[] = aircraft.map((a) => {
    const at = glidePosition(a, secondsSinceReceived)
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [at.lon, at.lat] },
      properties: {
        callsign: a.callsign,
        headingDeg: a.headingDeg,
        onGround: a.onGround,
        aircraftIcao: a.aircraftIcao ?? '',
        departure: a.departure ?? '',
        arrival: a.arrival ?? '',
        altitudeM: a.altitudeM,
        groundSpeedMs: a.groundSpeedMs
      }
    }
  })
  return { type: 'FeatureCollection', features }
}

/**
 * The lines of an aircraft's popup.
 *
 * @param properties The clicked symbol's properties.
 * @param onGroundText What to say for an aircraft on the ground (translated by the caller).
 * @returns The callsign, then the type and route, then the altitude and speed. Lines with nothing to say are left out.
 */
export function popupLines(properties: TrafficFeatureProperties, onGroundText: string): string[] {
  const route =
    properties.departure || properties.arrival
      ? `${properties.departure || '?'} → ${properties.arrival || '?'}`
      : ''
  const identity = [properties.aircraftIcao, route].filter((part) => part !== '').join(' · ')
  const motion = properties.onGround
    ? onGroundText
    : `${Math.round(mToFt(properties.altitudeM)).toLocaleString()} ft · ${Math.round(msToKt(properties.groundSpeedMs))} kt`
  return [properties.callsign, identity, motion].filter((line) => line !== '')
}
