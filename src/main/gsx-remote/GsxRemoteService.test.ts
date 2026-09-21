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
})
