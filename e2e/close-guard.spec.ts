import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * Closing the window while a flight is in progress asks first (src/main/window/CloseGuard.ts, winglog-backend's
 * docs/plans/tray.md). A flight counts from the moment Dispatch's "Fly" loads it, before the sim connects and tracking
 * starts, so this plans a flight with no sim at all. Answering "keep open" leaves the window up. The native question is
 * stood in for by a stub in the main process, since a test can't click an OS dialog.
 */
test('closing the window with a flight loaded asks first, and keeps it open on no', async () => {
  const {
    app,
    window: page,
    cleanup
  } = await launchApp({
    // Turns the guard on: launchApp switches it off for every other test.
    env: { WINGLOG_E2E_NO_CLOSE_PROMPT: '' }
  })
  const asked = (): Promise<number> => app.evaluate(() => (globalThis as unknown as { asked: number }).asked)
  const isVisible = (): Promise<boolean> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
  const tryClose = (): Promise<void> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  try {
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

    // A planned flight, as Dispatch's Fly leaves it: no sim connected, nothing tracked yet.
    await page.evaluate(async () => {
      const aircraft = await window.winglog.aircraftCreate({ registration: 'G-GUARD', icaoType: 'C172' })
      await window.winglog.flightCreate({ aircraftId: aircraft.id, depIcao: 'EGLL', arrIcao: 'EGCC' })
    })

    await tryClose()
    await expect.poll(asked).toBe(1)
    expect(await isVisible()).toBe(true)

    // Let the app close for the cleanup.
    await app.evaluate(() => {
      ;(globalThis as unknown as { answer: number }).answer = 0
    })
  } finally {
    await cleanup()
  }
})
