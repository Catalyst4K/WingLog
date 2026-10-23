import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { latestTopic, openPhone } from './lan-device'
import { CHOICE_A, CHOICE_B, launchTaxiFlight, screensAgree, taxiLineSettled } from './screens-agree'

/**
 * The PC and the phone keep showing the same thing through what goes wrong (winglog-backend's
 * docs/plans/taxi-and-second-screen-robustness.md, stage 7). A recorded taxi at ZJSY is replayed through the real app with the clearance
 * BeyondATC gave; a device speaking the phone's protocol stands in for the phone, and each test does one thing to the PC or the link and
 * then asks `screensAgree`: the same taxi line, the same procedure choice, the same planned route.
 */

/**
 * @param app The app.
 * @param what What to do to the PC window (not a phone's hidden window, which loads a page from the PC).
 */
function onPcWindow(app: ElectronApplication, what: 'minimize' | 'hide'): Promise<void> {
  return app.evaluate(({ BrowserWindow }, action) => {
    const pc = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('http'))
    if (action === 'minimize') pc?.minimize()
    else pc?.hide()
  }, what)
}

/**
 * @param pc The PC window.
 * @returns The revision of the taxi line the PC holds, or -1 with none.
 */
async function pcRevision(pc: Page): Promise<number> {
  const route = (await pc.evaluate(() => (globalThis as unknown as Window).winglog.getTaxiRoute())) as {
    revision: number
  } | null
  return route?.revision ?? -1
}

test.describe('Second screen: faults', () => {
  test.describe.configure({ timeout: 180_000 })

  test('1. a phone gone for 30 s mid-clearance comes back to the same line, choice and route', async () => {
    const world = await launchTaxiFlight({ speed: 8 })
    try {
      const { device, token } = await world.pair()
      await world.start()
      await expect
        .poll(() => latestTopic(device, 'taxiRoute')?.kind ?? null, { timeout: 30_000 })
        .not.toBeNull()
      const before = Number(latestTopic(device, 'taxiRoute')!.revision)
      device.close()
      // The aircraft keeps taxiing while the phone is away: the line moves on without it.
      await world.window.waitForTimeout(30_000)
      expect(await pcRevision(world.window)).toBeGreaterThan(before)
      const back = await world.reconnect(token)
      await screensAgree(world.window, [back])
      await taxiLineSettled(world.window)
      await screensAgree(world.window, [back])
      back.close()
    } finally {
      await world.cleanup()
    }
  })

  test('2a. a minimised PC window changes nothing the phone shows', async () => {
    const world = await launchTaxiFlight({ speed: 12 })
    try {
      const { device } = await world.pair()
      await onPcWindow(world.app, 'minimize')
      await world.start()
      await expect
        .poll(() => latestTopic(device, 'taxiRoute')?.kind ?? null, { timeout: 30_000 })
        .not.toBeNull()
      await taxiLineSettled(world.window)
      expect(Number(latestTopic(device, 'taxiRoute')!.revision)).toBeGreaterThan(3)
      await screensAgree(world.window, [device])
      device.close()
    } finally {
      await world.cleanup()
    }
  })

  test('2b. a PC window hidden as the tray hides it changes nothing the phone shows', async () => {
    const world = await launchTaxiFlight({ speed: 12 })
    try {
      const { device } = await world.pair()
      await onPcWindow(world.app, 'hide')
      await world.start()
      await expect
        .poll(() => latestTopic(device, 'taxiRoute')?.kind ?? null, { timeout: 30_000 })
        .not.toBeNull()
      await taxiLineSettled(world.window)
      expect(Number(latestTopic(device, 'taxiRoute')!.revision)).toBeGreaterThan(3)
      await screensAgree(world.window, [device])
      device.close()
    } finally {
      await world.cleanup()
    }
  })

  test('3. the PC window on the Logbook throughout changes nothing the phone shows', async () => {
    const world = await launchTaxiFlight({ speed: 12 })
    try {
      const { device } = await world.pair()
      await world.window.getByRole('tab', { name: 'Logbook' }).click()
      await world.start()
      await expect
        .poll(() => latestTopic(device, 'taxiRoute')?.kind ?? null, { timeout: 30_000 })
        .not.toBeNull()
      await taxiLineSettled(world.window)
      await screensAgree(world.window, [device])
      await expect(world.window.getByRole('tab', { name: 'Logbook' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      device.close()
    } finally {
      await world.cleanup()
    }
  })

  test('4. an app started again mid-flight on the same data, with the flight resumed, gives a phone the same choice and route as the PC', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'winglog-e2e-faults-'))
    try {
      const first = await launchTaxiFlight({ speed: 12, userDataDir })
      try {
        const { device } = await first.pair()
        device.send({ t: 'cmd', name: 'track.setProcedureSelection', args: [CHOICE_A] })
        await expect.poll(() => latestTopic(device, 'procedureSelection')?.sidIdent).toBe('PORA1N')
        await first.start()
        await expect
          .poll(() => latestTopic(device, 'taxiRoute')?.kind ?? null, { timeout: 30_000 })
          .not.toBeNull()
        device.close()
      } finally {
        await first.cleanup()
      }

      const second = await launchTaxiFlight({ speed: 12, userDataDir, createFlight: false })
      try {
        const orphan = await second.window.evaluate(() =>
          (globalThis as unknown as Window).winglog.trackingGetOrphanedFlight()
        )
        expect(orphan).not.toBeNull()
        await second.window.evaluate(
          (id) => (globalThis as unknown as Window).winglog.trackingResumeOrphaned(id),
          orphan!.id
        )
        const { device } = await second.pair()
        // The choice made before the restart is the one both show.
        await expect.poll(() => latestTopic(device, 'procedureSelection')?.sidIdent).toBe('PORA1N')
        await screensAgree(second.window, [device])
        device.close()
      } finally {
        await second.cleanup()
      }
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  test('5. the sim stream stopping for 20 s and coming back leaves the phone and the PC showing the same, and the phone knows the sim is gone', async () => {
    // The sim goes away 120 s into the capture and comes back 20 s of real time later.
    const world = await launchTaxiFlight({ speed: 40, env: { WINGLOG_E2E_REPLAY_GAP_S: '120:20' } })
    try {
      const { device } = await world.pair()
      await world.start()
      await expect
        .poll(() => latestTopic(device, 'simConnectionStatus')?.state, { timeout: 30_000 })
        .toBe('disconnected')
      // While it is gone the line stands still on both, and the phone has been told.
      const during = Number(latestTopic(device, 'taxiRoute')?.revision ?? -1)
      await screensAgree(world.window, [device])
      await world.window.waitForTimeout(3000)
      expect(Number(latestTopic(device, 'taxiRoute')?.revision ?? -1)).toBe(during)
      await screensAgree(world.window, [device])
      // It comes back: the phone is told, and the line carries on to the same end on both.
      await expect
        .poll(() => latestTopic(device, 'simConnectionStatus')?.state, { timeout: 40_000 })
        .toBe('connected')
      await taxiLineSettled(world.window)
      expect(Number(latestTopic(device, 'taxiRoute')!.revision)).toBeGreaterThan(during)
      await screensAgree(world.window, [device])
      device.close()
    } finally {
      await world.cleanup()
    }
  })

  test('8a. a phone that connects after the sim has gone says so, and shows no frozen readings', async () => {
    // The sim goes away 5 s into the capture and does not come back during the test.
    const world = await launchTaxiFlight({ speed: 40, env: { WINGLOG_E2E_REPLAY_GAP_S: '5:600' } })
    try {
      await world.start()
      await expect
        .poll(
          () =>
            world.window.evaluate(() =>
              (globalThis as unknown as Window).winglog.getSimConnectionStatus().then((s) => s.state)
            ),
          { timeout: 30_000 }
        )
        .toBe('disconnected')
      const code = await world.window.evaluate(
        async () => (await (globalThis as unknown as Window).winglog.lanStartPairing()).pairing?.code ?? ''
      )
      const phone = await openPhone(world.app, `http://127.0.0.1:${world.port}/#code=${code}`)
      await expect(phone.getByRole('navigation')).toBeVisible()
      await expect(phone.getByText("The sim isn't connected to WingLog on the PC.")).toBeVisible()
      // The speed and altitude readout has nothing to show, rather than the last readings of a sim that has gone.
      await expect(phone.getByText(/[0-9]+ kt/)).toHaveCount(0)
    } finally {
      await world.cleanup()
    }
  })

  test('8b. a phone that connects after the flight was finished shows no flight and none of its procedures', async () => {
    const world = await launchTaxiFlight({ speed: 40 })
    try {
      const { device } = await world.pair()
      device.send({ t: 'cmd', name: 'track.setProcedureSelection', args: [CHOICE_A] })
      await expect.poll(() => latestTopic(device, 'procedureSelection')?.sidIdent).toBe('PORA1N')
      await world.start()
      await expect
        .poll(() => latestTopic(device, 'taxiRoute')?.kind ?? null, { timeout: 30_000 })
        .not.toBeNull()
      device.close()
      await world.window.evaluate(() => (globalThis as unknown as Window).winglog.trackingFinish())

      const late = await world.pair('Late phone')
      expect(latestTopic(late.device, 'plannedRoute')).toBeNull()
      expect(latestTopic(late.device, 'procedureSelection') ?? null).toBeNull()
      late.device.close()
      const code = await world.window.evaluate(
        async () => (await (globalThis as unknown as Window).winglog.lanStartPairing()).pairing?.code ?? ''
      )
      const phone = await openPhone(world.app, `http://127.0.0.1:${world.port}/#code=${code}`)
      await expect(phone.getByText('No flight is being tracked on the PC yet.')).toBeVisible()
      await expect(phone.getByRole('button', { name: /Procedures/ })).toHaveCount(0)
    } finally {
      await world.cleanup()
    }
  })

  test('6. two phones paired at once both keep the PC’s line, choice and route', async () => {
    const world = await launchTaxiFlight({ speed: 12 })
    try {
      const first = await world.pair('First phone')
      const second = await world.pair('Second phone')
      await world.start()
      await expect
        .poll(() => latestTopic(second.device, 'taxiRoute')?.kind ?? null, { timeout: 30_000 })
        .not.toBeNull()
      await taxiLineSettled(world.window)
      await screensAgree(world.window, [first.device, second.device])
      first.device.close()
      second.device.close()
    } finally {
      await world.cleanup()
    }
  })

  test('7. a choice made on the PC and on a phone in the same moment ends the same on both', async () => {
    const world = await launchTaxiFlight()
    try {
      const { device } = await world.pair()
      const other = await world.pair('Second phone')
      device.send({ t: 'cmd', name: 'track.setProcedureSelection', args: [CHOICE_A] })
      await world.window.evaluate(
        (choice) => (globalThis as unknown as Window).winglog.trackingSetProcedureSelection(choice),
        CHOICE_B
      )
      await screensAgree(world.window, [device, other.device], 10_000)
      const held = await world.window.evaluate(() =>
        (globalThis as unknown as Window).winglog.trackingGetProcedureSelection()
      )
      // One of the two choices won, whole: never a mixture of them.
      expect([CHOICE_A.sidIdent, CHOICE_B.sidIdent]).toContain((held as { sidIdent: string }).sidIdent)
      expect(held).toEqual((held as { sidIdent: string }).sidIdent === 'PORA1N' ? CHOICE_A : CHOICE_B)
      device.close()
      other.device.close()
    } finally {
      await world.cleanup()
    }
  })
})
