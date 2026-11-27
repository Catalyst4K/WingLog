/**
 * An end-to-end run can't follow WingLog starting itself again: `app.relaunch()` would leave a WingLog running outside Playwright. With
 * this variable set to `1` (e2e/launch-app.ts sets it for every test), Restart now only quits, and the test starts the app again itself.
 * A packaged build ignores it.
 */
export const E2E_NO_RELAUNCH_ENV = 'WINGLOG_E2E_NO_RELAUNCH'

/**
 * @param isPackaged Whether this is a packaged build (`app.isPackaged`).
 * @param value The variable's value.
 * @returns Whether Restart now should start the app again after it quits.
 */
export function shouldRelaunch(isPackaged: boolean, value: string | undefined): boolean {
  return isPackaged || value !== '1'
}
