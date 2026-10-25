import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { destinationPoint } from '@shared/geo'
import { detectSelf, PROBABLY_RADIUS_NM, type SelfQuery } from './detect-self'
import type { FeedPilot, FeedSnapshot } from './feed-snapshot'
import { parseVatsimFeed } from './vatsim-feed'

const HERE = { lat: 51.47, lon: -0.46 }

function pilot(callsign: string, changes: Partial<FeedPilot> = {}): FeedPilot {
  return {
    memberId: null,
    callsign,
    latitude: HERE.lat,
    longitude: HERE.lon,
    altitudeM: 0,
    groundSpeedMs: 0,
    headingDeg: 0,
    onGround: true,
    aircraftIcao: 'A320',
    departure: 'EGLL',
    arrival: 'LFPG',
    ageAtFeedS: 0,
    ...changes
  }
}

function snapshot(...pilots: FeedPilot[]): FeedSnapshot {
  return { network: 'vatsim', updatedMs: 0, receivedMs: 0, pilots, controllers: [], atis: [] }
}

const NO_QUERY: SelfQuery = { memberId: null, flight: null, position: null, pretendCallsign: null }
const FLIGHT = { departure: 'EGLL', arrival: 'LFPG' }

describe('detectSelf', () => {
  describe('by member number', () => {
    it('is online, with the callsign and the filed plan', () => {
      const match = detectSelf(snapshot(pilot('OTHER'), pilot('BAW123', { memberId: '1234567' })), {
        ...NO_QUERY,
        memberId: '1234567'
      })
      expect(match.status).toEqual({
        state: 'online',
        callsign: 'BAW123',
        filedPlan: { departure: 'EGLL', arrival: 'LFPG', aircraftIcao: 'A320' }
      })
      expect(match.pilot?.callsign).toBe('BAW123')
    })

    it('is offline when no pilot has that number, even if a plan and position would match', () => {
      const match = detectSelf(snapshot(pilot('SAME-PLAN', { memberId: '999' })), {
        memberId: '1234567',
        flight: FLIGHT,
        position: HERE,
        pretendCallsign: null
      })
      expect(match.status.state).toBe('offline')
      expect(match.pilot).toBeNull()
    })

    it('gives no filed plan for a pilot who has not filed one', () => {
      const bare = pilot('BAW1', { memberId: '5', aircraftIcao: null, departure: null, arrival: null })
      expect(detectSelf(snapshot(bare), { ...NO_QUERY, memberId: '5' }).status.filedPlan).toBeNull()
    })
  })

  describe('without a member number', () => {
    const query: SelfQuery = { ...NO_QUERY, flight: FLIGHT, position: HERE }

    it('is probably the pilot whose plan matches and who is at the aircraft', () => {
      const match = detectSelf(snapshot(pilot('BAW1')), query)
      expect(match.status).toMatchObject({ state: 'probably', callsign: 'BAW1' })
    })

    it('takes the nearest when two match', () => {
      const nearer = destinationPoint(HERE, 90, 1 * 1852)
      const further = destinationPoint(HERE, 90, 3 * 1852)
      const match = detectSelf(
        snapshot(
          pilot('FAR', { latitude: further.lat, longitude: further.lon }),
          pilot('NEAR', { latitude: nearer.lat, longitude: nearer.lon })
        ),
        query
      )
      expect(match.status.callsign).toBe('NEAR')
    })

    it('is offline when the plan matches but the pilot is further than 5 nm away', () => {
      const away = destinationPoint(HERE, 0, (PROBABLY_RADIUS_NM + 0.5) * 1852)
      expect(
        detectSelf(snapshot(pilot('BAW1', { latitude: away.lat, longitude: away.lon })), query).status.state
      ).toBe('offline')
    })

    it('is probably when just inside 5 nm', () => {
      const inside = destinationPoint(HERE, 0, (PROBABLY_RADIUS_NM - 0.1) * 1852)
      expect(
        detectSelf(snapshot(pilot('BAW1', { latitude: inside.lat, longitude: inside.lon })), query).status
          .state
      ).toBe('probably')
    })

    it.each([
      ['another departure', { departure: 'EGKK' }],
      ['another arrival', { arrival: 'EHAM' }],
      ['no plan filed', { departure: null, arrival: null }]
    ])('is offline for a pilot at the aircraft with %s', (_name, changes) => {
      expect(detectSelf(snapshot(pilot('BAW1', changes)), query).status.state).toBe('offline')
    })

    it('never matches on a callsign alone', () => {
      const elsewhere = destinationPoint(HERE, 0, 400 * 1852)
      const match = detectSelf(
        snapshot(pilot('BAW123', { latitude: elsewhere.lat, longitude: elsewhere.lon, departure: 'KJFK' })),
        query
      )
      expect(match.status.state).toBe('offline')
    })

    it('is offline with no flight or no position to compare', () => {
      expect(detectSelf(snapshot(pilot('BAW1')), { ...query, flight: null }).status.state).toBe('offline')
      expect(detectSelf(snapshot(pilot('BAW1')), { ...query, position: null }).status.state).toBe('offline')
    })
  })

  describe('the dev override', () => {
    it('takes the pilot with that callsign to be the pilot, ahead of the member number', () => {
      const match = detectSelf(
        snapshot(pilot('MINE', { memberId: '1' }), pilot('SOMEONE', { memberId: '2' })),
        {
          ...NO_QUERY,
          memberId: '1',
          pretendCallsign: 'SOMEONE'
        }
      )
      expect(match.status).toMatchObject({ state: 'online', callsign: 'SOMEONE' })
    })

    it('is offline when no pilot has that callsign', () => {
      expect(detectSelf(snapshot(pilot('A')), { ...NO_QUERY, pretendCallsign: 'NOPE' }).status.state).toBe(
        'offline'
      )
    })
  })

  it('finds a pilot injected into a recorded feed, by member number and by plan', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'vatsim-busy.json'), 'utf8')) as {
      pilots: Record<string, unknown>[]
    }
    const real = parseVatsimFeed(raw, 0)!
    const target = real.pilots.find((p) => p.departure !== null && p.arrival !== null)!
    expect(detectSelf(real, { ...NO_QUERY, memberId: target.memberId }).status.callsign).toBe(target.callsign)
    const byPlan = detectSelf(real, {
      memberId: null,
      flight: { departure: target.departure!, arrival: target.arrival! },
      position: { lat: target.latitude, lon: target.longitude },
      pretendCallsign: null
    })
    expect(byPlan.status.state).toBe('probably')
  })
})
