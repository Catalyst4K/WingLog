/** The words for why devices cannot connect to the sim PC, or cannot be given a pairing code. */

import type { LanDeviceKind, LanProblem, LanStatus } from '@shared/ipc'

/** The locale key under `lan.settings.problem` for each problem. */
export const LAN_PROBLEM_KEY: Record<LanProblem, string> = {
  'no-adapter': 'noAdapter',
  'port-in-use': 'portInUse',
  failed: 'failed'
}

/**
 * @param status The server's status.
 * @param kind The kind being paired.
 * @returns The locale key of why no code of that kind can be used now (the server's own problem, no home network, or, for a computer,
 *   no certificate), or null when one can.
 */
export function pairingProblemKey(status: LanStatus, kind: LanDeviceKind): string | null {
  if (status.problem) return `lan.settings.problem.${LAN_PROBLEM_KEY[status.problem]}`
  if (!status.url) return 'settingsView.twin.notReachable'
  if (kind === 'twin' && !status.twinCertificate) return 'settingsView.twin.noCertificate'
  return null
}
