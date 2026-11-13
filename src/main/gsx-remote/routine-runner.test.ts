import { describe, expect, it } from 'vitest'
import type { GsxRemoteMenuState, GsxRemoteServiceStatus } from '@shared/ipc'
import {
  BUILT_IN_ROUTINES,
  stageRoutine,
  type GsxRoutine,
  type GsxRoutineService
} from '@shared/gsx-routines'
import type { GsxRoutineCancelChoice } from '@shared/gsx-routine-progress'
import { EMPTY_MENU } from './GsxRemoteService'
import { cancelRoutine, stepRoutine } from './routine-runner'
import {
  routineProgress,
  startRoutine,
  type RoutineRun,
  type RunnerAction,
  type RunnerInput
} from './routine-run'

/** The main menu as the twelve recordings show it, at every airport: same entries, same order. */
const MAIN_ENTRIES = [
  'Request Deboarding',
  'Request Catering service',
  'Request Refueling',
  'Request Boarding',
  'Prepare for Push-back and Departure',
  'Operate Jetway',
  'Stairs disabled',
  'Additional Services ▶',
  'Customize this Parking position'
]
const ADDITIONAL_ENTRIES = [
  'Request GPU',
  'Request DeIce',
  'Request Lavatory service',
  'Request Water service',
  'Request Cleaning service',
  'Cameras ▶',
  'Show EGLL airport diagram',
  'Next Page ▶',
  '↑ Back'
]
const SERVICE_IDS = [
  'Deboarding',
  'Catering',
  'Refueling',
  'Boarding',
  'Departure',
  'OperateJetways',
  'OperateStairs',
  'GPU',
  'DeIce',
  'Lavatory',
  'Water',
  'Cleaning'
]

function menu(title: string, entries: string[], disabled: boolean[] = []): GsxRemoteMenuState {
  return { ...EMPTY_MENU, menuShown: true, title, entries, disabled }
}
const mainMenu = (): GsxRemoteMenuState => menu('Activate Services at EGLL/London Heathrow', MAIN_ENTRIES)
const additionalMenu = (): GsxRemoteMenuState => menu('Additional Services', ADDITIONAL_ENTRIES)
const operatorMenu = (): GsxRemoteMenuState =>
  menu('Select handling operator', ['Menzies', 'SATS [GSX choice]', 'Swissport'])
const tugMenu = (): GsxRemoteMenuState => menu('Attach Pushback Tug now?', ['Yes', 'No [GSX choice]'])
const refuelLevelMenu = (): GsxRemoteMenuState =>
  menu('Select refueling level', [
    ' 50% - 30870 USGAL / 93815 kg',
    ' 72% - BLOCK FUEL from Simbrief - 61740 USGAL / 187631 kg',
    '100% - 85750 USGAL / 260000 kg'
  ])

function service(id: string, state: string): GsxRemoteServiceStatus {
  return {
    id,
    displayName: id,
    state,
    stateText: '',
    icon: id.toLowerCase(),
    canTrigger: state === 'available',
    canBypass: false,
    statusText: '',
    progressText: ''
  }
}

/** A fake GSX and aircraft: holds the menu and each service's state, and runs the routine one step at a time. */
class Session {
  nowMs = 0
  menu: GsxRemoteMenuState = EMPTY_MENU
  states: Record<string, string> = Object.fromEntries(SERVICE_IDS.map((id) => [id, 'available']))
  absent = new Set<string>()
  gsxConnected = true
  aircraftMoving = false
  guard: RunnerInput['guard'] = {
    fuelEntryOpen: false,
    payloadEntryOpen: false,
    fuelGapKg: null,
    timedOut: false
  }
  plan: RunnerInput['plan'] = 'ready'
  run: RoutineRun

  constructor(routine: GsxRoutine) {
    this.run = startRoutine(routine, 0)
  }

  /** What the runner is given now. */
  input(): RunnerInput {
    return {
      nowMs: this.nowMs,
      gsxConnected: this.gsxConnected,
      aircraftMoving: this.aircraftMoving,
      menu: this.menu,
      services: SERVICE_IDS.filter((id) => !this.absent.has(id)).map((id) => service(id, this.states[id])),
      guard: this.guard,
      plan: this.plan
    }
  }

  /** Advances the clock, runs one step, and returns the actions it asked for. */
  tick(afterMs = 250): RunnerAction[] {
    this.nowMs += afterMs
    const step = stepRoutine(this.run, this.input())
    this.run = step.run
    return step.actions
  }

  /** The pilot presses Cancel, with a choice for the services under way. */
  cancel(choice?: GsxRoutineCancelChoice): RunnerAction[] {
    const step = cancelRoutine(this.run, this.input(), choice)
    this.run = step.run
    return step.actions
  }

  /** Runs steps until nothing more is asked of GSX, applying nothing: for checking what a quiet routine does. */
  quiet(steps: number, afterMs = 250): RunnerAction[] {
    return Array.from({ length: steps }).flatMap(() => this.tick(afterMs))
  }

  get progress(): ReturnType<typeof routineProgress> {
    return routineProgress(this.run)
  }
}

/**
 * The captured start of flights 433 and 434: the routine picks Catering, GSX asks for the handling operator and then, after a pause,
 * the catering operator, and the second menu stays open about eight seconds with nothing answered. Each change of GSX is its own step.
 *
 * @param routine The routine to run.
 * @returns The session, with `Select catering operator` still showing.
 */
function catering777Waiting(routine: GsxRoutine): Session {
  const session = new Session(routine)
  expect(session.tick(250)).toEqual([{ kind: 'openMenu' }])
  session.menu = mainMenu()
  expect(session.tick(250)[0]).toMatchObject({ label: 'Request Catering service', index: 1 })
  session.menu = operatorMenu()
  session.tick(900)
  session.menu = EMPTY_MENU
  session.tick(300)
  session.menu = menu('Select catering operator', ['DNATA Catering', 'SATS [GSX choice]', 'Back'])
  session.tick(350)
  session.quiet(32, 250)
  return session
}

/** Asks for a service as GSX does: the menu opens, the pick lands, GSX takes it and closes the menu. */
function request(session: Session, id: string, menuToShow: GsxRemoteMenuState = mainMenu()): RunnerAction[] {
  const actions = [...session.tick(2_000)]
  expect(actions).toEqual([{ kind: 'openMenu' }])
  session.menu = menuToShow
  const pick = session.tick()
  actions.push(...pick)
  session.menu = EMPTY_MENU
  session.states[id] = 'requested'
  actions.push(...session.tick())
  return actions
}

const custom = (services: GsxRoutineService[], overrides: Partial<GsxRoutine> = {}): GsxRoutine => ({
  id: 'test',
  name: 'Test',
  stages: stageRoutine(services),
  answerGsxChoice: false,
  fuel: 'ask',
  ...overrides
})

describe('requesting a service', () => {
  it('opens the menu, then picks the exact label with the title and label it expects', () => {
    const session = new Session(custom(['Catering']))
    expect(session.tick()).toEqual([{ kind: 'openMenu' }])
    session.menu = mainMenu()
    expect(session.tick()).toEqual([
      {
        kind: 'pick',
        index: 1,
        title: 'Activate Services at EGLL/London Heathrow',
        label: 'Request Catering service'
      }
    ])
  })

  it('does not toggle the menu again while it waits for it to open', () => {
    const session = new Session(custom(['Catering']))
    expect(session.tick()).toEqual([{ kind: 'openMenu' }])
    expect(session.quiet(10)).toEqual([])
  })

  it('goes one level down for a service under Additional Services', () => {
    const session = new Session(custom(['Cleaning']))
    session.tick()
    session.menu = mainMenu()
    expect(session.tick()).toEqual([
      {
        kind: 'pick',
        index: 7,
        title: 'Activate Services at EGLL/London Heathrow',
        label: 'Additional Services ▶'
      }
    ])
    session.menu = additionalMenu()
    expect(session.tick()).toEqual([
      { kind: 'pick', index: 4, title: 'Additional Services', label: 'Request Cleaning service' }
    ])
  })

  it("requests the PMDG 777's ground power by the label its Additional Services menu shows (flight 260)", () => {
    const session = new Session(custom(['GPU']))
    session.tick()
    session.menu = mainMenu()
    session.tick()
    session.menu = menu('Additional Services', [
      'Request PMDG Ground Power Unit',
      ...ADDITIONAL_ENTRIES.slice(1)
    ])
    expect(session.tick()).toEqual([
      { kind: 'pick', index: 0, title: 'Additional Services', label: 'Request PMDG Ground Power Unit' }
    ])
  })

  it('skips the GPU when the menu has neither of its labels', () => {
    const session = new Session(custom(['GPU']))
    session.tick()
    session.menu = mainMenu()
    session.tick()
    session.menu = menu('Additional Services', ADDITIONAL_ENTRIES.slice(1))
    expect(session.tick()).toEqual([{ kind: 'closeMenu' }])
    expect(session.progress.services[0].progress).toBe('skipped')
  })

  it('follows the service once GSX has requested it, and waits two seconds before the next request', () => {
    const session = new Session(custom(['Catering', 'Refueling']))
    request(session, 'Catering')
    expect(session.progress.services).toEqual([
      { service: 'Catering', progress: 'running' },
      { service: 'Refueling', progress: 'waiting' }
    ])
    expect(session.tick(1_000)).toEqual([])
    expect(session.tick(1_000)).toEqual([{ kind: 'openMenu' }])
  })

  it('asks for services in the stage one at a time, never two in the menu together', () => {
    const session = new Session(custom(['Catering', 'Refueling']))
    session.tick()
    session.menu = mainMenu()
    session.tick()
    // Catering is picked but not yet taken: Refueling must not be started.
    session.menu = EMPTY_MENU
    expect(session.quiet(10)).toEqual([])
  })

  it('never picks a slot whose label has changed because its service is running', () => {
    const session = new Session(custom(['Catering']))
    session.tick()
    session.menu = menu('Activate Services at EGLL/London Heathrow', [
      MAIN_ENTRIES[0],
      'Catering vehicles are on their way',
      ...MAIN_ENTRIES.slice(2)
    ])
    expect(session.tick()).toEqual([{ kind: 'closeMenu' }])
    expect(session.progress.services[0].progress).toBe('skipped')
    expect(session.run.outcome).toEqual({ state: 'finished' })
  })

  it('says why a service was left out while the rest of the routine carries on', () => {
    const session = new Session(custom(['Catering', 'Refueling']))
    session.tick()
    session.menu = menu('Activate Services at EGLL/London Heathrow', [
      MAIN_ENTRIES[0],
      'Catering vehicles are on their way',
      ...MAIN_ENTRIES.slice(2)
    ])
    expect(session.tick()).toEqual([{ kind: 'closeMenu' }])
    expect(session.run.note).toEqual({ code: 'skipped', service: 'Catering', reason: 'not-offered' })
    session.menu = EMPTY_MENU
    expect(session.tick()).toEqual([{ kind: 'openMenu' }])
  })

  it('skips a service whose entry is greyed out, closing the menu it opened', () => {
    const session = new Session(custom(['Deboarding']))
    session.tick()
    session.menu = menu('Activate Services at EGLL/London Heathrow', MAIN_ENTRIES, [true])
    expect(session.tick()).toEqual([{ kind: 'closeMenu' }])
    expect(session.progress.services[0].progress).toBe('skipped')
  })

  it('skips a service GSX does not list at all, without opening the menu', () => {
    const session = new Session(custom(['GPU']))
    session.absent.add('GPU')
    expect(session.tick()).toEqual([])
    expect(session.progress.services[0].progress).toBe('skipped')
    expect(session.run.outcome).toEqual({ state: 'finished' })
  })

  it('skips a service when Additional Services is missing from the menu', () => {
    const session = new Session(custom(['Water']))
    session.tick()
    session.menu = menu('Activate Services at EGLL/London Heathrow', MAIN_ENTRIES.slice(0, 7))
    expect(session.tick()).toEqual([{ kind: 'closeMenu' }])
    expect(session.progress.services[0].progress).toBe('skipped')
  })

  it('does not ask again for a service already under way, it follows it', () => {
    const session = new Session(custom(['Catering']))
    session.states.Catering = 'performing'
    expect(session.tick()).toEqual([])
    expect(session.progress.services[0].progress).toBe('running')
    session.states.Catering = 'available'
    session.tick()
    expect(session.progress.services[0].progress).toBe('done')
  })

  it('counts a service GSX already shows completed as done without asking', () => {
    const session = new Session(custom(['Catering']))
    session.states.Catering = 'completed'
    expect(session.tick()).toEqual([])
    expect(session.run.outcome).toEqual({ state: 'finished' })
  })

  it('stops with "menu failed" when GSX will not open its menu, after one more try', () => {
    const session = new Session(custom(['Catering']))
    expect(session.tick()).toEqual([{ kind: 'openMenu' }])
    expect(session.tick(5_000)).toEqual([])
    expect(session.tick()).toEqual([{ kind: 'openMenu' }])
    session.tick(5_000)
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'menu-failed' })
  })

  it('asks once more when GSX does not take a pick, then leaves the service out', () => {
    const session = new Session(custom(['Catering']))
    session.tick()
    session.menu = mainMenu()
    session.tick()
    session.menu = EMPTY_MENU
    session.tick(5_000)
    expect(session.tick()).toEqual([{ kind: 'openMenu' }])
    session.menu = mainMenu()
    expect(session.tick()).toHaveLength(1)
    session.menu = EMPTY_MENU
    session.tick(5_000)
    expect(session.progress.services[0].progress).toBe('skipped')
  })

  // Flights 433 and 434 (PMDG 777, WSSS), from the captures: after the pick GSX shows its own `Select catering operator` menu and
  // leaves it open about eight seconds. It closes the menu first, and reports Catering taken in a later patch (200 ms later in 433,
  // 716 ms in 434). The routine used to toggle GSX's menu open the moment the follow-up menu closed, and then skip a running service.
  describe('a service GSX takes after its own follow-up menu closes (flights 433, 434, 436)', () => {
    it.each([
      ['433', 200],
      ['434', 716]
    ])('follows it and opens no menu over it, in the order of flight %s', (_flight, takenAfterCloseMs) => {
      const session = catering777Waiting(BUILT_IN_ROUTINES[0])
      session.menu = EMPTY_MENU // /menuShown false
      expect(session.tick(10)).toEqual([])
      session.states.Catering = 'requested' // /services, a patch of its own
      expect(session.tick(takenAfterCloseMs)).toEqual([])
      expect(session.progress.services[0]).toEqual({ service: 'Catering', progress: 'running' })
      // The routine goes on to Refueling once the settle window is over, with no stray menu of Catering's left open.
      expect(session.tick(2_000)).toEqual([{ kind: 'openMenu' }])
      session.menu = mainMenu()
      expect(session.tick(250)[0]).toMatchObject({ label: 'Request Refueling', index: 2 })
    })

    it('counts the wait for the pick from the moment the follow-up menu closed, not from the pick', () => {
      const session = catering777Waiting(custom(['Catering']))
      session.menu = EMPTY_MENU
      // GSX's own menu closed 5 s ago: only now does the pick count as not taken, and the routine asks again
      expect(session.quiet(20, 250)).toEqual([])
      expect(session.tick(250)).toEqual([{ kind: 'openMenu' }])
    })

    it('still leaves the service out when GSX never takes it, asking once more first', () => {
      const session = catering777Waiting(custom(['Catering']))
      session.menu = EMPTY_MENU
      session.quiet(20, 250)
      session.menu = mainMenu()
      expect(session.tick(250)[0]).toMatchObject({ label: 'Request Catering service' })
      session.menu = EMPTY_MENU
      expect(session.tick(5_000)).toEqual([])
      expect(session.progress.services[0].progress).toBe('skipped')
    })

    it('closes the main menu its own retry toggle opens when GSX takes the service just before the menu shows', () => {
      const session = catering777Waiting(custom(['Catering']))
      session.menu = EMPTY_MENU
      session.quiet(20, 250)
      expect(session.tick(250)).toEqual([{ kind: 'openMenu' }])
      session.states.Catering = 'requested' // GSX takes it before the toggle's menu is up
      expect(session.tick(100)).toEqual([])
      expect(session.progress.services[0]).toEqual({ service: 'Catering', progress: 'running' })
      session.menu = menu(
        'Activate Services at WSSS/Changi',
        MAIN_ENTRIES.map((e) => (e === 'Request Catering service' ? 'Catering vehicles are on their way' : e))
      )
      expect(session.tick(350)).toEqual([{ kind: 'closeMenu' }])
      expect(session.run.note.code).not.toBe('waiting-for-pilot')
      // A main menu opened by the pilot later is left alone.
      session.menu = EMPTY_MENU
      session.tick(250)
      session.menu = mainMenu()
      expect(session.tick(250)).toEqual([])
    })

    it('counts the window from the toggle, so a menu the pilot opens five seconds after it is left alone', () => {
      const session = catering777Waiting(custom(['Catering']))
      session.menu = EMPTY_MENU
      session.quiet(20, 250)
      expect(session.tick(250)).toEqual([{ kind: 'openMenu' }]) // the retry toggle, which produces no menu
      expect(session.quiet(17, 250)).toEqual([])
      session.states.Catering = 'requested' // adopted 4.5 s after the toggle, with no menu up
      expect(session.tick(100)).toEqual([])
      session.menu = mainMenu() // the pilot's, 5.3 s after the toggle: the window has closed
      expect(session.tick(700)).toEqual([])
    })

    it("closes only the first menu after the toggle: a main menu after the routine's own is the pilot's", () => {
      const session = catering777Waiting(custom(['Catering']))
      session.menu = EMPTY_MENU
      session.quiet(20, 250)
      session.tick(250)
      session.states.Catering = 'requested'
      session.tick(100)
      session.menu = mainMenu()
      expect(session.tick(300)).toEqual([{ kind: 'closeMenu' }])
      session.menu = EMPTY_MENU
      session.tick(200)
      session.menu = mainMenu()
      expect(session.tick(300)).toEqual([])
    })

    it("does not carry the window into the next service's attempt", () => {
      const session = catering777Waiting(BUILT_IN_ROUTINES[0])
      session.menu = EMPTY_MENU
      session.quiet(20, 250)
      session.tick(250) // the retry toggle
      session.states.Catering = 'requested'
      session.tick(100) // adopted, window open
      expect(session.tick(2_000)).toEqual([{ kind: 'openMenu' }]) // Refueling's attempt starts
      session.menu = mainMenu()
      expect(session.tick(250)[0]).toMatchObject({ label: 'Request Refueling' })
      session.menu = EMPTY_MENU
      session.states.Refueling = 'requested'
      session.tick(250)
      session.menu = mainMenu() // the pilot's menu, still inside the first window's five seconds
      expect(session.tick(250)).toEqual([])
    })

    it('does not open the window when the service is adopted while the attempt is on its submenu step', () => {
      const session = new Session(custom(['GPU']))
      expect(session.tick(250)).toEqual([{ kind: 'openMenu' }])
      session.menu = mainMenu()
      expect(session.tick(250)[0]).toMatchObject({ label: 'Additional Services ▶' })
      session.menu = EMPTY_MENU
      session.states.GPU = 'requested'
      expect(session.tick(250)).toEqual([])
      session.menu = mainMenu()
      expect(session.tick(250)).toEqual([])
    })

    it('adopts a service taken after a retry has reopened the menu, closing the menu it opened', () => {
      const session = catering777Waiting(custom(['Catering']))
      session.menu = EMPTY_MENU
      session.quiet(20, 250)
      session.menu = mainMenu()
      session.states.Catering = 'requested'
      expect(session.tick(250)).toEqual([{ kind: 'closeMenu' }])
      expect(session.progress.services[0]).toEqual({ service: 'Catering', progress: 'running' })
    })
  })
})

describe('check before pick', () => {
  it('sends no main-menu pick when the refuelling menu opened between the toggle and the pick', () => {
    const session = new Session(custom(['Catering']))
    session.tick()
    session.menu = refuelLevelMenu()
    expect(session.tick()).toEqual([])
    expect(session.run.note).toEqual({ code: 'waiting-for-pilot', menu: 'Select refueling level' })
    session.menu = EMPTY_MENU
    session.tick(250)
    session.menu = mainMenu()
    expect(session.tick()[0]).toMatchObject({ kind: 'pick', label: 'Request Catering service' })
  })

  it('waits for a menu the pilot opened before starting a request', () => {
    const session = new Session(custom(['Catering']))
    session.menu = mainMenu()
    expect(session.quiet(8)).toEqual([])
    expect(session.run.note).toEqual({
      code: 'waiting-for-pilot',
      menu: 'Activate Services at EGLL/London Heathrow'
    })
    session.menu = EMPTY_MENU
    expect(session.tick()).toEqual([{ kind: 'openMenu' }])
  })
})

describe('follow-up menus', () => {
  function pickedHandling(options: {
    answer: boolean
    afterMs: number
    menu?: GsxRemoteMenuState
  }): RunnerAction[] {
    const session = new Session(custom(['Catering'], { answerGsxChoice: options.answer }))
    session.tick()
    session.menu = mainMenu()
    session.tick()
    session.menu = EMPTY_MENU
    session.states.Catering = 'requested'
    session.tick(options.afterMs - 250)
    session.menu = options.menu ?? operatorMenu()
    return session.tick(250)
  }

  it('answers GSX’s own default when the routine says to and the menu follows its own pick', () => {
    expect(pickedHandling({ answer: true, afterMs: 800 })).toEqual([
      { kind: 'pick', index: 1, title: 'Select handling operator', label: 'SATS [GSX choice]' }
    ])
  })

  it('leaves it to the pilot when the routine does not answer for GSX', () => {
    expect(pickedHandling({ answer: false, afterMs: 800 })).toEqual([])
  })

  it('leaves a menu that did not follow the routine’s own pick to the pilot', () => {
    expect(pickedHandling({ answer: true, afterMs: 9_000 })).toEqual([])
  })

  it('never answers the pushback tug question', () => {
    expect(pickedHandling({ answer: true, afterMs: 800, menu: tugMenu() })).toEqual([])
  })

  it('does not answer the same menu twice while it closes', () => {
    const session = new Session(custom(['Catering'], { answerGsxChoice: true }))
    session.tick()
    session.menu = mainMenu()
    session.tick()
    session.menu = operatorMenu()
    expect(session.tick(250)).toHaveLength(1)
    expect(session.tick(250)).toEqual([])
  })

  it('picks the SimBrief block fuel when the routine stores that, whenever the level menu opens', () => {
    const session = new Session(custom(['Refueling'], { fuel: 'simbrief-block' }))
    request(session, 'Refueling')
    session.tick(90_000)
    session.menu = refuelLevelMenu()
    expect(session.tick(250)).toEqual([
      {
        kind: 'pick',
        index: 1,
        title: 'Select refueling level',
        label: ' 72% - BLOCK FUEL from Simbrief - 61740 USGAL / 187631 kg'
      }
    ])
  })

  it('waits for the pilot at the refuelling level when the routine asks', () => {
    const session = new Session(custom(['Refueling'], { fuel: 'ask' }))
    request(session, 'Refueling')
    session.tick(90_000)
    session.menu = refuelLevelMenu()
    expect(session.tick(250)).toEqual([])
    expect(session.run.note).toEqual({ code: 'waiting-for-pilot', menu: 'Select refueling level' })
  })

  it('does not touch the refuelling level when the routine did not ask for Refueling', () => {
    const session = new Session(custom(['Catering'], { fuel: 'simbrief-block' }))
    request(session, 'Catering')
    session.menu = refuelLevelMenu()
    expect(session.tick(5_000)).toEqual([])
  })

  it('does not pick a block fuel entry marked as a defuel', () => {
    const session = new Session(custom(['Refueling'], { fuel: 'simbrief-block' }))
    request(session, 'Refueling')
    session.menu = menu('Select refueling level', [' 72% - BLOCK FUEL from Simbrief - 187631 kg [DEFUEL]'])
    expect(session.tick(5_000)).toEqual([])
  })
})

describe('when a service counts as completed', () => {
  function followed(): Session {
    const session = new Session(custom(['Catering']))
    request(session, 'Catering')
    return session
  }

  it('on a completed that lasts only six seconds', () => {
    const session = followed()
    session.states.Catering = 'performing'
    session.tick(60_000)
    session.states.Catering = 'completed'
    session.tick()
    expect(session.progress.services[0].progress).toBe('done')
  })

  it('when it goes from performing back to available, a completed that was missed', () => {
    const session = followed()
    session.states.Catering = 'performing'
    session.tick()
    session.states.Catering = 'available'
    session.tick()
    expect(session.progress.services[0].progress).toBe('done')
  })

  it('when it goes from requested straight to completed, with nothing to load', () => {
    const session = followed()
    session.states.Catering = 'completed'
    session.tick()
    expect(session.progress.services[0].progress).toBe('done')
  })

  it('is not completion when a request goes back to available without running: asked again after ten seconds', () => {
    const session = followed()
    session.states.Catering = 'available'
    session.tick()
    expect(session.progress.services[0].progress).toBe('waiting')
    expect(session.tick(5_000)).toEqual([])
    expect(session.tick(5_000)).toEqual([{ kind: 'openMenu' }])
  })

  it('is treated as a service GSX does not offer when it is dropped a second time', () => {
    const session = followed()
    session.states.Catering = 'available'
    session.tick()
    session.tick(10_000)
    session.menu = mainMenu()
    session.tick()
    session.menu = EMPTY_MENU
    session.states.Catering = 'requested'
    session.tick()
    session.states.Catering = 'available'
    session.tick()
    expect(session.progress.services[0].progress).toBe('skipped')
  })

  it('skips a service GSX bypasses', () => {
    const session = followed()
    session.states.Catering = 'bypassed'
    session.tick()
    expect(session.progress.services[0].progress).toBe('skipped')
  })
})

describe('the Departure routine', () => {
  it('asks for Catering and Refueling, then Boarding six seconds after Catering completes', () => {
    const session = new Session(BUILT_IN_ROUTINES[0])
    request(session, 'Catering')
    request(session, 'Refueling')
    expect(session.quiet(8, 1_000)).toEqual([])
    expect(session.run.note).toEqual({ code: 'waiting-for-stage', services: ['Catering'] })
    session.states.Catering = 'performing'
    session.states.Refueling = 'performing'
    session.tick(60_000)
    session.states.Catering = 'completed'
    expect(session.tick(250)).toEqual([{ kind: 'openMenu' }])
    session.menu = mainMenu()
    expect(session.tick(250)[0]).toMatchObject({ label: 'Request Boarding', index: 3 })
  })

  // Flights 433 and 434 asked for Boarding while GSX was still performing Catering, because the skipped Catering counted as settled.
  it('holds Boarding until a late-taken Catering is completed in GSX, not only done with by WingLog (flights 433, 434)', () => {
    const session = catering777Waiting(BUILT_IN_ROUTINES[0])
    session.menu = EMPTY_MENU
    expect(session.tick(10)).toEqual([])
    session.states.Catering = 'requested'
    expect(session.tick(200)).toEqual([])
    expect(session.progress.services[0]).toEqual({ service: 'Catering', progress: 'running' })
    request(session, 'Refueling')
    session.states.Catering = 'performing'
    session.states.Refueling = 'performing'
    expect(session.quiet(60, 1_000)).toEqual([])
    expect(session.progress.services[2]).toEqual({ service: 'Boarding', progress: 'waiting' })
    session.states.Catering = 'completed'
    expect(session.tick(250)).toEqual([{ kind: 'openMenu' }])
    session.menu = mainMenu()
    expect(session.tick(250)[0]).toMatchObject({ label: 'Request Boarding' })
  })

  it('finishes when every service is done', () => {
    const session = new Session(custom(['Catering']))
    request(session, 'Catering')
    session.states.Catering = 'completed'
    session.tick()
    expect(session.run.outcome).toEqual({ state: 'finished' })
    expect(session.run.note).toEqual({ code: 'finished' })
    expect(session.progress.state).toBe('finished')
  })

  it('lets a stage that waits for a skipped service go ahead', () => {
    const session = new Session(BUILT_IN_ROUTINES[0])
    session.absent.add('Catering')
    expect(session.tick()).toEqual([{ kind: 'openMenu' }])
    session.menu = mainMenu()
    expect(session.tick()[0]).toMatchObject({ label: 'Request Refueling' })
    expect(session.progress.services[0].progress).toBe('skipped')
  })
})

describe('the data-entry guard', () => {
  /** A routine of Refueling then Boarding, with Refueling taken and the settle window still open. */
  function atBoarding(guard: Partial<RunnerInput['guard']>): Session {
    const session = new Session(custom(['Refueling', 'Boarding']))
    request(session, 'Refueling')
    session.guard = {
      fuelEntryOpen: false,
      payloadEntryOpen: false,
      fuelGapKg: null,
      timedOut: false,
      ...guard
    }
    return session
  }

  it('holds Boarding while the fuel entry is open, and says by how far a jump missed', () => {
    const session = atBoarding({ fuelEntryOpen: true, fuelGapKg: 8_200 })
    expect(session.quiet(12)).toEqual([])
    expect(session.run.note).toEqual({ code: 'waiting-for-fuel-entry', gapKg: 8_200 })
  })

  it('asks for Boarding once the fuel entry is done', () => {
    const session = atBoarding({ fuelEntryOpen: true })
    expect(session.tick(2_000)).toEqual([])
    session.guard = { fuelEntryOpen: false, payloadEntryOpen: false, fuelGapKg: null, timedOut: false }
    expect(session.tick()).toEqual([{ kind: 'openMenu' }])
  })

  it('holds Refueling while the payload entry is open', () => {
    const session = new Session(custom(['Refueling', 'Boarding']))
    session.states.Boarding = 'performing'
    session.guard = { fuelEntryOpen: false, payloadEntryOpen: true, fuelGapKg: null, timedOut: false }
    expect(session.quiet(8)).toEqual([])
    expect(session.run.note).toEqual({ code: 'waiting-for-payload-entry' })
  })

  it('says so when an entry timed out and the request went ahead', () => {
    const session = atBoarding({ timedOut: true })
    expect(session.tick(2_000)).toEqual([{ kind: 'openMenu' }])
    session.menu = mainMenu()
    session.tick()
    session.menu = EMPTY_MENU
    session.states.Boarding = 'requested'
    session.tick()
    session.states.Boarding = 'performing'
    session.tick()
    expect(session.run.note).toEqual({ code: 'entry-timed-out' })
  })

  it('stops, and says why, when GSX has no SimBrief plan', () => {
    const session = new Session(custom(['Boarding']))
    session.plan = 'gsx-has-no-plan'
    expect(session.tick()).toEqual([])
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'gsx-has-no-plan' })
  })

  it('does not request Boarding without the plan’s weight', () => {
    const session = new Session(custom(['Boarding']))
    session.plan = 'no-planned-weight'
    expect(session.tick()).toEqual([])
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'no-planned-weight' })
  })

  it('does not look at the plan for a routine without Boarding', () => {
    const session = new Session(custom(['Catering']))
    session.plan = 'gsx-has-no-plan'
    expect(session.tick()).toEqual([{ kind: 'openMenu' }])
  })
})

describe('stopping', () => {
  it('stops when the pilot cancels, closing a menu the routine opened', () => {
    const session = new Session(custom(['Catering']))
    session.tick()
    session.menu = mainMenu()
    const actions = session.cancel()
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'cancelled' })
    expect(actions).toEqual([{ kind: 'closeMenu' }])
  })

  it('does not close a menu it did not open when cancelled', () => {
    const session = new Session(custom(['Catering']))
    request(session, 'Catering')
    session.menu = tugMenu()
    expect(session.cancel()).toEqual([])
  })

  it('stops when GSX disconnects', () => {
    const session = new Session(custom(['Catering']))
    session.gsxConnected = false
    session.tick()
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'gsx-disconnected' })
  })

  it('stops when the aircraft moves', () => {
    const session = new Session(custom(['Catering']))
    session.aircraftMoving = true
    session.tick()
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'aircraft-moved' })
  })

  it.each(['requested', 'performing'])('stops when Departure is %s', (state) => {
    const session = new Session(custom(['Catering']))
    session.states.Departure = state
    session.tick()
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'departure' })
  })

  it('does nothing more once stopped, and a later cancel changes nothing', () => {
    const session = new Session(custom(['Catering']))
    session.gsxConnected = false
    session.tick()
    session.gsxConnected = true
    expect(session.tick()).toEqual([])
    const before = session.run
    session.cancel()
    expect(session.run).toBe(before)
  })

  it('does not change the run it was given', () => {
    const before = startRoutine(custom(['Catering']), 0)
    const snapshot = structuredClone(before)
    stepRoutine(before, {
      nowMs: 250,
      gsxConnected: true,
      aircraftMoving: false,
      menu: EMPTY_MENU,
      services: SERVICE_IDS.map((id) => service(id, 'available')),
      guard: { fuelEntryOpen: false, payloadEntryOpen: false, fuelGapKg: null, timedOut: false },
      plan: 'ready'
    })
    expect(before).toEqual(snapshot)
  })
})

describe('the status line', () => {
  it('says a stage is stalled after thirty minutes of waiting', () => {
    const session = new Session(custom(['Catering', 'Boarding']))
    request(session, 'Catering')
    session.states.Catering = 'performing'
    session.tick()
    session.tick(31 * 60_000)
    expect(session.run.note).toEqual({ code: 'stalled', services: ['Catering'] })
    expect(session.run.outcome).toBeNull()
  })

  it('reports the stage the routine is in', () => {
    const session = new Session(custom(['Catering', 'Boarding']))
    expect(session.progress).toMatchObject({ stage: 1, stageCount: 2, state: 'running' })
    request(session, 'Catering')
    session.states.Catering = 'completed'
    session.tick()
    expect(session.progress.stage).toBe(2)
  })
})

/** GSX's menu for a running service's own entry (captures/flight-258, 2026-10-29): it does not say which service it is for. */
const serviceInProgressMenu = (): GsxRemoteMenuState =>
  menu('Service in progress', ['Complete now', 'Abort service', 'Back'])
/** The main menu while Refueling runs: GSX relabels the entry the routine picked (index 2). */
const mainMenuRefuelling = (): GsxRemoteMenuState =>
  menu(
    'Activate Services at EGLL/London Heathrow',
    MAIN_ENTRIES.map((entry, i) => (i === 2 ? 'Fuel Truck is in position' : entry))
  )
/** The Additional Services submenu while GPU runs: the entry the routine picked (index 0) is relabelled. */
const additionalMenuGpu = (): GsxRemoteMenuState =>
  menu(
    'Additional Services',
    ADDITIONAL_ENTRIES.map((entry, i) => (i === 0 ? 'GPU connected' : entry))
  )

/** A routine that has asked for Refueling, which GSX is now performing. */
function refuelling(extra: GsxRoutineService[] = []): Session {
  const session = new Session(custom(['Refueling', ...extra]))
  request(session, 'Refueling')
  session.states.Refueling = 'performing'
  session.tick()
  return session
}

describe('cancelling with a choice for the services under way (docs/plans/gsx-routine-cancel.md)', () => {
  it('aborts a running service through its own entry and the Service in progress menu, then ends cancelled', () => {
    const session = refuelling()
    expect(session.cancel('abort')).toEqual([{ kind: 'openMenu' }])
    expect(session.run.outcome).toBeNull()
    expect(session.progress.note).toEqual({ code: 'ending', choice: 'abort', services: ['Refueling'] })
    session.menu = mainMenuRefuelling()
    expect(session.tick()).toEqual([
      {
        kind: 'pick',
        index: 2,
        title: 'Activate Services at EGLL/London Heathrow',
        label: 'Fuel Truck is in position'
      }
    ])
    session.menu = serviceInProgressMenu()
    expect(session.tick()).toEqual([
      { kind: 'pick', index: 1, title: 'Service in progress', label: 'Abort service' }
    ])
    session.menu = EMPTY_MENU
    session.states.Refueling = 'available'
    session.tick()
    expect(session.tick()).toEqual([])
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'cancelled' })
    expect(session.progress.note).toEqual({ code: 'stopped', reason: 'cancelled' })
  })

  it('completes a running service with Complete now, done once GSX shows it completing', () => {
    const session = refuelling()
    session.cancel('complete')
    session.menu = mainMenuRefuelling()
    session.tick()
    session.menu = serviceInProgressMenu()
    expect(session.tick()).toEqual([
      { kind: 'pick', index: 0, title: 'Service in progress', label: 'Complete now' }
    ])
    session.menu = EMPTY_MENU
    session.states.Refueling = 'completing'
    session.tick()
    session.tick()
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'cancelled' })
  })

  it('goes one level down for a service under Additional Services', () => {
    const session = new Session(custom(['GPU']))
    session.tick()
    session.menu = mainMenu()
    session.tick()
    session.menu = additionalMenu()
    session.tick()
    session.menu = EMPTY_MENU
    session.states.GPU = 'performing'
    session.tick()
    session.cancel('abort')
    session.menu = mainMenu()
    expect(session.tick()).toEqual([
      {
        kind: 'pick',
        index: 7,
        title: 'Activate Services at EGLL/London Heathrow',
        label: 'Additional Services ▶'
      }
    ])
    session.menu = additionalMenuGpu()
    expect(session.tick()).toEqual([
      { kind: 'pick', index: 0, title: 'Additional Services', label: 'GPU connected' }
    ])
    session.menu = serviceInProgressMenu()
    expect(session.tick()).toEqual([
      { kind: 'pick', index: 1, title: 'Service in progress', label: 'Abort service' }
    ])
  })

  it("does the services one at a time, in the routine's order", () => {
    const session = new Session(custom(['Catering', 'Refueling']))
    request(session, 'Catering')
    session.states.Catering = 'performing'
    request(session, 'Refueling')
    session.states.Refueling = 'performing'
    session.tick()
    session.cancel('complete')
    expect(session.progress.note).toEqual({
      code: 'ending',
      choice: 'complete',
      services: ['Catering', 'Refueling']
    })
    session.menu = menu(
      'Activate Services at EGLL/London Heathrow',
      MAIN_ENTRIES.map((entry, i) => (i === 1 ? 'Catering truck is loading' : entry))
    )
    expect(session.tick()).toEqual([expect.objectContaining({ kind: 'pick', index: 1 })])
    session.menu = serviceInProgressMenu()
    session.tick()
    session.menu = EMPTY_MENU
    session.states.Catering = 'completing'
    session.tick()
    expect(session.progress.note).toEqual({ code: 'ending', choice: 'complete', services: ['Refueling'] })
  })

  it('leaves them running, and stops at once, when asked to (or when the choice is missing)', () => {
    for (const choice of ['leave', undefined] as const) {
      const session = refuelling()
      session.cancel(choice)
      expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'cancelled' })
    }
  })

  it('stops at once when no service of the routine is under way', () => {
    const session = new Session(custom(['Catering']))
    session.cancel('abort')
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'cancelled' })
  })

  it('leaves alone a service GSX was already running that the routine did not ask for', () => {
    const session = new Session(custom(['Refueling']))
    session.states.Refueling = 'performing'
    session.tick()
    session.cancel('abort')
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'cancelled' })
  })

  it('never picks an entry that is still a Request entry, and says the service was left as it is', () => {
    const session = refuelling()
    session.cancel('abort')
    session.menu = mainMenu()
    expect(session.tick()).toEqual([{ kind: 'closeMenu' }])
    session.menu = EMPTY_MENU
    session.tick()
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'cancelled' })
    expect(session.progress.note).toEqual({ code: 'ending-failed', services: ['Refueling'] })
  })

  it('picks Abort service or Complete now only on a menu titled Service in progress', () => {
    const session = refuelling()
    session.cancel('abort')
    session.menu = mainMenuRefuelling()
    session.tick()
    session.menu = menu('Select refueling level', ['Abort service', 'Complete now'])
    expect(session.tick()).toEqual([])
  })

  it('gives a service up after ten seconds without its menu, closes what it opened, and ends cancelled', () => {
    const session = refuelling()
    session.cancel('abort')
    session.menu = mainMenuRefuelling()
    session.tick()
    session.menu = mainMenuRefuelling()
    expect(session.tick(10_000)).toEqual([{ kind: 'closeMenu' }])
    session.menu = EMPTY_MENU
    session.tick()
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'cancelled' })
    expect(session.progress.note).toEqual({ code: 'ending-failed', services: ['Refueling'] })
  })

  it('does not ask twice while it waits for the menu to open', () => {
    const session = refuelling()
    session.cancel('abort')
    expect(session.quiet(10)).toEqual([])
  })

  it('stops for the usual reasons even while winding down', () => {
    const session = refuelling()
    session.cancel('abort')
    session.gsxConnected = false
    session.tick()
    expect(session.run.outcome).toEqual({ state: 'stopped', reason: 'gsx-disconnected' })
  })
})
