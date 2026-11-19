import { EventEmitter } from 'node:events'
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { LanListener } from './lan-listener'

const HOST = '127.0.0.1'

/** A stand-in for a server that is handed connections: it keeps what each one sends. */
class Target extends EventEmitter {
  readonly sockets: Socket[] = []
  readonly received: Buffer[] = []

  constructor() {
    super()
    this.on('connection', (socket: Socket) => {
      this.sockets.push(socket)
      socket.on('data', (chunk: Buffer) => this.received.push(chunk))
      socket.on('error', () => undefined)
    })
  }

  text(): string {
    return Buffer.concat(this.received).toString('latin1')
  }
}

describe('LanListener', () => {
  let listener: LanListener | null = null
  const clients: Socket[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy()
    await listener?.close()
    listener = null
  })

  async function start(secure: Target | null, waitMs = 5000) {
    const plain = new Target()
    listener = new LanListener({ plain, secure }, waitMs)
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, HOST, resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    await listener.listen(HOST, port)
    const connect = async (): Promise<Socket> => {
      const socket = createConnection({ host: HOST, port })
      socket.on('error', () => undefined)
      clients.push(socket)
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
      return socket
    }
    return { plain, connect, port }
  }

  it('hands a connection that starts like HTTP to the plain server, with every byte it sent', async () => {
    const secure = new Target()
    const { plain, connect } = await start(secure)
    const socket = await connect()
    socket.write('GET / HTTP/1.1\r\n\r\n')
    await expect.poll(() => plain.text()).toBe('GET / HTTP/1.1\r\n\r\n')
    expect(secure.sockets).toHaveLength(0)
  })

  it('hands a connection that starts a TLS handshake to the TLS server, with every byte it sent', async () => {
    const secure = new Target()
    const { plain, connect } = await start(secure)
    const socket = await connect()
    socket.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05]))
    socket.write(Buffer.from([0x0a, 0x0b]))
    await expect
      .poll(() => [...Buffer.concat(secure.received)])
      .toEqual([0x16, 0x03, 0x01, 0x00, 0x05, 0x0a, 0x0b])
    expect(plain.sockets).toHaveLength(0)
  })

  it('routes on the first byte even when it arrives alone, before the rest', async () => {
    const secure = new Target()
    const { connect } = await start(secure)
    const socket = await connect()
    socket.write(Buffer.from([0x16]))
    await new Promise((resolve) => setTimeout(resolve, 30))
    socket.write(Buffer.from([0x03, 0x01]))
    await expect.poll(() => [...Buffer.concat(secure.received)]).toEqual([0x16, 0x03, 0x01])
  })

  it('closes a TLS connection when there is no TLS server, and still serves plain ones', async () => {
    const { plain, connect } = await start(null)
    const tls = await connect()
    const closed = new Promise<void>((resolve) => tls.once('close', () => resolve()))
    tls.write(Buffer.from([0x16, 0x03, 0x01]))
    await closed
    const page = await connect()
    page.write('GET /')
    await expect.poll(() => plain.text()).toBe('GET /')
  })

  it('closes a connection that sends nothing within the time allowed', async () => {
    const { plain, connect } = await start(new Target(), 40)
    const silent = await connect()
    await new Promise<void>((resolve) => silent.once('close', () => resolve()))
    expect(plain.sockets).toHaveLength(0)
  })

  it('does not close a connection after its first byte because of the silence timer', async () => {
    const { plain, connect } = await start(new Target(), 60)
    const socket = await connect()
    socket.write('G')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(socket.destroyed).toBe(false)
    expect(plain.sockets).toHaveLength(1)
  })

  it('closes every connection when it is closed: the ones waiting and the ones handed on', async () => {
    const secure = new Target()
    const { plain, connect } = await start(secure)
    const waiting = await connect()
    const handedPlain = await connect()
    handedPlain.write('GET /')
    const handedSecure = await connect()
    handedSecure.write(Buffer.from([0x16]))
    await expect.poll(() => plain.sockets.length + secure.sockets.length).toBe(2)
    const closes = [waiting, handedPlain, handedSecure].map(
      (socket) => new Promise<void>((resolve) => socket.once('close', () => resolve()))
    )
    await listener?.close()
    await Promise.all(closes)
    expect(plain.sockets[0]?.destroyed).toBe(true)
    expect(secure.sockets[0]?.destroyed).toBe(true)
  })

  it('starts its targets only once it is listening, and lets both go when the port is taken', async () => {
    const closed: string[] = []
    const target = (name: string) =>
      Object.assign(new EventEmitter(), { close: () => void closed.push(name) })
    const listening: string[] = []
    const watch = (name: string, server: EventEmitter) => server.on('listening', () => listening.push(name))
    const { port } = await start(null)
    const plain = target('plain')
    const secure = target('secure')
    watch('plain', plain)
    watch('secure', secure)
    const busy = new LanListener({ plain, secure }, 1000)
    expect(listening).toEqual([])
    await expect(busy.listen(HOST, port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(listening).toEqual([])
    expect(closed.sort()).toEqual(['plain', 'secure'])
    // Once it does listen, both are started.
    const second = target('plain')
    const other = target('secure')
    watch('plain', second)
    watch('secure', other)
    const fresh = new LanListener({ plain: second, secure: other }, 1000)
    await fresh.listen(HOST, 0)
    expect(listening.sort()).toEqual(['plain', 'secure'])
    await fresh.close()
  })

  it('can be closed without ever listening, and rejects listen when the port is taken', async () => {
    const idle = new LanListener({ plain: new Target(), secure: null }, 1000)
    await expect(idle.close()).resolves.toBeUndefined()
    const { port } = await start(null)
    const second = new LanListener({ plain: new Target(), secure: null }, 1000)
    await expect(second.listen(HOST, port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})
