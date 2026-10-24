/**
 * Reads the chosen network's public feed while the map needs it and publishes the aircraft near the pilot as the `networkTraffic`
 * topic, plus which traffic layers draw as `trafficLayers`.
 *
 * A thin wrapper: when to fetch is `feed-poll-step.ts`'s pure step, what a feed means is the two parsers, and what draws is
 * `traffic-layers.ts`. This class injects the fetch, clock and timers, owns the timer, and keeps the last good snapshot. One fetch
 * serves every screen (the PC window and the phone both read the topic). Nothing is fetched while nothing draws the layer, or for IVAO
 * without a VID (Regulation D.2). Plan: winglog-backend docs/plans/vatsim-build.md, Step 1b.
 */
import type { LatLon } from '@shared/geo'
import type { NetworkTraffic, OnlineNetwork, OnlineNetworkSettings, TrafficLayers } from '@shared/ipc'
import type { LiveHub } from '../live/LiveHub'
import { feedUserAgent, vatsimDataUrl, type FeedUrls } from './feed-urls'
import { initialPollState, pollFinished, stepPoll, type PollState } from './feed-poll-step'
import { TRAFFIC_MAX_AIRCRAFT, TRAFFIC_RADIUS_M, trafficNear, type FeedSnapshot } from './feed-snapshot'
import { parseIvaoFeed } from './ivao-feed'
import { decideTrafficLayers } from './traffic-layers'
import { parseVatsimFeed } from './vatsim-feed'

/** How long a request may take before it is given up, milliseconds. */
export const FEED_TIMEOUT_MS = 10_000
/** How long the last aircraft stay on the map after the feed starts failing, milliseconds. */
export const STALE_AFTER_MS = 45_000
/** The least time between two log lines about failing feeds, milliseconds. */
export const FAILURE_LOG_INTERVAL_MS = 10 * 60_000
/** The biggest feed body read, bytes: the busiest real feed is about 2.5 MB. */
const MAX_BODY_BYTES = 30_000_000

/** An error carrying a short, safe description (never feed content) for the log. */
class FeedError extends Error {}

/** The timers the service uses, replaceable in tests. */
export interface FeedTimers {
  set: (callback: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

/** What the service needs. */
export interface NetworkFeedDeps {
  hub: Pick<LiveHub, 'publish'>
  fetch: typeof fetch
  now: () => number
  timers: FeedTimers
  urls: FeedUrls
  /** The app's version, for the User-Agent. */
  appVersion: string
  settings: () => OnlineNetworkSettings
  switches: () => { networkOn: boolean; simOn: boolean }
  /** Stores the new switches. */
  saveSwitches: (switches: { networkOn: boolean; simOn: boolean }) => void
  /** Where to look around: the aircraft, else the departure airport of the flight shown, else null. */
  centre: () => LatLon | null
  log: { warn: (message: string) => void }
}

/** The service. */
export class NetworkFeedService {
  private poll: PollState = initialPollState()
  private snapshot: FeedSnapshot | null = null
  private lastOkMs: number | null = null
  private wantedSinceMs: number | null = null
  private timer: unknown = null
  private staleTimer: unknown = null
  private lastLogMs: number | null = null
  private vatsimUrl: string | null = null
  private abort: AbortController | null = null
  private stopped = false
  private lastState: NetworkTraffic['state'] | null = null
  /** Bumped when the network changes or the service stops, so a late answer from the old request is ignored. */
  private generation = 0

  /** @param deps The fetch, clock, timers, settings and the hub. */
  constructor(private readonly deps: NetworkFeedDeps) {}

  /** Publishes the first state and starts reading if the layer is on. */
  start(): void {
    this.refresh()
  }

  /** Stops the timers and any request in flight. */
  stop(): void {
    this.stopped = true
    this.generation++
    this.clearTimers()
    this.abort?.abort()
  }

  /**
   * Turns the network layer on or off for every screen, and remembers it.
   *
   * @param on The new state of the switch.
   */
  setNetworkOn(on: boolean): void {
    this.deps.saveSwitches({ ...this.deps.switches(), networkOn: on })
    this.refresh()
  }

  /** Re-reads the settings and switches and acts on them: call after either changes. */
  refresh(): void {
    if (this.stopped) return
    const layers = this.layers()
    this.deps.hub.publish('trafficLayers', layers)
    const settings = this.deps.settings()
    if (this.snapshot && this.snapshot.network !== settings.network) {
      this.snapshot = null
      this.lastOkMs = null
      this.generation++
      this.abort?.abort()
    }
    if (layers.drawNetwork && this.wantedSinceMs === null) this.wantedSinceMs = this.deps.now()
    if (!layers.drawNetwork) {
      this.wantedSinceMs = null
      this.clearStaleTimer()
    }
    this.publishTraffic()
    this.tick()
  }

  /** Call when the aircraft's position or the flight shown may have changed: a layer waiting for a centre gets one. */
  onPositionChanged(): void {
    if (this.lastState === 'noCentre') this.refresh()
  }

  /** @returns Which layers draw now. */
  private layers(): TrafficLayers {
    const settings = this.deps.settings()
    const switches = this.deps.switches()
    return decideTrafficLayers({
      networkOn: switches.networkOn,
      simOn: switches.simOn,
      network: settings.network,
      ivaoVidSet: settings.ivaoVid !== null,
      simAvailable: false
    })
  }

  /** @returns The network whose feed should be read now, or null when nothing draws. */
  private wantedNetwork(): OnlineNetwork | null {
    const layers = this.layers()
    return layers.drawNetwork && this.deps.centre() !== null ? this.deps.settings().network : null
  }

  /** Asks the pure step whether to fetch, and sets the timer for when to ask again. */
  private tick(): void {
    this.clearTimer()
    if (this.stopped) return
    const network = this.wantedNetwork()
    const step = stepPoll(this.poll, {
      nowMs: this.deps.now(),
      network: network ?? this.deps.settings().network,
      wanted: network ? 'traffic' : 'none'
    })
    this.poll = step.state
    if (step.fetchNow && network) this.fetchFeed(network)
    else if (step.wakeAtMs !== null)
      this.timer = this.deps.timers.set(() => this.tick(), Math.max(0, step.wakeAtMs - this.deps.now()))
  }

  /**
   * Reads one feed, publishes the result, and schedules the next look.
   *
   * @param network The network to read.
   */
  private fetchFeed(network: OnlineNetwork): void {
    const generation = this.generation
    this.abort = new AbortController()
    const abort = this.abort
    const timeout = this.deps.timers.set(() => abort.abort(), FEED_TIMEOUT_MS)
    this.readSnapshot(network, abort.signal)
      .then(
        (snapshot) => ({ snapshot, error: null }),
        (error: unknown) => ({ snapshot: null, error })
      )
      .then(({ snapshot, error }) => {
        this.deps.timers.clear(timeout)
        if (generation !== this.generation || this.stopped) return
        // The pilot changed network while this was in flight: its answer is for a feed no longer wanted.
        if (network !== this.deps.settings().network) return this.tick()
        if (snapshot) this.onSuccess(snapshot)
        else this.onFailure(network, error)
        this.tick()
      })
  }

  /**
   * @param network The network to read.
   * @param signal Aborts the request.
   * @returns The parsed feed.
   * @throws A FeedError with a short description when the request fails or the body is not a feed.
   */
  private async readSnapshot(network: OnlineNetwork, signal: AbortSignal): Promise<FeedSnapshot> {
    const url = network === 'vatsim' ? await this.vatsimFeedUrl(signal) : this.deps.urls.ivao
    const response = await this.get(url, signal)
    if (!response.ok) throw new FeedError(`HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > MAX_BODY_BYTES) throw new FeedError('response too large')
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new FeedError('not JSON')
    }
    const receivedMs = this.deps.now()
    const snapshot =
      network === 'vatsim' ? parseVatsimFeed(json, receivedMs) : parseIvaoFeed(json, receivedMs)
    if (!snapshot) throw new FeedError('not a feed')
    return snapshot
  }

  /**
   * @param url The address.
   * @param signal Aborts the request.
   * @returns The response.
   */
  private get(url: string, signal: AbortSignal): Promise<Response> {
    return this.deps.fetch(url, {
      headers: { 'User-Agent': feedUserAgent(this.deps.appVersion), 'Accept-Encoding': 'gzip' },
      signal
    })
  }

  /**
   * VATSIM's data address: its status page names it, read once per session; the fixed address is used if the page cannot be read.
   *
   * @param signal Aborts the request.
   * @returns The address.
   */
  private async vatsimFeedUrl(signal: AbortSignal): Promise<string> {
    if (this.vatsimUrl) return this.vatsimUrl
    const { vatsimStatus, vatsimData } = this.deps.urls
    if (vatsimStatus === null) return (this.vatsimUrl = vatsimData)
    try {
      const response = await this.get(vatsimStatus, signal)
      const found = response.ok ? vatsimDataUrl(await response.json()) : null
      return (this.vatsimUrl = found ?? vatsimData)
    } catch {
      return (this.vatsimUrl = vatsimData)
    }
  }

  /** @param snapshot A good feed. */
  private onSuccess(snapshot: FeedSnapshot): void {
    this.snapshot = snapshot
    this.lastOkMs = this.deps.now()
    this.poll = pollFinished(this.poll, true, this.deps.now())
    this.clearStaleTimer()
    this.publishTraffic()
  }

  /**
   * @param network The network that failed.
   * @param error What went wrong.
   */
  private onFailure(network: OnlineNetwork, error: unknown): void {
    const nowMs = this.deps.now()
    this.poll = pollFinished(this.poll, false, nowMs)
    if (this.lastLogMs === null || nowMs - this.lastLogMs >= FAILURE_LOG_INTERVAL_MS) {
      this.lastLogMs = nowMs
      // Only the network and a short reason: never feed content, a callsign or a member number.
      const reason = error instanceof FeedError ? error.message : 'request failed'
      this.deps.log.warn(`[online] ${network} feed failed: ${reason}`)
    }
    const since = this.lastOkMs ?? this.wantedSinceMs ?? nowMs
    const waitMs = Math.max(0, since + STALE_AFTER_MS - nowMs)
    if (waitMs === 0) this.markUnavailable()
    else if (this.staleTimer === null)
      this.staleTimer = this.deps.timers.set(() => this.markUnavailable(), waitMs)
  }

  /** Drops the last aircraft and says the feed is unavailable. */
  private markUnavailable(): void {
    this.staleTimer = null
    this.snapshot = null
    this.publishTraffic(true)
  }

  /**
   * Publishes the topic for the current settings and snapshot.
   *
   * @param unavailable True when the feed has been failing past the time the last aircraft are kept.
   */
  private publishTraffic(unavailable = false): void {
    const settings = this.deps.settings()
    const layers = this.layers()
    const network = settings.network
    let traffic: NetworkTraffic
    if (network === null) traffic = { network, state: 'noNetwork', aircraft: [] }
    else if (network === 'ivao' && settings.ivaoVid === null)
      traffic = { network, state: 'needsVid', aircraft: [] }
    else if (!layers.networkOn) traffic = { network, state: 'off', aircraft: [] }
    else {
      const centre = this.deps.centre()
      if (centre === null) traffic = { network, state: 'noCentre', aircraft: [] }
      else if (unavailable) traffic = { network, state: 'unavailable', aircraft: [] }
      else if (this.snapshot)
        traffic = { network, state: 'shown', aircraft: this.near(this.snapshot, centre, settings) }
      else {
        this.publishWaiting(network)
        return
      }
    }
    this.lastState = traffic.state
    this.deps.hub.publish('networkTraffic', traffic)
  }

  /**
   * Nothing has arrived yet for a layer that is on: shown, with no aircraft, until the first feed lands or fails.
   *
   * @param network The network chosen.
   */
  private publishWaiting(network: OnlineNetwork): void {
    this.lastState = 'shown'
    this.deps.hub.publish('networkTraffic', { network, state: 'shown', aircraft: [] })
  }

  /**
   * @param snapshot The parsed feed.
   * @param centre Where to look around.
   * @param settings The member numbers: the pilot's own aircraft is left out.
   * @returns The aircraft near the centre.
   */
  private near(snapshot: FeedSnapshot, centre: LatLon, settings: OnlineNetworkSettings) {
    return trafficNear(snapshot, centre, {
      radiusM: TRAFFIC_RADIUS_M,
      max: TRAFFIC_MAX_AIRCRAFT,
      excludeMemberId: snapshot.network === 'vatsim' ? settings.vatsimCid : settings.ivaoVid,
      nowMs: this.deps.now()
    })
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.timers.clear(this.timer)
    this.timer = null
  }

  private clearStaleTimer(): void {
    if (this.staleTimer !== null) this.deps.timers.clear(this.staleTimer)
    this.staleTimer = null
  }

  private clearTimers(): void {
    this.clearTimer()
    this.clearStaleTimer()
  }
}
