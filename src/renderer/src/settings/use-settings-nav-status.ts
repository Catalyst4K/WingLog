/** The Devices page's and the update's state, for Settings' list of pages. */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { winglogApi } from '../data/winglog-api'
import type { SettingsNavStatus } from './SettingsNav'
import { useLanStatus } from './use-lan-status'

/**
 * The sim PC's Devices entry and the update's state, for the list: how many paired devices (computers and phones) are connected now
 * (green, and no light at all when none is), and whether a new version is waiting.
 *
 * @param isHost Whether this computer runs the device server (not a client, whose Devices light is its link to the sim PC).
 * @returns The two pages' light and words, as far as they are known.
 */
export function useSettingsNavStatus(isHost: boolean): Pick<SettingsNavStatus, 'devices' | 'about'> {
  const { t } = useTranslation()
  const [lan] = useLanStatus(isHost)
  const [updateReady, setUpdateReady] = useState(false)
  useEffect(() => winglogApi().onUpdateStatus((s) => setUpdateReady(s.state === 'available')), [])
  const connected = lan?.devices.filter((device) => device.connected).length ?? 0
  return {
    devices:
      connected > 0
        ? { light: 'green', status: t('settingsView.status.connected', { count: connected }) }
        : {},
    about: updateReady ? { light: 'amber', status: t('settingsView.status.updateReady') } : {}
  }
}
