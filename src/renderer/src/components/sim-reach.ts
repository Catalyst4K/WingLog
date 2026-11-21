/** How far the sim can be reached from this device: one meaning for the Mac's header light, the phone's Sim light and the Settings list. */

import type { LightState } from '@/components/StatusLight'

/** Where the chain from this device to the sim breaks, if it does. */
export type SimReach =
  /** No sim PC has been paired: nothing is wrong, so no alarm. */
  | 'unpaired'
  /** Not connected to the sim PC (connecting, not reachable, or it needs pairing again). */
  | 'no-pc'
  /** Connected to the sim PC, but its sim is not connected. */
  | 'no-sim'
  /** Connected to the sim PC, and its sim is connected. */
  | 'ready'

/**
 * @param link The state of the link to the sim PC: the Mac's `HostLinkState` or the phone's `LanLinkState`. Only `connected` and
 *   `unpaired` are told apart; any other state is a link that is not working.
 * @param simState The sim PC's own sim connection state (`SimConnectionStatus['state']`); undefined while it has not been heard.
 * @returns How far the sim can be reached.
 */
export function simReach(link: string, simState: string | undefined): SimReach {
  if (link === 'unpaired') return 'unpaired'
  if (link !== 'connected') return 'no-pc'
  return simState === 'connected' ? 'ready' : 'no-sim'
}

const LIGHT: Record<SimReach, LightState> = {
  unpaired: 'off',
  'no-pc': 'red',
  'no-sim': 'amber',
  ready: 'green'
}

/**
 * The light for how far the sim can be reached: off when nothing is paired, red when the sim PC is not connected, amber when it is
 * but its sim is not, green when both are.
 *
 * @param link The link state, as for {@link simReach}.
 * @param simState The sim PC's sim connection state, as for {@link simReach}.
 * @returns The light's state.
 */
export function simReachLight(link: string, simState: string | undefined): LightState {
  return LIGHT[simReach(link, simState)]
}
