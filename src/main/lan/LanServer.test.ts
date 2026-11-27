import { createServer, request } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createConnection, type AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { logger } from '../logging/logger'
import { LiveHub } from '../live/LiveHub'
import { hashToken } from './pairing'
import { certificatePin, makeHostCertificate } from './host-certificate'
import type { HostIdentity } from './host-identity-store'
import {
  pageSecurityPolicy,
  LAN_TOPICS,
  LanServer,
  ABUSE_FACTOR,
  MAX_PENDING_FAST,
  MAX_PENDING_SLOW,
  RATE_BURST,
  RATE_PER_SECOND,
  MAX_SOCKETS,
  MAX_MESSAGE_BYTES,
  TWIN_MAX_MESSAGE_BYTES,
  MAX_UNAUTHENTICATED_PER_ADDRESS,
  type LanServerDeps
} from './LanServer'

vi.mock('../logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

const HOST = '127.0.0.1'

/** The sim PC's identity for these tests: made once, as the real store makes it. */
const IDENTITY: HostIdentity = (() => {
  const { keyPem, certPem, certDer } = makeHostCertificate()
  return { keyPem, certPem, pin: certificatePin(certDer), isNew: false }
})()

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
  const rows = new Map<string, { id: number; kind: 'screen' | 'twin' }>()
  const seen: number[] = []
  const revoked: number[] = []
  return {
    rows,
    seen,
    revoked,
    devices: {
      add: (_name: string, tokenHash: string, kind: 'screen' | 'twin' = 'screen') => {
        rows.set(tokenHash, { id: rows.size + 1, kind })
        return rows.size
      },
      // A revoked device is not found, as in the real table.
      find: (tokenHash: string) => {
        const row = rows.get(tokenHash)
        return row && !revoked.includes(row.id) ? row : null
      },
      touch: (id: number) => void seen.push(id),
      revoke: (id: number) => {
        if (revoked.includes(id)) return false
        revoked.push(id)
        return true
      },
      forget: () => undefined
    }
  }
}

/** A socket under test, remembering everything the server said to it. */
class TestClient {
  readonly received: Record<string, unknown>[] = []
  readonly ws: WebSocket
  closed = false
  /** The code the socket was closed with: 1009 is the socket's own size limit, 1005 is a plain `close()` with none. */
  closeCode: number | null = null

  constructor(url: string, headers: Record<string, string> = {}) {
    // Nothing is trusted here: the tests are about what the server does with a connection, and the twin's own certificate check has its
    // own tests (ws-socket.test.ts).
    this.ws = new WebSocket(url, { headers, rejectUnauthorized: false })
    this.ws.on('message', (data) => this.received.push(JSON.parse(data.toString())))
    this.ws.on('close', (code) => {
      this.closed = true
      this.closeCode = code
    })
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
      identity: () => Promise.resolve(IDENTITY),
      ...overrides
    }
    server = new LanServer(deps)
    const port = await freePort()
    await server.start(HOST, port)
    const url = `ws://${HOST}:${port}/live`
    const secureUrl = `wss://${HOST}:${port}/live`
    const connectTo = async (to: string, headers?: Record<string, string>) => {
      const client = new TestClient(to, { host: `${HOST}:${port}`, ...headers })
      open.push(client)
      await client.opened()
      return client
    }
    /** A socket in the clear, as a phone's page opens one. */
    const connect = (headers?: Record<string, string>) => connectTo(url, headers)
    /** A socket over TLS, as another WingLog opens one. */
    const connectTwin = (headers?: Record<string, string>) => connectTo(secureUrl, headers)
    /** Pairs a new socket with the code the PC shows; returns the socket and its token. */
    const pair = async () => {
      const { code } = server!.openPairing()
      const client = await connect()
      client.send({ t: 'pair', code, name: 'iPad' })
      const paired = await client.message('paired')
      return { client, token: paired.token as string }
    }
    return { server: server!, hub, store, ran, port, url, secureUrl, connect, connectTwin, pair }
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

  describe('the page security policy', () => {
    it('lets images come from the map host and the airline logo service, and fetches only from the map host and the server itself', () => {
      const policy = pageSecurityPolicy('192.168.1.5:47321')
      expect(policy).toContain(
        "img-src 'self' data: blob: https://tiles.openfreemap.org https://images.kiwi.com"
      )
      expect(policy).toContain("connect-src 'self' ws://192.168.1.5:47321 https://tiles.openfreemap.org")
      expect(policy.match(/connect-src[^;]*/)?.[0]).not.toContain('kiwi')
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

  describe('the size of one frame (docs/plans/security-audit-v2.md, L12)', () => {
    const OVER = MAX_MESSAGE_BYTES + 1024

    it('cuts off an unpaired socket in the clear that sends a frame over 16 KB, before anything in it is read', async () => {
      const { server, connect } = await setup()
      const { code } = server.openPairing()
      const client = await connect()
      client.send({ t: 'pair', code, name: 'x'.repeat(OVER) })
      await client.waitFor(() => client.closed)
      // The socket's own limit closed it (1009, message too big), so the frame was never buffered whole, let alone handled.
      expect(client.closeCode).toBe(1009)
      expect(client.received).toEqual([])
      expect(server.pairingOpen()).toBe(true)
    })

    it('cuts off a paired phone in the clear that sends a frame over 16 KB', async () => {
      const { pair } = await setup()
      const { client } = await pair()
      await client.message('snapshot')
      client.send({ t: 'query', id: 1, name: 'echo', args: ['x'.repeat(OVER)] })
      await client.waitFor(() => client.closed)
      expect(client.closeCode).toBe(1009)
      expect(client.received.some((m) => m.t === 'result')).toBe(false)
    })

    it('still closes a phone that sends over 16 KB over TLS, where the larger limit applies', async () => {
      const { connectTwin } = await setup()
      const client = await connectTwin()
      client.send('x'.repeat(OVER))
      await client.waitFor(() => client.closed)
      expect(client.closeCode).toBe(1005)
    })

    it('accepts a frame of 3 MB from a paired twin over wss://', async () => {
      const { server, connectTwin } = await setup()
      const twin = await connectTwin()
      twin.send({ t: 'pair', code: server.openPairing('twin').code, name: 'Mac', kind: 'twin' })
      await twin.message('paired')
      const big = 'x'.repeat(3 * 1024 * 1024)
      twin.send({ t: 'query', id: 7, name: 'echo', args: [big] })
      const result = await twin.message('result')
      expect(result.data).toEqual([big])
      expect(twin.closed).toBe(false)
    })

    it('still buffers up to 4 MB from an unpaired socket over TLS before refusing it (accepted in L12), and no more', async () => {
      const { connectTwin } = await setup()
      const under = await connectTwin()
      under.send('x'.repeat(TWIN_MAX_MESSAGE_BYTES - 16))
      await under.waitFor(() => under.closed)
      // Taken whole and then refused by the size check (a plain close), not cut off by the socket's own limit.
      expect(under.closeCode).toBe(1005)
      const over = await connectTwin()
      over.send('x'.repeat(TWIN_MAX_MESSAGE_BYTES + 1))
      await over.waitFor(() => over.closed)
      expect(over.closeCode).toBe(1009)
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
      expect(server.pairingOpen()).toBe(false)
      const { code } = server.openPairing()
      expect(server.pairingOpen()).toBe(true)
      const client = await connect()
      client.send({ t: 'pair', code })
      await client.message('paired')
      expect(server.pairingOpen()).toBe(false)
    })

    describe('a twin and a second screen pair separately', () => {
      it('takes a twin only with the twin code, and records its kind', async () => {
        const store = deviceStore()
        const { server, connect, connectTwin } = await setup({ devices: store.devices })
        const screen = server.openPairing('screen')
        const twin = server.openPairing('twin')
        expect(screen.code).not.toBe(twin.code)
        expect(server.pairingOpen('screen')).toBe(true)
        expect(server.pairingOpen('twin')).toBe(true)
        // The second screen's code is no good for a device that says it is a twin.
        const wrong = await connectTwin()
        wrong.send({ t: 'pair', code: screen.code, name: 'Mac', kind: 'twin' })
        await wrong.message('denied')
        const right = await connectTwin()
        right.send({ t: 'pair', code: twin.code, name: 'WingLog on MAC', kind: 'twin' })
        await right.message('paired')
        expect([...store.rows.values()].map((row) => row.kind)).toEqual(['twin'])
        // The twin's window is spent; the second screen's is still open for a phone.
        expect(server.pairingOpen('twin')).toBe(false)
        expect(server.pairingOpen('screen')).toBe(true)
        const phone = await connect()
        phone.send({ t: 'pair', code: screen.code, name: 'iPad' })
        await phone.message('paired')
        expect([...store.rows.values()].map((row) => row.kind)).toEqual(['twin', 'screen'])
      })

      it('refuses to pair a kind whose switch is off, and refuses its token when the switch is turned off later', async () => {
        const store = deviceStore()
        let kinds = { screen: true, twin: true }
        const { server, connectTwin } = await setup({ devices: store.devices, enabledKinds: () => kinds })
        const twin = server.openPairing('twin')
        kinds = { screen: true, twin: false }
        const refused = await connectTwin()
        refused.send({ t: 'pair', code: twin.code, name: 'Mac', kind: 'twin' })
        await refused.message('denied')
        expect(store.rows.size).toBe(0)

        kinds = { screen: true, twin: true }
        const paired = await connectTwin()
        const again = server.openPairing('twin')
        paired.send({ t: 'pair', code: again.code, name: 'Mac', kind: 'twin' })
        const { token } = await paired.message('paired')
        kinds = { screen: true, twin: false }
        const later = await connectTwin()
        later.send({ t: 'hello', token })
        await later.waitFor(() => later.closed)
        // The token is known, so it is not told it was revoked: it keeps the token and tries again.
        expect(later.received).toEqual([])
        kinds = { screen: true, twin: true }
        const back = await connectTwin()
        back.send({ t: 'hello', token })
        await back.message('snapshot')
      })

      it('drops the open connections of a kind when asked', async () => {
        const store = deviceStore()
        const { server, connectTwin } = await setup({ devices: store.devices })
        const twin = server.openPairing('twin')
        const device = await connectTwin()
        device.send({ t: 'pair', code: twin.code, name: 'Mac', kind: 'twin' })
        await device.message('paired')
        server.disconnectKind('screen')
        expect(device.closed).toBe(false)
        server.disconnectKind('twin')
        await device.waitFor(() => device.closed)
        // Closed without a message: 'denied' would make the device forget its token.
        expect(device.received.map((m) => m.t)).toEqual(['paired', 'snapshot'])
      })

      it('says denied to an unknown token even while its kind is switched off, so a stranger learns nothing', async () => {
        const store = deviceStore()
        const { connect } = await setup({
          devices: store.devices,
          enabledKinds: () => ({ screen: false, twin: false })
        })
        const stranger = await connect()
        stranger.send({ t: 'hello', token: 'not-a-token' })
        await stranger.message('denied')
      })
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
        devices: {
          ...store.devices,
          add: (name, hash, kind) => (names.push(name), store.devices.add(name, hash, kind))
        }
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

    it('tells a twin, once for a burst of changes, that the PC’s database changed, and tells a second screen nothing', async () => {
      const { server, connect, connectTwin } = await setup()
      const twin = await connectTwin()
      twin.send({ t: 'pair', code: server.openPairing('twin').code, name: 'Mac', kind: 'twin' })
      await twin.message('paired')
      const screen = await connect()
      screen.send({ t: 'pair', code: server.openPairing('screen').code, name: 'Phone' })
      await screen.message('paired')

      server.notifyTwins()
      server.notifyTwins()
      server.notifyTwins()
      await twin.message('sync')
      await new Promise((resolve) => setTimeout(resolve, 1200))

      expect(twin.received.filter((m) => m.t === 'sync')).toHaveLength(1)
      expect(screen.received.filter((m) => m.t === 'sync')).toHaveLength(0)
    })

    describe('a lookup that needs to know which device is asking', () => {
      /** A server with one such lookup, and the calls it was given. */
      async function withDeviceLookup() {
        const calls: unknown[][] = []
        const made = await setup({
          deviceQueries: {
            'sync.pull': (deviceId, ...args) => {
              calls.push([deviceId, ...args])
              return 'a page'
            }
          }
        })
        return { ...made, calls }
      }

      it('gives a twin its own device id first, and a plain lookup nothing extra', async () => {
        const { server, connectTwin, calls } = await withDeviceLookup()
        const device = await connectTwin()
        device.send({ t: 'pair', code: server.openPairing('twin').code, name: 'Mac', kind: 'twin' })
        await device.message('paired')
        device.send({ t: 'query', id: 1, name: 'sync.pull', args: ['aircraft', null] })
        device.send({ t: 'query', id: 2, name: 'echo', args: ['aircraft', null] })
        await device.waitFor(() => device.received.filter((m) => m.t === 'result').length === 2)

        expect(calls).toEqual([[expect.any(Number), 'aircraft', null]])
        const results = device.received.filter((m) => m.t === 'result')
        expect(results).toContainEqual({ t: 'result', id: 1, data: 'a page' })
        expect(results).toContainEqual({ t: 'result', id: 2, data: ['aircraft', null] })
      })

      it('does not exist for a second screen, which is refused it as for any lookup it may not ask', async () => {
        const { pair, calls } = await withDeviceLookup()
        const { client } = await pair()
        client.send({ t: 'query', id: 1, name: 'sync.pull', args: ['aircraft', null] })
        await client.waitFor(() => client.received.some((m) => m.t === 'result'))
        expect(client.received.find((m) => m.t === 'result')).toEqual({ t: 'result', id: 1, error: true })
        expect(calls).toEqual([])
      })
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

    it("runs a twin's own version of a command where there is one, and a phone's the shared one", async () => {
      const calls: string[] = []
      const { server, pair, connectTwin } = await setup({
        commands: { 'track.setProcedureSelection': () => void calls.push('shared') },
        twinCommands: { 'track.setProcedureSelection': () => void calls.push('twin') }
      })
      const { client: phone } = await pair()
      phone.send({ t: 'cmd', name: 'track.setProcedureSelection', args: [{}] })
      await phone.waitFor(() => calls.length === 1)
      const twin = await connectTwin()
      twin.send({ t: 'pair', code: server.openPairing('twin').code, name: 'Mac', kind: 'twin' })
      await twin.message('paired')
      twin.send({ t: 'cmd', name: 'track.setProcedureSelection', args: [{}] })
      await twin.waitFor(() => calls.length === 2)
      expect(calls).toEqual(['shared', 'twin'])
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
      await vi.waitFor(() => expect(server.connectedDeviceIds.has(1)).toBe(false))
      const again = await connect()
      again.send({ t: 'hello', token })
      await again.message('denied')
    })
  })

  describe('two sides of one port (a phone in the clear, a twin over TLS)', () => {
    const warnings = (): string[] => vi.mocked(logger.warn).mock.calls.map((call) => String(call[0]))

    /** A plain HTTP or HTTPS request to the port, answering its status. */
    function get(port: number, secure: boolean): Promise<number> {
      return new Promise((resolve, reject) => {
        const make = secure ? httpsRequest : request
        const req = make(
          { host: HOST, port, path: '/', headers: { host: `${HOST}:${port}` }, rejectUnauthorized: false },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          }
        )
        req.on('error', reject)
        req.end()
      })
    }

    it('serves the page over HTTP, a phone over ws:// and a twin over wss://, all on the one port', async () => {
      const { server, port, pair, connectTwin } = await setup()
      expect(await get(port, false)).toBe(200)
      const { client } = await pair()
      await client.message('snapshot')
      const twin = await connectTwin()
      twin.send({ t: 'pair', code: server.openPairing('twin').code, name: 'Mac', kind: 'twin' })
      await twin.message('paired')
      await twin.message('snapshot')
      expect(server.connectionCount).toBe(2)
    })

    it('lets a twin say hello with its token over wss://', async () => {
      const { server, connectTwin } = await setup()
      const first = await connectTwin()
      first.send({ t: 'pair', code: server.openPairing('twin').code, name: 'Mac', kind: 'twin' })
      const { token } = await first.message('paired')
      const again = await connectTwin()
      again.send({ t: 'hello', token })
      await again.message('snapshot')
    })

    it('answers every plain request over TLS with 404: only twin sockets are served there', async () => {
      const { port } = await setup()
      expect(await get(port, true)).toBe(404)
    })

    it('shows the certificate it was given, and its pin through certificatePin', async () => {
      const { server, port } = await setup()
      expect(server.certificatePin).toBe(IDENTITY.pin)
      const shown = await new Promise<string>((resolve, reject) => {
        const req = httpsRequest({ host: HOST, port, path: '/', rejectUnauthorized: false }, (res) => {
          res.resume()
          resolve(certificatePin((res.socket as TLSSocket).getPeerCertificate().raw))
        })
        req.on('error', reject)
        req.end()
      })
      expect(shown).toBe(IDENTITY.pin)
      await server.stop()
      expect(server.certificatePin).toBeNull()
    })

    it('refuses a connection that offers only TLS 1.2 or older', async () => {
      const { secureUrl, port } = await setup()
      const old = new WebSocket(secureUrl, {
        headers: { host: `${HOST}:${port}` },
        rejectUnauthorized: false,
        maxVersion: 'TLSv1.2'
      })
      old.on('error', () => undefined)
      const opened = await new Promise<boolean>((resolve) => {
        old.once('open', () => resolve(true))
        old.once('close', () => resolve(false))
      })
      expect(opened).toBe(false)
    })

    it('denies a twin that pairs over ws:// without spending the code, and says why in the log', async () => {
      vi.mocked(logger.warn).mockClear()
      const store = deviceStore()
      const { server, connect, connectTwin } = await setup({ devices: store.devices })
      const { code } = server.openPairing('twin')
      const plain = await connect()
      plain.send({ t: 'pair', code, name: 'Mac', kind: 'twin' })
      await plain.message('denied')
      await plain.waitFor(() => plain.closed)
      expect(plain.received.map((m) => m.t)).toEqual(['denied'])
      expect(store.rows.size).toBe(0)
      expect(warnings().some((line) => line.includes('without encryption'))).toBe(true)
      // The code was neither used nor counted as a wrong guess: it still works over TLS.
      expect(server.pairingOpen('twin')).toBe(true)
      const secure = await connectTwin()
      secure.send({ t: 'pair', code, name: 'Mac', kind: 'twin' })
      await secure.message('paired')
    })

    it('revokes a twin token presented over ws://: it was sent in the clear, so it fails over wss:// too, and is logged once without the token', async () => {
      vi.mocked(logger.warn).mockClear()
      const store = deviceStore()
      const { server, connect, connectTwin } = await setup({ devices: store.devices })
      const secure = await connectTwin()
      secure.send({ t: 'pair', code: server.openPairing('twin').code, name: 'Mac', kind: 'twin' })
      const { token } = await secure.message('paired')
      await secure.message('snapshot')
      const plain = await connect()
      plain.send({ t: 'hello', token })
      await plain.message('denied')
      expect(plain.received.some((m) => m.t === 'snapshot')).toBe(false)
      expect(store.revoked).toEqual([1])
      // Its open TLS socket is told it is denied and dropped.
      await secure.message('denied')
      await secure.waitFor(() => secure.closed)
      // The token no longer works anywhere, and asking again does not log again.
      for (const open of [connectTwin, connect]) {
        const again = await open()
        again.send({ t: 'hello', token })
        await again.message('denied')
        expect(again.received.some((m) => m.t === 'snapshot')).toBe(false)
      }
      const logged = warnings().filter((line) => line.includes('without encryption'))
      expect(logged).toHaveLength(1)
      expect(logged[0]).not.toContain(token)
    })

    it('does not revoke a phone for a token presented over wss://, nor a twin for one over wss://', async () => {
      const store = deviceStore()
      const { server, pair, connectTwin } = await setup({ devices: store.devices })
      const { token } = await pair()
      const wrongSide = await connectTwin()
      wrongSide.send({ t: 'hello', token })
      await wrongSide.message('denied')
      const twin = await connectTwin()
      twin.send({ t: 'pair', code: server.openPairing('twin').code, name: 'Mac', kind: 'twin' })
      const paired = await twin.message('paired')
      const again = await connectTwin()
      again.send({ t: 'hello', token: paired.token })
      await again.message('snapshot')
      expect(store.revoked).toEqual([])
    })

    it('denies a phone that pairs or says hello over wss://', async () => {
      const store = deviceStore()
      const { server, pair, connectTwin } = await setup({ devices: store.devices })
      const { code } = server.openPairing('screen')
      const secure = await connectTwin()
      secure.send({ t: 'pair', code, name: 'iPad' })
      await secure.message('denied')
      expect(store.rows.size).toBe(0)
      expect(server.pairingOpen('screen')).toBe(true)
      const { token } = await pair()
      const again = await connectTwin()
      again.send({ t: 'hello', token })
      await again.message('denied')
      expect(again.received.some((m) => m.t === 'snapshot')).toBe(false)
    })

    it('closes a socket that sends nothing at all, and one that starts a TLS handshake and stops', async () => {
      const { port } = await setup({ authTimeoutMs: 40 })
      const silent = createConnection({ host: HOST, port })
      const halfway = createConnection({ host: HOST, port })
      for (const socket of [silent, halfway]) socket.on('error', () => undefined)
      halfway.write(Buffer.from([0x16, 0x03, 0x01]))
      await Promise.all(
        [silent, halfway].map(
          (socket) => new Promise<void>((resolve) => socket.once('close', () => resolve()))
        )
      )
    })

    it('logs a failed handshake, but not more than once a minute', async () => {
      vi.mocked(logger.warn).mockClear()
      // A handshake that never completes ends at the handshake timeout, which is the same time as a silent socket's.
      const { port } = await setup({ authTimeoutMs: 40 })
      for (let i = 0; i < 3; i++) {
        const junk = createConnection({ host: HOST, port })
        junk.on('error', () => undefined)
        junk.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05]))
        await new Promise<void>((resolve) => junk.once('close', () => resolve()))
      }
      expect(warnings().filter((line) => line.includes('TLS handshake'))).toHaveLength(1)
    })

    it('leaves no socket open when it stops, whatever it was doing', async () => {
      const { server, port, pair, connectTwin } = await setup()
      await pair()
      const twin = await connectTwin()
      twin.send({ t: 'pair', code: server.openPairing('twin').code, name: 'Mac', kind: 'twin' })
      await twin.message('paired')
      const waiting = createConnection({ host: HOST, port })
      const halfway = createConnection({ host: HOST, port })
      for (const socket of [waiting, halfway]) socket.on('error', () => undefined)
      halfway.write(Buffer.from([0x16, 0x03, 0x01]))
      await new Promise((resolve) => setTimeout(resolve, 30))
      const closes = [waiting, halfway].map(
        (socket) => new Promise<void>((resolve) => socket.once('close', () => resolve()))
      )
      await server.stop()
      await Promise.all(closes)
      await twin.waitFor(() => twin.closed)
      expect(server.connectionCount).toBe(0)
    })

    describe('without an identity (this computer cannot keep a key safely, or it could not be loaded)', () => {
      for (const [label, identity] of [
        ['none', () => Promise.resolve(null)],
        ['one that fails to load', () => Promise.reject(new Error('disk says no'))]
      ] as const) {
        it(`still serves phones and refuses twins: ${label}`, async () => {
          vi.mocked(logger.warn).mockClear()
          const { server, port, pair, connectTwin } = await setup({ identity })
          expect(server.certificatePin).toBeNull()
          expect(await get(port, false)).toBe(200)
          const { client } = await pair()
          await client.message('snapshot')
          server.openPairing('twin')
          await expect(connectTwin()).rejects.toThrow()
          if (label !== 'none') expect(warnings().some((line) => line.includes('identity'))).toBe(true)
          expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('PRIVATE')
        })
      }

      it('still serves phones and refuses twins when the TLS server cannot be made from the identity (a key that will not load)', async () => {
        vi.mocked(logger.warn).mockClear()
        const broken: HostIdentity = {
          keyPem: 'not a key',
          certPem: 'not a certificate',
          pin: 'p',
          isNew: false
        }
        const { server, port, pair, connectTwin } = await setup({ identity: () => Promise.resolve(broken) })
        expect(server.listening).toBe(true)
        expect(server.certificatePin).toBeNull()
        expect(await get(port, false)).toBe(200)
        const { client } = await pair()
        await client.message('snapshot')
        await expect(connectTwin()).rejects.toThrow()
        expect(warnings().some((line) => line.includes('could not start the TLS server'))).toBe(true)
        expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('not a key')
      })

      it('starts a server with no identity dependency at all, as before', async () => {
        const { server } = await setup({ identity: undefined })
        expect(server.listening).toBe(true)
        expect(server.certificatePin).toBeNull()
      })
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

    it('lists a paired device as connected while its socket is open, and not a socket still pairing', async () => {
      const { server, pair, connect } = await setup()
      const stranger = await connect()
      expect(server.connectedDeviceIds.size).toBe(0)
      const { client } = await pair()
      expect([...server.connectedDeviceIds]).toEqual([1])
      client.ws.close()
      await client.waitFor(() => client.closed)
      await vi.waitFor(() => expect(server.connectedDeviceIds.size).toBe(0))
      stranger.ws.close()
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

    it('checks the flight when a tracked point brings a new phase, not at every point, so a touchdown reaches a device before the next heartbeat', async () => {
      let key = 'a'
      let shown: unknown = { flight: { flightId: 7, actualOnUtc: null } }
      const { pair, hub } = await setup({ flightKey: () => key, flight: () => shown })
      const { client } = await pair()
      await client.message('snapshot')
      const flights = (): number => client.received.filter((m) => m.t === 'flight').length
      hub.publish('trackingPoint', { id: 1, flightId: 7, phase: 'descent' } as never)
      // The flight row changes (a touchdown), but a point of the same phase does not look at it.
      key = 'b'
      shown = { flight: { flightId: 7, actualOnUtc: '2026-01-01T01:00:00.000Z' } }
      hub.publish('trackingPoint', { id: 2, flightId: 7, phase: 'descent' } as never)
      await client.waitFor(() => client.received.filter((m) => m.t === 'topic').length === 2)
      expect(client.received.some((m) => m.t === 'flight' && m.flight === shown)).toBe(false)
      hub.publish('trackingPoint', { id: 3, flightId: 7, phase: 'landing' } as never)
      await client.waitFor(() => client.received.filter((m) => m.t === 'topic').length === 3)
      const sent = client.received.filter((m) => m.t === 'flight')
      expect(sent.at(-1)).toEqual({ t: 'flight', flight: shown })
      // The flight goes ahead of the point that brought the phase, and only once for it.
      expect(client.received.at(-1)).toMatchObject({ t: 'topic', payload: { id: 3 } })
      const count = flights()
      hub.publish('trackingPoint', { id: 4, flightId: 7, phase: 'landing' } as never)
      await client.waitFor(() => client.received.filter((m) => m.t === 'topic').length === 4)
      expect(flights()).toBe(count)
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
      // A heartbeat before the device paired learns the first key and reports it, which is why this counts from here.
      const settled = changed
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(changed).toBe(settled)
      key = 'b'
      await vi.waitFor(() => expect(changed).toBe(settled + 1))
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(changed).toBe(settled + 1)
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
        'gsxRoutine',
        'simConnectionStatus',
        'simTelemetry',
        'simTraffic',
        'storageStatus',
        'trackingPoint',
        'trackingPointsUpdated',
        'procedureSelection',
        'plannedRoute',
        'taxiRoute',
        'networkTraffic',
        'trafficLayers',
        'onlineStatus',
        'networkControllers',
        'networkAtc'
      ].sort()
    )
  })
})
