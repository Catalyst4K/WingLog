import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * The first-launch setup end to end (winglog-backend's docs/plans/first-launch-setup.md):
 * shown to a fresh profile, choices saved through the real IPC, gone after a restart, and
 * back from Settings → About.
 */
test('a new install gets the setup once, its choices stick, and About reopens it', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'winglog-e2e-setup-'))
  try {
    const first = await launchApp({ userDataDir, keepSetup: true })
    try {
      const page = first.window
      const dialog = page.getByRole('dialog', { name: 'Welcome to WingLog' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText(/For flight simulation use only/)).toBeVisible()
      await page.getByRole('button', { name: 'Get started' }).click()

      await page.getByRole('textbox', { name: 'SimBrief username' }).fill('e2e-setup-pilot')
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByText('Saved.')).toBeVisible()
      for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Next' }).click()
      await page.getByRole('button', { name: 'Finish' }).click()
      await expect(page.getByRole('dialog')).toBeHidden()
      expect(await page.evaluate(() => window.winglog.settingsGetSimbriefUsername())).toBe('e2e-setup-pilot')
    } finally {
      await first.cleanup()
    }

    const second = await launchApp({ userDataDir, keepSetup: true })
    try {
      const page = second.window
      await expect(page.getByText('Fleet', { exact: true }).first()).toBeVisible()
      await expect(page.getByRole('dialog')).toBeHidden()
      await page.getByRole('tab', { name: 'Settings' }).click()
      await page.getByRole('tab', { name: 'About' }).click()
      await page.getByRole('button', { name: 'Run setup again' }).click()
      await expect(page.getByRole('dialog', { name: 'Welcome to WingLog' })).toBeVisible()
    } finally {
      await second.cleanup()
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
