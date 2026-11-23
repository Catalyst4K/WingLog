/** When a client's link to the sim PC needs pairing (again): the rule the Devices page's Add a device button follows. */

import type { HostLinkState, HostLinkStatus } from '@shared/ipc'

/** The states that come with a line saying what happened and what to do, and with Add a device again. */
const REFUSED_STATES = ['pair-again', 'certificate-changed', 'not-secure'] as const

/**
 * @param state A link state.
 * @returns True for a state in which the link cannot go on until the pilot pairs again.
 */
export function isRefused(state: HostLinkState): state is (typeof REFUSED_STATES)[number] {
  return (REFUSED_STATES as readonly string[]).includes(state)
}

/**
 * @param status The link's status, or null before it has been read.
 * @returns True when a pairing is offered: no sim PC is paired, the code was wrong, or the link cannot go on without pairing again.
 */
export function offersPairing(status: HostLinkStatus | null): boolean {
  const state = status?.state ?? 'unpaired'
  const paired = state !== 'unpaired' && status?.address
  return !paired || state === 'wrong-code' || isRefused(state)
}
