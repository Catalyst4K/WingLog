import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * Closing the window while a flight is in progress asks first (src/main/window/CloseGuard.ts, winglog-backend's
 * docs/plans/tray.md). A flight counts from the moment Dispatch's "Fly" loads it, before the sim connects and tracking
 * starts, so this plans a flight with no sim at all. Answering "keep open" leaves the window up; answering close ends the app. The question is
 * asked in the app window itself.
 */
test('closing the window with a flight loaded asks first, and closes only on yes', async () => {
  const {
    app,
    window: page,
    cleanup
  } = await launchApp({
    // Turns the guard on: launchApp switches it off for every other test.
    env: { WINGLOG_E2E_NO_CLOSE_PROMPT: '' }
  })
  const isVisible = (): Promise<boolean> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
  const tryClose = (): Promise<void> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  try {
    // A planned flight, as Dispatch's Fly leaves it: no sim connected, nothing tracked yet.
    await page.evaluate(async () => {
      const aircraft = await window.winglog.aircraftCreate({ registration: 'G-GUARD', icaoType: 'C172' })
      await window.winglog.flightCreate({ aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
    })

    // The question is a dialog inside the app, not an operating-system message box.
    await tryClose()
    const dialog = page.getByRole('alertdialog', { name: 'Close WingLog?' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Keep open' }).click()
    await expect(dialog).toBeHidden()
    expect(await isVisible()).toBe(true)

    // Closing again asks again; this time the pilot closes, which ends the app.
    await tryClose()
    await expect(dialog).toBeVisible()
    const exited = app.waitForEvent('close')
    // The page goes away mid-click, so the click itself reports a closed page; the app exiting is the result.
    await dialog
      .getByRole('button', { name: 'Close WingLog' })
      .click()
      .catch(() => undefined)
    await exited
  } finally {
    await cleanup()
  }
})
