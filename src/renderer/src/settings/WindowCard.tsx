/** Settings → Interface → Window: where the window goes when minimised (winglog-backend's docs/plans/tray.md). */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WindowSettings } from '@shared/ipc'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'
import { SegmentedRow } from '../SettingsFields'
import { SettingsCard } from './ui/SettingsCard'

type MinimizeChoice = 'taskbar' | 'tray'

/**
 * The Window card: minimise to the taskbar, or to the tray. Not shown where there is no tray.
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

  function choose(choice: MinimizeChoice): void {
    const minimizeToTray = choice === 'tray'
    setSettings((current) => current && { ...current, minimizeToTray })
    runAsync('WindowCard settingsSetWindow', winglogApi().settingsSetWindow({ minimizeToTray }))
  }

  return (
    <SettingsCard title={t('settingsView.window.cardTitle')}>
      <SegmentedRow<MinimizeChoice>
        label={t('settingsView.window.minimizeLabel')}
        value={settings.minimizeToTray ? 'tray' : 'taskbar'}
        options={[
          { value: 'taskbar', label: t('settingsView.window.taskbar') },
          { value: 'tray', label: t('settingsView.window.tray') }
        ]}
        onChange={choose}
        note={t('settingsView.window.description')}
      />
    </SettingsCard>
  )
}
