import { expect, test } from '@playwright/test'
import { launchApp } from './launch-app'

/**
 * Settings has one layout (winglog-backend's docs/plans/settings-layout.md): in every category the cards are one column of equal
 * width, with their left edges lined up. Also writes a screenshot of each category, light and dark, for a person to look at.
 */

const CATEGORIES = ['UI', '3rd party', 'Data', 'About'] as const

test('every Settings category is one column of equal-width cards', async () => {
  const { window: page, cleanup } = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
  try {
    await page.getByRole('tab', { name: 'Settings' }).click()
    for (const theme of ['Light', 'Dark'] as const) {
      await page.getByRole('tab', { name: 'UI' }).click()
      await page.getByRole('button', { name: theme, exact: true }).click()
      for (const category of CATEGORIES) {
        await page.getByRole('tab', { name: category }).click()
        const cards = page.locator('[role="tabpanel"]:visible [data-slot="card"]')
        await expect(cards.first()).toBeVisible()
        const boxes = await cards.evaluateAll((nodes) =>
          nodes.map((n) => {
            const r = n.getBoundingClientRect()
            return { left: Math.round(r.left), width: Math.round(r.width) }
          })
        )
        expect(boxes.length).toBeGreaterThan(0)
        for (const box of boxes) expect(box).toEqual(boxes[0])
        await page.screenshot({
          path: `release/sim/settings-layout/${category.replace(' ', '-')}-${theme.toLowerCase()}.png`,
          animations: 'disabled'
        })
      }
    }
  } finally {
    await cleanup()
  }
})
