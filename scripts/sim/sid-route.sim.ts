// @vitest-environment jsdom
/**
 * The route the map is drawn from, through the app's real hook, when a SID clearance is accepted: flight 250's planned selection,
 * then BeyondATC's clearance applied, with the real navdata cache behind `window.winglog`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { getFlight } from '../../src/main/db/flight-repo'
import { listCachedProcedureLegs } from '../../src/main/db/navdata-repo'
import { parseFlightFixture } from '../../src/main/sim/flight-fixture'
import { parseAtcBoxClearance } from '../../src/shared/atc-info-boxes'
import { applyClearance } from '../../src/renderer/src/app/atc-clearance'
import { seedProcedureSelectionFromOfp, useLiveWaypoints } from '../../src/renderer/src/procedure-selection'
import { findCapture } from './flight'
import { openUserDb, userDataDir } from './local-data'

it('the route follows an accepted SID clearance', async () => {
  const capture = parseFlightFixture(
    readFileSync(findCapture(userDataDir(), process.env.WINGLOG_SIM_CAPTURE), 'utf8')
  )
  const flightId = (capture.header as { flightId: number }).flightId
  const { db, close } = openUserDb()
  try {
    const flight = getFlight(db, flightId)
    if (!flight) throw new Error('no flight')
    ;(window as unknown as { winglog: unknown }).winglog = {
      navdataGetProcedureWaypoints: (
        icao: string,
        kind: never,
        id: string,
        rwy?: string | null,
        tr?: string | null
      ) => Promise.resolve(listCachedProcedureLegs(db, icao, kind, id, rwy ?? null, tr ?? null))
    }
    const planned = seedProcedureSelectionFromOfp(flight.ofpJson ?? null)
    const e = capture.events.find(
      (x) =>
        x.type === 'beyondatc' &&
        x.direction === 'in' &&
        x.text.startsWith('InfoBoxes: ') &&
        x.text.includes('"SID"')
    )
    const clearance = parseAtcBoxClearance(
      JSON.parse((e as { text: string }).text.slice('InfoBoxes: '.length))
    )
    if (!clearance) throw new Error('no clearance')
    const airports = {
      depIcao: flight.depIcao,
      arrIcao: flight.arrIcao,
      altnIcao: null,
      ofpJson: flight.ofpJson ?? null
    }
    const { result, rerender } = renderHook(({ s }) => useLiveWaypoints(airports as never, s), {
      initialProps: { s: planned }
    })
    const sidIdents = (): string[] => result.current.filter((w) => w.segment === 'sid').map((w) => w.ident)
    await waitFor(() => expect(sidIdents().length).toBeGreaterThan(0))
    const before = sidIdents()
    act(() => rerender({ s: applyClearance(planned, clearance.fields) }))
    const expected = listCachedProcedureLegs(
      db,
      flight.depIcao,
      'sid',
      clearance.fields.sidIdent as string,
      clearance.fields.departureRunway as string,
      null
    ).map((l) => l.fixIdent)
    await waitFor(() => expect(sidIdents()).toEqual(expected))
    writeFileSync(
      'release/sim/sid/route.txt',
      JSON.stringify({ before, after: sidIdents(), expected }, null, 1)
    )
  } finally {
    close()
  }
})
