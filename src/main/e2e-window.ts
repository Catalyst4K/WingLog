/** How an e2e run shows the app's window, so a test run on a developer's machine doesn't take over the screen or the keyboard focus. */

export const E2E_WINDOW_ENV = 'WINGLOG_E2E_WINDOW'
export const E2E_DISPLAY_ENV = 'WINGLOG_E2E_DISPLAY'

export type WindowShow = 'normal' | 'inactive' | 'hidden'

export interface DisplayBounds {
  /** The display's top-left and size, in screen coordinates. */
  bounds: { x: number; y: number; width: number; height: number }
  /** Whether it's the primary display. */
  primary: boolean
}

/**
 * How to show the window.
 *
 * @param value WINGLOG_E2E_WINDOW: `hidden` (never shown), `inactive` (shown without taking focus), anything else the normal show.
 * @returns The way to show it.
 */
export function windowShow(value: string | undefined): WindowShow {
  return value === 'hidden' || value === 'inactive' ? value : 'normal'
}

/**
 * Which display an e2e window goes on: the one asked for (WINGLOG_E2E_DISPLAY, counting from 1), else the first display that isn't the
 * primary one, else none (the window stays where Electron put it).
 *
 * @param displays The machine's displays.
 * @param value WINGLOG_E2E_DISPLAY.
 * @returns The display, or null.
 */
export function chooseDisplay(displays: DisplayBounds[], value: string | undefined): DisplayBounds | null {
  const asked = Number(value)
  if (value !== undefined && Number.isInteger(asked) && asked >= 1 && asked <= displays.length)
    return displays[asked - 1]
  return displays.find((d) => !d.primary) ?? null
}
