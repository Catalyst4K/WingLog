/** The second screen's and the update's state, for Settings' list of pages. */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'
import type { SettingsNavStatus } from './SettingsNav'

/**
 * The second screen's and the update's state, for the list: how many phones are paired, and whether a new version is waiting.
 *
 * @returns The two pages' light and words, as far as they are known.
 */
export function useSettingsNavStatus(): Pick<SettingsNavStatus, 'secondScreen' | 'about'> {
  const { t } = useTranslation()
  const [devices, setDevices] = useState<{ count: number; connected: boolean } | null>(null)
  const [updateReady, setUpdateReady] = useState(false)
  useEffect(() => {
    runAsync(
      'SettingsNav lanGetStatus',
      winglogApi()
        .lanGetStatus()
        // A client runs no second screen, and its answer is nothing.
        .then((s) => {
          // The Second screen page counts phones and tablets; the other WingLogs are on the Sim PC page.
          const screens = s?.devices.filter((device) => device.kind === 'screen')
          if (s && screens) setDevices({ count: screens.length, connected: s.connections > 0 })
        })
    )
    return winglogApi().onUpdateStatus((s) => setUpdateReady(s.state === 'available'))
  }, [])
  return {
    secondScreen:
      devices && devices.count > 0
        ? {
            light: devices.connected ? 'green' : undefined,
            status: t('settingsView.status.devices', { count: devices.count })
          }
        : {},
    about: updateReady ? { light: 'amber', status: t('settingsView.status.updateReady') } : {}
  }
}
