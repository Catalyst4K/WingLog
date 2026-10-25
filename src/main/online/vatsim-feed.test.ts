import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { METRES_PER_FOOT, MS_PER_KT } from '@shared/units'
import { parseVatsimFeed, VATSIM_GROUND_SPEED_KT } from './vatsim-feed'

const RECEIVED_MS = Date.parse('2026-10-24T21:05:06Z')

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8'))
}

function rawFixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', 'malformed', name), 'utf8')
}

function pilot(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cid: 1000001,
    callsign: 'BAW123',
    latitude: 51.5,
    longitude: -0.5,
    altitude: 10000,
    groundspeed: 250,
    heading: 90,
    last_updated: '2026-10-24T21:05:03Z',
    flight_plan: { aircraft_short: 'A320', departure: 'EGLL', arrival: 'LFPG', remarks: 'x' },
    ...changes
  }
}

function feed(pilots: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    general: { update_timestamp: '2026-10-24T21:05:05Z' },
    pilots,
    controllers: [],
    atis: [],
    ...extra
  }
}

describe('parseVatsimFeed', () => {
  it('reads the busy fixture: every pilot kept, in SI units, with no names', () => {
    const snapshot = parseVatsimFeed(fixture('vatsim-busy.json'), RECEIVED_MS)
    expect(snapshot?.network).toBe('vatsim')
    expect(snapshot?.pilots.length).toBeGreaterThan(100)
    expect(JSON.stringify(snapshot)).not.toContain('Test Pilot')
    for (const p of snapshot?.pilots ?? []) {
      expect(p.callsign.length).toBeLessThanOrEqual(12)
      expect(p.headingDeg).toBeGreaterThanOrEqual(0)
      expect(p.headingDeg).toBeLessThan(360)
      expect(p.ageAtFeedS).toBeGreaterThanOrEqual(0)
    }
  })

  it('converts feet to metres, knots to m/s, and keeps the true heading as given', () => {
    const snapshot = parseVatsimFeed(
      feed([pilot({ altitude: 36000, groundspeed: 480, heading: 271 })]),
      RECEIVED_MS
    )
    expect(snapshot?.pilots[0]).toMatchObject({
      memberId: '1000001',
      callsign: 'BAW123',
      latitude: 51.5,
      longitude: -0.5,
      altitudeM: 36000 * METRES_PER_FOOT,
      groundSpeedMs: 480 * MS_PER_KT,
      headingDeg: 271,
      aircraftIcao: 'A320',
      departure: 'EGLL',
      arrival: 'LFPG',
      onGround: false
    })
  })

  it('takes ground speed under 40 kt as on the ground, and 40 kt as airborne', () => {
    const snapshot = parseVatsimFeed(
      feed([
        pilot({ callsign: 'SLOW', groundspeed: VATSIM_GROUND_SPEED_KT - 1 }),
        pilot({ callsign: 'EDGE', groundspeed: VATSIM_GROUND_SPEED_KT })
      ]),
      RECEIVED_MS
    )
    expect(snapshot?.pilots.map((p) => p.onGround)).toEqual([true, false])
  })

  it('works out how old each position was when the feed was made', () => {
    const snapshot = parseVatsimFeed(feed([pilot()]), RECEIVED_MS)
    expect(snapshot?.updatedMs).toBe(Date.parse('2026-10-24T21:05:05Z'))
    expect(snapshot?.pilots[0]?.ageAtFeedS).toBe(2)
  })

  it('gives age 0 when the times are missing or unreadable, and never a negative age', () => {
    const noTimes = parseVatsimFeed({ pilots: [pilot({ last_updated: 'soon' })] }, RECEIVED_MS)
    expect(noTimes?.updatedMs).toBeNull()
    expect(noTimes?.pilots[0]?.ageAtFeedS).toBe(0)
    const future = parseVatsimFeed(feed([pilot({ last_updated: '2026-10-24T21:09:00Z' })]), RECEIVED_MS)
    expect(future?.pilots[0]?.ageAtFeedS).toBe(0)
  })

  it('keeps a pilot with no flight plan, with the plan fields null', () => {
    const snapshot = parseVatsimFeed(feed([pilot({ flight_plan: null })]), RECEIVED_MS)
    expect(snapshot?.pilots[0]).toMatchObject({ aircraftIcao: null, departure: null, arrival: null })
  })

  it('clips the type and airports, and strips control characters from a callsign', () => {
    const snapshot = parseVatsimFeed(
      feed([
        pilot({
          callsign: 'AB\u0000C\u001b[31m1\n2',
          flight_plan: { aircraft_short: 'ABCDEFGHIJKL', departure: 'EGLLXYZ', arrival: '' }
        })
      ]),
      RECEIVED_MS
    )
    expect(snapshot?.pilots[0]).toMatchObject({
      callsign: 'ABC[31m12',
      aircraftIcao: 'ABCDEFGH',
      departure: 'EGLL',
      arrival: null
    })
  })

  it('drops a pilot whose callsign is empty, not text, or longer than a callsign can be', () => {
    const snapshot = parseVatsimFeed(
      feed([
        pilot({ callsign: '' }),
        pilot({ callsign: 42 }),
        pilot({ callsign: 'X'.repeat(13) }),
        pilot({ callsign: 'OK1' })
      ]),
      RECEIVED_MS
    )
    expect(snapshot?.pilots.map((p) => p.callsign)).toEqual(['OK1'])
  })

  it('drops a repeated callsign, keeping the first', () => {
    const snapshot = parseVatsimFeed(feed([pilot({ latitude: 1 }), pilot({ latitude: 2 })]), RECEIVED_MS)
    expect(snapshot?.pilots).toHaveLength(1)
    expect(snapshot?.pilots[0]?.latitude).toBe(1)
  })

  it.each([
    ['a latitude out of range', { latitude: 91 }],
    ['a longitude out of range', { longitude: -181 }],
    ['a latitude that is text', { latitude: '51.4' }],
    ['a missing longitude', { longitude: null }],
    ['a NaN-like speed', { groundspeed: Number.NaN }],
    ['a negative speed', { groundspeed: -5 }],
    ['an impossible speed', { groundspeed: 99999 }],
    ['an altitude far too high', { altitude: 1e12 }],
    ['a heading that is an object', { heading: {} }]
  ])('drops a pilot with %s', (_name, changes) => {
    expect(
      parseVatsimFeed(feed([pilot(changes), pilot({ callsign: 'GOOD' })]), RECEIVED_MS)?.pilots.map(
        (p) => p.callsign
      )
    ).toEqual(['GOOD'])
  })

  it('wraps a heading of 360 or more into 0 to 359', () => {
    expect(parseVatsimFeed(feed([pilot({ heading: 360 })]), RECEIVED_MS)?.pilots[0]?.headingDeg).toBe(0)
    expect(parseVatsimFeed(feed([pilot({ heading: -90 })]), RECEIVED_MS)?.pilots[0]?.headingDeg).toBe(270)
  })

  it('ignores entries that are not objects', () => {
    expect(parseVatsimFeed(feed([null, 5, 'x', [], pilot()]), RECEIVED_MS)?.pilots).toHaveLength(1)
  })

  it('leaves a member number null when the feed has none or an odd one', () => {
    expect(parseVatsimFeed(feed([pilot({ cid: 'abc' })]), RECEIVED_MS)?.pilots[0]?.memberId).toBeNull()
    expect(parseVatsimFeed(feed([pilot({ cid: -4 })]), RECEIVED_MS)?.pilots[0]?.memberId).toBeNull()
  })

  describe('controllers and ATIS', () => {
    it('drops observers, listing only real positions, with frequencies as MHz text', () => {
      const snapshot = parseVatsimFeed(fixture('vatsim-observers.json'), RECEIVED_MS)
      expect(snapshot?.controllers.map((c) => c.callsign).sort()).toEqual(['EWR_GND', 'LGA_GND'])
      expect(snapshot?.controllers.every((c) => /^\d{3}\.\d{3}$/.test(c.frequency))).toBe(true)
      expect(snapshot?.controllers.every((c) => c.position === 'gnd')).toBe(true)
    })

    it('reads each facility number as its position and drops facility 0 even with a normal frequency', () => {
      const controllers = [0, 1, 2, 3, 4, 5, 6, 7].map((facility) => ({
        callsign: `ST${facility}_X`,
        frequency: '121.800',
        facility
      }))
      const snapshot = parseVatsimFeed(feed([], { controllers }), RECEIVED_MS)
      expect(snapshot?.controllers.map((c) => c.position)).toEqual(['fss', 'del', 'gnd', 'twr', 'app', 'ctr'])
    })

    it('drops a controller on the observer frequency whatever its facility', () => {
      const snapshot = parseVatsimFeed(
        feed([], { controllers: [{ callsign: 'KLM868', frequency: '199.998', facility: 4 }] }),
        RECEIVED_MS
      )
      expect(snapshot?.controllers).toEqual([])
    })

    it('reads an ATIS as its letter and text lines', () => {
      const snapshot = parseVatsimFeed(fixture('vatsim-observers.json'), RECEIVED_MS)
      const atis = snapshot?.atis.find((a) => a.callsign === 'KEWR_ATIS')
      expect(atis?.code).toBe('C')
      expect(atis?.lines[0]).toContain('EWR ATIS INFO C')
    })

    it('drops an ATIS with no text, and clips a very long line', () => {
      const snapshot = parseVatsimFeed(
        feed([], {
          atis: [
            { callsign: 'EGLL_ATIS', atis_code: 'A', text_atis: null },
            { callsign: 'EGKK_ATIS', atis_code: 'B', text_atis: ['y'.repeat(5000)] }
          ]
        }),
        RECEIVED_MS
      )
      expect(snapshot?.atis).toHaveLength(1)
      expect(snapshot?.atis[0]?.lines[0]).toHaveLength(200)
    })
  })

  describe('a feed that is not a feed', () => {
    it.each([null, undefined, 5, 'text', [], {}, { pilots: 'many' }, { pilots: {} }])(
      'is null for %j',
      (bad) => {
        expect(parseVatsimFeed(bad, RECEIVED_MS)).toBeNull()
      }
    )

    it('is null for an HTML error page, truncated JSON and a feed with no pilots', () => {
      expect(() => JSON.parse(rawFixture('vatsim-html-error.html'))).toThrow()
      expect(() => JSON.parse(rawFixture('vatsim-truncated.json'))).toThrow()
      expect(parseVatsimFeed(JSON.parse(rawFixture('vatsim-no-pilots.json')), RECEIVED_MS)).toBeNull()
    })
  })

  describe('the malformed fixtures', () => {
    it('keeps only the good pilots when one has the wrong types, a huge callsign or bad positions', () => {
      for (const name of [
        'vatsim-wrong-types.json',
        'vatsim-huge-callsign.json',
        'vatsim-bad-positions.json'
      ]) {
        const snapshot = parseVatsimFeed(JSON.parse(rawFixture(name)), RECEIVED_MS)
        expect(snapshot?.pilots).toHaveLength(3)
      }
    })

    it('cleans the control characters out of a callsign', () => {
      const snapshot = parseVatsimFeed(JSON.parse(rawFixture('vatsim-control-chars.json')), RECEIVED_MS)
      expect(snapshot?.pilots[0]?.callsign).toBe('ABC[31m12')
    })
  })
})
