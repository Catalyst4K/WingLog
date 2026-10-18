import { EventEmitter } from 'node:events'
import type { Socket } from 'node:dgram'
import { describe, expect, it } from 'vitest'
import { defaultRouteAddress } from './default-route'

/** A UDP socket that answers connect the way the operating system would. */
function fakeSocket(behaviour: {
  address?: string
  connectError?: boolean
  connectThrows?: boolean
  addressThrows?: boolean
  closeThrows?: boolean
}): { socket: Socket; closed: () => boolean; probed: () => { port: number; host: string } | null } {
  const emitter = new EventEmitter()
  let closed = false
  let probed: { port: number; host: string } | null = null
  const socket = Object.assign(emitter, {
    connect(port: number, host: string, done: () => void) {
      probed = { port, host }
      if (behaviour.connectThrows) throw new Error('bad address')
      if (behaviour.connectError) queueMicrotask(() => emitter.emit('error', new Error('ENETUNREACH')))
      else queueMicrotask(done)
    },
    address() {
      if (behaviour.addressThrows) throw new Error('not bound')
      return { address: behaviour.address ?? '192.168.1.136', family: 'IPv4', port: 50000 }
    },
    close() {
      closed = true
      if (behaviour.closeThrows) throw new Error('already closed')
    }
  }) as unknown as Socket
  return { socket, closed: () => closed, probed: () => probed }
}

describe('defaultRouteAddress', () => {
  it('gives the address the operating system would send from, by connecting (not sending) a UDP socket', async () => {
    const fake = fakeSocket({ address: '192.168.1.136' })
    expect(await defaultRouteAddress(() => fake.socket)).toBe('192.168.1.136')
    expect(fake.probed()).toEqual({ port: 53, host: '1.1.1.1' })
    expect(fake.closed()).toBe(true)
  })

  it('gives null when there is no route, and still closes the socket', async () => {
    const fake = fakeSocket({ connectError: true })
    expect(await defaultRouteAddress(() => fake.socket)).toBeNull()
    expect(fake.closed()).toBe(true)
  })

  it('gives null when the socket cannot be opened, connected or read', async () => {
    expect(
      await defaultRouteAddress(() => {
        throw new Error('no sockets')
      })
    ).toBeNull()
    expect(await defaultRouteAddress(() => fakeSocket({ connectThrows: true }).socket)).toBeNull()
    expect(await defaultRouteAddress(() => fakeSocket({ addressThrows: true }).socket)).toBeNull()
  })

  it('is not troubled by a socket that is already closed', async () => {
    expect(await defaultRouteAddress(() => fakeSocket({ closeThrows: true }).socket)).toBe('192.168.1.136')
  })

  it('answers on this machine with an address or null, never an error', async () => {
    const address = await defaultRouteAddress()
    expect(address === null || /^\d+\.\d+\.\d+\.\d+$/.test(address)).toBe(true)
  })
})
