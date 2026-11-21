import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkSocket } from '@shared/lan-connection'
import type { HostLinkStatus } from '@shared/ipc'
import { logger } from '../logging/logger'
import { LiveHub } from '../live/LiveHub'
import { HostLink, HOST_LINK_TOPICS } from './HostLink'
import { HELD_BACK } from './flight-mirror'
import type { TwinSyncStatus } from './TwinSync'
import type { HostLinkStore, StoredHostLink } from './host-link-store'
import type { SocketPin } from './ws-socket'

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

/** The pin of the sim PC's certificate in these tests. */
const PIN = 'p'.repeat(43)

/** The refusal's English wording, as a user sees it: the link is down or reconnecting, so try again. */
const NOT_CONNECTED =
  "The sim PC isn't connected right now (the link may be reconnecting). Try again in a moment."

describe('HostLink', () => {
  let hub: LiveHub
  let sockets: FakeSocket[]
  /** What each socket was given to check the certificate against, in the order they were opened. */
  let pins: SocketPin[]
  let statuses: HostLinkStatus[]

  beforeEach(() => {
    hub = new LiveHub()
    sockets = []
    pins = []
    statuses = []
  })

  afterEach(() => vi.useRealTimers())

  function make(store: HostLinkStore): HostLink {
    return new HostLink({
      hub,
      store,
      createSocket: (url, pin) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        pins.push(pin)
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
      const link = make(memoryStore({ address, token: 'tok', pin: PIN }))
      await link.start()
      expect(link.getStatus().state, address).toBe('unpaired')
    }
    expect(sockets).toHaveLength(0)
  })

  it('pairs with the code, keeps the token it is given and follows the host topics into the hub', () => {
    const store = memoryStore()
    const link = make(store)
    link.pair('http://192.168.1.20:5051/', '123456', null)
    expect(sockets[0]?.url).toBe('wss://192.168.1.20:5051/live')
    sockets[0]?.open()
    expect(sockets[0]?.sent[0]).toEqual({ t: 'pair', code: '123456', name: 'WingLog on MAC', kind: 'twin' })
    // A typed pairing takes the certificate the sim PC shows on this connection.
    expect(pins[0]?.expected).toBeNull()
    pins[0]?.onCertificate(PIN)
    sockets[0]?.hear({ t: 'paired', token: 'tok-1' })
    sockets[0]?.hear(SNAPSHOT)
    expect(store.saved).toEqual([{ address: '192.168.1.20:5051', token: 'tok-1', pin: PIN }])
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
    link.pair('192.168.1.20:5051', '123456', null)
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

  it('follows a topic the host clears to null, not only the values it sets: the finished GSX routine is gone from the twin too (flight 436)', () => {
    const link = make(memoryStore())
    link.pair('192.168.1.20:5051', '123456', null)
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'paired', token: 't' })
    sockets[0]?.hear({ t: 'snapshot', topics: {}, flight: null })
    const stopped = { routineId: 'r', routineName: '777 Departure', state: 'stopped' }
    sockets[0]?.hear({ t: 'topic', name: 'gsxRoutine', payload: stopped })
    expect(hub.snapshot().gsxRoutine).toEqual(stopped)
    // The host's driver publishes null two minutes after a routine ends.
    sockets[0]?.hear({ t: 'topic', name: 'gsxRoutine', payload: null })
    expect(hub.snapshot().gsxRoutine).toBeNull()
  })

  it('takes a null from the host in its snapshot after a reconnect, replacing the value held from before the link dropped', () => {
    const link = make(memoryStore())
    link.pair('192.168.1.20:5051', '123456', null)
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'paired', token: 't' })
    sockets[0]?.hear({ t: 'snapshot', topics: {}, flight: null })
    sockets[0]?.hear({ t: 'topic', name: 'taxiRoute', payload: { points: [] } })
    sockets[0]?.hear({ t: 'topic', name: 'gsxRemotePrompt', payload: { title: 'x' } })
    sockets[0]?.drop()
    // While it was down the host cleared both.
    sockets[0]?.hear({ t: 'snapshot', topics: { taxiRoute: null, gsxRemotePrompt: null }, flight: null })
    expect(hub.snapshot().taxiRoute).toBeNull()
    expect(hub.snapshot().gsxRemotePrompt).toBeNull()
  })

  it('reconnects with the stored token at start, checking the stored pin', async () => {
    const link = make(memoryStore({ address: '10.0.0.7:49321', token: 'saved-token', pin: PIN }))
    await link.start()
    expect(sockets[0]?.url).toBe('wss://10.0.0.7:49321/live')
    expect(pins[0]?.expected).toBe(PIN)
    sockets[0]?.open()
    expect(sockets[0]?.sent[0]).toEqual({ t: 'hello', token: 'saved-token' })
    expect(link.getStatus().state).toBe('connecting')
    sockets[0]?.hear({ t: 'snapshot', topics: {}, flight: null })
    expect(link.getStatus().state).toBe('connected')
  })

  it('says so when the code is wrong', () => {
    const link = make(memoryStore())
    link.pair('192.168.1.20:5051', '000000', null)
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'denied' })
    expect(link.getStatus().state).toBe('wrong-code')
  })

  it('refuses an address that is not on the home network, and opens nothing', () => {
    const link = make(memoryStore())
    expect(() => link.pair('example.com:5051', '123456', null)).toThrow('address')
    expect(() => link.pair('8.8.8.8:5051', '123456', null)).toThrow('address')
    expect(sockets).toHaveLength(0)
    expect(link.getStatus().state).toBe('unpaired')
  })

  it('sends the host a command once connected, and refuses before', async () => {
    const link = make(memoryStore())
    expect(() => link.command('atc.setAction', ['Request Taxi'])).toThrow(NOT_CONNECTED)
    await expect(link.query('stands', 'EGLL')).rejects.toThrow(NOT_CONNECTED)
    link.pair('192.168.1.20:5051', '123456', null)
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
    await expect(link.commandAfterSync('gsx.startRoutine', ['my-routine'])).rejects.toThrow(NOT_CONNECTED)
    link.pair('192.168.1.20:5051', '123456', null)
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
    link.pair('192.168.1.20:5051', '123456', null)
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
    link.pair('192.168.1.20:5051', '123456', null)
    expect(events).toEqual(['forget cursors', 'socket'])
    link.forget()
    expect(events).toEqual(['forget cursors', 'socket', 'forget cursors'])
  })

  it('forgets the sim PC: closes the link, deletes the stored token and goes back to unpaired', () => {
    const store = memoryStore()
    const link = make(store)
    link.pair('192.168.1.20:5051', '123456', null)
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
    link.pair('192.168.1.20:5051', '123456', null)
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
            : HELD_BACK
          : payload
    })
    link.pair('192.168.1.20:5051', '123456', null)
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
    link.pair('192.168.1.20:5051', '123456', null)
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
    link.pair('192.168.1.20:5051', '123456', null)
    sockets[0]?.open()
    pins[0]?.onCertificate(PIN)
    sockets[0]?.hear({ t: 'paired', token: 't' })
    sockets[0]?.hear(SNAPSHOT)
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith('[host-link] could not store the token:', expect.any(Error))
    )
    expect(link.getStatus().state).toBe('connected')
  })

  describe('the pinned certificate (security audit M4)', () => {
    /** A link with a pin stored, started, whose first socket is open. */
    async function stored(store = memoryStore({ address: '192.168.1.20:5051', token: 'saved', pin: PIN })) {
      const link = make(store)
      await link.start()
      return { link, store }
    }

    it('checks the pin from pasted pairing text, stores it with the token, and does not look at the certificate shown', () => {
      const store = memoryStore()
      const link = make(store)
      link.pair('192.168.1.20:5051', '123456', PIN)
      expect(pins[0]?.expected).toBe(PIN)
      sockets[0]?.open()
      sockets[0]?.hear({ t: 'paired', token: 'tok-1' })
      sockets[0]?.hear(SNAPSHOT)
      expect(store.saved).toEqual([{ address: '192.168.1.20:5051', token: 'tok-1', pin: PIN }])
    })

    it('keeps the stored pin when the host sends a paired message on a link that was not pairing', async () => {
      const { store } = await stored()
      sockets[0]?.open()
      sockets[0]?.hear({ t: 'paired', token: 'unasked' })
      expect(store.saved).toEqual([{ address: '192.168.1.20:5051', token: 'unasked', pin: PIN }])
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('without a certificate pin'))
    })

    it('checks the stored pin, never a certificate it has not been told, on every later connection', async () => {
      vi.useFakeTimers()
      const link = make(memoryStore())
      link.pair('192.168.1.20:5051', '123456', null)
      sockets[0]?.open()
      pins[0]?.onCertificate(PIN)
      sockets[0]?.hear({ t: 'paired', token: 't' })
      sockets[0]?.hear(SNAPSHOT)
      sockets[0]?.drop()
      await vi.advanceTimersByTimeAsync(1100)
      // The reconnection is not a pairing: it expects the pin the pairing took, not "whatever is shown".
      expect(pins).toHaveLength(2)
      expect(pins[1]?.expected).toBe(PIN)
      link.stop()
    })

    it('stops, and opens nothing more, when the host revokes the token: the pin goes with it', async () => {
      const { link } = await stored()
      sockets[0]?.open()
      sockets[0]?.hear({ t: 'denied' })
      expect(link.getStatus().state).toBe('unpaired')
      expect(sockets).toHaveLength(1)
    })

    it('asks to pair again, and opens nothing, for a pairing stored before the link was encrypted', async () => {
      const store = memoryStore({ address: '192.168.1.20:5051', token: 'saved', pin: null })
      const link = make(store)
      await link.start()
      expect(sockets).toHaveLength(0)
      expect(link.getStatus()).toEqual({
        state: 'pair-again',
        address: '192.168.1.20:5051',
        hostSim: null,
        sync: IDLE
      })
      expect(statuses.at(-1)?.state).toBe('pair-again')
      expect(store.cleared).toBe(0)
      // Pairing again clears it, and forgetting does too.
      link.pair('192.168.1.20:5051', '123456', null)
      expect(link.getStatus().state).toBe('connecting')
      const other = make(store)
      await other.start()
      other.forget()
      expect(other.getStatus().state).toBe('unpaired')
    })

    for (const reason of ['certificate-changed', 'not-secure'] as const) {
      it(`says ${reason} when the connection is refused, keeps the token, and never sends it`, async () => {
        vi.useFakeTimers()
        const store = memoryStore({ address: '192.168.1.20:5051', token: 'saved', pin: PIN })
        const link = make(store)
        await link.start()
        // The socket is refused at the handshake, so it never opens: nothing is sent, and it closes.
        pins[0]?.onRefused(reason)
        sockets[0]?.drop()
        expect(link.getStatus().state).toBe(reason)
        expect(statuses.at(-1)?.state).toBe(reason)
        expect(sockets[0]?.sent).toEqual([])
        expect(store.cleared).toBe(0)
        // It keeps trying, and the state holds while each try is refused.
        await vi.advanceTimersByTimeAsync(1100)
        expect(sockets).toHaveLength(2)
        pins[1]?.onRefused(reason)
        sockets[1]?.drop()
        expect(link.getStatus().state).toBe(reason)
        expect(sockets[1]?.sent).toEqual([])
        // A connection that succeeds clears it.
        await vi.advanceTimersByTimeAsync(2100)
        expect(sockets).toHaveLength(3)
        sockets[2]?.open()
        sockets[2]?.hear({ t: 'snapshot', topics: {}, flight: null })
        expect(link.getStatus().state).toBe('connected')
        expect(sockets[2]?.sent[0]).toEqual({ t: 'hello', token: 'saved' })
        link.stop()
      })

      it(`pairing again or forgetting clears ${reason}`, async () => {
        const { link } = await stored()
        pins[0]?.onRefused(reason)
        expect(link.getStatus().state).toBe(reason)
        link.pair('192.168.1.20:5051', '123456', PIN)
        expect(link.getStatus().state).toBe('connecting')
        pins[1]?.onRefused(reason)
        expect(link.getStatus().state).toBe(reason)
        link.forget()
        expect(link.getStatus().state).toBe('unpaired')
      })
    }

    it('refuses a pairing whose pasted pin is not the certificate shown, without sending the code and without storing anything', () => {
      const store = memoryStore()
      const link = make(store)
      link.pair('192.168.1.20:5051', '123456', PIN)
      // The check refuses it at the handshake, so the socket never opens and the code is never sent.
      pins[0]?.onRefused('certificate-changed')
      sockets[0]?.drop()
      expect(sockets[0]?.sent).toEqual([])
      expect(link.getStatus().state).toBe('certificate-changed')
      expect(store.saved).toEqual([])
    })
  })

  it('forgets a token the host no longer accepts', async () => {
    const store = memoryStore({ address: '192.168.1.20:5051', token: 'revoked', pin: PIN })
    const link = make(store)
    await link.start()
    sockets[0]?.open()
    sockets[0]?.hear({ t: 'denied' })
    expect(store.cleared).toBe(1)
    expect(link.getStatus().state).toBe('unpaired')
  })
})
