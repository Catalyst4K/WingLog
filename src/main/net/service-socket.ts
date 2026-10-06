/**
 * The part of a WebSocket that BeyondAtcService and GsxRemoteService use: the seam a live
 * connection, a test double, or a replayed capture plugs into
 * (flightdeck-backend docs/plans/robustness/scenario-testing.md Part 1).
 */

import { WebSocket } from 'ws'

/** The four events the services listen for; only `message` carries data they read. */
export interface ServiceSocketListeners {
  open: () => void
  message: (event: { data: unknown }) => void
  close: () => void
  error: () => void
}

/** A connected (or connecting) socket, as the services see it. */
export interface ServiceSocket {
  /** The value `readyState` has once the socket can send. */
  readonly OPEN: number
  readonly readyState: number
  addEventListener<K extends keyof ServiceSocketListeners>(type: K, listener: ServiceSocketListeners[K]): void
  send(text: string): void
  close(): void
}

/** Opens a socket to `url`; `ws`'s WebSocket in the app. */
export type ServiceSocketCtor = new (url: string) => ServiceSocket

/** `ws`'s WebSocket behind the ServiceSocket shape: the services' live connection. `ws`, not
 *  Node's built-in WebSocket: the built-in one drops lines from a large multi-line message
 *  (flightdeck-backend docs/beyondatc-notes.md, 2026-09-28). */
export class NodeServiceSocket implements ServiceSocket {
  readonly OPEN = WebSocket.OPEN
  private readonly ws: WebSocket

  constructor(url: string) {
    this.ws = new WebSocket(url)
  }

  get readyState(): number {
    return this.ws.readyState
  }

  addEventListener<K extends keyof ServiceSocketListeners>(type: K, listener: ServiceSocketListeners[K]): void {
    if (type === 'message') {
      const onMessage = listener as ServiceSocketListeners['message']
      this.ws.addEventListener('message', (event) => onMessage({ data: event.data }))
      return
    }
    const onEvent = listener as () => void
    this.ws.addEventListener(type, () => onEvent())
  }

  send(text: string): void {
    this.ws.send(text)
  }

  close(): void {
    this.ws.close()
  }
}
