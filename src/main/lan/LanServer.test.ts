import { createServer, request } from 'node:http'
import { type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { LiveHub } from '../live/LiveHub'
import { hashToken } from './pairing'
import { LAN_TOPICS, LanServer, MAX_MESSAGES_PER_SECOND, MAX_SOCKETS, type LanServerDeps } from './LanServer'

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
        'gsx.toggleMenu': (...args) => void ran.push({ name: 'gsx.toggleMenu', args })
      },
      devices: store.devices,
      flight: () => ({ route: ['WSSS', 'EGLL'] }),
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
        new Promise<{ status: number; body: string; type?: string }>((resolve, reject) => {
          const req = request({ host: HOST, port, path, method, headers: { host } }, (res) => {
            let body = ''
            res.on('data', (chunk) => (body += chunk))
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, body, type: res.headers['content-type'] })
            )
          })
          req.on('error', reject)
          req.end()
        })
      expect(await get('/')).toMatchObject({ status: 200, body: '<h1>WingLog</h1>', type: 'text/html' })
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
      const { connect, url } = await setup()
      for (let i = 0; i < MAX_SOCKETS; i++) open.push(await connect())
      const ninth = new TestClient(url, { host: new URL(url).host })
      await expect(ninth.opened()).rejects.toThrow(/503/)
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

    it('is limited to a set number of messages a second', async () => {
      const { pair, ran } = await setup({ now: () => 1_000_000 })
      const { client } = await pair()
      for (let i = 0; i < MAX_MESSAGES_PER_SECOND + 10; i++)
        client.send({ t: 'cmd', name: 'gsx.toggleMenu', args: [] })
      await new Promise((resolve) => setTimeout(resolve, 150))
      // The pair message used one of this second's slots.
      expect(ran.length).toBe(MAX_MESSAGES_PER_SECOND - 1)
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

    it('refuses to start twice, and reports a port already in use', async () => {
      const { server, port } = await setup()
      await expect(server.start(HOST, port)).rejects.toThrow('Already listening')
      const other = new LanServer({
        hub: new LiveHub(),
        commands: {},
        devices: deviceStore().devices,
        flight: () => null,
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
        'trackingPoint',
        'trackingPointsUpdated'
      ].sort()
    )
  })
})
