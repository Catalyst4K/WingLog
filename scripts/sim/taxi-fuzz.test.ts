import { describe, expect, it } from 'vitest'
import { greatCircleM } from '../../src/shared/geo'
import { at, airport, line, seg } from './taxi-test-airport'
import { buildGraph, sampleCases } from './taxi-generate'
import { DEVIATIONS, fuzzDrive, sampleLegs, SPEED_MS, type Deviation } from './taxi-fuzz'

const graph = buildGraph(airport().segments)
const routes = (['holding-point', 'stand', 'hold-short'] as const).flatMap((endType) =>
  sampleCases(airport(), endType, 30, 3).map((c) => c.truth)
)

/** A ladder: A and B run east-west 300 m apart, with rungs at 0, 300, 900, 1500 and 1800, so there is a way round on every stretch. */
const ladder = buildGraph([
  ...line([0, 0], [1800, 0], 'A', 300),
  ...line([0, 300], [1800, 300], 'B', 300),
  ...[0, 300, 900, 1500, 1800].map((e) => seg([e, 0], [e, 300], `R${e}`))
])
const along = (from: number, to: number): [number, number][] =>
  Array.from({ length: (to - from) / 300 + 1 }, (_, i) => {
    const p = at(from + i * 300, 0)
    return [p.lon, p.lat]
  })

describe('sampleLegs', () => {
  it('drives a polyline at a steady speed, one sample a second, ending on its last point', () => {
    const a: [number, number] = [0, 51]
    const b: [number, number] = [0, 51.01]
    const samples = sampleLegs(a, 0, [{ drive: [a, b] }])
    expect(samples[0]).toMatchObject({ t: 0, groundSpeedMs: 0 })
    const steps = samples.slice(1, -1)
    for (let i = 1; i < steps.length; i++)
      expect(
        greatCircleM(
          { lat: steps[i - 1].lat, lon: steps[i - 1].lon },
          { lat: steps[i].lat, lon: steps[i].lon }
        )
      ).toBeCloseTo(SPEED_MS, 0)
    expect(samples.at(-1)!.lat).toBeCloseTo(51.01, 6)
    expect(samples.map((s) => s.t)).toEqual(samples.map((_, i) => i))
  })

  it('holds, and turns on the spot, without moving', () => {
    const p: [number, number] = [0, 51]
    const samples = sampleLegs(p, 90, [{ hold: 3 }, { turnDeg: 180, seconds: 4 }])
    expect(samples).toHaveLength(1 + 3 + 4)
    expect(samples.every((s) => s.lat === 51 && s.groundSpeedMs === 0)).toBe(true)
    expect(samples.at(-1)!.headingDeg).toBeCloseTo(270, 0)
  })
})

describe('fuzzDrive', () => {
  const drives = (deviation: Deviation) =>
    routes.map((r) => fuzzDrive(graph, r, deviation)).filter((d) => d !== null)

  it('makes the missed turn and the stop and turn on routes of the airport', () => {
    for (const deviation of ['missed-turn', 'stop-and-turn'] as const)
      expect(drives(deviation).length).toBeGreaterThan(0)
  })

  it('makes only known deviations, each leaving the route after the start', () => {
    for (const deviation of DEVIATIONS)
      for (const d of drives(deviation)) {
        expect(d.deviation).toBe(deviation)
        expect(d.leftAtIndex).toBeGreaterThan(0)
        expect(d.samples.length).toBeGreaterThan(d.leftAtIndex)
      }
  })

  it('takes another way between two points of the route, not on the route in between', () => {
    const d = fuzzDrive(ladder, along(0, 1800), 'parallel-taxiway')!
    expect(d).not.toBeNull()
    expect(d.samples.filter((s) => s.lat < at(0, 100).lat).length).toBeGreaterThan(10)
    expect(d.leftAtIndex).toBeGreaterThan(0)
  })

  it('sets off the way the nose points when that is away from the route, and still gets there', () => {
    const d = fuzzDrive(ladder, along(900, 1800), 'wrong-way-start')!
    expect(d).not.toBeNull()
    expect(d.startHeadingDeg).toBeCloseTo(270, 0)
    expect(d.samples.at(-1)!.lon).toBeCloseTo(at(1800, 0).lon, 5)
  })

  it('stops for ten seconds, then turns on the spot for ten, in a stop-and-turn', () => {
    for (const d of drives('stop-and-turn'))
      expect(d.samples.filter((s) => s.groundSpeedMs === 0).length).toBeGreaterThanOrEqual(20)
  })

  it('gives null for a route too short to have a deviation', () => {
    expect(fuzzDrive(graph, [routes[0][0], routes[0][1]], 'missed-turn')).toBeNull()
  })
})
