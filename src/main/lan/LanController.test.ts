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
  open: Record<string, boolean> = { screen: false, twin: false }
  disconnected: number[] = []
  disconnectedKinds: string[] = []
  pairingOpen(kind: string): boolean {
    return this.open[kind] ?? false
  }
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
  opened: string[] = []
  openPairing(kind: string) {
    this.open[kind] = true
    this.opened.push(kind)
    return { code: kind === 'twin' ? '654321' : '123456', expiresAt: 1_000_000 + 300_000 }
  }
  closePairing(kind: string): void {
    this.open[kind] = false
  }
  disconnectKind(kind: string): void {
    this.disconnectedKinds.push(kind)
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
  let settings: LanSettings = { enabled: false, port: 8765, twinEnabled: false, ...initial }
  let network = interfaces
  let route: string | null = null
  let clock = 1_000_000
  const devices: LanDevice[] = [{ id: 1, kind: 'screen', name: 'iPad', createdAt: 'x', lastSeenAt: null }]
  const revoke = vi.fn((id: number) => devices.some((d) => d.id === id))
  const controller = new LanController({
    server,
    settings: { get: () => settings, set: (s) => (settings = s) },
    addresses: () => listLanAddresses(network),
    routeAddress: () => Promise.resolve(route),
    devices: { list: () => devices, revoke },
    now: () => clock
  })
  return {
    server,
    controller,
    revoke,
    settings: () => settings,
    setNetwork: (n: Record<string, NetworkInterfaceInfo[] | undefined>) => (network = n),
    setRoute: (address: string | null) => (route = address),
    advance: (ms: number) => (clock += ms)
  }
}

describe('LanController', () => {
  it('does nothing while switched off, but still lists the devices', async () => {
    const { controller, server } = setup()
    await controller.sync()
    expect(server.starts).toEqual([])
    const status = controller.getStatus()
    expect(status).toMatchObject({ listening: false, url: null, problem: null, pairing: null })
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
    expect((await controller.applySettings({ enabled: true, port: 8765 })).listening).toBe(true)
    expect(settings().enabled).toBe(true)
    expect((await controller.applySettings({ enabled: false, port: 8765 })).listening).toBe(false)
    expect(server.stops).toBe(1)
  })

  it('moves to the new port when it changes, and leaves a running server alone otherwise', async () => {
    const { controller, server } = setup({ enabled: true })
    await controller.sync()
    await controller.sync()
    expect(server.starts).toHaveLength(1)
    await controller.applySettings({ enabled: true, port: 9100 })
    expect(server.starts).toEqual([
      ['192.168.1.136', 8765],
      ['192.168.1.136', 9100]
    ])
    expect(server.stops).toBe(1)
  })

  it('rebinds when the PC gets a new address (DHCP)', async () => {
    const { controller, server, setNetwork } = setup({ enabled: true })
    await controller.sync()
    setNetwork({ Ethernet: [ipv4('192.168.1.200')] })
    await controller.sync()
    expect(server.starts.map(([address]) => address)).toEqual(['192.168.1.136', '192.168.1.200'])
  })

  it('stops a running server and says so when the network goes away, and starts again when it is back', async () => {
    const { controller, server, setNetwork } = setup({ enabled: true })
    await controller.sync()
    setNetwork({})
    await controller.sync()
    expect(server.listening).toBe(false)
    expect(controller.getStatus().problem).toBe('no-adapter')
    setNetwork({ 'Wi-Fi': [ipv4('192.168.0.9')] })
    await controller.sync()
    expect(controller.getStatus()).toMatchObject({ listening: true, problem: null })
  })

  it('with several real adapters, listens on the one the PC reaches the network through', async () => {
    const two = { Ethernet: [ipv4('192.168.1.10')], 'Wi-Fi': [ipv4('192.168.1.11')] }
    const wifi = setup({ enabled: true }, two)
    wifi.setRoute('192.168.1.11')
    await wifi.controller.sync()
    expect(wifi.server.starts).toEqual([['192.168.1.11', 8765]])
    const none = setup({ enabled: true }, two)
    await none.controller.sync()
    expect(none.server.starts).toEqual([['192.168.1.10', 8765]])
  })

  it('never listens on a virtual adapter, even when that is the route (a VPN)', async () => {
    const { controller, server, setRoute } = setup({ enabled: true })
    setRoute('172.28.64.1')
    await controller.sync()
    expect(server.starts).toEqual([['192.168.1.136', 8765]])
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

    it('stops showing a code once the server has used it', async () => {
      const { controller, server } = setup({ enabled: true })
      await controller.sync()
      expect(controller.startPairing().pairing?.code).toBe('123456')
      server.open.screen = false
      expect(controller.getStatus().pairing).toBeNull()
    })

    it('can be closed, and closes when the server stops', async () => {
      const { controller, server } = setup({ enabled: true })
      await controller.sync()
      controller.startPairing()
      expect(controller.stopPairing().pairing).toBeNull()
      expect(server.open.screen).toBe(false)
      controller.startPairing()
      await controller.applySettings({ enabled: false, port: 8765 })
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

describe('the twin kind', () => {
  it('runs the server while either switch is on, and stops it when both are off', async () => {
    const { controller, server } = setup({ twinEnabled: true })
    await controller.init()
    expect(server.listening).toBe(true)
    await controller.applySettings({ twinEnabled: false })
    expect(server.listening).toBe(false)
    await controller.applySettings({ enabled: true })
    expect(server.listening).toBe(true)
    await controller.stop()
  })

  it('keeps the other switch when one card changes its own, and the port stays', async () => {
    const { controller, settings } = setup({ enabled: true, twinEnabled: false, port: 9000 })
    await controller.applySettings({ twinEnabled: true })
    expect(settings()).toEqual({ enabled: true, twinEnabled: true, port: 9000 })
    await controller.applySettings({ enabled: false })
    expect(settings()).toEqual({ enabled: false, twinEnabled: true, port: 9000 })
    await controller.stop()
  })

  it('opens a pairing window for each kind with its own code, and closes one without the other', async () => {
    const { controller, server } = setup({ enabled: true, twinEnabled: true })
    await controller.init()
    expect(controller.startPairing().pairing?.code).toBe('123456')
    const both = controller.startPairing('twin')
    expect(both.twinPairing?.code).toBe('654321')
    expect(both.pairing?.code).toBe('123456')
    expect(server.opened).toEqual(['screen', 'twin'])
    const afterTwinStops = controller.stopPairing('twin')
    expect(afterTwinStops.twinPairing).toBeNull()
    expect(afterTwinStops.pairing?.code).toBe('123456')
    await controller.stop()
  })

  it('opens no window for a kind whose switch is off', async () => {
    const { controller, server } = setup({ enabled: true, twinEnabled: false })
    await controller.init()
    expect(controller.startPairing('twin').twinPairing).toBeNull()
    expect(server.opened).toEqual([])
    await controller.stop()
  })

  it('drops a kind that is switched off: its code closes and its connections end', async () => {
    const { controller, server } = setup({ enabled: true, twinEnabled: true })
    await controller.init()
    controller.startPairing('twin')
    await controller.applySettings({ twinEnabled: false })
    expect(server.disconnectedKinds).toEqual(['twin'])
    expect(controller.getStatus().twinPairing).toBeNull()
    await controller.stop()
  })
})

describe('parseSettings', () => {
  it('accepts a complete setting, and ignores an adapter an older version stored', () => {
    const none = { enabled: false, port: 8765, twinEnabled: false }
    expect(parseSettings({ enabled: true, port: 8765 }, none)).toEqual({
      enabled: true,
      port: 8765,
      twinEnabled: false
    })
    expect(parseSettings({ enabled: false, adapter: 'Wi-Fi', port: 1024 }, none)).toEqual({
      enabled: false,
      port: 1024,
      twinEnabled: false
    })
  })

  it('refuses anything else, including privileged and out-of-range ports', () => {
    const bad: unknown[] = [
      null,
      'on',
      { enabled: 'yes', port: 8765 },
      { twinEnabled: 'yes' },
      { enabled: true, port: 80 },
      { enabled: true, port: 1023 },
      { enabled: true, port: 65536 },
      { enabled: true, port: 8765.5 },
      { enabled: true, port: '8765' }
    ]
    for (const value of bad)
      expect(() => parseSettings(value, { enabled: false, port: 8765, twinEnabled: false })).toThrow(
        'Invalid second-screen settings'
      )
  })
})
