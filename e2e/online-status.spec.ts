import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp } from './launch-app'
import { startNetworkFeedServer } from './network-feed-server'

/**
 * Knowing the pilot is online, end to end (winglog-backend's docs/plans/vatsim-build.md, Step 2): a replayed free flight with the
 * pilot's CID set, against a fake VATSIM feed that holds an aircraft with that CID. WingLog finds it, hides BeyondATC with a note on
 * Track, and writes the network and callsign on the finished flight, which the Logbook shows. The real networks are never reached.
 */
const VHHH = { lat: 22.31, lon: 113.92 }
const FIXTURE = join(process.cwd(), 'src/main/tracking/__fixtures__/tier2-vfr-no-ofp-short-hop.ndjson')
const CID = 1234567

type Winglog = Window['winglog']

test('a flight flown while online is recorded with its network and callsign, and BeyondATC is hidden meanwhile', async () => {
  const feed = await startNetworkFeedServer({
    centre: VHHH,
    self: { cid: CID, callsign: 'TSTPIL1' },
    station: 'VHHH'
  })
  const { window, cleanup } = await launchApp({
    env: {
      WINGLOG_E2E_FIXTURE: FIXTURE,
      WINGLOG_E2E_REPLAY_MODE: 'paced',
      WINGLOG_E2E_REPLAY_SPEED: '200',
      WINGLOG_E2E_REPLAY_HOLD: '1',
      WINGLOG_E2E_VATSIM_URL: feed.vatsimUrl,
      WINGLOG_E2E_IVAO_URL: feed.ivaoUrl
    }
  })
  try {
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

    // Found in the feed by CID: the status says so, and BeyondATC is hidden with the reason on Track.
    await expect
      .poll(() =>
        window.evaluate(() => (globalThis as unknown as { winglog: Winglog }).winglog.getOnlineStatus())
      )
      .toMatchObject({ network: 'vatsim', state: 'online', callsign: 'TSTPIL1', hidesBeyondAtc: true })
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
