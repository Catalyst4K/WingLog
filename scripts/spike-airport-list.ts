/**
 * Throwaway spike for flightdeck-backend docs/plans/landing-airfield-from-sim.md, Step 1.
 * Confirms against a live MSFS 2024 whether the sim's own airport list (SimConnect
 * RequestFacilitiesList / SubscribeToFacilities on AIRPORT) includes add-on/closed fields
 * that the vendored OurAirports slice lacks (Kai Tak = VHHX), and how long it takes.
 *
 * Prints every airport within SPIKE_RADIUS_NM (default 15) of the user's aircraft, sorted by
 * distance, marking the ones missing from resources/airports.csv. Then, if SPIKE_ICAO (or
 * the nearest unknown airport) is set, requests its RUNWAYS via the same facility request
 * the navdata provider uses and prints them.
 *
 * Usage (MSFS running, aircraft loaded near Kai Tak or anywhere):
 *   npm run spike:airport-list
 *   SPIKE_ICAO=VHHX npm run spike:airport-list
 * Log answers in flightdeck-backend docs/simconnect-notes.md.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  open,
  Protocol,
  SimConnectConstants,
  SimConnectDataType,
  SimConnectPeriod,
  FacilityListType,
  FacilityDataType
} from 'node-simconnect'
import { NavdataDefId, addRunwayFields, parseAirportHeader, parseRunway } from '../src/main/sim/facility-fields'

const RADIUS_NM = Number(process.env['SPIKE_RADIUS_NM'] ?? 15)
const RUNWAY_ICAO = process.env['SPIKE_ICAO']

const vendored = new Set(
  readFileSync(join(process.cwd(), 'resources', 'airports.csv'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.split(',')[0]?.replace(/"/g, ''))
    .filter((v): v is string => !!v)
)
console.log(`Vendored airports.csv ident column has ${vendored.size} entries`)

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return (2 * 6371008.8 * Math.asin(Math.sqrt(a))) / 1852
}

const started = Date.now()
open('WingLog airport-list spike', Protocol.SunRise)
  .then(({ recvOpen, handle }) => {
    console.log(`Connected: ${recvOpen.applicationName}`)
    let lat: number | null = null
    let lon: number | null = null
    const airports: { icao: string; region: string; lat: number; lon: number }[] = []
    let listCount = 0

    handle.addToDataDefinition(0, 'PLANE LATITUDE', 'degrees', SimConnectDataType.FLOAT64, 0, 0)
    handle.addToDataDefinition(0, 'PLANE LONGITUDE', 'degrees', SimConnectDataType.FLOAT64, 0, 1)
    handle.requestDataOnSimObject(0, 0, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND)
    handle.on('simObjectData', (d) => {
      lat = d.data.readFloat64()
      lon = d.data.readFloat64()
    })

    handle.on('airportList', (list) => {
      listCount++
      airports.push(...list.airports.map((a) => ({ icao: a.icao, region: a.region, lat: a.latitude, lon: a.longitude })))
      if (list.entryNumber + 1 >= list.outOf) report()
    })

    let reported = false
    function report(): void {
      if (reported) return
      reported = true
      console.log(`Total airports received: ${airports.length} in ${Date.now() - started}ms (${listCount} packets)`)
      if (lat === null || lon === null) {
        console.log('No aircraft position yet — waiting for the flight to load...')
        reported = false
        setTimeout(report, 2000)
        return
      }
      const near = airports
        .map((a) => ({ ...a, nm: haversineNm(lat!, lon!, a.lat, a.lon) }))
        .filter((a) => a.nm <= RADIUS_NM)
        .sort((x, y) => x.nm - y.nm)
      console.log(`Within ${RADIUS_NM} nm of ${lat.toFixed(4)}, ${lon.toFixed(4)}:`)
      for (const a of near) {
        console.log(
          `  ${a.icao.padEnd(6)} region=${a.region.padEnd(4)} ${a.nm.toFixed(1).padStart(5)} nm  ${vendored.has(a.icao) ? '' : '<-- NOT IN VENDORED LIST'}`
        )
      }
      const target = RUNWAY_ICAO ?? near.find((a) => !vendored.has(a.icao))?.icao
      if (target) requestRunways(target)
      else setTimeout(() => process.exit(0), 500)
    }

    // Both routes, so the notes can say which one works: a one-shot list request and a
    // subscription (the subscription is what would keep a cache fresh in the app).
    handle.requestFacilitiesList(FacilityListType.AIRPORT, 1)
    setTimeout(() => {
      if (!reported) {
        console.log('No airportList reply after 15 s')
        report()
      }
    }, 15_000)

    function requestRunways(icao: string): void {
      console.log(`Requesting RUNWAYS for ${icao}...`)
      const t0 = Date.now()
      handle.addToFacilityDefinition(NavdataDefId.RUNWAYS, 'OPEN AIRPORT')
      handle.addToFacilityDefinition(NavdataDefId.RUNWAYS, 'ICAO')
      addRunwayFields((name) => handle.addToFacilityDefinition(NavdataDefId.RUNWAYS, name))
      handle.addToFacilityDefinition(NavdataDefId.RUNWAYS, 'CLOSE AIRPORT')
      handle.on('facilityData', (recv) => {
        if (recv.type === FacilityDataType.AIRPORT) console.log('  airport', parseAirportHeader(recv.data))
        else if (recv.type === FacilityDataType.RUNWAY) console.log('  runway', parseRunway(recv.data))
      })
      handle.on('facilityDataEnd', () => {
        console.log(`RUNWAYS for ${icao} complete in ${Date.now() - t0}ms`)
        process.exit(0)
      })
      handle.on('facilityMinimalList', (m) => console.log('  minimal list', m.data))
      handle.requestFacilityData(NavdataDefId.RUNWAYS, NavdataDefId.RUNWAYS, icao)
      setTimeout(() => {
        console.log('RUNWAYS request timed out after 20 s')
        process.exit(1)
      }, 20_000)
    }

    handle.on('exception', (e) => console.error(`SimConnect exception: ${e.exceptionName} (index ${e.index})`))
    handle.on('quit', () => process.exit(0))
  })
  .catch((error: unknown) => {
    console.error('Connection failed:', error)
    process.exit(1)
  })
