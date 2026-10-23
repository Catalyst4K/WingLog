import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { Device, freePort, latestTopic } from './lan-device'
import { launchApp } from './launch-app'

/**
 * The procedure choice for the flight shown is held in the PC's main process (winglog-backend's
 * docs/plans/taxi-and-second-screen-robustness.md, stage 4): a phone's choice is saved on the flight and shown on the phone with the PC
 * window on the Logbook, and it is still there, on the PC window and on a phone, after the app is closed and started again on the same data.
 */

const CHOICE = {
  departureRunway: '08',
  sidIdent: 'PORA1N',
  sidTransition: null,
  starIdent: 'CANT3A',
  starTransition: null,
  approachIdent: null,
  approachTransition: null,
  arrivalIcao: null
}

/**
 * @param page The PC window.
 * @returns The choice the main process holds for the flight shown.
 */
function held(page: Page): Promise<unknown> {
  return page.evaluate(() => (globalThis as unknown as Window).winglog.trackingGetProcedureSelection())
}

/**
 * Pairs a device with the PC, as the phone page does.
 *
 * @param port The second screen's port.
 * @param code The pairing code the PC shows.
 * @returns The device, once it has its snapshot.
 */
async function pairPhone(port: number, code: string): Promise<Device> {
  const phone = new Device(port)
  await phone.opened()
  phone.send({ t: 'pair', code, name: 'Test phone' })
  await phone.message('paired')
  await phone.message('snapshot')
  return phone
}

test.describe('Second screen: the procedure choice', () => {
  test("a phone's choice is saved by the PC and survives a restart, with the PC window on the Logbook throughout", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'winglog-e2e-selection-'))
    const port = await freePort()
    const env = { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' }
    try {
      const first = await launchApp({ userDataDir, env })
      try {
        const code = await first.window.evaluate(async (p) => {
          const api = (globalThis as unknown as Window).winglog
          const aircraft = await api.aircraftCreate({ registration: 'G-TEST', icaoType: 'A320' })
          await api.flightCreate({ aircraftId: aircraft.id, depIcao: 'ZJSY', arrIcao: 'VHHH' })
          await api.lanSetSettings({ enabled: true, port: p })
          return (await api.lanStartPairing()).pairing?.code ?? ''
        }, port)
        const phone = await pairPhone(port, code)

        // The PC window is on the Logbook, not Track: nothing the phone does may depend on the page it shows.
        await first.window.getByRole('tab', { name: 'Logbook' }).click()
        await expect(first.window.getByRole('tab', { name: 'Logbook' })).toHaveAttribute(
          'aria-selected',
          'true'
        )

        // Nothing chosen yet.
        expect(await held(first.window)).toMatchObject({ sidIdent: null })

        phone.send({ t: 'cmd', name: 'track.setProcedureSelection', args: [CHOICE] })
        // Announced back to the phone as the choice and as the route built from it, and held by the PC for its own window.
        await expect.poll(() => latestTopic(phone, 'procedureSelection')?.sidIdent).toBe('PORA1N')
        await expect
          .poll(() => (latestTopic(phone, 'plannedRoute')?.selection as { sidIdent?: string })?.sidIdent)
          .toBe('PORA1N')
        expect(await held(first.window)).toEqual(CHOICE)
        phone.close()
      } finally {
        await first.cleanup()
      }

      // The app is started again on the same data: the choice was saved on the flight when it was made.
      const second = await launchApp({ userDataDir, env })
      try {
        await expect.poll(() => held(second.window)).toEqual(CHOICE)
        const code = await second.window.evaluate(
          async () => (await (globalThis as unknown as Window).winglog.lanStartPairing()).pairing?.code ?? ''
        )
        const phone = await pairPhone(port, code)
        expect(latestTopic(phone, 'procedureSelection')).toEqual(CHOICE)
        expect(latestTopic(phone, 'plannedRoute')?.selection).toEqual(CHOICE)
        phone.close()
      } finally {
        await second.cleanup()
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
