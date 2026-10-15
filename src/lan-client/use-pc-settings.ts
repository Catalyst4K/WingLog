/** What the page needs to know about the PC's own settings: its units, and which add-ons are switched on. */

import { useEffect, useState } from 'react'
import type { AltitudeUnit, WeightUnit, WindSpeedUnit } from '@shared/ipc'
import type { LanConnection } from './lan-connection'
import { useLinkState } from './use-link'

/** The PC's settings a page shows figures by. */
export interface PcSettings {
  weightUnit: WeightUnit
  altitudeUnit: AltitudeUnit
  windSpeedUnit: WindSpeedUnit
  gsxRemote: boolean
  beyondAtc: boolean
}

/** How many times the settings are asked for when a lookup fails, and how long to wait between asks. */
const RETRIES = 4
const RETRY_MS = 1500

const DEFAULTS: PcSettings = {
  weightUnit: 'kg',
  altitudeUnit: 'ft',
  windSpeedUnit: 'kt',
  gsxRemote: false,
  beyondAtc: false
}

/**
 * @param value The answer to the display-settings lookup.
 * @returns The units from it, each falling back to the default when it is not one the page knows.
 */
function unitsFrom(value: unknown): Pick<PcSettings, 'weightUnit' | 'altitudeUnit' | 'windSpeedUnit'> {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return {
    weightUnit: record.weightUnit === 'lb' ? 'lb' : 'kg',
    altitudeUnit:
      record.altitudeUnit === 'm' || record.altitudeUnit === 'hybrid' ? record.altitudeUnit : 'ft',
    windSpeedUnit: record.windSpeedUnit === 'mps' ? 'mps' : 'kt'
  }
}

/**
 * Asks the PC for its unit settings and which add-ons are on, each time the link comes up.
 *
 * @param link The link to the PC.
 * @returns The settings; the defaults until the PC has answered.
 */
export function usePcSettings(link: LanConnection): PcSettings {
  const state = useLinkState(link)
  const [settings, setSettings] = useState<PcSettings>(DEFAULTS)
  useEffect(() => {
    if (state !== 'connected') return
    let current = true
    const enabled = (value: unknown): boolean =>
      typeof value === 'object' && value !== null && (value as { enabled?: unknown }).enabled === true
    let retry: ReturnType<typeof setTimeout> | undefined
    /** Asks for the three answers; any that fail are asked again shortly, so one refused lookup can't leave a page missing. */
    const ask = (attempt: number): void => {
      Promise.allSettled([
        link.query('settings.display'),
        link.query('settings.gsxRemote'),
        link.query('settings.beyondAtc')
      ]).then(([display, gsx, atc]) => {
        if (!current) return
        setSettings((now) => ({
          ...(display.status === 'fulfilled' ? unitsFrom(display.value) : unitsFrom(now)),
          gsxRemote: gsx.status === 'fulfilled' ? enabled(gsx.value) : now.gsxRemote,
          beyondAtc: atc.status === 'fulfilled' ? enabled(atc.value) : now.beyondAtc
        }))
        const failed = [display, gsx, atc].some((answer) => answer.status === 'rejected')
        if (failed && attempt < RETRIES) retry = setTimeout(() => ask(attempt + 1), RETRY_MS)
      })
    }
    ask(1)
    return () => {
      current = false
      clearTimeout(retry)
    }
  }, [link, state])
  return settings
}
