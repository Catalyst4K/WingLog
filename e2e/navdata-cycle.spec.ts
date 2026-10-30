import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * Which navigation data the sim has, read from a fake Navigraph install in the test's own app-data folder
 * (winglog-backend docs/plans/navdata-cycle-check.md). The launcher points the app at `<profile>/fake-msfs`, so no run reads this
 * machine's real Navigraph files; the cycles used are an ancient one and a far-future one, so the test does not depend on the date.
 */

/**
 * @param profile The test's profile folder.
 * @param cycle The cycle the fake Navigraph package states, or null for no Navigraph at all.
 */
function installNavigraph(profile: string, cycle: string | null): void {
  const cfgDir = join(profile, 'fake-msfs')
  const packages = join(profile, 'fake-packages')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'UserCfg.opt'), `InstalledPackagesPath "${packages}"\r\n`)
  if (cycle === null) return
  const info = join(packages, 'Community', 'navigraph-nav-base', 'ContentInfo', 'navigraph-navdata')
  mkdirSync(info, { recursive: true })
  writeFileSync(
    join(info, 'cycle.json'),
    JSON.stringify({ cycle, revision: '2', validityPeriod: '2099-01-01/2099-01-28' })
  )
}

/**
 * @param profile The profile folder to use.
 * @returns The launched app's navigation data status, read through the real IPC.
 */
async function statusIn(profile: string): Promise<{ status: unknown; text: string }> {
  const { window: page, cleanup } = await launchApp({ userDataDir: profile })
  try {
    await page.getByRole('tab', { name: 'Settings' }).click()
    await page.getByRole('tab', { name: '3rd party' }).click()
    const card = page.locator('[data-slot="card"]').filter({ hasText: 'Navigation data' }).first()
    await expect(card).toContainText(/Navigraph AIRAC|Its cycle cannot be read/)
    const status = await page.evaluate(() =>
      (
        globalThis as unknown as { winglog: { navdataGetStatus: () => Promise<unknown> } }
      ).winglog.navdataGetStatus()
    )
    return { status, text: (await card.textContent()) ?? '' }
  } finally {
    await cleanup()
  }
}

test.describe('navigation data cycle', () => {
  test('warns, in Settings, when the sim’s Navigraph data is a cycle behind the calendar', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'winglog-e2e-navdata-'))
    try {
      installNavigraph(profile, '2001')
      const { status, text } = await statusIn(profile)
      expect(status).toMatchObject({ source: 'navigraph', cycle: '2001', revision: '2', state: 'behind' })
      expect(text).toContain('Navigraph AIRAC 2001, revision 2, valid until 2099-01-28')
      expect(text).toMatch(/but \d{4} is the current cycle\. Update it in the Navigraph Hub\./)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })

  test('says it is up to date when the package is not behind the calendar’s cycle, with no warning', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'winglog-e2e-navdata-'))
    try {
      installNavigraph(profile, '9999')
      const { status, text } = await statusIn(profile)
      expect(status).toMatchObject({ source: 'navigraph', cycle: '9999', state: 'current' })
      const { calendarCycle } = status as { calendarCycle: string }
      expect(text).toContain(`Up to date with the current cycle (${calendarCycle}).`)
      expect(text).not.toContain('Update it in the Navigraph Hub')
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })

  test('is the sim’s own data, with nothing to compare, when there is no Navigraph package', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'winglog-e2e-navdata-'))
    try {
      installNavigraph(profile, null)
      const { status, text } = await statusIn(profile)
      expect(status).toMatchObject({ source: 'default', cycle: null, state: 'default' })
      expect(text).toContain('Its cycle cannot be read')
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })
})
