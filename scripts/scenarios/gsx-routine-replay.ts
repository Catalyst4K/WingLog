/**
 * Replays a recorded turnaround through the GSX routine runner and the data-entry guard (winglog-backend's
 * docs/plans/gsx-service-presets.md, "Tests"; scenario-testing.md). The recording is GSX's services and the aircraft's weights; a
 * fake GSX answers what the runner sends (the menu opens, a pick lands) and moves a service along its recorded lifecycle from the
 * moment the routine asked for it. The runner and the guard are the production step functions, so what they decide here is what
 * they would decide in the sim.
 */
import type { GsxRemoteMenuState, GsxRemoteServiceStatus } from '../../src/shared/ipc'
import type { GsxRoutine, GsxRoutineService } from '../../src/shared/gsx-routines'
import { EMPTY_MENU } from '../../src/main/gsx-remote/GsxRemoteService'
import { NEW_GUARD, stepGuard, type GuardState } from '../../src/main/gsx-remote/data-entry-guard'
import { stepRoutine } from '../../src/main/gsx-remote/routine-runner'
import {
  startRoutine,
  type RoutineRun,
  type RunnerAction,
  type RunnerInput
} from '../../src/main/gsx-remote/routine-run'
import type { GsxRoutineNote } from '../../src/shared/gsx-routine-progress'

export interface FixtureService {
  id: string
  state: string
  canTrigger: boolean
  fuel?: { target: number; startTotal: number; unit: string }
  pax?: { done: number; total: number }
}

/** A trimmed slice of a recorded flight (scripts/scenarios/__fixtures__/gsx-routine-*.json). */
export interface RoutineFixture {
  about: string
  windowStartsAtS: number
  /** [seconds, fuelTotalKg, totalWeightKg, groundSpeedMs] */
  telemetry: [number, number, number, number][]
  services: { t: number; services: FixtureService[] }[]
}

export interface ReplayOptions {
  routine: GsxRoutine
  /** When the routine is started, in seconds from the start of the fixture. */
  startAtS: number
  plannedZfwKg: number | null
  /**
   * Services the pilot asked for in the recording, which the routine asks for instead: they stay `available` until the routine
   * picks them, then follow their recorded lifecycle from the moment of the pick.
   */
  askedByRoutine: GsxRoutineService[]
  /** The replay stops here, in seconds from the start of the fixture. */
  endAtS: number
}

export interface ReplayEvent {
  t: number
  kind: 'pick' | 'note' | 'outcome'
  text: string
}

export interface GuardSample {
  t: number
  fuelEntryOpen: boolean
  payloadEntryOpen: boolean
}

export interface ReplayResult {
  run: RoutineRun
  events: ReplayEvent[]
  guard: GuardSample[]
  /** When each service was picked by the routine, in seconds. */
  pickedAtS: Partial<Record<GsxRoutineService, number>>
  /** When each service first showed `completed` in the (shifted) lifecycle, in seconds. */
  completedAtS: Partial<Record<string, number>>
}

const STEP_S = 0.5

const MAIN_MENU: GsxRemoteMenuState = {
  ...EMPTY_MENU,
  menuShown: true,
  title: 'Activate Services at VHHH/Hong Kong Intl',
  entries: [
    'Request Deboarding',
    'Request Catering service',
    'Request Refueling',
    'Request Boarding',
    'Prepare for Push-back and Departure',
    'Operate Jetway',
    'Stairs disabled',
    'Additional Services ▶'
  ]
}
const ADDITIONAL_MENU: GsxRemoteMenuState = {
  ...EMPTY_MENU,
  menuShown: true,
  title: 'Additional Services',
  entries: [
    'Request GPU',
    'Request DeIce',
    'Request Lavatory service',
    'Request Water service',
    'Request Cleaning service'
  ]
}

/**
 * @param fixture The recording.
 * @param id A service.
 * @param t Seconds from the start of the fixture.
 * @returns The service as the recording had it at that time.
 */
function recordedAt(fixture: RoutineFixture, id: string, t: number): FixtureService | undefined {
  let found: FixtureService | undefined
  for (const change of fixture.services) {
    if (change.t > t) break
    found = change.services.find((s) => s.id === id) ?? found
  }
  return found
}

/**
 * @param fixture The recording.
 * @param id A service.
 * @returns When the recording first shows the service asked for, in seconds, or undefined if never.
 */
function recordedRequestAt(fixture: RoutineFixture, id: string): number | undefined {
  for (const change of fixture.services) {
    const state = change.services.find((s) => s.id === id)?.state
    if (state && state !== 'available' && state !== 'bypassed') return change.t
  }
  return undefined
}

/**
 * @param service A service as recorded.
 * @returns It as GSX Remote reports it.
 */
function toStatus(service: FixtureService): GsxRemoteServiceStatus {
  return {
    id: service.id,
    displayName: service.id,
    state: service.state,
    stateText: '',
    icon: service.id.toLowerCase(),
    canTrigger: service.canTrigger,
    canBypass: false,
    statusText: '',
    progressText: '',
    detail: {
      ...(service.fuel ? { fuel: { current: 0, aircraftTotal: 0, ...service.fuel } } : {}),
      ...(service.pax ? { pax: service.pax } : {})
    }
  }
}

/**
 * @param fixture The recording.
 * @param t Seconds from the start of the fixture.
 * @returns The latest weights at or before that time.
 */
function telemetryAt(fixture: RoutineFixture, t: number): [number, number, number, number] {
  let found = fixture.telemetry[0]
  for (const row of fixture.telemetry) {
    if (row[0] > t) break
    found = row
  }
  return found
}

/** What the fake GSX holds: the menu on screen, and when the routine picked each service it asked for. */
interface FakeGsx {
  menu: GsxRemoteMenuState
  pickedAtS: Partial<Record<GsxRoutineService, number>>
}

const SERVICE_FOR_LABEL: Record<string, GsxRoutineService> = {
  'Request Deboarding': 'Deboarding',
  'Request Catering service': 'Catering',
  'Request Refueling': 'Refueling',
  'Request Boarding': 'Boarding',
  'Operate Jetway': 'OperateJetways',
  'Request GPU': 'GPU',
  'Request Lavatory service': 'Lavatory',
  'Request Water service': 'Water',
  'Request Cleaning service': 'Cleaning'
}

/**
 * Answers what the runner sent, as GSX does: a toggle opens the main menu, `Additional Services ▶` opens its submenu, and a pick
 * of a request closes the menu.
 *
 * @param gsx The fake GSX.
 * @param actions What the runner asked for.
 * @param t The time, in seconds.
 * @param log Where picks are recorded.
 */
function answer(gsx: FakeGsx, actions: RunnerAction[], t: number, log: (event: ReplayEvent) => void): void {
  for (const action of actions) {
    if (action.kind === 'openMenu') gsx.menu = MAIN_MENU
    else if (action.kind === 'closeMenu') gsx.menu = EMPTY_MENU
    else if (action.label === 'Additional Services ▶') gsx.menu = ADDITIONAL_MENU
    else {
      const service = SERVICE_FOR_LABEL[action.label]
      if (service) {
        gsx.pickedAtS[service] = t
        log({ t, kind: 'pick', text: `asked GSX for ${service}` })
      }
      gsx.menu = EMPTY_MENU
    }
  }
}

/**
 * The services as GSX would show them at this moment: the recording, except that a service the routine asks for follows its
 * recorded lifecycle from the pick, and is `available` before it.
 *
 * @param fixture The recording.
 * @param options What the replay changes.
 * @param gsx The fake GSX.
 * @param t The time, in seconds.
 * @returns The services.
 */
function servicesAt(
  fixture: RoutineFixture,
  options: ReplayOptions,
  gsx: FakeGsx,
  t: number
): GsxRemoteServiceStatus[] {
  const ids = fixture.services[0].services.map((s) => s.id)
  return ids.map((id) => {
    if (!(options.askedByRoutine as string[]).includes(id)) {
      return toStatus(recordedAt(fixture, id, t) ?? { id, state: 'available', canTrigger: true })
    }
    const pickedAt = gsx.pickedAtS[id as GsxRoutineService]
    const requestedAt = recordedRequestAt(fixture, id)
    if (pickedAt === undefined || requestedAt === undefined) {
      return toStatus({ id, state: 'available', canTrigger: true })
    }
    return toStatus(
      recordedAt(fixture, id, t - pickedAt + requestedAt) ?? { id, state: 'requested', canTrigger: false }
    )
  })
}

/**
 * @param note A status.
 * @returns A short text for the timeline.
 */
function noteText(note: GsxRoutineNote): string {
  return 'services' in note ? `${note.code}: ${note.services.join(', ')}` : note.code
}

/**
 * Runs a routine over a recording.
 *
 * @param fixture The recording.
 * @param options What to run, from when, and what the routine asks for instead of the pilot.
 * @returns What the routine did, the guard's open and closed intervals, and when each service was asked for and completed.
 */
export function replayRoutine(fixture: RoutineFixture, options: ReplayOptions): ReplayResult {
  const events: ReplayEvent[] = []
  const guardSamples: GuardSample[] = []
  const gsx: FakeGsx = { menu: EMPTY_MENU, pickedAtS: {} }
  const completedAtS: Partial<Record<string, number>> = {}
  let run = startRoutine(options.routine, options.startAtS * 1000)
  let guardState: GuardState = NEW_GUARD
  let lastNote = ''
  for (let t = options.startAtS; t <= options.endAtS && !run.outcome; t += STEP_S) {
    const services = servicesAt(fixture, options, gsx, t)
    for (const s of services)
      if (s.state === 'completed' && completedAtS[s.id] === undefined) completedAtS[s.id] = t
    const [, fuelTotalKg, totalWeightKg, groundSpeedMs] = telemetryAt(fixture, t)
    const guard = stepGuard(guardState, {
      nowMs: t * 1000,
      fuelTotalKg,
      totalWeightKg,
      refueling: services.find((s) => s.id === 'Refueling'),
      boarding: services.find((s) => s.id === 'Boarding'),
      plannedZfwKg: options.plannedZfwKg
    })
    guardState = guard.state
    guardSamples.push({ t, fuelEntryOpen: guard.fuelEntryOpen, payloadEntryOpen: guard.payloadEntryOpen })
    const input: RunnerInput = {
      nowMs: t * 1000,
      gsxConnected: true,
      aircraftMoving: groundSpeedMs > 2,
      menu: gsx.menu,
      services,
      guard,
      plan: options.plannedZfwKg === null ? 'no-planned-weight' : 'ready'
    }
    const step = stepRoutine(run, input)
    run = step.run
    answer(gsx, step.actions, t, (event) => events.push(event))
    const text = noteText(run.note)
    if (text !== lastNote) {
      lastNote = text
      events.push({ t, kind: 'note', text })
    }
  }
  if (run.outcome) {
    events.push({
      t: options.endAtS,
      kind: 'outcome',
      text: run.outcome.state === 'finished' ? 'finished' : `stopped: ${run.outcome.reason}`
    })
  }
  return { run, events, guard: guardSamples, pickedAtS: gsx.pickedAtS, completedAtS }
}

/**
 * @param result A replay.
 * @param open Which of the guard's entries.
 * @returns The first moment that entry closed after being open, in seconds, or undefined if it never did.
 */
export function guardClosedAt(
  result: ReplayResult,
  open: 'fuelEntryOpen' | 'payloadEntryOpen'
): number | undefined {
  const opened = result.guard.findIndex((sample) => sample[open])
  if (opened < 0) return undefined
  return result.guard.slice(opened).find((sample) => !sample[open])?.t
}
