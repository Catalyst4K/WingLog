/**
 * `npm run sim -- taxi-suite-fixtures`: writes the fixtures `taxi-suite.test.ts` runs on (winglog-backend
 * docs/plans/taxi-and-second-screen-robustness.md, stage 6f): for VHHH, ZJSY and EGLL, about a hundred generated clearances and the part of
 * the airport's cached taxi network within SUITE_BUFFER_M of their routes. The network is MSFS facility data from WingLog's own cache,
 * as the fixtures beside the taxi tests already are; there is no personal data in it, and nothing here reads anything else.
 *
 * Writes scripts/sim/__fixtures__/taxi-suite/<icao>.json. Run it to change the cases; the thresholds in taxi-suite-thresholds.json are
 * then set from taxi-suite.test.ts's own report, never lowered.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import type { NavdataTaxiSegment } from '@shared/ipc'
import { flat, distToPolyline } from './taxi-geometry'
import { sampleCases, type EndType } from './taxi-generate'
import { loadGeneratorAirports } from './taxi-networks'
import { openUserDb } from './local-data'

export const SUITE_AIRPORTS = ['VHHH', 'ZJSY', 'EGLL']
export const SUITE_SEED = 7
export const SUITE_COUNTS: Record<EndType, number> = { 'holding-point': 40, 'hold-short': 30, stand: 30 }
const SUITE_BUFFER_M = 100
const round = (v: number): number => Math.round(v * 1e6) / 1e6

/** A segment as a compact row: [startLat, startLon, endLat, endLon, name, startHoldShort, endHoldShort]. */
export function rowOf(
  s: NavdataTaxiSegment
): [number, number, number, number, string | null, number, number] {
  return [
    round(s.startLat),
    round(s.startLon),
    round(s.endLat),
    round(s.endLon),
    s.name,
    s.startHoldShort ? 1 : 0,
    s.endHoldShort ? 1 : 0
  ]
}

it('writes the taxi suite fixtures', () => {
  const { db, close } = openUserDb()
  try {
    const dir = resolve(__dirname, '__fixtures__', 'taxi-suite')
    mkdirSync(dir, { recursive: true })
    for (const airport of loadGeneratorAirports(db, SUITE_AIRPORTS)) {
      const cases = (Object.keys(SUITE_COUNTS) as EndType[]).flatMap((endType) =>
        sampleCases(airport, endType, SUITE_COUNTS[endType], SUITE_SEED)
      )
      const ref = airport.segments[0].startLat
      const routes = cases.map((c) => flat(c.truth, ref))
      const near = airport.segments.filter((s) => {
        const mid = flat(
          [
            [(s.startLon + s.endLon) / 2, (s.startLat + s.endLat) / 2],
            [s.startLon, s.startLat],
            [s.endLon, s.endLat]
          ],
          ref
        )
        return routes.some((r) => mid.some((p) => distToPolyline(p, r) <= SUITE_BUFFER_M))
      })
      const idents = new Set(
        cases.flatMap((c) => [c.clearance.taxiToRunway, c.clearance.holdShortRunway]).filter(Boolean)
      )
      const usedStands = new Set(cases.map((c) => c.clearance.stand).filter(Boolean))
      const fixture = {
        icao: airport.icao,
        network: near.map(rowOf),
        runways: airport.runways.filter((r) => idents.has(r.ident)),
        stands: airport.stands.filter((s) => usedStands.has(s.name)),
        cases: cases.map((c) => ({
          id: c.id,
          endType: c.endType,
          pushback: c.pushback,
          text: c.text,
          clearance: {
            ...c.clearance,
            from: c.clearance.from && {
              lat: round(c.clearance.from.lat),
              lon: round(c.clearance.from.lon),
              headingDeg: c.clearance.from.headingDeg
            }
          },
          truth: c.truth.map(([lon, lat]) => [round(lon), round(lat)])
        }))
      }
      writeFileSync(join(dir, `${airport.icao}.json`), JSON.stringify(fixture))
      process.stdout.write(
        `SUITE ${airport.icao}: ${fixture.cases.length} cases, ${fixture.network.length} of ${airport.segments.length} segments\n`
      )
    }
  } finally {
    close()
  }
}, 600_000)
