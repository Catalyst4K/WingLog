import { join } from 'node:path'
import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { Device, freePort, latestTopic } from './lan-device'
import { launchApp, type LaunchedApp } from './launch-app'

/**
 * What the second-screen fault specs share (winglog-backend's docs/plans/taxi-and-second-screen-robustness.md, stage 7): a recorded taxi
 * at ZJSY replayed through the real app with a flight, the second screen on and phones paired, and `screensAgree`, which says whether the
 * PC and its phones hold the same taxi line, the same procedure choice and the same planned route.
 */

/** A choice with a departure runway and procedures, as a phone or the PC window makes it. */
export interface Choice {
  departureRunway: string | null
  sidIdent: string | null
  sidTransition: string | null
  starIdent: string | null
  starTransition: string | null
  approachIdent: string | null
  approachTransition: string | null
  arrivalIcao: string | null
}

export const CHOICE_A: Choice = {
  departureRunway: '08',
  sidIdent: 'PORA1N',
  sidTransition: null,
  starIdent: 'CANT3A',
  starTransition: null,
  approachIdent: null,
  approachTransition: null,
  arrivalIcao: null
}

export const CHOICE_B: Choice = { ...CHOICE_A, sidIdent: 'LAMEN1N', starIdent: 'CANT3B' }

export interface TaxiFlight extends LaunchedApp {
  port: number
  flightId: number
  /** A phone paired with the PC: its token, to come back with, and the device. */
  pair(name?: string): Promise<{ device: Device; token: string }>
  /** A phone that was paired already, back again with its token. */
  reconnect(token: string): Promise<Device>
  /** Starts tracking the flight, which plays the replay. */
  start(): Promise<void>
}

export interface TaxiFlightOptions {
  /** Replay speed: 1 is real time; the recorded taxi lasts 7 min 45 s. */
  speed?: number
  userDataDir?: string
  env?: Record<string, string>
  /** Make the flight, as a new profile needs; false for an app started again on the data of an earlier one. */
  createFlight?: boolean
}

/**
 * Launches the app with the recorded ZJSY taxi held at its first sample, a flight, the second screen on and a pairing code at hand.
 *
 * @param options Speed, data directory and extra environment.
 * @returns The app, and ways to pair phones and to start the replay.
 */
export async function launchTaxiFlight(options: TaxiFlightOptions = {}): Promise<TaxiFlight> {
  const port = await freePort()
  const launched = await launchApp({
    userDataDir: options.userDataDir,
    env: {
      WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1',
      WINGLOG_E2E_FIXTURE: join(process.cwd(), 'src/main/tracking/__fixtures__/zjsy-taxi-d-b7-a.ndjson'),
      WINGLOG_E2E_REPLAY_MODE: 'paced',
      WINGLOG_E2E_REPLAY_SPEED: String(options.speed ?? 40),
      WINGLOG_E2E_REPLAY_STREAMS: 'beyondatc',
      // Parked at the first sample until tracking starts, so the phones are paired and BeyondATC is on before anything moves.
      WINGLOG_E2E_REPLAY_HOLD: '1',
      WINGLOG_E2E_TAXI_NETWORK: join(process.cwd(), 'src/shared/taxi/__fixtures__/zjsy-taxi-d-b7-a.json'),
      WINGLOG_E2E_TAXI_ICAO: 'ZJSY',
      ...options.env
    }
  })
  const { window: pc } = launched
  const { flightId } = await pc.evaluate(
    async ({ p, create }) => {
      const api = (globalThis as unknown as Window).winglog
      let id = -1
      if (create) {
        const aircraft = await api.aircraftCreate({ registration: 'G-TEST', icaoType: 'A320' })
        id = (await api.flightCreate({ aircraftId: aircraft.id, depIcao: 'ZJSY', arrIcao: 'VHHH' })).id
      }
      await api.settingsSetBeyondAtc({ enabled: true, host: '127.0.0.1' })
      await api.lanSetSettings({ enabled: true, port: p })
      return { flightId: id }
    },
    { p: port, create: options.createFlight ?? true }
  )

  const pair = async (name = 'Test phone'): Promise<{ device: Device; token: string }> => {
    const code = await pc.evaluate(
      async () => (await (globalThis as unknown as Window).winglog.lanStartPairing()).pairing?.code ?? ''
    )
    const device = new Device(port)
    await device.opened()
    device.send({ t: 'pair', code, name })
    const paired = await device.message('paired')
    await device.message('snapshot')
    return { device, token: String(paired.token) }
  }
  const reconnect = async (token: string): Promise<Device> => {
    const device = new Device(port)
    await device.opened()
    device.send({ t: 'hello', token })
    await device.message('snapshot')
    return device
  }
  return {
    ...launched,
    port,
    flightId,
    pair,
    reconnect,
    start: () => pc.evaluate((id) => (globalThis as unknown as Window).winglog.trackingStart(id), flightId)
  }
}

/**
 * @param pc The PC window.
 * @returns What the PC holds: the taxi line, and the procedure choice for the flight shown.
 */
async function pcState(pc: Page): Promise<{ taxiRoute: unknown; selection: unknown }> {
  return pc.evaluate(async () => {
    const api = (globalThis as unknown as Window).winglog
    return { taxiRoute: await api.getTaxiRoute(), selection: await api.trackingGetProcedureSelection() }
  })
}

/**
 * Says whether the PC and its phones show the same thing, within a time: the same taxi line (revision and points), the same procedure
 * choice, and the same planned route (the phones' route carries the choice it was built from).
 *
 * The PC window assembles its own planned route from its lookups (the plan's D1), so the route is compared between the phones, and
 * against the PC's choice; the taxi line and the choice are compared with the PC's own.
 *
 * @param pc The PC window.
 * @param phones The paired phones that are connected.
 * @param timeoutMs How long they have to agree.
 */
export async function screensAgree(pc: Page, phones: Device[], timeoutMs = 5000): Promise<void> {
  await expect
    .poll(
      async () => {
        const held = await pcState(pc)
        const taxi = JSON.stringify(held.taxiRoute)
        const choice = JSON.stringify(held.selection)
        const routes = phones.map((p) => JSON.stringify(latestTopic(p, 'plannedRoute')))
        return {
          taxi: phones.map((p) => JSON.stringify(latestTopic(p, 'taxiRoute')) === taxi),
          choice: phones.map((p) => {
            const shown = latestTopic(p, 'procedureSelection')
            return choice === 'null'
              ? shown === null || shown === undefined
              : JSON.stringify(shown) === choice
          }),
          routeChoice: phones.map((p) => {
            const route = latestTopic(p, 'plannedRoute')
            return !route || choice === 'null' || JSON.stringify(route.selection) === choice
          }),
          sameRoute: routes.every((r) => r === routes[0])
        }
      },
      { timeout: timeoutMs, message: 'the PC and its phones show the same taxi line, choice and route' }
    )
    .toEqual({
      taxi: phones.map(() => true),
      choice: phones.map(() => true),
      routeChoice: phones.map(() => true),
      sameRoute: true
    })
}

/**
 * Waits until the taxi line has settled at the end of the replay: the same revision on the PC for a few seconds.
 *
 * @param pc The PC window.
 * @param app The app, for its window list.
 * @param timeoutMs How long to wait.
 */
export async function taxiLineSettled(pc: Page, timeoutMs = 90_000): Promise<number> {
  let last = -1
  let since = Date.now()
  await expect
    .poll(
      async () => {
        const route = (await pcState(pc)).taxiRoute as { revision: number } | null
        const revision = route?.revision ?? -1
        if (revision !== last) {
          last = revision
          since = Date.now()
        }
        return revision >= 0 && Date.now() - since > 3000
      },
      { timeout: timeoutMs }
    )
    .toBe(true)
  return last
}

export type { ElectronApplication }
