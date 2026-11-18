/** The live topics a paired device is sent (the second-screen server's allowlist). */

import type { LiveTopic } from '@shared/live'

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
