import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { Device, freePort } from './lan-device'
import { launchApp } from './launch-app'

/**
 * The taxi line is traced once, on the PC (winglog-backend's docs/plans/taxi-and-second-screen-robustness.md, stage 3), and reaches a
 * paired phone whatever page the PC window is on. A recorded taxi at ZJSY ("taxi to holding point A, runway 08, via D, B7, A", flight 227's
 * positions) is replayed through the real app with the clearance BeyondATC gave, on the airport's real taxi network.
 */

/** The taxi route a device was last sent, from its snapshot or a later push. */
function latestTaxiRoute(device: Device): Record<string, unknown> | null {
  let latest: Record<string, unknown> | null = null
  for (const message of device.received) {
    if (message.t === 'snapshot') {
      const topics = message.topics as Record<string, unknown> | undefined
      if (topics && 'taxiRoute' in topics) latest = topics.taxiRoute as Record<string, unknown> | null
    } else if (message.t === 'topic' && message.name === 'taxiRoute') {
      latest = message.payload as Record<string, unknown> | null
    }
  }
  return latest
}

/** A real runway 08 hold short of ZJSY's taxiway A, where the clearance ends. */
const RUNWAY_08_HOLD = { lat: 18.30168, lon: 109.39634 }

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180))
}

test.describe('Second screen: the taxi line', () => {
  test('is traced on the PC and reaches a phone, with the PC window on the Logbook throughout', async () => {
    const port = await freePort()
    const { window: pc, cleanup } = await launchApp({
      env: {
        WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1',
        WINGLOG_E2E_FIXTURE: join(process.cwd(), 'src/main/tracking/__fixtures__/zjsy-taxi-d-b7-a.ndjson'),
        WINGLOG_E2E_REPLAY_MODE: 'paced',
        WINGLOG_E2E_REPLAY_SPEED: '40',
        WINGLOG_E2E_REPLAY_STREAMS: 'beyondatc',
        // Parked at the first tick until tracking starts, so the phone is paired and BeyondATC is on before anything moves.
        WINGLOG_E2E_REPLAY_HOLD: '1',
        WINGLOG_E2E_TAXI_NETWORK: join(process.cwd(), 'src/shared/taxi/__fixtures__/zjsy-taxi-d-b7-a.json'),
        WINGLOG_E2E_TAXI_ICAO: 'ZJSY'
      }
    })
    try {
      const { flightId, code } = await pc.evaluate(async (p) => {
        const api = (globalThis as unknown as Window).winglog
        const aircraft = await api.aircraftCreate({ registration: 'G-TEST', icaoType: 'A320' })
        const flight = await api.flightCreate({ aircraftId: aircraft.id, depIcao: 'ZJSY', arrIcao: 'VHHH' })
        await api.settingsSetBeyondAtc({ enabled: true, host: '127.0.0.1' })
        await api.lanSetSettings({ enabled: true, port: p })
        return { flightId: flight.id, code: (await api.lanStartPairing()).pairing?.code ?? '' }
      }, port)

      const phone = new Device(port)
      await phone.opened()
      phone.send({ t: 'pair', code, name: 'Test phone' })
      await phone.message('paired')
      await phone.message('snapshot')

      // The PC window is on the Logbook, not Track: nothing on the phone may depend on the page the window shows.
      await pc.getByRole('tab', { name: 'Logbook' }).click()
      await expect(pc.getByRole('tab', { name: 'Logbook' })).toHaveAttribute('aria-selected', 'true')

      await pc.evaluate((id) => (globalThis as unknown as Window).winglog.trackingStart(id), flightId)

      // The line arrives on the phone, traced from the clearance on the airport's network.
      await expect
        .poll(() => latestTaxiRoute(phone)?.kind ?? null, { timeout: 30_000 })
        .toMatch(/^(exact|pathfinder)$/)
      const route = latestTaxiRoute(phone)!
      expect(route).toMatchObject({
        icao: 'ZJSY',
        clearance: { taxiways: ['D', 'B7', 'A'], holdingPoint: 'A', stand: null, holdShortRunway: null }
      })
      expect((route.line as unknown[]).length).toBeGreaterThan(2)

      // The replay ends with the aircraft held at the runway: the line has settled, and the phone and the PC window hold the same one.
      await expect
        .poll(
          async () => {
            const onPc = await pc.evaluate(() => (globalThis as unknown as Window).winglog.getTaxiRoute())
            return JSON.stringify(latestTaxiRoute(phone)) === JSON.stringify(onPc)
          },
          { timeout: 30_000 }
        )
        .toBe(true)
      await expect
        .poll(() => latestTaxiRoute(phone)?.revision as number, { timeout: 30_000 })
        .toBeGreaterThan(3)
      const settled = latestTaxiRoute(phone)!
      const line = settled.line as [number, number][]
      const [endLon, endLat] = line[line.length - 1]
      expect(distanceM({ lat: endLat, lon: endLon }, RUNWAY_08_HOLD)).toBeLessThan(40)
      await expect(pc.getByRole('tab', { name: 'Logbook' })).toHaveAttribute('aria-selected', 'true')

      phone.close()
    } finally {
      await cleanup()
    }
  })
})
