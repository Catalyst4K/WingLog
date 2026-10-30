import { describe, expect, it } from 'vitest'
import type { AtisAnswer, AtisRequest, BeyondAtcAtis, BeyondAtcAtisList } from '@shared/ipc'
import { withBeyondAtcAtis } from './with-beyondatc-atis'

const EGLL: BeyondAtcAtis = {
  icao: 'EGLL',
  code: 'R',
  text: 'EGLL ATIS R 2338Z ARR RWY 27 RIGHT DEP RWY 27 LEFT',
  arrivalRunways: ['27R'],
  departureRunways: ['27L']
}
const WSSS: BeyondAtcAtis = {
  icao: 'WSSS',
  code: 'E',
  text: 'WSSS ATIS E 2338Z ARR RWY 20 RIGHT DEP RWY 20 CENTER',
  arrivalRunways: ['20R'],
  departureRunways: ['20C']
}
const shown = (...airports: BeyondAtcAtis[]): BeyondAtcAtisList => ({ state: 'shown', airports })
const asked: AtisRequest[] = [
  { icao: 'WSSS', slot: 'departure' },
  { icao: 'EGLL', slot: 'destination' },
  { icao: 'EGKK', slot: 'alternate' }
]
const NETWORK_ATIS = {
  callsign: 'EGLL_A_ATIS',
  code: 'L',
  kind: 'arrival' as const,
  lines: ['EGLL INFORMATION L'],
  runway: '27R'
}
const vatsim: AtisAnswer = {
  network: 'vatsim',
  airports: [
    { icao: 'WSSS', slot: 'departure', state: 'none', atis: [] },
    { icao: 'EGLL', slot: 'destination', state: 'shown', atis: [NETWORK_ATIS] },
    { icao: 'EGKK', slot: 'alternate', state: 'none', atis: [] }
  ]
}
const noNetwork: AtisAnswer = { network: null, airports: [] }

describe('withBeyondAtcAtis', () => {
  it('changes nothing while BeyondATC is off, whatever the network says', () => {
    const off: BeyondAtcAtisList = { state: 'off', airports: [] }
    expect(withBeyondAtcAtis(vatsim, off, asked)).toBe(vatsim)
    expect(withBeyondAtcAtis(noNetwork, off, asked)).toBe(noNetwork)
  })

  it("puts BeyondATC's ATIS before the network's for the same airport, with its runways", () => {
    const answer = withBeyondAtcAtis(vatsim, shown(EGLL, WSSS), asked)
    expect(answer.network).toBe('vatsim')
    expect(answer.airports[1]?.atis.map((a) => a.callsign)).toEqual(['BeyondATC', 'EGLL_A_ATIS'])
    expect(answer.airports[1]?.atis[0]).toEqual({
      callsign: 'BeyondATC',
      code: 'R',
      kind: 'single',
      lines: [EGLL.text],
      runway: null,
      source: 'beyondatc',
      arrivalRunways: ['27R'],
      departureRunways: ['27L']
    })
  })

  it("turns a network's 'none' into shown when BeyondATC has the airport, and leaves an airport it lacks as it was", () => {
    const answer = withBeyondAtcAtis(vatsim, shown(WSSS), asked)
    expect(answer.airports[0]).toMatchObject({ icao: 'WSSS', state: 'shown' })
    expect(answer.airports[2]).toMatchObject({ icao: 'EGKK', state: 'none', atis: [] })
    expect(answer.airports[1]?.atis).toHaveLength(1)
  })

  it('builds the airports from the requests when no network is chosen', () => {
    const answer = withBeyondAtcAtis(noNetwork, shown(EGLL), asked)
    expect(answer.network).toBeNull()
    expect(answer.airports.map((a) => [a.icao, a.slot, a.state])).toEqual([
      ['WSSS', 'departure', 'none'],
      ['EGLL', 'destination', 'shown'],
      ['EGKK', 'alternate', 'none']
    ])
  })

  it('marks every airport when BeyondATC is connected but did not answer, and shows no older ATIS', () => {
    const answer = withBeyondAtcAtis(vatsim, { state: 'unavailable', airports: [] }, asked)
    expect(answer.airports.every((a) => a.beyondAtcUnavailable === true)).toBe(true)
    expect(answer.airports[1]?.atis).toEqual([NETWORK_ATIS])
  })

  it('does not mark airports when BeyondATC answered', () => {
    const answer = withBeyondAtcAtis(vatsim, shown(EGLL), asked)
    expect(answer.airports.some((a) => 'beyondAtcUnavailable' in a)).toBe(false)
  })
})
