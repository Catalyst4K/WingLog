/** Opens the `ws` client as the `LinkSocket` the shared connection logic expects (the browser's WebSocket has the same shape). */

import WebSocket from 'ws'
import type { LinkSocket } from '@shared/lan-connection'

/** How long to wait for the host to accept the connection before giving up on this attempt, in milliseconds. */
const HANDSHAKE_TIMEOUT_MS = 10_000

/**
 * @param url The host's WebSocket address (`ws://host:port/live`).
 * @returns The socket, opening now. Its handlers are set by the caller before the connection completes.
 */
export function openHostSocket(url: string): LinkSocket {
  // No Origin header is sent, which the host's upgrade check allows (it only refuses an Origin that names another server).
  const socket = new WebSocket(url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS, maxPayload: 8 * 1024 * 1024 })
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
