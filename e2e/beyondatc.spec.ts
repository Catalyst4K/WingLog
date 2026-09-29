import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'
import {
  AUTO_SETTINGS_SNAPSHOT,
  FakeBeyondAtcServer,
  FREQUENCIES_RESPONSE,
  RADIO_CHECK_RESPONSE,
  RADIO_CHECK_SNAPSHOT
} from './beyondatc-server'

/**
 * Drives `BeyondAtcService`'s real WebSocket client through a real launched app — unit/
 * renderer-tested only (mocking `WebSocketCtor`/`window.winglog`) until now. `FakeBeyondAtcServer`
 * stands in for `BeyondATC.exe`'s own real local WebSocket server, same "real protocol, fake
 * transport" shape `gsx-remote.spec.ts` already uses for GSX. Real captures throughout, from
 * flightdeck-backend's docs/beyondatc-notes.md.
 */
test.describe('BeyondATC integration', () => {
  test('enabling in Settings drives the real BeyondATC tab end to end', async () => {
    const server = await FakeBeyondAtcServer.start()
    const { window: page, cleanup } = await launchApp()
    try {
      await page.getByRole('tab', { name: 'Settings' }).click()
      await page.getByRole('tab', { name: '3rd party' }).click()

      // Scoped to this card specifically — the GSX Remote Control card above it has its own,
      // identically-labelled "Off"/"On" toggle (same collision settings.spec.ts already
      // works around for the file-based GSX card).
      const beyondAtcCard = page.locator('[data-slot="card"]').filter({ hasText: 'BeyondATC' })
      await beyondAtcCard.getByLabel('Host').fill('127.0.0.1')
      await beyondAtcCard.getByRole('button', { name: 'Off', exact: true }).click()

      await server.waitForConnection()
      await expect(beyondAtcCard.getByText('Connected', { exact: true })).toBeVisible()

      server.sendLines(...RADIO_CHECK_SNAPSHOT)

      await page.getByRole('tab', { name: 'BeyondATC' }).click()
      await expect(page.getByRole('heading', { name: 'BeyondATC' })).toBeVisible()
      await expect(page.getByText('Cathay 116 Heavy')).toBeVisible()
      await expect(page.getByText('Tuned to Brisbane Delivery (118.850)')).toBeVisible()

      // The real set_action command, confirmed live against BeyondATC's own WebSocket.
      await page.getByRole('button', { name: 'Radio Check' }).click()
      await expect.poll(() => server.receivedCommands.at(-1)).toBe('set_action: Radio Check')

      server.sendLines(...RADIO_CHECK_RESPONSE)
      await expect(page.getByText('Cathay 116 Heavy, radio check.')).toBeVisible()
      await expect(page.getByText('Cathay 116 Heavy, readability 5.')).toBeVisible()

      // BeyondAtcService requests the real frequency list itself, right after connecting —
      // confirmed live 2026-09-29 (docs/beyondatc-notes.md).
      await expect.poll(() => server.receivedCommands).toContain('frequencies')
      server.sendLines(...FREQUENCIES_RESPONSE)
      server.sendLines(...AUTO_SETTINGS_SNAPSHOT)

      await page.getByRole('combobox', { name: 'Choose a frequency…' }).first().click()
      await page.getByRole('option', { name: 'SINGAPORE APPROACH 124.050' }).click()
      await expect.poll(() => server.receivedCommands.at(-1)).toBe('set_frequency: 124.050')

      await page.getByRole('button', { name: 'Auto-tune: On' }).click()
      await expect.poll(() => server.receivedCommands.at(-1)).toBe('set_autotune: false')
    } finally {
      await cleanup()
      await server.stop()
    }
  })
})
