import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import type { LinkSocket } from '@shared/lan-connection'
import { certificatePin, makeHostCertificate } from '../lan/host-certificate'
import { openHostSocket, type SocketPin, type SocketRefusal } from './ws-socket'

vi.mock('../logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))

/** A sim PC's TLS side on loopback, recording what reached it. */
interface TestHost {
  port: number
  /** The pin of the certificate it shows. */
  pin: string
  upgrades: number
  messages: string[]
}

describe('openHostSocket', () => {
  const servers: (HttpsServer | HttpServer)[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close()
      server.closeAllConnections()
    }
  })

  /** A TLS server with its own new certificate, serving WebSocket upgrades like the sim PC's. */
  async function tlsHost(): Promise<TestHost> {
    const { keyPem, certPem, certDer } = makeHostCertificate()
    const server = createHttpsServer({ key: keyPem, cert: certPem, minVersion: 'TLSv1.3' })
    const wss = new WebSocketServer({ noServer: true })
    const host: TestHost = { port: 0, pin: certificatePin(certDer), upgrades: 0, messages: [] }
    server.on('upgrade', (req, socket, head) => {
      host.upgrades += 1
      wss.handleUpgrade(req, socket, head, (ws) =>
        ws.on('message', (data) => host.messages.push(String(data)))
      )
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    host.port = (server.address() as AddressInfo).port
    return host
  }

  /** What the pin callbacks were told. */
  function listener(expected: string | null) {
    const told: { certificates: string[]; refusals: SocketRefusal[] } = { certificates: [], refusals: [] }
    const pin: SocketPin = {
      expected,
      onCertificate: (seen) => told.certificates.push(seen),
      onRefused: (reason) => told.refusals.push(reason)
    }
    return { pin, told }
  }

  /** Opens a socket, and says whether it opened (and sends a message when it did) before it closed. */
  function open(url: string, pin: SocketPin): Promise<{ socket: LinkSocket; opened: boolean }> {
    return new Promise((resolve) => {
      const socket = openHostSocket(url, pin)
      let opened = false
      socket.onopen = () => {
        opened = true
        socket.send('hello-token')
        setTimeout(() => socket.close(), 30)
      }
      socket.onclose = () => setTimeout(() => resolve({ socket, opened }), 30)
    })
  }

  it('opens to the certificate it was told to expect, and everything it sends reaches the host', async () => {
    const host = await tlsHost()
    const { pin, told } = listener(host.pin)
    const result = await open(`wss://127.0.0.1:${host.port}/live`, pin)
    expect(result.opened).toBe(true)
    expect(host.messages).toEqual(['hello-token'])
    expect(told).toEqual({ certificates: [], refusals: [] })
  })

  it('refuses another certificate before anything is sent: no upgrade, no message, and says the certificate changed', async () => {
    const host = await tlsHost()
    const other = await tlsHost()
    const { pin, told } = listener(other.pin)
    const result = await open(`wss://127.0.0.1:${host.port}/live`, pin)
    expect(result.opened).toBe(false)
    expect(told).toEqual({ certificates: [], refusals: ['certificate-changed'] })
    expect(host.upgrades).toBe(0)
    expect(host.messages).toEqual([])
  })

  it('accepts the certificate shown on a pairing from typed text, and reports its pin', async () => {
    const host = await tlsHost()
    const { pin, told } = listener(null)
    const result = await open(`wss://127.0.0.1:${host.port}/live`, pin)
    expect(result.opened).toBe(true)
    expect(told).toEqual({ certificates: [host.pin], refusals: [] })
  })

  it('never opens to a pin that cannot match, such as an empty one: a link with nothing to check against is closed', async () => {
    const host = await tlsHost()
    const { pin, told } = listener('')
    const result = await open(`wss://127.0.0.1:${host.port}/live`, pin)
    expect(result.opened).toBe(false)
    expect(told.refusals).toEqual(['certificate-changed'])
    expect(host.messages).toEqual([])
  })

  it('tells an older sim PC (plain HTTP on the port) from a network problem: not secure', async () => {
    const old = createHttpServer((_req, res) => res.end('page'))
    const wss = new WebSocketServer({ noServer: true })
    old.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, () => undefined))
    servers.push(old)
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve))
    const { pin, told } = listener('x'.repeat(43))
    const result = await open(`wss://127.0.0.1:${(old.address() as AddressInfo).port}/live`, pin)
    expect(result.opened).toBe(false)
    expect(told.refusals).toEqual(['not-secure'])
  })

  it('treats a closed port as ordinary offline: closed, and no refusal', async () => {
    const probe = createNetServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const { pin, told } = listener('x'.repeat(43))
    const result = await open(`wss://127.0.0.1:${port}/live`, pin)
    expect(result.opened).toBe(false)
    expect(told).toEqual({ certificates: [], refusals: [] })
  })

  it('does not open to a server that offers only TLS 1.2', async () => {
    const { keyPem, certPem, certDer } = makeHostCertificate()
    const server = createHttpsServer({ key: keyPem, cert: certPem, maxVersion: 'TLSv1.2' })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { pin } = listener(certificatePin(certDer))
    const result = await open(`wss://127.0.0.1:${(server.address() as AddressInfo).port}/live`, pin)
    expect(result.opened).toBe(false)
  })

  it('connects through the checked lookup: by address, and by a name that resolves to this computer', async () => {
    const host = await tlsHost()
    for (const name of ['127.0.0.1', 'localhost']) {
      const { pin } = listener(host.pin)
      const result = await open(`wss://${name}:${host.port}/live`, pin)
      expect(result.opened, name).toBe(true)
    }
  })

  it('never starts a connection to a public address typed as a number, however it is written (review of L8)', async () => {
    for (const url of [
      'wss://8.8.8.8:5051/live',
      'wss://0x08080808:5051/live',
      'wss://134744072:5051/live',
      'wss://[2001:4860:4860::8888]:5051/live',
      'wss://[::ffff:8.8.8.8]:5051/live'
    ]) {
      const { pin, told } = listener('x'.repeat(43))
      const socket = openHostSocket(url, pin)
      // Closed from the start: a socket that had begun connecting would still be CONNECTING (0) here.
      expect(socket.readyState, url).toBe(3)
      const closed = await new Promise<boolean>((resolve) => {
        socket.onopen = () => resolve(false)
        socket.onclose = () => resolve(true)
      })
      expect(closed, url).toBe(true)
      expect(told.refusals, url).toEqual([])
    }
  })

  it('starts a connection to a private address typed as a number', () => {
    const { pin } = listener('x'.repeat(43))
    const socket = openHostSocket('wss://192.168.250.250:5051/live', pin)
    expect(socket.readyState).toBe(0)
    socket.close()
  })
})
