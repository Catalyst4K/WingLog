import { describe, expect, it } from 'vitest'
import type { SimTrafficRecord } from '../sim/simvars'
import { TRAFFIC_MAX_AIRCRAFT } from './feed-snapshot'
import { simTrafficAircraft } from './sim-traffic'

function record(overrides: Partial<SimTrafficRecord> & { objectId: number }): SimTrafficRecord {
  return {
    latitude: 33.94,
    longitude: -118.41,
    altitudeM: 3048,
    headingDeg: 270,
    groundSpeedMs: 128.6,
    onGround: false,
    atcId: 'UAL2763',
    title: 'FSLTL_B738_UAL',
    ...overrides
  }
}

const USER = record({ objectId: 1, atcId: 'N12345', title: 'A350-900 ULR' })

describe('simTrafficAircraft', () => {
  it('turns a record into an aircraft keyed by its object id, with nothing known about the route', () => {
    const [aircraft] = simTrafficAircraft([USER, record({ objectId: 42 })], 1)
    expect(aircraft).toEqual({
      key: '42',
      callsign: 'UAL2763',
      latitude: 33.94,
      longitude: -118.41,
      altitudeM: 3048,
      groundSpeedMs: 128.6,
      headingDeg: 270,
      onGround: false,
      aircraftIcao: null,
      departure: null,
      arrival: null,
      ageS: 0
    })
  })

  it("leaves out the user's own aircraft", () => {
    const keys = simTrafficAircraft([USER, record({ objectId: 2 })], 1).map((a) => a.key)
    expect(keys).toEqual(['2'])
  })

  it('leaves out ApronLife scenery, whatever case its title is in, and keeps other add-on aircraft', () => {
    const records = [
      USER,
      record({ objectId: 2, title: 'ApronLife_JetwayHelper_A', atcId: 'SS0226' }),
      record({ objectId: 3, title: 'apronlife_Stairs' }),
      record({ objectId: 4, title: 'Asobo PassiveAircraft' })
    ]
    expect(simTrafficAircraft(records, 1).map((a) => a.key)).toEqual(['4'])
  })

  it('leaves out an aircraft with no real position', () => {
    const records = [
      USER,
      record({ objectId: 2, latitude: Number.NaN }),
      record({ objectId: 3, longitude: 400 }),
      record({ objectId: 4, latitude: -91 }),
      record({ objectId: 5 })
    ]
    expect(simTrafficAircraft(records, 1).map((a) => a.key)).toEqual(['5'])
  })

  it('puts the nearest first and keeps at most the cap', () => {
    const many = Array.from({ length: TRAFFIC_MAX_AIRCRAFT + 20 }, (_, i) =>
      record({ objectId: 100 + i, latitude: 33.94 + (i + 1) * 0.001 })
    )
    const result = simTrafficAircraft([USER, ...many.reverse()], 1)
    expect(result).toHaveLength(TRAFFIC_MAX_AIRCRAFT)
    expect(result[0].key).toBe('100')
    expect(result.at(-1)?.key).toBe(String(100 + TRAFFIC_MAX_AIRCRAFT - 1))
  })

  it('cuts a long ATC id and trims spaces', () => {
    const [aircraft] = simTrafficAircraft([USER, record({ objectId: 2, atcId: '  ABCDEFGHIJKLMNOP  ' })], 1)
    expect(aircraft.callsign).toBe('ABCDEFGHIJKL')
  })

  it("still lists aircraft while the user's id is not known yet", () => {
    expect(simTrafficAircraft([record({ objectId: 2 }), record({ objectId: 3 })], null)).toHaveLength(2)
  })
})
