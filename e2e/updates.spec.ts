import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { test, expect } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * The update check end to end (winglog-backend's docs/plans/update-check.md, Part A),
 * against a fake GitHub "latest release" endpoint serving the real response shape. Never
 * clicks Download: that opens the real browser.
 */
const RELEASE = {
  tag_name: 'v99.0.0',
  name: 'WingLog 99.0.0',
  html_url: 'https://github.com/Catalyst4K/WingLog/releases/tag/v99.0.0',
  body: '## New\n- Everything',
  draft: false,
  prerelease: false,
  published_at: '2026-10-04T18:00:00Z'
}

async function startFakeGitHub(): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(RELEASE))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/repos/Catalyst4K/WingLog/releases/latest`, server }
}

test('"Check now" finds a newer release, the banner offers it, and "Skip this version" sticks across a restart', async () => {
  const { url, server } = await startFakeGitHub()
  const userDataDir = mkdtempSync(join(tmpdir(), 'winglog-e2e-updates-'))
  try {
    const first = await launchApp({ userDataDir, env: { WINGLOG_UPDATE_URL: url } })
    try {
      const page = first.window
      await page.getByRole('tab', { name: 'Settings' }).click()
      await page.getByRole('tab', { name: 'About' }).click()
      await expect(page.getByRole('button', { name: 'On', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await page.getByRole('button', { name: 'Check now' }).click()

      const banner = page.getByRole('region', { name: 'Update available' })
      await expect(banner.getByText('WingLog 99.0.0 is available.')).toBeVisible()
      await banner.getByRole('button', { name: "What's new" }).click()
      await expect(banner.getByText('- Everything')).toBeVisible()
      await banner.getByRole('button', { name: 'Skip this version' }).click()
      await expect(banner).toBeHidden()
    } finally {
      await first.cleanup()
    }

    const second = await launchApp({ userDataDir, env: { WINGLOG_UPDATE_URL: url } })
    try {
      const page = second.window
      await page.getByRole('tab', { name: 'Settings' }).click()
      await page.getByRole('tab', { name: 'About' }).click()
      await page.getByRole('button', { name: 'Check now' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'WingLog 99.0.0 is available.' })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Update available' })).toBeHidden()
    } finally {
      await second.cleanup()
    }
  } finally {
    server.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
