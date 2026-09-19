import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * Fleet's full CRUD path against the real built app — create, view detail, edit, delete —
 * per flightdeck-backend's docs/plans/test-coverage.md Phase 4. Only `registration` and
 * `icaoType` are required (aircraft-validation.ts); every other field is left blank/typed
 * free-text rather than picked from a dropdown, so this never depends on a real network
 * call (adsbdb registration lookup, SimBrief airframe search) succeeding in CI —
 * `aircraftTypeSearch`/`airlineSearch` are both backed by data vendored into the app, not
 * fetched live.
 */
test('create, view, edit, and delete an aircraft', async () => {
  const { window, cleanup } = await launchApp()
  try {
    await expect(window.getByRole('heading', { name: 'Fleet' })).toBeVisible()
    await expect(window.getByText('No active aircraft')).toBeVisible()

    // Create
    await window.getByRole('button', { name: 'New aircraft' }).click()
    await expect(window.getByRole('heading', { name: 'New aircraft' })).toBeVisible()
    await window.getByRole('textbox').first().fill('G-CRUD')
    await window.getByPlaceholder('e.g. A350, Boeing, B77W, or type an ICAO code').fill('A320')
    await window.getByRole('button', { name: 'Save' }).click()

    // Back on the list, the new row is there
    await expect(window.getByRole('heading', { name: 'Fleet' })).toBeVisible()
    await expect(window.getByRole('cell', { name: 'G-CRUD' })).toBeVisible()

    // View detail — the card title is a CardTitle (div), not a semantic heading
    await window.getByRole('row', { name: /G-CRUD/ }).click()
    await expect(window.getByText('G-CRUD — A320')).toBeVisible()

    // Edit
    await window.getByRole('button', { name: 'Edit' }).click()
    await expect(window.getByRole('heading', { name: 'Edit G-CRUD' })).toBeVisible()
    await window.getByPlaceholder('e.g. British Airways, BAW, or type a name').fill('Test Air')
    await window.getByRole('button', { name: 'Save' }).click()

    await expect(window.getByText('G-CRUD — A320')).toBeVisible()
    await expect(window.getByText('Test Air')).toBeVisible()

    // Delete
    await window.getByRole('button', { name: 'Delete' }).click()
    await expect(window.getByRole('heading', { name: 'Delete G-CRUD?' })).toBeVisible()
    await window.getByRole('button', { name: 'Delete aircraft' }).click()

    await expect(window.getByRole('heading', { name: 'Fleet' })).toBeVisible()
    await expect(window.getByText('No active aircraft')).toBeVisible()
  } finally {
    await cleanup()
  }
})

/**
 * Plain Retire (flightdeck-backend docs/plans/fleet-retire.md) through the real app — the
 * aircraft leaves the active list for the Retired tab (history kept, unlike Replace), and
 * Un-retire brings it back. Exercises the real IPC handlers and the 0027 migration.
 */
test('retire an aircraft, find it under Retired, then un-retire it', async () => {
  const { window, cleanup } = await launchApp()
  try {
    await window.getByRole('button', { name: 'New aircraft' }).click()
    await window.getByRole('textbox').first().fill('G-RETI')
    await window.getByPlaceholder('e.g. A350, Boeing, B77W, or type an ICAO code').fill('A320')
    await window.getByRole('button', { name: 'Save' }).click()
    await expect(window.getByRole('cell', { name: 'G-RETI' })).toBeVisible()

    await window.getByRole('row', { name: /G-RETI/ }).click()
    await window.getByRole('button', { name: 'Retire', exact: true }).click()
    await expect(window.getByRole('heading', { name: 'Retire G-RETI?' })).toBeVisible()
    await window.getByRole('button', { name: 'Retire aircraft' }).click()
    await expect(window.getByText(/its flight history is kept/)).toBeVisible()

    await window.getByRole('button', { name: 'Back to fleet' }).click()
    await expect(window.getByText('No active aircraft')).toBeVisible()
    await window.getByRole('tab', { name: 'Retired (1)' }).click()
    await expect(window.getByRole('cell', { name: 'G-RETI' })).toBeVisible()

    await window.getByRole('row', { name: /G-RETI/ }).click()
    await window.getByRole('button', { name: 'Un-retire' }).click()
    await expect(window.getByRole('button', { name: 'Retire', exact: true })).toBeVisible()

    await window.getByRole('button', { name: 'Back to fleet' }).click()
    await expect(window.getByRole('cell', { name: 'G-RETI' })).toBeVisible()
  } finally {
    await cleanup()
  }
})
