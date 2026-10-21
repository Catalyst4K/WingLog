/**
 * `npm run sim -- taxi-evidence`: for winglog-backend's docs/plans/taxi-routing-rules.md, step 2. Matches every recorded taxi
 * onto the taxi network as it was flown (BeyondATC's saved copy, `GeneratedAirports/<ICAO>.json`, which is the sim's network with
 * the scenery installed at the time) and reads off the taxiway names actually driven, then compares them with the clearance:
 * followed (every cleared name driven, in order), partly, or not. Writes release/sim/taxi/evidence.json (gitignored).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { getFlight, listFlights } from '../../src/main/db/flight-repo'
import { listCachedRunways } from '../../src/main/db/navdata-repo'
import { listTrackPoints } from '../../src/main/db/track-point-repo'
import { boxTaxiClearance } from '../../src/renderer/src/taxi-clearance'
import { openUserDb, readInfoBoxesLogs } from './local-data'
import { simOutputDir } from './report'
import {
  scenarioFromHand,
  scenariosFromLog,
  type GroundSample,
  type HandScenario,
  type TaxiScenario
} from './taxi'

const BATC_DIR = join(
  homedir(),
  'AppData',
  'LocalLow',
  'Skirmish Mode Games, Inc',
  'BeyondATC',
  'GeneratedAirports'
)
/** A recorded position further than this from every network edge isn't matched. */
const MATCH_M = 25
/** A run of one name shorter than this is a junction crossed, not a taxiway driven. */
const MIN_RUN_M = 30

interface Edge {
  name: string
  type: number
  widthFt: number
  a: { x: number; z: number }
  b: { x: number; z: number }
}

interface Network {
  lat0: number
  lon0: number
  edges: Edge[]
}

function loadNetwork(icao: string): Network | null {
  const path = join(BATC_DIR, `${icao}.json`)
  if (!existsSync(path)) return null
  const j = JSON.parse(readFileSync(path, 'utf8')) as {
    latitude: number
    longitude: number
    rawTaxiPoints: {
      guid: string
      biasX: number
      biasZ: number
      connections: { icao: string; pathType: number; widthFeet: number; taxiPointGuid: string }[]
    }[]
  }
  const byGuid = new Map(j.rawTaxiPoints.map((p) => [p.guid, p]))
  const seen = new Set<string>()
  const edges: Edge[] = []
  for (const p of j.rawTaxiPoints)
    for (const c of p.connections) {
      const q = byGuid.get(c.taxiPointGuid)
      if (!q) continue
      const key = [p.guid, q.guid].sort().join()
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({
        name: c.icao || '-',
        type: c.pathType,
        widthFt: c.widthFeet,
        a: { x: p.biasX, z: p.biasZ },
        b: { x: q.biasX, z: q.biasZ }
      })
    }
  return { lat0: j.latitude, lon0: j.longitude, edges }
}

/** The angle between two bearings as lines, ignoring direction: 0-90. */
function lineAngle(a: number, b: number): number {
  const d = Math.abs((((a - b) % 180) + 180) % 180)
  return d > 90 ? 180 - d : d
}

/** The network edge a recorded position is on: the nearest, with its direction matching the aircraft's heading. */
function edgeAt(net: Network, s: GroundSample): Edge | null {
  const cos = Math.cos((net.lat0 * Math.PI) / 180)
  const x = (s.lon - net.lon0) * 111_320 * cos
  const z = (s.lat - net.lat0) * 111_320
  let best: Edge | null = null
  let bestScore = Infinity
  for (const e of net.edges) {
    const dx = e.b.x - e.a.x
    const dz = e.b.z - e.a.z
    const len2 = dx * dx + dz * dz || 1
    const t = Math.max(0, Math.min(1, ((x - e.a.x) * dx + (z - e.a.z) * dz) / len2))
    const d = Math.hypot(e.a.x + t * dx - x, e.a.z + t * dz - z)
    if (d > MATCH_M) continue
    const bearing = (Math.atan2(dx, dz) * 180) / Math.PI
    const score = d + lineAngle(bearing, s.headingDeg) / 3
    if (score < bestScore) {
      bestScore = score
      best = e
    }
  }
  return best
}

/** The taxiway names driven, in order: runs of one name shorter than MIN_RUN_M are dropped as junctions crossed. */
function drivenNames(net: Network, samples: GroundSample[]): { name: string; m: number }[] {
  const runs: { name: string; m: number }[] = []
  let prev: GroundSample | null = null
  for (const s of samples) {
    if (s.phase === 'takeoff') break
    if (s.groundSpeedMs < 1.5) continue
    const e = edgeAt(net, s)
    const name = e ? e.name : '?'
    const step = prev
      ? Math.hypot(
          (s.lat - prev.lat) * 111_320,
          (s.lon - prev.lon) * 111_320 * Math.cos((s.lat * Math.PI) / 180)
        )
      : 0
    prev = s
    const last = runs.at(-1)
    if (last && last.name === name) last.m += step
    else runs.push({ name, m: step })
  }
  const kept = runs.filter((r) => r.m >= MIN_RUN_M)
  const merged: { name: string; m: number }[] = []
  for (const r of kept) {
    const last = merged.at(-1)
    if (last && last.name === r.name) last.m += r.m
    else merged.push({ ...r })
  }
  return merged
}

/** The longest run of `want` found in order within `got`. */
function inOrder(want: string[], got: string[]): number {
  const dp = Array.from({ length: want.length + 1 }, () => new Array<number>(got.length + 1).fill(0))
  for (let i = 1; i <= want.length; i++)
    for (let k = 1; k <= got.length; k++)
      dp[i]![k] =
        want[i - 1] === got[k - 1] ? dp[i - 1]![k - 1]! + 1 : Math.max(dp[i - 1]![k]!, dp[i]![k - 1]!)
  return dp[want.length]![got.length]!
}

it('matches every recorded taxi to the network as flown', () => {
  const { db, close } = openUserDb()
  try {
    const pointsFor = (flightId: number) => listTrackPoints(db, flightId)
    const fromLog = scenariosFromLog(readInfoBoxesLogs(), listFlights(db), pointsFor)
    const handPath = join(simOutputDir('taxi'), 'hand-scenarios.json')
    const hands = existsSync(handPath) ? (JSON.parse(readFileSync(handPath, 'utf8')) as HandScenario[]) : []
    const fromHand = hands.flatMap((hand) => {
      const flight = getFlight(db, hand.flightId)
      const icao = flight ? (hand.side === 'out' ? flight.depIcao : flight.arrIcao) : null
      const sc =
        flight && icao
          ? scenarioFromHand(hand, flight, pointsFor(hand.flightId), listCachedRunways(db, icao))
          : null
      return sc ? [sc] : []
    })
    const byId = new Map<string, TaxiScenario>()
    for (const sc of [...fromLog, ...fromHand])
      if (sc.samples.length > 0 && !byId.has(sc.id)) byId.set(sc.id, sc)
    const results = [...byId.values()]
      .sort((a, b) => a.atMs - b.atMs)
      .map((sc) => {
        const net = loadNetwork(sc.icao)
        const clearance = boxTaxiClearance(sc.boxes)
        const cleared = clearance?.taxiways ?? []
        if (!net) return { id: sc.id, icao: sc.icao, cleared, driven: [], verdict: 'no network' }
        const driven = drivenNames(net, sc.samples)
        const names = driven.map((d) => d.name)
        const matched = inOrder(cleared, names)
        const verdict =
          cleared.length === 0
            ? 'no taxiways'
            : matched === cleared.length
              ? 'followed'
              : matched * 2 >= cleared.length
                ? 'partly'
                : 'not'
        return {
          id: sc.id,
          icao: sc.icao,
          cleared,
          end: clearance?.holdingPoint ?? clearance?.stand ?? clearance?.holdShortRunway ?? null,
          driven: driven.map((d) => `${d.name} ${Math.round(d.m)}m`),
          verdict,
          notCleared: [...new Set(names.filter((n) => !cleared.includes(n)))]
        }
      })
    writeFileSync(join(simOutputDir('taxi'), 'evidence.json'), JSON.stringify(results, null, 2))
    for (const r of results)
      process.stdout.write(
        `EVIDENCE ${r.id.padEnd(10)} ${r.icao} ${r.verdict.padEnd(9)} cleared [${r.cleared.join(', ')}] -> driven ${r.driven.join(' > ')}\n`
      )
  } finally {
    close()
  }
})
