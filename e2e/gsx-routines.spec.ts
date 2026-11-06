import { expect, test, type Page } from '@playwright/test'
import { FakeGsxRemoteServer } from './gsx-remote-server'
import { ScriptedGsx } from './gsx-routine-session'
import { freePort } from './lan-device'
import { launchApp } from './launch-app'

/**
 * GSX routines (winglog-backend's docs/plans/gsx-service-presets.md): the real app against a scripted GSX that answers the way the
 * recorded GSX does. The Departure routine is run through to Boarding requested, on the PC window and from a phone, and a routine
 * of the pilot's own is made in the editor and saved.
 */

/** The pick order GSX should see for the Departure routine: Catering and Refueling together, Boarding after Catering completes. */
const FENIX_PICKS = ['Request Catering service', 'Request Refueling', 'Request Boarding']

/**
 * A planned flight with a planned weight (a routine's data-entry guard needs one before it asks for Boarding), and GSX Remote
 * pointed at the scripted GSX.
 *
 * @param page The PC window.
 * @param gsxPort The scripted GSX's port.
 */
async function setUp(page: Page, gsxPort: number): Promise<void> {
  await page.evaluate(async (port) => {
    const api = (globalThis as unknown as Window).winglog
    const aircraft = await api.aircraftCreate({ registration: 'B-TEST', icaoType: 'A320' })
    await api.flightCreate({ aircraftId: aircraft.id, depIcao: 'VHHH', arrIcao: 'ZJSY', zfwKg: 62_000 })
    await api.settingsSetGsxRemote({ enabled: true, host: '127.0.0.1', port })
  }, gsxPort)
  // The window reads whether GSX Remote is on when it opens, so it is opened again now that it is.
  await page.reload()
}

test.describe('GSX routines', () => {
  test('the Departure routine runs on the PC window through to Boarding, and a routine of your own can be made', async () => {
    const server = await FakeGsxRemoteServer.start()
    const gsx = new ScriptedGsx(server)
    const { window: page, cleanup } = await launchApp()
    try {
      await setUp(page, server.port)
      await server.waitForConnection()
      gsx.sendBootSnapshot()
      await page.getByRole('tab', { name: 'Ground services' }).click()

      // The three built-ins, and a way to make another.
      for (const name of ['Departure', 'Arrival', 'Turnaround clean']) {
        await expect(page.getByRole('button', { name, exact: true })).toBeEnabled()
      }
      await expect(page.getByRole('button', { name: 'New routine' })).toBeVisible()

      await page.getByRole('button', { name: 'Departure', exact: true }).click()
      const progress = page.getByTestId('gsx-routine-progress')
      await expect(progress.getByText('Stage 1 of 2')).toBeVisible()

      // Catering and Refueling are asked for one after another, each through its own opened menu.
      await expect.poll(() => gsx.picks).toEqual(['Request Catering service', 'Request Refueling'])
      await expect(progress.getByRole('status')).toHaveText('Waiting for: Catering.')
      await page.screenshot({
        path: 'release/sim/gsx-routines/pc-waiting-for-catering.png',
        animations: 'disabled'
      })
      expect(gsx.picks).not.toContain('Request Boarding')

      // Boarding waits for Catering to complete, and is asked for only then.
      gsx.setState('Catering', 'performing')
      gsx.setState('Refueling', 'performing')
      await page.waitForTimeout(500)
      expect(gsx.picks).not.toContain('Request Boarding')
      gsx.setState('Catering', 'completed')
      await expect.poll(() => gsx.picks).toEqual(FENIX_PICKS)

      // Everything finishes, and the routine says so.
      gsx.setState('Catering', 'available')
      gsx.setState('Refueling', 'completed')
      gsx.setState('Boarding', 'performing')
      gsx.setState('Boarding', 'completed')
      await expect(progress.getByRole('status')).toHaveText('Routine finished.')
      await page.screenshot({ path: 'release/sim/gsx-routines/pc-finished.png', animations: 'disabled' })
      await expect(progress.getByRole('button', { name: 'Cancel' })).toHaveCount(0)

      // A routine of your own: name it, tick services, save, and it is on the row.
      await page.getByRole('button', { name: 'New routine' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Name').fill('Cabin turn')
      await dialog.getByRole('button', { name: 'Cleaning', exact: true }).click()
      await dialog.getByRole('button', { name: 'Water', exact: true }).click()
      await dialog.getByRole('button', { name: 'Catering', exact: true }).click()
      await expect(dialog.getByLabel('What stage 2 waits for')).toHaveValue('Cleaning')
      await page.screenshot({ path: 'release/sim/gsx-routines/pc-editor.png', animations: 'disabled' })
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Cabin turn', exact: true })).toBeVisible()

      // A routine that comes with WingLog is edited and deleted the same way as one of your own.
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
      await page.getByRole('button', { name: 'Edit Arrival' }).click()
      await dialog.getByLabel('Name').fill('Gate arrival')
      await dialog.getByRole('button', { name: 'GPU', exact: true }).click()
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Edit Arrival' })).toHaveCount(0)
      await page.getByRole('button', { name: 'Edit Gate arrival' }).click()
      await expect(dialog.getByRole('button', { name: 'GPU', exact: true })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(dialog.getByTestId('gsx-routine-delete-confirmation')).toContainText(
        'Delete “Gate arrival”?'
      )
      await page.screenshot({
        path: 'release/sim/gsx-routines/pc-delete-confirmation.png',
        animations: 'disabled'
      })
      await dialog
        .getByTestId('gsx-routine-delete-confirmation')
        .getByRole('button', { name: 'Delete' })
        .click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Edit Gate arrival' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Edit Turnaround clean' })).toBeVisible()
    } finally {
      await cleanup()
      await server.stop()
    }
  })

  test('a routine stops, and says why, when the aircraft has no planned weight for Boarding', async () => {
    const server = await FakeGsxRemoteServer.start()
    const gsx = new ScriptedGsx(server)
    const { window: page, cleanup } = await launchApp()
    try {
      await page.evaluate(
        (port) =>
          (globalThis as unknown as Window).winglog.settingsSetGsxRemote({
            enabled: true,
            host: '127.0.0.1',
            port
          }),
        server.port
      )
      await page.reload()
      await server.waitForConnection()
      gsx.sendBootSnapshot()
      await page.getByRole('tab', { name: 'Ground services' }).click()
      await page.getByRole('button', { name: 'New routine' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: 'Boarding', exact: true }).click()
      await dialog.getByRole('button', { name: 'Save' }).click()
      await page.getByRole('button', { name: 'My routine', exact: true }).click()
      await expect(page.getByTestId('gsx-routine-progress').getByRole('status')).toHaveText(
        'Routine stopped: WingLog has no planned weight for this flight.'
      )
      expect(gsx.picks).toEqual([])
    } finally {
      await cleanup()
      await server.stop()
    }
  })

  test('a phone starts and cancels a routine and has no editor', async () => {
    const server = await FakeGsxRemoteServer.start()
    const gsx = new ScriptedGsx(server)
    const port = await freePort()
    const { app, window: page, cleanup } = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      await setUp(page, server.port)
      const code = await page.evaluate(async (lanPort) => {
        const api = (globalThis as unknown as Window).winglog
        await api.lanSetSettings({ enabled: true, port: lanPort })
        return (await api.lanStartPairing()).pairing?.code ?? ''
      }, port)
      await server.waitForConnection()

      const known = app.windows().length
      await app.evaluate(async ({ BrowserWindow }, url) => {
        const window = new BrowserWindow({ show: false, width: 390, height: 780, useContentSize: true })
        await window.loadURL(url)
      }, `http://127.0.0.1:${port}/#code=${code}`)
      await expect.poll(() => app.windows().length).toBeGreaterThan(known)
      const phone = app.windows().find((w) => w.url().startsWith(`http://127.0.0.1:${port}`))!

      gsx.sendBootSnapshot()
      await phone.getByRole('navigation').getByRole('button', { name: 'Ground services' }).click()
      await expect(phone.getByRole('button', { name: 'Departure', exact: true })).toBeEnabled()
      await expect(phone.getByRole('button', { name: 'New routine' })).toHaveCount(0)
      await expect(phone.getByRole('button', { name: /^Edit / })).toHaveCount(0)

      await phone.getByRole('button', { name: 'Departure', exact: true }).click()
      const progress = phone.getByTestId('gsx-routine-progress')
      await expect(progress.getByText('Stage 1 of 2')).toBeVisible()
      await expect.poll(() => gsx.picks).toEqual(['Request Catering service', 'Request Refueling'])
      await phone.screenshot({ path: 'release/sim/gsx-routines/phone-running.png', animations: 'disabled' })

      // Cancel from the phone is seen on the PC window as well.
      // With services under way Cancel first asks what to do with them (plan/gsx-routine-cancel).
      await progress.getByRole('button', { name: 'Cancel' }).click()
      await progress.getByRole('button', { name: 'Leave them running' }).click()
      // A plain cancel takes the routine off every screen at once (routine-driver.ts), it is not left saying "cancelled".
      await expect(progress).toHaveCount(0)
      await page.getByRole('tab', { name: 'Ground services' }).click()
      await expect(page.getByTestId('gsx-routine-progress')).toHaveCount(0)
    } finally {
      await cleanup()
      await server.stop()
    }
  })
})
