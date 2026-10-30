/**
 * BeyondATC while the pilot is on an online network, where human controllers are the only voice. Two rules, each living only here:
 * - whether BeyondATC's prompts, taxi line, frequency suggestions and auto step climb are hidden or silent. BeyondATC keeps running
 *   underneath, so going offline mid-session restores everything. Main computes it into the `onlineStatus` topic, and every screen and
 *   the step climb read that;
 * - whether to warn that BeyondATC's auto tune is on, which the screens work out from the online status and BeyondATC's own state.
 */
import type { OnlineStatus } from './types/online'

/**
 * @param state The pilot's online state.
 * @returns True when the pilot is online, or probably is.
 */
function isOnline(state: OnlineStatus['state']): boolean {
  return state === 'online' || state === 'probably'
}

/**
 * @param state The pilot's online state.
 * @param keepWhileOnline The "Keep BeyondATC while online" setting (off by default).
 * @returns True when BeyondATC should be hidden and silent: the pilot is online (or probably) and has not asked to keep it.
 */
export function beyondAtcSuppressed(state: OnlineStatus['state'], keepWhileOnline: boolean): boolean {
  return isOnline(state) && !keepWhileOnline
}

/**
 * Auto tune is BeyondATC's own setting and retunes the aircraft's radios, which online takes the pilot off the network controller's
 * frequency. WingLog only warns and never switches it off by itself (Callum, 2026-10-25). The warning holds whether or not BeyondATC is
 * kept while online, since auto tune changes the radios either way.
 *
 * @param state The pilot's online state.
 * @param connected Whether BeyondATC is connected now (its last auto tune value is kept after it closes).
 * @param autoTune BeyondATC's auto tune, or null before BeyondATC has said.
 * @returns True while the pilot is online (or probably) and a connected BeyondATC has auto tune on.
 */
export function autoTuneWarning(
  state: OnlineStatus['state'],
  connected: boolean,
  autoTune: boolean | null
): boolean {
  return isOnline(state) && connected && autoTune === true
}
