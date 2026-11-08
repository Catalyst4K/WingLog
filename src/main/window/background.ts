/**
 * Running in the background (winglog-backend's docs/plans/multi-device.md, Part 5): the sim PC's WingLog starts in the tray with no window, so
 * the Mac's WingLog is used as the app and this one just does the sim's work. Pure, so each case is tested without Electron.
 */

import type { AppCapabilities } from '@shared/run-mode'

/** What decides whether "run in the background" and "start with Windows" are offered. */
export interface BackgroundContext {
  capabilities: Pick<AppCapabilities, 'runMode' | 'multiDevice'>
  /** Whether a tray icon can be shown here. */
  trayAvailable: boolean
  /** Whether this is an installed copy, not a development run. */
  isPackaged: boolean
  /** The operating system (`process.platform`). */
  platform: string
}

/** What is offered. */
export interface BackgroundOffer {
  /** Run in the background: the multi-device build, as the sim PC's host, where a tray exists (a window with no tray could not be got back). */
  available: boolean
  /** Start with Windows: the same, and an installed copy on Windows (a development run would register the wrong program). */
  loginItemAvailable: boolean
}

/**
 * @param context This run of the app.
 * @returns What it offers.
 */
export function backgroundOffer(context: BackgroundContext): BackgroundOffer {
  const available =
    context.capabilities.multiDevice && context.capabilities.runMode === 'host' && context.trayAvailable
  return { available, loginItemAvailable: available && context.isPackaged && context.platform === 'win32' }
}

/**
 * @param offer What is offered.
 * @param hostOnly The saved choice.
 * @returns Whether the window is left hidden at start: only where the choice is offered, so a choice saved earlier is ignored where it is not.
 */
export function startsHidden(offer: BackgroundOffer, hostOnly: boolean): boolean {
  return offer.available && hostOnly
}
