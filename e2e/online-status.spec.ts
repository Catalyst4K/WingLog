import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { FakeBeyondAtcServer } from './beyondatc-server'
import { launchApp } from './launch-app'
import { startNetworkFeedServer } from './network-feed-server'

/**
 * Knowing the pilot is online, end to end (winglog-backend's docs/plans/vatsim-build.md, Step 2): a replayed free flight with the
 * pilot's CID set, against a fake VATSIM feed that holds an aircraft with that CID. WingLog finds it, hides BeyondATC with a note on
 * Track, and writes the network and callsign on the finished flight, which the Logbook shows. With a fake BeyondATC connected, it warns
 * while BeyondATC's auto-tune is on and never switches it off itself. The real networks are never reached.
 */
const VHHH = { lat: 22.31, lon: 113.92 }
const FIXTURE = join(process.cwd(), 'src/main/tracking/__fixtures__/tier2-vfr-no-ofp-short-hop.ndjson')
const CID = 1234567

type Winglog = Window['winglog']

/**
 * @returns A fake VATSIM and IVAO feed holding the pilot (by CID) at VHHH, with a controller and ATIS there.
 */
function startFeed(): ReturnType<typeof startNetworkFeedServer> {
  return startNetworkFeedServer({ centre: VHHH, self: { cid: CID, callsign: 'TSTPIL1' }, station: 'VHHH' })
}

/**
 * @param feed The fake feeds.
 * @returns The launch variables: the replayed flight, held until tracking starts, and the fake feeds in place of the real ones.
 */
function replayEnv(feed: { vatsimUrl: string; ivaoUrl: string }): Record<string, string> {
  return {
    WINGLOG_E2E_FIXTURE: FIXTURE,
    WINGLOG_E2E_REPLAY_MODE: 'paced',
    WINGLOG_E2E_REPLAY_SPEED: '200',
    WINGLOG_E2E_REPLAY_HOLD: '1',
    WINGLOG_E2E_VATSIM_URL: feed.vatsimUrl,
    WINGLOG_E2E_IVAO_URL: feed.ivaoUrl
  }
}

/**
 * Chooses VATSIM with the pilot's CID, starts tracking a free flight on Track, and waits until WingLog has found the pilot in the feed.
 *
 * @param window The app's window.
 */
async function startOnlineFlight(window: Page): Promise<void> {
  await window.evaluate(
    (cid) =>
      (globalThis as unknown as { winglog: Winglog }).winglog.settingsSetOnlineNetwork({
        network: 'vatsim',
        vatsimCid: String(cid),
        ivaoVid: null,
        keepBeyondAtcOnline: false
      }),
    CID
  )
  await window.getByRole('tab', { name: 'Track' }).click()
  await window.getByRole('button', { name: 'Free flight' }).click()
  await window.getByRole('button', { name: 'Start tracking' }).click()
  await expect(window.getByText(/Phase:/)).toBeVisible()
  await expect
    .poll(() =>
      window.evaluate(() => (globalThis as unknown as { winglog: Winglog }).winglog.getOnlineStatus())
    )
    .toMatchObject({ network: 'vatsim', state: 'online', callsign: 'TSTPIL1', hidesBeyondAtc: true })
}

test('a flight flown while online is recorded with its network and callsign, and BeyondATC is hidden meanwhile', async () => {
  const feed = await startFeed()
  const { window, cleanup } = await launchApp({ env: replayEnv(feed) })
  try {
    // Found in the feed by CID: BeyondATC is hidden with the reason on Track.
    await startOnlineFlight(window)
    await expect(window.getByText(/BeyondATC is hidden while you are online on VATSIM/)).toBeVisible()
    expect(feed.requests.length).toBeGreaterThan(0)

    // The controllers and ATIS at the flight's airport are listed on Track.
    const atc = window.getByRole('region', { name: 'VHHH' })
    await expect(atc.getByText('VHHH_TWR')).toBeVisible()
    await expect(atc.getByText('118.700')).toBeVisible()
    await expect(atc.getByText('RUNWAY 07R IN USE')).toBeVisible()
    await expect(atc.getByText('Runway in use (from the ATIS): 07R')).toBeVisible()

    // Fly it, finish it, and find it in the Logbook with its network and callsign.
    await window.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const api = (
            globalThis as unknown as {
              winglog: { onSimTelemetry: (l: (t: { onGround: boolean }) => void) => () => void }
            }
          ).winglog
          let airborne = false
          const off = api.onSimTelemetry((t) => {
            if (!t.onGround) airborne = true
            else if (airborne) {
              off()
              resolve()
            }
          })
        })
    )
    await window.getByRole('button', { name: 'Finish & save' }).click()
    const confirmDialog = window.getByRole('alertdialog')
    await confirmDialog.getByRole('button', { name: 'Finish & save' }).click()
    await expect(confirmDialog).toBeHidden()

    await window.getByRole('tab', { name: 'Logbook' }).click()
    const row = window.getByRole('row', { name: /G-TEST/ })
    await expect(row.getByText('VATSIM')).toBeVisible()
    await expect(row.getByText('VATSIM')).toHaveAttribute('title', 'TSTPIL1')
    await row.click()
    await expect(window.getByText('VATSIM · TSTPIL1')).toBeVisible()
  } finally {
    await cleanup()
    await feed.close()
  }
})

test("warns while BeyondATC's auto-tune is on and the pilot is online, and leaves switching it off to the pilot", async () => {
  const feed = await startFeed()
  const beyondAtc = await FakeBeyondAtcServer.start()
  const { window, cleanup } = await launchApp({ env: { ...replayEnv(feed), ...beyondAtc.env } })
  try {
    // Switched on in Settings, so the BeyondATC tab appears. The online network card mentions BeyondATC too, but has no host.
    await window.getByRole('tab', { name: 'Settings' }).click()
    await window.getByRole('tab', { name: '3rd party' }).click()
    const beyondAtcCard = window
      .locator('[data-slot="card"]')
      .filter({ hasText: 'BeyondATC' })
      .filter({ has: window.getByLabel('Host') })
    await beyondAtcCard.getByLabel('Host').fill('127.0.0.1')
    await beyondAtcCard.getByRole('button', { name: 'On', exact: true }).click()
    await beyondAtc.waitForConnection()
    await startOnlineFlight(window)
    const warning = window.getByRole('alert').filter({ hasText: "BeyondATC's auto-tune is on" })

    // Auto-tune on while online: the warning shows on Track, and above the toggle on the BeyondATC page.
    beyondAtc.sendLines('AutoTune: true')
    await expect(warning).toBeVisible()

    // Track at its fullest (the note, the warning, the controllers card), in the window size WingLog first opens at: nothing is
    // squeezed, the page scrolls instead. The flight card shows its airport row in full, the map's Zoom out can be pressed, and the
    // map's speed line sits at its bottom edge. Once, the map's box shrank under the map: its overlays floated mid-map and the
    // attribution covered Zoom out; and a card squeezed instead cut off the airports.
    const clearDeparture = window.getByRole('button', { name: 'Clear departure' })
    const flightCard = await window
      .locator('[data-slot="card"]')
      .filter({ has: clearDeparture })
      .boundingBox()
    const airportRow = await clearDeparture.boundingBox()
    expect(
      flightCard && airportRow && flightCard.y + flightCard.height - (airportRow.y + airportRow.height)
    ).toBeGreaterThan(0)
    await window.getByRole('button', { name: 'Zoom out' }).click({ trial: true, timeout: 5000 })
    const map = await window.locator('[data-framed]').boundingBox()
    const speed = await window.getByText(/^Speed:/).boundingBox()
    expect(map && speed && map.y + map.height - (speed.y + speed.height)).toBeLessThan(20)

    await window.getByRole('tab', { name: 'BeyondATC' }).click()
    await expect(warning).toBeVisible()
    await expect(window.getByRole('button', { name: 'Auto-tune: On' })).toBeVisible()

    // Switched off in BeyondATC, the warning goes.
    beyondAtc.sendLines('AutoTune: false')
    await expect(warning).toBeHidden()

    // On again, then BeyondATC switched off in WingLog's settings while Track stays open (as the phone's Track can): the open screen is
    // told and the warning goes. Saved through the call the Settings card makes, since opening Settings here would close Track.
    beyondAtc.sendLines('AutoTune: true')
    await window.getByRole('tab', { name: 'Track' }).click()
    await expect(warning).toBeVisible()
    await window.evaluate(() =>
      (globalThis as unknown as { winglog: Winglog }).winglog.settingsSetBeyondAtc({
        enabled: false,
        host: '127.0.0.1'
      })
    )
    await expect(warning).toBeHidden()

    // WingLog only warned: it never sent BeyondATC a change to auto-tune.
    expect(beyondAtc.receivedCommands.filter((command) => command.startsWith('set_autotune'))).toEqual([])
  } finally {
    await cleanup()
    await beyondAtc.stop()
    await feed.close()
  }
})
