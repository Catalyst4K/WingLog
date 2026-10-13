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
    Promise.all([
      link.query('settings.display'),
      link.query('settings.gsxRemote'),
      link.query('settings.beyondAtc')
    ]).then(
      ([display, gsx, atc]) => {
        if (current) setSettings({ ...unitsFrom(display), gsxRemote: enabled(gsx), beyondAtc: enabled(atc) })
      },
      () => undefined
    )
    return () => {
      current = false
    }
  }, [link, state])
  return settings
}
