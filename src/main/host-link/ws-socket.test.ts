import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { openHostSocket } from './ws-socket'

describe('openHostSocket (audit L8)', () => {
  const servers: WebSocketServer[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  /** A server on this computer's loopback address, and the port it listens on. */
  async function listen(): Promise<number> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    servers.push(server)
    await new Promise((resolve) => server.once('listening', resolve))
    return (server.address() as AddressInfo).port
  }

  it('connects through the checked lookup: by address, and by a name that resolves to this computer', async () => {
    const port = await listen()
    for (const host of ['127.0.0.1', 'localhost']) {
      const opened = await new Promise<boolean>((resolve) => {
        const socket = openHostSocket(`ws://${host}:${port}/live`)
        socket.onopen = () => {
          socket.close()
          resolve(true)
        }
        socket.onclose = () => resolve(false)
      })
      expect(opened, host).toBe(true)
    }
  })

  it('never starts a connection to a public address typed as a number, however it is written (review of L8)', async () => {
    for (const url of [
      'ws://8.8.8.8:5051/live',
      'ws://0x08080808:5051/live',
      'ws://134744072:5051/live',
      'ws://[2001:4860:4860::8888]:5051/live',
      'ws://[::ffff:8.8.8.8]:5051/live'
    ]) {
      const socket = openHostSocket(url)
      // Closed from the start: a socket that had begun connecting would still be CONNECTING (0) here.
      expect(socket.readyState, url).toBe(3)
      const closed = await new Promise<boolean>((resolve) => {
        socket.onopen = () => resolve(false)
        socket.onclose = () => resolve(true)
      })
      expect(closed, url).toBe(true)
    }
  })

  it('starts a connection to a private address typed as a number', () => {
    const socket = openHostSocket('ws://192.168.250.250:5051/live')
    expect(socket.readyState).toBe(0)
    socket.close()
  })
})
