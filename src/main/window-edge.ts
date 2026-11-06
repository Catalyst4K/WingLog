/**
 * The thin border Windows 11 draws round a window, which follows the system's accent colour (a blue edge that looked foreign against the
 * app). It is set to the app's own ground colour, so the window's edge blends with the page; Windows 10 draws no such border and ignores it.
 */

import { BrowserWindow, nativeTheme } from 'electron'
import type { Theme } from '@shared/ipc'
import { currentPlatform } from './platform/platform'

/** The page's ground colour in each theme (the renderer's `--background`). */
const GROUND_LIGHT = '#ebe8de'
const GROUND_DARK = '#100f0e'

/**
 * @param theme The theme setting.
 * @param systemIsDark Whether the system is in its dark mode (what "System" follows).
 * @returns The colour of the page's ground in that theme.
 */
export function edgeColour(theme: Theme, systemIsDark: boolean): string {
  const dark = theme === 'dark' || (theme === 'system' && systemIsDark)
  return dark ? GROUND_DARK : GROUND_LIGHT
}

/**
 * Gives a window the edge colour of the theme. A failure is ignored: the edge is decoration.
 *
 * @param window The window.
 * @param theme The theme setting.
 */
export function applyWindowEdge(window: BrowserWindow, theme: Theme): void {
  if (currentPlatform() !== 'win32' || window.isDestroyed()) return
  try {
    window.setAccentColor(edgeColour(theme, nativeTheme.shouldUseDarkColors))
  } catch {
    // Older Windows, or a window that is closing: nothing to change.
  }
}

/**
 * Applies the theme's edge to every window, and again whenever the system's own light or dark mode changes (for "System").
 *
 * @param getTheme Reads the stored theme setting.
 * @returns A function that re-applies the edge to every window now (after the setting changes).
 */
export function keepWindowEdgesInStep(getTheme: () => Theme): () => void {
  const apply = (): void => {
    const theme = getTheme()
    for (const window of BrowserWindow.getAllWindows()) applyWindowEdge(window, theme)
  }
  nativeTheme.on('updated', apply)
  return apply
}
