/** How the app opens SimConnect, with the one e2e override: a port to try instead of the real sim's. */

import { open, type Protocol } from 'node-simconnect'

/** The e2e launcher sets this to a port nothing listens on, so a test run never reaches a real sim running on the same machine. */
export const E2E_SIMCONNECT_PORT_ENV = 'WINGLOG_E2E_SIMCONNECT_PORT'

type ConnectionOptions = Parameters<typeof open>[2]

/**
 * The connection options an e2e run asks for.
 *
 * @param value The environment variable's value.
 * @returns A remote connection to that port on this machine, or undefined for the normal lookup.
 */
export function e2eSimConnectOptions(value: string | undefined): ConnectionOptions {
  const port = Number(value)
  if (value === undefined || !Number.isInteger(port) || port <= 0 || port >= 65536) return undefined
  return { remote: { host: '127.0.0.1', port } }
}

/**
 * node-simconnect's `open`, except that an e2e run is pointed at its own port (the real sim's own lookup otherwise).
 *
 * @param appName The client's name, as the sim lists it.
 * @param protocolVersion The lowest protocol version.
 * @param options Connection options; the e2e override applies only when none are given.
 * @returns The open connection.
 */
export function openSimConnect(
  appName: string,
  protocolVersion: Protocol,
  options?: ConnectionOptions
): ReturnType<typeof open> {
  return open(appName, protocolVersion, options ?? e2eSimConnectOptions(process.env[E2E_SIMCONNECT_PORT_ENV]))
}
