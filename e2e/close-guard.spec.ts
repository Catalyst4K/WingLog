import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * Closing the window while a flight is tracked asks first (src/main/window/CloseGuard.ts, winglog-backend's
 * docs/plans/tray.md): answering "keep open" leaves the window up and the flight recording. The native
 * question is stood in for by a stub in the main process, since a test can't click an OS dialog.
 */
test('closing the window while a flight is tracked asks first, and keeps it open on no', async () => {
  const fixturePath = join(process.cwd(), 'src/main/tracking/__fixtures__/tier2-vfr-no-ofp-short-hop.ndjson')
  const {
    app,
    window: page,
    cleanup
  } = await launchApp({
    env: {
      WINGLOG_E2E_FIXTURE: fixturePath,
      WINGLOG_E2E_REPLAY_MODE: 'paced',
      WINGLOG_E2E_REPLAY_SPEED: '200',
      WINGLOG_E2E_REPLAY_HOLD: '1',
      // Turns the guard on: launchApp switches it off for every other test.
      WINGLOG_E2E_NO_CLOSE_PROMPT: ''
    }
  })
  try {
    await page.getByRole('tab', { name: 'Track' }).click()
    await page.getByRole('button', { name: 'Free flight' }).click()
    await page.getByRole('button', { name: 'Start tracking' }).click()
    await expect(page.getByText(/Phase:/)).toBeVisible()

    // Answers the question with "keep open" (button 1), counting how often it is asked.
    await app.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { asked: number; answer: number }
      state.asked = 0
      state.answer = 1
      dialog.showMessageBox = (() => {
        state.asked++
        return Promise.resolve({ response: state.answer, checkboxChecked: false })
      }) as never
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { asked: number }).asked)).toBe(1)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true)
    await expect(page.getByText(/Phase:/)).toBeVisible()

    // Let the app close for the cleanup.
    await app.evaluate(() => {
      ;(globalThis as unknown as { answer: number }).answer = 0
    })
  } finally {
    await cleanup()
  }
})
