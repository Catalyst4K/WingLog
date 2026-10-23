import { describe, expect, it } from 'vitest'
import { at, airport, line, seg } from './taxi-test-airport'
import { routeProblems } from '../../src/shared/taxi/route-checks'
import { angleBetweenDeg } from '../../src/shared/taxi/route-trace'
import {
  buildGraph,
  clearanceNames,
  runsOf,
  sampleCases,
  shortestRoute,
  type GeneratorAirport
} from './taxi-generate'

describe('buildGraph', () => {
  it('has a node at each distinct end, two directions for each segment, and marks a hold short', () => {
    const graph = buildGraph(airport().segments)
    expect(graph.edges).toHaveLength(airport().segments.length * 2)
    expect(graph.nodes.filter((n) => n.holdShort)).toHaveLength(6)
    // Both directions of a segment have opposite bearings.
    const a = graph.edges[0]
    const b = graph.edges[1]
    expect(a.from).toBe(b.to)
    expect(angleBetweenDeg(a.bearing, b.bearing)).toBeCloseTo(180, 0)
  })
})

describe('shortestRoute', () => {
  const graph = buildGraph(airport().segments)
  const nodeAt = (east: number, north: number): number => {
    const p = at(east, north)
    return graph.nodes.findIndex((n) => Math.abs(n.lat - p.lat) < 1e-6 && Math.abs(n.lon - p.lon) < 1e-6)
  }
  const length = (path: number[]): number => path.reduce((sum, id) => sum + graph.edges[id].lengthM, 0)

  it('finds the shortest way along a taxiway', () => {
    const path = shortestRoute(graph, nodeAt(0, 0), nodeAt(2000, 0))!
    expect(length(path)).toBeCloseTo(2000, -1)
    expect(new Set(path.map((id) => graph.edges[id].name))).toEqual(new Set(['A']))
  })

  it('goes round by a link to the other taxiway when that is the way', () => {
    const path = shortestRoute(graph, nodeAt(0, 0), nodeAt(800, 300))!
    expect(runsOf(graph, path).map((r) => r.name)).toEqual(['A', 'L1', 'B'])
  })

  it('never takes a turn at a junction sharper than an airliner can', () => {
    // From E1 (south of A at east 200) the way west on A is a 90-degree turn: fine. A tight hairpin is not available anywhere here.
    const path = shortestRoute(graph, nodeAt(200, -200), nodeAt(0, 0))!
    for (let i = 1; i < path.length; i++)
      expect(
        angleBetweenDeg(graph.edges[path[i - 1]].bearing, graph.edges[path[i]].bearing)
      ).toBeLessThanOrEqual(100)
  })

  it('does not turn back on itself: a dead end has no way back out', () => {
    const dead = buildGraph([...line([0, 0], [400, 0], 'X'), ...line([400, 0], [400, 200], 'Y')])
    const from = dead.nodes.findIndex((n) => Math.abs(n.lat - at(400, 200).lat) < 1e-6)
    const to = dead.nodes.findIndex(
      (n) => Math.abs(n.lat - at(0, 0).lat) < 1e-6 && Math.abs(n.lon - at(0, 0).lon) < 1e-6
    )
    // Y to X at the corner is a 90-degree turn: allowed, so the way back to the start is found...
    expect(shortestRoute(dead, from, to)).not.toBeNull()
    // ...but the same network with the corner a hairpin (X and Y running back along each other) is not.
    const hairpin = buildGraph([...line([0, 0], [400, 0], 'X'), seg([400, 0], [0, 4], 'Y')])
    const tip = hairpin.nodes.length - 1
    expect(shortestRoute(hairpin, tip, 0)).toBeNull()
  })

  it("starts the way the aircraft's nose points, when its heading is given", () => {
    const from = nodeAt(1000, 0)
    const path = shortestRoute(graph, from, nodeAt(800, 0), 90)!
    expect(angleBetweenDeg(graph.edges[path[0]].bearing, 90)).toBeLessThanOrEqual(90)
    // Going round by L2 and B costs far more than the 200 m straight back, which a nose pointing east rules out.
    expect(length(path)).toBeGreaterThan(1000)
  })

  it('is null when there is no way', () => {
    expect(shortestRoute(graph, nodeAt(0, 0), nodeAt(200, -300))).not.toBeNull()
    const apart = buildGraph([...line([0, 0], [400, 0], 'X'), ...line([0, 900], [400, 900], 'Z')])
    expect(shortestRoute(apart, 0, apart.nodes.length - 1)).toBeNull()
  })
})

describe('runsOf and clearanceNames', () => {
  it('collapses a name driven in a row, and unnamed edges do not break a run or start one', () => {
    const graph = buildGraph([
      seg([0, 0], [100, 0], null),
      seg([100, 0], [200, 0], 'A'),
      seg([200, 0], [300, 0], null),
      seg([300, 0], [400, 0], 'A'),
      seg([400, 0], [500, 0], 'B')
    ])
    const path = graph.edges.map((_, i) => i).filter((i) => i % 2 === 0)
    expect(runsOf(graph, path).map((r) => r.name)).toEqual(['A', 'B'])
  })

  it('leaves out an interior run shorter than the limit, and what that leaves doubled is one', () => {
    const runs = [
      { name: 'A', lengthM: 500 },
      { name: 'LINK', lengthM: 50 },
      { name: 'A', lengthM: 300 },
      { name: 'B', lengthM: 100 },
      { name: 'C', lengthM: 30 }
    ]
    expect(clearanceNames(runs, 0)).toEqual(['A', 'LINK', 'A', 'B', 'C'])
    expect(clearanceNames(runs, 120)).toEqual(['A', 'C'])
    // The first and the last run are always said, however short.
    expect(
      clearanceNames(
        [
          { name: 'X', lengthM: 5 },
          { name: 'Y', lengthM: 6 }
        ],
        240
      )
    ).toEqual(['X', 'Y'])
  })
})

describe('sampleCases', () => {
  const gen = (endType: 'holding-point' | 'hold-short' | 'stand', count = 12, seed = 1) =>
    sampleCases(airport(), endType, count, seed)

  it('is deterministic for a seed, and a different seed samples differently', () => {
    expect(gen('holding-point', 8).map((c) => c.text)).toEqual(gen('holding-point', 8).map((c) => c.text))
    // This airport can only make a few distinct clearances, so compare what each of several seeds picks first.
    const firsts = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => gen('holding-point', 1, seed)[0].text)
    expect(new Set(firsts).size).toBeGreaterThan(1)
  })

  it('makes holding-point clearances from a stand to a hold short by a threshold, ending on the taxiway it names', () => {
    const cases = gen('holding-point')
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) {
      expect(c.clearance.holdingPoint).toBeTruthy()
      expect(c.clearance.taxiToRunway).toMatch(/^(09|27|18)$/)
      expect(c.clearance.taxiways.at(-1)).toBe(c.clearance.holdingPoint)
      expect(c.text).toContain(`holding point ${c.clearance.holdingPoint}`)
      expect(c.clearance.stand).toBeNull()
    }
  })

  it('makes a quarter of the departures start mid-pushback, nose pointing away from the route', () => {
    const cases = gen('holding-point', 40)
    const pushback = cases.filter((c) => c.pushback)
    expect(pushback.length).toBeGreaterThan(0)
    expect(pushback.length).toBeLessThan(cases.length)
    for (const c of cases) {
      const [a, b] = c.truth
      const along =
        ((Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI + 360) %
        360
      const away = angleBetweenDeg(along, c.clearance.from!.headingDeg!) > 150
      expect(away).toBe(c.pushback)
    }
  })

  it('makes hold-short clearances only for routes that cross another runway, stopped at a hold short before it', () => {
    const cases = gen('hold-short')
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) {
      expect(c.clearance.holdShortRunway).toBe('18')
      expect(c.clearance.holdingPoint).toBeNull()
      expect(c.text).toContain('hold short of runway 18')
    }
  })

  it('makes stand clearances from where an aircraft leaves a runway to a stand, naming the stand', () => {
    const cases = gen('stand')
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) {
      expect(c.clearance.stand).toMatch(/^N[1-5]$/)
      expect(c.clearance.holdingPoint).toBeNull()
      expect(c.clearance.holdShortRunway).toBeNull()
      expect(c.text).toContain(`stand ${c.clearance.stand}`)
    }
  })

  it('only makes routes an aircraft could taxi, whatever the wording, and gives every case its own clearance', () => {
    for (const endType of ['holding-point', 'hold-short', 'stand'] as const) {
      const cases = gen(endType, 30)
      const signatures = new Set<string>()
      for (const c of cases) {
        const request = {
          segments: airport().segments,
          taxiways: c.clearance.taxiways,
          holdingPoint: c.clearance.holdingPoint,
          from: c.clearance.from!,
          end: { lat: c.truth.at(-1)![1], lon: c.truth.at(-1)![0] }
        }
        // The route itself (heading unknown: a pushback start points away on purpose).
        expect(
          routeProblems(c.truth, { ...request, taxiways: [], holdingPoint: null, headingDeg: null })
        ).toEqual([])
        signatures.add(c.text + JSON.stringify(c.clearance.from))
      }
      expect(signatures.size).toBe(cases.length)
    }
  })

  it('words the same route differently as the link limit changes, leaving short interior runs out', () => {
    const cases = gen('holding-point', 30)
    expect(new Set(cases.map((c) => c.linkLimitM))).toEqual(new Set([0, 120, 240]))
  })

  it('gives fewer cases, rather than failing, when the airport cannot make them', () => {
    const none: GeneratorAirport = { ...airport(), stands: [] }
    expect(sampleCases(none, 'holding-point', 5)).toEqual([])
    expect(sampleCases(none, 'stand', 5)).toEqual([])
    const noRunways: GeneratorAirport = { ...airport(), runways: [] }
    expect(sampleCases(noRunways, 'holding-point', 5)).toEqual([])
  })
})
