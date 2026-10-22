// Scratch (not committed): which network segments cross a runway, and which hold shorts beside it lead to one.
import { it } from 'vitest'
import { listCachedRunways, listCachedTaxiSegments } from '../../src/main/db/navdata-repo'
import { openUserDb } from './local-data'

it('cross', () => {
  const { db, close } = openUserDb()
  const icao = process.env.ICAO ?? 'VHHH'
  const rwy = listCachedRunways(db, icao).find((r) => r.ident === (process.env.RWY ?? '07C'))!
  const segs = listCachedTaxiSegments(db, icao)
  const h = (rwy.headingTrueDeg * Math.PI) / 180
  const frame = (lat: number, lon: number) => {
    const north = (lat - rwy.thresholdLat) * 111_320
    const east = (lon - rwy.thresholdLon) * 111_320 * Math.cos((rwy.thresholdLat * Math.PI) / 180)
    return { along: north * Math.cos(h) + east * Math.sin(h), across: east * Math.cos(h) - north * Math.sin(h) }
  }
  process.stdout.write(`RWY ${rwy.ident} len ${Math.round(rwy.lengthM)} width ${Math.round(rwy.widthM)} heading ${Math.round(rwy.headingTrueDeg)}\n`)
  const crossing = segs.filter((s) => {
    const a = frame(s.startLat, s.startLon), b = frame(s.endLat, s.endLon)
    return a.across * b.across < 0 && Math.min(a.along, b.along) > -300 && Math.max(a.along, b.along) < rwy.lengthM + 300
  })
  for (const s of crossing) {
    const a = frame(s.startLat, s.startLon), b = frame(s.endLat, s.endLon)
    process.stdout.write(`CROSS ${String(s.name).padEnd(5)} along ${Math.round(a.along)}..${Math.round(b.along)} across ${Math.round(a.across)}..${Math.round(b.across)}\n`)
  }
  const holds = new Map<string, { along: number; across: number; names: Set<string> }>()
  for (const s of segs) for (const [lat, lon, hs] of [[s.startLat, s.startLon, s.startHoldShort], [s.endLat, s.endLon, s.endHoldShort]] as const) {
    if (!hs) continue
    const f = frame(lat, lon)
    if (f.along < -150 || f.along > rwy.lengthM + 150 || Math.abs(f.across) > rwy.widthM / 2 + 150) continue
    const k = `${lat},${lon}`
    const e = holds.get(k) ?? { ...f, names: new Set<string>() }
    e.names.add(s.name ?? '-')
    holds.set(k, e)
  }
  for (const [k, v] of [...holds.entries()].sort((a, b) => a[1].along - b[1].along))
    process.stdout.write(`HOLD along ${Math.round(v.along)} across ${Math.round(v.across)} [${[...v.names].join('/')}] ${k}\n`)
  close()
})
