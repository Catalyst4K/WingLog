import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'
import { FakeGsxRemoteServer, PUSHBACK_DIRECTION_MENU, VHHH_BOOT_SNAPSHOT } from './gsx-remote-server'

/**
 * Drives `GsxRemoteService`'s real WebSocket client through a real launched app, per
 * `gsx-remote-control.md`'s own "still open" list — this was unit/renderer-tested only
 * (mocking `WebSocketCtor`/`window.winglog`) until now. `FakeGsxRemoteServer` stands in for
 * GSX Pro's real Remote Client server — same "real protocol, fake transport" shape
 * `track-replay.spec.ts` already uses for SimConnect via `ReplaySimConnectService`, applied
 * to GSX's own WebSocket instead. All payloads are real captures from flightdeck-backend's
 * docs/gsx-notes.md, not invented shapes.
 */
test.describe('GSX Remote Control', () => {
  test('connecting in Settings drives the real GSX tab end to end', async () => {
    const server = await FakeGsxRemoteServer.start()
    const { window: page, cleanup } = await launchApp()
    try {
      await page.getByRole('tab', { name: 'Settings' }).click()
      await page.getByRole('tab', { name: '3rd party' }).click()

      // Scoped to this card specifically — the file-based GSX ground-services card above it
      // has its own, differently-purposed "Off"/"On" toggle with the same button text.
      const gsxRemoteCard = page.locator('[data-slot="card"]').filter({ hasText: 'GSX Remote Control' })
      await gsxRemoteCard.getByLabel('Host').fill('127.0.0.1')
      const portInput = gsxRemoteCard.getByLabel('Port')
      await portInput.fill(String(server.port))
      await portInput.blur()
      await gsxRemoteCard.getByRole('button', { name: 'Off', exact: true }).click()

      await server.waitForConnection()
      await expect(gsxRemoteCard.getByText('Connected', { exact: true })).toBeVisible()
      server.sendSnapshot(VHHH_BOOT_SNAPSHOT)

      await page.getByRole('tab', { name: 'Ground services' }).click()
      await expect(page.getByRole('heading', { name: 'Ground services' })).toBeVisible()

      // Gate header (state.airport/parking/gateProperties, combined by GsxRemoteService).
      await expect(page.getByText('Gate N6')).toBeVisible()
      await expect(page.getByText('VHHH · Hong Kong Intl · (N) T1 North')).toBeVisible()
      await expect(page.getByText('jetway')).toBeVisible()

      // A primary service (always visible) with structured fuel/billing detail, formatted.
      await expect(page.getByText('Refuel')).toBeVisible()
      await expect(page.getByText('15,357 / 81,488 kg')).toBeVisible()
      await expect(page.getByText(/24,272/)).toBeVisible()

      // A secondary, idle service (GPU) stays folded behind "show more" until active.
      await expect(page.getByText('GPU')).not.toBeVisible()
      await page.getByText('Show 1 more service').click()
      await expect(page.getByText('GPU')).toBeVisible()

      // Opening the menu sends the real command real GSX remotes send (menu.js's own
      // `cmd(closed ? "menu.toggle" : "menu.close")`) — not just passively mirroring state.
      await page.getByText('GSX Menu').click()
      await expect.poll(() => server.receivedCommands.some((c) => c.verb === 'menu.toggle')).toBe(true)
    } finally {
      await cleanup()
      await server.stop()
    }
  })

  test('an important GSX menu interrupts the whole app from another tab', async () => {
    const server = await FakeGsxRemoteServer.start()
    const { window: page, cleanup } = await launchApp()
    try {
      await page.getByRole('tab', { name: 'Settings' }).click()
      await page.getByRole('tab', { name: '3rd party' }).click()
      const gsxRemoteCard = page.locator('[data-slot="card"]').filter({ hasText: 'GSX Remote Control' })
      await gsxRemoteCard.getByLabel('Host').fill('127.0.0.1')
      const portInput = gsxRemoteCard.getByLabel('Port')
      await portInput.fill(String(server.port))
      await portInput.blur()
      await gsxRemoteCard.getByRole('button', { name: 'Off', exact: true }).click()
      await server.waitForConnection()
      server.sendSnapshot(VHHH_BOOT_SNAPSHOT)

      // Land back on Fleet — GSX's own important menus must reach the user wherever they are,
      // not only while the GSX tab happens to be open (Callum's explicit requirement).
      await page.getByRole('tab', { name: 'Fleet' }).click()

      server.sendPatch('menuShown', true)
      server.sendPatch('menu', PUSHBACK_DIRECTION_MENU)

      await expect(page.getByRole('dialog').getByText('GSX needs your input')).toBeVisible()
      await expect(page.getByText('Select pushback direction')).toBeVisible()
      await page.getByRole('button', { name: 'RED - Facing South onto B9' }).click()

      await expect.poll(() => server.receivedCommands.at(-1)).toEqual({ verb: 'menu.pick', args: { index: 0 } })
      // Picking an entry doesn't dismiss the dialog itself (GsxRemotePanel's own comment:
      // "doing so would just make the dialog flash closed then reopen") — GSX answering
      // with a new, different menu (or none) is what actually closes it. Confirm both, not
      // just the command that was sent.
      server.sendPatch('menuShown', false)
      server.sendPatch('menu', { title: '', header: '', subtitle: '', entries: [], icons: [], disabled: [], layout: '' })
      await expect(page.getByRole('dialog')).not.toBeVisible()
    } finally {
      await cleanup()
      await server.stop()
    }
  })
})
