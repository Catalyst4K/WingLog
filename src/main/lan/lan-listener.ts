/**
 * One port for two servers (winglog-backend's docs/plans/security-audit-v2.md, step 22, decision D3 a): the second-screen server's plain
 * HTTP and WebSocket for phones, and its TLS server for twins. Each connection is sent to one of them by its first byte, so the pilot still
 * has one address and one port. A TLS handshake starts with byte 0x16, and HTTP never does.
 *
 * It owns the listening socket and every connection it has accepted, so closing it leaves nothing open, whichever server a connection
 * was handed to.
 */

import type { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { logger } from '../logging/logger'
import type { HostIdentity } from './host-identity-store'

/** The first byte of a TLS handshake (a "handshake" record). */
const TLS_HANDSHAKE_BYTE = 0x16

/** What a connection can be handed to: an `http.Server` or `https.Server` that is not listening itself. */
export type ConnectionTarget = Pick<EventEmitter, 'emit'> & { close?: () => unknown }

/** What the listener routes to. */
export interface LanListenerTargets {
  /** Takes every connection that does not start a TLS handshake. */
  plain: ConnectionTarget
  /** Takes the connections that do, or null when there is no TLS server (no identity): they are closed. */
  secure: ConnectionTarget | null
}

/** Listens on one address and port, and routes each connection on its first byte. */
export class LanListener {
  private readonly server: Server
  /** Every connection until it closes, so `close` can end the ones still waiting for a first byte or in a handshake. */
  private readonly sockets = new Set<Socket>()

  /**
   * @param targets Where connections go.
   * @param waitMs How long a connection may send nothing at all before it is closed, in milliseconds.
   */
  constructor(
    private readonly targets: LanListenerTargets,
    private readonly waitMs: number
  ) {
    this.server = createServer((socket) => this.route(socket))
    // A server that is never asked to listen would not start the header and request timeouts a listening one has.
    this.targets.plain.emit('listening')
    this.targets.secure?.emit('listening')
  }

  /**
   * @param address The address to bind.
   * @param port The port.
   * @returns Resolves once listening; rejects with the listen error (such as the port being in use).
   */
  listen(address: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, address, () => {
        this.server.off('error', reject)
        this.server.on('error', (error) => logger.warn('[lan] server error:', error))
        resolve()
      })
    })
  }

  /**
   * Stops listening and closes every connection.
   *
   * @returns Resolves when the listening socket is closed.
   */
  close(): Promise<void> {
    this.targets.plain.close?.()
    this.targets.secure?.close?.()
    return new Promise((resolve) => {
      if (!this.server.listening) {
        this.destroyAll()
        resolve()
        return
      }
      this.server.close(() => resolve())
      this.destroyAll()
    })
  }

  private destroyAll(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  /**
   * Waits for a connection's first byte, then hands it to the server that speaks what that byte starts. The byte is put back first, so the
   * server reads the connection from its start.
   *
   * @param socket The new connection.
   */
  private route(socket: Socket): void {
    this.sockets.add(socket)
    const silence = setTimeout(() => socket.destroy(), this.waitMs)
    const onError = (): void => undefined
    const onReadable = (): void => {
      const first = socket.read(1) as Buffer | null
      if (first === null) return
      socket.off('readable', onReadable)
      socket.off('error', onError)
      clearTimeout(silence)
      socket.unshift(first)
      const target = first[0] === TLS_HANDSHAKE_BYTE ? this.targets.secure : this.targets.plain
      if (target === null) socket.destroy()
      else target.emit('connection', socket)
    }
    socket.on('error', onError)
    socket.on('readable', onReadable)
    socket.once('close', () => {
      clearTimeout(silence)
      this.sockets.delete(socket)
    })
  }
}

/**
 * The twins' TLS server: TLS 1.3 only, with the sim PC's identity. It answers every plain request with 404 (only twins' WebSocket upgrades
 * are served on it) and is never asked to listen: the listener hands it connections.
 *
 * @param identity The sim PC's key and certificate.
 * @param handshakeTimeoutMs How long a connection may take over its handshake before it is closed, in milliseconds.
 * @param onUpgrade Called with each WebSocket upgrade request.
 * @param onClientError Called when a connection fails its handshake.
 * @returns The server.
 */
export function createTlsServer(
  identity: HostIdentity,
  handshakeTimeoutMs: number,
  onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  onClientError: (error: Error) => void
): HttpsServer {
  const server = createHttpsServer(
    {
      key: identity.keyPem,
      cert: identity.certPem,
      minVersion: 'TLSv1.3',
      handshakeTimeout: handshakeTimeoutMs
    },
    (_req, res) => res.writeHead(404).end()
  )
  server.on('upgrade', onUpgrade)
  server.on('tlsClientError', onClientError)
  return server
}
