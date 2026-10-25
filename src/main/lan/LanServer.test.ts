import { createServer, request } from 'node:http'
import { type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { logger } from '../logging/logger'
import { LiveHub } from '../live/LiveHub'
import { hashToken } from './pairing'
import {
  LAN_TOPICS,
  LanServer,
  ABUSE_FACTOR,
  MAX_PENDING_FAST,
  MAX_PENDING_SLOW,
  RATE_BURST,
  RATE_PER_SECOND,
  MAX_SOCKETS,
  MAX_UNAUTHENTICATED_PER_ADDRESS,
  type LanServerDeps
} from './LanServer'

vi.mock('../logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

const HOST = '127.0.0.1'

/** A port nothing is listening on. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, HOST, resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** An in-memory stand-in for the lan_device table, keyed the way the real one is. */
function deviceStore() {
  const rows = new Map<string, number>()
  const seen: number[] = []
  return {
    rows,
    seen,
    devices: {
      add: (_name: string, tokenHash: string) => {
        rows.set(tokenHash, rows.size + 1)
        return rows.size
      },
      find: (tokenHash: string) => rows.get(tokenHash) ?? null,
      touch: (id: number) => void seen.push(id)
    }
  }
}

/** A socket under test, remembering everything the server said to it. */
class TestClient {
  readonly received: Record<string, unknown>[] = []
  readonly ws: WebSocket
  closed = false

  constructor(url: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(url, { headers })
    this.ws.on('message', (data) => this.received.push(JSON.parse(data.toString())))
    this.ws.on('close', () => (this.closed = true))
    this.ws.on('error', () => undefined)
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    })
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message))
  }

  async waitFor(predicate: () => boolean): Promise<void> {
    await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 2000, interval: 5 })
  }

  async message(type: string): Promise<Record<string, unknown>> {
    await this.waitFor(() => this.received.some((m) => m.t === type))
    return this.received.find((m) => m.t === type) as Record<string, unknown>
  }
}

describe('LanServer', () => {
  const open: TestClient[] = []
  let server: LanServer | null = null

  afterEach(async () => {
    for (const client of open.splice(0)) client.ws.terminate()
    await server?.stop()
    server = null
  })

  /** Starts a server on a free loopback port. */
  async function setup(overrides: Partial<LanServerDeps> = {}) {
    const hub = new LiveHub()
    const store = deviceStore()
    const ran: { name: string; args: unknown[] }[] = []
    const deps: LanServerDeps = {
      hub,
      commands: {
        'atc.setAction': (...args) => void ran.push({ name: 'atc.setAction', args }),
        'gsx.toggleMenu': (...args) => void ran.push({ name: 'gsx.toggleMenu', args }),
        // A command whose own code fails, as a bug in one would.
        'gsx.search': () => {
          throw new Error('no such gate')
        }
      },
      devices: store.devices,
      flight: () => ({ route: ['WSSS', 'EGLL'] }),
      queries: {
        echo: (...args) => args,
        later: (arg) => Promise.resolve(`later ${String(arg)}`),
        broken: () => {
          throw new Error('no')
        },
        // What a failed SimConnect connection throws: no message at all.
        noMessage: () => {
          throw new AggregateError([new Error('ECONNREFUSED')])
        },
        never: () => new Promise(() => undefined),
        // Names in the lookup table's slow lane (src/shared/lan-queries.ts).
        'navdata.refreshAirport': () => new Promise(() => undefined),
        stands: () => new Promise(() => undefined)
      },
      staticFile: (path) => (path === '/' ? { type: 'text/html', body: '<h1>WingLog</h1>' } : null),
      now: () => Date.now(),
      ...overrides
    }
    server = new LanServer(deps)
    const port = await freePort()
    await server.start(HOST, port)
    const url = `ws://${HOST}:${port}/live`
    const connect = async (headers?: Record<string, string>) => {
      const client = new TestClient(url, { host: `${HOST}:${port}`, ...headers })
      open.push(client)
      await client.opened()
      return client
    }
    /** Pairs a new socket with the code the PC shows; returns the socket and its token. */
    const pair = async () => {
      const { code } = server!.openPairing()
      const client = await connect()
      client.send({ t: 'pair', code, name: 'iPad' })
      const paired = await client.message('paired')
      return { client, token: paired.token as string }
    }
    return { server: server!, hub, store, ran, port, url, connect, pair }
  }

  describe('the page', () => {
    it('serves the page on the bound address and nothing else', async () => {
      const { port } = await setup()
      const get = (path: string, host = `${HOST}:${port}`, method = 'GET') =>
        new Promise<{ status: number; body: string; type?: string; referrerPolicy?: string }>(
          (resolve, reject) => {
            const req = request({ host: HOST, port, path, method, headers: { host } }, (res) => {
              let body = ''
              res.on('data', (chunk) => (body += chunk))
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body,
                  type: res.headers['content-type'],
                  referrerPolicy: res.headers['referrer-policy'] as string | undefined
                })
              )
            })
            req.on('error', reject)
            req.end()
          }
        )
      expect(await get('/')).toMatchObject({ status: 200, body: '<h1>WingLog</h1>', type: 'text/html' })
      expect((await get('/')).referrerPolicy).toBe('no-referrer')
      expect((await get('/secret.js')).status).toBe(404)
      expect((await get('/', 'evil.example:80')).status).toBe(404)
      expect((await get('/', `${HOST}:${port}`, 'POST')).status).toBe(404)
    })
  })

  describe('the socket door', () => {
    it('refuses a Host that is not the bound address (DNS rebinding)', async () => {
      const { url } = await setup()
      const client = new TestClient(url, { host: 'attacker.example:8765' })
      await expect(client.opened()).rejects.toThrow(/403/)
    })

    it('refuses an Origin from another site, and accepts the page served by this server', async () => {
      const { url, port } = await setup()
      const foreign = new TestClient(url, { host: `${HOST}:${port}`, origin: 'http://evil.example' })
      await expect(foreign.opened()).rejects.toThrow(/403/)
      const malformed = new TestClient(url, { host: `${HOST}:${port}`, origin: 'not a url' })
      await expect(malformed.opened()).rejects.toThrow(/403/)
      const ours = new TestClient(url, { host: `${HOST}:${port}`, origin: `http://${HOST}:${port}` })
      open.push(ours)
      await expect(ours.opened()).resolves.toBeUndefined()
    })

    it('refuses any path but /live', async () => {
      const { port } = await setup()
      const client = new TestClient(`ws://${HOST}:${port}/other`)
      await expect(client.opened()).rejects.toThrow(/404/)
    })

    it('refuses the ninth socket', async () => {
      const { connect, pair, url } = await setup()
      const { token } = await pair()
      for (let i = 1; i < MAX_SOCKETS; i++) {
        const device = await connect()
        device.send({ t: 'hello', token })
        await device.message('snapshot')
      }
      const ninth = new TestClient(url, { host: new URL(url).host })
      await expect(ninth.opened()).rejects.toThrow(/503/)
    })

    it('refuses a fifth socket from one address that has not paired, but not a paired device from the same address', async () => {
      const { connect, pair, url } = await setup()
      const { token } = await pair()
      for (let i = 0; i < MAX_UNAUTHENTICATED_PER_ADDRESS; i++) await connect()
      const fifth = new TestClient(url, { host: new URL(url).host })
      await expect(fifth.opened()).rejects.toThrow(/429/)
      // The paired device's own socket does not count against the limit, and closing waiting ones frees room.
      open[1].ws.terminate()
      await vi.waitFor(async () => {
        const next = new TestClient(url, { host: new URL(url).host })
        open.push(next)
        await expect(next.opened()).resolves.toBeUndefined()
      })
      expect(token).toBeTruthy()
    })

    it('closes a socket that has not paired or said hello in time', async () => {
      const { connect } = await setup({ authTimeoutMs: 40 })
      const client = await connect()
      await client.waitFor(() => client.closed)
    })

    it('closes a socket that sends more than the size limit', async () => {
      const { connect } = await setup()
      const client = await connect()
      client.send('x'.repeat(20 * 1024))
      await client.waitFor(() => client.closed)
    })
  })

  describe('pairing', () => {
    it('pairs with the code, hands back a token, stores only its hash and sends the snapshot', async () => {
      const { pair, store, hub } = await setup()
      hub.publish('simConnectionStatus', { state: 'connected' } as never)
      const { client, token } = await pair()
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect([...store.rows.keys()]).toEqual([hashToken(token)])
      expect(JSON.stringify([...store.rows.keys()])).not.toContain(token)
      const snapshot = await client.message('snapshot')
      expect(snapshot.flight).toEqual({ route: ['WSSS', 'EGLL'] })
    })

    it('denies a wrong code and closes the socket', async () => {
      const { server, connect, store } = await setup()
      server.openPairing()
      const client = await connect()
      client.send({ t: 'pair', code: '000000x', name: 'iPad' })
      await client.message('denied')
      await client.waitFor(() => client.closed)
      expect(store.rows.size).toBe(0)
    })

    it('denies everything when no pairing window is open', async () => {
      const { connect } = await setup()
      const client = await connect()
      client.send({ t: 'pair', code: '123456' })
      await client.message('denied')
    })

    it('closes the window after five wrong codes, so the right code no longer works', async () => {
      const { server, connect, store } = await setup()
      const { code } = server.openPairing()
      for (let i = 0; i < 5; i++) {
        const client = await connect()
        client.send({ t: 'pair', code: code === '000000' ? '111111' : '000000' })
        await client.message('denied')
      }
      const right = await connect()
      right.send({ t: 'pair', code })
      await right.message('denied')
      expect(store.rows.size).toBe(0)
    })

    it('reports whether a pairing window is open: only until its code is used', async () => {
      const { server, connect } = await setup()
      expect(server.pairingOpen).toBe(false)
      const { code } = server.openPairing()
      expect(server.pairingOpen).toBe(true)
      const client = await connect()
      client.send({ t: 'pair', code })
      await client.message('paired')
      expect(server.pairingOpen).toBe(false)
    })

    it('uses a code once', async () => {
      const { server, pair, connect } = await setup()
      const { code } = server.openPairing()
      const first = await connect()
      first.send({ t: 'pair', code })
      await first.message('paired')
      const second = await connect()
      second.send({ t: 'pair', code })
      await second.message('denied')
      void pair
    })

    it('can be closed from the PC', async () => {
      const { server, connect } = await setup()
      const { code } = server.openPairing()
      server.closePairing()
      const client = await connect()
      client.send({ t: 'pair', code })
      await client.message('denied')
    })

    it('records a clean device name', async () => {
      const names: string[] = []
      const store = deviceStore()
      const { server, connect } = await setup({
        devices: { ...store.devices, add: (name, hash) => (names.push(name), store.devices.add(name, hash)) }
      })
      const { code } = server.openPairing()
      const client = await connect()
      client.send({ t: 'pair', code, name: `Pad\n${'x'.repeat(80)}` })
      await client.message('paired')
      expect(names[0]).toHaveLength(40)
      expect(names[0]).not.toContain('\n')
    })
  })

  describe('a paired device', () => {
    it('reconnects with its token and gets the snapshot, restricted to the allowed topics', async () => {
      const { pair, connect, hub, store } = await setup()
      const { token } = await pair()
      hub.publish('simTelemetry', { latitude: 1.37 } as never)
      ;(hub as unknown as { latest: Record<string, unknown> }).latest['somethingNew'] = 'private'
      const again = await connect()
      again.send({ t: 'hello', token })
      const snapshot = await again.message('snapshot')
      expect(Object.keys(snapshot.topics as object)).toEqual(['simTelemetry'])
      expect(store.seen).toHaveLength(1)
    })

    it('is denied with an unknown token, a non-string token or none', async () => {
      const { connect } = await setup()
      for (const hello of [{ t: 'hello', token: 'nope' }, { t: 'hello', token: 5 }, { t: 'hello' }]) {
        const client = await connect()
        client.send(hello)
        await client.message('denied')
        await client.waitFor(() => client.closed)
      }
    })

    it('hears every allowed topic as it is published and nothing before it has authenticated', async () => {
      const { pair, connect, hub } = await setup()
      const stranger = await connect()
      const { client } = await pair()
      await client.message('snapshot')
      hub.publish('simTelemetry', { latitude: 1 } as never)
      hub.publish('beyondAtcStatus', { state: 'ready' } as never)
      await client.waitFor(() => client.received.filter((m) => m.t === 'topic').length === 2)
      expect(client.received.filter((m) => m.t === 'topic')).toEqual([
        { t: 'topic', name: 'simTelemetry', payload: { latitude: 1 } },
        { t: 'topic', name: 'beyondAtcStatus', payload: { state: 'ready' } }
      ])
      expect(stranger.received).toEqual([])
    })

    it('tells a connected device when tracking starts, once per flight, before the first point', async () => {
      let active: unknown = null
      const { pair, hub } = await setup({ flight: () => active })
      const { client } = await pair()
      await client.message('snapshot')
      expect(client.received.find((m) => m.t === 'snapshot')).toMatchObject({ flight: null })
      active = { flight: { flightId: 7, depIcao: 'WSSS', arrIcao: 'EGLL', ofpJson: null }, trackPoints: [] }
      hub.publish('trackingPoint', { id: 1, flightId: 7 } as never)
      hub.publish('trackingPoint', { id: 2, flightId: 7 } as never)
      await client.waitFor(() => client.received.filter((m) => m.t === 'topic').length === 2)
      const kinds = client.received.slice(2).map((m) => m.t)
      expect(kinds).toEqual(['flight', 'topic', 'topic'])
      expect(client.received[2]).toEqual({ t: 'flight', flight: active })
      hub.publish('trackingPoint', { id: 3, flightId: 8 } as never)
      await client.waitFor(() => client.received.filter((m) => m.t === 'flight').length === 2)
    })

    it('does not announce a flight for points without a flight id, or other topics', async () => {
      const { pair, hub } = await setup({ flight: () => ({ flight: { flightId: 7 } }) })
      const { client } = await pair()
      await client.message('snapshot')
      hub.publish('trackingPoint', { id: 1 } as never)
      hub.publish('trackingPoint', null as never)
      hub.publish('simTelemetry', { flightId: 99 } as never)
      hub.publish('trackingPoint', { id: 2, flightId: 7 } as never)
      await client.waitFor(() => client.received.filter((m) => m.t === 'topic').length === 4)
      expect(client.received.some((m) => m.t === 'flight')).toBe(false)
    })

    it('runs a command from the table and refuses one that is not in it', async () => {
      const { pair, ran } = await setup()
      const { client } = await pair()
      client.send({ t: 'cmd', name: 'atc.setAction', args: ['Request pushback'] })
      await vi.waitFor(() => expect(ran).toEqual([{ name: 'atc.setAction', args: ['Request pushback'] }]))
      client.send({ t: 'cmd', name: 'settings.save', args: [] })
      client.send({ t: 'cmd', name: '__proto__', args: [] })
      client.send({ t: 'cmd', name: 'atc.setAction', args: [1, 2, 3] })
      await client.waitFor(() => client.received.filter((m) => m.t === 'error').length === 3)
      expect(client.received.filter((m) => m.t === 'error')).toEqual(
        Array(3).fill({ t: 'error', message: 'Not allowed' })
      )
      expect(ran).toHaveLength(1)
    })

    it('answers a lookup, including one that takes a moment, and says so when it cannot', async () => {
      const { pair } = await setup()
      const { client } = await pair()
      client.send({ t: 'query', id: 1, name: 'echo', args: [{ icao: 'WSSS' }, 'x'] })
      client.send({ t: 'query', id: 2, name: 'later', args: ['x'] })
      client.send({ t: 'query', id: 3, name: 'broken' })
      client.send({ t: 'query', id: 4, name: 'settings.save' })
      client.send({ t: 'query', id: 5, name: '__proto__' })
      client.send({ t: 'query', id: 'six', name: 'echo' })
      client.send({ t: 'query', id: 7, name: 'echo', args: 'not a list' })
      client.send({ t: 'query', id: 8, name: 'echo', args: [1, 2, 3, 4, 5, 6, 7] })
      await client.waitFor(() => client.received.filter((m) => m.t === 'result').length === 7)
      const results = client.received.filter((m) => m.t === 'result')
      expect(results).toContainEqual({ t: 'result', id: 1, data: [{ icao: 'WSSS' }, 'x'] })
      expect(results).toContainEqual({ t: 'result', id: 2, data: 'later x' })
      for (const id of [3, 4, 5, 7, 8]) expect(results).toContainEqual({ t: 'result', id, error: true })
    })

    it('answers a quick lookup over the limit with busy and a time to wait, not with silence', async () => {
      const { pair } = await setup()
      const { client } = await pair()
      for (let id = 1; id <= MAX_PENDING_FAST + 1; id++) client.send({ t: 'query', id, name: 'never' })
      await client.waitFor(() => client.received.some((m) => m.t === 'result'))
      expect(client.received.filter((m) => m.t === 'result')).toEqual([
        { t: 'result', id: MAX_PENDING_FAST + 1, error: true, busy: true, retryAfterMs: 250 }
      ])
    })

    it('counts slow lookups apart, so two of them waiting never hold up a quick one', async () => {
      const { pair } = await setup()
      const { client } = await pair()
      client.send({ t: 'query', id: 1, name: 'navdata.refreshAirport', args: ['EGLL'] })
      client.send({ t: 'query', id: 2, name: 'stands', args: ['EGLL'] })
      client.send({ t: 'query', id: 3, name: 'stands', args: ['WSSS'] })
      client.send({ t: 'query', id: 4, name: 'echo', args: ['quick'] })
      await client.waitFor(() => client.received.filter((m) => m.t === 'result').length === 2)
      const results = client.received.filter((m) => m.t === 'result')
      expect(MAX_PENDING_SLOW).toBe(2)
      expect(results).toContainEqual({ t: 'result', id: 3, error: true, busy: true, retryAfterMs: 250 })
      expect(results).toContainEqual({ t: 'result', id: 4, data: ['quick'] })
    })

    it('ignores lookups from a socket that has not authenticated', async () => {
      const { connect } = await setup()
      const client = await connect()
      client.send({ t: 'query', id: 1, name: 'echo', args: [1] })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(client.received).toEqual([])
    })

    it('ignores commands from a socket that has not authenticated', async () => {
      const { connect, ran } = await setup()
      const client = await connect()
      client.send({ t: 'cmd', name: 'gsx.toggleMenu', args: [] })
      client.send({ t: 'cmd', name: 'gsx.toggleMenu', args: [] })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(ran).toEqual([])
    })

    it('drops garbage without closing or throwing', async () => {
      const { pair } = await setup()
      const { client } = await pair()
      for (const junk of ['not json', '42', 'null', '[]', '{"t":"unknown"}', '{"t":5}']) client.send(junk)
      client.ws.send(Buffer.from([1, 2, 3]), { binary: true })
      client.send({ t: 'cmd', name: 'gsx.toggleMenu', args: [] })
      await vi.waitFor(() => expect(client.closed).toBe(false))
      expect(client.received.filter((m) => m.t === 'error')).toEqual([])
    })

    describe('the rate limit', () => {
      it('lets a burst through, then answers each message over the limit with busy and how long to wait', async () => {
        const { pair, ran } = await setup({ now: () => 1_000_000 })
        const { client } = await pair()
        for (let i = 0; i < RATE_BURST + 5; i++) client.send({ t: 'cmd', name: 'gsx.toggleMenu', args: [] })
        client.send({ t: 'query', id: 9, name: 'echo', args: ['x'] })
        await client.waitFor(() => client.received.some((m) => m.t === 'result'))
        // The pairing message used one of the burst.
        expect(ran.length).toBe(RATE_BURST - 1)
        const busy = client.received.filter((m) => m.t === 'error')
        expect(busy).toHaveLength(6)
        expect(busy[0]).toEqual({ t: 'error', message: 'busy', retryAfterMs: 50 })
        expect(client.received.find((m) => m.t === 'result')).toEqual({
          t: 'result',
          id: 9,
          error: true,
          busy: true,
          retryAfterMs: 50
        })
        expect(client.closed).toBe(false)
      })

      it('lets messages through again as the bucket refills', async () => {
        let now = 1_000_000
        const { pair, ran } = await setup({ now: () => now })
        const { client } = await pair()
        for (let i = 0; i < RATE_BURST; i++) client.send({ t: 'cmd', name: 'gsx.toggleMenu', args: [] })
        await vi.waitFor(() => expect(ran.length).toBe(RATE_BURST - 1))
        now += 500
        for (let i = 0; i < RATE_PER_SECOND; i++) client.send({ t: 'cmd', name: 'gsx.toggleMenu', args: [] })
        // Half a second refills half a second's worth of the rate.
        await vi.waitFor(() => expect(ran.length).toBe(RATE_BURST - 1 + RATE_PER_SECOND / 2))
      })

      it('closes a socket that keeps sending long after it was told to wait', async () => {
        const { pair } = await setup({ now: () => 1_000_000 })
        const { client } = await pair()
        for (let i = 0; i < RATE_BURST + ABUSE_FACTOR * RATE_PER_SECOND + 5; i++)
          client.send({ t: 'cmd', name: 'gsx.toggleMenu', args: [] })
        await client.waitFor(() => client.closed)
      })

      it('does not answer pairing or hello from a socket that is not in yet, only drops it', async () => {
        const { connect } = await setup({ now: () => 1_000_000 })
        const stranger = await connect()
        for (let i = 0; i < RATE_BURST + 5; i++) stranger.send({ t: 'hello', token: 'nope' })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(stranger.received.filter((m) => m.t === 'error' || m.t === 'result')).toEqual([])
      })
    })

    it('is dropped at once when revoked, and its token no longer works', async () => {
      const { server, pair, connect, store } = await setup()
      const { client, token } = await pair()
      store.rows.delete(hashToken(token))
      server.disconnectDevice(1)
      await client.message('denied')
      await client.waitFor(() => client.closed)
      const again = await connect()
      again.send({ t: 'hello', token })
      await again.message('denied')
    })
  })

  describe('lifecycle', () => {
    it('listens only after start and closes every socket on stop', async () => {
      const { server, pair } = await setup()
      expect(server.listening).toBe(true)
      const { client } = await pair()
      expect(server.connectionCount).toBe(1)
      await server.stop()
      expect(server.listening).toBe(false)
      await client.waitFor(() => client.closed)
      expect(server.connectionCount).toBe(0)
    })

    it('stops hearing the hub after stop', async () => {
      const { server, hub } = await setup()
      const spy = vi.spyOn(server as never, 'broadcast' as never)
      await server.stop()
      hub.publish('simTelemetry', {} as never)
      expect(spy).not.toHaveBeenCalled()
    })

    it('drops a socket that stops answering pings, and keeps one that answers', async () => {
      const { connect } = await setup({ heartbeatMs: 40 })
      const quiet = await connect()
      const answering = await connect()
      // ws answers pings by itself; make the first client unable to by stopping its automatic pong.
      ;(quiet.ws as unknown as { pong: () => void }).pong = () => undefined
      await quiet.waitFor(() => quiet.closed)
      expect(answering.closed).toBe(false)
    })

    it('sends a paired device a heartbeat each round, and nothing to one that has not paired', async () => {
      const { pair, connect } = await setup({ heartbeatMs: 30 })
      const stranger = await connect()
      const { client } = await pair()
      await client.waitFor(() => client.received.filter((m) => m.t === 'hb').length >= 2)
      expect(stranger.received.some((m) => m.t === 'hb')).toBe(false)
    })

    it('sends devices the flight again when its key changes, and not otherwise', async () => {
      let key = 'a'
      let shown: unknown = { flight: { flightId: 1 } }
      const { pair } = await setup({ heartbeatMs: 30, flightKey: () => key, flight: () => shown })
      const { client } = await pair()
      await client.message('snapshot')
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(client.received.some((m) => m.t === 'flight')).toBe(false)
      key = 'b'
      shown = { flight: { flightId: 2 } }
      await client.waitFor(() => client.received.some((m) => m.t === 'flight'))
      expect(client.received.find((m) => m.t === 'flight')).toEqual({ t: 'flight', flight: shown })
      const count = client.received.filter((m) => m.t === 'flight').length
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(client.received.filter((m) => m.t === 'flight')).toHaveLength(count)
    })

    it('tells the PC when the flight shown changed, so the route built from it can be built again', async () => {
      let key = 'a'
      let changed = 0
      const { pair } = await setup({
        heartbeatMs: 30,
        flightKey: () => key,
        onFlightChanged: () => (changed += 1)
      })
      await pair()
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(changed).toBe(0)
      key = 'b'
      await vi.waitFor(() => expect(changed).toBe(1))
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(changed).toBe(1)
    })

    it('gives a connecting device the planned route in its snapshot, and each new one as it is published', async () => {
      const { pair, hub } = await setup()
      const route = { flightId: 1, revision: 1, selection: {}, waypoints: [] }
      hub.publish('plannedRoute', route as never)
      const { client } = await pair()
      const snapshot = await client.message('snapshot')
      expect((snapshot.topics as Record<string, unknown>).plannedRoute).toEqual(route)
      hub.publish('plannedRoute', { ...route, revision: 2 } as never)
      await client.waitFor(() => client.received.some((m) => m.t === 'topic' && m.name === 'plannedRoute'))
      expect(client.received.find((m) => m.t === 'topic' && m.name === 'plannedRoute')).toMatchObject({
        payload: { revision: 2 }
      })
    })

    describe('the log (docs/plans/lan-sync.md, step 4)', () => {
      const logged = (level: 'info' | 'warn'): string[] =>
        vi.mocked(logger[level]).mock.calls.map((call) => String(call[0]))

      it('writes one line a round for the messages it refused as busy, with the device and the count', async () => {
        vi.mocked(logger.warn).mockClear()
        const { pair } = await setup({ now: () => 1_000_000, heartbeatMs: 40 })
        const { client } = await pair()
        for (let i = 0; i < RATE_BURST + 7; i++) client.send({ t: 'cmd', name: 'gsx.toggleMenu', args: [] })
        await vi.waitFor(() => expect(logged('warn').some((l) => l.includes('refused as busy'))).toBe(true))
        const line = logged('warn').find((l) => l.includes('refused as busy'))!
        expect(line).toMatch(/^\[lan\] device 1: \d+ messages refused as busy/)
        // A quiet round writes nothing more.
        const count = logged('warn').filter((l) => l.includes('refused as busy')).length
        await new Promise((resolve) => setTimeout(resolve, 120))
        expect(logged('warn').filter((l) => l.includes('refused as busy')).length).toBe(count)
      })

      it('writes a line when it closes a socket for ignoring the wait', async () => {
        vi.mocked(logger.warn).mockClear()
        const { pair } = await setup({ now: () => 1_000_000 })
        const { client } = await pair()
        for (let i = 0; i < RATE_BURST + ABUSE_FACTOR * RATE_PER_SECOND + 5; i++)
          client.send({ t: 'cmd', name: 'gsx.toggleMenu', args: [] })
        await client.waitFor(() => client.closed)
        expect(logged('warn').some((l) => l.includes('closed for sending far more'))).toBe(true)
      })

      it('writes the name of a lookup it refused, made safe, and never its arguments', async () => {
        vi.mocked(logger.warn).mockClear()
        const { pair } = await setup()
        const { client } = await pair()
        client.send({ t: 'query', id: 1, name: 'steal\nthe.token', args: ['secret-value'] })
        client.send({ t: 'query', id: 2, name: 'echo', args: [1, 2, 3, 4, 5, 6, 7] })
        await client.waitFor(() => client.received.filter((m) => m.t === 'result').length === 2)
        const lines = logged('warn').join('\n')
        expect(lines).toContain('lookup refused (unknown lookup "steal?the.token")')
        expect(lines).toContain('lookup refused (bad arguments "echo")')
        expect(lines).not.toContain('secret-value')
      })

      it('writes the name and the reason when a lookup fails, and how long a slow one took', async () => {
        vi.mocked(logger.warn).mockClear()
        vi.mocked(logger.info).mockClear()
        let t = 0
        const { pair } = await setup({ now: () => (t += 2500) })
        const { client } = await pair()
        client.send({ t: 'query', id: 1, name: 'broken' })
        client.send({ t: 'query', id: 2, name: 'later', args: ['x'] })
        await client.waitFor(() => client.received.filter((m) => m.t === 'result').length === 2)
        expect(logged('warn')).toContain('[lan] lookup "broken" failed: Error: no')
        expect(logged('info').some((l) => /^\[lan\] lookup "later" took \d+ ms$/.test(l))).toBe(true)
      })

      it('names the error when it has no message, so a failed sim fetch does not log as a blank', async () => {
        vi.mocked(logger.warn).mockClear()
        const { pair } = await setup()
        const { client } = await pair()
        client.send({ t: 'query', id: 1, name: 'noMessage' })
        await client.waitFor(() => client.received.some((m) => m.t === 'result'))
        expect(logged('warn')).toContain('[lan] lookup "noMessage" failed: AggregateError')
      })

      it('writes what a device reports, from the fixed list only, and the same one at most once a minute', async () => {
        vi.mocked(logger.warn).mockClear()
        let now = 1_000_000
        const { pair } = await setup({ now: () => now })
        const { client } = await pair()
        const report = (code: unknown): void => client.send({ t: 'report', code })
        report('selection-unconfirmed')
        report('selection-unconfirmed')
        report('query-failed:navdata.listSids')
        report('query-failed:not.a.lookup')
        report('anything I like \n [lan] fake line')
        report(42)
        await vi.waitFor(() => expect(logged('warn').filter((l) => l.includes('device 1')).length).toBe(3))
        const lines = logged('warn')
        expect(lines.filter((l) => l === '[lan] device 1 reports selection-unconfirmed')).toHaveLength(1)
        expect(lines).toContain('[lan] device 1 reports query-failed:navdata.listSids')
        // Anything else is one generic line, not the device's own words.
        expect(lines.filter((l) => l.includes('a report the PC does not know'))).toHaveLength(1)
        expect(lines.join('')).not.toContain('fake line')
        // A minute on, it is written again.
        now += 61_000
        report('selection-unconfirmed')
        await vi.waitFor(() =>
          expect(
            logged('warn').filter((l) => l === '[lan] device 1 reports selection-unconfirmed')
          ).toHaveLength(2)
        )
      })

      it('writes the detail a code takes, as one line, and none for a code that takes none', async () => {
        vi.mocked(logger.warn).mockClear()
        const { pair } = await setup()
        const { client } = await pair()
        const newline = String.fromCharCode(10)
        client.send({
          t: 'report',
          code: 'script-error',
          detail: 'Uncaught Error: boom' + newline + '[lan] fake line'
        })
        client.send({ t: 'report', code: 'route-applied', detail: 'r7' })
        client.send({ t: 'report', code: 'taxi-route-applied', detail: 'not a revision' })
        client.send({ t: 'report', code: 'selection-unconfirmed', detail: 'ignored' })
        client.send({ t: 'report', code: 'reconnected' })
        await vi.waitFor(() => expect(logged('warn').filter((l) => l.includes('device 1')).length).toBe(5))
        const lines = logged('warn')
        expect(lines).toContain('[lan] device 1 reports script-error: Uncaught Error: boom [lan] fake line')
        expect(lines).toContain('[lan] device 1 reports route-applied: r7')
        expect(lines).toContain('[lan] device 1 reports taxi-route-applied')
        expect(lines).toContain('[lan] device 1 reports selection-unconfirmed')
        expect(lines).toContain('[lan] device 1 reports reconnected')
        expect(lines.some((l) => l.includes(newline))).toBe(false)
      })

      it('writes a script error again only a minute later, however different its message', async () => {
        vi.mocked(logger.warn).mockClear()
        let now = 1_000_000
        const { pair } = await setup({ now: () => now })
        const { client } = await pair()
        client.send({ t: 'report', code: 'script-error', detail: 'first' })
        client.send({ t: 'report', code: 'script-error', detail: 'second' })
        await vi.waitFor(() =>
          expect(logged('warn').some((l) => l.includes('script-error: first'))).toBe(true)
        )
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(logged('warn').some((l) => l.includes('script-error: second'))).toBe(false)
        now += 61_000
        client.send({ t: 'report', code: 'script-error', detail: 'third' })
        await vi.waitFor(() =>
          expect(logged('warn').some((l) => l.includes('script-error: third'))).toBe(true)
        )
      })

      it('says which command failed and why, once a minute, and answers the device the same whatever went wrong', async () => {
        vi.mocked(logger.warn).mockClear()
        let now = 1_000_000
        const { pair } = await setup({ now: () => now })
        const { client } = await pair()
        client.send({ t: 'cmd', name: 'gsx.search', args: ['N32'] })
        client.send({ t: 'cmd', name: 'gsx.search', args: ['N33'] })
        client.send({ t: 'cmd', name: 'not.a.command', args: [] })
        await client.waitFor(() => client.received.filter((m) => m.t === 'error').length === 3)
        expect(client.received.filter((m) => m.t === 'error')).toEqual([
          { t: 'error', message: 'Not allowed' },
          { t: 'error', message: 'Not allowed' },
          { t: 'error', message: 'Not allowed' }
        ])
        const lines = logged('warn')
        expect(
          lines.filter((l) => l === '[lan] device 1 command "gsx.search" failed: Error: no such gate')
        ).toHaveLength(1)
        expect(lines).toContain('[lan] device 1 command "not.a.command" failed: Error: Unknown command')
        now += 61_000
        client.send({ t: 'cmd', name: 'gsx.search', args: ['N34'] })
        await vi.waitFor(() =>
          expect(
            logged('warn').filter(
              (l) => l === '[lan] device 1 command "gsx.search" failed: Error: no such gate'
            )
          ).toHaveLength(2)
        )
      })

      it('writes a command name it was sent only in a safe form', async () => {
        vi.mocked(logger.warn).mockClear()
        const { pair } = await setup()
        const { client } = await pair()
        client.send({ t: 'cmd', name: 'evil' + String.fromCharCode(10) + '[lan] fake', args: [] })
        await client.waitFor(() => client.received.some((m) => m.t === 'error'))
        expect(logged('warn').some((l) => l.includes(String.fromCharCode(10)))).toBe(false)
        expect(logged('warn').some((l) => l.includes('command "evil?'))).toBe(true)
      })

      it('ignores a report from a socket that is not paired', async () => {
        vi.mocked(logger.warn).mockClear()
        const { connect } = await setup()
        const stranger = await connect()
        stranger.send({ t: 'report', code: 'route-missing' })
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(logged('warn').some((l) => l.includes('reports'))).toBe(false)
      })
    })

    it('refuses to start twice, and reports a port already in use', async () => {
      const { server, port } = await setup()
      await expect(server.start(HOST, port)).rejects.toThrow('Already listening')
      const other = new LanServer({
        hub: new LiveHub(),
        commands: {},
        devices: deviceStore().devices,
        flight: () => null,
        queries: {},
        staticFile: () => null,
        now: () => 0
      })
      await expect(other.start(HOST, port)).rejects.toThrow(/EADDRINUSE/)
      expect(other.listening).toBe(false)
    })

    it('can stop without ever starting', async () => {
      const idle = new LanServer({
        hub: new LiveHub(),
        commands: {},
        devices: deviceStore().devices,
        flight: () => null,
        queries: {},
        staticFile: () => null,
        now: () => 0
      })
      await expect(idle.stop()).resolves.toBeUndefined()
    })
  })

  it('sends only the topics on the allowlist, which is every live topic the panels use', () => {
    expect([...LAN_TOPICS].sort()).toEqual(
      [
        'beyondAtcArrival',
        'beyondAtcState',
        'beyondAtcStatus',
        'beyondAtcStepClimb',
        'beyondAtcTranscript',
        'gsxRemoteCommandBar',
        'gsxRemoteGate',
        'gsxRemoteMenu',
        'gsxRemotePrompt',
        'gsxRemoteServices',
        'gsxRemoteStatus',
        'simConnectionStatus',
        'simTelemetry',
        'storageStatus',
        'trackingPoint',
        'trackingPointsUpdated',
        'procedureSelection',
        'plannedRoute',
        'taxiRoute',
        'networkTraffic',
        'trafficLayers'
      ].sort()
    )
  })
})
