import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'
import { FakeBeyondAtcServer, LARGE_REAL_SNAPSHOT, RADIO_CHECK_RESPONSE, RADIO_CHECK_SNAPSHOT } from './beyondatc-server'

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
    } finally {
      await cleanup()
      await server.stop()
    }
  })

  test('a real full-size initial snapshot (real bug, 2026-09-28) parses past the first line', async () => {
    // Node's built-in global WebSocket silently dropped every line after the first in a
    // message this size — BeyondAtcService now uses the `ws` package instead. RADIO_CHECK_
    // SNAPSHOT above (three short lines) never exercised a message large enough to hit this;
    // LARGE_REAL_SNAPSHOT is a real ~18-line capture, deliberately kept full-size.
    const server = await FakeBeyondAtcServer.start()
    const { window: page, cleanup } = await launchApp()
    try {
      await page.getByRole('tab', { name: 'Settings' }).click()
      await page.getByRole('tab', { name: '3rd party' }).click()
      const beyondAtcCard = page.locator('[data-slot="card"]').filter({ hasText: 'BeyondATC' })
      await beyondAtcCard.getByLabel('Host').fill('127.0.0.1')
      await beyondAtcCard.getByRole('button', { name: 'Off', exact: true }).click()
      await server.waitForConnection()

      server.sendLines(...LARGE_REAL_SNAPSHOT)

      await page.getByRole('tab', { name: 'BeyondATC' }).click()
      await expect(page.getByRole('heading', { name: 'BeyondATC' })).toBeVisible()
      // Facility is the first line — always parsed even with the bug. Everything below is
      // only reachable if the lines after it survived too.
      await expect(page.getByText('Tuned to Singapore Delivery (121.650)')).toBeVisible()
      await expect(page.getByText('Singapore 830 Super')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Request IFR Clearance' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Radio Check' })).toBeVisible()
    } finally {
      await cleanup()
      await server.stop()
    }
  })
})
