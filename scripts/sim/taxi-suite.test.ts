/**
 * The taxi line's generated-clearance gate (winglog-backend docs/plans/taxi-and-second-screen-robustness.md, stage 6f): about 110 clearances
 * generated on VHHH, ZJSY and EGLL (taxi-suite-fixtures.sim.ts), traced the way the app traces them and scored against the route each was
 * made from. The numbers in taxi-suite-thresholds.json are a ratchet: a group may not follow fewer, draw more lines with a problem, or leave
 * more without a line than it does there. Raise them as the taxi rules improve (`WINGLOG_SUITE_WRITE=1 npm test -- taxi-suite` rewrites the
 * file from the current results, and only when nothing got worse); never lower them to make a red build green.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NavdataRunway, NavdataStand, NavdataTaxiSegment } from '../../src/shared/ipc'
import { clearanceEnds, traceClearanceDetailed, type TaxiClearance } from '../../src/shared/taxi/clearance'
import { flat, shareOnLine } from './taxi-geometry'
import type { EndType } from './taxi-generate'
import THRESHOLDS from './taxi-suite-thresholds.json'

type Row = [number, number, number, number, string | null, number, number]

interface SuiteFixture {
  icao: string
  network: Row[]
  runways: NavdataRunway[]
  stands: NavdataStand[]
  cases: {
    id: string
    endType: EndType
    text: string
    clearance: TaxiClearance
    truth: [number, number][]
  }[]
}

interface Group {
  cases: number
  followed: number
  problems: number
  none: number
}

const AIRPORTS = ['VHHH', 'ZJSY', 'EGLL']
const FIXTURE_DIR = join(__dirname, '__fixtures__', 'taxi-suite')
const THRESHOLD_FILE = join(__dirname, 'taxi-suite-thresholds.json')

const load = (icao: string): SuiteFixture =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, `${icao}.json`), 'utf8')) as SuiteFixture

const toSegments = (rows: Row[]): NavdataTaxiSegment[] =>
  rows.map(([startLat, startLon, endLat, endLon, name, startHoldShort, endHoldShort]) => ({
    startLat,
    startLon,
    endLat,
    endLon,
    name,
    startHoldShort: startHoldShort === 1,
    endHoldShort: endHoldShort === 1
  }))

/**
 * @param fixture One airport's fixture.
 * @returns How each end type came out at that airport.
 */
function runAirport(fixture: SuiteFixture): Record<string, Group> {
  const segments = toSegments(fixture.network)
  const groups: Record<string, Group> = {}
  for (const c of fixture.cases) {
    const key = `${fixture.icao}/${c.endType}`
    const group = (groups[key] ??= { cases: 0, followed: 0, problems: 0, none: 0 })
    group.cases += 1
    const ends = clearanceEnds(c.clearance, fixture.stands, fixture.runways)
    const traced = traceClearanceDetailed(
      c.clearance,
      segments,
      ends.stand,
      ends.threshold,
      ends.holdShortRunway
    )
    if (!traced) {
      group.none += 1
      continue
    }
    if (traced.problems.length > 0) group.problems += 1
    const ref = c.truth[0][1]
    const line = flat(traced.route, ref)
    const truth = flat(c.truth, ref)
    if (
      (shareOnLine(line, truth) ?? 0) >= THRESHOLDS.followPct &&
      (shareOnLine(truth, line) ?? 0) >= THRESHOLDS.followPct
    )
      group.followed += 1
  }
  return groups
}

const results: Record<string, Group> = {}

describe('taxi suite: generated clearances on VHHH, ZJSY and EGLL', () => {
  for (const icao of AIRPORTS) {
    it(`${icao}: no group follows fewer clearances, or draws more lines with a problem or none at all, than the ratchet`, () => {
      const fixture = load(icao)
      const groups = runAirport(fixture)
      Object.assign(results, groups)
      const thresholds = THRESHOLDS.groups as Record<
        string,
        { followed: number; problems: number; none: number }
      >
      for (const [key, group] of Object.entries(groups)) {
        const floor = thresholds[key]
        expect(floor, `no threshold for ${key}: run WINGLOG_SUITE_WRITE=1`).toBeDefined()
        const label = `${key} (${group.cases} cases)`
        expect(group.followed, `${label}: followed`).toBeGreaterThanOrEqual(floor.followed)
        expect(group.problems, `${label}: lines with a problem`).toBeLessThanOrEqual(floor.problems)
        expect(group.none, `${label}: no line`).toBeLessThanOrEqual(floor.none)
      }
    }, 300_000)
  }

  it('has fixtures for every airport, each with cases of the end types it can make', () => {
    for (const icao of AIRPORTS) {
      const fixture = load(icao)
      expect(fixture.cases.length).toBeGreaterThanOrEqual(30)
      expect(fixture.network.length).toBeGreaterThan(500)
      expect(new Set(fixture.cases.map((c) => c.id)).size).toBe(fixture.cases.length)
    }
  })

  it.skipIf(!process.env.WINGLOG_SUITE_WRITE)(
    'writes the ratchet from the current results when none got worse',
    () => {
      const current = Object.fromEntries(
        AIRPORTS.flatMap((icao) => Object.entries(runAirport(load(icao)))).map(([key, g]) => [
          key,
          { followed: g.followed, problems: g.problems, none: g.none }
        ])
      )
      const old = THRESHOLDS.groups as Record<string, { followed: number; problems: number; none: number }>
      for (const [key, now] of Object.entries(current)) {
        const before = old[key]
        if (!before) continue
        expect(now.followed, `${key} followed`).toBeGreaterThanOrEqual(before.followed)
        expect(now.problems, `${key} problems`).toBeLessThanOrEqual(before.problems)
        expect(now.none, `${key} none`).toBeLessThanOrEqual(before.none)
      }
      writeFileSync(
        THRESHOLD_FILE,
        JSON.stringify({ followPct: THRESHOLDS.followPct, groups: current }, null, 2) + '\n'
      )
    },
    300_000
  )
})
