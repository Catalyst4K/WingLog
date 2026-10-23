/**
 * Pictures of the PC window and a phone side by side through the second-screen faults (winglog-backend
 * docs/plans/taxi-and-second-screen-robustness.md, stage 9's visual report): the recorded ZJSY taxi replayed through the built app, with
 * the taxi chart on, after a phone's reload, with the sim gone, and after the flight is finished. Writes release/sim/robustness-2/shots/
 * (gitignored). Run with `npx playwright test -c playwright.screenshots.config.ts e2e/robustness-screens.shots.ts` after `npm run build`.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, type Page } from '@playwright/test'
import { openPhone } from './lan-device'
import { CHOICE_A, launchTaxiFlight, type TaxiFlight } from './screens-agree'

const OUT = join(process.cwd(), 'release', 'sim', 'robustness-2', 'shots')

/**
 * @param world The app.
 * @returns A phone page paired with it.
 */
async function phoneFor(world: TaxiFlight): Promise<Page> {
  const code = await world.window.evaluate(
    async () => (await (globalThis as unknown as Window).winglog.lanStartPairing()).pairing?.code ?? ''
  )
  const phone = await openPhone(world.app, `http://127.0.0.1:${world.port}/#code=${code}`)
  await phone.getByRole('navigation').waitFor()
  return phone
}

/**
 * @param pc The PC window.
 * @param phone The phone page.
 * @param name The pictures' name.
 */
async function shoot(pc: Page, phone: Page, name: string): Promise<void> {
  // Both pictures at once; taken again if the line changed shape meanwhile (a re-route keeps the end but not the number of points).
  const path = (): Promise<string> =>
    pc.evaluate(async () => {
      const route = await (globalThis as unknown as Window).winglog.getTaxiRoute()
      return JSON.stringify(
        route ? [route.kind, route.clearance, route.line.length, route.line.slice(-3)] : null
      )
    })
  for (let attempt = 0; attempt < 10; attempt++) {
    const before = await path()
    await Promise.all([
      pc.screenshot({ path: join(OUT, `${name}-pc.png`) }),
      phone.screenshot({ path: join(OUT, `${name}-phone.png`) })
    ])
    if ((await path()) === before) return
  }
  throw new Error(`the taxi line kept being re-routed while ${name} was taken`)
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }))

test('the taxi line on both screens, and a phone that reloads', async () => {
  const world = await launchTaxiFlight({ speed: 6 })
  try {
    await world.window.evaluate(
      (choice) => (globalThis as unknown as Window).winglog.trackingSetProcedureSelection(choice),
      CHOICE_A
    )
    const phone = await phoneFor(world)
    await world.window.getByRole('tab', { name: 'Track' }).click()
    await world.start()
    await world.window.getByRole('button', { name: 'Show taxi chart' }).click()
    await phone.getByRole('button', { name: 'Show taxi chart' }).click()
    await phone.waitForTimeout(25_000)
    await shoot(world.window, phone, '1-taxi')
    await phone.reload()
    await phone.getByRole('navigation').waitFor()
    await phone.getByRole('button', { name: 'Show taxi chart' }).click()
    // Well after the re-route the recorded taxi makes about 35 s in (the pushback went the wrong way).
    await phone.waitForTimeout(15_000)
    await shoot(world.window, phone, '2-phone-reloaded')
  } finally {
    await world.cleanup()
  }
})

test('a phone that joins after the sim has gone', async () => {
  const world = await launchTaxiFlight({ speed: 40, env: { WINGLOG_E2E_REPLAY_GAP_S: '5:600' } })
  try {
    await world.window.getByRole('tab', { name: 'Track' }).click()
    await world.start()
    await world.window.waitForTimeout(4_000)
    const phone = await phoneFor(world)
    await phone.waitForTimeout(3_000)
    await shoot(world.window, phone, '3-sim-gone')
  } finally {
    await world.cleanup()
  }
})

test('a phone that joins after the flight is finished', async () => {
  const world = await launchTaxiFlight({ speed: 40 })
  try {
    await world.window.evaluate(
      (choice) => (globalThis as unknown as Window).winglog.trackingSetProcedureSelection(choice),
      CHOICE_A
    )
    await world.start()
    await world.window.waitForTimeout(4_000)
    await world.window.evaluate(() => (globalThis as unknown as Window).winglog.trackingFinish())
    await world.window.getByRole('tab', { name: 'Track' }).click()
    const phone = await phoneFor(world)
    await phone.waitForTimeout(3_000)
    await shoot(world.window, phone, '4-flight-finished')
  } finally {
    await world.cleanup()
  }
})
