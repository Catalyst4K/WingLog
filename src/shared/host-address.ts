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

/** The scheme of the pairing text the host offers to copy. */
const PAIRING_SCHEME = 'winglog-pair://'

/**
 * The text the host offers to copy so another WingLog can pair with one paste: its address and the pairing code.
 *
 * @param address The host's `host:port`.
 * @param code The 6-digit pairing code.
 * @returns For example `winglog-pair://192.168.1.20:5051/123456`.
 */
export function formatPairingText(address: string, code: string): string {
  return `${PAIRING_SCHEME}${address}/${code}`
}

/**
 * Reads what was pasted into the address field: the pairing text, or an address with the code after it (a space, a comma or a slash), or
 * only an address.
 *
 * @param text What was pasted or typed.
 * @returns The home-network address and the code if there was one, or null when there is no usable address.
 */
export function parsePairingText(text: string): { address: string; code: string | null } | null {
  const trimmed = text.trim()
  const body = trimmed.toLowerCase().startsWith(PAIRING_SCHEME)
    ? trimmed.slice(PAIRING_SCHEME.length)
    : trimmed
  const match = /^(\S+?)(?:[\s,/]+(\d{6}))?\/?$/.exec(body)
  if (!match) return null
  const address = parseHostAddress(match[1] as string)
  return address ? { address, code: match[2] ?? null } : null
}

/**
 * @param address An IPv6 address as text.
 * @returns Its eight 16-bit groups, or null when it is not an IPv6 address. An IPv4 tail (`::ffff:192.168.1.5`) is read as two groups.
 */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase()
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)?.[1]
  if (tail) {
    const octets = tail.split('.').map(Number)
    if (octets.some((octet) => octet > 255)) return null
    const [a, b, c, d] = octets as [number, number, number, number]
    text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (part === '') return []
    const groups = part.split(':')
    return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? groups.map((g) => parseInt(g, 16)) : null
  }
  const head = parse(halves[0] as string)
  const rest = halves.length === 2 ? parse(halves[1] as string) : []
  if (!head || !rest) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const missing = 8 - head.length - rest.length
  return missing < 1 ? null : [...head, ...new Array<number>(missing).fill(0), ...rest]
}

/**
 * Whether an address a name resolved to is on the home network (winglog-backend's docs/plans/security-audit-v2.md, L8): a private,
 * link-local or loopback IPv4 address, or the IPv6 loopback, a link-local (`fe80::/10`) or a unique local (`fc00::/7`) address, or an IPv4
 * address of those kinds written as IPv6 (`::ffff:192.168.1.5`). Anything else, including text that is not an address, is not.
 *
 * @param address One address, as text.
 * @returns True when it is on the home network.
 */
export function isHomeNetworkAddress(address: string): boolean {
  if (isPrivateIpv4(address)) return true
  const groups = ipv6Groups(address)
  return groups !== null && isHomeIpv6(groups)
}

/**
 * @param groups The eight 16-bit groups of an IPv6 address.
 * @returns True for the loopback, a link-local or unique local address, or an IPv4-mapped address whose IPv4 is on the home network.
 */
function isHomeIpv6(groups: number[]): boolean {
  const first = groups[0] as number
  const last = groups[7] as number
  const zeros = (from: number, to: number): boolean => groups.slice(from, to).every((group) => group === 0)
  if (zeros(0, 7) && last === 1) return true
  if ((first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00) return true
  if (zeros(0, 5) && groups[5] === 0xffff) {
    const [high, low] = [groups[6] as number, last]
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  return false
}
