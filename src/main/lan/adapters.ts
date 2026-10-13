/**
 * Which of this PC's network addresses the second-screen server may listen on (winglog-backend's docs/plans/lan-web-viewer.md): a
 * private-network IPv4 address on a real Ethernet or Wi-Fi adapter, never `0.0.0.0` and never a virtual adapter a phone can't be on.
 */

import type { NetworkInterfaceInfo } from 'node:os'

/** A private address the server could listen on. */
export interface LanAddress {
  adapter: string
  address: string
  /** `virtual` for Hyper-V, WSL, Docker, VPN and similar adapters: listed, never chosen automatically. */
  kind: 'physical' | 'virtual'
}

/** Adapter names that are not a network a phone can be on. */
const VIRTUAL_ADAPTER =
  /vethernet|wsl|hyper-v|docker|vbox|virtualbox|vmware|vmnet|vpn|tailscale|zerotier|loopback|tun\d|tap\d|utun/i

/**
 * @param address A dotted IPv4 address.
 * @returns True for 10/8, 172.16/12, 192.168/16 and link-local 169.254/16.
 */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false
  const [a, b] = parts
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/**
 * @param interfaces What `os.networkInterfaces()` returned.
 * @returns Every private IPv4 address that isn't internal, physical adapters first, in the order the OS listed them.
 */
export function listLanAddresses(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>
): LanAddress[] {
  const found: LanAddress[] = []
  for (const [adapter, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isPrivateIpv4(entry.address)) continue
      found.push({
        adapter,
        address: entry.address,
        kind: VIRTUAL_ADAPTER.test(adapter) ? 'virtual' : 'physical'
      })
    }
  }
  return [...found.filter((a) => a.kind === 'physical'), ...found.filter((a) => a.kind === 'virtual')]
}

/**
 * Picks the address to listen on: the real adapter this PC reaches the network through (the default route), else the first real
 * adapter. A virtual adapter (WSL, Hyper-V, a VPN) is never picked: a phone can't be on it.
 *
 * @param addresses The list from `listLanAddresses`.
 * @param routeAddress The local address of the default route (`defaultRouteAddress`), or null when there is none.
 * @returns The address, or null when there is no real adapter.
 */
export function chooseAddress(addresses: LanAddress[], routeAddress: string | null): LanAddress | null {
  const physical = addresses.filter((a) => a.kind === 'physical')
  return physical.find((a) => a.address === routeAddress) ?? physical[0] ?? null
}
