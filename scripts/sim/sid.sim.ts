/**
 * Accepting a BeyondATC departure clearance that changes the SID, replayed from a recorded flight: the selection SimBrief planned,
 * the clearance BeyondATC gave, and which SID the map would draw afterwards with and without the fix that drops the old
 * transition (winglog-backend docs/plans/robustness/scenario-testing.md Part 6). Set WINGLOG_SIM_CAPTURE to use another capture.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { NavdataLeg, ProcedureSelection } from '../../src/shared/ipc'
import { getFlight } from '../../src/main/db/flight-repo'
import { listCachedProcedureLegs } from '../../src/main/db/navdata-repo'
import { parseFlightFixture } from '../../src/main/sim/flight-fixture'
import { parseAtcBoxClearance } from '../../src/shared/atc-info-boxes'
import { applyClearance } from '../../src/renderer/src/app/atc-clearance'
import { seedProcedureSelectionFromOfp } from '../../src/renderer/src/procedure-selection'
import { findCapture } from './flight'
import { openUserDb, userDataDir } from './local-data'
import { simOutputDir, writeReport } from './report'
import { boundsOf, escapeHtml, makeFrame, polyline, svg, type LonLat } from './svg'

const PLANNED = '#868e96'
const BEFORE = '#e8590c'
const AFTER = '#2f9e44'

const lonLats = (legs: NavdataLeg[]): LonLat[] =>
  legs.flatMap((l) =>
    l.fixLatitude === null || l.fixLongitude === null ? [] : [[l.fixLongitude, l.fixLatitude] as LonLat]
  )

it('simulates accepting a SID change', () => {
  const capture = parseFlightFixture(
    readFileSync(findCapture(userDataDir(), process.env.WINGLOG_SIM_CAPTURE), 'utf8')
  )
  const flightId = (capture.header as { flightId?: number }).flightId
  const { db, close } = openUserDb()
  try {
    const flight = flightId === undefined ? undefined : getFlight(db, flightId)
    if (!flight) throw new Error('The capture has no flight in the database')
    const planned = seedProcedureSelectionFromOfp(flight.ofpJson ?? null)
    let clearance = null
    let at = 0
    for (const e of capture.events) {
      if (e.type !== 'beyondatc' || e.direction !== 'in' || !e.text.startsWith('InfoBoxes: ')) continue
      const parsed = parseAtcBoxClearance(JSON.parse(e.text.slice('InfoBoxes: '.length)))
      if (parsed?.fields.sidIdent) {
        clearance = parsed
        at = e.tOffsetMs
        break
      }
    }
    if (!clearance) throw new Error('No departure clearance in the capture')
    const withoutFix: ProcedureSelection = { ...planned, ...clearance.fields }
    const withFix = applyClearance(planned, clearance.fields)
    const icao = flight.depIcao
    const legsOf = (s: ProcedureSelection): NavdataLeg[] =>
      s.sidIdent
        ? listCachedProcedureLegs(db, icao, 'sid', s.sidIdent, s.departureRunway, s.sidTransition)
        : []
    const plannedLegs = legsOf(planned)
    const beforeLegs = legsOf(withoutFix)
    const afterLegs = legsOf(withFix)
    // The map falls back to SimBrief's own SID when the fetch comes back empty (procedure-selection.ts, matchingLegs).
    const drawnWithout = beforeLegs.length > 0 ? beforeLegs : plannedLegs
    const drawnWith = afterLegs.length > 0 ? afterLegs : plannedLegs
    const name = (s: ProcedureSelection): string =>
      `${s.sidIdent ?? '-'} runway ${s.departureRunway ?? '-'} transition ${s.sidTransition ?? 'none'}`

    const all = [...lonLats(plannedLegs), ...lonLats(drawnWithout), ...lonLats(drawnWith)]
    const frame = makeFrame(boundsOf(all, 0.01), 420, 260, 420)
    const map = (title: string, legs: NavdataLeg[], colour: string, showPlanned: boolean): string =>
      svg(
        frame,
        (showPlanned
          ? polyline(
              frame,
              lonLats(plannedLegs),
              `stroke="${PLANNED}" stroke-width="3" stroke-dasharray="6 4"`
            )
          : '') + polyline(frame, lonLats(legs), `stroke="${colour}" stroke-width="5" stroke-opacity="0.85"`),
        title
      )
    const figure = (title: string, caption: string, legs: NavdataLeg[], colour: string): string =>
      `<figure>${map(title, legs, colour, true)}<figcaption>${escapeHtml(caption)}</figcaption></figure>`
    const sameAsPlanned = (legs: NavdataLeg[]): boolean =>
      JSON.stringify(lonLats(legs)) === JSON.stringify(lonLats(plannedLegs))

    const page = writeReport(
      'sid',
      {
        title: 'Accepting a BeyondATC SID change',
        intro: `Flight ${flightId} from ${icao}: the selection SimBrief planned, the departure clearance BeyondATC gave at ${Math.round(at / 1000)} s into the recording, and the SID the map draws after Accept, with and without the fix.`,
        lookFor: [
          'Left: without the fix the map keeps drawing the SID SimBrief planned (the dashed grey line is that SID).',
          'Right: with the fix the map draws the cleared SID.'
        ],
        key: [
          { colour: PLANNED, label: 'The SID SimBrief planned' },
          { colour: BEFORE, label: 'Drawn after Accept, before the fix' },
          { colour: AFTER, label: 'Drawn after Accept, with the fix' }
        ],
        summary: [
          { label: 'Planned', value: name(planned) },
          { label: 'Cleared', value: `${clearance.summary}` }
        ],
        sections: [
          {
            title: `Flight ${flightId}: ${planned.sidIdent} to ${clearance.fields.sidIdent}`,
            meta: `Selection after Accept, without the fix: ${name(withoutFix)}. With the fix: ${name(withFix)}.`,
            metrics: [
              { label: 'Legs found, without the fix', value: String(beforeLegs.length) },
              { label: 'Legs found, with the fix', value: String(afterLegs.length) },
              {
                label: 'Map without the fix',
                value: sameAsPlanned(drawnWithout) ? 'still the planned SID' : 'the cleared SID'
              },
              {
                label: 'Map with the fix',
                value: sameAsPlanned(drawnWith) ? 'still the planned SID' : 'the cleared SID'
              }
            ],
            figures: `<div class="pair">${figure('before the fix', 'Before the fix', drawnWithout, BEFORE)}${figure('with the fix', 'With the fix', drawnWith, AFTER)}</div>`
          }
        ]
      },
      {
        planned,
        cleared: clearance.fields,
        withoutFix,
        withFix,
        legs: { planned: plannedLegs.length, withoutFix: beforeLegs.length, withFix: afterLegs.length }
      }
    )
    console.log(`SID sim: ${name(planned)} -> ${name(withFix)}; report ${page}`)
    expect(afterLegs.length).toBeGreaterThan(0)
  } finally {
    close()
  }
})
void simOutputDir
