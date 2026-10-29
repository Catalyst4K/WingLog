import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp } from './launch-app'
import { startFakeAreaReleases } from './atc-areas-release-server'

/**
 * The ATC areas update themselves (winglog-backend docs/plans/atc-areas-auto-update.md), against a fake GitHub on this machine: Settings
 * shows the areas bundled with the app, Check now brings newer releases down and uses them, the app's own copy is kept in its data folder,
 * and it is still in use after a restart. The scheduled weekly check is covered by the unit tests: its first look is a minute after launch.
 */
test('Check now brings newer ATC areas down, keeps them in the data folder, and uses them after a restart', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'winglog-e2e-atc-areas-'))
  const releases = await startFakeAreaReleases({ vatspy: 'v9999.1', tracon: 'v9.9.9' })
  try {
    const first = await launchApp({ userDataDir: profile, env: { WINGLOG_E2E_ATC_AREAS_URL: releases.url } })
    try {
      const page = first.window
      // The row is there only while a network is chosen.
      await page.getByRole('tab', { name: 'Settings' }).click()
      await page.getByRole('tab', { name: '3rd party' }).click()
      const card = page.locator('[data-slot="card"]').filter({ hasText: 'Online network' }).first()
      await expect(card.getByText('Keep ATC areas up to date')).toHaveCount(0)
      await card.getByRole('button', { name: 'VATSIM' }).click()
      await expect(card.getByText(/\(bundled with WingLog\)/)).toBeVisible()
      expect(releases.requests).toEqual([])

      await card.getByRole('button', { name: 'Check now' }).click()
      await expect(card.getByText('Updated to VAT-Spy v9999.1, TRACON v9.9.9.')).toBeVisible()
      await expect(
        card.getByText(/VAT-Spy v9999\.1, TRACON v9\.9\.9 \(downloaded from GitHub\)/)
      ).toBeVisible()
      expect(releases.requests.filter((path) => path.endsWith('/releases/latest'))).toHaveLength(2)
      expect(releases.requests.filter((path) => path.startsWith('/files/'))).toHaveLength(3)

      const copy = join(profile, 'atc-areas.json')
      expect(existsSync(copy)).toBe(true)
      expect(JSON.parse(readFileSync(copy, 'utf8')).sources).toEqual({ vatspy: 'v9999.1', tracon: 'v9.9.9' })

      // Again: already the newest, so nothing more is downloaded.
      const filesBefore = releases.requests.filter((path) => path.startsWith('/files/')).length
      await card.getByRole('button', { name: 'Check now' }).click()
      await expect(card.getByText('Already the newest.')).toBeVisible()
      expect(releases.requests.filter((path) => path.startsWith('/files/'))).toHaveLength(filesBefore)
    } finally {
      await first.cleanup()
    }

    // A restart in the same profile: the app's own copy is the one in use.
    const second = await launchApp({ userDataDir: profile, env: { WINGLOG_E2E_ATC_AREAS_URL: releases.url } })
    try {
      const status = await second.window.evaluate(() =>
        (
          globalThis as unknown as { winglog: { atcAreasGetStatus: () => Promise<unknown> } }
        ).winglog.atcAreasGetStatus()
      )
      expect(status).toMatchObject({ source: 'downloaded', vatspy: 'v9999.1', tracon: 'v9.9.9', auto: true })
    } finally {
      await second.cleanup()
    }
  } finally {
    await releases.close()
    rmSync(profile, { recursive: true, force: true })
  }
})

test('without a fake server, a launched app reaches no real GitHub: Check now fails quietly and the bundled areas stay', async () => {
  const { window: page, cleanup } = await launchApp()
  try {
    const check = await page.evaluate(() =>
      (
        globalThis as unknown as { winglog: { atcAreasCheckNow: () => Promise<unknown> } }
      ).winglog.atcAreasCheckNow()
    )
    expect(check).toMatchObject({ outcome: 'failed', status: { source: 'bundled', checkedAt: null } })
  } finally {
    await cleanup()
  }
})
