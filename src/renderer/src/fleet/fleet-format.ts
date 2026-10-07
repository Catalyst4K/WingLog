/** Formatting shared by the Fleet list and an aircraft's detail page. */

import { useTranslation } from 'react-i18next'
import type { AircraftLastParked } from '@shared/ipc'
import { displayIcao } from '../display-icao'

/**
 * A date and time in the user's locale.
 *
 * @param iso An ISO timestamp, or null.
 * @returns The formatted text, or a dash when there is none.
 */
export function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

/**
 * "VHHH · stand N32" — the stand only when it's at the airport the aircraft is at now
 * (stand-positions.md).
 *
 * @returns A function giving an aircraft's location text from its airport and where it last parked.
 */
export function useLocationLabel(): (icao: string | null, parked: AircraftLastParked | undefined) => string {
  const { t } = useTranslation()
  return (icao, parked) => {
    if (!icao) return '—'
    const airport = displayIcao(icao)
    return parked && parked.icao === icao
      ? `${airport} · ${t('fleetView.atStand', { stand: parked.stand })}`
      : airport
  }
}
