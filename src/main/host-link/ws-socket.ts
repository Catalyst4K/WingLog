/** Opens the `ws` client as the `LinkSocket` the shared connection logic expects (the browser's WebSocket has the same shape). */

import { isIP } from 'node:net'
import WebSocket from 'ws'
import { isHomeNetworkAddress } from '@shared/host-address'
import type { LinkSocket } from '@shared/lan-connection'
import { logger } from '../logging/logger'
import { homeNetworkLookup } from './home-lookup'

/** How long to wait for the host to accept the connection before giving up on this attempt, in milliseconds. */
const HANDSHAKE_TIMEOUT_MS = 10_000

/** A WebSocket's `readyState` once it is closed. */
const CLOSED = 3

/**
 * @param url The host's WebSocket address.
 * @returns The address it names when that is typed as a number (an IPv6 one without its brackets), or null for a name.
 */
function literalAddress(url: string): string | null {
  // The URL parser writes every way of typing an IPv4 address (0x7f.1, 2130706433) in its usual form, so the check sees what is connected to.
  const host = new URL(url).hostname.replace(/^\[(.*)\]$/, '$1')
  return isIP(host) === 0 ? null : host
}

/**
 * @param address The address that was refused.
 * @returns A socket that never opened: it is closed, and says so once its handlers are set.
 */
function refusedSocket(address: string): LinkSocket {
  logger.warn(`[host-link] not connecting to ${address}: it is outside the home network`)
  const link: LinkSocket = {
    readyState: CLOSED,
    send: () => undefined,
    close: () => undefined,
    onopen: null,
    onmessage: null,
    onclose: null
  }
  setImmediate(() => link.onclose?.(undefined as never))
  return link
}

/**
 * @param url The host's WebSocket address (`ws://host:port/live`).
 * @returns The socket, opening now. Its handlers are set by the caller before the connection completes. An address typed as a number that is
 *   not on the home network is never connected to: the socket comes back closed (audit L8; Node does not call `lookup` for such an address).
 */
export function openHostSocket(url: string): LinkSocket {
  const literal = literalAddress(url)
  if (literal !== null && !isHomeNetworkAddress(literal)) return refusedSocket(literal)
  // No Origin header is sent, which the host's upgrade check allows (it only refuses an Origin that names another server).
  const socket = new WebSocket(url, {
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    maxPayload: 8 * 1024 * 1024,
    // The name is looked up here, and the connection goes to an address that was checked as being on the home network (audit L8).
    lookup: homeNetworkLookup() as never
  })
  const link: LinkSocket = {
    get readyState() {
      return socket.readyState
    },
    send: (text) => socket.send(text),
    close: () => socket.close(),
    onopen: null,
    onmessage: null,
    onclose: null
  }
  socket.on('open', () => link.onopen?.(undefined as never))
  socket.on('message', (data, isBinary) => {
    if (!isBinary) link.onmessage?.({ data: data.toString() } as never)
  })
  socket.on('close', () => link.onclose?.(undefined as never))
  // A failed connection is followed by `close`, which is what the link reacts to.
  socket.on('error', () => undefined)
  return link
}
