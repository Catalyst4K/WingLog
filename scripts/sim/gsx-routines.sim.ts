/**
 * GSX routines, replayed over two recorded turnarounds (winglog-backend docs/plans/gsx-service-presets.md): the production runner and
 * data-entry guard run over flight 256's PMDG 777 (fuel in one step) and flight 242's Fenix A320 (progressive fuel, the EFB's own
 * routine), and the page shows when the routine asked GSX for each service against when the pilot did by hand. Run with
 * `npm run sim -- gsx-routines`; the page is release/sim/gsx-routines/index.html, beside the real-app screenshots the e2e run writes.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import {
  BUILT_IN_ROUTINES,
  stageRoutine,
  type GsxRoutine,
  type GsxRoutineService
} from '../../src/shared/gsx-routines'
import { gsxRoutineFixture } from '../scenarios/bases'
import {
  guardClosedAt,
  replayRoutine,
  type ReplayResult,
  type RoutineFixture
} from '../scenarios/gsx-routine-replay'
import {
  GUARD_COLOUR,
  RECORDED_COLOUR,
  ROUTINE_COLOUR,
  timelineFigure,
  type Bar,
  type Lane,
  type Marker
} from './gsx-routines-report'
import { simOutputDir, writeReport, type Report, type ReportSection } from './report'
import { escapeHtml } from './svg'

const PLANNED_ZFW_777_KG = 202_857
const PLANNED_ZFW_A320_KG = 58_000
const SHOWN: GsxRoutineService[] = ['Catering', 'Refueling', 'Boarding']

const own = (services: GsxRoutineService[]): GsxRoutine => ({
  id: 'sim',
  name: 'Refueling, then Boarding',
  stages: stageRoutine(services),
  answerGsxChoice: false,
  fuel: 'ask'
})

/**
 * @param fixture The recording.
 * @param id A service.
 * @returns When the recording shows the service under way: from asked for to completed, or back to available.
 */
function recordedBars(fixture: RoutineFixture, id: string): Bar[] {
  const bars: Bar[] = []
  let from: number | null = null
  for (const change of fixture.services) {
    const state = change.services.find((s) => s.id === id)?.state
    if (!state) continue
    const underWay = state === 'requested' || state === 'performing' || state === 'completing'
    if (underWay && from === null) from = change.t
    else if (!underWay && from !== null) {
      bars.push({ fromS: from, toS: change.t })
      from = null
    }
  }
  if (from !== null) bars.push({ fromS: from, toS: fixture.telemetry.at(-1)?.[0] ?? from })
  return bars
}

/**
 * @param fixture The recording.
 * @param result The replay.
 * @param id A service the routine asked for.
 * @returns The same bars, moved to where the routine asked for the service.
 */
function routineBars(fixture: RoutineFixture, result: ReplayResult, id: GsxRoutineService): Bar[] {
  const pickedAt = result.pickedAtS[id]
  const recorded = recordedBars(fixture, id)
  if (pickedAt === undefined || recorded.length === 0) return []
  const shift = pickedAt - recorded[0].fromS
  return recorded.slice(0, 1).map((b) => ({ fromS: b.fromS + shift, toS: b.toS + shift }))
}

/**
 * @param result The replay.
 * @param open Which entry.
 * @returns The intervals the guard held that entry open.
 */
function guardBars(result: ReplayResult, open: 'fuelEntryOpen' | 'payloadEntryOpen'): Bar[] {
  const bars: Bar[] = []
  let from: number | null = null
  for (const sample of result.guard) {
    if (sample[open] && from === null) from = sample.t
    else if (!sample[open] && from !== null) {
      bars.push({ fromS: from, toS: sample.t })
      from = null
    }
  }
  if (from !== null) bars.push({ fromS: from, toS: result.guard.at(-1)?.t ?? from })
  return bars
}

const minutes = (s: number): string => `${(s / 60).toFixed(1)} min`

interface Scenario {
  title: string
  meta: string
  routine: GsxRoutine
  fixture: RoutineFixture
  plannedZfwKg: number
  askedByRoutine: GsxRoutineService[]
  startAtS: number
  endAtS: number
  caption: string
  metrics: (result: ReplayResult) => ReportSection['metrics']
}

/**
 * @param scenario What to replay.
 * @returns The report section: the numbers and the picture.
 */
function sectionFor(scenario: Scenario): { section: ReportSection; result: ReplayResult } {
  const { fixture } = scenario
  const result = replayRoutine(fixture, {
    routine: scenario.routine,
    startAtS: scenario.startAtS,
    plannedZfwKg: scenario.plannedZfwKg,
    askedByRoutine: scenario.askedByRoutine,
    endAtS: scenario.endAtS
  })
  const lanes: Lane[] = SHOWN.flatMap((id): Lane[] => [
    { label: `${id}: by hand`, colour: RECORDED_COLOUR, bars: recordedBars(fixture, id) },
    { label: `${id}: routine`, colour: ROUTINE_COLOUR, bars: routineBars(fixture, result, id) }
  ])
  const picks: Marker[] = result.events
    .filter((e) => e.kind === 'pick')
    .map((e) => ({ atS: e.t, label: e.text.replace('asked GSX for ', '') }))
  const figure = timelineFigure(
    {
      fromS: Math.max(0, scenario.startAtS - 20),
      toS: scenario.endAtS,
      lanes,
      guardLanes: [
        { label: 'fuel entry open', colour: GUARD_COLOUR, bars: guardBars(result, 'fuelEntryOpen') },
        { label: 'payload entry open', colour: GUARD_COLOUR, bars: guardBars(result, 'payloadEntryOpen') }
      ],
      picks,
      fuel: { label: 'Fuel on board', colour: '#c2255c', points: fixture.telemetry.map((r) => [r[0], r[1]]) },
      zfw: {
        label: 'Zero fuel weight',
        colour: '#5f3dc4',
        labelAt: 'right',
        points: fixture.telemetry.map((r) => [r[0], r[2] - r[1]])
      }
    },
    scenario.caption
  )
  return {
    section: {
      title: scenario.title,
      meta: scenario.meta,
      metrics: scenario.metrics(result),
      figures: figure
    },
    result
  }
}

/**
 * @param fixture The recording.
 * @param id A service.
 * @param state A state.
 * @returns When the recording first shows the service in that state.
 */
function firstSeen(fixture: RoutineFixture, id: string, state: string): number {
  return fixture.services.find((c) => c.services.some((s) => s.id === id && s.state === state))?.t ?? NaN
}

/**
 * @returns The screenshots the e2e run wrote, as a section of images, or null when it has not run.
 */
function screenshotsSection(): ReportSection | null {
  const shots = [
    [
      'pc-waiting-for-catering.png',
      'The PC window while the Departure routine waits for Catering to complete'
    ],
    ['pc-editor.png', 'The editor, with a routine of your own: Cleaning and Water, then Catering'],
    ['phone-running.png', 'A phone: the same routine row, with Cancel and no editor']
  ].filter(([file]) => existsSync(join(simOutputDir('gsx-routines'), file)))
  if (shots.length === 0) return null
  const figures = shots
    .map(
      ([file, caption]) =>
        `<figure><img src="${escapeHtml(file)}" alt="${escapeHtml(caption)}" style="max-width:100%;border-radius:8px"><figcaption>${escapeHtml(caption)}</figcaption></figure>`
    )
    .join('')
  return {
    title: 'In the app',
    meta: 'Screenshots from the Playwright run (npm run test:e2e -- gsx-routines), against a scripted GSX.',
    metrics: [],
    figures
  }
}

it('replays GSX routines over recorded turnarounds and writes the report', () => {
  const f256 = gsxRoutineFixture(256)
  const f242 = gsxRoutineFixture(242)
  const scenarios: Scenario[] = [
    {
      title: 'Flight 256, PMDG 777-300ER: Departure routine',
      meta: 'Catering and Refueling, then Boarding once Catering has completed. The pilot asked for all three within a minute; here the routine does. The weights are the recording’s and are not moved with the services, so the payload bar stays open to the end: that is the replay, not the guard.',
      routine: BUILT_IN_ROUTINES[0],
      fixture: f256,
      plannedZfwKg: PLANNED_ZFW_777_KG,
      askedByRoutine: ['Catering', 'Refueling', 'Boarding'],
      startAtS: 24,
      endAtS: 700,
      caption:
        'Boarding waits for Catering (32.0 min), by which time the fuel step (30.2 min) is long done: the guard never has to hold it.',
      metrics: (r) => [
        { label: 'Catering asked', value: minutes(r.pickedAtS.Catering ?? NaN) },
        { label: 'Refueling asked', value: minutes(r.pickedAtS.Refueling ?? NaN) },
        {
          label: 'Boarding asked',
          value: minutes(r.pickedAtS.Boarding ?? NaN),
          was: `${minutes(firstSeen(f256, 'Boarding', 'requested'))} by hand`
        },
        {
          label: 'After Catering completed',
          value: `${((r.pickedAtS.Boarding ?? NaN) - (r.completedAtS.Catering ?? NaN)).toFixed(1)} s`
        },
        { label: 'Fuel entry closed', value: minutes(guardClosedAt(r, 'fuelEntryOpen') ?? NaN) }
      ]
    },
    {
      title: 'Flight 256, PMDG 777-300ER: Refueling, then Boarding (the overlap)',
      meta: 'A routine with Refueling and Boarding and nothing in between. By hand, Boarding was asked for 67 s after Refueling: the payload was typed in while the fuel was still to come, the overlap that has mixed up the 777’s MCDU.',
      routine: own(['Refueling', 'Boarding']),
      fixture: f256,
      plannedZfwKg: PLANNED_ZFW_777_KG,
      askedByRoutine: ['Refueling', 'Boarding'],
      startAtS: 24,
      endAtS: 700,
      caption:
        'The orange bars are the guard holding Boarding back: the routine asks for it only after the 777 has taken its fuel.',
      metrics: (r) => [
        { label: 'Refueling asked', value: minutes(r.pickedAtS.Refueling ?? NaN) },
        {
          label: 'Boarding asked',
          value: minutes(r.pickedAtS.Boarding ?? NaN),
          was: `${minutes(firstSeen(f256, 'Boarding', 'requested'))} by hand`
        },
        {
          label: 'Held for',
          value: `${((r.pickedAtS.Boarding ?? NaN) - (r.pickedAtS.Refueling ?? NaN)).toFixed(0)} s after Refueling`
        },
        { label: 'Fuel entry closed', value: minutes(guardClosedAt(r, 'fuelEntryOpen') ?? NaN) }
      ]
    },
    {
      title: 'Flight 242, Fenix A320: Departure routine',
      meta: 'The Fenix’s own EFB asks for Refueling and Catering together and Boarding 6 s after Catering completes. The routine is meant to do the same. The Fenix’s total weight does not move as passengers board, so its payload entry stays open until Boarding finishes; Refueling is asked for first, so nothing waits on it.',
      routine: BUILT_IN_ROUTINES[0],
      fixture: f242,
      plannedZfwKg: PLANNED_ZFW_A320_KG,
      askedByRoutine: ['Catering', 'Refueling', 'Boarding'],
      startAtS: 0,
      endAtS: 440,
      caption:
        'A progressive load: the fuel entry closes at the first 20 kg, so Boarding waits only for Catering.',
      metrics: (r) => [
        { label: 'Catering asked', value: minutes(r.pickedAtS.Catering ?? NaN) },
        { label: 'Refueling asked', value: minutes(r.pickedAtS.Refueling ?? NaN) },
        {
          label: 'Boarding asked',
          value: `${((r.pickedAtS.Boarding ?? NaN) - (r.completedAtS.Catering ?? NaN)).toFixed(1)} s after Catering completed`,
          was: `${(firstSeen(f242, 'Boarding', 'requested') - firstSeen(f242, 'Catering', 'completed')).toFixed(1)} s, the EFB`
        },
        { label: 'Fuel entry closed', value: minutes(guardClosedAt(r, 'fuelEntryOpen') ?? NaN) }
      ]
    }
  ]
  const sections = scenarios.map((scenario) => sectionFor(scenario).section)
  const shots = screenshotsSection()
  const report: Report = {
    title: 'GSX routines',
    intro:
      'The routine runner and the data-entry guard that ship in WingLog, run over two recorded turnarounds. A fake GSX answers the runner’s menu actions and moves each service along its recorded lifecycle from the moment the routine asks for it. Grey is what the pilot did by hand in the recording, blue is when the routine asked.',
    lookFor: [
      'The Departure routine on the 777: Boarding is asked for as soon as Catering completes, and the guard has nothing to hold.',
      'Refueling then Boarding on the 777: the orange bar is the guard holding Boarding until the fuel has arrived, minutes after the pilot overlapped the two by hand.',
      'The Fenix: the routine asks for Boarding within a few seconds of Catering completing, as the EFB does.',
      'The screenshots at the foot: the routine row, its progress and Cancel, the editor, and the same row on a phone.'
    ],
    key: [
      { colour: RECORDED_COLOUR, label: 'asked by the pilot, as recorded' },
      { colour: ROUTINE_COLOUR, label: 'asked by the routine' },
      { colour: GUARD_COLOUR, label: 'data entry open (the guard holds the other service)' },
      { colour: '#2f9e44', label: 'the routine asks GSX' }
    ],
    summary: [
      { label: 'Recorded turnarounds', value: '2' },
      { label: 'Scenarios', value: String(scenarios.length) }
    ],
    sections: shots ? [...sections, shots] : sections
  }
  const page = writeReport(
    'gsx-routines',
    report,
    sections.map((s) => ({ title: s.title, metrics: s.metrics }))
  )
  console.log(`GSX routines report: ${page}`)
})
