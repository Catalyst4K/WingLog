import { describe, expect, it } from 'vitest'
import { destinationPoint } from '@shared/geo'
import { trafficToShow, type FeedPilot, type FeedSnapshot } from './feed-snapshot'

const CENTRE = { lat: 51.47, lon: -0.46 }
const RECEIVED_MS = 1_000_000

function pilot(callsign: string, distanceM: number, changes: Partial<FeedPilot> = {}): FeedPilot {
  const at = destinationPoint(CENTRE, 45, distanceM)
  return {
    memberId: `10${callsign.length}${distanceM}`,
    callsign,
    latitude: at.lat,
    longitude: at.lon,
    altitudeM: 3000,
    groundSpeedMs: 150,
    headingDeg: 90,
    onGround: false,
    aircraftIcao: 'A320',
    departure: 'EGLL',
    arrival: 'LFPG',
    ageAtFeedS: 3,
    ...changes
  }
}

function snapshot(pilots: FeedPilot[]): FeedSnapshot {
  return {
    network: 'vatsim',
    updatedMs: RECEIVED_MS - 1000,
    receivedMs: RECEIVED_MS,
    pilots,
    controllers: [],
    atis: []
  }
}

describe('trafficToShow', () => {
  const options = { radiusM: 100_000, max: 10, maxWithoutCentre: 50, nowMs: RECEIVED_MS }

  it('keeps the aircraft inside the radius and drops the rest', () => {
    const result = trafficToShow(snapshot([pilot('NEAR', 50_000), pilot('FAR', 150_000)]), CENTRE, options)
    expect(result.map((a) => a.callsign)).toEqual(['NEAR'])
  })

  it('lists the nearest first', () => {
    const result = trafficToShow(
      snapshot([pilot('C', 90_000), pilot('A', 10_000), pilot('B', 40_000)]),
      CENTRE,
      options
    )
    expect(result.map((a) => a.callsign)).toEqual(['A', 'B', 'C'])
  })

  it('cuts the list to the nearest max', () => {
    const many = Array.from({ length: 6 }, (_, i) => pilot(`P${i}`, (i + 1) * 10_000))
    const result = trafficToShow(snapshot(many), CENTRE, { ...options, max: 3 })
    expect(result.map((a) => a.callsign)).toEqual(['P0', 'P1', 'P2'])
  })

  it('leaves out the pilot with the given member number', () => {
    const own = pilot('OWN', 5_000, { memberId: '1234567' })
    const result = trafficToShow(snapshot([own, pilot('OTHER', 8_000)]), CENTRE, {
      ...options,
      excludeMemberId: '1234567'
    })
    expect(result.map((a) => a.callsign)).toEqual(['OTHER'])
  })

  it('leaves nobody out with no member number, and does not confuse a pilot with no number with it', () => {
    const noId = pilot('NOID', 5_000, { memberId: null })
    expect(trafficToShow(snapshot([noId]), CENTRE, options)).toHaveLength(1)
    expect(trafficToShow(snapshot([noId]), CENTRE, { ...options, excludeMemberId: null })).toHaveLength(1)
  })

  it('carries no member number or other field the screens do not draw', () => {
    const [aircraft] = trafficToShow(snapshot([pilot('ONE', 1000)]), CENTRE, options)
    expect(Object.keys(aircraft ?? {}).sort()).toEqual(
      [
        'ageS',
        'aircraftIcao',
        'altitudeM',
        'arrival',
        'callsign',
        'departure',
        'groundSpeedMs',
        'headingDeg',
        'key',
        'latitude',
        'longitude',
        'onGround'
      ].sort()
    )
  })

  it('adds the time since the snapshot was received to the age at the feed', () => {
    const [aircraft] = trafficToShow(snapshot([pilot('ONE', 1000, { ageAtFeedS: 3 })]), CENTRE, {
      ...options,
      nowMs: RECEIVED_MS + 2500
    })
    expect(aircraft?.ageS).toBe(5.5)
  })

  it('never gives a negative extra age if the clock stepped back', () => {
    const [aircraft] = trafficToShow(snapshot([pilot('ONE', 1000, { ageAtFeedS: 3 })]), CENTRE, {
      ...options,
      nowMs: RECEIVED_MS - 5000
    })
    expect(aircraft?.ageS).toBe(3)
  })

  it('is empty for a snapshot with no pilots', () => {
    expect(trafficToShow(snapshot([]), CENTRE, options)).toEqual([])
  })

  describe('with no position to centre on', () => {
    it('shows the whole network, however far away, in the feed’s order', () => {
      const result = trafficToShow(
        snapshot([pilot('FAR', 9_000_000), pilot('NEAR', 1_000), pilot('MID', 400_000)]),
        null,
        options
      )
      expect(result.map((a) => a.callsign)).toEqual(['FAR', 'NEAR', 'MID'])
    })

    it('stops at the most for the whole network, not the most around a point', () => {
      const many = Array.from({ length: 60 }, (_, i) => pilot(`P${i}`, (i + 1) * 500_000))
      expect(trafficToShow(snapshot(many), null, options)).toHaveLength(50)
    })

    it('still leaves out the pilot’s own aircraft, by member number or callsign', () => {
      const own = pilot('OWN', 5_000, { memberId: '1234567' })
      const byPlan = pilot('PLAN1', 6_000)
      const result = trafficToShow(snapshot([own, byPlan, pilot('OTHER', 8_000)]), null, {
        ...options,
        excludeMemberId: '1234567',
        excludeCallsign: 'PLAN1'
      })
      expect(result.map((a) => a.callsign)).toEqual(['OTHER'])
    })
  })
})
