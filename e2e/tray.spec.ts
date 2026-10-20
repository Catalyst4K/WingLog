import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * "Keep running in the tray" end to end (winglog-backend's docs/plans/tray.md): closing the window quits by default;
 * with the setting on it hides the window and the app carries on, and quitting still quits. The tray exists only on Windows.
 */
test.skip(process.platform !== 'win32', 'the tray is Windows-only')

test('closing the window keeps WingLog running only when the tray setting is on', async () => {
  const { app, window: page, cleanup } = await launchApp()
  try {
    await page.getByRole('tab', { name: 'Settings' }).click()
    await expect(page.getByRole('button', { name: 'Quit WingLog' })).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('button', { name: 'Keep running in the tray' }).click()
    await expect
      .poll(() => page.evaluate(() => window.winglog.settingsGetWindow()))
      .toEqual({ closeToTray: true, trayAvailable: true })

    // Closing hides the window; the app (and its main process) is still there.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))
      .toBe(false)

    // Turning the setting off with the window hidden brings the window back, so the pilot is never locked out.
    await app.evaluate(async ({ BrowserWindow }) => {
      const [main] = BrowserWindow.getAllWindows()
      await main.webContents.executeJavaScript('window.winglog.settingsSetWindow({ closeToTray: false })')
    })
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))
      .toBe(true)
  } finally {
    await cleanup()
  }
})
