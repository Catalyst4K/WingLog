import type { FakeGsxRemoteServer } from './gsx-remote-server'

/**
 * A GSX that answers the way the real one does to what a routine sends (winglog-backend's docs/gsx-notes.md, "What twelve recorded
 * flights say about routines"): `menu.toggle` opens the main menu, picking a `Request …` entry closes the menu and puts that service
 * to `requested`, and `Additional Services ▶` opens its submenu. The services only move on when a test says so, so a run is
 * deterministic. The menu labels are the recorded ones.
 */

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
  '↑ Back'
]
const SERVICE_FOR_LABEL: Record<string, string> = {
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

/** What the real SimBrief button state looks like once a plan is loaded. */
const SIMBRIEF_LOADED = { status: 'loaded', error: '', gen: 0 }

export class ScriptedGsx {
  /** The labels the app picked, in order. */
  readonly picks: string[] = []
  private states = new Map<string, string>(SERVICE_IDS.map((id) => [id, 'available']))
  private level: 'closed' | 'main' | 'additional' = 'closed'

  constructor(
    private readonly server: FakeGsxRemoteServer,
    private readonly airport = 'VHHH/Hong Kong Intl'
  ) {
    server.onCommand((command) => this.answer(command))
  }

  /** Sends GSX's state as it is right after the app connects: a gate, every service available, the menu closed. */
  sendBootSnapshot(): void {
    this.server.sendSnapshot({
      airport: { icao: 'VHHH', name: 'Hong Kong Intl', country: 'Hong Kong' },
      parking: '(N) T1 North|Gate N6',
      gateProperties: ['jetway'],
      services: this.services(),
      menu: this.menuValue('closed'),
      menuShown: false,
      prompt: null,
      simbrief: SIMBRIEF_LOADED
    })
  }

  /**
   * Moves a service to a state, as GSX would when it works on it.
   *
   * @param id The service.
   * @param state Its new state.
   */
  setState(id: string, state: string): void {
    this.states.set(id, state)
    this.server.sendPatch('/services', this.services())
  }

  private services(): Record<string, unknown>[] {
    return SERVICE_IDS.map((id) => {
      const state = this.states.get(id) ?? 'available'
      return {
        id,
        displayName: id,
        state,
        stateRaw: 1,
        stateText: '',
        icon: id.toLowerCase(),
        canTrigger: state === 'available',
        canBypass: false,
        progressText: ''
      }
    })
  }

  private menuValue(level: 'closed' | 'main' | 'additional'): Record<string, unknown> {
    const entries = level === 'main' ? MAIN_ENTRIES : level === 'additional' ? ADDITIONAL_ENTRIES : []
    const title =
      level === 'main'
        ? `Activate Services at ${this.airport}`
        : level === 'additional'
          ? 'Additional Services'
          : ''
    return { title, header: '', subtitle: '', entries, icons: [], disabled: [], layout: '' }
  }

  private show(level: 'closed' | 'main' | 'additional'): void {
    this.level = level
    if (level !== 'closed') this.server.sendPatch('/menu', this.menuValue(level))
    this.server.sendPatch('/menuShown', level !== 'closed')
  }

  private answer(command: { verb: string; args?: Record<string, unknown> }): void {
    if (command.verb === 'menu.toggle') this.show(this.level === 'closed' ? 'main' : 'closed')
    else if (command.verb === 'menu.close') this.show('closed')
    else if (command.verb === 'menu.pick') this.pick(Number(command.args?.index))
  }

  private pick(index: number): void {
    if (this.level === 'closed') return
    const label = (this.level === 'main' ? MAIN_ENTRIES : ADDITIONAL_ENTRIES)[index]
    if (label === 'Additional Services ▶') {
      this.show('additional')
      return
    }
    this.picks.push(label)
    const id = SERVICE_FOR_LABEL[label]
    // GSX closes the menu after a pick, and the service goes to requested.
    this.show('closed')
    if (id) this.setState(id, 'requested')
  }
}
