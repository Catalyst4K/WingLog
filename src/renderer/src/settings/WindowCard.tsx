/** Settings → Interface → Window: where the window goes when minimised (winglog-backend's docs/plans/tray.md). */

import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { WindowSettings, WindowSettingsPatch } from '@shared/ipc'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'
import { SegmentedRow } from '../SettingsFields'
import { OnOffControl, SettingRow, SettingsCard } from './ui/SettingsCard'

type MinimizeChoice = 'taskbar' | 'tray'

/**
 * The Window card: minimise to the taskbar, or to the tray. Not shown where there is no tray, unless rows are put in front of it (Settings puts the theme there).
 *
 * @param props An optional title, and rows to put before the window row.
 * @returns The element, or nothing until the setting is read and wherever a tray is not possible.
 */
export function WindowCard(props: { title?: string; lead?: ReactNode }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<WindowSettings | null>(null)

  useEffect(() => {
    runAsync('WindowCard settingsGetWindow', winglogApi().settingsGetWindow().then(setSettings))
  }, [])

  const trayAvailable = settings?.trayAvailable === true
  if (!trayAvailable && !props.lead) return null

  function change(patch: WindowSettingsPatch): void {
    setSettings((current) => current && { ...current, ...patch })
    runAsync('WindowCard settingsSetWindow', winglogApi().settingsSetWindow(patch))
  }

  function choose(choice: MinimizeChoice): void {
    change({ minimizeToTray: choice === 'tray' })
  }

  return (
    <SettingsCard title={props.title ?? t('settingsView.window.cardTitle')}>
      {props.lead}
      {settings?.trayAvailable && (
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
      )}
      {settings?.backgroundAvailable && (
        <SettingRow
          label={t('settingsView.window.backgroundLabel')}
          note={t('settingsView.window.backgroundNote')}
        >
          <OnOffControl
            label={t('settingsView.window.backgroundLabel')}
            enabled={settings.hostOnly}
            onText={t('lan.settings.on')}
            offText={t('lan.settings.off')}
            onChange={(hostOnly) => change({ hostOnly })}
          />
        </SettingRow>
      )}
      {settings?.startWithWindowsAvailable && (
        <SettingRow
          label={t('settingsView.window.startWithWindowsLabel')}
          note={t('settingsView.window.startWithWindowsNote')}
        >
          <OnOffControl
            label={t('settingsView.window.startWithWindowsLabel')}
            enabled={settings.startWithWindows}
            onText={t('lan.settings.on')}
            offText={t('lan.settings.off')}
            onChange={(startWithWindows) => change({ startWithWindows })}
          />
        </SettingRow>
      )}
    </SettingsCard>
  )
}
