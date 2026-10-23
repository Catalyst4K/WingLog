import { createServer } from 'node:net'
import { expect } from '@playwright/test'
import { WebSocket } from 'ws'

/** What the second-screen specs share: a free loopback port, and a device that talks to the PC the way the phone page does. */

/** A port nothing listens on. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/** A device talking to the PC the way the page does, remembering what it was sent. */
export class Device {
  readonly received: Record<string, unknown>[] = []
  closed = false
  private readonly ws: WebSocket

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/live`)
    this.ws.on('message', (data) => this.received.push(JSON.parse(data.toString())))
    this.ws.on('close', () => (this.closed = true))
    this.ws.on('error', () => undefined)
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message))
  }

  async message(type: string): Promise<Record<string, unknown>> {
    await expect.poll(() => this.received.some((m) => m.t === type)).toBe(true)
    return this.received.find((m) => m.t === type) as Record<string, unknown>
  }

  close(): void {
    this.ws.terminate()
  }
}
