import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * "Minimise to the tray" end to end (winglog-backend's docs/plans/tray.md): with the setting on, minimising hides the window
 * to the tray instead of the taskbar, and turning it off brings a hidden window back. The tray exists only on Windows.
 */
test.skip(process.platform !== 'win32', 'the tray is Windows-only')

test('minimising hides the window only when the tray setting is on', async () => {
  const { app, window: page, cleanup } = await launchApp()
  const isVisible = (): Promise<boolean> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
  try {
    await page.getByRole('tab', { name: 'Settings' }).click()
    await expect(page.getByRole('button', { name: 'Taskbar' })).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('button', { name: 'System tray' }).click()
    await expect
      .poll(() => page.evaluate(() => window.winglog.settingsGetWindow()))
      .toEqual({ minimizeToTray: true, trayAvailable: true })

    // Minimising hides the window rather than leaving it on the taskbar; the app is still running.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
    await expect.poll(isVisible).toBe(false)

    // Turning the setting off with the window hidden brings the window back, so the pilot is never locked out.
    await app.evaluate(async ({ BrowserWindow }) => {
      const [main] = BrowserWindow.getAllWindows()
      await main.webContents.executeJavaScript('window.winglog.settingsSetWindow({ minimizeToTray: false })')
    })
    await expect.poll(isVisible).toBe(true)

    // And with it off, minimising goes back to the taskbar.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()))
      .toBe(true)
  } finally {
    await cleanup()
  }
})
