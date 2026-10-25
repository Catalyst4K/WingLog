import { describe, expect, it } from 'vitest'
import type { TrafficAircraft } from '@shared/ipc'
import { popupLines, trafficFeatures, type TrafficFeatureProperties } from './traffic-features'

function aircraft(changes: Partial<TrafficAircraft> = {}): TrafficAircraft {
  return {
    key: 'BAW1',
    callsign: 'BAW1',
    latitude: 51,
    longitude: -1,
    altitudeM: 10_668,
    groundSpeedMs: 231.5,
    headingDeg: 90,
    onGround: false,
    aircraftIcao: 'A320',
    departure: 'EGLL',
    arrival: 'LFPG',
    ageS: 0,
    ...changes
  }
}

function properties(changes: Partial<TrafficFeatureProperties> = {}): TrafficFeatureProperties {
  return {
    callsign: 'BAW1',
    headingDeg: 90,
    onGround: false,
    aircraftIcao: 'A320',
    departure: 'EGLL',
    arrival: 'LFPG',
    altitudeM: 10_668,
    groundSpeedMs: 231.5,
    ...changes
  }
}

describe('trafficFeatures', () => {
  it('makes one point per aircraft, [lon, lat], with what the layers and popup need', () => {
    const { features } = trafficFeatures([aircraft()], 0)
    expect(features).toHaveLength(1)
    expect(features[0]?.geometry).toEqual({ type: 'Point', coordinates: [-1, 51] })
    expect(features[0]?.properties).toMatchObject({
      callsign: 'BAW1',
      headingDeg: 90,
      onGround: false,
      aircraftIcao: 'A320'
    })
  })

  it('moves an airborne aircraft on from its reported position, and not one on the ground', () => {
    const { features } = trafficFeatures(
      [aircraft(), aircraft({ key: 'G', callsign: 'G', onGround: true })],
      10
    )
    expect(features[0]?.geometry.coordinates[0]).toBeGreaterThan(-1)
    expect(features[1]?.geometry.coordinates).toEqual([-1, 51])
  })

  it('uses empty text for an unknown type or airport, so the popup can leave it out', () => {
    const { features } = trafficFeatures(
      [aircraft({ aircraftIcao: null, departure: null, arrival: null })],
      0
    )
    expect(features[0]?.properties).toMatchObject({ aircraftIcao: '', departure: '', arrival: '' })
  })

  it('is empty for no aircraft', () => {
    expect(trafficFeatures([], 5).features).toEqual([])
  })
})

describe('popupLines', () => {
  it('gives the callsign, the type and route, then the altitude in feet and the speed in knots', () => {
    expect(popupLines(properties(), 'On the ground')).toEqual([
      'BAW1',
      'A320 · EGLL → LFPG',
      '35,000 ft · 450 kt'
    ])
  })

  it('says the given text on the ground, instead of altitude and speed', () => {
    expect(popupLines(properties({ onGround: true }), 'Am Boden')).toEqual([
      'BAW1',
      'A320 · EGLL → LFPG',
      'Am Boden'
    ])
  })

  it('leaves out what is unknown, and marks one missing airport with ?', () => {
    expect(popupLines(properties({ aircraftIcao: '', departure: '', arrival: '' }), 'x')).toEqual([
      'BAW1',
      '35,000 ft · 450 kt'
    ])
    expect(popupLines(properties({ departure: '' }), 'x')[1]).toBe('A320 · ? → LFPG')
    expect(popupLines(properties({ aircraftIcao: '', arrival: '' }), 'x')[1]).toBe('EGLL → ?')
  })
})
