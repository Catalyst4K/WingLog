/**
 * Runs the second-screen server according to the pilot's settings (winglog-backend's docs/plans/lan-web-viewer.md): starts it on the
 * PC's home-network address when it is switched on, moves it when the address changes, stops it when switched off, and tells Settings what state it
 * is in. Everything it touches arrives as a dependency so it can be tested without a network.
 */

import type { LanDevice, LanPairing, LanProblem, LanSettings, LanStatus } from '@shared/ipc'
import { isValidLanPort } from '../db/settings-repo'
import { logger } from '../logging/logger'
import { chooseAddress, type LanAddress } from './adapters'

/** How often the controller checks that the home-network address it listens on is still the PC's. */
export const ADDRESS_CHECK_MS = 15_000

/** The part of `LanServer` the controller uses. */
export interface LanServerPort {
  readonly listening: boolean
  readonly connectionCount: number
  /** Whether a pairing window is still open (a used code is not). */
  readonly pairingOpen: boolean
  start(address: string, port: number): Promise<void>
  stop(): Promise<void>
  openPairing(): { code: string; expiresAt: number }
  closePairing(): void
  disconnectDevice(deviceId: number): void
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
  private pairing: LanPairing | null = null
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
      this.pairing = null
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
    const settings = parseSettings(value)
    this.deps.settings.set(settings)
    await this.sync()
    return this.getStatus()
  }

  /** @returns The status: settings, addresses, whether it is listening and why not, pairing and devices. */
  getStatus(): LanStatus {
    const settings = this.deps.settings.get()
    const { server } = this.deps
    if (this.pairing && (this.pairing.expiresAt <= this.deps.now() || !server.pairingOpen))
      this.pairing = null
    return {
      settings,
      listening: server.listening,
      url: server.listening && this.boundTo ? `http://${this.boundTo.address}:${this.boundTo.port}/` : null,
      problem: this.problem,
      connections: server.connectionCount,
      pairing: server.listening ? this.pairing : null,
      devices: this.deps.devices.list()
    }
  }

  /** @returns The status with a new pairing code open, or without one when the server isn't listening. */
  startPairing(): LanStatus {
    if (this.deps.server.listening) this.pairing = this.deps.server.openPairing()
    return this.getStatus()
  }

  /** @returns The status with pairing closed. */
  stopPairing(): LanStatus {
    this.deps.server.closePairing()
    this.pairing = null
    return this.getStatus()
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
    if (!settings.enabled) {
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
    this.pairing = null
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
 * @param value Settings from the window.
 * @returns The checked settings.
 * @throws When anything is the wrong shape or the port isn't an unprivileged one.
 */
export function parseSettings(value: unknown): LanSettings {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  if (!record || typeof record.enabled !== 'boolean' || !isValidLanPort(record.port)) {
    throw new Error('Invalid second-screen settings')
  }
  return { enabled: record.enabled, port: record.port }
}
