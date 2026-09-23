import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GsxRemoteMenuState, GsxRemotePromptState, GsxRemoteServiceStatus } from '@shared/ipc'
import { GsxRemoteService, type WebSocketCtor } from './GsxRemoteService'

/** A minimal WHATWG-WebSocket-shaped double, driven manually from tests — no real socket,
 *  same reasoning as SimConnectService.test.ts's fake node-simconnect handle. */
class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly OPEN = 1
  readyState = FakeWebSocket.CONNECTING
  sent: unknown[] = []
  closed = false

  constructor(public readonly url: string) {
    super()
  }

  addEventListener(event: string, listener: (...args: unknown[]) => void): void {
    this.on(event, listener)
  }
  removeEventListener(event: string, listener: (...args: unknown[]) => void): void {
    this.off(event, listener)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  // Test helpers, standing in for a real server.
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open', {})
  }
  simulateMessage(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) })
  }
}

function makeCtor(): { ctor: WebSocketCtor; instances: FakeWebSocket[] } {
  const instances: FakeWebSocket[] = []
  // A real class, not a vi.fn — an arrow-wrapped mock implementation can't be invoked
  // with `new`, and GsxRemoteService always constructs its WebSocketImpl with `new`.
  class TrackedFakeWebSocket extends FakeWebSocket {
    constructor(url: string) {
      super(url)
      instances.push(this)
    }
  }
  return { ctor: TrackedFakeWebSocket as unknown as WebSocketCtor, instances }
}

const SERVICES: GsxRemoteServiceStatus[] = [
  {
    id: 'Refueling',
    displayName: 'Refuel',
    state: 'requested',
    stateText: 'Refueling service has been requested',
    icon: 'refueling',
    canTrigger: false,
    canBypass: false,
    operator: 'World Fuel Services',
    statusText: 'on the way, ETA 24 secs',
    progressText: ''
  }
]

// The real wire shape: `menuShown` is GSX's own SEPARATE top-level key, a sibling of
// `menu`, not nested inside it (docs/gsx-notes.md, 2026-09-21) — RAW_MENU is what a real
// `/menu` snapshot/patch value looks like; MENU is the combined shape GsxRemoteService
// exposes to callers via getMenu(), used in assertions below.
const RAW_MENU = {
  title: 'Ground Services',
  header: '',
  subtitle: '',
  entries: ['Request Refueling', 'Request Catering'],
  icons: ['', ''],
  disabled: [false, false],
  layout: 't9'
}
const MENU: GsxRemoteMenuState = { ...RAW_MENU, menuShown: true }

// Real wire shape, confirmed live 2026-09-21 (docs/gsx-notes.md, round 6/7 captures): a
// real VHHH session's `airport`/`parking`/`gateProperties` top-level keys, and a real
// Refueling `detail` (fuel + a live bill) and Boarding `detail` (pax + per-hold cargo).
const AIRPORT = { icao: 'VHHH', name: 'Hong Kong Intl', country: 'Hong Kong' }
const PARKING = '(N) T1 North|Gate N6'
const GATE_PROPERTIES = ['Gate Heavy', 'jetway', 'no stairs']
const SERVICE_WITH_DETAIL: GsxRemoteServiceStatus = {
  id: 'Refueling',
  displayName: 'Refuel',
  state: 'performing',
  stateText: 'Refueling service is being performed',
  icon: 'refueling',
  canTrigger: false,
  canBypass: false,
  operator: 'AFSC',
  statusText: 'pumping\nfuel 15357/81488 kg\naircraft 15606→30963 kg\nBill $24272',
  progressText: '19%',
  detail: { phase: 'pumping', fuel: { current: 15357, target: 81488, unit: 'kg', startTotal: 15606, aircraftTotal: 30963 }, bill: 24272 }
}

const PROMPT: GsxRemotePromptState = {
  kind: 'text',
  gen: 3,
  title: 'Save Location',
  description: '',
  default: '',
  maxLength: 64
}

describe('GsxRemoteService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('connects to ws://<host>:<port>/ and subscribes on open', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()

    expect(instances[0].url).toBe('ws://localhost:8744/')
    instances[0].simulateOpen()

    expect(instances[0].sent).toEqual([{ type: 'subscribe', channels: ['state', 'prompts', 'toasts'] }])
    expect(service.getStatus()).toEqual({ state: 'connected', lastError: null })
    service.stop()
  })

  it('applies a snapshot message, replacing state wholesale', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: SERVICES,
      menu: RAW_MENU,
      menuShown: true,
      prompt: null
    })

    expect(service.getServices()).toEqual(SERVICES)
    expect(service.getMenu()).toEqual(MENU)
    expect(service.getPrompt()).toBeNull()
    service.stop()
  })

  it('applies a patch to just the one top-level key it names', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()
    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: [],
      menu: RAW_MENU,
      menuShown: true,
      prompt: null
    })

    instances[0].simulateMessage({ v: 1, type: 'patch', ts: 2, path: '/services', value: SERVICES })

    expect(service.getServices()).toEqual(SERVICES)
    expect(service.getMenu()).toEqual(MENU) // untouched by the services patch
    service.stop()
  })

  it('drops a key when a patch value is null', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()
    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: [],
      menu: RAW_MENU,
      menuShown: true,
      prompt: PROMPT
    })

    instances[0].simulateMessage({ v: 1, type: 'patch', ts: 2, path: '/prompt', value: null })

    expect(service.getPrompt()).toBeNull()
    service.stop()
  })

  it('emits services/menu/prompt events only for the state slice that actually changed', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    const servicesListener = vi.fn()
    const menuListener = vi.fn()
    service.on('services', servicesListener)
    service.on('menu', menuListener)
    service.start()
    instances[0].simulateOpen()
    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: [],
      menu: RAW_MENU,
      menuShown: true,
      prompt: null
    })
    servicesListener.mockClear()
    menuListener.mockClear()

    instances[0].simulateMessage({ v: 1, type: 'patch', ts: 2, path: '/services', value: SERVICES })

    expect(servicesListener).toHaveBeenCalledOnce()
    expect(menuListener).not.toHaveBeenCalled()
    service.stop()
  })

  it('defaults services/menu/prompt before any snapshot arrives', () => {
    const { ctor } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)

    expect(service.getServices()).toEqual([])
    expect(service.getMenu()).toEqual({
      menuShown: false,
      title: '',
      header: '',
      subtitle: '',
      entries: [],
      icons: [],
      disabled: [],
      layout: ''
    })
    expect(service.getPrompt()).toBeNull()
  })

  it('sends menu.pick with the index when picking a menu entry', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()
    instances[0].sent = []

    service.pickMenu(2)

    expect(instances[0].sent).toEqual([{ type: 'command', verb: 'menu.pick', args: { index: 2 } }])
    service.stop()
  })

  it('sends input.submit/input.cancel for a text prompt', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()
    instances[0].sent = []

    service.submitPrompt(3, 'Gate 1')
    service.cancelPrompt(4)

    expect(instances[0].sent).toEqual([
      { type: 'command', verb: 'input.submit', args: { gen: 3, text: 'Gate 1' } },
      { type: 'command', verb: 'input.cancel', args: { gen: 4 } }
    ])
    service.stop()
  })

  it('does not send a command while disconnected', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    // Never opened — still CONNECTING.

    service.pickMenu(0)

    expect(instances[0].sent).toEqual([])
    service.stop()
  })

  it('reconnects with GSX-matching backoff after a close, and resubscribes', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].close()
    expect(service.getStatus().state).toBe('disconnected')
    expect(instances).toHaveLength(1)

    vi.advanceTimersByTime(250)
    expect(instances).toHaveLength(2)
    instances[1].simulateOpen()
    expect(instances[1].sent).toEqual([{ type: 'subscribe', channels: ['state', 'prompts', 'toasts'] }])
    service.stop()
  })

  it('does not reconnect after stop()', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()

    service.stop()
    instances[0].emit('close', {}) // a straggling close event after stop()

    vi.advanceTimersByTime(5_000)
    expect(instances).toHaveLength(1)
  })

  it('reconfigure() against a new host/port drops old state and reconnects', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()
    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: SERVICES,
      menu: RAW_MENU,
      menuShown: true,
      prompt: null
    })

    service.reconfigure('192.168.1.50', 8091)

    expect(instances[0].closed).toBe(true)
    expect(instances[1].url).toBe('ws://192.168.1.50:8091/')
    expect(service.getServices()).toEqual([]) // stale state from the old connection is gone
    service.stop()
  })

  it('a menuShown-only patch also emits a menu event (entries can be stale while closed)', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    const menuListener = vi.fn()
    service.on('menu', menuListener)
    service.start()
    instances[0].simulateOpen()
    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: [],
      menu: RAW_MENU,
      menuShown: true,
      prompt: null
    })
    menuListener.mockClear()

    instances[0].simulateMessage({ v: 1, type: 'patch', ts: 2, path: '/menuShown', value: false })

    expect(menuListener).toHaveBeenCalledWith(expect.objectContaining({ menuShown: false }))
    expect(service.getMenu().menuShown).toBe(false)
    service.stop()
  })

  it('returns null gate info before any airport/parking data arrives', () => {
    const { ctor } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)

    expect(service.getGateInfo()).toBeNull()
  })

  it('combines airport/parking/gateProperties into gate info from a snapshot', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: [],
      menu: RAW_MENU,
      menuShown: true,
      prompt: null,
      airport: AIRPORT,
      parking: PARKING,
      gateProperties: GATE_PROPERTIES
    })

    expect(service.getGateInfo()).toEqual({
      airportIcao: 'VHHH',
      airportName: 'Hong Kong Intl',
      parking: PARKING,
      gateProperties: GATE_PROPERTIES
    })
    service.stop()
  })

  it('emits a gate event for an airport/parking/gateProperties patch, not for an unrelated one', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    const gateListener = vi.fn()
    service.on('gate', gateListener)
    service.start()
    instances[0].simulateOpen()
    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: [],
      menu: RAW_MENU,
      menuShown: true,
      prompt: null
    })
    gateListener.mockClear()

    instances[0].simulateMessage({ v: 1, type: 'patch', ts: 2, path: '/services', value: SERVICES })
    expect(gateListener).not.toHaveBeenCalled()

    instances[0].simulateMessage({ v: 1, type: 'patch', ts: 3, path: '/airport', value: AIRPORT })
    instances[0].simulateMessage({ v: 1, type: 'patch', ts: 4, path: '/parking', value: PARKING })

    expect(gateListener).toHaveBeenCalledTimes(2)
    expect(service.getGateInfo()).toEqual({ airportIcao: 'VHHH', airportName: 'Hong Kong Intl', parking: PARKING, gateProperties: [] })
    service.stop()
  })

  it('passes a service\'s structured detail (fuel/bill) through unchanged', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: [SERVICE_WITH_DETAIL],
      menu: RAW_MENU,
      menuShown: true,
      prompt: null
    })

    expect(service.getServices()).toEqual([SERVICE_WITH_DETAIL])
    expect(service.getServices()[0].detail?.bill).toBe(24272)
    service.stop()
  })

  it('toggleMenu() sends menu.toggle when closed, menu.close when open', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()
    instances[0].sent = []

    service.toggleMenu()
    expect(instances[0].sent).toEqual([{ type: 'command', verb: 'menu.toggle' }])

    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: [],
      menu: RAW_MENU,
      menuShown: true,
      prompt: null
    })
    instances[0].sent = []

    service.toggleMenu()
    expect(instances[0].sent).toEqual([{ type: 'command', verb: 'menu.close' }])
    service.stop()
  })

  // Real wire shapes, confirmed live 2026-09-23 (docs/gsx-notes.md) by reading GSX's own
  // shipped menu.js source directly — STATIC_COMMANDS' ids/labels, and a real
  // commandIcons/commandIconsSvg/simbrief capture from a live VHHH session.
  const COMMAND_ICONS = {
    CUSTOMIZE_AIRPORT_POSITION: 'data:image/png;base64,AAA',
    CUSTOMIZE_AIRPLANE: 'data:image/png;base64,BBB',
    SETTINGS: 'data:image/png;base64,CCC',
    RESTART_COUATL: 'data:image/png;base64,DDD',
    RELOAD_SIMBRIEF: 'data:image/png;base64,EEE'
  }
  const COMMAND_ICONS_SVG = {
    CUSTOMIZE_AIRPORT_POSITION: 'data:image/svg+xml;base64,AAA',
    RESTART_COUATL: 'data:image/svg+xml;base64,DDD'
  }

  it('lists all three static commands with null icons before GSX has sent commandIcons, and no simbrief', () => {
    const { ctor } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)

    expect(service.getCommandBar()).toEqual({
      commands: [
        { id: 'CUSTOMIZE_AIRPORT_POSITION', label: 'Customize Airport', iconUri: null, confirm: false },
        { id: 'CUSTOMIZE_AIRPLANE', label: 'Customize Aircraft', iconUri: null, confirm: false },
        { id: 'RESTART_COUATL', label: 'Restart Couatl', iconUri: null, confirm: true }
      ],
      simbrief: null,
      simbriefIconUri: null
    })
  })

  it('combines commandIcons/commandIconsSvg/simbrief into the three real commands, excluding SETTINGS', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: [],
      menu: RAW_MENU,
      menuShown: true,
      prompt: null,
      commandIcons: COMMAND_ICONS,
      commandIconsSvg: COMMAND_ICONS_SVG,
      simbrief: { status: 'loaded', error: '', gen: 3 }
    })

    expect(service.getCommandBar()).toEqual({
      commands: [
        // SVG preferred over PNG when both exist, per menu.js's own fallback order.
        { id: 'CUSTOMIZE_AIRPORT_POSITION', label: 'Customize Airport', iconUri: 'data:image/svg+xml;base64,AAA', confirm: false },
        // PNG-only when no SVG exists for this id.
        { id: 'CUSTOMIZE_AIRPLANE', label: 'Customize Aircraft', iconUri: 'data:image/png;base64,BBB', confirm: false },
        { id: 'RESTART_COUATL', label: 'Restart Couatl', iconUri: 'data:image/svg+xml;base64,DDD', confirm: true }
      ],
      simbrief: { status: 'loaded', error: '', gen: 3 },
      simbriefIconUri: 'data:image/png;base64,EEE'
    })
    service.stop()
  })

  it('still lists all three commands with a null icon if GSX has not sent one for that id yet', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()

    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: [],
      menu: RAW_MENU,
      menuShown: true,
      prompt: null
    })

    const commandBar = service.getCommandBar()
    expect(commandBar.commands.map((c) => c.id)).toEqual(['CUSTOMIZE_AIRPORT_POSITION', 'CUSTOMIZE_AIRPLANE', 'RESTART_COUATL'])
    expect(commandBar.commands.every((c) => c.iconUri === null)).toBe(true)
    service.stop()
  })

  it('emits a commandBar event for a commandIcons/commandIconsSvg/simbrief patch, not for an unrelated one', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    const commandBarListener = vi.fn()
    service.on('commandBar', commandBarListener)
    service.start()
    instances[0].simulateOpen()
    instances[0].simulateMessage({
      v: 1,
      type: 'snapshot',
      ts: 1,
      services: [],
      menu: RAW_MENU,
      menuShown: true,
      prompt: null
    })
    commandBarListener.mockClear()

    instances[0].simulateMessage({ v: 1, type: 'patch', ts: 2, path: '/services', value: SERVICES })
    expect(commandBarListener).not.toHaveBeenCalled()

    instances[0].simulateMessage({ v: 1, type: 'patch', ts: 3, path: '/commandIcons', value: COMMAND_ICONS })
    instances[0].simulateMessage({ v: 1, type: 'patch', ts: 4, path: '/simbrief', value: { status: 'error', error: 'x', gen: 1 } })
    expect(commandBarListener).toHaveBeenCalledTimes(2)
    service.stop()
  })

  it('runCommand sends command.run with the id, GSX\'s own real wire shape', () => {
    const { ctor, instances } = makeCtor()
    const service = new GsxRemoteService('localhost', 8744, ctor)
    service.start()
    instances[0].simulateOpen()
    instances[0].sent = []

    service.runCommand('RESTART_COUATL')
    expect(instances[0].sent).toEqual([{ type: 'command', verb: 'command.run', args: { command: 'RESTART_COUATL' } }])

    service.runCommand('RELOAD_SIMBRIEF')
    expect(instances[0].sent[1]).toEqual({ type: 'command', verb: 'command.run', args: { command: 'RELOAD_SIMBRIEF' } })
    service.stop()
  })
})
