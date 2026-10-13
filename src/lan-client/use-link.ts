/** Hooks that read the link to the PC. */

import { useSyncExternalStore } from 'react'
import type { LiveTopic, LiveTopics } from '@shared/live'
import type { LanConnection, LanLinkState } from './lan-connection'

/**
 * @param link The link to the PC.
 * @returns Its state, kept current.
 */
export function useLinkState(link: LanConnection): LanLinkState {
  return useSyncExternalStore(
    (notify) => link.onState(() => notify()),
    () => link.state
  )
}

/**
 * @param link The link to the PC.
 * @param topic A live topic.
 * @returns The topic's latest value, or undefined until the PC has sent one.
 */
export function useTopic<T extends LiveTopic>(link: LanConnection, topic: T): LiveTopics[T] | undefined {
  return useSyncExternalStore(
    (notify) => link.subscribe(topic, () => notify()),
    () => link.latest(topic)
  )
}
