import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GsxRemoteCommandBar,
  GsxRemoteMenuState,
  GsxRemoteServiceStatus,
  SimTelemetry
} from '@shared/ipc'
import { stageRoutine, type GsxRoutine, type GsxRoutineService } from '@shared/gsx-routines'
import type { GsxRoutineProgress } from '@shared/gsx-routine-progress'
import { EMPTY_COMMAND_BAR, EMPTY_MENU } from './GsxRemoteService'
import { RoutineDriver, type RoutineGsx } from './routine-driver'

const MAIN_MENU: GsxRemoteMenuState = {
  ...EMPTY_MENU,
  menuShown: true,
  title: 'Activate Services at EGLL/London Heathrow',
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

/** A GSX that records what the driver sends and lets a test change what it shows. */
class FakeGsx implements RoutineGsx {
  status: 'connected' | 'disconnected' = 'connected'
  menu: GsxRemoteMenuState = EMPTY_MENU
  states: Record<string, string> = {
    Catering: 'available',
    Refueling: 'available',
    Boarding: 'available',
    Departure: 'available'
  }
  commandBar: GsxRemoteCommandBar = EMPTY_COMMAND_BAR
  sent: string[] = []
  pickAccepted = true
  private listeners = new Set<() => void>()

  getStatus(): { state: 'connected' | 'disconnected'; lastError: null } {
    return { state: this.status, lastError: null }
  }
  getMenu(): GsxRemoteMenuState {
    return this.menu
  }
  getServices(): GsxRemoteServiceStatus[] {
    return Object.entries(this.states).map(([id, state]) => service(id, state))
  }
  getCommandBar(): GsxRemoteCommandBar {
    return this.commandBar
  }
  openMenuIfClosed(): boolean {
    this.sent.push('open')
    return true
  }
  closeMenuIfOpen(): boolean {
    this.sent.push('close')
    return true
  }
  pickMenuChecked(index: number, title: string, label: string): boolean {
    this.sent.push(`pick ${index} ${label} in ${title}`)
    return this.pickAccepted
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /** GSX changed something: the driver hears about it. */
  changed(): void {
    for (const listener of this.listeners) listener()
  }
  get listenerCount(): number {
    return this.listeners.size
  }
}

function telemetry(overrides: Partial<SimTelemetry> = {}): SimTelemetry {
  return { groundSpeedMs: 0, fuelTotalKg: 9_000, totalWeightKg: 200_000, ...overrides } as SimTelemetry
}

const routine = (services: GsxRoutineService[]): GsxRoutine => ({
  id: 'test',
  name: 'Test',
  stages: stageRoutine(services),
  answerGsxChoice: false,
  fuel: 'ask'
})

describe('RoutineDriver', () => {
  let gsx: FakeGsx
  let published: (GsxRoutineProgress | null)[]
  let currentTelemetry: SimTelemetry | undefined
  let plannedZfwKg: number | null
  let logged: string[]
  let driver: RoutineDriver

  beforeEach(() => {
    vi.useFakeTimers()
    gsx = new FakeGsx()
    published = []
    currentTelemetry = telemetry()
    plannedZfwKg = 191_000
    logged = []
    driver = new RoutineDriver({
      gsx,
      telemetry: () => currentTelemetry,
      plannedZfwKg: () => plannedZfwKg,
      publish: (progress) => published.push(progress),
      logger: { info: (m) => logged.push(`info ${m}`), warn: (m) => logged.push(`warn ${m}`) },
      nowMs: () => Date.now()
    })
  })
  afterEach(() => {
    driver.dispose()
    vi.useRealTimers()
  })

  it('opens the menu when a routine starts, and publishes where it is', () => {
    expect(driver.start(routine(['Catering']))).toBe(true)
    expect(gsx.sent).toEqual(['open'])
    expect(driver.isRunning()).toBe(true)
    expect(published.at(-1)).toMatchObject({
      routineName: 'Test',
      state: 'running',
      note: { code: 'opening-menu', service: 'Catering' }
    })
    expect(logged).toContain('info GSX routine "Test" started')
  })

  it('picks the entry when GSX shows the menu, sending the title and label it read', () => {
    driver.start(routine(['Catering']))
    gsx.menu = MAIN_MENU
    gsx.changed()
    expect(gsx.sent).toContain('pick 1 Request Catering service in Activate Services at EGLL/London Heathrow')
    expect(logged).toContain(
      'info GSX routine picked "Request Catering service" in "Activate Services at EGLL/London Heathrow"'
    )
  })

  it('logs when a pick was refused because the menu had changed', () => {
    gsx.pickAccepted = false
    driver.start(routine(['Catering']))
    gsx.menu = MAIN_MENU
    gsx.changed()
    expect(
      logged.some((line) => line.startsWith('warn GSX routine did not pick "Request Catering service"'))
    ).toBe(true)
  })

  it('steps on its own twice a second so a timeout can fire without GSX saying anything', () => {
    driver.start(routine(['Catering']))
    vi.advanceTimersByTime(5_000)
    expect(gsx.sent).toEqual(['open'])
    vi.advanceTimersByTime(500)
    expect(gsx.sent).toEqual(['open', 'open'])
  })

  it('does not publish the same progress twice', () => {
    driver.start(routine(['Catering']))
    const count = published.length
    vi.advanceTimersByTime(2_000)
    expect(published).toHaveLength(count)
  })

  it('runs one routine at a time', () => {
    expect(driver.start(routine(['Catering']))).toBe(true)
    expect(driver.start(routine(['Refueling']))).toBe(false)
    expect(published.at(-1)).toMatchObject({ routineName: 'Test' })
  })

  it('finishes when GSX has the service completed, stops listening, then clears the screens after two minutes', () => {
    gsx.states.Catering = 'completed'
    driver.start(routine(['Catering']))
    expect(published.at(-1)).toMatchObject({ state: 'finished', note: { code: 'finished' } })
    expect(driver.isRunning()).toBe(false)
    expect(gsx.listenerCount).toBe(0)
    expect(logged).toContain('info GSX routine "Test" finished')
    vi.advanceTimersByTime(2 * 60_000 - 1)
    expect(published.at(-1)).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(published.at(-1)).toBeNull()
    expect(driver.getProgress()).toBeNull()
  })

  it('can start another routine once one has ended, and keeps the older one’s clear from wiping it', () => {
    gsx.states.Catering = 'completed'
    driver.start(routine(['Catering']))
    gsx.states.Catering = 'available'
    gsx.states.Refueling = 'performing'
    expect(driver.start(routine(['Refueling']))).toBe(true)
    vi.advanceTimersByTime(2 * 60_000)
    expect(driver.isRunning()).toBe(true)
    expect(published.at(-1)).toMatchObject({ state: 'running' })
  })

  it('stops when the aircraft moves', () => {
    driver.start(routine(['Catering']))
    currentTelemetry = telemetry({ groundSpeedMs: 3 })
    gsx.changed()
    expect(published.at(-1)).toMatchObject({
      state: 'stopped',
      note: { code: 'stopped', reason: 'aircraft-moved' }
    })
    expect(logged).toContain('info GSX routine "Test" stopped: aircraft-moved')
  })

  it('does not call a parked aircraft’s wobble movement', () => {
    driver.start(routine(['Catering']))
    currentTelemetry = telemetry({ groundSpeedMs: 0.4 })
    gsx.changed()
    expect(driver.isRunning()).toBe(true)
  })

  it('stops when GSX disconnects', () => {
    driver.start(routine(['Catering']))
    gsx.status = 'disconnected'
    gsx.changed()
    expect(published.at(-1)).toMatchObject({ note: { code: 'stopped', reason: 'gsx-disconnected' } })
  })

  it('cancel stops it, closes the menu the routine had opened, and clears it from the screens at once', () => {
    driver.start(routine(['Catering']))
    gsx.menu = MAIN_MENU
    driver.cancel()
    expect(gsx.sent).toContain('close')
    expect(published.filter((p) => p?.state === 'stopped')).toEqual([
      expect.objectContaining({ note: { code: 'stopped', reason: 'cancelled' } })
    ])
    expect(published.at(-1)).toBeNull()
    driver.cancel()
    expect(published.filter((p) => p?.state === 'stopped')).toHaveLength(1)
  })

  it('a cancelled routine can be started again straight away', () => {
    driver.start(routine(['Catering']))
    driver.cancel()
    expect(driver.start(routine(['Catering']))).toBe(true)
    expect(published.at(-1)).toMatchObject({ state: 'running' })
  })

  describe('cancel with a choice for the services under way', () => {
    const IN_PROGRESS: GsxRemoteMenuState = {
      ...EMPTY_MENU,
      menuShown: true,
      title: 'Service in progress',
      entries: ['Complete now', 'Abort service', 'Back']
    }
    const relabelled = (): GsxRemoteMenuState => ({
      ...MAIN_MENU,
      entries: MAIN_MENU.entries.map((entry, i) => (i === 1 ? 'Catering truck is loading' : entry))
    })

    /** A routine that has asked for Catering, which GSX is now performing. */
    function cateringUnderWay(): void {
      driver.start(routine(['Catering']))
      gsx.menu = MAIN_MENU
      gsx.changed()
      gsx.menu = EMPTY_MENU
      gsx.states.Catering = 'performing'
      vi.advanceTimersByTime(3_000)
    }

    it('aborts the service in GSX’s menu first, then clears the routine from the screens', () => {
      cateringUnderWay()
      driver.cancel('abort')
      expect(published.at(-1)).toMatchObject({ state: 'running', note: { code: 'ending', choice: 'abort' } })
      expect(driver.isRunning()).toBe(true)
      gsx.menu = relabelled()
      gsx.changed()
      expect(gsx.sent).toContain(
        'pick 1 Catering truck is loading in Activate Services at EGLL/London Heathrow'
      )
      gsx.menu = IN_PROGRESS
      gsx.changed()
      expect(gsx.sent).toContain('pick 1 Abort service in Service in progress')
      gsx.menu = EMPTY_MENU
      gsx.states.Catering = 'available'
      vi.advanceTimersByTime(1_000)
      expect(published.at(-1)).toBeNull()
      expect(driver.isRunning()).toBe(false)
      expect(logged).toContain('info GSX routine "Test" stopped: cancelled')
    })

    it('keeps the routine on the screens for a while when a service had to be left as it is', () => {
      cateringUnderWay()
      driver.cancel('complete')
      vi.advanceTimersByTime(11_000)
      expect(published.at(-1)).toMatchObject({
        state: 'stopped',
        note: { code: 'ending-failed', services: ['Catering'] }
      })
      vi.advanceTimersByTime(2 * 60_000)
      expect(published.at(-1)).toBeNull()
    })

    it.each(['leave', 'bogus', 7, null, undefined])(
      'leaves the services running for %s, and clears at once',
      (choice) => {
        cateringUnderWay()
        driver.cancel(choice)
        expect(published.at(-1)).toBeNull()
        expect(driver.isRunning()).toBe(false)
        expect(gsx.sent.filter((s) => s.startsWith('pick')).length).toBe(1)
      }
    )
  })

  it('cancel with nothing running does nothing', () => {
    driver.cancel()
    expect(published).toEqual([])
  })

  describe('Boarding', () => {
    it('stops when GSX has no SimBrief plan', () => {
      gsx.commandBar = {
        commands: [],
        simbrief: { status: 'error', error: 'No SimBrief plan loaded', gen: 0 },
        simbriefIconUri: null
      }
      driver.start(routine(['Boarding']))
      expect(published.at(-1)).toMatchObject({ note: { code: 'stopped', reason: 'gsx-has-no-plan' } })
    })

    it('stops when WingLog has no planned weight', () => {
      plannedZfwKg = null
      driver.start(routine(['Boarding']))
      expect(published.at(-1)).toMatchObject({ note: { code: 'stopped', reason: 'no-planned-weight' } })
    })

    it('goes ahead when GSX has loaded its plan', () => {
      gsx.commandBar = {
        commands: [],
        simbrief: { status: 'loaded', error: '', gen: 0 },
        simbriefIconUri: null
      }
      driver.start(routine(['Boarding']))
      expect(gsx.sent).toEqual(['open'])
    })

    it('waits for the fuel entry that is under way, from the aircraft’s own fuel', () => {
      gsx.states.Refueling = 'performing'
      gsx.states.Catering = 'completed'
      driver.start(routine(['Catering', 'Boarding']))
      expect(published.at(-1)).toMatchObject({ note: { code: 'waiting-for-fuel-entry' } })
      expect(gsx.sent).toEqual([])
      currentTelemetry = telemetry({ fuelTotalKg: 9_100 })
      vi.advanceTimersByTime(1_000)
      expect(gsx.sent).toEqual(['open'])
    })
  })

  it('judges the guard by nothing when the sim has sent no telemetry yet', () => {
    currentTelemetry = undefined
    gsx.states.Refueling = 'performing'
    gsx.states.Catering = 'completed'
    driver.start(routine(['Catering', 'Boarding']))
    expect(gsx.sent).toEqual(['open'])
  })

  it('dispose stops the timer and the listener, and clears the screens', () => {
    driver.start(routine(['Catering']))
    driver.dispose()
    expect(gsx.listenerCount).toBe(0)
    expect(published.at(-1)).toBeNull()
    gsx.sent = []
    vi.advanceTimersByTime(5_000)
    expect(gsx.sent).toEqual([])
  })
})
