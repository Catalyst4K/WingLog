import type { LiveSnapshot, LiveTopic, LiveTopics } from '@shared/live'

export type LiveListener = <T extends LiveTopic>(topic: T, payload: LiveTopics[T]) => void

/**
 * The one place live state goes through in the main process (flightdeck-backend's
 * docs/plans/live-data-seam.md, part A). Services publish here instead of writing to the
 * window; the window is one subscriber. The v1.5 LAN server will be a second subscriber,
 * and `snapshot()` is how a device that connects mid-flight gets the current state in one
 * go rather than waiting for every stream to tick.
 */
export class LiveHub {
  private readonly latest: LiveSnapshot = {}
  private readonly listeners = new Set<LiveListener>()

  publish<T extends LiveTopic>(topic: T, payload: LiveTopics[T]): void {
    ;(this.latest as Record<LiveTopic, unknown>)[topic] = payload
    for (const listener of this.listeners) {
      try {
        listener(topic, payload)
      } catch (error) {
        // One broken subscriber (a closed window, later a dropped LAN client) mustn't stop
        // the others hearing about it.
        console.warn(`[live] subscriber failed on ${topic}:`, error)
      }
    }
  }

  subscribe(listener: LiveListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The latest payload of every topic published so far. A copy: callers can't mutate it. */
  snapshot(): LiveSnapshot {
    return { ...this.latest }
  }
}
