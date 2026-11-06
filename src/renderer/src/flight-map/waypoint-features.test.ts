import { describe, expect, it } from 'vitest'
import type { Waypoint } from '@shared/route'
import { waypointFeatures } from './map-layers'

function waypoint(ident: string, segment: Waypoint['segment']): Waypoint {
  return { ident, lon: 0, lat: 0, altitudeFt: 0, segment }
}

const ROUTE: Waypoint[] = [
  waypoint('DET', 'sid'),
  waypoint('KAMI', 'sid'),
  waypoint('LAM', 'enroute'),
  waypoint('SIER', 'star'),
  waypoint('BUR', 'star'),
  waypoint('IAF', 'approach')
]

describe('waypointFeatures', () => {
  it('tags the first fix of each procedure with its name, and no other fix', () => {
    const { features } = waypointFeatures(ROUTE, { sid: 'DET2G', star: 'SIER7B', approach: 'ILS 27L' })
    expect(features.map((f) => f.properties.tag ?? null)).toEqual([
      'DET2G',
      null,
      null,
      'SIER7B',
      null,
      'ILS 27L'
    ])
  })

  it('tags only what has a name: a procedure the plan does not choose is left alone', () => {
    const { features } = waypointFeatures(ROUTE, { sid: null, star: 'SIER7B', approach: null })
    expect(features.map((f) => f.properties.tag ?? null)).toEqual([null, null, null, 'SIER7B', null, null])
  })

  it('tags nothing without names, and never tags an en route fix', () => {
    expect(waypointFeatures(ROUTE).features.some((f) => 'tag' in f.properties)).toBe(false)
    const enrouteOnly = waypointFeatures([waypoint('LAM', 'enroute')], { sid: 'X', star: 'Y', approach: 'Z' })
    expect(enrouteOnly.features[0]?.properties).toEqual({ ident: 'LAM', segment: 'enroute' })
  })

  it('marks the points along the departure runway as the line’s only, and tags the first real fix of the SID instead', () => {
    const runway = (ident: string): Waypoint => ({ ...waypoint(ident, 'sid'), runwayPoint: true })
    const { features } = waypointFeatures(
      [runway('RW27'), runway(''), waypoint('DET', 'sid'), waypoint('KAMI', 'sid')],
      {
        sid: 'DET2G',
        star: null,
        approach: null
      }
    )
    expect(features.map((f) => f.properties.runway ?? false)).toEqual([true, true, false, false])
    expect(features.map((f) => f.properties.tag ?? null)).toEqual([null, null, 'DET2G', null])
  })

  it('keeps the ident, the segment and the position of every fix', () => {
    const [first] = waypointFeatures([{ ...waypoint('DET', 'sid'), lon: 1.5, lat: 51.2 }], {
      sid: 'DET2G',
      star: null,
      approach: null
    }).features
    expect(first).toMatchObject({
      properties: { ident: 'DET', segment: 'sid', tag: 'DET2G' },
      geometry: { type: 'Point', coordinates: [1.5, 51.2] }
    })
  })
})
