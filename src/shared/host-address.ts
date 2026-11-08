/**
 * The address of the sim PC's WingLog, as a person types it or copies it from the host's Second screen card (winglog-backend's
 * docs/plans/multi-device.md, Part 2). A client only ever connects to a computer on the home network: a private IPv4 address, this
 * computer, or a local name, never an address on the internet. Pure so each case is tested without a network.
 */

/** A host name label: letters, digits and hyphens, not starting or ending with a hyphen. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i

/**
 * @param host Four dot-separated numbers.
 * @returns True for 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x (link-local) and 127.x.x.x (this computer).
 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false
  const [a, b] = parts.map(Number) as [number, number, number, number]
  if (parts.some((part) => Number(part) > 255)) return false
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

/**
 * @param host A host name.
 * @returns True for a single label (a name on the home network, such as `simpc`), `localhost`, or a name ending `.local`.
 */
function isLocalName(host: string): boolean {
  const labels = host.split('.')
  if (!labels.every((label) => LABEL.test(label))) return false
  return labels.length === 1 || labels.at(-1)?.toLowerCase() === 'local'
}

/**
 * Reads what was typed into the address field.
 *
 * @param text The address: `192.168.1.20:5051`, or the page address the host shows (`http://192.168.1.20:5051/`), with or without the `http://`.
 * @returns The `host:port` to connect to, or null when it is not a home-network address with a port.
 */
export function parseHostAddress(text: string): string | null {
  const bare = text
    .trim()
    .replace(/^(https?|wss?):\/\//i, '')
    .replace(/\/live\/?$/i, '')
    .replace(/\/+$/, '')
  const match = /^([^:/\s]+):(\d{1,5})$/.exec(bare)
  if (!match) return null
  const host = match[1] as string
  const port = Number(match[2])
  if (port < 1 || port > 65535) return null
  return isPrivateIpv4(host) || isLocalName(host) ? `${host}:${port}` : null
}
