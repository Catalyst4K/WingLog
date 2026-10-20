/** Settings → Interface → Window: what closing the window does (winglog-backend's docs/plans/tray.md). */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WindowSettings } from '@shared/ipc'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'
import { SegmentedRow } from '../SettingsFields'
import { SettingsCard } from './ui/SettingsCard'

type CloseChoice = 'quit' | 'tray'

/**
 * The Window card: quit on close, or keep running in the tray. Not shown where there is no tray.
 *
 * @returns The element, or nothing until the setting is read and wherever a tray is not possible.
 */
export function WindowCard(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<WindowSettings | null>(null)

  useEffect(() => {
    runAsync('WindowCard settingsGetWindow', winglogApi().settingsGetWindow().then(setSettings))
  }, [])

  if (!settings?.trayAvailable) return null

  function choose(choice: CloseChoice): void {
    const closeToTray = choice === 'tray'
    setSettings((current) => current && { ...current, closeToTray })
    runAsync('WindowCard settingsSetWindow', winglogApi().settingsSetWindow({ closeToTray }))
  }

  return (
    <SettingsCard title={t('settingsView.window.cardTitle')}>
      <SegmentedRow<CloseChoice>
        label={t('settingsView.window.closeLabel')}
        value={settings.closeToTray ? 'tray' : 'quit'}
        options={[
          { value: 'quit', label: t('settingsView.window.quit') },
          { value: 'tray', label: t('settingsView.window.tray') }
        ]}
        onChange={choose}
        note={t('settingsView.window.description')}
      />
    </SettingsCard>
  )
}
