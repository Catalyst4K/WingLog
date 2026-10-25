import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { METRES_PER_FOOT, MS_PER_KT } from '@shared/units'
import { parseIvaoFeed } from './ivao-feed'
import { parseVatsimFeed } from './vatsim-feed'

const RECEIVED_MS = Date.parse('2026-10-24T21:00:06Z')

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8'))
}

function rawFixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', 'malformed', name), 'utf8')
}

function pilot(
  changes: Record<string, unknown> = {},
  track: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    userId: 900001,
    callsign: 'BAW123',
    lastTrack: {
      latitude: 51.5,
      longitude: -0.5,
      altitude: 10000,
      groundSpeed: 250,
      heading: 90,
      onGround: false,
      timestamp: '2026-10-24T21:00:03Z',
      ...track
    },
    flightPlan: {
      departureId: 'EGLL',
      arrivalId: 'LFPG',
      aircraftId: 'A320',
      aircraft: { icaoCode: 'A320' }
    },
    ...changes
  }
}

function feed(pilots: unknown[], atcs: unknown[] = []): unknown {
  return { updatedAt: '2026-10-24T21:00:05Z', clients: { pilots, atcs, observers: [] } }
}

describe('parseIvaoFeed', () => {
  it('reads the synthetic fixture: every pilot, with the controllers and their ATIS', () => {
    const snapshot = parseIvaoFeed(fixture('ivao-synthetic.json'), RECEIVED_MS)
    expect(snapshot?.network).toBe('ivao')
    expect(snapshot?.pilots).toHaveLength(40)
    expect(snapshot?.controllers.map((c) => c.position)).toEqual(['twr', 'gnd', 'app'])
    expect(snapshot?.atis.map((a) => a.callsign)).toEqual(['TSTA_TWR', 'TSTA_APP'])
  })

  it('converts feet to metres and knots to m/s, and reads the on-ground flag', () => {
    const snapshot = parseIvaoFeed(
      feed([pilot({}, { altitude: 36000, groundSpeed: 480, onGround: true })]),
      RECEIVED_MS
    )
    expect(snapshot?.pilots[0]).toMatchObject({
      memberId: '900001',
      altitudeM: 36000 * METRES_PER_FOOT,
      groundSpeedMs: 480 * MS_PER_KT,
      onGround: true,
      aircraftIcao: 'A320',
      departure: 'EGLL',
      arrival: 'LFPG'
    })
  })

  it('treats anything but true as airborne', () => {
    const snapshot = parseIvaoFeed(feed([pilot({}, { onGround: 'yes' })]), RECEIVED_MS)
    expect(snapshot?.pilots[0]?.onGround).toBe(false)
  })

  it('works out the position age from the track timestamp', () => {
    expect(parseIvaoFeed(feed([pilot()]), RECEIVED_MS)?.pilots[0]?.ageAtFeedS).toBe(2)
  })

  it('keeps a pilot with no flight plan, and uses the aircraft id when there is no aircraft record', () => {
    expect(parseIvaoFeed(feed([pilot({ flightPlan: null })]), RECEIVED_MS)?.pilots[0]).toMatchObject({
      aircraftIcao: null,
      departure: null,
      arrival: null
    })
    const bare = pilot({ flightPlan: { aircraftId: 'B738' } })
    expect(parseIvaoFeed(feed([bare]), RECEIVED_MS)?.pilots[0]?.aircraftIcao).toBe('B738')
  })

  it.each([
    ['no track', { lastTrack: null }],
    ['a track that is text', { lastTrack: 'here' }],
    ['a huge callsign', { callsign: 'X'.repeat(10000) }],
    ['no callsign', { callsign: undefined }]
  ])('drops a pilot with %s', (_name, changes) => {
    expect(
      parseIvaoFeed(feed([pilot(changes), pilot({ callsign: 'GOOD' })]), RECEIVED_MS)?.pilots.map(
        (p) => p.callsign
      )
    ).toEqual(['GOOD'])
  })

  it.each([
    ['a latitude out of range', { latitude: 999 }],
    ['a longitude that is null', { longitude: null }],
    ['a speed that is text', { groundSpeed: 'fast' }],
    ['a negative speed', { groundSpeed: -5 }],
    ['an altitude far too high', { altitude: 1e12 }],
    ['a heading that is an object', { heading: {} }]
  ])('drops a pilot with %s', (_name, track) => {
    expect(
      parseIvaoFeed(feed([pilot({}, track), pilot({ callsign: 'GOOD' })]), RECEIVED_MS)?.pilots.map(
        (p) => p.callsign
      )
    ).toEqual(['GOOD'])
  })

  describe('controllers', () => {
    const atc = (position: string, frequency: unknown, atis: unknown = null): unknown => ({
      callsign: `TSTA_${position}`,
      atcSession: { position, frequency },
      atis
    })

    it('formats a numeric frequency as MHz with three decimals, the same as VATSIM gives it', () => {
      const snapshot = parseIvaoFeed(feed([], [atc('TWR', 118.1), atc('APP', 119.725)]), RECEIVED_MS)
      expect(snapshot?.controllers.map((c) => c.frequency)).toEqual(['118.100', '119.725'])
    })

    it('reads the ATIS from the controller: letter and lines', () => {
      const snapshot = parseIvaoFeed(
        feed([], [atc('TWR', 118.1, { lines: ['one', 'two'], revision: 'H', timestamp: 'x' })]),
        RECEIVED_MS
      )
      expect(snapshot?.atis).toEqual([{ callsign: 'TSTA_TWR', code: 'H', lines: ['one', 'two'] }])
    })

    it('drops a controller with an unknown position or a frequency that is not a number, keeping its ATIS if it has one', () => {
      const snapshot = parseIvaoFeed(
        feed(
          [],
          [atc('XXX', 118.1), atc('TWR', '118.1'), atc('GND', 121.7, { lines: ['hello'], revision: 'A' })]
        ),
        RECEIVED_MS
      )
      expect(snapshot?.controllers.map((c) => c.position)).toEqual(['gnd'])
      expect(snapshot?.atis.map((a) => a.callsign)).toEqual(['TSTA_GND'])
    })

    it('does not list observers: they are a separate list the parser does not read', () => {
      const snapshot = parseIvaoFeed(fixture('ivao-synthetic.json'), RECEIVED_MS)
      expect(snapshot?.controllers.some((c) => c.callsign.includes('OBS'))).toBe(false)
    })
  })

  describe('a feed that is not a feed', () => {
    it.each([null, undefined, 5, [], {}, { clients: {} }, { clients: { pilots: 'many' } }])(
      'is null for %j',
      (bad) => {
        expect(parseIvaoFeed(bad, RECEIVED_MS)).toBeNull()
      }
    )

    it('is null for an HTML error page, truncated JSON and a feed with no pilots', () => {
      expect(() => JSON.parse(rawFixture('ivao-html-error.html'))).toThrow()
      expect(() => JSON.parse(rawFixture('ivao-truncated.json'))).toThrow()
      expect(parseIvaoFeed(JSON.parse(rawFixture('ivao-no-pilots.json')), RECEIVED_MS)).toBeNull()
    })
  })

  it('keeps only the good pilots from the malformed fixtures', () => {
    for (const name of ['ivao-wrong-types.json', 'ivao-huge-callsign.json', 'ivao-bad-positions.json']) {
      expect(parseIvaoFeed(JSON.parse(rawFixture(name)), RECEIVED_MS)?.pilots).toHaveLength(3)
    }
  })
})

describe('both parsers, for the same situation', () => {
  it('give the same pilots, controllers and ATIS', () => {
    const vatsim = parseVatsimFeed(
      {
        general: { update_timestamp: '2026-10-24T21:00:05Z' },
        pilots: [
          {
            cid: 900001,
            callsign: 'BAW123',
            latitude: 51.5,
            longitude: -0.5,
            altitude: 10000,
            groundspeed: 250,
            heading: 90,
            last_updated: '2026-10-24T21:00:03Z',
            flight_plan: { aircraft_short: 'A320', departure: 'EGLL', arrival: 'LFPG' }
          }
        ],
        controllers: [{ callsign: 'EGLL_TWR', frequency: '118.700', facility: 4 }],
        atis: [{ callsign: 'EGLL_TWR', atis_code: 'H', text_atis: ['wind calm'] }]
      },
      RECEIVED_MS
    )
    const ivao = parseIvaoFeed(
      feed(
        [pilot()],
        [
          {
            callsign: 'EGLL_TWR',
            atcSession: { position: 'TWR', frequency: 118.7 },
            atis: { lines: ['wind calm'], revision: 'H' }
          }
        ]
      ),
      RECEIVED_MS
    )
    expect({ ...ivao, network: 'vatsim' }).toEqual(vatsim)
  })
})
