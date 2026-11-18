import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { LanSettings } from '@shared/ipc'
import type { LanDeviceKind } from '@shared/types/lan'
import { LanConnection, type LanLinkState, type LinkSocket } from '@shared/lan-connection'
import { LiveHub } from '../live/LiveHub'
import { LanController } from './LanController'
import { LanServer } from './LanServer'
import { hashToken } from './pairing'
import { certificatePin, makeHostCertificate } from './host-certificate'

vi.mock('../logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

/**
 * The real controller, the real server and the real client-side link, wired together over loopback: what a phone's page or a twin
 * shows when the pilot switches its kind of device off (e2e/second-screen-resilience.spec.ts, "says it cannot reach the PC ...").
 * A switch is not a revocation: the device keeps its token and links again by itself when the switch is back on.
 */

const HOST = '127.0.0.1'
/** The sim PC's identity: twins connect over TLS with it. */
const IDENTITY = (() => {
  const { keyPem, certPem, certDer } = makeHostCertificate()
  return { keyPem, certPem, pin: certificatePin(certDer), isNew: false }
})()
const LINK_TIMEOUT_MS = 3000
const RECONNECT_TIMEOUT_MS = 15_000
/** Long enough for the device's first retry (1 s) to reach a server that is still up. */
const RETRY_SETTLE_MS = 1500

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, HOST, resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

describe('a device linked to the PC when its switch is turned off', () => {
  let controller: LanController | null = null
  const links: LanConnection[] = []

  afterEach(async () => {
    for (const link of links.splice(0)) link.stop()
    await controller?.stop()
  })

  /** A controller and server on a free port, with both switches as given. */
  async function rig(initial: { enabled: boolean; twinEnabled: boolean }) {
    const port = await freePort()
    let settings: LanSettings = { ...initial, port }
    const rows = new Map<string, { id: number; kind: LanDeviceKind }>()
    const server = new LanServer({
      hub: new LiveHub(),
      commands: {},
      devices: {
        add: (_name, tokenHash, kind) => {
          rows.set(tokenHash, { id: rows.size + 1, kind })
          return rows.size
        },
        find: (tokenHash) => rows.get(tokenHash) ?? null,
        touch: () => undefined,
        revoke: () => false,
        forget: () => undefined
      },
      enabledKinds: () => ({ screen: settings.enabled, twin: settings.twinEnabled }),
      flight: () => null,
      queries: {},
      staticFile: () => null,
      identity: () => Promise.resolve(IDENTITY),
      now: () => Date.now()
    })
    const lan = new LanController({
      server,
      settings: { get: () => settings, set: (s) => (settings = s) },
      addresses: () => [{ adapter: 'lo', address: HOST, kind: 'physical' }],
      routeAddress: () => Promise.resolve(HOST),
      devices: { list: () => [], revoke: () => false, forget: () => undefined },
      now: () => Date.now()
    })
    controller = lan
    await lan.sync()
    return { port, rows, lan }
  }

  /** Pairs a new client of the given kind and waits until it is linked. */
  async function linkedDevice(harness: Awaited<ReturnType<typeof rig>>, kind: LanDeviceKind) {
    const status = harness.lan.startPairing(kind)
    const code = (kind === 'twin' ? status.twinPairing : status.pairing)?.code ?? ''
    expect(code).toHaveLength(6)
    let token: string | null = null
    const states: LanLinkState[] = []
    const link = new LanConnection(
      `${kind === 'twin' ? 'wss' : 'ws'}://${HOST}:${harness.port}/live`,
      { get: () => token, set: (t) => (token = t), clear: () => (token = null) },
      // A twin connects over TLS; this test is about the switches, not the certificate (ws-socket.test.ts checks that).
      (url) => new WebSocket(url, { rejectUnauthorized: false }) as unknown as LinkSocket,
      kind === 'twin' ? 'Mac' : 'Phone'
    )
    links.push(link)
    link.onState((s) => states.push(s))
    link.start()
    link.pair(code, kind === 'twin' ? 'twin' : undefined)
    await vi.waitFor(() => expect(link.state).toBe('connected'), { timeout: LINK_TIMEOUT_MS, interval: 10 })
    expect(token).not.toBeNull()
    expect([...harness.rows.keys()]).toContain(hashToken(token!))
    states.length = 0
    return { link, states, token: () => token }
  }

  it('says the PC cannot be reached, keeps its token, and links again when the second screen is switched back on', async () => {
    const harness = await rig({ enabled: true, twinEnabled: false })
    const phone = await linkedDevice(harness, 'screen')

    // The twin switch is off too, so the server stops.
    await harness.lan.applySettings({ enabled: false, port: harness.port })
    await vi.waitFor(() => expect(phone.link.state).not.toBe('connected'), {
      timeout: LINK_TIMEOUT_MS,
      interval: 10
    })

    expect(phone.states).not.toContain('needs-pairing')
    expect(phone.link.state).toBe('offline')
    expect(phone.token()).not.toBeNull()

    await harness.lan.applySettings({ enabled: true, port: harness.port })
    await vi.waitFor(() => expect(phone.link.state).toBe('connected'), {
      timeout: RECONNECT_TIMEOUT_MS,
      interval: 50
    })
  }, 25_000)

  it('does the same when the server stays up for a twin: the phone is closed on, not denied', async () => {
    const harness = await rig({ enabled: true, twinEnabled: true })
    const phone = await linkedDevice(harness, 'screen')

    await harness.lan.applySettings({ enabled: false, port: harness.port })
    await vi.waitFor(() => expect(phone.link.state).not.toBe('connected'), {
      timeout: LINK_TIMEOUT_MS,
      interval: 10
    })
    await new Promise((resolve) => setTimeout(resolve, RETRY_SETTLE_MS))

    expect(phone.states).not.toContain('needs-pairing')
    expect(phone.link.state).toBe('offline')
    expect(phone.token()).not.toBeNull()

    await harness.lan.applySettings({ enabled: true, port: harness.port })
    await vi.waitFor(() => expect(phone.link.state).toBe('connected'), {
      timeout: RECONNECT_TIMEOUT_MS,
      interval: 50
    })
  }, 25_000)

  it('keeps a twin paired and offline when Other WingLogs is switched off, and links it again when it is back on', async () => {
    const harness = await rig({ enabled: false, twinEnabled: true })
    const twin = await linkedDevice(harness, 'twin')

    await harness.lan.applySettings({ twinEnabled: false, port: harness.port })
    await vi.waitFor(() => expect(twin.link.state).not.toBe('connected'), {
      timeout: LINK_TIMEOUT_MS,
      interval: 10
    })

    expect(twin.states).not.toContain('needs-pairing')
    expect(twin.link.state).toBe('offline')
    expect(twin.token()).not.toBeNull()

    await harness.lan.applySettings({ twinEnabled: true, port: harness.port })
    await vi.waitFor(() => expect(twin.link.state).toBe('connected'), {
      timeout: RECONNECT_TIMEOUT_MS,
      interval: 50
    })
  }, 25_000)

  it('keeps a twin offline, not unpaired, when its switch is off but a phone keeps the server up', async () => {
    const harness = await rig({ enabled: true, twinEnabled: true })
    const twin = await linkedDevice(harness, 'twin')

    await harness.lan.applySettings({ twinEnabled: false, port: harness.port })
    await vi.waitFor(() => expect(twin.link.state).not.toBe('connected'), {
      timeout: LINK_TIMEOUT_MS,
      interval: 10
    })
    await new Promise((resolve) => setTimeout(resolve, RETRY_SETTLE_MS))

    expect(twin.states).not.toContain('needs-pairing')
    expect(twin.link.state).toBe('offline')
    expect(twin.token()).not.toBeNull()

    await harness.lan.applySettings({ twinEnabled: true, port: harness.port })
    await vi.waitFor(() => expect(twin.link.state).toBe('connected'), {
      timeout: RECONNECT_TIMEOUT_MS,
      interval: 50
    })
  }, 25_000)

  it('still tells a device whose token the PC does not know that it was refused', async () => {
    const harness = await rig({ enabled: true, twinEnabled: false })
    let token: string | null = 'a-token-the-pc-never-issued'
    const stranger = new LanConnection(
      `ws://${HOST}:${harness.port}/live`,
      { get: () => token, set: (t) => (token = t), clear: () => (token = null) },
      (url) => new WebSocket(url) as unknown as LinkSocket,
      'Phone'
    )
    links.push(stranger)
    stranger.start()
    await vi.waitFor(() => expect(stranger.state).toBe('needs-pairing'), {
      timeout: LINK_TIMEOUT_MS,
      interval: 10
    })
    expect(token).toBeNull()
  })
})
