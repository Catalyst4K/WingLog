/**
 * Opens the `ws` client as the `LinkSocket` the shared connection logic expects (the browser's WebSocket has the same shape), over TLS
 * with the sim PC's certificate checked by its pin (winglog-backend's docs/plans/security-audit-v2.md, step 22). This file is the only place
 * the certificate is checked.
 */

import { isIP } from 'node:net'
import { connect, type ConnectionOptions, type TLSSocket } from 'node:tls'
import WebSocket from 'ws'
import { isHomeNetworkAddress } from '@shared/host-address'
import type { LinkSocket } from '@shared/lan-connection'
import { certificatePin } from '../lan/host-certificate'
import { logger } from '../logging/logger'
import { homeNetworkLookup } from './home-lookup'

/** Why a connection was refused before anything was sent over it. */
export type SocketRefusal = 'certificate-changed' | 'not-secure'

/** What the twin knows of the sim PC's certificate, and how it is told what the connection found. */
export interface SocketPin {
  /** The pin the certificate must have, or null on a pairing connection from typed text, which accepts the one shown and reports it. */
  expected: string | null
  /** Called with the pin of the certificate shown, when `expected` is null and the connection goes on. */
  onCertificate(pin: string): void
  /** Called when the connection was refused: the certificate is not the expected one, or the far end did not answer in TLS. */
  onRefused(reason: SocketRefusal): void
}

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
 * @param pin What to check the certificate against, and who to tell.
 * @returns A `createConnection` for `ws`: a TLS 1.3 connection whose certificate is checked by its pin when the handshake ends.
 */
function pinnedConnection(pin: SocketPin): (options: ConnectionOptions) => TLSSocket {
  return (options) => {
    // The certificate is self-signed, so there is no chain to check and Node's own check is switched off. This is safe because the leaf
    // certificate is pinned by its SHA-256 just below, before anything is sent over the connection. `checkServerIdentity` is not an option:
    // Node never calls it for a self-signed certificate once this is off.
    const socket = connect({
      ...options,
      path: undefined,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      servername: isIP(options.host ?? '') ? '' : options.host
    })
    let secure = false
    socket.once('secureConnect', () => {
      secure = true
      const raw = socket.getPeerCertificate().raw as Buffer | undefined
      const seen = raw ? certificatePin(raw) : null
      if (seen === null || (pin.expected !== null && seen !== pin.expected)) {
        socket.destroy()
        pin.onRefused('certificate-changed')
      } else if (pin.expected === null) pin.onCertificate(seen)
    })
    // The far end answered something other than TLS (an older sim PC answers its plain port): not a network problem.
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (!secure && isNotTlsError(error)) pin.onRefused('not-secure')
    })
    return socket
  }
}

/**
 * @param error What a connection that has not finished its handshake failed with.
 * @returns True when it failed because the other end does not speak TLS.
 */
function isNotTlsError(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EPROTO' || (error.code?.startsWith('ERR_SSL_') ?? false)
}

/**
 * @param url The host's WebSocket address (`wss://host:port/live`).
 * @param pin What the certificate is checked against, and who is told what the connection found.
 * @returns The socket, opening now. Its handlers are set by the caller before the connection completes. An address typed as a number that is
 *   not on the home network is never connected to: the socket comes back closed (audit L8; Node does not call `lookup` for such an address).
 */
export function openHostSocket(url: string, pin: SocketPin): LinkSocket {
  const literal = literalAddress(url)
  if (literal !== null && !isHomeNetworkAddress(literal)) return refusedSocket(literal)
  // No Origin header is sent, which the host's upgrade check allows (it only refuses an Origin that names another server).
  const socket = new WebSocket(url, {
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    maxPayload: 8 * 1024 * 1024,
    createConnection: pinnedConnection(pin) as never,
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
