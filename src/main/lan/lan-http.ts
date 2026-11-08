/** The HTTP side of the second-screen server: what its page may load and which web pages may open its socket. */

/**
 * What the page may load: its own files, the map tiles and style from OpenFreeMap, the airline logos from images.kiwi.com (images only,
 * the same service the PC's window uses), and its WebSocket back to this server, nothing else.
 *
 * @param host The host (with port) this server is bound to.
 * @returns The Content-Security-Policy header value.
 */
export function pageSecurityPolicy(host: string): string {
  return [
    "default-src 'self'",
    "img-src 'self' data: blob: https://tiles.openfreemap.org https://images.kiwi.com",
    `connect-src 'self' ws://${host} https://tiles.openfreemap.org`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

/**
 * @param origin The Origin header.
 * @param host The host (with port) this server is bound to.
 * @returns True when the origin is a web page served by this server.
 */
export function originMatches(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
