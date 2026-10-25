/**
 * Makes the committed test fixtures for the online-network parsers, in src/main/online/__fixtures__/.
 *
 *   npx tsx --tsconfig tsconfig.node.json scripts/online-fixture.ts
 *
 * VATSIM: trimmed from the newest real capture in release/online-capture/vatsim/ (made by scripts/online-capture.ts): the pilots near
 * one airport plus that area's controllers and ATIS, with every name removed and every CID replaced. Callsigns are kept (public).
 * IVAO: SYNTHETIC. The real structure with every value invented (callsigns TST001.., VIDs from 900001), placed around the airport.
 * No real IVAO record is ever committed, even trimmed (Regulation D.2).
 * Also writes the malformed variants for both networks. Plan: winglog-backend docs/plans/vatsim-build.md, Step 0.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { destinationPoint, greatCircleNm, type LatLon } from '@shared/geo'

const CAPTURE_DIR = join('release', 'online-capture', 'vatsim')
const OUT_DIR = join('src', 'main', 'online', '__fixtures__')
const SCENE_RADIUS_NM = 300
/** The most pilots kept in one scene: the nearest, so the committed fixture stays small. */
const SCENE_MAX_PILOTS = 150
const FIRST_FAKE_CID = 1_000_001
const FIRST_FAKE_VID = 900_001
const OBSERVERS_KEPT = 8

interface Scene {
  file: string
  airport: LatLon
  /** Callsign prefixes (before the first underscore) of the controllers and ATIS kept. */
  prefixes: string[]
  withObservers: boolean
}

const SCENES: Scene[] = [
  {
    file: 'vatsim-busy.json',
    airport: { lat: 51.4706, lon: -0.4619 },
    prefixes: ['EGLL', 'EGKK', 'EGSS', 'LON', 'EGLC'],
    withObservers: false
  },
  {
    file: 'vatsim-observers.json',
    airport: { lat: 40.6398, lon: -73.7789 },
    prefixes: ['KJFK', 'JFK', 'EWR', 'LGA', 'N90', 'KEWR', 'KLGA'],
    withObservers: true
  }
]

type Json = Record<string, unknown>

function newestCapture(): Json {
  const files = readdirSync(CAPTURE_DIR).sort()
  const newest = files[files.length - 1]
  if (!newest) throw new Error(`no capture in ${CAPTURE_DIR}: run scripts/online-capture.ts first`)
  return JSON.parse(readFileSync(join(CAPTURE_DIR, newest), 'utf8')) as Json
}

function sceneVatsim(raw: Json, scene: Scene): Json {
  let nextCid = FIRST_FAKE_CID
  const pilots = (raw.pilots as Json[])
    .map((p) => ({
      p,
      nm: greatCircleNm(scene.airport, { lat: p.latitude as number, lon: p.longitude as number })
    }))
    .filter(({ nm }) => nm <= SCENE_RADIUS_NM)
    .sort((a, b) => a.nm - b.nm)
    .slice(0, SCENE_MAX_PILOTS)
    .map(({ p }) => {
      const plan = p.flight_plan as Json | null
      // Free text a pilot typed can name them: dropped.
      return { ...p, cid: nextCid++, name: 'Test Pilot', flight_plan: plan ? { ...plan, remarks: '' } : null }
    })
  const prefix = (callsign: unknown): string => String(callsign).split('_')[0] ?? ''
  const controllers = (raw.controllers as Json[]).filter(
    (c) => (c.facility as number) > 0 && scene.prefixes.includes(prefix(c.callsign))
  )
  // An observer logon’s callsign can be a member number or a name, so these are renamed.
  const observers = scene.withObservers
    ? (raw.controllers as Json[])
        .filter((c) => c.facility === 0)
        .slice(0, OBSERVERS_KEPT)
        .map((c, i) => ({ ...c, callsign: `TESTOBS${i + 1}` }))
    : []
  const scrub = (c: Json): Json => ({
    ...c,
    cid: nextCid++,
    name: 'Test Controller',
    text_atis: c.text_atis ? ['Test controller information'] : null
  })
  const atis = (raw.atis as Json[])
    .filter((a) => scene.prefixes.includes(prefix(a.callsign)))
    .map((a) => ({ ...a, cid: nextCid++, name: 'Test ATIS' }))
  return {
    general: raw.general,
    pilots,
    controllers: [...controllers, ...observers].map(scrub),
    atis,
    servers: [],
    prefiles: [],
    facilities: raw.facilities,
    ratings: raw.ratings,
    pilot_ratings: raw.pilot_ratings,
    military_ratings: raw.military_ratings
  }
}

/** A small deterministic generator, so regenerating the fixture changes nothing. */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296
    return state / 4_294_967_296
  }
}

function syntheticIvao(airport: LatLon): Json {
  const random = seeded(24)
  const ivaoPlan = (dep: string, arr: string): Json => ({
    id: 1,
    revision: 1,
    aircraftId: 'A320',
    aircraftNumber: 1,
    departureId: dep,
    arrivalId: arr,
    alternativeId: null,
    alternative2Id: null,
    route: 'DCT',
    remarks: 'TEST',
    speed: 'N0450',
    level: 'F350',
    flightRules: 'I',
    flightType: 'N',
    eet: 3600,
    endurance: 18000,
    departureTime: 0,
    actualDepartureTime: null,
    peopleOnBoard: 100,
    aircraft: { icaoCode: 'A320', model: 'A320', wakeTurbulence: 'M', military: false, description: 'L2J' }
  })
  const pilots: Json[] = []
  for (let i = 0; i < 40; i++) {
    const onGround = i < 10
    const position = destinationPoint(
      airport,
      random() * 360,
      (onGround ? random() * 3 : 20 + random() * 400) * 1852
    )
    pilots.push({
      id: 1000 + i,
      userId: FIRST_FAKE_VID + i,
      callsign: `TST${String(i + 1).padStart(3, '0')}`,
      serverId: 'TEST',
      softwareTypeId: 'altitude',
      softwareVersion: '0',
      rating: 2,
      createdAt: '2026-10-24T20:00:00.000Z',
      time: 3600,
      pilotSession: { simulatorId: 'MSFS2020', textureId: null },
      lastTrack: {
        altitude: onGround ? 80 : 20000 + Math.round(random() * 20000),
        altitudeDifference: 0,
        arrivalDistance: null,
        departureDistance: null,
        groundSpeed: onGround ? Math.round(random() * 20) : 300 + Math.round(random() * 200),
        heading: Math.round(random() * 359),
        latitude: position.lat,
        longitude: position.lon,
        onGround,
        state: onGround ? 'On Ground' : 'En Route',
        timestamp: '2026-10-24T21:00:00.000Z',
        transponder: 2000 + i,
        transponderMode: 'N',
        time: 3600
      },
      flightPlan: i % 7 === 0 ? null : ivaoPlan('ZZZA', 'ZZZB')
    })
  }
  const atc = (id: number, position: string, frequency: number, lines: string[] | null): Json => ({
    id,
    userId: FIRST_FAKE_VID + 100 + id,
    callsign: `TSTA_${position}`,
    serverId: 'TEST',
    softwareTypeId: 'aurora',
    softwareVersion: '0',
    rating: 5,
    createdAt: '2026-10-24T20:00:00.000Z',
    time: 3600,
    atcSession: { frequency, position },
    lastTrack: {
      altitude: 0,
      altitudeDifference: 0,
      arrivalDistance: null,
      departureDistance: null,
      groundSpeed: 0,
      heading: 0,
      latitude: airport.lat,
      longitude: airport.lon,
      onGround: true,
      state: null,
      timestamp: '2026-10-24T21:00:00.000Z',
      transponder: 0,
      transponderMode: null,
      time: 0
    },
    atis: lines ? { lines, revision: 'A', timestamp: '2026-10-24T20:50:00.000Z' } : null
  })
  return {
    updatedAt: '2026-10-24T21:00:05.000Z',
    servers: [],
    voiceServers: [],
    connections: { total: 41, supervisor: 0, atc: 3, observer: 1, pilot: 40, worldTour: 0, sweatbox: 0 },
    clients: {
      pilots,
      atcs: [
        atc(1, 'TWR', 118.1, ['TEST ATIS INFORMATION A', 'RUNWAY 27 IN USE']),
        atc(2, 'GND', 121.7, null),
        atc(3, 'APP', 119.725, ['TEST APPROACH'])
      ],
      observers: [
        {
          id: 9,
          userId: FIRST_FAKE_VID + 200,
          callsign: 'TSTO_OBS',
          serverId: 'TEST',
          softwareTypeId: 'aurora',
          softwareVersion: '0',
          rating: 1,
          createdAt: '2026-10-24T20:00:00.000Z',
          time: 3600
        }
      ],
      followMe: []
    }
  }
}

function malformed(vatsim: Json, ivao: Json): Record<string, string> {
  const firstVatsim = (vatsim.pilots as Json[])[0] as Json
  const firstIvao = ((ivao.clients as Json).pilots as Json[])[0] as Json
  const vatsimWith = (pilot: Json): string =>
    JSON.stringify({ ...vatsim, pilots: [pilot, ...(vatsim.pilots as Json[]).slice(1, 4)] })
  const ivaoWith = (pilot: Json): string =>
    JSON.stringify({
      ...ivao,
      clients: {
        ...(ivao.clients as Json),
        pilots: [pilot, ...((ivao.clients as Json).pilots as Json[]).slice(1, 4)]
      }
    })
  const lastTrack = firstIvao.lastTrack as Json
  const ivaoTrack = (changes: Json): Json => ({ ...firstIvao, lastTrack: { ...lastTrack, ...changes } })
  const small = JSON.stringify({ ...vatsim, pilots: (vatsim.pilots as Json[]).slice(0, 4) })
  const smallIvao = JSON.stringify({
    ...ivao,
    clients: { ...(ivao.clients as Json), pilots: ((ivao.clients as Json).pilots as Json[]).slice(0, 4) }
  })
  const html =
    '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1></body></html>'
  return {
    'vatsim-html-error.html': html,
    'ivao-html-error.html': html,
    'vatsim-truncated.json': small.slice(0, Math.floor(small.length / 2)),
    'ivao-truncated.json': smallIvao.slice(0, Math.floor(smallIvao.length / 2)),
    'vatsim-no-pilots.json': JSON.stringify({ ...vatsim, pilots: undefined }),
    'ivao-no-pilots.json': JSON.stringify({ ...ivao, clients: {} }),
    'vatsim-wrong-types.json': vatsimWith({
      ...firstVatsim,
      latitude: '51.4',
      longitude: null,
      groundspeed: 'fast',
      heading: {},
      callsign: 42
    }),
    'ivao-wrong-types.json': ivaoWith(
      ivaoTrack({ latitude: '51.4', longitude: null, groundSpeed: 'fast', heading: {} })
    ),
    'vatsim-huge-callsign.json': vatsimWith({ ...firstVatsim, callsign: 'X'.repeat(10_000) }),
    'ivao-huge-callsign.json': ivaoWith({ ...firstIvao, callsign: 'X'.repeat(10_000) }),
    'vatsim-bad-positions.json': vatsimWith({
      ...firstVatsim,
      latitude: 999,
      longitude: -999,
      groundspeed: -5,
      altitude: 1e12
    }),
    'ivao-bad-positions.json': ivaoWith(
      ivaoTrack({ latitude: 999, longitude: -999, groundSpeed: -5, altitude: 1e12 })
    ),
    'vatsim-control-chars.json': vatsimWith({ ...firstVatsim, callsign: 'AB\u0000C\u001b[31m1\n2' })
  }
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(join(OUT_DIR, 'malformed'), { recursive: true })
  const raw = newestCapture()
  const scenes = SCENES.map((scene) => ({ scene, data: sceneVatsim(raw, scene) }))
  for (const { scene, data } of scenes)
    writeFileSync(join(OUT_DIR, scene.file), JSON.stringify(data, null, 1) + '\n')
  const ivao = syntheticIvao(SCENES[0]!.airport)
  writeFileSync(join(OUT_DIR, 'ivao-synthetic.json'), JSON.stringify(ivao, null, 1) + '\n')
  for (const [name, text] of Object.entries(malformed(scenes[0]!.data, ivao)))
    writeFileSync(join(OUT_DIR, 'malformed', name), text)
  for (const { scene, data } of scenes)
    console.log(
      scene.file,
      (data.pilots as Json[]).length,
      'pilots',
      (data.controllers as Json[]).length,
      'controllers',
      (data.atis as Json[]).length,
      'atis'
    )
}

main()
