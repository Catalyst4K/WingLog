/**
 * The address this PC reaches the network with: the one Windows would use to send to anything outside its own subnet, which is the
 * home network a phone is on. Found by connecting a UDP socket, which only asks the operating system for a route: no packet is sent
 * and nothing leaves the machine.
 */

import { createSocket, type Socket } from 'node:dgram'

/** Any address outside the private ranges will do; nothing is sent to it. */
const PROBE_ADDRESS = '1.1.1.1'
const PROBE_PORT = 53

/**
 * @param open Opens a UDP socket (the real one unless a test passes its own).
 * @returns The local IPv4 address of the default route, or null when there is no route (no network) or it can't be told.
 */
export function defaultRouteAddress(open: () => Socket = () => createSocket('udp4')): Promise<string | null> {
  return new Promise((resolve) => {
    let socket: Socket
    try {
      socket = open()
    } catch {
      resolve(null)
      return
    }
    const finish = (address: string | null): void => {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      resolve(address)
    }
    socket.once('error', () => finish(null))
    try {
      socket.connect(PROBE_PORT, PROBE_ADDRESS, () => {
        try {
          finish(socket.address().address)
        } catch {
          finish(null)
        }
      })
    } catch {
      finish(null)
    }
  })
}
