import { describe, expect, it } from 'vitest'
import type { FeedPilot, FeedSnapshot } from './feed-snapshot'
import { selfStatus, unknownStatus, type SelfStatusInput } from './self-status'

const HERE = { lat: 51.47, lon: -0.46 }

function pilot(callsign: string, memberId: string | null): FeedPilot {
  return {
    memberId,
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
    ageAtFeedS: 0
  }
}

function feed(network: 'vatsim' | 'ivao', ...pilots: FeedPilot[]): FeedSnapshot {
  return { network, updatedMs: 0, receivedMs: 0, pilots, controllers: [], atis: [] }
}

const INPUT: SelfStatusInput = {
  network: 'vatsim',
  memberId: '42',
  flight: { departure: 'EGLL', arrival: 'LFPG' },
  position: HERE,
  pretendCallsign: null
}

describe('selfStatus', () => {
  it('is online with the callsign and plan when the member number is in the feed', () => {
    const result = selfStatus(feed('vatsim', pilot('BAW1', '42')), INPUT)
    expect(result.status).toEqual({
      network: 'vatsim',
      state: 'online',
      callsign: 'BAW1',
      filedPlan: { departure: 'EGLL', arrival: 'LFPG', aircraftIcao: 'A320' }
    })
    expect(result.pilot?.memberId).toBe('42')
  })

  it('is offline when the feed was read and the pilot is not in it', () => {
    expect(selfStatus(feed('vatsim', pilot('OTHER', '7')), INPUT).status).toMatchObject({
      network: 'vatsim',
      state: 'offline',
      callsign: null
    })
  })

  it('is unknown with no feed read yet, no flight tracked, or no network chosen', () => {
    expect(selfStatus(null, INPUT).status).toEqual(unknownStatus('vatsim'))
    expect(selfStatus(feed('vatsim'), { ...INPUT, flight: null }).status).toEqual(unknownStatus('vatsim'))
    expect(selfStatus(feed('vatsim'), { ...INPUT, network: null }).status).toEqual(unknownStatus(null))
  })

  it('is unknown, not offline, when the feed held is the other network’s', () => {
    expect(selfStatus(feed('ivao', pilot('BAW1', '42')), INPUT).status).toEqual(unknownStatus('vatsim'))
  })

  it('is probably, by plan and position, with no member number', () => {
    const result = selfStatus(feed('vatsim', pilot('BAW1', '9')), { ...INPUT, memberId: null })
    expect(result.status.state).toBe('probably')
  })

  it('passes the dev override through', () => {
    const result = selfStatus(feed('vatsim', pilot('BAW1', '9')), { ...INPUT, pretendCallsign: 'BAW1' })
    expect(result.status).toMatchObject({ state: 'online', callsign: 'BAW1' })
  })
})
