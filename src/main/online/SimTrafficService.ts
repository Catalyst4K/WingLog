/**
 * Publishes the aircraft the sim lists around the pilot as the `simTraffic` topic, while the sim layer draws (winglog-backend
 * docs/plans/vatsim-build.md, Step 4b).
 *
 * A thin wrapper: what an aircraft means is `sim-traffic.ts`, how the sim is read is a {@link SimTrafficLink} (a connection of its own, never
 * the tracking one), and whether the layer draws is `traffic-layers.ts`. This class keeps the link open only while the layer draws, asks for a
 * sweep every few seconds, and retries a link that could not be opened (the sim is not running yet) without ever blocking anything else.
 */
import type { SimTraffic } from '@shared/ipc'
import type { LiveHub } from '../live/LiveHub'
import type { SimTrafficRecord } from '../sim/simvars'
import type { FeedTimers } from './NetworkFeedService'
import { simTrafficAircraft } from './sim-traffic'

/** How often the sim is asked for the aircraft around the pilot, milliseconds. */
export const SIM_SWEEP_INTERVAL_MS = 5_000
/** How long to wait before trying to open the connection again after it failed or dropped, milliseconds. */
export const SIM_RETRY_MS = 15_000

/** What the sim connection tells the service. */
export interface SimTrafficHandlers {
  /** The object id the sim gives the user's own aircraft. */
  onUser: (objectId: number) => void
  /** One whole sweep: every aircraft within range, the user's own among them. */
  onSweep: (records: SimTrafficRecord[]) => void
  /** The connection went away (the sim quit). */
  onLost: () => void
}

/** An open connection to the sim for traffic. */
export interface SimTrafficLink {
  /** Asks the sim for one sweep; the answer arrives through `onSweep`. */
  requestSweep: () => void
  close: () => void
}

/** What the service needs. */
export interface SimTrafficDeps {
  hub: Pick<LiveHub, 'publish'>
  /** Opens a connection of its own; rejects when the sim cannot be reached. */
  open: (handlers: SimTrafficHandlers) => Promise<SimTrafficLink>
  timers: FeedTimers
  log: { warn: (message: string) => void }
}

/** The service. */
export class SimTrafficService {
  private wanted = false
  private link: SimTrafficLink | null = null
  private timer: unknown = null
  private userObjectId: number | null = null
  private lastState: SimTraffic['state'] | null = null
  /** Bumped on every start and stop, so a late answer from an earlier attempt is ignored. */
  private generation = 0
  private stopped = false

  /** @param deps The connection, timers and the hub. */
  constructor(private readonly deps: SimTrafficDeps) {}

  /** Publishes the first state: the layer is off. */
  start(): void {
    this.publish({ state: 'off', aircraft: [] })
  }

  /** Closes the connection and the timer for good. */
  stop(): void {
    this.stopped = true
    this.close()
  }

  /**
   * Starts or stops reading the sim.
   *
   * @param wanted True while the sim layer draws.
   */
  setWanted(wanted: boolean): void {
    if (this.stopped || wanted === this.wanted) return
    this.wanted = wanted
    this.close()
    if (wanted) {
      this.publish({ state: 'shown', aircraft: [] })
      this.connect()
    } else {
      this.publish({ state: 'off', aircraft: [] })
    }
  }

  /** Opens the connection and starts sweeping, or tries again later. */
  private connect(): void {
    const generation = this.generation
    this.deps
      .open({
        onUser: (objectId) => {
          if (generation === this.generation) this.userObjectId = objectId
        },
        onSweep: (records) => {
          if (generation !== this.generation) return
          this.publish({ state: 'shown', aircraft: simTrafficAircraft(records, this.userObjectId) })
        },
        onLost: () => {
          if (generation !== this.generation) return
          this.dropLink()
          this.scheduleRetry()
        }
      })
      .then(
        (link) => {
          if (generation !== this.generation) {
            link.close()
            return
          }
          this.link = link
          this.sweep()
        },
        () => {
          if (generation !== this.generation) return
          this.scheduleRetry()
        }
      )
  }

  /** Asks for a sweep now and again after the interval. */
  private sweep(): void {
    if (!this.link) return
    this.link.requestSweep()
    this.timer = this.deps.timers.set(() => this.sweep(), SIM_SWEEP_INTERVAL_MS)
  }

  /** Says the sim cannot be read and tries again after a while. */
  private scheduleRetry(): void {
    this.publish({ state: 'unavailable', aircraft: [] })
    this.timer = this.deps.timers.set(() => this.reopen(), SIM_RETRY_MS)
  }

  private reopen(): void {
    this.timer = null
    if (this.wanted && !this.stopped) this.connect()
  }

  private dropLink(): void {
    this.clearTimer()
    try {
      this.link?.close()
    } catch {
      this.deps.log.warn('[sim-traffic] closing the connection failed')
    }
    this.link = null
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.timers.clear(this.timer)
    this.timer = null
  }

  /** Ends the connection and everything waiting on it. */
  private close(): void {
    this.generation++
    this.dropLink()
    this.userObjectId = null
  }

  /**
   * Publishes a state, except an unchanged 'unavailable' or 'off' (nothing new to say).
   *
   * @param traffic The topic's new value.
   */
  private publish(traffic: SimTraffic): void {
    if (traffic.state !== 'shown' && traffic.state === this.lastState) return
    this.lastState = traffic.state
    this.deps.hub.publish('simTraffic', traffic)
  }
}
