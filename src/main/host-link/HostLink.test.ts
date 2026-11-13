import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkSocket } from '@shared/lan-connection'
import type { HostLinkStatus } from '@shared/ipc'
import { logger } from '../logging/logger'
import { LiveHub } from '../live/LiveHub'
import { HostLink, HOST_LINK_TOPICS } from './HostLink'
import type { TwinSyncStatus } from './TwinSync'
import type { HostLinkStore, StoredHostLink } from './host-link-store'

vi.mock('../logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

/** A socket the test drives: what the client sent, and what the host "says". */
class FakeSocket implements LinkSocket {
  readyState = 1
  sent: Record<string, unknown>[] = []
  closed = false
  onopen: ((event: never) => void) | null = null
  onmessage: ((event: never) => void) | null = null
  onclose: ((event: never) => void) | null = null
  constructor(readonly url: string) {}
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>)
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.onopen?.(undefined as never)
  }
  hear(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as never)
  }
  drop(): void {
    this.onclose?.(undefined as never)
  }
}

function memoryStore(
  initial: StoredHostLink | null = null
): HostLinkStore & { saved: StoredHostLink[]; cleared: number } {
  const store = {
    saved: [] as StoredHostLink[],
    cleared: 0,
    load: () => Promise.resolve(initial),
    save: (link: StoredHostLink) => {
      store.saved.push(link)
      return Promise.resolve()
    },
    clear: () => {
      store.cleared += 1
    }
  }
  return store
}

const IDLE = { state: 'idle', lastSyncedAt: null, problem: null } as const

describe('HostLink', () => {
  let hub: LiveHub
  let sockets: FakeSocket[]
  let statuses: HostLinkStatus[]

  beforeEach(() => {
    hub = new LiveHub()
    sockets = []
    statuses = []
  })

  afterEach(() => vi.useRealTimers())

  function make(store: HostLinkStore): HostLink {
    return new HostLink({
      hub,
      store,
      createSocket: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket
      },
      deviceName: 'WingLog on MAC',
      onStatus: (status) => statuses.push(status)
    })
  }

  const SNAPSHOT = {
    t: 'snapshot',
    topics: {
      beyondAtcState: { facility: null },
      storageStatus: { freeBytes: 1 },
      simConnectionStatus: { state: 'connected', simConnectVersion: '0.4' }
    },
    flight: null
  }

  it('starts unpaired with nothing stored, and connects to nothing', async () => {
    const link = make(memoryStore())
    await link.start()
    expect(link.getStatus()).toEqual({ state: 'unpaired', address: null, hostSim: null, sync: IDLE })
    expect(sockets).toHaveLength(0)
  })

  it('does not connect to a stored address outside the home network, such as one edited by hand (review of L8)', async () => {
    for (const address of ['8.8.8.8:5051', 'example.com:5051', 'not an address']) {
      const link = make(memoryStore({ address, token: 'tok' }))
      await link.start()
      expect(link.getStatus().state, address).toBe('unpaired')
    }
    expect(sockets).toHaveLength(0)
  })

  it('pairs with the code, keeps the token it is given and follows the host topics into the hub', () => {
    const store = memoryStore()
    const link = make(store)
    link.pair('http://192.168.1.20:5051/', '123456')
    expect(sockets[0]?.url).toBe('ws://192.168.1.20:5051/live')
    sockets[0]?.open()
    expect(sockets[0]?.sent[0]).toEqual({ t: 'pair', code: '123456', name: 'WingLog on MAC', kind: 'twin' })
    sockets[0]?.hear({ t: 'paired', token: 'tok-1' })
    sockets[0]?.hear(SNAPSHOT)
    expect(store.saved).toEqual([{ address: '192.168.1.20:5051', token: 'tok-1' }])
    expect(link.getStatus()).toEqual({
      state: 'connected',
      address: '192.168.1.20:5051',
      hostSim: 'connected',
      sync: IDLE
    })
    expect(hub.snapshot().beyondAtcState).toEqual({ facility: null })
    expect(hub.snapshot().simConnectionStatus).toEqual({ state: 'connected', simConnectVersion: '0.4' })
    // This computer's own disk warning is not replaced by the host's.
    expect(hub.snapshot().storageStatus).toBeUndefined()
    expect(statuses.at(-1)?.state).toBe('connected')
  })

  it('follows each later topic the host publishes', () => {
    const link = make(memoryStore())
    link.pair('192.168.1.20:5051', '123456')
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'paired', token: 't' })
    sockets[0]?.hear({ t: 'snapshot', topics: {}, flight: null })
    sockets[0]?.hear({ t: 'topic', name: 'gsxRemoteStatus', payload: { state: 'connected' } })
    sockets[0]?.hear({ t: 'topic', name: 'storageStatus', payload: { freeBytes: 2 } })
    expect(hub.snapshot().gsxRemoteStatus).toEqual({ state: 'connected' })
    expect(hub.snapshot().storageStatus).toBeUndefined()
    expect(HOST_LINK_TOPICS).not.toContain('storageStatus')
    expect(HOST_LINK_TOPICS).toContain('beyondAtcTranscript')
  })

  it('reconnects with the stored token at start', async () => {
    const link = make(memoryStore({ address: '10.0.0.7:49321', token: 'saved-token' }))
    await link.start()
    expect(sockets[0]?.url).toBe('ws://10.0.0.7:49321/live')
    sockets[0]?.open()
    expect(sockets[0]?.sent[0]).toEqual({ t: 'hello', token: 'saved-token' })
    expect(link.getStatus().state).toBe('connecting')
    sockets[0]?.hear({ t: 'snapshot', topics: {}, flight: null })
    expect(link.getStatus().state).toBe('connected')
  })

  it('says so when the code is wrong', () => {
    const link = make(memoryStore())
    link.pair('192.168.1.20:5051', '000000')
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'denied' })
    expect(link.getStatus().state).toBe('wrong-code')
  })

  it('refuses an address that is not on the home network, and opens nothing', () => {
    const link = make(memoryStore())
    expect(() => link.pair('example.com:5051', '123456')).toThrow('address')
    expect(() => link.pair('8.8.8.8:5051', '123456')).toThrow('address')
    expect(sockets).toHaveLength(0)
    expect(link.getStatus().state).toBe('unpaired')
  })

  it('sends the host a command once connected, and refuses before', async () => {
    const link = make(memoryStore())
    expect(() => link.command('atc.setAction', ['Request Taxi'])).toThrow('Not connected')
    await expect(link.query('stands', 'EGLL')).rejects.toThrow('Not connected')
    link.pair('192.168.1.20:5051', '123456')
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'paired', token: 't' })
    sockets[0]?.hear({ t: 'snapshot', topics: {}, flight: null })
    link.command('atc.setAction', ['Request Taxi'])
    expect(sockets[0]?.sent.at(-1)).toEqual({ t: 'cmd', name: 'atc.setAction', args: ['Request Taxi'] })
  })

  it('sends a command after the two databases are level, so what was just made here is on the host first', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const link = new HostLink({
      hub,
      store: memoryStore(),
      createSocket: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket
      },
      deviceName: 'WingLog on MAC',
      onStatus: () => {},
      sync: {
        run: () => {
          order.push('sync started')
          return new Promise<boolean>((resolve) => {
            release = () => {
              order.push('sync ended')
              resolve(true)
            }
          })
        },
        syncSoon: () => undefined,
        status: () => IDLE,
        forgetCursors: () => undefined,
        onChange: () => undefined
      }
    })
    await expect(link.commandAfterSync('gsx.startRoutine', ['my-routine'])).rejects.toThrow('Not connected')
    link.pair('192.168.1.20:5051', '123456')
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'paired', token: 't' })
    sockets[0]?.hear({ t: 'snapshot', topics: {}, flight: null })
    const sentBefore = sockets[0]?.sent.length ?? 0
    const sending = link.commandAfterSync('gsx.startRoutine', ['my-routine'])
    // Nothing is sent while the sync is running.
    await Promise.resolve()
    expect(sockets[0]?.sent.length).toBe(sentBefore)
    release()
    await sending
    expect(order).toEqual(['sync started', 'sync ended'])
    expect(sockets[0]?.sent.at(-1)).toEqual({ t: 'cmd', name: 'gsx.startRoutine', args: ['my-routine'] })
  })

  it('marks the host sim disconnected when the link drops, so stale telemetry is not shown as live', () => {
    vi.useFakeTimers()
    const link = make(memoryStore())
    link.pair('192.168.1.20:5051', '123456')
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'paired', token: 't' })
    sockets[0]?.hear(SNAPSHOT)
    expect(hub.snapshot().simConnectionStatus).toMatchObject({ state: 'connected' })
    sockets[0]?.drop()
    expect(link.getStatus()).toEqual({
      state: 'offline',
      address: '192.168.1.20:5051',
      hostSim: 'disconnected',
      sync: IDLE
    })
    expect(hub.snapshot().simConnectionStatus).toEqual({ state: 'disconnected' })
    link.stop()
  })

  it('drops the cursors kept for the old sim PC whenever it pairs and when it forgets, before anything new is synced (audit M8)', () => {
    const events: string[] = []
    const link = new HostLink({
      hub,
      store: memoryStore(),
      createSocket: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        events.push('socket')
        return socket
      },
      deviceName: 'WingLog on MAC',
      onStatus: () => {},
      sync: {
        run: () => Promise.resolve(true),
        syncSoon: () => undefined,
        status: () => IDLE,
        forgetCursors: () => void events.push('forget cursors'),
        onChange: () => undefined
      }
    })
    link.pair('192.168.1.20:5051', '123456')
    expect(events).toEqual(['forget cursors', 'socket'])
    link.forget()
    expect(events).toEqual(['forget cursors', 'socket', 'forget cursors'])
  })

  it('forgets the sim PC: closes the link, deletes the stored token and goes back to unpaired', () => {
    const store = memoryStore()
    const link = make(store)
    link.pair('192.168.1.20:5051', '123456')
    sockets[0]?.open()
    link.forget()
    expect(sockets[0]?.closed).toBe(true)
    expect(store.cleared).toBe(1)
    expect(link.getStatus()).toEqual({ state: 'unpaired', address: null, hostSim: null, sync: IDLE })
  })

  it('asks for a sync when the link comes up and when the host says its data changed, and shows the sync in its status', () => {
    const asked: number[] = []
    let current: TwinSyncStatus = IDLE
    let changed: () => void = () => {}
    const link = new HostLink({
      hub,
      store: memoryStore(),
      createSocket: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket
      },
      deviceName: 'WingLog on MAC',
      onStatus: (status) => statuses.push(status),
      sync: {
        run: () => Promise.resolve(true),
        syncSoon: (delayMs) => void asked.push(delayMs),
        status: () => current,
        forgetCursors: () => undefined,
        onChange: (listener) => (changed = listener)
      }
    })
    link.pair('192.168.1.20:5051', '123456')
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'paired', token: 't' })
    expect(asked).toEqual([])
    sockets[0]?.hear({ t: 'snapshot', topics: {}, flight: null })
    expect(asked).toEqual([0])
    sockets[0]?.hear({ t: 'sync' })
    expect(asked).toEqual([0, 500])
    current = { state: 'syncing', lastSyncedAt: '2026-11-08T12:00:00.000Z', problem: null }
    const before = statuses.length
    changed()
    expect(statuses.length).toBe(before + 1)
    expect(link.getStatus().sync).toEqual(current)
  })

  it('re-labels a topic on its way in, and holds back one that cannot be re-labelled yet', () => {
    const link = new HostLink({
      hub,
      store: memoryStore(),
      createSocket: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket
      },
      deviceName: 'WingLog on MAC',
      onStatus: () => {},
      mapTopic: (topic, payload) =>
        topic === 'trackingPoint'
          ? (payload as { flightId: number }).flightId === 7
            ? { flightId: 3 }
            : null
          : payload
    })
    link.pair('192.168.1.20:5051', '123456')
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'paired', token: 't' })
    sockets[0]?.hear({ t: 'snapshot', topics: {}, flight: null })
    sockets[0]?.hear({ t: 'topic', name: 'trackingPoint', payload: { flightId: 7 } })
    expect(hub.snapshot().trackingPoint).toEqual({ flightId: 3 })
    sockets[0]?.hear({ t: 'topic', name: 'trackingPoint', payload: { flightId: 99 } })
    expect(hub.snapshot().trackingPoint).toEqual({ flightId: 3 })
    sockets[0]?.hear({ t: 'topic', name: 'gsxRemoteStatus', payload: { state: 'connected' } })
    expect(hub.snapshot().gsxRemoteStatus).toEqual({ state: 'connected' })
  })

  it('tells who follows the flight when the host shows one, and when the link is closed', () => {
    const seen: (string | null)[] = []
    const link = new HostLink({
      hub,
      store: memoryStore(),
      createSocket: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket
      },
      deviceName: 'WingLog on MAC',
      onStatus: () => {},
      onFlight: (flight, points) => {
        seen.push(flight ? 'flight' : null)
        // The points are read when asked for: none yet from a flight just shown, and none once the link is closed.
        expect(points()).toEqual([])
      }
    })
    link.pair('192.168.1.20:5051', '123456')
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'paired', token: 't' })
    sockets[0]?.hear({ t: 'snapshot', topics: {}, flight: { flight: { flightId: 7 }, trackPoints: [] } })
    expect(seen.at(-1)).toBe('flight')
    link.forget()
    expect(seen.at(-1)).toBeNull()
  })

  it('stays paired when the token could not be stored, and says so in the log', async () => {
    const store = { ...memoryStore(), save: () => Promise.reject(new Error('keychain locked')) }
    const link = make(store)
    link.pair('192.168.1.20:5051', '123456')
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'paired', token: 't' })
    sockets[0]?.hear(SNAPSHOT)
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith('[host-link] could not store the token:', expect.any(Error))
    )
    expect(link.getStatus().state).toBe('connected')
  })

  it('forgets a token the host no longer accepts', async () => {
    const store = memoryStore({ address: '192.168.1.20:5051', token: 'revoked' })
    const link = make(store)
    await link.start()
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'denied' })
    expect(store.cleared).toBe(1)
    expect(link.getStatus().state).toBe('unpaired')
  })
})
