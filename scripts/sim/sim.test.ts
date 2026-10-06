import { describe, expect, it } from 'vitest'
import type { Flight, TrackPoint } from '../../src/shared/ipc'
import { parseInfoBoxesLog } from './local-data'
import { renderReport } from './report'
import { boundsAround, boundsOf, escapeHtml, makeFrame, polyline } from './svg'
import { groundSamples, scenarioFromHand, scenariosFromLog } from './taxi'

// Real main.log lines (flight 230, 2026-10-05), local time as electron-log writes it.
const LOG = `[2026-10-05 14:52:37.953] [info]  [beyondatc] InfoBoxes [{"title":"Pushback Direction","info":"southwest"}]
[2026-10-05 14:58:42.980] [info]  [beyondatc] InfoBoxes [{"title":"Taxi to Runway","info":"07R"},{"title":"Taxi Via 1","info":"B"},{"title":"Hold Position","info":"J1"}]
[2026-10-05 15:06:39.605] [info]  [beyondatc] InfoBoxes [{"title":"Taxi to Runway","info":"07R"},{"title":"Taxi Via 1","info":"B"},{"title":"Hold Position","info":"J1"}]
[2026-10-05 15:07:00.000] [info]  [beyondatc] InfoBoxes [{"title":"Taxi
[2026-10-05 16:24:09.299] [info]  [beyondatc] InfoBoxes [{"title":"Taxi to Gate","info":"Gate 102"},{"title":"Taxi Via 1","info":"A4"},{"title":"Taxi Via 2","info":"D"}]
[2026-10-05 16:24:10.000] [info]  [gsx] something else`

const local = (iso: string): number => new Date(iso).getTime()

const FLIGHT = {
  id: 230,
  depIcao: 'VHHH',
  arrIcao: 'ZJSY',
  actualOutUtc: new Date(local('2026-10-05T14:33:14')).toISOString(),
  actualOffUtc: new Date(local('2026-10-05T15:10:33')).toISOString(),
  actualOnUtc: new Date(local('2026-10-05T16:22:24')).toISOString(),
  actualInUtc: new Date(local('2026-10-05T16:29:26')).toISOString()
} as Flight

function point(iso: string, overrides: Partial<TrackPoint> = {}): TrackPoint {
  return {
    tsUtc: new Date(local(iso)).toISOString(),
    latitude: 22.3,
    longitude: 113.9,
    headingTrueDeg: 70,
    groundSpeedMs: 5,
    phase: 'taxi',
    onGround: true,
    excludedReason: null,
    ...overrides
  } as TrackPoint
}

describe('parseInfoBoxesLog', () => {
  it('reads every InfoBoxes line with its local time, skipping cut lines and other logs', () => {
    const parsed = parseInfoBoxesLog(LOG)
    expect(parsed).toHaveLength(4)
    expect(parsed[1]).toEqual({ atMs: local('2026-10-05T14:58:42.980'), boxes: [
      { title: 'Taxi to Runway', info: '07R' },
      { title: 'Taxi Via 1', info: 'B' },
      { title: 'Hold Position', info: 'J1' }
    ] })
  })
})

describe('taxi scenarios', () => {
  const points = [
    point('2026-10-05T14:55:00', { phase: 'pushback' }),
    point('2026-10-05T14:59:00'),
    point('2026-10-05T15:12:00', { onGround: false, phase: 'climb' }),
    point('2026-10-05T16:22:40', { phase: 'landing', groundSpeedMs: 30 }),
    point('2026-10-05T16:24:20', { phase: 'cruise' }),
    point('2026-10-05T16:25:00', { excludedReason: 'resume-spurious' })
  ]

  it('matches each new taxi clearance to its flight and side, once', () => {
    const scenarios = scenariosFromLog(parseInfoBoxesLog(LOG), [FLIGHT], () => points)
    expect(scenarios.map((s) => [s.id, s.icao, s.side, s.samples.length])).toEqual([
      ['230-out', 'VHHH', 'out', 1],
      ['230-in', 'ZJSY', 'in', 1]
    ])
  })

  it('repairs ground rows a pre-fix bounce left in cruise, and drops excluded points', () => {
    const arrival = groundSamples(FLIGHT, points, 'in')
    expect(arrival.map((s) => s.phase)).toEqual(['landing', 'taxi'])
  })

  it('places a hand-written clearance at a point of the recorded taxi', () => {
    const hand = scenarioFromHand(
      { id: '230-out', flightId: 230, side: 'out', at: 'pushbackEnd', source: 'plan doc', boxes: [] },
      FLIGHT,
      points
    )
    expect(hand?.atMs).toBe(local('2026-10-05T14:59:00'))
    expect(hand?.icao).toBe('VHHH')
  })
})

describe('report pieces', () => {
  it('escapes external text', () => {
    expect(escapeHtml(`<b onclick="x">'&'</b>`)).toBe('&lt;b onclick=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/b&gt;')
    const page = renderReport({ title: 'T', intro: '<script>', lookFor: ['a & b'], key: [], summary: [], sections: [] })
    expect(page).not.toContain('<script>')
    expect(page).toContain('a &amp; b')
  })

  it('fits a map to its area, north up', () => {
    const frame = makeFrame(boundsOf([[113.9, 22.3], [113.91, 22.31]], 0), 400, 100, 1000)
    expect(frame.x(113.9)).toBeCloseTo(0)
    expect(frame.x(113.91)).toBeCloseTo(400)
    expect(frame.y(22.31)).toBeCloseTo(0)
    expect(frame.height).toBeCloseTo(400 / Math.cos((22.305 * Math.PI) / 180), 0)
    expect(polyline(frame, [], '')).toBe('')
  })

  it('makes a square area around a point', () => {
    const b = boundsAround({ lat: 0, lon: 0 }, 1113.2)
    expect(b.north).toBeCloseTo(0.01)
    expect(b.east).toBeCloseTo(0.01)
  })
})
