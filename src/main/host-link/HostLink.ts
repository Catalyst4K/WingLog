/**
 * A client's link to the sim PC's WingLog (winglog-backend's docs/plans/multi-device.md, Part 2). It pairs with the host's second-screen
 * server the way a phone does, keeps the host's address and device token, follows the host's live topics into this computer's own
 * `LiveHub` so the screens and `LiveClient` do not change, and sends the host the commands a phone may send. Reconnecting, lookups and
 * retries are the shared `LanConnection`'s, the same code the phone's page runs.
 */

import type { LiveTopic, LiveTopics } from '@shared/live'
import { LanConnection, type LanLinkState, type LinkSocket, type TokenStore } from '@shared/lan-connection'
import { parseHostAddress } from '@shared/host-address'
import type { HostLinkState, HostLinkStatus, LanFlightSnapshot, TrackPoint } from '@shared/ipc'
import { logger } from '../logging/logger'
import { LAN_TOPICS } from '../lan/LanServer'
import type { LiveHub } from '../live/LiveHub'
import type { HostLinkStore } from './host-link-store'
import type { TwinSyncPort } from './TwinSync'

/**
 * The topics a client takes from the host. Not the host's disk space: a client warns about its own.
 */
export const HOST_LINK_TOPICS: readonly LiveTopic[] = LAN_TOPICS.filter((topic) => topic !== 'storageStatus')

/** What a connection state means to a person. */
const STATE_OF: Record<LanLinkState, HostLinkState> = {
  starting: 'connecting',
  'needs-pairing': 'unpaired',
  'wrong-code': 'wrong-code',
  connected: 'connected',
  offline: 'offline'
}

export interface HostLinkDeps {
  hub: LiveHub
  store: HostLinkStore
  /** Opens a socket to the host (the `ws` client; a test double in tests). */
  createSocket: (url: string) => LinkSocket
  /** The name the host lists this computer by. */
  deviceName: string
  /** Called whenever the status changes. */
  onStatus: (status: HostLinkStatus) => void
  /**
   * Re-labels a topic's value on its way into this computer's hub: the sim PC's flight ids mean nothing here. Returns null to drop it.
   * Left out, every topic is passed on as it came.
   */
  mapTopic?: (topic: LiveTopic, payload: unknown) => unknown
  /** Told the flight the sim PC shows (null when none or the link is gone), and a way to read the track it has recorded so far. */
  onFlight?: (flight: LanFlightSnapshot | null, track: () => TrackPoint[]) => void
  /** Keeps the two databases in step; asked to sync when the link comes up and when the sim PC says it changed. Left out in tests of the link alone. */
  sync?: TwinSyncPort
}

/** How soon after the sim PC says its data changed a client syncs, in milliseconds. */
const SYNC_AFTER_HINT_MS = 500

/** The link to the sim PC, kept for the life of the app. */
export class HostLink {
  private connection: LanConnection | null = null
  private address: string | null = null
  private token: string | null = null
  private hostSim: HostLinkStatus['hostSim'] = null
  private unsubscribers: (() => void)[] = []

  /** @param deps The hub to follow into, where the link is kept, how to open a socket, and who to tell of changes. */
  constructor(private readonly deps: HostLinkDeps) {
    deps.sync?.onChange(() => this.emit())
  }

  /** @returns Where the link stands. */
  getStatus(): HostLinkStatus {
    const state: HostLinkState = this.connection ? STATE_OF[this.connection.state] : 'unpaired'
    return {
      state,
      address: this.address,
      hostSim: this.hostSim,
      sync: this.deps.sync?.status() ?? { state: 'idle', lastSyncedAt: null, problem: null }
    }
  }

  /** Connects to the sim PC this computer was paired with, if there was one. */
  async start(): Promise<void> {
    const stored = await this.deps.store.load()
    if (!stored || this.connection) return
    this.address = stored.address
    this.token = stored.token
    this.open()?.start()
  }

  /**
   * Pairs with a sim PC.
   *
   * @param rawAddress The host's address as typed.
   * @param code The 6-digit code the host's Second screen card shows.
   * @throws When the address is not a home-network `host:port`.
   */
  pair(rawAddress: string, code: string): void {
    const address = parseHostAddress(rawAddress)
    if (!address) throw new Error('Enter the sim PC’s address with its port, such as 192.168.1.20:5051')
    this.close()
    this.address = address
    this.token = null
    // The sim PC may have a new or restored database whose counter starts low: what was sent to and taken from the one before means nothing now.
    this.deps.sync?.forgetCursors()
    // Another WingLog pairs as a twin, with the code of the host's Pair another WingLog, not the second screen's.
    this.open()?.pair(code, 'twin')
    this.emit()
  }

  /** Forgets the sim PC: closes the link and deletes the stored token. */
  forget(): void {
    this.close()
    this.address = null
    this.token = null
    this.hostSim = null
    this.deps.sync?.forgetCursors()
    this.deps.store.clear()
    this.emit()
  }

  /**
   * Sends the host a command (the same validated ones a phone may send).
   *
   * @param name The command's name.
   * @param args Its arguments.
   * @throws When the link is not up.
   */
  command(name: string, args: unknown[]): void {
    if (!this.connection) throw new Error('Not connected to the sim PC')
    this.connection.command(name, ...args)
  }

  /**
   * Sends the host a command after bringing the two databases level, for a command that names something the pilot may have just made here.
   *
   * @param name The command's name.
   * @param args Its arguments.
   * @throws When the link is not up.
   */
  async commandAfterSync(name: string, args: unknown[]): Promise<void> {
    if (!this.connection) throw new Error('Not connected to the sim PC')
    await this.deps.sync?.run()
    this.command(name, args)
  }

  /**
   * Asks the host for read-only data (an airport's runways, a taxi chart).
   *
   * @param name The lookup's name.
   * @param args Its arguments.
   * @returns The host's answer.
   */
  query(name: string, ...args: unknown[]): Promise<unknown> {
    if (!this.connection) return Promise.reject(new Error('Not connected to the sim PC'))
    return this.connection.query(name, ...args)
  }

  /** Closes the link for good (the app is quitting). */
  stop(): void {
    this.close()
  }

  private open(): LanConnection | null {
    const address = this.address
    if (!address) return null
    const tokens: TokenStore = {
      get: () => this.token,
      set: (token) => {
        this.token = token
        this.deps.store.save({ address, token }).catch((error: unknown) => {
          logger.warn('[host-link] could not store the token:', error)
        })
      },
      clear: () => {
        this.token = null
        this.deps.store.clear()
      }
    }
    const connection = new LanConnection(
      `ws://${address}/live`,
      tokens,
      this.deps.createSocket,
      this.deps.deviceName
    )
    this.connection = connection
    this.unsubscribers = [
      connection.onState((state) => {
        // A host that cannot be reached must not leave its last telemetry on screen as if it were live.
        if (state === 'offline') this.hostSimChanged('disconnected')
        // Each time the link comes up, the two databases are brought level.
        if (state === 'connected') this.deps.sync?.syncSoon(0)
        this.emit()
      }),
      connection.onSyncHint(() => this.deps.sync?.syncSoon(SYNC_AFTER_HINT_MS)),
      connection.onFlight((flight) => this.deps.onFlight?.(flight, () => connection.track)),
      ...HOST_LINK_TOPICS.map((topic) =>
        connection.subscribe(topic, (payload) => this.republish(topic, payload))
      )
    ]
    return connection
  }

  private close(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers = []
    this.deps.onFlight?.(null, () => [])
    this.connection?.stop()
    this.connection = null
  }

  /**
   * @param topic A topic the host published.
   * @param payload Its new value.
   */
  private republish<T extends LiveTopic>(topic: T, payload: unknown): void {
    const mapped = this.deps.mapTopic ? this.deps.mapTopic(topic, payload) : payload
    // A value that cannot be re-labelled yet (its flight has not synced) is held back, not shown against the wrong flight.
    if (mapped !== null) this.deps.hub.publish(topic, mapped as LiveTopics[T])
    if (topic === 'simConnectionStatus') {
      this.hostSimChanged((payload as LiveTopics['simConnectionStatus']).state)
    }
  }

  private hostSimChanged(state: NonNullable<HostLinkStatus['hostSim']>): void {
    if (state === 'disconnected' && this.hostSim !== 'disconnected') {
      this.deps.hub.publish('simConnectionStatus', { state: 'disconnected' })
    }
    this.hostSim = state
    this.emit()
  }

  private emit(): void {
    this.deps.onStatus(this.getStatus())
  }
}
