import { describe, expect, it, vi } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import type { LanDevice, LanSettings } from '@shared/ipc'
import { listLanAddresses } from './adapters'
import { LanController, parseSettings, type LanServerPort } from './LanController'

function ipv4(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`
  }
}

// The development PC: the LAN on Ethernet and WSL's virtual switch.
const THIS_PC = { Ethernet: [ipv4('192.168.1.136')], 'vEthernet (WSLCore)': [ipv4('172.28.64.1')] }

class FakeServer implements LanServerPort {
  listening = false
  connectionCount = 0
  starts: [string, number][] = []
  stops = 0
  failWith: (Error & { code?: string }) | null = null
  pairingOpen = false
  disconnected: number[] = []
  start(address: string, port: number): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith)
    this.listening = true
    this.starts.push([address, port])
    return Promise.resolve()
  }
  stop(): Promise<void> {
    this.listening = false
    this.stops += 1
    return Promise.resolve()
  }
  openPairing() {
    this.pairingOpen = true
    return { code: '123456', expiresAt: 1_000_000 + 300_000 }
  }
  closePairing(): void {
    this.pairingOpen = false
  }
  disconnectDevice(id: number): void {
    this.disconnected.push(id)
  }
}

function setup(
  initial: Partial<LanSettings> = {},
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = THIS_PC
) {
  const server = new FakeServer()
  let settings: LanSettings = { enabled: false, adapter: null, port: 8765, ...initial }
  let network = interfaces
  let clock = 1_000_000
  const devices: LanDevice[] = [{ id: 1, name: 'iPad', createdAt: 'x', lastSeenAt: null }]
  const revoke = vi.fn((id: number) => devices.some((d) => d.id === id))
  const controller = new LanController({
    server,
    settings: { get: () => settings, set: (s) => (settings = s) },
    addresses: () => listLanAddresses(network),
    devices: { list: () => devices, revoke },
    now: () => clock
  })
  return {
    server,
    controller,
    revoke,
    settings: () => settings,
    setNetwork: (n: Record<string, NetworkInterfaceInfo[] | undefined>) => (network = n),
    advance: (ms: number) => (clock += ms)
  }
}

describe('LanController', () => {
  it('does nothing while switched off, but still lists the addresses and devices', async () => {
    const { controller, server } = setup()
    await controller.sync()
    expect(server.starts).toEqual([])
    const status = controller.getStatus()
    expect(status).toMatchObject({ listening: false, url: null, problem: null, pairing: null })
    expect(status.addresses).toEqual([
      { adapter: 'Ethernet', address: '192.168.1.136', virtual: false },
      { adapter: 'vEthernet (WSLCore)', address: '172.28.64.1', virtual: true }
    ])
    expect(status.devices).toHaveLength(1)
  })

  it('listens on the only real adapter, never the WSL one, when switched on', async () => {
    const { controller, server } = setup({ enabled: true })
    await controller.init()
    await controller.stop()
    expect(server.starts).toEqual([['192.168.1.136', 8765]])
  })

  it('reports the URL a device opens', async () => {
    const { controller } = setup({ enabled: true, port: 9000 })
    await controller.sync()
    expect(controller.getStatus()).toMatchObject({
      listening: true,
      url: 'http://192.168.1.136:9000/',
      problem: null
    })
  })

  it('applies new settings: switch on, then off', async () => {
    const { controller, server, settings } = setup()
    expect((await controller.applySettings({ enabled: true, adapter: null, port: 8765 })).listening).toBe(
      true
    )
    expect(settings().enabled).toBe(true)
    expect((await controller.applySettings({ enabled: false, adapter: null, port: 8765 })).listening).toBe(
      false
    )
    expect(server.stops).toBe(1)
  })

  it('moves to the new port when it changes, and leaves a running server alone otherwise', async () => {
    const { controller, server } = setup({ enabled: true })
    await controller.sync()
    await controller.sync()
    expect(server.starts).toHaveLength(1)
    await controller.applySettings({ enabled: true, adapter: null, port: 9100 })
    expect(server.starts).toEqual([
      ['192.168.1.136', 8765],
      ['192.168.1.136', 9100]
    ])
    expect(server.stops).toBe(1)
  })

  it('rebinds when the address of the chosen adapter changes (DHCP)', async () => {
    const { controller, server, setNetwork } = setup({ enabled: true, adapter: 'Ethernet' })
    await controller.sync()
    setNetwork({ Ethernet: [ipv4('192.168.1.200')] })
    await controller.sync()
    expect(server.starts.map(([address]) => address)).toEqual(['192.168.1.136', '192.168.1.200'])
  })

  it('stops listening and says so when the chosen adapter has gone', async () => {
    const { controller, server, setNetwork } = setup({ enabled: true, adapter: 'Wi-Fi' })
    setNetwork({ Other: [ipv4('192.168.0.9')] })
    await controller.sync()
    expect(server.listening).toBe(false)
    expect(controller.getStatus().problem).toBe('choose-adapter')
    setNetwork({ 'Wi-Fi': [ipv4('192.168.0.9')] })
    await controller.sync()
    expect(controller.getStatus()).toMatchObject({ listening: true, problem: null })
  })

  it('stops a running server when its adapter goes away', async () => {
    const { controller, server, setNetwork } = setup({ enabled: true, adapter: 'Ethernet' })
    await controller.sync()
    setNetwork({})
    await controller.sync()
    expect(server.listening).toBe(false)
    expect(controller.getStatus().problem).toBe('choose-adapter')
  })

  it('asks the pilot to choose when there are several real adapters', async () => {
    const { controller, server } = setup(
      { enabled: true },
      { Ethernet: [ipv4('192.168.1.10')], 'Wi-Fi': [ipv4('192.168.1.11')] }
    )
    await controller.sync()
    expect(server.listening).toBe(false)
    expect(controller.getStatus().problem).toBe('choose-adapter')
  })

  it('says there is no private network when there is none', async () => {
    const { controller } = setup({ enabled: true }, {})
    await controller.sync()
    expect(controller.getStatus().problem).toBe('no-adapter')
  })

  it('reports a port that is already in use, and a failure to listen for any other reason', async () => {
    const { controller, server } = setup({ enabled: true })
    server.failWith = Object.assign(new Error('in use'), { code: 'EADDRINUSE' })
    await controller.sync()
    expect(controller.getStatus()).toMatchObject({ listening: false, problem: 'port-in-use' })
    server.failWith = new Error('boom')
    await controller.sync()
    expect(controller.getStatus().problem).toBe('failed')
    server.failWith = null
    await controller.sync()
    expect(controller.getStatus()).toMatchObject({ listening: true, problem: null })
  })

  describe('pairing', () => {
    it('opens a window only while listening, and shows the code until it expires', async () => {
      const { controller, advance } = setup({ enabled: true })
      expect(controller.startPairing().pairing).toBeNull()
      await controller.sync()
      expect(controller.startPairing().pairing).toEqual({ code: '123456', expiresAt: 1_300_000 })
      expect(controller.getStatus().pairing?.code).toBe('123456')
      advance(300_001)
      expect(controller.getStatus().pairing).toBeNull()
    })

    it('can be closed, and closes when the server stops', async () => {
      const { controller, server } = setup({ enabled: true })
      await controller.sync()
      controller.startPairing()
      expect(controller.stopPairing().pairing).toBeNull()
      expect(server.pairingOpen).toBe(false)
      controller.startPairing()
      await controller.applySettings({ enabled: false, adapter: null, port: 8765 })
      expect(controller.getStatus().pairing).toBeNull()
    })
  })

  describe('devices', () => {
    it('revokes a device and drops its connections', () => {
      const { controller, server, revoke } = setup({ enabled: true })
      controller.revokeDevice(1)
      expect(revoke).toHaveBeenCalledWith(1)
      expect(server.disconnected).toEqual([1])
    })

    it('ignores an id that is not a whole number or that is not paired', () => {
      const { controller, server } = setup()
      for (const id of ['1', 1.5, null, undefined, {}, 99]) controller.revokeDevice(id)
      expect(server.disconnected).toEqual([])
    })
  })

  it('serialises overlapping syncs so the server is never started twice at once', async () => {
    const { controller, server } = setup({ enabled: true })
    await Promise.all([controller.sync(), controller.sync(), controller.sync()])
    expect(server.starts).toHaveLength(1)
  })
})

describe('parseSettings', () => {
  it('accepts a complete setting, an empty adapter meaning "the only real one"', () => {
    expect(parseSettings({ enabled: true, adapter: 'Wi-Fi', port: 8765 })).toEqual({
      enabled: true,
      adapter: 'Wi-Fi',
      port: 8765
    })
    expect(parseSettings({ enabled: false, adapter: '', port: 1024 })).toEqual({
      enabled: false,
      adapter: null,
      port: 1024
    })
  })

  it('refuses anything else, including privileged and out-of-range ports', () => {
    const bad: unknown[] = [
      null,
      'on',
      {},
      { enabled: 'yes', adapter: null, port: 8765 },
      { enabled: true, adapter: 5, port: 8765 },
      { enabled: true, adapter: 'x'.repeat(201), port: 8765 },
      { enabled: true, adapter: null, port: 80 },
      { enabled: true, adapter: null, port: 1023 },
      { enabled: true, adapter: null, port: 65536 },
      { enabled: true, adapter: null, port: 8765.5 },
      { enabled: true, adapter: null, port: '8765' }
    ]
    for (const value of bad) expect(() => parseSettings(value)).toThrow('Invalid second-screen settings')
  })
})
