import { describe, expect, it } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import { chooseAddress, isPrivateIpv4, listLanAddresses } from './adapters'

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`
  }
}

// The shape of the development PC: the LAN on Ethernet, WSL's virtual switch, loopback, and an IPv6 entry.
const THIS_PC: Record<string, NetworkInterfaceInfo[]> = {
  'vEthernet (WSLCore)': [ipv4('172.28.64.1')],
  Ethernet: [ipv4('192.168.1.136')],
  'Loopback Pseudo-Interface 1': [ipv4('127.0.0.1', true)],
  'Wi-Fi': [{ ...ipv4('fe80::1'), family: 'IPv6' as never }]
}

describe('isPrivateIpv4', () => {
  it('accepts the private and link-local ranges and nothing else', () => {
    for (const address of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.136', '169.254.10.2'])
      expect(isPrivateIpv4(address)).toBe(true)
    for (const address of [
      '8.8.8.8',
      '172.15.0.1',
      '172.32.0.1',
      '192.169.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '0.0.0.0'
    ])
      expect(isPrivateIpv4(address)).toBe(false)
  })

  it('rejects anything that is not a dotted IPv4', () => {
    for (const address of [
      '',
      'fe80::1',
      '192.168.1',
      '192.168.1.1.1',
      '192.168.1.300',
      '192.168.x.1',
      '10.0.0.-1'
    ])
      expect(isPrivateIpv4(address)).toBe(false)
  })
})

describe('listLanAddresses', () => {
  it('lists the real adapter before the virtual one and skips loopback and IPv6', () => {
    expect(listLanAddresses(THIS_PC)).toEqual([
      { adapter: 'Ethernet', address: '192.168.1.136', kind: 'physical' },
      { adapter: 'vEthernet (WSLCore)', address: '172.28.64.1', kind: 'virtual' }
    ])
  })

  it('marks Hyper-V, Docker, VPN and Tailscale adapters as virtual', () => {
    const list = listLanAddresses({
      'Wi-Fi': [ipv4('192.168.0.20')],
      'vEthernet (Default Switch)': [ipv4('172.20.0.1')],
      docker0: [ipv4('172.17.0.1')],
      Tailscale: [ipv4('10.64.0.9')],
      'OpenVPN TAP-Windows': [ipv4('10.8.0.2')]
    })
    expect(list.map((a) => [a.adapter, a.kind])).toEqual([
      ['Wi-Fi', 'physical'],
      ['vEthernet (Default Switch)', 'virtual'],
      ['docker0', 'virtual'],
      ['Tailscale', 'virtual'],
      ['OpenVPN TAP-Windows', 'virtual']
    ])
  })

  it('returns nothing for a PC with no private network', () => {
    expect(listLanAddresses({})).toEqual([])
    expect(listLanAddresses({ Ethernet: undefined })).toEqual([])
    expect(listLanAddresses({ Ethernet: [ipv4('8.8.8.8')] })).toEqual([])
  })
})

describe('chooseAddress', () => {
  const list = listLanAddresses(THIS_PC)

  it('takes the only physical adapter without being asked, even when a virtual one exists', () => {
    expect(chooseAddress(list, null)?.address).toBe('192.168.1.136')
  })

  it("takes the user's saved adapter, including a virtual one they picked on purpose", () => {
    expect(chooseAddress(list, 'vEthernet (WSLCore)')?.address).toBe('172.28.64.1')
  })

  it('does not listen when the saved adapter has gone', () => {
    expect(chooseAddress(list, 'Wi-Fi')).toBeNull()
  })

  it('needs the user to choose when there are several physical adapters', () => {
    const two = listLanAddresses({ Ethernet: [ipv4('192.168.1.10')], 'Wi-Fi': [ipv4('192.168.1.11')] })
    expect(chooseAddress(two, null)).toBeNull()
    expect(chooseAddress(two, 'Wi-Fi')?.address).toBe('192.168.1.11')
  })

  it('has no answer when there is no private network', () => {
    expect(chooseAddress([], null)).toBeNull()
  })
})
