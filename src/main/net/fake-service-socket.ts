/**
 * Test support: a ServiceSocket that never connects on its own, for tests that need to see what
 * BeyondAtcService or GsxRemoteService opens without a server. Used only by tests.
 */
import type { ServiceSocket, ServiceSocketListeners } from './service-socket'

/** A socket the test opens by hand. Every one constructed is in `FakeServiceSocket.opened`. */
export class FakeServiceSocket implements ServiceSocket {
  /** Every socket constructed, oldest first. Clear it between tests. */
  static readonly opened: FakeServiceSocket[] = []
  readonly OPEN = 1
  readyState = 0
  closed = false
  /** Everything the service sent, as the text it sent. */
  readonly sent: string[] = []
  private readonly listeners = new Map<keyof ServiceSocketListeners, ((...args: never[]) => void)[]>()

  /** @param url The address the service asked for. */
  constructor(readonly url: string) {
    FakeServiceSocket.opened.push(this)
  }

  addEventListener<K extends keyof ServiceSocketListeners>(
    type: K,
    listener: ServiceSocketListeners[K]
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    this.closed = true
  }

  /** Connects, as a server answering would. */
  open(): void {
    this.readyState = this.OPEN
    for (const listener of this.listeners.get('open') ?? []) (listener as () => void)()
  }

  /**
   * Delivers a message, as the server would.
   *
   * @param payload What the server sent; it goes out as JSON.
   */
  receive(payload: unknown): void {
    const event = { data: JSON.stringify(payload) }
    for (const listener of this.listeners.get('message') ?? [])
      (listener as (e: { data: unknown }) => void)(event)
  }
}
