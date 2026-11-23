/**
 * The sim PC's side of Add a device (winglog-backend's docs/plans/devices-page.md, step 4): open a kind's pairing code (turning its switch
 * on first if it was off), keep a phone's code fresh until Close, notice the new device when it appears, and close the code again.
 */

import { useRef, useState } from 'react'
import type { LanDeviceKind, LanStatus } from '@shared/ipc'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'
import { useLanStatus } from './use-lan-status'

/** Pairing mode for a phone: on until Close, when the code on screen runs out, and how many phones were paired when it opened. */
interface PhoneRenewal {
  on: boolean
  expiresAt: number
  devices: number
}

/** The pairing open now: its kind, and whether choosing it turned its switch on. */
export interface OpenPairing {
  kind: LanDeviceKind
  turnedOn: boolean
}

/**
 * @param status The server's status.
 * @returns The status with only the phones and tablets in its device list.
 */
function screensOnly(status: LanStatus): LanStatus {
  return { ...status, devices: status.devices.filter((device) => device.kind === 'screen') }
}

/**
 * Keeps the pairing code fresh while the pilot is in pairing mode.
 *
 * @param status The status just read.
 * @param pairing Whether pairing mode is on, when the code on screen runs out, and how many devices were paired when it was opened.
 * @param show Shows the status a new code comes back with.
 */
function renewPairing(
  status: LanStatus,
  pairing: { on: boolean; expiresAt: number; devices: number },
  show: (next: LanStatus) => void
): void {
  if (!pairing.on) return
  if (!status.url) {
    pairing.on = false
    return
  }
  if (status.pairing) {
    pairing.expiresAt = status.pairing.expiresAt
    return
  }
  const used = status.devices.length > pairing.devices
  const expired = pairing.expiresAt !== 0 && Date.now() >= pairing.expiresAt
  if (used || expired) {
    pairing.devices = status.devices.length
    runAsync('AddDeviceDialog lanStartPairing (renew)', winglogApi().lanStartPairing().then(show))
  } else {
    // Gone before its time and nobody paired: the PC cancelled it after wrong guesses, so stop offering codes.
    pairing.on = false
  }
}

/**
 * Runs one opening of Add a device on the sim PC.
 *
 * @param onPaired Called once with the new device's name when a device of the open kind appears.
 * @returns The status, the pairing open now (null before one is chosen), and the functions that open and close it.
 */
export function useDevicePairing(onPaired: (name: string) => void): {
  status: LanStatus | null
  open: OpenPairing | null
  start: (kind: LanDeviceKind) => Promise<void>
  stop: () => void
} {
  const [open, setOpen] = useState<OpenPairing | null>(null)
  /** The devices paired when the code opened: one that is not among them is the new one. */
  const known = useRef<Set<number>>(new Set())
  const renewal = useRef<PhoneRenewal>({ on: false, expiresAt: 0, devices: 0 })

  /** Closes the code that is open, if one is. */
  function stop(): void {
    if (!open) return
    renewal.current.on = false
    runAsync('AddDeviceDialog lanStopPairing', winglogApi().lanStopPairing(open.kind))
    setOpen(null)
  }

  function read(next: LanStatus, show: (status: LanStatus) => void): void {
    if (!open) return
    const paired = next.devices.find((device) => device.kind === open.kind && !known.current.has(device.id))
    if (paired) {
      stop()
      onPaired(paired.name)
    } else if (open.kind === 'screen') {
      renewPairing(screensOnly(next), renewal.current, show)
    }
  }

  const [status, setStatus] = useLanStatus(true, read)

  /**
   * Opens a kind's code. A kind that is switched off is turned on by choosing it (decided 2026-11-23, D1), and the step says so.
   *
   * @param kind What is being added.
   */
  async function start(kind: LanDeviceKind): Promise<void> {
    const api = winglogApi()
    const before = await api.lanGetStatus()
    const off = kind === 'twin' ? !before.settings.twinEnabled : !before.settings.enabled
    if (off) await api.lanSetSettings(kind === 'twin' ? { twinEnabled: true } : { enabled: true })
    const opened = await api.lanStartPairing(kind)
    known.current = new Set(opened.devices.map((device) => device.id))
    renewal.current = { on: kind === 'screen', expiresAt: 0, devices: screensOnly(opened).devices.length }
    setStatus(opened)
    setOpen({ kind, turnedOn: off })
  }

  return { status, open, start, stop }
}
