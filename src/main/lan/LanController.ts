/**
 * Runs the second-screen server according to the pilot's settings (winglog-backend's docs/plans/lan-web-viewer.md): starts it on the
 * PC's home-network address when it is switched on, moves it when the address changes, stops it when switched off, and tells Settings what state it
 * is in. Everything it touches arrives as a dependency so it can be tested without a network.
 */

import type { LanDevice, LanDeviceKind, LanPairing, LanProblem, LanSettings, LanStatus } from '@shared/ipc'
import { isValidLanPort } from '../db/settings-repo'
import { logger } from '../logging/logger'
import { chooseAddress, type LanAddress } from './adapters'

/** How often the controller checks that the home-network address it listens on is still the PC's. */
export const ADDRESS_CHECK_MS = 15_000

/** The part of `LanServer` the controller uses. */
export interface LanServerPort {
  readonly listening: boolean
  readonly connectionCount: number
  /** Whether a kind's pairing window is still open (a used code is not). */
  pairingOpen(kind: LanDeviceKind): boolean
  start(address: string, port: number): Promise<void>
  stop(): Promise<void>
  openPairing(kind: LanDeviceKind): { code: string; expiresAt: number }
  closePairing(kind: LanDeviceKind): void
  disconnectDevice(deviceId: number): void
  /** Drops every open connection of a kind of device (its switch was turned off). */
  disconnectKind(kind: LanDeviceKind): void
}

/** What the controller is given. */
export interface LanControllerDeps {
  server: LanServerPort
  settings: { get(): LanSettings; set(settings: LanSettings): void }
  /** The private addresses on this machine, real adapters first (`listLanAddresses` over the OS's interfaces). */
  addresses(): LanAddress[]
  /** The local address of the default route (`defaultRouteAddress`), or null when the PC has no route. */
  routeAddress(): Promise<string | null>
  devices: { list(): LanDevice[]; revoke(id: number): boolean }
  now(): number
}

/** Runs the second-screen server to match the settings and the machine's network. */
export class LanController {
  private problem: LanProblem | null = null
  private boundTo: { address: string; port: number } | null = null
  /** The open pairing window of each kind (a second screen and a twin pair with their own codes). */
  private readonly pairings: Record<LanDeviceKind, LanPairing | null> = { screen: null, twin: null }
  private timer: NodeJS.Timeout | null = null
  /** Starts and stops are queued so two never overlap. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: LanControllerDeps) {}

  /** Starts the server if it was left on, and begins watching the address. */
  async init(): Promise<void> {
    await this.sync()
    this.timer = setInterval(() => {
      this.sync().catch(() => undefined)
    }, ADDRESS_CHECK_MS)
    this.timer.unref()
  }

  /** Stops watching and stops the server (the app is quitting). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.enqueue(async () => {
      this.pairings.screen = null
      this.pairings.twin = null
      await this.deps.server.stop()
      this.boundTo = null
    })
  }

  /**
   * Makes the server match the settings and the machine's addresses now: starts, moves or stops it as needed.
   *
   * @returns Resolves when done; never rejects (a failure becomes the status's problem).
   */
  sync(): Promise<void> {
    return this.enqueue(() => this.reconcile())
  }

  /**
   * Stores new settings and applies them.
   *
   * @param value Settings from the window, unchecked.
   * @returns The new status.
   * @throws When the settings aren't valid.
   */
  async applySettings(value: unknown): Promise<LanStatus> {
    const before = this.deps.settings.get()
    const settings = parseSettings(value, before)
    this.deps.settings.set(settings)
    // A kind whose switch is turned off loses its open connections and its pairing code at once.
    if (before.enabled && !settings.enabled) this.dropKind('screen')
    if (before.twinEnabled && !settings.twinEnabled) this.dropKind('twin')
    await this.sync()
    return this.getStatus()
  }

  /** @returns The status: settings, addresses, whether it is listening and why not, pairing and devices. */
  getStatus(): LanStatus {
    const settings = this.deps.settings.get()
    const { server } = this.deps
    for (const kind of ['screen', 'twin'] as const) {
      const open = this.pairings[kind]
      if (open && (open.expiresAt <= this.deps.now() || !server.pairingOpen(kind))) this.pairings[kind] = null
    }
    return {
      settings,
      listening: server.listening,
      url: server.listening && this.boundTo ? `http://${this.boundTo.address}:${this.boundTo.port}/` : null,
      problem: this.problem,
      connections: server.connectionCount,
      pairing: server.listening ? this.pairings.screen : null,
      twinPairing: server.listening ? this.pairings.twin : null,
      devices: this.deps.devices.list()
    }
  }

  /**
   * @param kind A second screen (the default) or a twin, unchecked: anything else is a second screen.
   * @returns The status with a new pairing code of that kind open, or without one when the server isn't listening or that kind is off.
   */
  startPairing(kind?: unknown): LanStatus {
    const which = kindOf(kind)
    const settings = this.deps.settings.get()
    const on = which === 'twin' ? settings.twinEnabled : settings.enabled
    if (this.deps.server.listening && on) this.pairings[which] = this.deps.server.openPairing(which)
    return this.getStatus()
  }

  /**
   * @param kind A second screen (the default) or a twin, unchecked.
   * @returns The status with that kind's pairing closed.
   */
  stopPairing(kind?: unknown): LanStatus {
    const which = kindOf(kind)
    this.deps.server.closePairing(which)
    this.pairings[which] = null
    return this.getStatus()
  }

  private dropKind(kind: LanDeviceKind): void {
    this.deps.server.closePairing(kind)
    this.pairings[kind] = null
    this.deps.server.disconnectKind(kind)
  }

  /**
   * Revokes a device and drops its open connections.
   *
   * @param id The device, unchecked.
   * @returns The status.
   */
  revokeDevice(id: unknown): LanStatus {
    if (typeof id === 'number' && Number.isInteger(id) && this.deps.devices.revoke(id)) {
      this.deps.server.disconnectDevice(id)
    }
    return this.getStatus()
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async reconcile(): Promise<void> {
    const settings = this.deps.settings.get()
    const { server } = this.deps
    // One server for both kinds of device: it runs while either switch is on.
    if (!settings.enabled && !settings.twinEnabled) {
      this.problem = null
      if (server.listening) await this.release()
      return
    }
    const target = chooseAddress(this.deps.addresses(), await this.deps.routeAddress())
    if (!target) {
      if (server.listening) await this.release()
      this.problem = 'no-adapter'
      return
    }
    if (server.listening && this.boundTo?.address === target.address && this.boundTo.port === settings.port) {
      this.problem = null
      return
    }
    if (server.listening) await this.release()
    await this.listen(target, settings.port)
  }

  private async release(): Promise<void> {
    this.pairings.screen = null
    this.pairings.twin = null
    await this.deps.server.stop()
    this.boundTo = null
  }

  private async listen(target: LanAddress, port: number): Promise<void> {
    try {
      await this.deps.server.start(target.address, port)
      this.boundTo = { address: target.address, port }
      this.problem = null
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      this.problem = code === 'EADDRINUSE' ? 'port-in-use' : 'failed'
      logger.warn(`[lan] could not listen on ${target.address}:${port}:`, error)
    }
  }
}

/**
 * @param value A kind from the window.
 * @returns The kind; a second screen unless it is exactly `twin`.
 */
function kindOf(value: unknown): LanDeviceKind {
  return value === 'twin' ? 'twin' : 'screen'
}

/**
 * Reads the settings from the window. A field left out keeps its stored value, so the Second screen card and the Sim PC page can each
 * change their own switch without knowing the other's.
 *
 * @param value Settings from the window.
 * @param current The stored settings.
 * @returns The checked settings.
 * @throws When anything is the wrong shape or the port isn't an unprivileged one.
 */
export function parseSettings(value: unknown, current: LanSettings): LanSettings {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  if (!record) throw new Error('Invalid second-screen settings')
  const enabled = record.enabled ?? current.enabled
  const twinEnabled = record.twinEnabled ?? current.twinEnabled
  const port = record.port ?? current.port
  if (typeof enabled !== 'boolean' || typeof twinEnabled !== 'boolean' || !isValidLanPort(port)) {
    throw new Error('Invalid second-screen settings')
  }
  return { enabled, twinEnabled, port }
}
