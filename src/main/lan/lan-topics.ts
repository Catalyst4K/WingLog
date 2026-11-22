/** The live topics a paired device is sent (the second-screen server's allowlist). */

import type { LiveSnapshot, LiveTopic } from '@shared/live'

/** The topics a paired device is sent. A topic added to `LiveTopics` is not sent until it is added here on purpose. */
export const LAN_TOPICS: readonly LiveTopic[] = [
  'simTelemetry',
  'simConnectionStatus',
  'trackingPoint',
  'trackingPointsUpdated',
  'procedureSelection',
  'plannedRoute',
  'taxiRoute',
  'networkTraffic',
  'simTraffic',
  'trafficLayers',
  'onlineStatus',
  'networkControllers',
  'networkAtc',
  'storageStatus',
  'gsxRemoteStatus',
  'gsxRemoteServices',
  'gsxRemoteGate',
  'gsxRemoteMenu',
  'gsxRemotePrompt',
  'gsxRemoteCommandBar',
  'gsxRoutine',
  'beyondAtcStatus',
  'beyondAtcState',
  'beyondAtcTranscript',
  'beyondAtcStepClimb',
  'beyondAtcArrival'
]

/**
 * @param snapshot The hub's latest value of each topic.
 * @returns Only the topics a paired device is sent, in the order of `LAN_TOPICS`.
 */
export function lanTopicsOf(snapshot: LiveSnapshot): LiveSnapshot {
  const topics: Record<string, unknown> = {}
  for (const topic of LAN_TOPICS) {
    if (topic in snapshot) topics[topic] = snapshot[topic]
  }
  return topics as LiveSnapshot
}
