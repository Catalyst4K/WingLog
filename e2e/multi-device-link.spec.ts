import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { freePort, switchPhonesOn } from './lan-device'
import { FakeGsxRemoteServer, VHHH_BOOT_SNAPSHOT } from './gsx-remote-server'
import { launchApp } from './launch-app'
import { skipWithoutMultiDevice } from './multi-device-build'

// A client checks the sim PC's certificate (winglog-backend's docs/plans/security-audit-v2.md, step 22, and docs/plans/devices-page.md): a pairing
// by address and code takes the certificate the sim PC shows and pins it, so a different sim PC on the same address later ends in
// "certificate changed" and is never sent the token.
test('a client pins the sim PC’s certificate when it pairs by address and code, and refuses another one afterwards', async () => {
  test.setTimeout(120_000)
  const clientDir = mkdtempSync(join(tmpdir(), 'winglog-e2e-client-'))
  const port = await freePort()
  /** Switches the twins' side on at a host, on the test's port, and opens a pairing code. */
  const openTwinPairing = (page: Awaited<ReturnType<typeof launchApp>>['window']) =>
    page.evaluate(async (lanPort) => {
      const api = window.winglog
      await api.lanSetSettings({ twinEnabled: true, port: lanPort })
      const status = await api.lanStartPairing('twin')
      return { pin: status.twinCertificate ?? '', code: status.twinPairing?.code ?? '' }
    }, port)
  try {
    const setup = await launchApp({ userDataDir: clientDir })
    try {
      const capabilities = await setup.window.evaluate(() => window.winglog.appGetCapabilities())
      skipWithoutMultiDevice(capabilities.multiDevice)
      await setup.window.evaluate(() => window.winglog.settingsSetRunMode('client'))
    } finally {
      await setup.cleanup()
    }

    const address = `127.0.0.1:${port}`
    // The client closes before the sim PC each time: a sim PC closed while a twin is still connected leaves its data folder locked.
    /** The pin of the certificate the client paired with. */
    let pinned = ''
    const host = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      const { pin, code } = await openTwinPairing(host.window)
      pinned = pin
      expect(pin).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(code).toMatch(/^\d{6}$/)
      const client = await launchApp({ userDataDir: clientDir })
      try {
        await expect(client.window.getByText('No sim PC paired')).toBeAttached()
        await client.window.evaluate(([a, c]) => window.winglog.hostLinkPair(a, c), [address, code] as const)
        await expect(client.window.getByText(/^Connected to the sim PC/)).toBeAttached({ timeout: 15_000 })
        const paired = await host.window.evaluate(() => window.winglog.lanGetStatus())
        expect(paired.devices).toHaveLength(1)
        expect(paired.devices[0]).toMatchObject({ kind: 'twin', connected: true })
      } finally {
        await client.cleanup()
      }
    } finally {
      await host.cleanup()
    }

    // Another WingLog (its own data folder, so its own certificate) on the same address: the client, started again with the pin it stored,
    // refuses it before sending its token.
    const impostor = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      // A different certificate: the pin the client keeps does not match it.
      const { pin: impostorPin } = await openTwinPairing(impostor.window)
      expect(impostorPin).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(impostorPin).not.toBe(pinned)
      const client = await launchApp({ userDataDir: clientDir })
      try {
        await expect
          .poll(() => client.window.evaluate(async () => (await window.winglog.hostLinkGetStatus()).state), {
            timeout: 30_000
          })
          .toBe('certificate-changed')
        // The header says it in words too (what a screen reader reads), not a raw key.
        await expect(client.window.getByText('Sim PC: certificate changed')).toBeAttached()
      } finally {
        await client.cleanup()
      }
    } finally {
      await impostor.cleanup()
    }
  } finally {
    rmSync(clientDir, { recursive: true, force: true })
  }
})

// Settings → Devices on both computers (winglog-backend's docs/plans/devices-page.md): a Windows PC that is a sim PC chooses Add a device →
// Use another PC's sim, and its next start opens Connect to a sim PC; it types the address and code the real sim PC's Add a device →
// Another computer with WingLog shows, and both say it paired. Restart now itself is a unit test (it relaunches outside Playwright).
test('a computer pairs with the sim PC through Add a device on both sides, after Use another PC’s sim', async () => {
  test.setTimeout(120_000)
  const clientDir = mkdtempSync(join(tmpdir(), 'winglog-e2e-client-'))
  const port = await freePort()
  try {
    const first = await launchApp({ userDataDir: clientDir })
    try {
      const capabilities = await first.window.evaluate(() => window.winglog.appGetCapabilities())
      skipWithoutMultiDevice(capabilities.multiDevice)
      await first.window.getByRole('tab', { name: 'Settings' }).click()
      await first.window.getByRole('tab', { name: /^Devices/ }).click()
      await first.window.getByRole('button', { name: 'Add a device' }).click()
      const dialog = first.window.getByRole('dialog')
      await dialog.getByRole('button', { name: /Use another PC’s sim/ }).click()
      await expect(dialog.getByRole('button', { name: 'Restart now' })).toBeVisible()
      expect(await first.window.evaluate(() => window.winglog.settingsGetRunMode())).toBe('client')
    } finally {
      await first.cleanup()
    }

    const host = await launchApp({ env: { WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1' } })
    try {
      await switchPhonesOn(host.window, port)
      await host.window.getByRole('button', { name: 'Add a device' }).click()
      const offer = host.window.getByRole('dialog')
      await offer.getByRole('button', { name: /Another computer with WingLog/ }).click()
      await expect(offer.getByText('Computers are now on.')).toBeVisible()
      const address = `127.0.0.1:${port}`
      await expect(offer.getByText(address, { exact: true })).toBeVisible()
      const code =
        (await offer
          .locator('[aria-label]')
          .filter({ hasText: /^\d{6}$/ })
          .textContent()) ?? ''
      expect(code).toMatch(/^\d{6}$/)

      const client = await launchApp({ userDataDir: clientDir })
      try {
        // The start after the switch opens Settings → Devices on Connect to a sim PC by itself.
        const connect = client.window.getByRole('dialog')
        await expect(connect.getByRole('heading', { name: 'Connect to a sim PC' })).toBeVisible({
          timeout: 15_000
        })
        await connect.getByRole('textbox', { name: 'Address' }).fill(address)
        await connect.getByRole('textbox', { name: 'Pairing code' }).fill(code)
        await connect.getByRole('button', { name: 'Connect' }).click()
        await expect(connect.getByText('Connected to the sim PC')).toBeVisible({ timeout: 15_000 })
        await connect.getByRole('button', { name: 'Done' }).click()
        await expect(connect).toHaveCount(0)

        // The sim PC's dialog says which computer paired, and its list shows it connected.
        await expect(offer.getByText(/ is paired$/)).toBeVisible({ timeout: 15_000 })
        await offer.getByRole('button', { name: 'Done' }).click()
        const list = host.window.locator('section', {
          has: host.window.getByRole('heading', { name: 'Paired with this PC' })
        })
        await expect(list.getByText('Computer', { exact: true })).toBeVisible()
        await expect(list.getByText('Connected', { exact: true })).toBeVisible()
        // Started again, the client goes to Fleet as usual: the request was used once.
        expect(await client.window.evaluate(() => window.winglog.appTakeOpenConnectOnStart())).toBe(false)
      } finally {
        await client.cleanup()
      }
    } finally {
      await host.cleanup()
    }
  } finally {
    rmSync(clientDir, { recursive: true, force: true })
  }
})

// Part 2 of winglog-backend's docs/plans/multi-device.md, through two real launched apps on loopback: a host replaying a recorded flight and
// serving its second screen, and a client that pairs with it and follows its live data. Needs a build with the multi-device flag
// (`npm run test:e2e:multi`); in a release-style build the run mode cannot be chosen and the test skips itself.
test('a client pairs with the host by address and code, follows its sim and keeps the link across a restart', async () => {
  const clientDir = mkdtempSync(join(tmpdir(), 'winglog-e2e-client-'))
  const fixture = join(process.cwd(), 'src/main/tracking/__fixtures__/short-hop-egll-egcc.ndjson')
  const port = await freePort()
  const gsx = await FakeGsxRemoteServer.start()
  try {
    // The client's first launch only chooses the client run mode, which applies from the next launch.
    const setup = await launchApp({ userDataDir: clientDir })
    try {
      const capabilities = await setup.window.evaluate(() => window.winglog.appGetCapabilities())
      skipWithoutMultiDevice(capabilities.multiDevice)
      await setup.window.evaluate(() => window.winglog.settingsSetRunMode('client'))
    } finally {
      await setup.cleanup()
    }

    const host = await launchApp({
      env: {
        WINGLOG_E2E_LAN_ADDRESS: '127.0.0.1',
        // BeyondATC is switched on at this host below: aim it at a port nothing listens on, never at a real BeyondATC that may be running.
        WINGLOG_E2E_BEYONDATC_PORT: String(await freePort()),
        WINGLOG_E2E_FIXTURE: fixture,
        WINGLOG_E2E_REPLAY_MODE: 'paced',
        WINGLOG_E2E_REPLAY_SPEED: '200'
      }
    })
    try {
      const code = await host.window.evaluate(async (lanPort) => {
        const api = window.winglog
        // Another WingLog pairs as a twin: its own switch and its own code, with the second screen left off.
        await api.lanSetSettings({ twinEnabled: true, port: lanPort })
        return (await api.lanStartPairing('twin')).twinPairing?.code ?? ''
      }, port)
      expect(code).toMatch(/^\d{6}$/)

      // The host has an aircraft before the client ever connects; the client will make one of its own.
      await host.window.evaluate(() =>
        window.winglog.aircraftCreate({ registration: 'G-HOST', icaoType: 'A320' })
      )

      // BeyondATC and GSX are switched on at the host: their tabs follow on the client once it is connected.
      await host.window.evaluate(() =>
        window.winglog.settingsSetBeyondAtc({ enabled: true, host: '127.0.0.1' })
      )
      await host.window.evaluate(
        (gsxPort) => window.winglog.settingsSetGsxRemote({ enabled: true, host: '127.0.0.1', port: gsxPort }),
        gsx.port
      )
      await gsx.waitForConnection()
      gsx.sendSnapshot(VHHH_BOOT_SNAPSHOT)

      const client = await launchApp({ userDataDir: clientDir })
      try {
        await expect(client.window.getByText('No sim PC paired')).toBeAttached()
        // An address that is not on the home network is refused, and nothing is opened.
        await expect(
          client.window.evaluate(() => window.winglog.hostLinkPair('example.com:5051', '123456'))
        ).rejects.toThrow()

        await client.window.evaluate(([address, pairing]) => window.winglog.hostLinkPair(address, pairing), [
          `127.0.0.1:${port}`,
          code
        ] as const)
        await expect(client.window.getByText(/^Connected to the sim PC/)).toBeAttached({ timeout: 15_000 })
        await expect(client.window.getByRole('tab', { name: 'BeyondATC' })).toBeVisible({ timeout: 15_000 })
        // The add-on pages open on the client (one that gets nothing for a lookup used to fall over), with the routine editor: routines are rows that sync.
        await client.window.getByRole('tab', { name: 'Ground services' }).click()
        await expect(client.window.getByRole('button', { name: 'Departure', exact: true })).toBeVisible({
          timeout: 15_000
        })
        await expect(client.window.getByRole('button', { name: 'New routine' })).toBeVisible()
        await expect(client.window.getByText('Something went wrong')).toHaveCount(0)
        await client.window.getByRole('tab', { name: 'BeyondATC' }).click()
        await expect(client.window.getByRole('textbox', { name: 'COM1 frequency' })).toBeVisible()
        await expect(client.window.getByText('Something went wrong')).toHaveCount(0)
        // The fleets come level: the host's aircraft reaches the client, and the client's reaches the host (LAN sync, both ways).
        await expect
          .poll(
            () =>
              client.window.evaluate(async () =>
                (await window.winglog.aircraftList()).map((a) => a.registration)
              ),
            {
              timeout: 20_000
            }
          )
          .toContain('G-HOST')
        await client.window.evaluate(() =>
          window.winglog.aircraftCreate({ registration: 'G-MACX', icaoType: 'B738' })
        )
        await expect
          .poll(
            () =>
              host.window.evaluate(async () =>
                (await window.winglog.aircraftList()).map((a) => a.registration)
              ),
            {
              timeout: 20_000
            }
          )
          .toContain('G-MACX')
        expect(await client.window.evaluate(() => window.winglog.hostLinkGetStatus())).toMatchObject({
          sync: { state: 'idle' }
        })
        // A GSX routine made on the client reaches the host, and one edited on the host comes back: they are rows that sync like the logbook.
        const cabinTurn = {
          id: 'cabin-turn',
          name: 'Cabin turn',
          stages: [{ services: ['Cleaning', 'Water'], startsWhen: [] }],
          answerGsxChoice: true,
          fuel: 'ask'
        }
        await client.window.evaluate((routine) => window.winglog.gsxRoutinesSave(routine), cabinTurn as never)
        await expect
          .poll(
            () =>
              host.window.evaluate(async () => (await window.winglog.gsxRoutinesList()).map((r) => r.name)),
            { timeout: 20_000 }
          )
          .toContain('Cabin turn')
        await host.window.evaluate((routine) => window.winglog.gsxRoutinesSave(routine), {
          ...cabinTurn,
          name: 'Cabin turn (PC)'
        } as never)
        await expect
          .poll(
            () =>
              client.window.evaluate(async () => (await window.winglog.gsxRoutinesList()).map((r) => r.name)),
            { timeout: 20_000 }
          )
          .toContain('Cabin turn (PC)')
        // The host's own window is told when the client changes something there, since it did not make the change itself.
        await host.window.evaluate(() => {
          const counter = window as unknown as { __dataChanged: number }
          counter.__dataChanged = 0
          window.winglog.onDataChanged(() => (counter.__dataChanged += 1))
        })
        // A flight is planned on the client and flown on the host, where the sim is: Fly sends it across, Start tracks it there, Finish ends it.
        const planned = await client.window.evaluate(async () => {
          const aircraft = (await window.winglog.aircraftList()).find((a) => a.registration === 'G-HOST')
          return window.winglog.flightCreate({
            aircraftId: aircraft?.id ?? 0,
            depIcao: 'EGLL',
            arrIcao: 'EGCC',
            flightNumber: 'MAC1'
          })
        })
        await expect
          .poll(
            () =>
              host.window.evaluate(async () =>
                (await window.winglog.flightList())
                  .filter((f) => f.status === 'planned')
                  .map((f) => f.flightNumber)
              ),
            { timeout: 30_000 }
          )
          .toEqual(['MAC1'])
        await expect
          .poll(
            () => host.window.evaluate(() => (window as unknown as { __dataChanged: number }).__dataChanged),
            {
              timeout: 10_000
            }
          )
          .toBeGreaterThan(0)
        await client.window.evaluate((id) => window.winglog.trackingStart(id), planned.id)
        await expect
          .poll(() => host.window.evaluate(async () => (await window.winglog.trackingGetActive()) !== null), {
            timeout: 30_000
          })
          .toBe(true)
        await client.window.evaluate(() => window.winglog.trackingFinish())
        await expect
          .poll(() => host.window.evaluate(async () => (await window.winglog.trackingGetActive()) === null), {
            timeout: 30_000
          })
          .toBe(true)

        // The host starts tracking a flight; the client's own Track screen reads it as its own flight, found by uuid, with the host's
        // track so far, though the client tracks nothing and its flight ids are not the host's.
        const hostFlight = await host.window.evaluate(async () => {
          const aircraft = (await window.winglog.aircraftList()).find((a) => a.registration === 'G-HOST')
          return window.winglog.trackingStartFree({
            aircraftId: aircraft?.id ?? null,
            simRegistration: null,
            simIcaoType: null,
            depIcao: 'EGLL',
            arrIcao: 'EGCC',
            flightNumber: 'TST1'
          })
        })
        expect(hostFlight).toBeTruthy()
        await expect
          .poll(
            () =>
              client.window.evaluate(async () => {
                const active = await window.winglog.trackingGetActive()
                if (!active) return null
                const flight = (await window.winglog.flightList()).find((f) => f.id === active.flightId)
                return flight ? `${flight.depIcao}-${flight.arrIcao}` : 'unknown flight'
              }),
            { timeout: 30_000 }
          )
          .toBe('EGLL-EGCC')
        await expect
          .poll(
            () =>
              client.window.evaluate(async () => {
                const active = await window.winglog.trackingGetActive()
                return active ? (await window.winglog.trackPointList(active.flightId)).length : 0
              }),
            { timeout: 30_000 }
          )
          .toBeGreaterThan(0)
        expect(await client.window.evaluate(() => window.winglog.hostLinkGetStatus())).toMatchObject({
          state: 'connected',
          address: `127.0.0.1:${port}`
        })
        // The host's replayed sim reaches the client's own hub, and so its screens: the client has no sim of its own.
        await expect
          .poll(
            () =>
              client.window.evaluate(async () => {
                const status = await window.winglog.getSimConnectionStatus()
                return status.state === 'connected' ? status.simConnectVersion : status.state
              }),
            { timeout: 15_000 }
          )
          .toBe('replay')
        // The host lists the client as a paired device.
        const devices = await host.window.evaluate(async () => (await window.winglog.lanGetStatus()).devices)
        expect(devices).toHaveLength(1)
        expect(devices[0]?.name).toContain('WingLog on')
        expect(devices[0]?.kind).toBe('twin')
        // The link is encrypted, and the host shows the pin of its certificate (never anything else of it).
        const lan = await host.window.evaluate(() => window.winglog.lanGetStatus())
        expect(lan.twinCertificate).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(JSON.stringify(lan)).not.toMatch(/PRIVATE KEY/)
        expect((await host.window.evaluate(() => window.winglog.lanGetStatus())).settings.enabled).toBe(false)
      } finally {
        await client.cleanup()
      }

      // A restart: the token and address are remembered, so it reconnects without a code.
      const again = await launchApp({ userDataDir: clientDir })
      try {
        await expect(again.window.getByText(/^Connected to the sim PC/)).toBeAttached({ timeout: 20_000 })
        await again.window.evaluate(() => window.winglog.hostLinkForget())
        await expect(again.window.getByText('No sim PC paired')).toBeAttached()
      } finally {
        await again.cleanup()
      }
    } finally {
      await host.cleanup()
    }
  } finally {
    await gsx.stop()
    rmSync(clientDir, { recursive: true, force: true })
  }
})
