/**
 * Looks a host name up for the link to the sim PC and refuses an answer that is not on the home network (winglog-backend's
 * docs/plans/security-audit-v2.md, L8). `parseHostAddress` accepts a single-label or `.local` name by its spelling, but a name with no dots
 * can resolve to a public address through a DNS search suffix. The check is made on the addresses the lookup returns, and the connection is
 * made to those same addresses, so a second lookup cannot give a different answer.
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { isHomeNetworkAddress } from '@shared/host-address'

/** What `dns.lookup` is called with here: the name, and the options the socket asked for. */
type Resolve = (
  hostname: string,
  options: { all: true; family?: number; hints?: number },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void

/**
 * The system resolver, asked for every address a name has.
 *
 * @param hostname The name.
 * @param options What to ask for (all addresses).
 * @param callback Called with the addresses.
 */
function systemResolve(
  hostname: string,
  options: { all: true; family?: number; hints?: number },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
): void {
  dnsLookup(hostname, options, callback)
}

/** The lookup function `net.connect` and `ws` take as their `lookup` option. */
export type SocketLookup = (
  hostname: string,
  options: { all?: boolean; family?: number; hints?: number },
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
) => void

/**
 * @param resolve How a name is looked up (the system's resolver; a fake in tests).
 * @returns A lookup that answers only with home-network addresses, and fails with a clear message when the name resolves to anything else.
 */
export function homeNetworkLookup(resolve: Resolve = systemResolve): SocketLookup {
  return (hostname, options, callback) => {
    // An address typed as a number needs no lookup, and has already been checked as text; it is checked again here all the same.
    const literal = isIP(hostname)
    if (literal !== 0) {
      if (!isHomeNetworkAddress(hostname)) return callback(refusal(hostname, [hostname]), [])
      return callback(null, options.all ? [{ address: hostname, family: literal }] : hostname, literal)
    }
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, [])
      const outside = addresses.filter((entry) => !isHomeNetworkAddress(entry.address))
      // One address outside the home network is enough to refuse: the connection could be made to it.
      if (addresses.length === 0 || outside.length > 0) {
        return callback(
          refusal(
            hostname,
            outside.map((entry) => entry.address)
          ),
          []
        )
      }
      if (options.all) return callback(null, addresses)
      const first = addresses[0] as LookupAddress
      return callback(null, first.address, first.family)
    })
  }
}

/**
 * @param hostname The name that was looked up.
 * @param outside The addresses it gave that are not on the home network (none when it gave nothing).
 * @returns The error to fail the connection with.
 */
function refusal(hostname: string, outside: string[]): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    outside.length === 0
      ? `“${hostname}” did not resolve to an address`
      : `“${hostname}” resolves to an address outside the home network (${outside.join(', ')}), so WingLog will not connect to it`
  )
  error.code = 'EHOSTNOTHOME'
  return error
}
