/**
 * Whether BeyondATC's prompts, taxi line, frequency suggestions and auto step climb are hidden or silent because the pilot is on an online
 * network: human controllers are the only voice then. BeyondATC keeps running underneath, so going offline mid-session restores everything.
 * The one place the rule lives; main computes it into the `onlineStatus` topic, and every screen and the step climb read that.
 */
import type { OnlineStatus } from './types/online'

/**
 * @param state The pilot's online state.
 * @param keepWhileOnline The "Keep BeyondATC while online" setting (off by default).
 * @returns True when BeyondATC should be hidden and silent: the pilot is online (or probably) and has not asked to keep it.
 */
export function beyondAtcSuppressed(state: OnlineStatus['state'], keepWhileOnline: boolean): boolean {
  return (state === 'online' || state === 'probably') && !keepWhileOnline
}
