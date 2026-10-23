import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { freePort, openPhone } from './lan-device'
import { launchApp } from './launch-app'

/**
 * The phone leaves evidence in the PC's log (winglog-backend's docs/plans/taxi-and-second-screen-robustness.md, stage 5): that it took the
 * route the PC pushed, and what its script threw. The next flaky moment on a flight then has both sides to read. A hidden window of the app's
 * Chromium stands in for the phone, over loopback.
 */

/**
 * @param userDataDir The app's profile.
 * @returns The PC's log so far, or empty before it is written.
 */
function mainLog(userDataDir: string): string {
  try {
    return readFileSync(join(userDataDir, 'logs', 'main.log'), 'utf8')
  } catch {
    return ''
  }
}

test.describe('Second screen: what the phone tells the PC', () => {
  test('a route it takes and a script error on its page are written to the PC log, tagged with the device', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'winglog-e2e-reports-'))
    const port = await freePort()
    const {
      app,
      window: pc,
      cleanup
    } = await launchApp({
      userDataDir,
      env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' }
    })
    try {
      const code = await pc.evaluate(async (p) => {
        const api = (globalThis as unknown as Window).winglog
        const aircraft = await api.aircraftCreate({ registration: 'G-TEST', icaoType: 'A320' })
        await api.flightCreate({ aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'KJFK' })
        await api.lanSetSettings({ enabled: true, port: p })
        return (await api.lanStartPairing()).pairing?.code ?? ''
      }, port)
      const phone = await openPhone(app, `http://127.0.0.1:${port}/#code=${code}`)
      await expect(phone.getByRole('navigation')).toBeVisible()

      // The route the PC built for the flight shown reached the page: the PC's log says which revision the phone took.
      await expect
        .poll(() => /\[lan\] device \d+ reports route-applied: r1/.test(mainLog(userDataDir)), {
          timeout: 20_000
        })
        .toBe(true)

      // A script error on the page, from a timer: the message is in the PC's log, never a stack.
      await phone.evaluate(() => {
        setTimeout(() => {
          throw new Error('phone boom')
        }, 0)
      })
      await expect
        .poll(
          () =>
            /\[lan\] device \d+ reports script-error: Uncaught Error: phone boom/.test(mainLog(userDataDir)),
          {
            timeout: 20_000
          }
        )
        .toBe(true)
      expect(mainLog(userDataDir)).not.toMatch(/reports script-error[^\n]*\n\s+at /)
    } finally {
      await cleanup()
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })
})
